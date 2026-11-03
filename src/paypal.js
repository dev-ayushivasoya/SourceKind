import crypto from 'node:crypto';
import { cfg } from './config.js';
import { db } from './store.js';

const P = cfg.paypal;
let tokenCache = { value: '', exp: 0 };

export const configured = () => !!(P.clientId && P.secret);
const basic = () => Buffer.from(`${P.clientId}:${P.secret}`).toString('base64');

export class PayPalError extends Error {
  constructor(status, body, where) {
    super(`PayPal ${where} failed (${status}): ${body?.message || body?.error_description || body?.name || 'error'}`);
    this.status = status; this.body = body;
  }
}

export async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.exp - 30000) return tokenCache.value;
  if (!configured()) throw new Error('PayPal credentials missing: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env');
  const res = await fetch(`${P.base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayPalError(res.status, body, 'token');
  tokenCache = { value: body.access_token, exp: Date.now() + body.expires_in * 1000 };
  return tokenCache.value;
}

export async function pp(method, path, body, headers = {}) {
  const token = await getToken();
  const res = await fetch(`${P.base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};
  if (!res.ok) throw new PayPalError(res.status, json, `${method} ${path}`);
  return json;
}

// ---------- Subscriptions: the monthly engine ----------
export async function ensurePlan(tier) {
  const key = String(tier);
  if (P.planIds[key]) return P.planIds[key];
  const saved = db.get('plans', key);
  if (saved) return saved.id;
  let product = db.get('plans', 'product');
  if (!product) {
    const p = await pp('POST', '/v1/catalogs/products', {
      name: `${cfg.appName} monthly pledge`, description: 'Monthly contribution split across the open-source maintainers your project depends on.',
      type: 'SERVICE', category: 'SOFTWARE',
    }, { 'PayPal-Request-Id': `product-${cfg.appName}-${Date.now()}` });
    product = db.set('plans', 'product', { id: p.id });
  }
  const plan = await pp('POST', '/v1/billing/plans', {
    product_id: product.id, name: `${cfg.appName} $${tier}/month`, description: `$${tier} per month, split across your dependencies`,
    status: 'ACTIVE',
    billing_cycles: [{
      frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0,
      pricing_scheme: { fixed_price: { value: Number(tier).toFixed(2), currency_code: 'USD' } },
    }],
    payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CONTINUE', payment_failure_threshold: 3 },
  }, { 'PayPal-Request-Id': `plan-${tier}-${Date.now()}` });
  db.set('plans', key, { id: plan.id, tier });
  return plan.id;
}

export function forgetPlans() {
  for (const tier of cfg.tiers) db.del('plans', String(tier));
  db.del('plans', 'product');
}

export async function createSubscription({ planId, customId, returnUrl, cancelUrl, email }) {
  const sub = await pp('POST', '/v1/billing/subscriptions', {
    plan_id: planId, custom_id: customId,
    ...(email ? { subscriber: { email_address: email } } : {}),
    application_context: {
      brand_name: cfg.appName, locale: 'en-US', shipping_preference: 'NO_SHIPPING', user_action: 'SUBSCRIBE_NOW',
      payment_method: { payer_selected: 'PAYPAL', payee_preferred: 'IMMEDIATE_PAYMENT_REQUIRED' },
      return_url: returnUrl, cancel_url: cancelUrl,
    },
  }, { 'PayPal-Request-Id': `sub-${customId}`, Prefer: 'return=representation' });
  const approve = sub.links?.find(l => l.rel === 'approve')?.href;
  return { id: sub.id, status: sub.status, approveUrl: approve };
}
export const getSubscription = (id) => pp('GET', `/v1/billing/subscriptions/${id}`);
export const cancelSubscription = (id, reason = 'Cancelled by funder') => pp('POST', `/v1/billing/subscriptions/${id}/cancel`, { reason });

// ---------- Payouts: money to maintainers ----------
export async function sendPayoutBatch(batchId, items) {
  // items: [{ id, receiver, payerId?, amount (number), note }]
  const out = await pp('POST', '/v1/payments/payouts', {
    sender_batch_header: { sender_batch_id: batchId, email_subject: `${cfg.appName}: a developer who uses your code sent you a contribution`, email_message: 'Thank you for maintaining open source.' },
    items: items.map(i => ({
      recipient_type: i.payerId ? 'PAYPAL_ID' : 'EMAIL',
      receiver: i.payerId || i.receiver,
      amount: { value: Number(i.amount).toFixed(2), currency: 'USD' },
      note: (i.note || '').slice(0, 160), sender_item_id: i.id,
    })),
  }, { 'PayPal-Request-Id': batchId });
  return { batchId: out.batch_header?.payout_batch_id, status: out.batch_header?.batch_status };
}
export const getPayoutBatch = (id) => pp('GET', `/v1/payments/payouts/${id}`);

// ---------- Webhooks ----------
export async function verifyWebhook(headers, event) {
  if (cfg.skipVerify) return true;
  if (!P.webhookId) throw new Error('PAYPAL_WEBHOOK_ID is not set, so webhook signatures cannot be verified');
  const out = await pp('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'], transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'], webhook_id: P.webhookId, webhook_event: event,
  });
  return out.verification_status === 'SUCCESS';
}

// ---------- Refunds & Invoicing ----------
export const refundSale = (saleId, amount, note) =>
  pp('POST', `/v1/payments/sale/${saleId}/refund`, { amount: { total: Number(amount).toFixed(2), currency: 'USD' }, description: note || 'Refund' });

export async function issueInvoice({ email, name, amount, cycle, pledgeId, saleId }) {
  let number;
  try { number = (await pp('POST', '/v2/invoicing/generate-next-invoice-number')).invoice_number; } catch { number = `UP-${pledgeId.slice(0, 6)}-${cycle}`; }
  const today = new Date().toISOString().slice(0, 10);
  const created = await pp('POST', '/v2/invoicing/invoices', {
    detail: { invoice_number: number, invoice_date: today, currency_code: 'USD', note: `Receipt for monthly open-source funding, cycle ${cycle}. PayPal sale ${saleId || 'n/a'}.`, payment_term: { term_type: 'DUE_ON_RECEIPT' } },
    primary_recipients: [{ billing_info: { email_address: email, name: { given_name: name || 'Funder' } } }],
    items: [{ name: `Open-source funding, cycle ${cycle}`, description: `Split across the maintainers of your dependencies by ${cfg.appName}`, quantity: '1', unit_amount: { currency_code: 'USD', value: Number(amount).toFixed(2) } }],
  });
  const id = (created.href || '').split('/').pop();
  await pp('POST', `/v2/invoicing/invoices/${id}/send`, { send_to_recipient: true, send_to_invoicer: false });
  // The funder already paid via the subscription, so mark the invoice as settled externally.
  await pp('POST', `/v2/invoicing/invoices/${id}/payments`, { method: 'OTHER', payment_date: today, amount: { currency_code: 'USD', value: Number(amount).toFixed(2) }, note: `Paid via PayPal subscription sale ${saleId || ''}` }).catch(() => {});
  return { id, number, href: created.href };
}

// ---------- Login with PayPal (maintainer identity) ----------
export const loginEnabled = () => configured();
export function loginUrl(state) {
  const q = new URLSearchParams({ client_id: P.clientId, response_type: 'code', scope: 'openid email', redirect_uri: `${cfg.baseUrl}/auth/paypal/callback`, state });
  return `${P.web}/signin/authorize?${q}`;
}
export async function exchangeLoginCode(code) {
  const res = await fetch(`${P.base}/v1/oauth2/token`, {
    method: 'POST', headers: { Authorization: `Basic ${basic()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayPalError(res.status, tok, 'login token');
  const ui = await fetch(`${P.base}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  const info = await ui.json().catch(() => ({}));
  if (!ui.ok) throw new PayPalError(ui.status, info, 'userinfo');
  const email = info.emails?.find(e => e.primary)?.value || info.emails?.[0]?.value || info.email;
  return { payerId: info.payer_id || info.user_id, email, name: info.name };
}
export const randomState = () => crypto.randomBytes(12).toString('base64url');
