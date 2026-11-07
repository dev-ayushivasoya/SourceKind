import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cfg } from "./src/config.js";
import { db, uid } from "./src/store.js";
import * as pay from "./src/paypal.js";
import * as engine from "./src/engine.js";
import * as agent from "./src/agent.js";
import { llmEnabled } from "./src/ai.js";
import { handleAuth } from "./src/auth.js";

const PUBLIC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "public",
);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const send = (res, code, body, headers = {}) => {
  const isObj = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(code, {
    "Content-Type": isObj ? "application/json" : "text/plain",
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
};
const redirect = (res, url, headers = {}) => {
  res.writeHead(302, { Location: url, ...headers });
  res.end();
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error("Body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const t = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(t ? JSON.parse(t) : {});
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
  });
const cookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim().split("="))
      .filter((x) => x[0]),
  );
function session(req, res) {
  let sid = cookies(req).sid;
  let s = sid && db.get("sessions", sid);
  if (!s) {
    sid = uid("s_");
    s = db.set("sessions", sid, { id: sid, createdAt: Date.now() });
    res.setHeader(
      "Set-Cookie",
      `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
    );
  }
  return s;
}
const fail = (status, message) => Object.assign(new Error(message), { status });

const routes = [];
const route = (method, pattern, fn) =>
  routes.push({
    method,
    re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"),
    fn,
  });

route("GET", "/api/health", async () => ({ ok: true, app: cfg.appName }));
route("GET", "/api/config", async () => ({
  appName: cfg.appName,
  tiers: cfg.tiers,
  minPayout: cfg.minPayout,
  devTools: cfg.devTools,
  claimDemo: cfg.claimDemo,
  paypalConfigured: pay.configured(),
  aiEnabled: llmEnabled(),
  githubOAuth: !!(cfg.github.clientId && cfg.github.clientSecret),
  paypalLogin: pay.loginEnabled(),
}));

// ---- Scan & pledge ----
route("POST", "/api/scan", async ({ body }) => {
  const budget = Number(body.budget);
  if (!cfg.tiers.includes(budget))
    throw fail(
      400,
      `Choose a monthly budget of ${cfg.tiers.map((t) => "$" + t).join(", ")}.`,
    );
  if (!body.repoUrl && !body.packageJson)
    throw fail(400, "Paste a GitHub repo URL or a package.json.");
  try {
    return await engine.createScan({
      repoUrl: body.repoUrl,
      packageJson: body.packageJson,
      budget,
    });
  } catch (e) {
    throw fail(400, e.message);
  }
});
route(
  "GET",
  "/api/scan/:id",
  async ({ params }) =>
    db.get("scans", params.id) ||
    (() => {
      throw fail(404, "Scan not found");
    })(),
);
route("POST", "/api/pledges", async ({ body }) => {
  if (!pay.configured())
    throw fail(
      503,
      "PayPal credentials are not set. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env and restart.",
    );
  try {
    const { pledge, approveUrl } = await engine.createPledge(body);
    return { id: pledge.id, approveUrl };
  } catch (e) {
    throw fail(e.status && e.status < 500 ? 400 : 502, e.message);
  }
});
route(
  "GET",
  "/api/pledges/:id",
  async ({ params }) =>
    engine.pledgeView(params.id) ||
    (() => {
      throw fail(404, "Pledge not found");
    })(),
);
route(
  "GET",
  "/api/impact/:id",
  async ({ params }) =>
    engine.impact(params.id) ||
    (() => {
      throw fail(404, "Pledge not found");
    })(),
);
route("GET", "/api/ledger", async () => engine.ledger());
route("GET", "/api/subscription/return", async ({ query, res }) => {
  const id = query.get("pledge");
  const p = db.get("pledges", id);
  if (p) {
    try {
      const s = await pay.getSubscription(p.subscriptionId);
      if (s.status === "ACTIVE" && p.status !== "active")
        db.update("pledges", id, { status: "active" });
    } catch {
      /* webhook will update it */
    }
  }
  return redirect(res, `/#/pledge/${id || ""}`);
});

// ---- Agent ----
route("POST", "/api/agent", async ({ body }) => {
  try {
    return await agent.chat(body);
  } catch (e) {
    throw fail(400, e.message);
  }
});
route("POST", "/api/agent/confirm", async ({ body }) => {
  try {
    return await agent.executeAction(body.actionId, !!body.approve);
  } catch (e) {
    throw fail(400, e.message);
  }
});

// ---- Maintainer claim ----
route("GET", "/api/claim/state", async ({ sess }) => {
  const user = sess.userId && db.get("users", sess.userId);
  const login =
    sess.githubLogin ||
    (sess.role === "maintainer" ? user?.handle : null) ||
    sess.claimLogin ||
    null;
  return {
    githubLogin: login,
    paypal: sess.paypal ? { email: sess.paypal.email } : null,
    demo: cfg.claimDemo,
    payouts: engine.payoutsFor(login),
    held: Object.values(
      engine.allHeld().reduce((m, a) => {
        const k = a.owner.toLowerCase();
        m[k] ||= { login: a.owner, repos: new Set(), total: 0 };
        m[k].repos.add(a.repo);
        m[k].total += a.amount;
        return m;
      }, {}),
    ).map((x) => ({
      login: x.login,
      repos: [...x.repos],
      total: Math.round(x.total * 100) / 100,
    })),
  };
});
route("POST", "/api/claim", async ({ body, sess }) => {
  const user = sess.userId && db.get("users", sess.userId);
  let login =
      sess.githubLogin ||
      (sess.role === "maintainer" ? user?.handle : null) ||
      sess.claimLogin,
    email = sess.paypal?.email,
    payerId = sess.paypal?.payerId;
  if (!login) {
    if (!cfg.claimDemo)
      throw fail(
        401,
        "Sign in with GitHub first to prove you maintain this project.",
      );
    login = String(body.login || "").trim();
  }
  if (!email) {
    if (!cfg.claimDemo) throw fail(401, "Connect your PayPal account first.");
    email = String(body.email || "").trim();
  }
  if (!login)
    throw fail(400, "Choose which maintainer account you are claiming for.");
  if (!/^\S+@\S+\.\S+$/.test(email || ""))
    throw fail(
      400,
      "Enter the email of the PayPal account that should receive the money.",
    );
  const result = await engine.claim({ login, email, payerId });
  db.update("sessions", sess.id, { claimLogin: login });
  return result;
});
route("POST", "/api/dev/seed-held", async ({ body, sess }) => {
  if (!cfg.devTools) throw fail(404, "Not found");
  const user = sess.userId && db.get("users", sess.userId);
  const login =
    sess.githubLogin || (sess.role === "maintainer" ? user?.handle : null);
  if (!login) throw fail(401, "Sign in as a maintainer first.");
  const amount = Math.max(Number(body?.amount) || 5, cfg.minPayout);
  return engine.seedHeld({
    login,
    amount,
    pkg: "demo-package",
    repo: `${login}/demo-package`,
  });
});
route("GET", "/auth/github", async ({ res, sess }) => {
  if (!cfg.github.clientId)
    throw fail(
      503,
      "GitHub OAuth is not configured (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET).",
    );
  const state = pay.randomState();
  db.update("sessions", sess.id, { ghState: state });
  return redirect(
    res,
    `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: cfg.github.clientId, redirect_uri: `${cfg.baseUrl}/auth/github/callback`, scope: "read:user", state })}`,
  );
});
route("GET", "/auth/github/callback", async ({ query, res, sess }) => {
  if (query.get("state") !== sess.ghState) throw fail(400, "Invalid state");
  const tok = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: cfg.github.clientId,
      client_secret: cfg.github.clientSecret,
      code: query.get("code"),
    }),
  }).then((r) => r.json());
  const user = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tok.access_token}`,
      "User-Agent": "sourcekind-hackathon",
    },
  }).then((r) => r.json());
  if (!user.login) throw fail(400, "GitHub sign-in failed");
  db.update("sessions", sess.id, { githubLogin: user.login });
  return redirect(res, "/#/claim");
});
route("GET", "/auth/paypal", async ({ res, sess }) => {
  const state = pay.randomState();
  db.update("sessions", sess.id, { ppState: state });
  return redirect(res, pay.loginUrl(state));
});
route("GET", "/auth/paypal/callback", async ({ query, res, sess }) => {
  if (query.get("state") !== sess.ppState) throw fail(400, "Invalid state");
  delete sess.ppState;
  db.set("sessions", sess.id, sess);
  if (query.has("error"))
    throw fail(400, "PayPal sign-in was not completed. Please try again.");
  const code = query.get("code");
  if (!code) throw fail(400, "PayPal did not return an authorization code.");
  const who = await pay.exchangeLoginCode(code);
  db.update("sessions", sess.id, { paypal: who });
  return redirect(res, "/#/claim");
});

// ---- PayPal webhooks ----
route("POST", "/api/webhooks/paypal", async ({ req, body }) => {
  let ok = false;
  try {
    ok = await pay.verifyWebhook(req.headers, body);
  } catch (e) {
    console.error("webhook verify error:", e.message);
    throw fail(500, "Cannot verify webhook");
  }
  if (!ok) throw fail(400, "Invalid webhook signature");
  return engine.handleEvent(body);
});

// ---- Sandbox helper: run a cycle now instead of waiting a month. Uses the SAME payout code path. ----
route("POST", "/api/dev/simulate-cycle", async ({ body }) => {
  if (!cfg.devTools) throw fail(404, "Not found");
  const p = db.get("pledges", body.pledgeId);
  if (!p) throw fail(404, "Pledge not found");
  const c = await engine.runCycle(p, { amount: p.tier });
  return c;
});
route("POST", "/api/dev/expire-held", async () => {
  if (!cfg.devTools) throw fail(404, "Not found");
  return { rolledOver: engine.expireHeld() };
});

// ---- Badge ----
route("GET", "/badge/:file", async ({ params, res }) => {
  const id = params.file.replace(/\.svg$/, "");
  const p = db.get("pledges", id);
  const paid = p ? engine.impact(id).paid : 0;
  const left = cfg.appName;
  const right = `$${Number(paid).toFixed(2)} paid to maintainers`;
  const xml = value => String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[c]);
  const w1 = left.length * 6.4 + 16,
    w2 = right.length * 6.4 + 16;
  res.writeHead(200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": "public, max-age=60",
  });
  res.end(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w1 + w2}" height="22" role="img" aria-label="${xml(left)}: ${xml(right)}"><rect width="${w1}" height="22" fill="#0c2b36"/><rect x="${w1}" width="${w2}" height="22" fill="#1d6f8f"/><g fill="#fff" font-family="Verdana,sans-serif" font-size="11"><text x="8" y="15">${xml(left)}</text><text x="${w1 + 8}" y="15">${xml(right)}</text></g></svg>`,
  );
});

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC, p));
  if (
    !file.startsWith(PUBLIC) ||
    !fs.existsSync(file) ||
    fs.statSync(file).isDirectory()
  )
    return send(res, 404, "Not found");
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
  });
  fs.createReadStream(file).pipe(res);
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, cfg.baseUrl);
  if (await handleAuth(req, res, url, { send, redirect, readBody, session }))
    return;
  const match = routes.find(
    (r) => r.method === req.method && r.re.test(url.pathname),
  );
  if (!match)
    return req.method === "GET"
      ? serveStatic(req, res)
      : send(res, 404, { error: "Not found" });
  if (
    url.pathname.startsWith("/api/claim") &&
    session(req, res).role !== "maintainer"
  ) {
    return send(res, 403, { error: "Maintainers only." });
  }
  try {
    const body = req.method === "POST" ? await readBody(req) : {};
    const params = url.pathname.match(match.re).groups || {};
    const out = await match.fn({
      req,
      res,
      body,
      params,
      query: url.searchParams,
      sess: session(req, res),
    });
    if (!res.writableEnded) send(res, 200, out ?? { ok: true });
  } catch (err) {
    if (res.writableEnded) return;
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    send(res, status, { error: err.message });
  }
});

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  server.listen(cfg.port, () => {
    console.log(`\n  ${cfg.appName} running at ${cfg.baseUrl}`);
    console.log(
      `  PayPal: ${pay.configured() ? "credentials found" : "NOT configured (add keys to .env)"} | AI: ${llmEnabled() ? cfg.llm.model : "fallback mode (no ANTHROPIC_API_KEY)"}`,
    );
    console.log(
      `  Webhook URL to register in PayPal: ${cfg.baseUrl}/api/webhooks/paypal\n`,
    );
  });
  setInterval(() => {
    const n = engine.expireHeld();
    if (n) console.log(`rolled over ${n} unclaimed allocations`);
  }, 3600e3).unref();
}
