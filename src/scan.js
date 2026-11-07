import fs from "node:fs";
import { cfg } from "./config.js";

const GH = "https://api.github.com";
const ghHeaders = () => ({
  Accept: "application/vnd.github+json",
  "User-Agent": "upstream-hackathon",
  ...(cfg.github.token ? { Authorization: `Bearer ${cfg.github.token}` } : {}),
});

export function parseRepoUrl(url) {
  const u = String(url || "").trim();
  const m =
    u.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i) ||
    u.match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i); // also npm shorthand: "owner/repo", "github:owner/repo"
  return m ? { owner: m[1], repo: m[2] } : null;
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}
async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (res.status === 403 || res.status === 429)
    throw Object.assign(new Error("rate limited"), { rate: true });
  if (!res.ok) return null;
  return { json: await res.json(), headers: res.headers };
}

export async function fetchPackageJson({ owner, repo }) {
  const res = await fetch(
    `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/package.json`,
  );
  if (!res.ok)
    throw new Error(
      `Could not find package.json at the root of ${owner}/${repo}. Paste the file instead.`,
    );
  return res.json();
}

// Count how many source files import each package (a rough "how central is it to this project" signal).
async function countImports(r, names) {
  const meta = await getJson(`${GH}/repos/${r.owner}/${r.repo}`, ghHeaders());
  const branch = meta?.json.default_branch || "HEAD";
  const tree = await getJson(
    `${GH}/repos/${r.owner}/${r.repo}/git/trees/${branch}?recursive=1`,
    ghHeaders(),
  );
  const files = (tree?.json.tree || [])
    .filter(
      (f) =>
        f.type === "blob" &&
        /\.(m?[jt]sx?|cjs)$/.test(f.path) &&
        !/(^|\/)(node_modules|dist|build|\.next|coverage)\//.test(f.path) &&
        (f.size || 0) < 150000,
    )
    .slice(0, 60);
  const counts = Object.fromEntries(names.map((n) => [n, 0]));
  const re =
    /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
  await pool(files, 6, async (f) => {
    const txt = await fetch(
      `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${branch}/${f.path}`,
    )
      .then((x) => (x.ok ? x.text() : ""))
      .catch(() => "");
    const seen = new Set();
    for (const m of txt.matchAll(re)) {
      const s = m[1];
      if (s.startsWith(".") || s.startsWith("/")) continue;
      const root = s.startsWith("@")
        ? s.split("/").slice(0, 2).join("/")
        : s.split("/")[0];
      if (root in counts) seen.add(root);
    }
    seen.forEach((k) => counts[k]++);
  });
  return { counts, filesScanned: files.length };
}

async function packageSignals(name, version, kind, warnings) {
  const sig = {
    name,
    version,
    kind,
    repo: null,
    ownerLogin: null,
    ownerType: null,
    npmMaintainers: null,
    contributors: null,
    downloads: 0,
    archived: false,
    deprecated: false,
    lastPush: null,
    hasFunding: false,
    stars: null,
    license: null,
    imports: null,
  };
  try {
    const reg = await fetch(
      `https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`,
    );
    if (reg.ok) {
      const m = await reg.json();
      sig.npmMaintainers = Array.isArray(m.maintainers)
        ? m.maintainers.length
        : null;
      sig.deprecated = !!m.deprecated;
      sig.license =
        typeof m.license === "string" ? m.license : m.license?.type || null;
      const url =
        typeof m.repository === "string" ? m.repository : m.repository?.url;
      const rr = parseRepoUrl(url || m.homepage || "");
      if (rr) {
        sig.repo = `${rr.owner}/${rr.repo}`;
        sig.ownerLogin = rr.owner;
      }
    }
    const dl = await getJson(
      `https://api.npmjs.org/downloads/point/last-month/${name}`,
    );
    sig.downloads = dl?.json.downloads || 0;
  } catch {
    warnings.add(`npm lookup failed for ${name}`);
  }
  if (sig.repo) {
    const [owner, repo] = sig.repo.split("/");
    try {
      const r = await getJson(`${GH}/repos/${owner}/${repo}`, ghHeaders());
      if (r) {
        const j = r.json;
        sig.ownerLogin = j.owner?.login || owner;
        sig.ownerType = j.owner?.type;
        sig.archived = !!j.archived;
        sig.lastPush = j.pushed_at;
        sig.stars = j.stargazers_count;
        sig.repo = j.full_name || sig.repo;
      }
      const c = await getJson(
        `${GH}/repos/${owner}/${repo}/contributors?per_page=1&anon=false`,
        ghHeaders(),
      );
      if (c) {
        const last = (c.headers.get("link") || "").match(
          /[?&]page=(\d+)>; rel="last"/,
        );
        sig.contributors = last ? +last[1] : c.json.length;
      }
      const f = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/.github/FUNDING.yml`,
      );
      sig.hasFunding = f.ok;
    } catch (err) {
      if (err.rate)
        warnings.add(
          "GitHub rate limit reached: add GITHUB_TOKEN to .env for accurate scores",
        );
    }
  }
  return sig;
}

export async function scanProject({ repoUrl, packageJson }) {
  const warnings = new Set();
  if (cfg.scanFixture) {
    // used by automated tests only
    const fx = JSON.parse(fs.readFileSync(cfg.scanFixture, "utf8"));
    return {
      source: "fixture",
      packages: fx.packages,
      skipped: [],
      warnings: [],
    };
  }
  const r = repoUrl ? parseRepoUrl(repoUrl) : null;
  if (repoUrl && !r)
    throw new Error(
      "That does not look like a GitHub repository URL (expected https://github.com/owner/repo).",
    );
  const pkg = packageJson
    ? typeof packageJson === "string"
      ? JSON.parse(packageJson)
      : packageJson
    : await fetchPackageJson(r);
  const deps = [
    ...Object.entries(pkg.dependencies || {}).map(([n, v]) => [
      n,
      v,
      "runtime",
    ]),
    ...Object.entries(pkg.devDependencies || {}).map(([n, v]) => [n, v, "dev"]),
  ];
  if (!deps.length) throw new Error("No dependencies found in package.json.");
  // Runtime dependencies first; cap the scan so it stays fast and within API limits.
  const picked = deps
    .sort((a, b) => (a[2] === b[2] ? 0 : a[2] === "runtime" ? -1 : 1))
    .slice(0, cfg.maxPackages);
  const packages = await pool(picked, 5, ([n, v, k]) =>
    packageSignals(n, v, k, warnings),
  );
  if (r) {
    try {
      const { counts, filesScanned } = await countImports(
        r,
        packages.map((p) => p.name),
      );
      if (filesScanned)
        packages.forEach((p) => {
          p.imports = counts[p.name];
        });
    } catch (err) {
      warnings.add(
        err.rate
          ? "GitHub rate limit reached while counting imports"
          : "Could not count imports",
      );
    }
  }
  const skipped = packages
    .filter((p) => !p.repo)
    .map((p) => ({
      name: p.name,
      reason: "No GitHub repository listed on npm, so no maintainer to pay",
    }));
  if (deps.length > picked.length)
    warnings.add(
      `Scanned the first ${picked.length} of ${deps.length} dependencies (MAX_PACKAGES).`,
    );
  return {
    source: r ? `${r.owner}/${r.repo}` : "pasted package.json",
    packages: packages.filter((p) => p.repo),
    skipped,
    warnings: [...warnings],
  };
}
