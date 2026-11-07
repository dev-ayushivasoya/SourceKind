import { cfg } from './config.js';
import { db, uid } from './store.js';
import * as pay from './paypal.js';
import { llmEnabled, llmRaw } from './ai.js';
import { pledgeView, outreachFor } from './engine.js';

const money = (n) => Math.round(n * 100) / 100;

const TOOLS = [
  { name: 'get_pledge_summary', description: 'Status, cycles, totals paid / in flight / awaiting claim / rolled over for the funder\'s pledge.', input_schema: { type: 'object', properties: {} }, write: false },
  { name: 'list_dependencies', description: 'List the dependencies in this pledge, their runtime/dev kind, funding amount, score, maintainer and reason they were selected.', input_schema: { type: 'object', properties: {} }, write: false },
  { name: 'list_allocations', description: 'Every payout line with package, maintainer, amount, status and PayPal ids. Optionally filter by status (paid, sent, unclaimed, held, rolled_over, failed).', input_schema: { type: 'object', properties: { status: { type: 'string' } } }, write: false },
  { name: 'draft_claim_reminders', description: 'Draft friendly reminder messages for maintainers whose money is still awaiting a claim.', input_schema: { type: 'object', properties: {} }, write: false },
  { name: 'cancel_subscription', description: 'Cancel the PayPal subscription so no further monthly charges happen. Needs the funder\'s confirmation.', input_schema: { type: 'object', properties: { reason: { type: 'string' } } }, write: true },
  { name: 'refund_unpaid_funds', description: 'Refund through PayPal the part of the latest charge that has NOT reached maintainers (unclaimed, failed or rolled over). Needs the funder\'s confirmation.', input_schema: { type: 'object', properties: {} }, write: true },
  { name: 'issue_invoice_for_last_cycle', description: 'Create and send a PayPal invoice/receipt to the funder\'s email for the latest cycle. Needs the funder\'s confirmation.', input_schema: { type: 'object', properties: {} }, write: true },
];

const refundable = (pledgeId) => {
  const v = pledgeView(pledgeId); const last = v.cycles;
  return v.allocations.filter(a => a.cycle === last && ['held', 'rolled_over', 'failed'].includes(a.status));
};

async function readTool(name, input, pledgeId) {
  const v = pledgeView(pledgeId);
  if (!v) throw new Error('Pledge not found.');
  if (name === 'get_pledge_summary') return { source: v.source, status: v.status, monthlyBudget: v.tier, cycles: v.cycles, carryover: v.carryover, totals: v.totals, invoices: v.invoices.length };
  if (name === 'list_dependencies') {
    const scan = db.get('scans', v.scanId);
    if (!scan) return { source: v.source, dependencies: Object.entries(v.packages || {}).map(([name, p]) => ({ name, maintainer: p.owner || null, reason: p.reason, amount: money((v.shares[name] || 0) * v.tier) })) };
    return {
      source: scan.source,
      dependencies: scan.items.map(p => ({
        name: p.name, kind: p.kind, amount: money((v.shares[p.name] || 0) * v.tier),
        funded: !!v.shares[p.name], score: p.score, maintainer: p.ownerLogin || null,
        reason: p.reason, risk: p.risk || null,
      })),
      skipped: scan.skipped,
      warnings: scan.warnings,
    };
  }
  if (name === 'list_allocations') return v.allocations.filter(a => !input.status || a.status === input.status).slice(0, 40).map(a => ({ package: a.pkg, maintainer: a.owner, amount: a.amount, cycle: a.cycle, status: a.status, paypalStatus: a.paypalStatus, batchId: a.payoutBatchId, transactionId: a.transactionId }));
  if (name === 'draft_claim_reminders') {
    const owners = [...new Set(v.allocations.filter(a => a.status === 'held').map(a => a.owner))];
    return Promise.all(owners.map(async o => ({ maintainer: o, message: await outreachFor(o) })));
  }
  return { error: 'unknown tool' };
}

function proposeWrite(name, input, pledgeId) {
  const v = pledgeView(pledgeId);
  let summary;
  if (name === 'cancel_subscription') summary = `Cancel the $${v.tier}/month PayPal subscription for ${v.source}. No further charges; payouts already sent are not affected.`;
  else if (name === 'refund_unpaid_funds') { const amt = money(refundable(pledgeId).reduce((t, a) => t + a.amount, 0)); summary = amt > 0 ? `Refund $${amt.toFixed(2)} (unclaimed / failed / rolled-over money from cycle ${v.cycles}) to your PayPal account.` : 'Nothing is refundable right now: every dollar from the latest cycle is paid or on its way.'; }
  else summary = `Create and send a PayPal invoice receipt for cycle ${v.cycles} to ${v.email || 'the funder email (none on file)'}.`;
  const a = { id: uid('act_'), pledgeId, tool: name, input, summary, status: 'pending', createdAt: Date.now() };
  return db.set('actions', a.id, a);
}

export async function executeAction(actionId, approve) {
  const a = db.get('actions', actionId);
  if (!a || a.status !== 'pending') throw new Error('Action not found or already handled.');
  if (!approve) return db.update('actions', a.id, { status: 'rejected' });
  const p = db.get('pledges', a.pledgeId);
  try {
    let result;
    if (a.tool === 'cancel_subscription') { await pay.cancelSubscription(p.subscriptionId, a.input?.reason || 'Cancelled by funder via agent'); db.update('pledges', p.id, { status: 'cancelled' }); result = 'Subscription cancelled in PayPal.'; }
    else if (a.tool === 'refund_unpaid_funds') {
      const list = refundable(p.id); const amt = money(list.reduce((t, x) => t + x.amount, 0));
      if (amt <= 0 || !p.lastSaleId) throw new Error('Nothing to refund (or no PayPal sale id on file yet).');
      await pay.refundSale(p.lastSaleId, amt, `Unclaimed ${cfg.appName} funds`);
      list.forEach(x => db.update('allocations', x.id, { status: 'refunded' }));
      db.update('pledges', p.id, { carryover: 0 }); result = `Refunded $${amt.toFixed(2)} through PayPal.`;
    } else if (a.tool === 'issue_invoice_for_last_cycle') {
      if (!p.email) throw new Error('No funder email on file for this pledge.');
      const inv = await pay.issueInvoice({ email: p.email, amount: p.tier, cycle: p.cycles, pledgeId: p.id, saleId: p.lastSaleId });
      db.set('invoices', inv.id, { ...inv, pledgeId: p.id, cycle: p.cycles }); result = `Invoice ${inv.number} sent.`;
    }
    return db.update('actions', a.id, { status: 'done', result });
  } catch (err) { return db.update('actions', a.id, { status: 'error', result: err.message }); }
}

// Rule-based agent used when no LLM key is configured (same tools, same confirmation gate).
async function fallbackAgent(message, pledgeId) {
  const t = message.toLowerCase();
  if (/dependenc|package|library|module|what.*fund|fund.*what/.test(t)) {
    const result = await readTool('list_dependencies', {}, pledgeId);
    const funded = result.dependencies.filter(p => p.funded);
    const details = funded.length
      ? funded.map(p => `${p.name} ($${p.amount.toFixed(2)}${p.kind ? `, ${p.kind}` : ''}${p.maintainer ? `, maintainer ${p.maintainer}` : ''})`).join('; ')
      : 'No dependencies currently have a funding allocation.';
    const skipped = result.skipped?.length ? ` ${result.skipped.length} package(s) were skipped because no repository/maintainer was available.` : '';
    return { reply: `Your pledge for ${result.source} includes ${funded.length} funded dependenc${funded.length === 1 ? 'y' : 'ies'}: ${details}.${skipped}`, actions: [] };
  }
  if (/payment|payout|paid|pending|transaction|status|how much|total/.test(t)) {
    const s = await readTool('get_pledge_summary', {}, pledgeId);
    const lines = await readTool('list_allocations', {}, pledgeId);
    const details = lines.length
      ? ` Payouts: ${lines.slice(0, 8).map(a => `${a.package} $${a.amount.toFixed(2)} (${a.paypalStatus || a.status}${a.transactionId ? `, transaction ${a.transactionId}` : ''})`).join('; ')}.`
      : '';
    return { reply: `Your ${s.source} pledge is ${s.status}, with a $${Number(s.monthlyBudget).toFixed(2)} monthly budget across ${s.cycles} billing cycle(s). Paid: $${s.totals.paid.toFixed(2)}; pending/in flight: $${s.totals.inFlight.toFixed(2)}; awaiting maintainer claim: $${s.totals.awaitingClaim.toFixed(2)}; rolled over: $${s.totals.rolledOver.toFixed(2)}.${details}`, actions: [] };
  }
  if (/cancel|stop|unsubscribe/.test(t)) return { reply: 'I can cancel the subscription. Please confirm below.', actions: [proposeWrite('cancel_subscription', {}, pledgeId)] };
  if (/refund|money back|unclaimed/.test(t)) { const a = proposeWrite('refund_unpaid_funds', {}, pledgeId); return { reply: a.summary, actions: [a] }; }
  if (/invoice|receipt/.test(t)) return { reply: 'I can send a PayPal invoice receipt. Please confirm below.', actions: [proposeWrite('issue_invoice_for_last_cycle', {}, pledgeId)] };
  if (/remind|claim|outreach/.test(t)) { const r = await readTool('draft_claim_reminders', {}, pledgeId); return { reply: r.length ? r.map(x => `${x.maintainer}: ${x.message}`).join('\n\n') : 'No maintainers are waiting to claim right now.', actions: [] }; }
  const s = await readTool('get_pledge_summary', {}, pledgeId);
  return { reply: `Pledge for ${s.source} is ${s.status}. Cycles run: ${s.cycles}. Paid $${s.totals.paid}, in flight $${s.totals.inFlight}, awaiting claim $${s.totals.awaitingClaim}, rolled over $${s.totals.rolledOver}. (Add ANTHROPIC_API_KEY for the full AI agent.)`, actions: [] };
}

export async function chat({ pledgeId, message, history = [] }) {
  const pledge = db.get('pledges', pledgeId);
  if (!pledge) throw new Error('Pledge not found.');
  if (!llmEnabled()) return fallbackAgent(message, pledgeId);
  const scan = db.get('scans', pledge.scanId);
  const context = {
    pledge: { source: pledge.source, status: pledge.status, monthlyBudget: pledge.tier, cycles: pledge.cycles, carryover: pledge.carryover, totals: pledgeView(pledgeId).totals },
    dependencies: (scan?.items || []).map(p => ({ name: p.name, kind: p.kind, amount: money((pledge.shares[p.name] || 0) * pledge.tier), funded: !!pledge.shares[p.name], score: p.score, maintainer: p.ownerLogin || null, reason: p.reason })),
  };
  const system = `You are the ${cfg.appName} agent, helping the funder manage the specific PayPal pledge and dependencies in CURRENT PLEDGE DATA below. You can see this data; answer dependency questions from it, and use tools for up-to-date payment/allocation facts. Never claim you cannot see the pledge or dependencies. Never guess amounts or statuses. Actions that change money or subscriptions are only PROPOSED: tell the user they must press Confirm. Be brief and plain.\nCURRENT PLEDGE DATA:\n${JSON.stringify(context)}`;
  const messages = [...history.slice(-8).map(h => ({ role: h.role, content: String(h.content) })), { role: 'user', content: message }];
  const actions = [];
  for (let i = 0; i < 5; i++) {
    const out = await llmRaw({ system, messages, tools: TOOLS.map(({ write, ...t }) => t) });
    const uses = (out.content || []).filter(b => b.type === 'tool_use');
    if (!uses.length || out.stop_reason !== 'tool_use') return { reply: (out.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim(), actions };
    messages.push({ role: 'assistant', content: out.content });
    const results = [];
    for (const u of uses) {
      const tool = TOOLS.find(t => t.name === u.name);
      let result;
      if (!tool) result = { error: 'unknown tool' };
      else if (tool.write) { const act = proposeWrite(u.name, u.input || {}, pledgeId); actions.push(act); result = { status: 'pending_user_confirmation', summary: act.summary }; }
      else result = await readTool(u.name, u.input || {}, pledgeId).catch(e => ({ error: e.message }));
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: 'I could not finish that request. Please try rephrasing.', actions };
}
