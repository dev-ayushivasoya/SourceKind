// A tiny local stand-in for the PayPal REST API, used by the automated tests and for offline development.
// Run `npm run mock:paypal`, then set PAYPAL_BASE=http://localhost:4010 and any dummy client id/secret.
// It is NOT used in the real demo: the real demo talks to the PayPal sandbox.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function startMock(port = 4010) {
  const calls = []; let n = 0; const subs = {};
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => {
      const body = raw && raw.startsWith('{') ? JSON.parse(raw) : raw;
      calls.push({ method: req.method, url: req.url, body, headers: req.headers });
      const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const u = req.url.split('?')[0];
      if (u === '/v1/oauth2/token') return json(200, { access_token: 'mock-token', expires_in: 3600 });
      if (u === '/v1/catalogs/products') return json(201, { id: 'PROD-MOCK' });
      if (u === '/v1/billing/plans') return json(201, { id: `P-MOCK-${++n}` });
      if (u === '/v1/billing/subscriptions' && req.method === 'POST') { const id = `I-MOCK${++n}`; subs[id] = body; return json(201, { id, status: 'APPROVAL_PENDING', links: [{ rel: 'approve', href: `http://localhost:${port}/approve/${id}` }] }); }
      if (/^\/v1\/billing\/subscriptions\/[^/]+$/.test(u)) return json(200, { id: u.split('/').pop(), status: 'ACTIVE' });
      if (/\/cancel$/.test(u)) return json(204, {});
      if (u === '/v1/payments/payouts') return json(201, { batch_header: { payout_batch_id: `BATCH-${++n}`, batch_status: 'PENDING' } });
      if (u === '/v1/notifications/verify-webhook-signature') return json(200, { verification_status: body.webhook_id === 'WH-OK' ? 'SUCCESS' : 'FAILURE' });
      if (/\/v1\/payments\/sale\/[^/]+\/refund$/.test(u)) return json(201, { id: `REF-${++n}`, state: 'completed' });
      if (u === '/v2/invoicing/generate-next-invoice-number') return json(200, { invoice_number: `0001-${++n}` });
      if (u === '/v2/invoicing/invoices') return json(201, { href: `http://localhost:${port}/v2/invoicing/invoices/INV2-MOCK${++n}` });
      if (/^\/v2\/invoicing\/invoices\/[^/]+\/(send|payments)$/.test(u)) return json(202, {});
      json(404, { name: 'NOT_FOUND', message: `mock has no ${req.method} ${u}` });
    });
  });
  return new Promise(r => server.listen(port, () => r({ server, calls, url: `http://localhost:${port}` })));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMock(4010).then(() => console.log('Mock PayPal API on http://localhost:4010 (set PAYPAL_BASE to this URL)'));
}
