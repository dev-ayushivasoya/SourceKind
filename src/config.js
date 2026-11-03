import fs from 'node:fs';
import path from 'node:path';

// Tiny .env loader (no dependencies). Real environment variables win over the file.
try {
  const raw = fs.readFileSync(path.resolve('.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env file: fine */ }

const e = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(v));
const num = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);

export const cfg = {
  port: num(e.PORT, 3000),
  baseUrl: (e.BASE_URL || `http://localhost:${num(e.PORT, 3000)}`).replace(/\/$/, ''),
  appName: e.APP_NAME || 'Upstream',
  dataDir: path.resolve(e.DATA_DIR || './data'),
  paypal: {
    clientId: e.PAYPAL_CLIENT_ID || '',
    secret: e.PAYPAL_CLIENT_SECRET || '',
    webhookId: e.PAYPAL_WEBHOOK_ID || '',
    base: (e.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com').replace(/\/$/, ''),
    web: (e.PAYPAL_WEB || 'https://www.sandbox.paypal.com').replace(/\/$/, ''),
    planIds: (() => { try { return JSON.parse(e.PAYPAL_PLAN_IDS || '{}'); } catch { return {}; } })(),
  },
  llm: { key: e.ANTHROPIC_API_KEY || '', model: e.LLM_MODEL || 'claude-sonnet-5-5', url: e.LLM_URL || 'https://api.anthropic.com/v1/messages' },
  github: { token: e.GITHUB_TOKEN || '', clientId: e.GITHUB_CLIENT_ID || '', clientSecret: e.GITHUB_CLIENT_SECRET || '' },
  claimDemo: bool(e.CLAIM_DEMO_MODE, true),
  devTools: bool(e.DEV_TOOLS, false),
  minPayout: num(e.MIN_PAYOUT, 1),
  maxPackages: num(e.MAX_PACKAGES, 20),
  claimExpiryDays: num(e.CLAIM_EXPIRY_DAYS, 30),
  feePct: num(e.PLATFORM_FEE_PCT, 0),
  skipVerify: bool(e.SKIP_WEBHOOK_VERIFY, false),
  tiers: [5, 10, 20, 50],
  scanFixture: e.SCAN_FIXTURE || '', // tests only
};
