#!/usr/bin/env node
// The release commands, with a trail: which commit every Workers version is,
// and whether production is at HEAD.
//
//   node scripts/release.mjs preview [--allow-dirty]
//       wrangler versions upload --preview-alias staging --tag <sha> --message "<sha> <subject>"
//   node scripts/release.mjs promote <version-id>[@100] [--yes] [--allow-mismatch]
//       refuses off main or with a dirty tree; prints the sha it ships;
//       wrangler versions deploy <id>@100 --message "<sha> <subject>"; then status, then the apex check
//   node scripts/release.mjs status
//       the live production version (id, tag, message), staging's, the local HEAD,
//       and one last line: MATCH, or BEHIND <sha>. Exit 1 unless MATCH.
//
// Why: a Workers version cannot be deleted, and until now carried only a short
// sha in its message, so when a branch build was promoted (6 November 2026:
// version 457f5dc1, a fix/mac-515 preview, went to production before the PR
// was merged) nothing said so. Every version now carries the commit as its
// tag and "<sha> <subject>" as its message, promote will not ship a version
// whose tag is not main's HEAD without being told to, and `status` says in one
// word whether what is live is what is merged. package.json's release:*
// scripts call these; DEPLOYMENT.md §8 and §8a are the procedure.
//
// The functions above main() are pure and tested (scripts/release.test.ts);
// main() is the only place that runs git, wrangler or the apex check.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class ReleaseError extends Error {}

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");
export const STAGING_ALIAS = "staging";
/** A git short sha, as `git rev-parse --short` prints it, or longer. */
export const SHA = /^[0-9a-f]{7,40}$/;
/** A conservative cap on a version message; the subject is cut, never the sha. */
export const MESSAGE_LIMIT = 100;

// ---------------------------------------------------------------------------
// Tag and message

export function versionTag(sha) {
  if (!SHA.test(sha)) throw new ReleaseError(`not a commit sha: ${JSON.stringify(sha)}`);
  return sha;
}

/** "<sha> <first line of the subject>", capped at MESSAGE_LIMIT characters. */
export function versionMessage(sha, subject) {
  const tag = versionTag(sha);
  const line = String(subject ?? "").split(/\r?\n/)[0].trim();
  const text = line ? `${tag} ${line}` : tag;
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 1)}…` : text;
}

/** The arguments to `wrangler versions upload` for a commit. A dirty tree is tagged as such, never as the commit. */
export function uploadArgs(sha, subject, { dirty = false } = {}) {
  const tag = dirty ? `${versionTag(sha)}-dirty` : versionTag(sha);
  const message = dirty ? `${tag} ${versionMessage(sha, subject).slice(sha.length + 1)}`.trimEnd() : versionMessage(sha, subject);
  return ["versions", "upload", "--preview-alias", STAGING_ALIAS, "--tag", tag, "--message", message.length > MESSAGE_LIMIT ? `${message.slice(0, MESSAGE_LIMIT - 1)}…` : message];
}

/** The arguments to `wrangler versions deploy`: the version at 100%, with the version's own message as the deployment's. */
export function deployArgs(versionId, message, { yes = false } = {}) {
  return ["versions", "deploy", `${versionId}@100`, "--message", message, ...(yes ? ["--yes"] : [])];
}

// ---------------------------------------------------------------------------
// Reading what Cloudflare reports

/** The versions a deployment serves, from `wrangler deployments status --json` (or one entry of `deployments list --json`). */
export function liveVersions(deployment) {
  const versions = Array.isArray(deployment?.versions) ? deployment.versions : [];
  return versions
    .map((v) => ({ versionId: v.version_id, percentage: Number(v.percentage) }))
    .filter((v) => v.versionId && v.percentage > 0)
    .sort((a, b) => b.percentage - a.percentage);
}

/** The first token of a message, if it is a sha: how versions were labelled before tags. */
export function shaFromMessage(message) {
  const first = String(message ?? "").trim().split(/\s+/)[0] ?? "";
  return SHA.test(first) ? first : null;
}

/** A version as `wrangler versions view --json` (or an entry of `versions list --json`) describes it. */
export function describeVersion(view) {
  const a = view?.annotations ?? {};
  const tag = a["workers/tag"] || null;
  const message = a["workers/message"] || "";
  return {
    id: view?.id ?? null,
    number: view?.number ?? null,
    created: view?.metadata?.created_on ?? null,
    alias: a["workers/alias"] || null,
    tag,
    message,
    /** The commit this version claims to be: its tag, or the sha an older version carried as its message. */
    sha: tag ?? shaFromMessage(message),
    /** Whether that claim came from a tag. */
    tagged: tag !== null,
  };
}

/** The newest version carrying the staging alias, from `wrangler versions list --json`, or null. */
export function stagingVersion(list) {
  const entries = (Array.isArray(list) ? list : []).filter((v) => v?.annotations?.["workers/alias"] === STAGING_ALIAS);
  if (!entries.length) return null;
  entries.sort((a, b) => (b.number ?? 0) - (a.number ?? 0) || String(b.metadata?.created_on ?? "").localeCompare(String(a.metadata?.created_on ?? "")));
  return describeVersion(entries[0]);
}

/** Two shas name the same commit when the shorter is a prefix of the longer (both at least 7 long). */
export function sameCommit(a, b) {
  if (!a || !b || !SHA.test(a) || !SHA.test(b)) return false;
  return a.length <= b.length ? b.startsWith(a) : a.startsWith(b);
}

/**
 * The one-line verdict: MATCH when production serves one version whose
 * commit is HEAD; BEHIND <sha> when it serves one version at some other
 * commit (or an untagged one, named by what it does carry); SPLIT when
 * traffic is divided between versions (DEPLOYMENT.md §7 says never to).
 */
export function decide(live, head) {
  if (live.length !== 1) return { verdict: "SPLIT", line: `SPLIT ${live.map((v) => `${shortId(v.id)}@${v.percentage}%`).join(" ")}` };
  const [v] = live;
  if (sameCommit(v.sha, head)) return { verdict: "MATCH", line: "MATCH" };
  return { verdict: "BEHIND", line: `BEHIND ${v.sha ?? `untagged version ${shortId(v.id)}`}` };
}

export const shortId = (id) => String(id ?? "").slice(0, 8);

/** One line per version, the same shape for production and staging. */
export function versionLine(label, v) {
  if (!v) return `${label.padEnd(11)} none`;
  const commit = v.tagged ? `tag ${v.tag}` : v.sha ? `untagged, message says ${v.sha}` : "untagged";
  const pct = v.percentage != null ? ` at ${v.percentage}%` : "";
  return `${label.padEnd(11)} ${v.id}  #${v.number ?? "?"}  ${commit}  ${JSON.stringify(v.message)}  ${v.created ?? ""}${pct}`;
}

/**
 * The status report from the three JSON documents and the local state.
 * Returns the lines to print and the exit code: 0 only on MATCH.
 */
export function statusReport({ deployment, views, list, head, branch }) {
  const live = liveVersions(deployment).map((lv) => ({ ...describeVersion(views[lv.versionId]), percentage: lv.percentage }));
  const staging = stagingVersion(list);
  const { verdict, line } = decide(live, head);
  const lines = [];
  for (const v of live) lines.push(versionLine("production", v));
  if (!live.length) lines.push("production  no version serves traffic (deployments status returned none)");
  lines.push(versionLine("staging", staging));
  lines.push(`${"local".padEnd(11)} ${head} (${branch})`);
  lines.push(line);
  return { lines, code: verdict === "MATCH" ? 0 : 1, verdict, live, staging };
}

// ---------------------------------------------------------------------------
// Running things

function run(cmd, args, { inherit = false } = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
  if (r.error) throw new ReleaseError(`${cmd} ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new ReleaseError(`${cmd} ${args.join(" ")} exited ${r.status}${r.stderr ? `:\n${r.stderr.trim()}` : ""}`);
  return r.stdout ?? "";
}
const git = (...args) => run("git", args).trim();
const wranglerJson = (...args) => {
  const out = run(WRANGLER, [...args, "--json"]);
  try {
    return JSON.parse(out);
  } catch {
    throw new ReleaseError(`wrangler ${args.join(" ")} --json did not return JSON:\n${out.slice(0, 400)}`);
  }
};

function local() {
  return {
    head: git("rev-parse", "--short", "HEAD"),
    subject: git("log", "-1", "--format=%s"),
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    dirty: git("status", "--porcelain") !== "",
  };
}

function status(out = console) {
  const deployment = wranglerJson("deployments", "status");
  const views = {};
  for (const { versionId } of liveVersions(deployment)) views[versionId] = wranglerJson("versions", "view", versionId);
  const list = wranglerJson("versions", "list");
  const { head, branch } = local();
  const report = statusReport({ deployment, views, list, head, branch });
  for (const line of report.lines) out.log(line);
  return report.code;
}

function preview(flags, out = console) {
  const { head, subject, dirty } = local();
  if (dirty && !flags.has("--allow-dirty")) {
    throw new ReleaseError("the working tree has uncommitted changes, so a version tagged with this commit would not be this commit. Commit or stash, or pass --allow-dirty to upload it tagged \"-dirty\".");
  }
  const args = uploadArgs(head, subject, { dirty });
  out.log(`release: uploading ${dirty ? "a DIRTY tree, tagged" : "commit"} ${args[args.indexOf("--tag") + 1]}: ${JSON.stringify(args[args.indexOf("--message") + 1])}`);
  run(WRANGLER, args, { inherit: true });
  return 0;
}

function promote(positional, flags, out = console) {
  const { head, branch, dirty } = local();
  if (branch !== "main") throw new ReleaseError(`promote runs from main only; this is ${branch}. What ships must be what is merged.`);
  if (dirty) throw new ReleaseError("promote refuses a dirty working tree (git status --porcelain is not empty). Commit or stash first.");
  const spec = positional[0];
  if (!spec) throw new ReleaseError("promote needs the version to ship: npm run release:promote -- <version-id>@100 --yes");
  const [versionId, pct = "100"] = spec.split("@");
  if (pct !== "100") throw new ReleaseError(`deploy at @100 only (asked for @${pct}): a split rollout can hand a browser one version's HTML and another's assets (DEPLOYMENT.md §7).`);
  const v = describeVersion(wranglerJson("versions", "view", versionId));
  out.log(versionLine("version", v));
  out.log(`local       ${head} (${branch})`);
  if (!sameCommit(v.sha, head)) {
    const claim = v.sha ? `is tagged ${v.sha}` : "has no tag or sha";
    if (!flags.has("--allow-mismatch")) {
      throw new ReleaseError(`version ${shortId(v.id)} ${claim}, and main is at ${head}: that is not what is merged. If this is a deliberate rollback, pass --allow-mismatch.`);
    }
    out.log(`release: WARNING: version ${shortId(v.id)} ${claim}, main is at ${head}; shipping anyway (--allow-mismatch).`);
  }
  out.log(`release: shipping ${v.sha ?? "an untagged version"}: ${JSON.stringify(v.message)} (version ${v.id})`);
  run(WRANGLER, deployArgs(v.id, v.message || versionMessage(head, ""), { yes: flags.has("--yes") }), { inherit: true });
  out.log("");
  out.log("release: status after promote");
  const statusCode = status(out);
  out.log("");
  out.log("release: the apex, as a browser sees it");
  const apex = spawnSync("bash", [join(here, "check-apex.sh")], { cwd: ROOT, stdio: "inherit" });
  return statusCode || apex.status || 0;
}

export function main(argv, out = console) {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const positional = rest.filter((a) => !a.startsWith("--"));
  switch (command) {
    case "preview": return preview(flags, out);
    case "promote": return promote(positional, flags, out);
    case "status": return status(out);
    default:
      throw new ReleaseError(`usage: release.mjs preview [--allow-dirty] | promote <version-id>[@100] [--yes] [--allow-mismatch] | status`);
  }
}

const invokedDirectly = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`release: ${e instanceof ReleaseError ? e.message : e.stack}`);
    process.exitCode = 2;
  }
}
