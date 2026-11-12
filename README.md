# SourceKind: pay the people your code runs on

Open-source libraries are often kept alive by one or two unpaid maintainers. GitHub Sponsors lets you fund them, but only if the maintainer has enrolled, and you still have to choose every amount yourself.

SourceKind takes a repo (or a `package.json`) and a monthly budget, scores each dependency, proposes a fair split, explains every share, and pays the maintainers through PayPal. Maintainers who have never signed up for anything get a claim link, and their money is held until they claim it.

## What PayPal does here (it is the engine, not a checkout button)

| Part of the product | PayPal feature | Where in code |
|---|---|---|
| The monthly clock: a pledge is a PayPal subscription; each billing cycle triggers a re-scan and a payout batch | Subscriptions API (product, plan, subscription, cancel) + webhooks `BILLING.SUBSCRIPTION.*`, `PAYMENT.SALE.COMPLETED` | `src/paypal.js`, `src/engine.js` |
| Paying maintainers in one batch | Payouts API (`PAYPAL_ID` or `EMAIL` recipients, idempotent `sender_batch_id`) | `sendPayoutBatch`, `payQueued` |
| Where the money is | Payout item webhooks (`SUCCEEDED`, `UNCLAIMED`, `RETURNED`, `FAILED`, `BLOCKED`, `HELD`...) drive a state machine: paid, waiting, or **rolled over** into the next cycle | `handleEvent` in `src/engine.js` |
| Trust | Every webhook is verified with `verify-webhook-signature`; events are idempotent and retry-safe | `verifyWebhook`, `/api/webhooks/paypal` |
| Maintainer identity | Login with PayPal (confirms the payee) + GitHub OAuth (proves they own the project) | `/auth/paypal`, `/auth/github` |
| Records | Invoicing API: a receipt invoice per cycle; Refunds API for unpaid money | `issueInvoice`, `refundSale` |
| Proof | The public ledger shows PayPal batch / item / transaction ids and offers a copyable public badge for contributor profiles; the badge reports payouts confirmed as paid | `/#/ledger`, `/badge/<pledge-id>.svg` |

How we split the money

For a budget $B$ and dependencies $i = 1, \dots, n$ with scores $s_i$, each share is proportional to its score:

$$\text{share}i = B \cdot \frac{s_i}{\sum{j=1}^{n} s_j}$$

In our demo, $B = 20$ and the scores sum to $662.6$, so a package scoring $84.6$ receives $20 \cdot \frac{84.6}{662.6} \approx \$2.55$. Because the shares always sum to $B$, the pool is fully allocated, and rebalancing after a funder edit is just recomputing the remaining shares.

## What the AI does

The AI never decides money. Amounts come from a deterministic scoring engine (`src/scoring.js`: need 40%, importance 30%, reach 20%, health 10%).

1. Explainer: writes a plain-language reason for every share and adds risk notes (one batched call, strict JSON, validated; falls back to templates if the model fails).
2. Risk flagger: rules + AI notes for archived/deprecated packages and look-alike (typo-squat) names.
3. Agent: answers questions about the current pledge, its dependencies, and payout statuses; it can also draft claim reminders, issue a PayPal invoice, refund unclaimed money, or cancel the subscription. Anything that changes money is only proposed; the funder must press Confirm.
4. Outreach writer: drafts the message to maintainers whose money is waiting.

No API key? Everything still works with built-in rule-based explanations and a rule-based agent.

## Sponsor tools

- AG Grid Community: the editable review table (`public/app.js`, loaded from jsDelivr). Falls back to a plain table if the CDN is unreachable.
- Postman: ready-made collection in `postman/upstream.postman_collection.json`.
- Render : For deployment

## Features

Repo URL or pasted `package.json` · dependency scan via npm + GitHub · explainable scoring · editable split with live budget bar · risk flags · PayPal subscription funding · batch payouts with live webhook status · maintainer claim (GitHub + PayPal) with pending, paid and other payout tabs · automatic rollover of unclaimed/returned money · PayPal invoices · confirmation-gated AI agent · public ledger · shareable README badge · impact numbers on the dashboard.

## Quick start (VS Code)

Requires **Node.js 18.17+**. There are **no npm dependencies**: nothing to install.

```bash
cp .env.example .env        # Windows: copy .env.example .env
# fill in PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (and ANTHROPIC_API_KEY if you have one)
npm start                   # opens on http://localhost:3000
```

For AI, use an Anthropic API key in `ANTHROPIC_API_KEY`, or an OpenRouter key in
`OPENROUTER_API_KEY`. OpenRouter keys are also auto-detected if they were placed
in `ANTHROPIC_API_KEY`. Set `LLM_MODEL` to a model ID (for example
`anthropic/claude-sonnet-5.5` for OpenRouter), not a URL. Restart the server
after changing `.env`.


## Run the demo

1. Open the app, paste a public GitHub repo with a `package.json` (or paste one), choose a budget, **Scan**.
2. Review the split in the table. Edit an amount, watch the bar update. Enter your email and click **Start ... with PayPal**.
3. Approve the subscription in the PayPal popup with your sandbox **funder** account. PayPal charges the first cycle; the webhook arrives; allocations appear on the dashboard as **waiting for claim**.
4. Open **Maintainers: claim**. In sandbox demo mode, enter a maintainer name from the list and one of your sandbox **maintainer** emails, then **Claim**. Track payouts in the maintainer page's **Pending**, **Paid**, and **Other** tabs as PayPal webhooks update their statuses.
5. Press **Run next cycle now** (sandbox helper) to show the next month, including rolled-over money, without waiting 30 days.
6. Ask the agent: "refund the unclaimed money" or "send me an invoice", then confirm.

> **Sandbox honesty note.** Maintainer accounts in the demo are PayPal sandbox test accounts, and "claim" uses sandbox demo mode (`CLAIM_DEMO_MODE=true`). For real verification set `CLAIM_DEMO_MODE=false`, configure maintainer GitHub sign-in (`LOGIN_GITHUB_CLIENT_ID/SECRET`, callback `BASE_URL/auth/login/github/callback`), and enable PayPal login with return URL `BASE_URL/auth/paypal/callback` in the PayPal app settings. Sign in as the maintainer first, then connect PayPal; the claim uses the signed-in GitHub handle automatically. Repos owned by organisations cannot be claimed in real mode yet.
> "Run next cycle now" exists only because PayPal bills monthly; it calls the same payout code as the webhook path. Turn it off with `DEV_TOOLS=false`.


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
