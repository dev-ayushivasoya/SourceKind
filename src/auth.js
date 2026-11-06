import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, uid } from "./store.js";
import { cfg } from "./config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "..", "public");
const PAGES = path.join(HERE, "pages");
const ROLES = ["maintainer", "contributor"];
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

const hash = (pw) => {
  const salt = crypto.randomBytes(16);
  return (
    salt.toString("hex") + ":" + crypto.scryptSync(pw, salt, 64).toString("hex")
  );
};
const verify = (pw, stored = "") => {
  const [s, k] = stored.split(":");
  if (!s || !k) return false;
  const d = crypto.scryptSync(pw, Buffer.from(s, "hex"), 64);
  return crypto.timingSafeEqual(d, Buffer.from(k, "hex"));
};
const html = (res, dir, file) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(path.join(dir, file)));
};
const login = (sess, user) => {
  sess.userId = user.id;
  sess.role = user.role;
  db.set("sessions", sess.id, sess);
};

// Returns true if it handled the request.
export async function handleAuth(req, res, url, h) {
  const { send, redirect, readBody, session } = h;
  const p = url.pathname,
    m = req.method;
  const isAuthRoute =
    p === "/login" ||
    p === "/" ||
    p === "/index.html" ||
    p.startsWith("/api/auth/") ||
    p.startsWith("/auth/login/") ||
    /^\/(maintainer|contributor)\/dashboard$/.test(p);
  if (!isAuthRoute) return false;

  const sess = h.sess ?? session(req, res);

  // The main page is only for signed-in users
  if (m === "GET" && (p === "/" || p === "/index.html")) {
    if (!sess.userId) {
      redirect(res, "/login");
      return true;
    }
    return false;
  }

  if (m === "GET" && p === "/login") {
    html(res, PUBLIC, "login.html");
    return true;
  }

  // Guarded dashboards
  let g;
  if (m === "GET" && (g = p.match(/^\/(maintainer|contributor)\/dashboard$/))) {
    if (sess.role !== g[1]) {
      redirect(res, "/login#" + g[1]);
      return true;
    }
    html(res, PAGES, g[1] + ".html");
    return true;
  }

  // Email sign up / sign in
  if (
    m === "POST" &&
    (g = p.match(/^\/api\/auth\/(maintainer|contributor)\/(signin|signup)$/))
  ) {
    const [, role, mode] = g;
    if (role === "maintainer") {
      send(res, 403, { message: "Maintainers sign in with GitHub." });
      return true;
    }
    let b;
    try {
      b = await readBody(req);
    } catch {
      send(res, 400, { message: "Invalid request." });
      return true;
    }
    const mail = String(b.email || "")
      .trim()
      .toLowerCase();
    const pw = String(b.password || "");

    if (mode === "signup") {
      if (
        !String(b.name || "").trim() ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) ||
        pw.length < 8
      ) {
        send(res, 400, {
          message: "Fill in every field. Password needs 8+ characters.",
        });
        return true;
      }
      const key = `${role}:${mail}`;
      if (db.get("user_index", key)) {
        send(res, 409, {
          message: "An account with this email already exists.",
        });
        return true;
      }
      const user = {
        id: uid("u_"),
        role,
        name: String(b.name).trim(),
        email: mail,
        org: b.org || null,
        handle: b.handle || null,
        passwordHash: hash(pw),
        createdAt: Date.now(),
      };
      db.set("users", user.id, user);
      db.set("user_index", key, { id: user.id });
      login(sess, user);
      send(res, 201, { ok: true });
      return true;
    }

    const idx = db.get("user_index", `${role}:${mail}`);
    const user = idx && db.get("users", idx.id);
    if (!user || !verify(pw, user.passwordHash)) {
      send(res, 401, { message: "Email or password is incorrect." });
      return true;
    }
    login(sess, user);
    send(res, 200, { ok: true });
    return true;
  }

  if (m === "POST" && p === "/api/auth/logout") {
    for (const key of [
      "userId",
      "role",
      "githubLogin",
      "paypal",
      "ghState",
      "ghRole",
      "ppState",
    ])
      delete sess[key];
    db.set("sessions", sess.id, sess);
    send(res, 200, { ok: true });
    return true;
  }

  if (m === "GET" && p === "/api/auth/me") {
    const u = sess.userId && db.get("users", sess.userId);
    send(res, 200, {
      user: u ? { id: u.id, role: u.role, name: u.name, email: u.email } : null,
    });
    return true;
  }

  // Password recovery: one page for both "forgot" and "reset"
  if (m === "GET" && p === "/auth/login/recover") {
    html(res, PUBLIC, "account-recovery.html");
    return true;
  }

  if (m === "POST" && p === "/api/auth/forgot") {
    let b;
    try {
      b = await readBody(req);
    } catch {
      send(res, 400, { message: "Invalid request." });
      return true;
    }
    const mail = String(b.email || "")
      .trim()
      .toLowerCase();
    const idx =
      ROLES.includes(b.role) && db.get("user_index", `${b.role}:${mail}`);
    if (idx) {
      const token = crypto.randomBytes(32).toString("hex");
      db.set("reset_tokens", sha(token), {
        userId: idx.id,
        expires: Date.now() + 30 * 60 * 1000,
        used: false,
      });
      // TODO: send this link by email once a mail service is connected.
      console.log(
        `\n[password reset] ${mail} (${b.role}): ${cfg.baseUrl}/auth/login/recover?token=${token}\n`,
      );
    }
    send(res, 200, { ok: true });
    return true; // same answer whether or not the account exists
  }

  if (m === "POST" && p === "/api/auth/reset") {
    let b;
    try {
      b = await readBody(req);
    } catch {
      send(res, 400, { message: "Invalid request." });
      return true;
    }
    const pw = String(b.password || "");
    if (pw.length < 8) {
      send(res, 400, { message: "Password needs at least 8 characters." });
      return true;
    }
    const key = sha(String(b.token || ""));
    const rec = db.get("reset_tokens", key);
    const user =
      rec &&
      !rec.used &&
      rec.expires > Date.now() &&
      db.get("users", rec.userId);
    if (!user) {
      send(res, 400, { message: "This reset link is invalid or has expired." });
      return true;
    }
    user.passwordHash = hash(pw);
    db.set("users", user.id, user);
    rec.used = true;
    db.set("reset_tokens", key, rec);
    send(res, 200, { ok: true });
    return true;
  }

  // GitHub OAuth
  if (m === "GET" && p === "/auth/login/github") {
    const role = ROLES.includes(url.searchParams.get("role"))
      ? url.searchParams.get("role")
      : "contributor";
    sess.ghState = crypto.randomBytes(16).toString("hex");
    sess.ghRole = role;
    db.set("sessions", sess.id, sess);
    redirect(
      res,
      "https://github.com/login/oauth/authorize?" +
        new URLSearchParams({
          client_id: process.env.LOGIN_GITHUB_CLIENT_ID,
          redirect_uri: process.env.LOGIN_GITHUB_CALLBACK_URL,
          scope: "read:user user:email",
          state: sess.ghState,
        }),
    );
    return true;
  }

  if (m === "GET" && p === "/auth/login/github/callback") {
    const code = url.searchParams.get("code");
    if (
      !code ||
      !sess.ghState ||
      url.searchParams.get("state") !== sess.ghState
    ) {
      send(res, 400, "Invalid sign-in state.");
      return true;
    }
    const role = sess.ghRole;
    delete sess.ghState;
    delete sess.ghRole;
    const tok = await (
      await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: process.env.LOGIN_GITHUB_CLIENT_ID,
          client_secret: process.env.LOGIN_GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: process.env.LOGIN_GITHUB_CALLBACK_URL,
        }),
      })
    ).json();
    if (!tok.access_token) {
      send(res, 401, "GitHub sign-in failed.");
      return true;
    }
    const gh = await (
      await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${tok.access_token}`,
          "User-Agent": "SourceKind",
        },
      })
    ).json();

    const key = `gh:${role}:${gh.id}`;
    let idx = db.get("user_index", key),
      user = idx && db.get("users", idx.id);
    if (!user) {
      user = {
        id: uid("u_"),
        role,
        name: gh.name || gh.login,
        handle: gh.login,
        email: (gh.email || "").toLowerCase(),
        githubId: gh.id,
        createdAt: Date.now(),
      };
      db.set("users", user.id, user);
      db.set("user_index", key, { id: user.id });
    }
    login(sess, user);
    redirect(res, "/");
    return true;
    return true;
  }

  return false;
}
