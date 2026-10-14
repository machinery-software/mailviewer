#!/usr/bin/env node
// Refuse to ship a known-vulnerable dependency.
//
//   node scripts/security-gate.mjs --config security-gate.json --lockfile package-lock.json \
//        [--osv-json FILE | --run-osv] [--npm-audit-json FILE | --run-npm-audit] \
//        [--today YYYY-MM-DD] [--github]
//
// Reads what OSV-Scanner and/or `npm audit --omit=dev` report against a
// lockfile and decides, for every advisory, whether it may ship:
//
//   - Shipped or build-only. `"shipped": "production"` counts every package the
//     lockfile does not mark dev (the web app: what Vite bundles comes only
//     from these). A path instead names a list file, one package per line (the
//     Mac app: only what is inside its parser bundle).
//   - Blocking. A shipped advisory of high or critical severity blocks. So does
//     a moderate one in a package on the `reachable` list: the packages that
//     read attacker-controlled mail (DOMPurify's sanitizer bypasses are rated
//     moderate, and they are exactly what matters to a mail viewer). A shipped
//     advisory whose severity is unknown blocks too: fail closed.
//   - Allowlisted. An entry in `allowlist` with the advisory's id (or an
//     alias such as its CVE), the package, a reason and an expiry date no more
//     than a year out lets one blocking advisory through until it expires.
//   - Everything else is reported, and build-only advisories are warnings.
//
// Exit 0: nothing blocks. Exit 1: something blocks. Exit 2: the gate could not
// decide (bad config or allowlist, a scanner missing or failing): treat as a
// refusal. --run-osv and --run-npm-audit need the network; tests pass the
// recorded JSON instead. --github adds GitHub Actions annotations and a job
// summary.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEVERITIES = ["low", "moderate", "high", "critical"];
const rank = (s) => SEVERITIES.indexOf(s);

export class GateError extends Error {}

/** CVSS base score to the GitHub/npm severity words. */
export function cvssBand(score) {
  const n = Number(score);
  if (!Number.isFinite(n) || score === "" || score == null) return null;
  if (n >= 9) return "critical";
  if (n >= 7) return "high";
  if (n >= 4) return "moderate";
  return n > 0 ? "low" : null;
}

function normaliseSeverity(s) {
  if (!s) return null;
  const w = String(s).toLowerCase();
  if (w === "medium") return "moderate";
  return SEVERITIES.includes(w) ? w : null;
}

/** The higher of two severities; null when neither is known. */
function worse(a, b) {
  if (!a) return b;
  if (!b) return a;
  return rank(a) >= rank(b) ? a : b;
}

/** Packages in a lockfile: name -> [{ version, dev }]. */
export function lockfilePackages(lock) {
  const out = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path || entry.link) continue;
    const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    // devOptional: only needed by dev dependencies (and optional). Build-only.
    const dev = entry.dev === true || entry.devOptional === true;
    if (!out.has(name)) out.set(name, []);
    out.get(name).push({ version: entry.version, dev });
  }
  return out;
}

/** Advisories from OSV-Scanner's JSON (`--format json`). */
export function fromOsv(report) {
  const found = [];
  for (const result of report.results ?? []) {
    for (const pkg of result.packages ?? []) {
      const { name, version } = pkg.package;
      for (const group of pkg.groups ?? []) {
        const vulns = (pkg.vulnerabilities ?? []).filter((v) => group.ids.includes(v.id));
        const ids = group.ids;
        const id = ids.find((i) => i.startsWith("GHSA-")) ?? ids[0];
        let severity = cvssBand(group.max_severity);
        for (const v of vulns) severity = worse(severity, normaliseSeverity(v.database_specific?.severity));
        const aliases = new Set([...ids, ...(group.aliases ?? []), ...vulns.flatMap((v) => v.aliases ?? [])]);
        const summary = vulns.find((v) => v.summary)?.summary ?? "";
        found.push({ id, aliases: [...aliases], name, versions: [version], severity, summary, source: "osv" });
      }
    }
  }
  return found;
}

/** Advisories from `npm audit --json` (v7+ format). Rolled-up parents are skipped. */
export function fromNpmAudit(report, packages) {
  if (report.error) throw new GateError(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  const found = [];
  for (const [name, entry] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via === "string") continue; // "vulnerable because it depends on <via>"
      const id = String(via.url ?? "").match(/GHSA-[\w-]+/)?.[0] ?? (via.source != null ? `npm-${via.source}` : "unknown");
      const versions = (packages.get(via.name ?? name) ?? []).map((p) => p.version);
      found.push({ id, aliases: [id], name: via.name ?? name, versions, severity: normaliseSeverity(via.severity), summary: via.title ?? "", source: "npm audit" });
    }
  }
  return found;
}

/** One entry per (package, advisory): the two scanners agree on GHSA ids. */
function merge(advisories) {
  const byKey = new Map();
  for (const a of advisories) {
    const key = `${a.name} ${a.id}`;
    const seen = byKey.get(key);
    if (!seen) { byKey.set(key, { ...a, sources: [a.source] }); continue; }
    seen.severity = worse(seen.severity, a.severity);
    seen.versions = [...new Set([...seen.versions, ...a.versions])];
    seen.aliases = [...new Set([...seen.aliases, ...a.aliases])];
    if (!seen.sources.includes(a.source)) seen.sources.push(a.source);
    if (!seen.summary) seen.summary = a.summary;
  }
  return [...byKey.values()];
}

const DAY = 86_400_000;

/** Checks the config; returns { shipped(name, versions), reachable, allowlist }. */
export function loadPolicy(config, configDir, packages, today) {
  if (!config || typeof config !== "object") throw new GateError("config is not an object");
  let isShipped;
  if (config.shipped === "production") {
    isShipped = (name, versions) => (packages.get(name) ?? [])
      .some((p) => !p.dev && (versions.length === 0 || versions.includes(p.version)));
  } else if (typeof config.shipped === "string") {
    const list = new Set(readFileSync(resolve(configDir, config.shipped), "utf8").split("\n")
      .map((l) => l.replace(/#.*/, "").trim()).filter(Boolean));
    isShipped = (name) => list.has(name);
  } else {
    throw new GateError('config.shipped must be "production" or the path of a package list');
  }
  if (!Array.isArray(config.reachable)) throw new GateError("config.reachable must be a list of package names");
  if (!Array.isArray(config.allowlist)) throw new GateError("config.allowlist must be a list");
  const allowlist = config.allowlist.map((e, i) => {
    const where = `allowlist[${i}]`;
    for (const field of ["id", "package", "reason", "expires"]) {
      if (typeof e?.[field] !== "string" || !e[field].trim()) throw new GateError(`${where}: "${field}" is required`);
    }
    if (e.reason.trim().length < 20) throw new GateError(`${where}: the reason must say why the code is unreachable`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires) || Number.isNaN(Date.parse(e.expires))) {
      throw new GateError(`${where}: "expires" must be a date, YYYY-MM-DD`);
    }
    const expires = Date.parse(e.expires);
    if (expires - today > 366 * DAY) throw new GateError(`${where}: expires more than a year out; triage it again instead`);
    return { ...e, expired: expires < today };
  });
  return { isShipped, reachable: new Set(config.reachable), allowlist };
}

/** The decision for every advisory. */
export function decide(advisories, policy) {
  const used = new Set();
  const rows = merge(advisories).map((a) => {
    const shipped = policy.isShipped(a.name, a.versions);
    const reachable = shipped && policy.reachable.has(a.name);
    const threshold = reachable ? "moderate" : "high";
    const severe = a.severity == null ? shipped : rank(a.severity) >= rank(threshold);
    const entry = policy.allowlist.find((e) => e.package === a.name && (e.id === a.id || a.aliases.includes(e.id)));
    if (entry) used.add(entry);
    let action;
    if (!shipped) action = "warn";
    else if (!severe) action = "report";
    else if (entry && !entry.expired) action = "allowlisted";
    else action = "block";
    return { ...a, shipped, reachable, action, allow: entry, expiredAllow: entry?.expired === true && severe && shipped };
  });
  const stale = policy.allowlist.filter((e) => !used.has(e));
  return { rows, stale };
}

function runTool(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new GateError(`${cmd} could not run: ${r.error.code === "ENOENT" ? "not installed" : r.error.message}`);
  return r;
}

function runOsv(lockfile) {
  const r = runTool("osv-scanner", ["scan", "source", "--lockfile", lockfile, "--format", "json"]);
  // 0: nothing found, 1: vulnerabilities found. Anything else is a failure to scan.
  if (r.status !== 0 && r.status !== 1) throw new GateError(`osv-scanner failed (exit ${r.status}): ${r.stderr.trim().split("\n").pop()}`);
  try { return JSON.parse(r.stdout); } catch { throw new GateError("osv-scanner did not print JSON"); }
}

function runNpmAudit(lockfile) {
  const r = runTool("npm", ["audit", "--omit=dev", "--json"], dirname(lockfile));
  try { return JSON.parse(r.stdout); } catch { throw new GateError(`npm audit did not print JSON (exit ${r.status})`); }
}

function parseArgs(argv) {
  const args = { github: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new GateError(`${a} needs a value`); return argv[++i]; };
    switch (a) {
      case "--config": args.config = value(); break;
      case "--lockfile": args.lockfile = value(); break;
      case "--osv-json": args.osvJson = value(); break;
      case "--npm-audit-json": args.npmJson = value(); break;
      case "--run-osv": args.runOsv = true; break;
      case "--run-npm-audit": args.runNpm = true; break;
      case "--today": args.today = value(); break;
      case "--github": args.github = true; break;
      default: throw new GateError(`unknown argument: ${a}`);
    }
  }
  if (!args.config || !args.lockfile) throw new GateError("--config and --lockfile are required");
  if (!args.osvJson && !args.runOsv && !args.npmJson && !args.runNpm) throw new GateError("give at least one scanner (OSV or npm audit)");
  return args;
}

export function main(argv, out = console) {
  const args = parseArgs(argv);
  const today = args.today ? Date.parse(args.today) : Date.parse(new Date().toISOString().slice(0, 10));
  const lockfile = resolve(args.lockfile);
  const packages = lockfilePackages(JSON.parse(readFileSync(lockfile, "utf8")));
  const configPath = resolve(args.config);
  const policy = loadPolicy(JSON.parse(readFileSync(configPath, "utf8")), dirname(configPath), packages, today);

  const advisories = [];
  const scanners = [];
  if (args.osvJson || args.runOsv) {
    advisories.push(...fromOsv(args.osvJson ? JSON.parse(readFileSync(args.osvJson, "utf8")) : runOsv(lockfile)));
    scanners.push("OSV-Scanner");
  }
  if (args.npmJson || args.runNpm) {
    advisories.push(...fromNpmAudit(args.npmJson ? JSON.parse(readFileSync(args.npmJson, "utf8")) : runNpmAudit(lockfile), packages));
    scanners.push("npm audit --omit=dev");
  }
  const { rows, stale } = decide(advisories, policy);

  const order = { block: 0, allowlisted: 1, report: 2, warn: 3 };
  rows.sort((a, b) => order[a.action] - order[b.action] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const line = (r) => `${r.action.toUpperCase().padEnd(11)} ${`${r.name}@${r.versions.join(",") || "?"}`.padEnd(32)} ${r.id.padEnd(20)} `
    + `${(r.severity ?? "unknown").padEnd(8)} ${r.shipped ? (r.reachable ? "shipped, reads mail" : "shipped") : "build-only"}`
    + (r.allow ? `  [allowlist: expires ${r.allow.expires}${r.allow.expired ? ", EXPIRED" : ""}]` : "");
  out.log(`security gate: ${lockfile} (${scanners.join(" + ")}), ${rows.length} advisor${rows.length === 1 ? "y" : "ies"}`);
  for (const r of rows) out.log("  " + line(r));
  for (const e of stale) out.log(`  note: allowlist entry ${e.id} (${e.package}) matched nothing; remove it`);

  const blocked = rows.filter((r) => r.action === "block");
  if (args.github) {
    for (const r of rows) {
      if (r.action === "block") out.log(`::error title=Shipped ${r.severity ?? "unknown-severity"} advisory::${r.name}: ${r.id} ${r.summary}${r.expiredAllow ? " (allowlist entry expired)" : ""}`);
      if (r.action === "warn" && r.severity && rank(r.severity) >= rank("high")) out.log(`::warning title=Build-only ${r.severity} advisory::${r.name}: ${r.id} ${r.summary}`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      const md = ["| Action | Package | Advisory | Severity | Shipped |", "| --- | --- | --- | --- | --- |",
        ...rows.map((r) => `| ${r.action} | ${r.name}@${r.versions.join(",")} | [${r.id}](https://osv.dev/${r.id}) | ${r.severity ?? "unknown"} | ${r.shipped ? "yes" : "build-only"} |`)];
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Security gate\n\n${rows.length ? md.join("\n") : "No advisories."}\n`);
    }
  }
  if (blocked.length) {
    out.error(`security gate: REFUSED. ${blocked.length} shipped advisor${blocked.length === 1 ? "y blocks" : "ies block"}:`);
    for (const r of blocked) out.error(`  ${r.name}: ${r.id} (${r.severity ?? "unknown severity"})${r.expiredAllow ? ", allowlist entry expired" : ""} ${r.summary}`);
    out.error("Upgrade the package, or triage it as unreachable and add an allowlist entry with a reason and an expiry (SECURITY.md).");
    return 1;
  }
  out.log("security gate: passed (nothing shipped is blocked).");
  return 0;
}

// Run as a command? Compared as real paths: a path through a symlink (macOS's
// /var -> /private/var, a linked checkout) must not make the gate skip
// main() and exit 0 having checked nothing.
const invokedDirectly = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`security gate: could not decide: ${e instanceof GateError ? e.message : e.stack}`);
    process.exitCode = 2;
  }
}
