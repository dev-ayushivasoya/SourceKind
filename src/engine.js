import { cfg } from "./config.js";
import { db, uid } from "./store.js";
import * as pay from "./paypal.js";
import { scanProject } from "./scan.js";
import { scoreAll, allocate } from "./scoring.js";
import { explainAllocations, draftOutreach } from "./ai.js";

const money = (n) => Math.round(n * 100) / 100;
const PAID_OUT = new Set(["paid"]);
const ROLL = new Set([
  "RETURNED",
  "FAILED",
  "BLOCKED",
  "DENIED",
  "CANCELED",
  "REFUNDED",
  "REVERSED",
]);

// ---------- Step 1: scan + propose a split ----------
export async function createScan({ repoUrl, packageJson, budget }) {
  const raw = await scanProject({ repoUrl, packageJson });
  const scored = scoreAll(raw.packages);
  const eligible = scored.filter((p) => p.eligible);
  const shares = allocate(
    Object.fromEntries(eligible.map((p) => [p.name, p.score])),
    budget,
    cfg.minPayout,
  );
  const items = scored.map((p) => ({ ...p, amount: shares[p.name] || 0 }));
  const { map, usedAI } = await explainAllocations(
    items.filter((p) => p.amount > 0),
  );
  const final = items.map((p) => ({
    ...p,
    reason:
      map[p.name]?.reason ||
      (p.eligible
        ? "Below the minimum payout, so it is not funded this month."
        : `Not funded: ${p.flags[0] || "ineligible"}.`),
    risk: [...p.flags, map[p.name]?.aiRisk].filter(Boolean).join("; "),
  }));
  const id = uid("scan_");
  db.set("scans", id, {
    id,
    source: raw.source,
    budget,
    items: final,
    skipped: raw.skipped,
    warnings: raw.warnings,
    usedAI,
    createdAt: Date.now(),
  });
  return db.get("scans", id);
}

// ---------- Step 2: user edits the table, then starts a PayPal subscription ----------
export async function createPledge({ scanId, amounts, tier, email }) {
  const scan = db.get("scans", scanId);
  if (!scan) throw new Error("Scan not found. Run the scan again.");
  if (!cfg.tiers.includes(Number(tier)))
    throw new Error(
      `Budget must be one of: ${cfg.tiers.map((t) => "$" + t).join(", ")}`,
    );
  const chosen = scan.items.filter((p) => Number(amounts?.[p.name]) > 0);
  const sum = chosen.reduce((t, p) => t + Number(amounts[p.name]), 0);
  if (!chosen.length || sum <= 0)
    throw new Error("Select at least one package with an amount above $0.");
  if (sum > Number(tier) + 0.02)
    throw new Error(
      `Your amounts add up to $${sum.toFixed(2)}, which is above the $${tier} budget.`,
    );
  const shares = Object.fromEntries(
    chosen.map((p) => [p.name, Number(amounts[p.name]) / sum]),
  );
  const id = uid("pl_");
  const subArgs = {
    customId: id,
    email: email || undefined,
    returnUrl: `${cfg.baseUrl}/api/subscription/return?pledge=${id}`,
    cancelUrl: `${cfg.baseUrl}/#/review/${scanId}`,
  };
  let planId, sub;
  try {
    planId = await pay.ensurePlan(tier);
    sub = await pay.createSubscription({ planId, ...subArgs });
  } catch (err) {
    // A 404 usually means a cached plan from a different PayPal app/credentials. Re-create plans once and retry.
    if (err.status !== 404 || Object.keys(cfg.paypal.planIds).length) throw err;
    console.warn(
      "Cached PayPal plan not found; re-creating plans and retrying once.",
    );
    pay.forgetPlans();
    planId = await pay.ensurePlan(tier);
    sub = await pay.createSubscription({ planId, ...subArgs });
  }
  const pledge = db.set("pledges", id, {
    id,
    scanId,
    source: scan.source,
    tier: Number(tier),
    email: email || "",
    shares,
    packages: Object.fromEntries(
      chosen.map((p) => [
        p.name,
        { repo: p.repo, owner: p.ownerLogin, reason: p.reason, flags: p.flags },
      ]),
    ),
    subscriptionId: sub.id,
    planId,
    status: "approval_pending",
    cycles: 0,
    carryover: 0,
    createdAt: Date.now(),
  });
  return { pledge, approveUrl: sub.approveUrl };
}

// ---------- Step 3: a PayPal charge arrives, so the cycle runs ----------
export async function runCycle(pledge, { saleId, amount }) {
  if (saleId && db.get("cycles", saleId)) return db.get("cycles", saleId); // idempotent
  const cycleNo = (pledge.cycles || 0) + 1;
  const gross = Number(amount ?? pledge.tier);
  const pool = money(gross * (1 - cfg.feePct / 100) + (pledge.carryover || 0));
  // Re-scan so the PayPal billing clock keeps the data fresh. Packages that went archived/deprecated drop out.
  let shares = { ...pledge.shares };
  try {
    const raw = await scanProject({
      repoUrl:
        pledge.source.includes("/") && !pledge.source.startsWith("pasted")
          ? `https://github.com/${pledge.source}`
          : undefined,
      packageJson: undefined,
    });
    const bad = new Set(
      raw.packages.filter((p) => p.archived || p.deprecated).map((p) => p.name),
    );
    for (const k of Object.keys(shares)) if (bad.has(k)) delete shares[k];
  } catch {
    /* keep previous shares if the rescan fails */
  }
  if (!Object.keys(shares).length) shares = { ...pledge.shares };
  const split = allocate(shares, pool, cfg.minPayout);
  const cycleId = saleId || uid("sim_");
  const allocs = [];
  for (const [name, amt] of Object.entries(split)) {
    const meta = pledge.packages?.[name];
    if (!meta || !meta.repo) continue;
    const owner = meta.owner;
    const m = owner ? db.get("maintainers", owner.toLowerCase()) : null;
    const a = {
      id: uid("al_"),
      pledgeId: pledge.id,
      cycle: cycleNo,
      pkg: name,
      repo: meta.repo,
      owner,
      amount: amt,
      reason: meta.reason || "Maintainer split",
      status: m?.payee ? "queued" : "held",
      claimBy: Date.now() + cfg.claimExpiryDays * 864e5,
      createdAt: Date.now(),
      payoutBatchId: null,
      payoutItemId: null,
      transactionId: null,
    };
    db.set("allocations", a.id, a);
    allocs.push(a);
  }
  db.set("cycles", cycleId, {
    id: cycleId,
    pledgeId: pledge.id,
    cycle: cycleNo,
    gross,
    pool,
    saleId: saleId || null,
    at: Date.now(),
  });
  db.update("pledges", pledge.id, {
    cycles: cycleNo,
    carryover: 0,
    lastCycleAt: Date.now(),
    lastSaleId: saleId || pledge.lastSaleId,
  });
  await payQueued(
    allocs.filter((a) => a.status === "queued"),
    `${pledge.id}_c${cycleNo}`,
  );
  // Receipt via PayPal Invoicing (best effort: never blocks the money flow)
  if (pledge.email)
    pay
      .issueInvoice({
        email: pledge.email,
        amount: gross,
        cycle: cycleNo,
        pledgeId: pledge.id,
        saleId,
      })
      .then((inv) =>
        db.set("invoices", inv.id, {
          ...inv,
          pledgeId: pledge.id,
          cycle: cycleNo,
        }),
      )
      .catch((err) => console.warn("invoice skipped:", err.message));
  return db.get("cycles", cycleId);
}

async function payQueued(allocs, batchId) {
  if (!allocs.length) return null;
  const items = allocs.flatMap((a) => {
    const owner =
      typeof a.owner === "string" ? a.owner.trim().toLowerCase() : "";
    const m = owner ? db.get("maintainers", owner) : null;
    if (!m?.payee) {
      db.update("allocations", a.id, {
        status: "held",
        error: "Missing maintainer payout details",
      });
      return [];
    }
    return [
      {
        id: a.id,
        receiver: m.payee,
        payerId: m.payerId,
        amount: a.amount,
        note: `${a.pkg}: thank you for maintaining it`,
      },
    ];
  });
  if (!items.length) return null;
  try {
    const out = await pay.sendPayoutBatch(batchId, items);
    allocs.forEach((a) =>
      db.update("allocations", a.id, {
        status: "sent",
        payoutBatchId: out.batchId,
      }),
    );
    return out;
  } catch (err) {
    console.error("payout batch failed:", err.message);
    console.dir(err, { depth: null });
    allocs.forEach((a) =>
      db.update("allocations", a.id, { status: "failed", error: err.message }),
    );
    for (const a of allocs) rollover(a);
    return null;
  }
}

function rollover(a) {
  const pl = db.get("pledges", a.pledgeId);
  if (!pl) return;
  db.update("pledges", pl.id, {
    carryover: money((pl.carryover || 0) + a.amount),
  });
  db.update("allocations", a.id, {
    status: "rolled_over",
    rolledAt: Date.now(),
  });
}

// Demo helper: puts money "set aside" for a maintainer, as if a funder had sponsored them.
export function seedHeld({ login, amount, pkg, repo }) {
  const owner = String(login || "").trim();
  if (!owner) throw new Error("Maintainer login is required.");
  const a = {
    id: uid("al_"),
    pledgeId: uid("demo_"),
    cycle: 1,
    pkg,
    repo,
    owner,
    amount: money(Number(amount)),
    reason: "Demo: money set aside by a funder",
    status: "held",
    claimBy: Date.now() + cfg.claimExpiryDays * 864e5,
    createdAt: Date.now(),
    payoutBatchId: null,
    payoutItemId: null,
    transactionId: null,
  };
  db.set("allocations", a.id, a);
  return a;
}

// ---------- Maintainer claim ----------
export async function claim({ login, email, payerId }) {
  const key = typeof login === "string" ? login.trim().toLowerCase() : "";
  if (!key) throw new Error("Maintainer login is required.");
  const payee = typeof email === "string" ? email.trim() : "";
  if (!payee || !/^\S+@\S+\.\S+$/.test(payee))
    throw new Error("Enter a valid PayPal email for the maintainer.");
  const m = db.set("maintainers", key, {
    login: login.trim(),
    payee,
    payerId: payerId || null,
    claimedAt: Date.now(),
  });
  const held = db.filter(
    "allocations",
    (a) =>
      a.owner?.toLowerCase() === key &&
      a.status === "held" &&
      a.claimBy > Date.now(),
  );
  const byBatch = {};
  for (const a of held)
    (byBatch[`${a.pledgeId}_c${a.cycle}_claim_${key}`] ||= []).push(a);
  for (const [batch, list] of Object.entries(byBatch))
    await payQueued(list, batch);
  return {
    maintainer: m,
    released: held.length,
    total: money(held.reduce((t, a) => t + a.amount, 0)),
  };
}
export const heldFor = (login) => {
  const key = typeof login === "string" ? login.trim().toLowerCase() : "";
  if (!key) return [];
  return db.filter(
    "allocations",
    (a) => a.owner?.toLowerCase() === key && a.status === "held",
  );
};
export const allHeld = () =>
  db.filter("allocations", (a) => a.status === "held");

export function expireHeld() {
  let n = 0;
  for (const a of db.filter(
    "allocations",
    (a) => a.status === "held" && a.claimBy < Date.now(),
  )) {
    rollover(a);
    n++;
  }
  return n;
}

// ---------- Webhook router: PayPal events drive every state change ----------
export async function handleEvent(ev) {
  if (!ev?.id || !ev.event_type) return { ignored: true };
  if (db.get("events", ev.id)) return { duplicate: true };
  db.set("events", ev.id, { id: ev.id, type: ev.event_type, at: Date.now() });
  try {
    return await route(ev);
  } catch (err) {
    db.del("events", ev.id);
    throw err;
  } // let PayPal retry
}
async function route(ev) {
  const r = ev.resource || {};
  switch (ev.event_type) {
    case "BILLING.SUBSCRIPTION.ACTIVATED": {
      const pl =
        db.get("pledges", r.custom_id) ||
        db.find("pledges", (p) => p.subscriptionId === r.id);
      if (pl)
        db.update("pledges", pl.id, {
          status: "active",
          subscriptionId: r.id,
          activatedAt: Date.now(),
        });
      break;
    }
    case "BILLING.SUBSCRIPTION.CANCELLED":
    case "BILLING.SUBSCRIPTION.SUSPENDED":
    case "BILLING.SUBSCRIPTION.EXPIRED": {
      const pl = db.find("pledges", (p) => p.subscriptionId === r.id);
      if (pl)
        db.update("pledges", pl.id, {
          status: ev.event_type.split(".").pop().toLowerCase(),
        });
      break;
    }
    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED": {
      const pl = db.find("pledges", (p) => p.subscriptionId === r.id);
      if (pl) db.update("pledges", pl.id, { lastPaymentFailedAt: Date.now() });
      break;
    }
    case "PAYMENT.SALE.COMPLETED": {
      const pl = db.find(
        "pledges",
        (p) => p.subscriptionId === r.billing_agreement_id,
      );
      if (pl) {
        if (pl.status !== "active")
          db.update("pledges", pl.id, { status: "active" });
        await runCycle(db.get("pledges", pl.id), {
          saleId: r.id,
          amount: r.amount?.total,
        });
      }
      break;
    }
    default:
      if (ev.event_type.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
        const status = ev.event_type.split(".").pop(); // SUCCEEDED, UNCLAIMED, RETURNED, FAILED, BLOCKED, HELD, ...
        const itemId = r.payout_item?.sender_item_id || r.sender_item_id;
        const a =
          (itemId && db.get("allocations", itemId)) ||
          db.find(
            "allocations",
            (x) => x.payoutItemId && x.payoutItemId === r.payout_item_id,
          );
        if (a) {
          db.update("allocations", a.id, {
            payoutItemId: r.payout_item_id || a.payoutItemId,
            payoutBatchId: r.payout_batch_id || a.payoutBatchId,
            transactionId: r.transaction_id || a.transactionId,
            paypalStatus: status,
          });
          if (status === "SUCCEEDED")
            db.update("allocations", a.id, {
              status: "paid",
              paidAt: Date.now(),
            });
          else if (status === "UNCLAIMED")
            db.update("allocations", a.id, { status: "unclaimed" });
          else if (status === "HELD")
            db.update("allocations", a.id, { status: "on_hold" });
          else if (ROLL.has(status) && a.status !== "rolled_over") rollover(a);
        }
      }
  }
  return { handled: ev.event_type };
}

// ---------- Read models ----------
export function pledgeView(id) {
  const p = db.get("pledges", id);
  if (!p) return null;
  const allocations = db
    .filter("allocations", (a) => a.pledgeId === id)
    .sort((a, b) => b.createdAt - a.createdAt);
  const sum = (st) =>
    money(
      allocations
        .filter((a) => st.includes(a.status))
        .reduce((t, a) => t + a.amount, 0),
    );
  return {
    ...p,
    allocations,
    invoices: db.filter("invoices", (i) => i.pledgeId === id),
    totals: {
      paid: sum(["paid"]),
      inFlight: sum(["sent", "queued", "unclaimed", "on_hold"]),
      awaitingClaim: sum(["held"]),
      rolledOver: sum(["rolled_over"]),
    },
  };
}
export function ledger() {
  return db
    .all("allocations")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 300)
    .map((a) => ({
      pkg: a.pkg,
      repo: a.repo,
      owner: a.owner,
      amount: a.amount,
      cycle: a.cycle,
      status: a.status,
      paypalStatus: a.paypalStatus || null,
      batchId: a.payoutBatchId,
      itemId: a.payoutItemId,
      transactionId: a.transactionId,
      at: a.createdAt,
    }));
}
export function impact(id) {
  const v = pledgeView(id);
  if (!v) return null;
  const owners = new Set(v.allocations.map((a) => a.owner));
  return {
    source: v.source,
    cycles: v.cycles,
    maintainers: owners.size,
    projects: new Set(v.allocations.map((a) => a.pkg)).size,
    ...v.totals,
    total: money(v.allocations.reduce((t, a) => t + a.amount, 0)),
  };
}
export { PAID_OUT };
export async function outreachFor(login) {
  const key = typeof login === "string" ? login.trim() : "";
  if (!key) return null;
  const held = heldFor(key);
  if (!held.length) return null;
  return draftOutreach({
    login: key,
    repo: held[0].repo,
    amount: money(held.reduce((t, a) => t + a.amount, 0)),
    claimUrl: `${cfg.baseUrl}/#/claim?login=${encodeURIComponent(key)}`,
  });
}
