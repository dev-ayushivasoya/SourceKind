# SourceKind: pay the people your code runs on

> Built for the **PayPal AI Hackathon** (Devpost). Working name "SourceKind": change it with `APP_NAME` in `.env`.

Open-source libraries are often kept alive by one or two unpaid maintainers. GitHub Sponsors lets you fund them, but only if the maintainer has enrolled, and you still have to choose every amount yourself.

**SourceKind** takes a repo (or a `package.json`) and a monthly budget, scores each dependency, proposes a fair split, explains every share, and pays the maintainers through **PayPal**. Maintainers who have never signed up for anything get a claim link, and their money is held until they claim it.

## What PayPal does here (it is the engine, not a checkout button)

| Part of the product | PayPal feature | Where in code |
|---|---|---|
| The monthly clock: a pledge **is** a PayPal subscription; each billing cycle triggers a re-scan and a payout batch | **Subscriptions API** (product, plan, subscription, cancel) + webhooks `BILLING.SUBSCRIPTION.*`, `PAYMENT.SALE.COMPLETED` | `src/paypal.js`, `src/engine.js` |
| Paying maintainers in one batch | **Payouts API** (`PAYPAL_ID` or `EMAIL` recipients, idempotent `sender_batch_id`) | `sendPayoutBatch`, `payQueued` |
| Where the money is | Payout item webhooks (`SUCCEEDED`, `UNCLAIMED`, `RETURNED`, `FAILED`, `BLOCKED`, `HELD`...) drive a state machine: paid, waiting, or **rolled over** into the next cycle | `handleEvent` in `src/engine.js` |
| Trust | Every webhook is verified with `verify-webhook-signature`; events are idempotent and retry-safe | `verifyWebhook`, `/api/webhooks/paypal` |
| Maintainer identity | **Login with PayPal** (confirms the payee) + GitHub OAuth (proves they own the project) | `/auth/paypal`, `/auth/github` |
| Records | **Invoicing API**: a receipt invoice per cycle; **Refunds API** for unpaid money | `issueInvoice`, `refundSale` |
| Proof | The public ledger shows PayPal batch / item / transaction ids | `/#/ledger` |

## What the AI does

The AI never decides money. Amounts come from a deterministic scoring engine (`src/scoring.js`: need 40%, importance 30%, reach 20%, health 10%).

1. **Explainer**: writes a plain-language reason for every share and adds risk notes (one batched call, strict JSON, validated; falls back to templates if the model fails).
2. **Risk flagger**: rules + AI notes for archived/deprecated packages and look-alike (typo-squat) names.
3. **Agent**: a tool-using agent (Claude tool use) that can check status, draft claim reminders, **issue a PayPal invoice, refund unclaimed money, or cancel the subscription**. Anything that changes money is only *proposed*; the funder must press **Confirm**.
4. **Outreach writer**: drafts the message to maintainers whose money is waiting.

No API key? Everything still works with built-in rule-based explanations and a rule-based agent.

## Sponsor tools

- **AG Grid Community**: the editable review table (`public/app.js`, loaded from jsDelivr). Falls back to a plain table if the CDN is unreachable.
- **Render**: deploy config in `render.yaml` (see below).
- **Postman**: ready-made collection in `postman/upstream.postman_collection.json`.

## Features

Repo URL or pasted `package.json` · dependency scan via npm + GitHub · explainable scoring · editable split with live budget bar · risk flags · PayPal subscription funding · batch payouts with live webhook status · maintainer claim (GitHub + PayPal) · automatic rollover of unclaimed/returned money · PayPal invoices · confirmation-gated AI agent · public ledger · shareable README badge · impact numbers on the dashboard.

## Quick start (VS Code)

Requires **Node.js 18.17+**. There are **no npm dependencies**: nothing to install.

```bash
cp .env.example .env        # Windows: copy .env.example .env
# fill in PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (and ANTHROPIC_API_KEY if you have one)
npm start                   # opens on http://localhost:3000
```

### 1. PayPal sandbox setup (about 10 minutes)

1. Go to <https://developer.paypal.com/dashboard/> and open **Apps & Credentials → Sandbox**.
2. Create an app (or use the default). Copy **Client ID** and **Secret** into `.env`.
3. Make sure the app has **Subscriptions**, **Payouts** and **Invoicing** enabled (App features), and **Log in with PayPal** if you want the maintainer login flow. Payouts needs your sandbox business account to hold a balance: add test funds in the sandbox account page if it is empty.
4. Under **Testing tools → Sandbox accounts**, create at least:
   - 1 **personal** account to act as the **funder** (approves the subscription),
   - 2 **personal** accounts to act as **maintainers** (receive payouts).
5. **Webhooks**: PayPal can only call a public HTTPS URL. Deploy to Render (below) or run `ngrok http 3000`, set `BASE_URL` to that URL, then in your app's **Webhooks** section add `https://YOUR-URL/api/webhooks/paypal` with these events: `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.SUSPENDED`, `BILLING.SUBSCRIPTION.EXPIRED`, `BILLING.SUBSCRIPTION.PAYMENT.FAILED`, `PAYMENT.SALE.COMPLETED`, and all `PAYMENT.PAYOUTS-ITEM.*` events. Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID`.
6. Optional: `npm run setup:paypal` creates the product and the four plans ($5/$10/$20/$50) up front and prints `PAYPAL_PLAN_IDS` (otherwise they are created on first use).

### 2. Run the demo (what judges will see)

1. Open the app, paste a public GitHub repo with a `package.json` (or paste one), choose a budget, **Scan**.
2. Review the split in the table. Edit an amount, watch the bar update. Enter your email and click **Start ... with PayPal**.
3. Approve the subscription in the PayPal popup with your sandbox **funder** account. PayPal charges the first cycle; the webhook arrives; allocations appear on the dashboard as **waiting for claim**.
4. Open **Maintainers: claim**. In sandbox demo mode, enter a maintainer name from the list and one of your sandbox **maintainer** emails, then **Claim**. A PayPal payout batch is sent; payout webhooks flip the rows to **paid** (the ledger shows batch / item / transaction ids).
5. Press **Run next cycle now** (sandbox helper) to show the next month, including rolled-over money, without waiting 30 days.
6. Ask the agent: "refund the unclaimed money" or "send me an invoice", then confirm.

> **Sandbox honesty note.** Maintainer accounts in the demo are PayPal sandbox test accounts, and "claim" uses sandbox demo mode (`CLAIM_DEMO_MODE=true`). For real verification set `CLAIM_DEMO_MODE=false` and configure `GITHUB_CLIENT_ID/SECRET` (callback `BASE_URL/auth/github/callback`) plus PayPal login (return URL `BASE_URL/auth/paypal/callback` in the app's Log in with PayPal settings). Repos owned by organisations cannot be claimed in real mode yet.
> "Run next cycle now" exists only because PayPal bills monthly; it calls the same payout code as the webhook path. Turn it off with `DEV_TOOLS=false`.

## Deploy on Render (public demo URL)

1. Push this repo to GitHub (public, MIT licensed).
2. On <https://render.com> create a **Web Service** from the repo (or use the Blueprint via `render.yaml`). Build command: none. Start command: `node server.js`.
3. Add the env vars from `.env.example` (at least `BASE_URL`, `PAYPAL_*`, optionally `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`).
4. Register `https://YOUR-SERVICE.onrender.com/api/webhooks/paypal` in the PayPal dashboard.
5. Note: the free tier's disk is wiped on every deploy/restart (the app stores data in `data/db.json`), so create your demo pledge shortly before recording, or attach a Render disk and set `DATA_DIR`. If plans are lost, they are simply re-created; pin them with `PAYPAL_PLAN_IDS`.

## Architecture

```
Browser (vanilla JS + AG Grid)  ──►  server.js (Node http, zero deps)
                                          │
   /api/scan ─► src/scan.js (npm, GitHub) ─► src/scoring.js (rules) ─► src/ai.js (explain)
   /api/pledges ─► PayPal Subscriptions (plan → subscription → approve link)
   /api/webhooks/paypal ─► verify signature ─► src/engine.js state machine
        SALE.COMPLETED ─► runCycle: rescan, split, hold or queue, Payouts batch, Invoicing
        PAYOUTS-ITEM.*  ─► paid / unclaimed / rolled over
   /api/claim, /auth/github, /auth/paypal ─► maintainer identity ─► release held money
   /api/agent ─► src/agent.js (LLM tools, confirmation gate) ─► PayPal refund / cancel / invoice
   data/db.json  (JSON file store)
```

## Tests

```bash
npm test
```

14 tests: scoring and allocation maths, plus an end-to-end flow (scan → subscription → webhooks → held → claim → payout → returned → rollover → agent refund) against a **local fake PayPal API** (`scripts/mock-paypal.js`, also runnable as `npm run mock:paypal` for offline development with `PAYPAL_BASE=http://localhost:4010`). The fake API checks our request shapes and flow logic; it is not the real PayPal.



## License

MIT, see [LICENSE](LICENSE).
