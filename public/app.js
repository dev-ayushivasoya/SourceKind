// Upstream front end: dependency-free hash-routed SPA. AG Grid (CDN) renders the review table.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const usd = (n) => "$" + Number(n || 0).toFixed(2);
const app = $("#app");
let CFG = {},
  timer = null,
  gridApi = null;
const COLORS = [
  "#1d6f8f",
  "#d9c58b",
  "#0c2b36",
  "#6bb3c4",
  "#a4762c",
  "#3d8f6a",
  "#7a8fa0",
  "#b53a24",
];

async function api(path, body) {
  const res = await fetch(
    path,
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const pill = (s) =>
  `<span class="pill ${esc(s)}">${esc(String(s).replace(/_/g, " "))}</span>`;
const short = (s) =>
  s
    ? `<span class="mono" title="${esc(s)}">${esc(String(s).slice(0, 14))}${String(s).length > 14 ? "…" : ""}</span>`
    : '<span class="muted">pending</span>';

// ---------- Router ----------
let me = null;
function setupNav() {
  document.getElementById("nav").innerHTML =
    me.role === "maintainer"
      ? '<a href="#/claim">Claim your funding</a><a href="#" id="signout">Sign out</a>'
      : '<a href="#/ledger">Public ledger</a><a href="#" id="signout">Sign out</a>';
  document.getElementById("signout").onclick = async (e) => {
    e.preventDefault();
    await fetch("/api/auth/logout", { method: "POST" });
    location.href = "/login";
  };
}
async function render() {
  clearInterval(timer);
  gridApi = null;
  const [pathPart, qs] = location.hash.slice(2).split("?");
  const [name, arg] = pathPart.split("/");
  if (!me) {
    try {
      me = (await (await fetch("/api/auth/me")).json()).user;
    } catch {
      me = null;
    }
    if (!me) {
      location.href = "/login";
      return;
    }
    setupNav();
  }
  if (me.role === "maintainer" && name !== "claim") {
    location.hash = "#/claim";
    return;
  }
  if (me.role === "contributor" && name === "claim") {
    location.hash = "#/";
    return;
  }
  const q = new URLSearchParams(qs || "");
  try {
    if (name === "review") await reviewView(arg);
    else if (name === "pledge") await pledgeView(arg);
    else if (name === "ledger") await ledgerView();
    else if (name === "claim") await claimView(q);
    else homeView();
  } catch (err) {
    app.innerHTML = `<div class="panel"><h2>Something went wrong</h2><p class="err">${esc(err.message)}</p><a class="btn ghost" href="#/">Back to start</a></div>`;
  }
  app.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", render);

// ---------- Home ----------
function homeView() {
  app.innerHTML = `
  <section class="hero">
    <h1>Pay the people upstream.</h1>
    <p class="lede">Paste your project. ${esc(CFG.appName)} splits a monthly budget across the open-source maintainers it depends on, explains every share, and pays them through PayPal, including maintainers who never signed up for sponsorship.</p>
    <form class="scan panel" id="scan">
      <fieldset class="chips" aria-label="Input type"><label><input type="radio" name="mode" value="repo" checked><span>GitHub repo</span></label><label><input type="radio" name="mode" value="pkg"><span>Paste package.json</span></label></fieldset>
      <div id="repoBox"><label for="repoUrl">Repository URL</label><input type="text" id="repoUrl" name="repoUrl" placeholder="https://github.com/owner/repo" autocomplete="off"></div>
      <div id="pkgBox" hidden><label for="pkgJson">package.json contents</label><textarea id="pkgJson" name="packageJson" placeholder='{ "dependencies": { "express": "^4.19.0" } }'></textarea></div>
      <fieldset class="chips"><legend>Monthly budget</legend>${CFG.tiers.map((t, i) => `<label><input type="radio" name="budget" value="${t}" ${i === 1 ? "checked" : ""}><span>$${t}</span></label>`).join("")}</fieldset>
      <div class="row"><button class="btn" id="scanBtn">Scan dependencies</button><span class="muted small" id="scanMsg"></span></div>
      <div class="err" id="scanErr" role="alert"></div>
    </form>
  </section>
  <section class="how">
    <div><h3>Scan</h3><p>Reads your direct dependencies, then checks npm and GitHub for who maintains each one and how much support it already has.</p></div>
    <div><h3>Split</h3><p>Rules weigh need, importance to your project, reach and health. AI explains each share in plain language and flags risks. It never sets the amounts.</p></div>
    <div><h3>Pay</h3><p>A PayPal subscription funds the pool every month. Payouts go out in one batch, and PayPal's own payout statuses drive what happens next.</p></div>
  </section>`;
  const f = $("#scan");
  f.addEventListener("change", () => {
    const m = f.mode.value;
    $("#repoBox").hidden = m !== "repo";
    $("#pkgBox").hidden = m !== "pkg";
  });
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#scanErr").textContent = "";
    const body = { budget: Number(f.budget.value) };
    if (f.mode.value === "repo") body.repoUrl = f.repoUrl.value.trim();
    else body.packageJson = f.packageJson.value.trim();
    const btn = $("#scanBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Scanning';
    $("#scanMsg").textContent =
      "Reading npm and GitHub. This can take 10 to 30 seconds.";
    try {
      const scan = await api("/api/scan", body);
      location.hash = `#/review/${scan.id}`;
    } catch (err) {
      $("#scanErr").textContent = err.message;
      btn.disabled = false;
      btn.textContent = "Scan dependencies";
      $("#scanMsg").textContent = "";
    }
  });
}

// ---------- Review (AG Grid) ----------
function splitBar(rows, budget) {
  const act = rows.filter((r) => r.include && r.amount > 0);
  const total = act.reduce((t, r) => t + Number(r.amount), 0);
  const seg = act
    .map(
      (r, i) =>
        `<i style="width:${(r.amount / Math.max(budget, total)) * 100}%;background:${COLORS[i % COLORS.length]}" title="${esc(r.name)} ${usd(r.amount)}"></i>`,
    )
    .join("");
  const legend =
    act
      .slice(0, 6)
      .map(
        (r, i) =>
          `<span><b style="background:${COLORS[i % COLORS.length]}"></b>${esc(r.name)} ${usd(r.amount)}</span>`,
      )
      .join("") +
    (act.length > 6 ? `<span>+${act.length - 6} more</span>` : "");
  return {
    html: `<div class="splitbar" role="img" aria-label="Budget split">${seg}</div><div class="legend">${legend}</div>`,
    total,
  };
}

async function reviewView(id) {
  const scan = await api(`/api/scan/${id}`);
  const rows = scan.items.map((p) => ({
    ...p,
    include: p.amount > 0,
    amount: p.amount,
  }));
  const budget = scan.budget;
  app.innerHTML = `
  <h2>Your split for ${esc(scan.source)}</h2>
  <p class="muted">${scan.usedAI ? "Explanations written by AI from the data below." : "Explanations generated from templates (add an Anthropic key for AI explanations)."} Scores and amounts come from fixed rules, and you can edit any amount.</p>
  <div class="panel"><div class="readout"><span>Allocated <strong id="total">$0.00</strong> of <strong>${usd(budget)}</strong> per month</span><span id="left" class="muted"></span><button class="btn ghost small" id="rebalance">Rebalance to budget</button></div><div id="bar"></div></div>
  <div style="height:16px"></div>
  <div id="grid" class="ag-theme-quartz" style="height:${Math.min(620, 120 + rows.length * 62)}px"></div>
  <div id="fallback"></div>
  ${scan.skipped.length ? `<p class="muted small">Skipped (no GitHub repository on npm): ${scan.skipped.map((s) => esc(s.name)).join(", ")}.</p>` : ""}
  ${scan.warnings.map((w) => `<p class="notice small">${esc(w)}</p>`).join("")}
  <div class="panel" style="margin-top:20px;display:grid;gap:12px;max-width:640px">
    <div><label for="email">Your email (for the PayPal invoice receipts)</label><input type="email" id="email" placeholder="you@example.com"></div>
    <div class="row"><button class="btn" id="go">Start ${usd(budget)}/month with PayPal</button><span class="muted small">You approve the subscription in the PayPal sandbox. No real money moves.</span></div>
    <div class="err" id="goErr" role="alert"></div>
  </div>`;

  const refresh = () => {
    const b = splitBar(rows, budget);
    $("#bar").innerHTML = b.html;
    $("#total").textContent = usd(b.total);
    $("#total").classList.toggle("over", b.total > budget + 0.02);
    $("#left").textContent =
      b.total > budget + 0.02
        ? `Over budget by ${usd(b.total - budget)}`
        : b.total < budget - 0.02
          ? `${usd(budget - b.total)} unallocated`
          : "Fully allocated";
    if (gridApi)
      gridApi.setGridOption("pinnedBottomRowData", [
        { name: "Total", amount: b.total, reason: "" },
      ]);
  };
  $("#rebalance").onclick = () => {
    const act = rows.filter((r) => r.include && r.amount > 0),
      sum = act.reduce((t, r) => t + r.amount, 0);
    if (!sum) return;
    let cents = act.map((r) => Math.floor((r.amount / sum) * budget * 100));
    let left = budget * 100 - cents.reduce((t, c) => t + c, 0);
    for (let i = 0; left > 0; i = (i + 1) % cents.length, left--) cents[i]++;
    act.forEach((r, i) => {
      r.amount = cents[i] / 100;
    });
    if (gridApi) gridApi.refreshCells({ force: true });
    else drawFallback();
    refresh();
  };

  const drawFallback = () => {
    $("#fallback").innerHTML =
      `<div class="t-wrap"><table class="t"><thead><tr><th>Fund</th><th>Package</th><th>Score</th><th>Amount</th><th>Why</th></tr></thead><tbody>${rows.map((r, i) => `<tr><td><input type="checkbox" data-i="${i}" ${r.include ? "checked" : ""}></td><td>${esc(r.name)}<div class="muted small">${esc(r.repo)}</div></td><td>${r.score}</td><td><input type="text" data-a="${i}" value="${Number(r.amount).toFixed(2)}" style="width:90px"></td><td>${esc(r.reason)}${r.risk ? `<div class="err small">${esc(r.risk)}</div>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
    $("#fallback").onchange = (e) => {
      const t = e.target;
      if (t.dataset.i != null) rows[t.dataset.i].include = t.checked;
      if (t.dataset.a != null)
        rows[t.dataset.a].amount = Math.max(0, Number(t.value) || 0);
      refresh();
    };
  };

  let gridOk = false;
  if (window.agGrid?.createGrid) {
    try {
      $("#grid").style.display = "";
      gridApi = agGrid.createGrid($("#grid"), {
        rowData: rows,
        getRowId: (p) => p.data.name,
        animateRows: false,
        domLayout: "normal",
        defaultColDef: { sortable: true, resizable: true },
        pinnedBottomRowData: [{ name: "Total", amount: 0, reason: "" }],
        columnDefs: [
          {
            field: "include",
            headerName: "Fund",
            width: 80,
            editable: (p) => !p.node.rowPinned,
            sortable: false,
            cellDataType: "boolean",
          },
          {
            field: "name",
            headerName: "Package",
            width: 190,
            cellRenderer: (p) =>
              p.node.rowPinned
                ? `<b>${esc(p.value)}</b>`
                : `<div>${esc(p.value)}</div><div style="font-size:12px;opacity:.65">${esc(p.data.repo)}</div>`,
          },
          { field: "score", headerName: "Score", width: 90, sort: "desc" },
          {
            headerName: "Need",
            width: 85,
            valueGetter: (p) =>
              p.data?.need != null ? Math.round(p.data.need * 100) + "%" : "",
          },
          {
            headerName: "Used",
            width: 85,
            valueGetter: (p) =>
              p.data?.importance != null
                ? Math.round(p.data.importance * 100) + "%"
                : "",
          },
          {
            field: "amount",
            headerName: "Amount (USD)",
            width: 135,
            editable: (p) => !p.node.rowPinned,
            valueParser: (p) =>
              Math.max(0, Math.round((Number(p.newValue) || 0) * 100) / 100),
            valueFormatter: (p) => usd(p.value),
            cellStyle: { fontWeight: 700 },
          },
          {
            field: "risk",
            headerName: "Risk flags",
            width: 190,
            wrapText: true,
            autoHeight: true,
            cellStyle: { color: "#b53a24", lineHeight: "1.35" },
          },
          {
            field: "reason",
            headerName: "Why this share",
            flex: 1,
            minWidth: 320,
            wrapText: true,
            autoHeight: true,
            cellStyle: { lineHeight: "1.4", padding: "8px 12px" },
          },
        ],
        onCellValueChanged: () => refresh(),
      });
      gridOk = true;
    } catch (err) {
      console.warn("AG Grid failed, using the plain table instead:", err);
      gridApi = null;
    }
  }
  if (!gridOk) {
    $("#grid").style.display = "none";
    drawFallback();
  }
  refresh();

  $("#go").onclick = async () => {
    const btn = $("#go");
    $("#goErr").textContent = "";
    const amounts = Object.fromEntries(
      rows
        .filter((r) => r.include && r.amount > 0)
        .map((r) => [r.name, r.amount]),
    );
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Contacting PayPal';
    try {
      const out = await api("/api/pledges", {
        scanId: id,
        amounts,
        tier: budget,
        email: $("#email").value.trim(),
      });
      location.href = out.approveUrl;
    } catch (err) {
      $("#goErr").textContent = err.message;
      btn.disabled = false;
      btn.textContent = `Start ${usd(budget)}/month with PayPal`;
    }
  };
}

// ---------- Pledge dashboard ----------
async function pledgeView(id) {
  const history = [];
  app.innerHTML = '<div id="pl"></div>';
  const draw = async () => {
    const p = await api(`/api/pledges/${id}`);
    const t = p.totals;
    const hold = $("#chatBox")?.outerHTML; // keep the chat while polling
    $("#pl").innerHTML = `
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(p.source)}</h2><span>${pill(p.status)}</span></div>
    <p class="muted">${usd(p.tier)} per month through PayPal Subscriptions. Cycles run so far: ${p.cycles}.${p.status === "approval_pending" ? " Waiting for PayPal to confirm your subscription." : ""}</p>
    <div class="stats"><div class="stat ok"><strong>${usd(t.paid)}</strong><span>Paid to maintainers</span></div><div class="stat"><strong>${usd(t.inFlight)}</strong><span>On its way (PayPal payout pending)</span></div><div class="stat warn"><strong>${usd(t.awaitingClaim)}</strong><span>Waiting for maintainers to claim</span></div><div class="stat flare"><strong>${usd(t.rolledOver)}</strong><span>Rolled over to the next cycle</span></div></div>
    <div class="cols"><div>
      <h3>Payouts</h3>
      ${p.allocations.length ? `<div class="t-wrap"><table class="t"><thead><tr><th>Cycle</th><th>Package</th><th>Maintainer</th><th>Amount</th><th>Status</th><th>PayPal batch</th></tr></thead><tbody>${p.allocations.map((a) => `<tr><td>${a.cycle}</td><td>${esc(a.pkg)}</td><td>${esc(a.owner)}</td><td>${usd(a.amount)}</td><td>${pill(a.status)}${a.paypalStatus ? `<div class="muted small">PayPal: ${esc(a.paypalStatus.toLowerCase())}</div>` : ""}</td><td>${short(a.payoutBatchId)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">No cycle has run yet. The first payouts start as soon as PayPal confirms the first charge.</p>'}
      ${p.invoices.length ? `<h3 style="margin-top:22px">PayPal invoices</h3><p class="small">${p.invoices.map((i) => `Cycle ${i.cycle}: ${esc(i.number)}`).join(" · ")}</p>` : ""}
      <h3 style="margin-top:22px">Share it</h3>
      <p class="small muted">README badge:</p><code>![I fund my dependencies](${esc(location.origin)}/badge/${esc(p.id)}.svg)</code>
      <p class="small"><img alt="badge" src="/badge/${esc(p.id)}.svg"></p>
      ${CFG.devTools ? `<div class="panel" style="margin-top:18px"><p class="small"><b>Sandbox demo helper.</b> PayPal bills monthly. This button runs the next cycle now, through the same payout code, so you can show the full flow in one sitting.</p><button class="btn ghost small" id="sim">Run next cycle now</button> <span id="simMsg" class="small muted"></span></div>` : ""}
    </div>
    <div class="panel chat" id="chatBox"><h3>Ask the ${esc(CFG.appName)} agent</h3><p class="small muted">${CFG.aiEnabled ? "AI agent with PayPal tools." : "Rule-based mode (add ANTHROPIC_API_KEY for the AI agent)."} It can check status, draft reminders, issue an invoice, refund unclaimed money or cancel, but anything that changes money waits for your confirmation.</p><div class="msgs" id="msgs"></div><div class="row"><input type="text" id="msg" placeholder="e.g. refund the unclaimed money" style="flex:1"><button class="btn small" id="send">Send</button></div></div></div>`;
    wireChat();
    const sim = $("#sim");
    if (sim)
      sim.onclick = async () => {
        sim.disabled = true;
        $("#simMsg").textContent = "Running...";
        try {
          await api("/api/dev/simulate-cycle", { pledgeId: id });
          await draw();
        } catch (e) {
          $("#simMsg").textContent = e.message;
          sim.disabled = false;
        }
      };
  };
  const msgs = []; // persisted across redraws
  function wireChat() {
    const box = $("#msgs");
    const paint = () => {
      box.innerHTML = msgs.map((m) => m.html).join("");
      box.scrollTop = box.scrollHeight;
    };
    paint();
    const add = (cls, text) =>
      msgs.push({ html: `<div class="msg ${cls}">${esc(text)}</div>` });
    const send = async () => {
      const input = $("#msg");
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      add("me", text);
      paint();
      history.push({ role: "user", content: text });
      try {
        const r = await api("/api/agent", {
          pledgeId: id,
          message: text,
          history: history.slice(0, -1),
        });
        add("", r.reply || "(no reply)");
        history.push({ role: "assistant", content: r.reply || "" });
        r.actions.forEach((a) =>
          msgs.push({
            html: `<div class="action" data-id="${esc(a.id)}"><b>Needs your confirmation</b><div>${esc(a.summary)}</div><div class="row"><button class="btn small" data-yes>Confirm</button><button class="btn ghost small" data-no>Reject</button></div></div>`,
          }),
        );
      } catch (e) {
        add("", e.message);
      }
      paint();
    };
    $("#send").onclick = send;
    $("#msg").onkeydown = (e) => {
      if (e.key === "Enter") send();
    };
    box.onclick = async (e) => {
      const card = e.target.closest(".action");
      if (
        !card ||
        !(
          e.target.dataset.yes !== undefined ||
          e.target.dataset.no !== undefined
        )
      )
        return;
      const approve = e.target.dataset.yes !== undefined;
      card.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        const out = await api("/api/agent/confirm", {
          actionId: card.dataset.id,
          approve,
        });
        card.innerHTML = `<b>${approve ? (out.status === "done" ? "Done" : "Could not complete") : "Rejected"}</b><div>${esc(out.result || "")}</div>`;
        const i = msgs.findIndex((m) =>
          m.html.includes(`data-id="${card.dataset.id}"`),
        );
        if (i >= 0) msgs[i].html = card.outerHTML;
        await draw();
      } catch (err) {
        card.innerHTML = `<b>Error</b><div>${esc(err.message)}</div>`;
      }
    };
  }
  await draw();
  timer = setInterval(() => {
    if (!document.activeElement?.matches?.("#msg")) draw().catch(() => {});
  }, 6000);
}

// ---------- Public ledger ----------
async function ledgerView() {
  const rows = await api("/api/ledger");
  app.innerHTML = `<h2>Public ledger</h2><p class="muted">Every allocation with its PayPal payout batch, item and transaction ids, so anyone can check where the money went.</p>
  ${rows.length ? `<div class="t-wrap"><table class="t"><thead><tr><th>When</th><th>Package</th><th>Maintainer</th><th>Amount</th><th>Status</th><th>Batch</th><th>Item</th><th>Transaction</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${new Date(r.at).toLocaleDateString()}</td><td>${esc(r.pkg)}</td><td>${esc(r.owner)}</td><td>${usd(r.amount)}</td><td>${pill(r.status)}</td><td>${short(r.batchId)}</td><td>${short(r.itemId)}</td><td>${short(r.transactionId)}</td></tr>`).join("")}</tbody></table></div>` : '<div class="panel"><p>Nothing here yet. Allocations appear after the first subscription charge.</p><a class="btn" href="#/">Start a pledge</a></div>'}`;
}

// ---------- Maintainer claim ----------
async function claimView(q) {
  const s = await api("/api/claim/state");
  const pre = q.get("login") || s.githubLogin || "";
  app.innerHTML = `<h2>Maintainers: claim your funding</h2>
  <p class="lede">If someone who uses your project set money aside for you, claim it here. Prove you maintain the project with GitHub, tell PayPal where to send it, and the payout goes out in one batch.</p>
  <div class="cols"><div>
    ${s.held.length ? `<div class="cards">${s.held.map((h) => `<div class="card"><strong>${usd(h.total)}</strong><div>${esc(h.login)}</div><div class="muted small">${h.repos.map(esc).join(", ")}</div></div>`).join("")}</div>` : '<div class="panel"><p>No money is waiting for anyone yet. It appears here after a funder\'s first charge.</p></div>'}
  </div>
  <div class="panel" style="display:grid;gap:12px">
    <h3>Claim</h3>
    <div class="row"><span>GitHub: ${s.githubLogin ? `<b>${esc(s.githubLogin)}</b>` : CFG.githubOAuth ? '<a class="btn small" href="/auth/github">Sign in with GitHub</a>' : '<span class="muted">OAuth not configured</span>'}</span></div>
    <div class="row"><span>PayPal: ${s.paypal ? `<b>${esc(s.paypal.email)}</b>` : CFG.paypalLogin ? '<a class="btn small" href="/auth/paypal">Log in with PayPal</a>' : '<span class="muted">not configured</span>'}</span></div>
    ${
      s.demo
        ? `<div class="notice small">Sandbox demo mode is on: enter the maintainer name and a sandbox PayPal email instead of signing in. Turn this off with CLAIM_DEMO_MODE=false.</div>
      ${s.githubLogin ? "" : `<div><label for="login">Maintainer (GitHub name)</label><input type="text" id="login" value="${esc(pre)}" list="logins"><datalist id="logins">${s.held.map((h) => `<option value="${esc(h.login)}">`).join("")}</datalist></div>`}
      ${s.paypal ? "" : '<div><label for="ppEmail">Sandbox PayPal email to receive the money</label><input type="email" id="ppEmail" placeholder="maintainer-test@personal.example.com"></div>'}`
        : ""
    }
    <button class="btn" id="claim">Claim and get paid</button><div class="err" id="claimMsg" role="alert"></div>
  </div></div>`;
  $("#claim").onclick = async () => {
    const m = $("#claimMsg");
    m.className = "err";
    m.textContent = "";
    try {
      const r = await api("/api/claim", {
        login: $("#login")?.value.trim(),
        email: $("#ppEmail")?.value.trim(),
      });
      m.className = "small";
      m.style.color = "#1f7a4d";
      m.textContent = r.released
        ? `Released ${usd(r.total)} to PayPal. Watch the status on the funder's page.`
        : "Saved. Future contributions for you will be paid out automatically.";
      setTimeout(render, 1500);
    } catch (err) {
      m.textContent = err.message;
    }
  };
}

// ---------- Boot ----------
(async () => {
  CFG = await api("/api/config");
  $("#brand").textContent = CFG.appName;
  document.title = `${CFG.appName}: pay the people your code runs on`;
  const n = [];
  if (!CFG.paypalConfigured)
    n.push(
      "PayPal keys are missing. You can scan and review, but starting a subscription needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.",
    );
  if (!CFG.aiEnabled)
    n.push(
      "AI is in fallback mode (no ANTHROPIC_API_KEY). Explanations and the agent use built-in rules.",
    );
  $("#notices").innerHTML = n
    .map((x) => `<div class="notice">${esc(x)}</div>`)
    .join("");
  render();
})();
