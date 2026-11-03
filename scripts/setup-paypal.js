// Creates the product and the four monthly plans in your PayPal sandbox and prints their ids.
// Optional: the app creates plans on first use anyway. Run this once if you want to pin them via PAYPAL_PLAN_IDS.
import { cfg } from '../src/config.js';
import * as pay from '../src/paypal.js';
import { db } from '../src/store.js';

if (!pay.configured()) { console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first.'); process.exit(1); }
const ids = {};
for (const t of cfg.tiers) { ids[t] = await pay.ensurePlan(t); console.log(`$${t}/month -> ${ids[t]}`); }
db.flush();
console.log('\nOptional: add this to .env to reuse these plans on another machine or on Render:\nPAYPAL_PLAN_IDS=' + JSON.stringify(ids));
