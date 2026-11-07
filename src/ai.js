import { cfg } from './config.js';

export const llmEnabled = () => !!cfg.llm.key;

function openRouterMessages(body) {
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: body.system });
  for (const message of body.messages || []) {
    if (message.role === 'user' && Array.isArray(message.content)) {
      const results = message.content.filter(block => block.type === 'tool_result');
      if (results.length) {
        for (const result of results) {
          messages.push({
            role: 'tool',
            tool_call_id: result.tool_use_id,
            content: typeof result.content === 'string'
              ? result.content
              : JSON.stringify(result.content),
          });
        }
        continue;
      }
    }
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const text = message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
      const toolCalls = message.content
        .filter(block => block.type === 'tool_use')
        .map(block => ({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        }));
      messages.push({
        role: 'assistant',
        ...(text ? { content: text } : { content: null }),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    messages.push({
      role: message.role,
      content: typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content),
    });
  }
  return messages;
}

function openRouterResponse(json) {
  const choice = json.choices?.[0];
  if (!choice) return { content: [], stop_reason: 'end_turn' };
  const content = [];
  if (typeof choice.message?.content === 'string' && choice.message.content)
    content.push({ type: 'text', text: choice.message.content });
  for (const toolCall of choice.message?.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(toolCall.function?.arguments || '{}');
    } catch {
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.function?.name,
      input,
    });
  }
  return {
    content,
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
  };
}

export async function llmRaw(body) {
  const openRouter = cfg.llm.provider === 'openrouter';
  const headers = openRouter
    ? {
      Authorization: `Bearer ${cfg.llm.key}`,
      'HTTP-Referer': cfg.baseUrl,
      'X-Title': cfg.appName,
      'Content-Type': 'application/json',
    }
    : {
      'x-api-key': cfg.llm.key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
  const request = openRouter
    ? {
      model: cfg.llm.model,
      max_tokens: 1500,
      messages: openRouterMessages(body),
      ...(body.tools ? {
        tools: body.tools.map(tool => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema,
          },
        })),
        tool_choice: 'auto',
      } : {}),
    }
    : { model: cfg.llm.model, max_tokens: 1500, ...body };
  const res = await fetch(cfg.llm.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`LLM request failed (${res.status}): ${json?.error?.message || 'error'}`);
  return openRouter ? openRouterResponse(json) : json;
}
async function llmText(system, user) {
  const out = await llmRaw({ system, messages: [{ role: 'user', content: user }] });
  return (out.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
function parseJson(text) {
  const clean = String(text).replace(/```json|```/g, '').trim();
  const start = clean.indexOf('['), obj = clean.indexOf('{');
  const from = start >= 0 && (obj < 0 || start < obj) ? start : obj;
  return JSON.parse(clean.slice(from));
}

// Deterministic fallback so the app (and the demo) never breaks when the LLM is missing or returns junk.
export function templateReason(p, amount) {
  const bits = [];
  if (p.npmMaintainers != null) bits.push(p.npmMaintainers <= 1 ? 'a solo maintainer' : `${p.npmMaintainers} maintainers`);
  if (p.hasFunding) bits.push('already lists funding links');
  if (p.imports) bits.push(`imported in ${p.imports} of your files`);
  else bits.push(p.kind === 'runtime' ? 'a runtime dependency' : 'a dev dependency');
  if (p.downloads) bits.push(`${Intl.NumberFormat('en', { notation: 'compact' }).format(p.downloads)} downloads last month`);
  return `${p.name} scores ${p.score}/100: ${bits.join(', ')}.${amount ? ` Share: $${Number(amount).toFixed(2)}.` : ''}`;
}

// One batched call: the model explains each allocation and may add risk notes. It never sets amounts.
export async function explainAllocations(items) {
  const fallback = Object.fromEntries(items.map(p => [p.name, { reason: templateReason(p, p.amount), aiRisk: '' }]));
  if (!llmEnabled()) return { map: fallback, usedAI: false };
  try {
    const payload = items.map(p => ({ name: p.name, repo: p.repo, score: p.score, amount: p.amount, maintainers: p.npmMaintainers, contributors: p.contributors, hasFundingFile: p.hasFunding, importsInProject: p.imports, kind: p.kind, downloadsLastMonth: p.downloads, archived: p.archived, deprecated: p.deprecated, lastPush: p.lastPush, ruleFlags: p.flags }));
    const text = await llmText(
      'You explain how a monthly open-source funding budget was split. Amounts and scores are already decided by a rule engine: never change or contradict them. Reply with ONLY a JSON array of {"name": string, "reason": string (max 28 words, plain language, mention the strongest signals), "risk": string (empty string unless something in the data looks risky; max 20 words)}. Use only facts present in the data.',
      JSON.stringify(payload));
    const arr = parseJson(text);
    const map = { ...fallback };
    for (const r of Array.isArray(arr) ? arr : []) {
      if (r && map[r.name] && typeof r.reason === 'string' && r.reason.trim()) map[r.name] = { reason: r.reason.trim().slice(0, 240), aiRisk: typeof r.risk === 'string' ? r.risk.trim().slice(0, 160) : '' };
    }
    return { map, usedAI: true };
  } catch (err) {
    console.warn('AI explanation fell back to templates:', err.message);
    return { map: fallback, usedAI: false };
  }
}

export async function draftOutreach({ login, repo, amount, claimUrl }) {
  const tpl = `Hi ${login}, someone who depends on ${repo} set aside $${Number(amount).toFixed(2)} for you through ${cfg.appName} as thanks for maintaining it. Claim it in two minutes (GitHub sign-in + PayPal): ${claimUrl}`;
  if (!llmEnabled()) return tpl;
  try {
    const t = await llmText('Write a warm, short (max 60 words) message to an open-source maintainer telling them money is waiting. Include the link exactly. No emojis, no hype.', JSON.stringify({ login, repo, amount, claimUrl }));
    return t.includes(claimUrl) ? t.trim() : tpl;
  } catch { return tpl; }
}
