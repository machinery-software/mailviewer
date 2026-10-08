// The security gate (scripts/security-gate.mjs), against scanner output
// recorded from real lockfiles pinned to known-vulnerable versions
// (scripts/security-gate-fixtures, re-recorded by hand with record.sh). No
// test here touches the network.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain .mjs script, no type declarations
import { decide, GateError, loadPolicy, lockfilePackages, main } from "./security-gate.mjs";

const here = new URL(".", import.meta.url).pathname;
const gate = join(here, "security-gate.mjs");
const fixtures = join(here, "security-gate-fixtures");
const TODAY = "2026-10-08";
const WEB = { shipped: "production", reachable: ["dompurify", "postal-mime", "fflate"], allowlist: [] as unknown[] };

function config(c: object): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  writeFileSync(join(dir, "shipped-mac.txt"), "# only what is in the parser bundle\npostal-mime\n");
  writeFileSync(join(dir, "shipped-mac-dompurify.txt"), "postal-mime\ndompurify\n");
  const path = join(dir, "security-gate.json");
  writeFileSync(path, JSON.stringify(c));
  return path;
}

type Scanners = "both" | "osv" | "npm";
function run(fixture: string, c: object, scanners: Scanners = "both", extra: string[] = []) {
  const f = join(fixtures, fixture);
  const args = ["--config", config(c), "--lockfile", join(f, "package-lock.json"), "--today", TODAY, ...extra];
  if (scanners !== "npm") args.push("--osv-json", join(f, "osv.json"));
  if (scanners !== "osv") args.push("--npm-audit-json", join(f, "npm-audit.json"));
  const lines: string[] = [];
  const out = { log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) };
  const code = main(args, out);
  const text = lines.join("\n");
  const rows = (action: string) => lines.filter((l) => l.trim().startsWith(action));
  return { code, text, rows };
}

/** The exit code and output of the real command line. */
function cli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(process.execPath, [gate, ...args], { encoding: "utf8", env });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe("what ships", () => {
  it("passes a lockfile whose shipped packages have no advisories", () => {
    const r = run("clean", WEB);
    expect(r.code).toBe(0);
    expect(r.text).toContain("0 advisories");
  });

  it("only warns about a critical advisory in a build-only package", () => {
    const r = run("build-only", WEB);
    expect(r.code).toBe(0);
    expect(r.rows("WARN").join("\n")).toMatch(/tinypool@1\.1\.1 +GHSA-5gmw-xhrv-c9v3 +critical build-only/);
    expect(r.rows("BLOCK")).toEqual([]);
  });

  it("refuses a lockfile pinned to a DOMPurify with critical advisories", () => {
    const r = run("shipped-high", WEB);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/BLOCK +dompurify@2\.0\.0 +GHSA-mjjq-c88q-qhr6 +critical shipped, reads mail/);
    expect(r.text).toContain("REFUSED");
    // The dev-only tinypool in the same lockfile is still only a warning.
    expect(r.rows("WARN").join("\n")).toContain("tinypool");
  });

  it("refuses it on npm audit --omit=dev alone (the release:preview gate)", () => {
    const r = run("shipped-high", WEB, "npm");
    expect(r.code).toBe(1);
    expect(r.text).toContain("npm audit --omit=dev");
    expect(r.rows("BLOCK").length).toBeGreaterThan(0);
    expect(r.text).not.toContain("tinypool");
  });

  it("refuses it on OSV-Scanner alone (CI)", () => {
    expect(run("shipped-high", WEB, "osv").code).toBe(1);
  });

  it("counts one advisory once when both scanners report it", () => {
    const r = run("shipped-moderate", WEB);
    const ids = r.rows("BLOCK").map((l) => l.trim().split(/ +/)[2]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("severity", () => {
  it("blocks high and critical in any shipped package, and reports the rest", () => {
    const plain = { ...WEB, reachable: [] };
    const r = run("shipped-high", plain);
    expect(r.code).toBe(1);
    for (const line of r.rows("BLOCK")) expect(line).toMatch(/ (high|critical) +shipped$/);
    expect(r.rows("REPORT").length).toBeGreaterThan(0);
  });

  it("blocks moderate in a package that reads mail: DOMPurify's XSS advisories are rated moderate", () => {
    // The ticket's rule alone (high and critical) lets this through...
    expect(run("shipped-moderate", { ...WEB, reachable: [] }).code).toBe(0);
    // ...which is why the packages that read attacker-controlled mail block at moderate.
    const r = run("shipped-moderate", WEB);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/BLOCK +dompurify@3\.1\.4 +GHSA-55q2-fjhq-7xh7 +moderate +shipped, reads mail/);
    // Low stays a report even there.
    expect(r.rows("BLOCK").join("\n")).not.toMatch(/ low /);
  });

  it("blocks a shipped advisory whose severity is unknown: fail closed", () => {
    const lock = { packages: { "": {}, "node_modules/dompurify": { version: "9.9.9" } } };
    const packages = lockfilePackages(lock);
    const policy = loadPolicy({ shipped: "production", reachable: [], allowlist: [] }, here, packages, Date.parse(TODAY));
    const { rows } = decide([{ id: "GHSA-xxxx-xxxx-xxxx", aliases: [], name: "dompurify", versions: ["9.9.9"], severity: null, summary: "", source: "osv" }], policy);
    expect(rows[0].action).toBe("block");
  });
});

describe("the Mac app's list of shipped packages", () => {
  it("treats a package outside the parser bundle as build-only", () => {
    const r = run("shipped-high", { shipped: "shipped-mac.txt", reachable: ["postal-mime"], allowlist: [] });
    expect(r.code).toBe(0);
    expect(r.rows("WARN").join("\n")).toMatch(/dompurify@2\.0\.0 .* build-only/);
  });

  it("refuses when a vulnerable package is in the bundle", () => {
    expect(run("shipped-high", { shipped: "shipped-mac-dompurify.txt", reachable: ["postal-mime"], allowlist: [] }).code).toBe(1);
  });
});

describe("the allowlist", () => {
  const blockingIds = () => run("shipped-moderate", WEB).rows("BLOCK").map((l) => l.trim().split(/ +/)[2]);
  const entry = (id: string, expires = "2026-12-31") => ({
    id, package: "dompurify", expires,
    reason: "Not reachable: the sanitizer path this needs is never called with message HTML here.",
  });

  it("lets triaged advisories through until they expire", () => {
    const r = run("shipped-moderate", { ...WEB, allowlist: blockingIds().map((id) => entry(id)) });
    expect(r.code).toBe(0);
    expect(r.rows("ALLOWLISTED").length).toBe(blockingIds().length);
    expect(r.text).toContain("expires 2026-12-31");
  });

  it("refuses again once an entry has expired", () => {
    const ids = blockingIds();
    const r = run("shipped-moderate", { ...WEB, allowlist: [...ids.slice(1).map((id) => entry(id)), entry(ids[0], "2026-10-07")] });
    expect(r.code).toBe(1);
    expect(r.text).toContain(`${ids[0]} (moderate), allowlist entry expired`);
  });

  it("matches an entry by an alias such as the CVE", () => {
    const ids = blockingIds().filter((id) => id !== "GHSA-39q2-94rc-95cp");
    const r = run("shipped-moderate", { ...WEB, allowlist: [...ids.map((id) => entry(id)), entry("CVE-2026-65903")] });
    expect(r.code).toBe(0);
  });

  it("names an entry that matches nothing, so it can be removed", () => {
    expect(run("clean", { ...WEB, allowlist: [entry("GHSA-gone-gone-gone")] }).text).toContain("GHSA-gone-gone-gone (dompurify) matched nothing");
  });

  it.each([
    ["no reason", { id: "GHSA-a", package: "dompurify", expires: "2026-12-31" }, /"reason" is required/],
    ["a reason that says nothing", { ...entry("GHSA-a"), reason: "fine" }, /must say why/],
    ["no expiry", { id: "GHSA-a", package: "dompurify", reason: entry("x").reason }, /"expires" is required/],
    ["an expiry that is not a date", entry("GHSA-a", "next year"), /must be a date/],
    ["an expiry more than a year out", entry("GHSA-a", "2028-01-01"), /more than a year out/],
  ])("rejects an entry with %s", (_name, bad, message) => {
    expect(() => run("clean", { ...WEB, allowlist: [bad] })).toThrow(GateError);
    expect(() => run("clean", { ...WEB, allowlist: [bad] })).toThrow(message);
  });
});

describe("the command line", () => {
  const f = (name: string) => join(fixtures, name);
  const base = (fixture: string) => ["--config", config(WEB), "--lockfile", join(f(fixture), "package-lock.json"), "--today", TODAY];

  it("exits 0, 1 and 2 for pass, refuse and cannot-decide", () => {
    expect(cli([...base("clean"), "--osv-json", join(f("clean"), "osv.json")]).status).toBe(0);
    expect(cli([...base("shipped-high"), "--osv-json", join(f("shipped-high"), "osv.json")]).status).toBe(1);
    expect(cli([...base("clean")]).status).toBe(2);
  });

  it("refuses when run through a symlinked path, as from macOS's /var or a linked checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-link-"));
    const link = join(dir, "security-gate.mjs");
    symlinkSync(gate, link);
    const r = spawnSync(process.execPath, [link, ...base("shipped-high"), "--osv-json", join(f("shipped-high"), "osv.json")], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("REFUSED");
  });

  it("cannot decide, and so refuses, when a scanner is missing", () => {
    const r = cli([...base("clean"), "--run-osv"], { ...process.env, PATH: "/nonexistent" });
    expect(r.status).toBe(2);
    expect(r.out).toContain("osv-scanner could not run: not installed");
  });

  it("cannot decide when npm audit reports an error instead of results", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    writeFileSync(join(dir, "err.json"), JSON.stringify({ error: { code: "ENOTFOUND", summary: "request to registry failed" } }));
    const r = cli([...base("clean"), "--npm-audit-json", join(dir, "err.json")]);
    expect(r.status).toBe(2);
    expect(r.out).toContain("npm audit failed: request to registry failed");
  });

  it("annotates GitHub Actions runs", () => {
    const r = cli([...base("shipped-high"), "--osv-json", join(f("shipped-high"), "osv.json"), "--github"], { ...process.env, GITHUB_STEP_SUMMARY: "" });
    expect(r.out).toMatch(/::error title=Shipped critical advisory::dompurify: GHSA-mjjq-c88q-qhr6/);
    expect(r.out).toMatch(/::warning title=Build-only critical advisory::tinypool/);
  });

  it("is what release:preview runs before uploading", () => {
    const pkg = JSON.parse(execFileSync("node", ["-p", "JSON.stringify(require('./package.json'))"], { cwd: join(here, ".."), encoding: "utf8" }));
    expect(pkg.scripts["release:preview"]).toMatch(/npm run security:gate && wrangler versions upload/);
    expect(pkg.scripts["security:gate"]).toContain("--run-npm-audit");
  });
});
