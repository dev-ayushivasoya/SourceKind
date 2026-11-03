// Deterministic, explainable scoring. The AI never changes these numbers; it only explains them.
export const WEIGHTS = { need: 0.4, importance: 0.3, reach: 0.2, health: 0.1 };
const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const POPULAR = ['react', 'lodash', 'express', 'axios', 'chalk', 'moment', 'request', 'webpack', 'typescript', 'commander', 'debug', 'vue', 'jquery', 'underscore', 'async', 'bluebird', 'colors', 'uuid', 'dotenv', 'cors', 'mongoose', 'prettier', 'eslint', 'jest'];

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
  {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // swapped letters
  }
  return d[a.length][b.length];
}
export function ruleFlags(s, now = Date.now()) {
  const flags = [];
  if (s.archived) flags.push('Repository is archived');
  if (s.deprecated) flags.push('Package is deprecated on npm');
  if (s.lastPush) { const days = (now - Date.parse(s.lastPush)) / 864e5; if (days > 730) flags.push('No repository activity for over 2 years'); }
  const bare = s.name.replace(/^@[^/]+\//, '');
  if (s.downloads < 5000 && POPULAR.some(p => p !== bare && editDistance(p, bare) <= 1)) flags.push('Name is very close to a popular package (possible typo-squat)');
  return flags;
}

export function scorePackage(s, ctx, now = Date.now()) {
  const m = s.npmMaintainers, c = s.contributors;
  let need = m == null ? 0.6 : m <= 1 ? 1 : m === 2 ? 0.8 : m === 3 ? 0.6 : m <= 5 ? 0.4 : 0.2;
  if (c != null && c <= 2) need = Math.min(1, need + 0.1);
  if (s.hasFunding) need *= 0.5;
  if (s.ownerType === 'Organization') need *= 0.75;
  const importance = s.imports != null
    ? clamp(Math.log1p(s.imports) / Math.log1p(Math.max(1, ctx.maxImports)))
    : s.kind === 'runtime' ? 0.7 : 0.35;
  const reach = clamp(Math.log10(s.downloads + 1) / Math.log10(Math.max(10, ctx.maxDownloads) + 1));
  const days = s.lastPush ? (now - Date.parse(s.lastPush)) / 864e5 : 365;
  const health = s.archived || s.deprecated ? 0 : days < 90 ? 1 : days < 365 ? 0.7 : days < 730 ? 0.4 : 0.1;
  const total = 100 * (WEIGHTS.need * need + WEIGHTS.importance * importance + WEIGHTS.reach * reach + WEIGHTS.health * health);
  const flags = ruleFlags(s, now);
  const eligible = !(s.archived || s.deprecated);
  const r1 = x => Math.round(x * 100) / 100;
  return { ...s, need: r1(need), importance: r1(importance), reach: r1(reach), health: r1(health), score: Math.round(total * 10) / 10, flags, eligible };
}

export function scoreAll(signals, now = Date.now()) {
  const ctx = { maxImports: Math.max(1, ...signals.map(s => s.imports || 0)), maxDownloads: Math.max(10, ...signals.map(s => s.downloads || 0)) };
  return signals.map(s => scorePackage(s, ctx, now)).sort((a, b) => b.score - a.score);
}

// Split `budget` dollars across weights using integer cents (largest-remainder), enforcing a minimum payout.
export function allocate(weights, budget, minPayout = 1) {
  let active = Object.entries(weights).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]);
  const cents = Math.round(budget * 100), min = Math.round(minPayout * 100);
  while (active.length) {
    const sum = active.reduce((t, [, w]) => t + w, 0);
    const raw = active.map(([k, w]) => [k, (w / sum) * cents]);
    if (raw[raw.length - 1][1] >= min || active.length === 1) {
      const base = raw.map(([k, v]) => [k, Math.floor(v), v - Math.floor(v)]);
      let left = cents - base.reduce((t, [, f]) => t + f, 0);
      [...base].sort((a, b) => b[2] - a[2]).forEach(b => { if (left > 0) { b[1] += 1; left--; } });
      return Object.fromEntries(base.map(([k, f]) => [k, f / 100]));
    }
    active = active.slice(0, -1); // drop the smallest share and redistribute
  }
  return {};
}
