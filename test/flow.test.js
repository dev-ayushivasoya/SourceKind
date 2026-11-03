// End-to-end test of the money flow against a local fake PayPal API (scripts/mock-paypal.js).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-'));
let mock, app, base, calls;

before(async () => {
  const { startMock } = await import('../scripts/mock-paypal.js');
  mock = await startMock(4011); calls = mock.calls;
  Object.assign(process.env, {
    DATA_DIR: tmp, PAYPAL_BASE: mock.url, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'WH-OK',
    SCAN_FIXTURE: path.join(here, 'fixtures/signals.json'), ANTHROPIC_API_KEY: '', DEV_TOOLS: 'true', CLAIM_DEMO_MODE: 'true', PORT: '4012', BASE_URL: 'http://localhost:4012',
  });
  const { server } = await import('../server.js');
  await new Promise(r => server.listen(4012, r)); app = server; base = 'http://localhost:4012';
});
after(() => { app.close(); mock.server.close(); });

const api = (p, body) => fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
let ev = 0; const hook = (type, resource) => api('/api/webhooks/paypal', { id: `WH-EVT-${++ev}`, event_type: type, resource });
const state = {};

test('scan proposes a split that sums to the budget and skips archived packages', async () => {
  const { json } = await api('/api/scan', { packageJson: '{"dependencies":{"x":"1"}}', budget: 20 });
  state.scan = json;
  const sum = json.items.reduce((t, p) => t + p.amount, 0);
  assert.equal(Math.round(sum * 100), 2000);
  assert.equal(json.items.find(p => p.name === 'old-lib').amount, 0);
  assert.match(json.items[0].reason, /scores/);
});

test('pledge creates a PayPal subscription and returns an approval link', async () => {
  const amounts = Object.fromEntries(state.scan.items.filter(p => p.amount > 0).map(p => [p.name, p.amount]));
  const { status, json } = await api('/api/pledges', { scanId: state.scan.id, amounts, tier: 20, email: 'funder@example.com' });
  assert.equal(status, 200); assert.match(json.approveUrl, /approve\/I-MOCK/);
  state.pledge = json.id;
  const sub = calls.find(c => c.url === '/v1/billing/subscriptions' && c.method === 'POST');
  assert.equal(sub.body.custom_id, json.id);
});

test('webhooks: activation, then a charge runs a cycle; unclaimed maintainers are held', async () => {
  const p = (await api(`/api/pledges/${state.pledge}`)).json;
  assert.equal((await hook('BILLING.SUBSCRIPTION.ACTIVATED', { id: p.subscriptionId, custom_id: state.pledge })).json.handled, 'BILLING.SUBSCRIPTION.ACTIVATED');
  await hook('PAYMENT.SALE.COMPLETED', { id: 'SALE-1', billing_agreement_id: p.subscriptionId, amount: { total: '20.00' } });
  const v = (await api(`/api/pledges/${state.pledge}`)).json;
  assert.equal(v.status, 'active'); assert.equal(v.cycles, 1);
  assert.ok(Math.abs(v.totals.awaitingClaim - 20) < 0.01);
  assert.ok(v.allocations.every(a => a.status === 'held'));
  assert.ok(!calls.some(c => c.url === '/v1/payments/payouts'), 'no payout before anyone claims');
  await new Promise(r => setTimeout(r, 100));
  assert.ok(calls.some(c => c.url === '/v2/invoicing/invoices'), 'invoice created');
  assert.ok(calls.some(c => /\/send$/.test(c.url)), 'invoice sent');
});

test('duplicate webhook events are ignored', async () => {
  const r = await api('/api/webhooks/paypal', { id: 'WH-EVT-2', event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'SALE-1', billing_agreement_id: 'x', amount: { total: '20' } } });
  assert.equal(r.json.duplicate, true);
});

test('claiming releases held money through one Payouts batch', async () => {
  const r = await api('/api/claim', { login: 'solo-dev', email: 'solo@example.com' });
  assert.equal(r.status, 200); assert.ok(r.json.released >= 1);
  const batch = calls.filter(c => c.url === '/v1/payments/payouts').pop();
  assert.equal(batch.body.items[0].receiver, 'solo@example.com');
  assert.match(batch.body.sender_batch_header.sender_batch_id, new RegExp(state.pledge));
  state.itemId = batch.body.items[0].sender_item_id;
});

test('payout webhooks drive status: succeeded, then returned money rolls over', async () => {
  await hook('PAYMENT.PAYOUTS-ITEM.SUCCEEDED', { payout_item_id: 'PI-1', payout_batch_id: 'BATCH-X', transaction_id: 'TX-1', payout_item: { sender_item_id: state.itemId } });
  let v = (await api(`/api/pledges/${state.pledge}`)).json;
  const a = v.allocations.find(x => x.id === state.itemId);
  assert.equal(a.status, 'paid'); assert.equal(a.transactionId, 'TX-1');
  // A second maintainer claims, then PayPal reports the payout as returned
  await api('/api/claim', { login: 'maria', email: 'maria@example.com' });
  v = (await api(`/api/pledges/${state.pledge}`)).json;
  const m = v.allocations.find(x => x.owner === 'maria');
  await hook('PAYMENT.PAYOUTS-ITEM.RETURNED', { payout_item_id: 'PI-2', payout_item: { sender_item_id: m.id } });
  v = (await api(`/api/pledges/${state.pledge}`)).json;
  assert.equal(v.allocations.find(x => x.id === m.id).status, 'rolled_over');
  assert.ok(Math.abs(v.carryover - m.amount) < 0.01);
});

test('next cycle includes the rolled-over money', async () => {
  const before = (await api(`/api/pledges/${state.pledge}`)).json;
  await api('/api/dev/simulate-cycle', { pledgeId: state.pledge });
  const v = (await api(`/api/pledges/${state.pledge}`)).json;
  const c2 = v.allocations.filter(a => a.cycle === 2).reduce((t, a) => t + a.amount, 0);
  assert.ok(Math.abs(c2 - (20 + before.carryover)) < 0.02); assert.equal(v.carryover, 0);
});

test('agent: write actions need confirmation, then call PayPal', async () => {
  const r = (await api('/api/agent', { pledgeId: state.pledge, message: 'please refund the unclaimed money' })).json;
  assert.equal(r.actions.length, 1); assert.equal(r.actions[0].status, 'pending');
  assert.ok(!calls.some(c => /refund$/.test(c.url)), 'nothing refunded before confirmation');
  const done = (await api('/api/agent/confirm', { actionId: r.actions[0].id, approve: true })).json;
  assert.equal(done.status, 'done'); assert.ok(calls.some(c => /\/v1\/payments\/sale\/SALE-1\/refund$/.test(c.url)));
  const cancel = (await api('/api/agent', { pledgeId: state.pledge, message: 'cancel my subscription' })).json;
  const rej = (await api('/api/agent/confirm', { actionId: cancel.actions[0].id, approve: false })).json;
  assert.equal(rej.status, 'rejected');
});

test('ledger, impact and badge are public', async () => {
  assert.ok((await api('/api/ledger')).json.length > 0);
  assert.ok((await api(`/api/impact/${state.pledge}`)).json.total >= 40);
  const svg = await fetch(`${base}/badge/${state.pledge}.svg`).then(r => r.text()); assert.match(svg, /<svg/);
});
