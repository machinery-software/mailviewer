// public/_headers, as Cloudflare applies it to each route (MAC-515).
//
// The file is a list of rules, each a URL pattern and the headers it attaches;
// every rule that matches a request path applies, in order, a header named
// twice is joined with a comma, and "! Name" detaches one. The function below
// applies those rules the way the Workers static-assets layer documents them
// (developers.cloudflare.com/workers/static-assets/headers/), starting from the
// one header Workers sends on its own, so that a test can ask what a given
// route is served with rather than whether a string occurs somewhere in the
// file. The CI step "Security headers present in build output" asks the second
// question of the CSP; tests/print/site.test.mjs asks real browsers the first.
//
// What is held here: every HTML response carries Cache-Control: no-transform.
// The zone has twice appended Cloudflare Web Analytics' beacon.min.js to the
// HTML it served to browsers, with no deploy on our side (DEPLOYMENT.md §5a).
// no-transform is the header that tells a proxy it may not rewrite the body,
// and it lives here, in version control, rather than in a dashboard toggle.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const HEADERS_FILE = new URL("../public/_headers", import.meta.url);
const PUBLIC_DIR = new URL("../public/", import.meta.url);

/** What Workers sends when _headers says nothing (developers.cloudflare.com/workers/static-assets/headers/#default-headers). */
const WORKERS_DEFAULTS = { "cache-control": "public, max-age=0, must-revalidate" };

type Rule = { pattern: RegExp; headers: Array<{ name: string; value: string | null }> };

/** Parse a _headers file into its rules, dropping comments and blank lines. */
export function parseHeaderRules(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) {
      rules.push({ pattern: patternToRegExp(line.trim()), headers: [] });
      continue;
    }
    const rule = rules[rules.length - 1];
    if (!rule) throw new Error(`header before any URL pattern: ${line}`);
    const detach = line.match(/^\s*!\s+([A-Za-z0-9-]+)\s*$/);
    if (detach) {
      rule.headers.push({ name: detach[1].toLowerCase(), value: null });
      continue;
    }
    const m = line.match(/^\s+([A-Za-z0-9-]+):\s*(.*)$/);
    if (!m) throw new Error(`unreadable _headers line: ${line}`);
    rule.headers.push({ name: m[1].toLowerCase(), value: m[2].trim() });
  }
  return rules;
}

/** A _headers URL pattern as a RegExp over the request path: one splat `*` is greedy, `:name` is one path segment. */
function patternToRegExp(pattern: string): RegExp {
  // A pattern with a scheme names a host; this site has one host, so only the
  // path part is matched.
  const path = pattern.replace(/^https?:\/\/[^/]*/, "") || "/";
  const source = path
    .split(/(\*|:[A-Za-z]\w*)/)
    .map((part) => (part === "*" ? "(.*)" : /^:[A-Za-z]/.test(part) ? "([^/]+)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`);
}

/** The headers a request for `path` is served with: the defaults, then every matching rule in file order. */
export function headersFor(path: string, rules: Rule[], defaults: Record<string, string> = WORKERS_DEFAULTS): Record<string, string> {
  const out: Record<string, string> = { ...defaults };
  const set = new Set<string>();
  for (const rule of rules) {
    if (!rule.pattern.test(path)) continue;
    for (const { name, value } of rule.headers) {
      if (value === null) {
        delete out[name];
        set.delete(name);
      } else if (set.has(name)) {
        out[name] = `${out[name]}, ${value}`;
      } else {
        out[name] = value;
        set.add(name);
      }
    }
  }
  return out;
}

/**
 * Every path that answers with HTML: the app's shell and each page under
 * public/, as a file, as a folder with and without the slash, and the paths
 * that have no file at all, which not_found_handling: single-page-application
 * answers with the shell.
 */
export function htmlRoutes(): string[] {
  const pages = readdirSync(PUBLIC_DIR, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".html"))
    .map((f) => `/${f.replace(/\\/g, "/")}`);
  const routes = new Set(["/", "/index.html", "/no-such-page", "/a/deeper/no-such-page"]);
  for (const page of pages) {
    routes.add(page);
    if (page.endsWith("/index.html")) {
      const dir = page.slice(0, -"index.html".length);
      routes.add(dir);
      routes.add(dir.replace(/\/$/, ""));
    }
  }
  return [...routes].sort();
}

const rules = parseHeaderRules(readFileSync(HEADERS_FILE, "utf8"));

describe("public/_headers", () => {
  it("has rules the parser reads whole: one /* block with the headers DEPLOYMENT.md §4 lists", () => {
    expect(rules.some((r) => r.pattern.source === patternToRegExp("/*").source)).toBe(true);
    const served = headersFor("/", rules);
    for (const name of ["content-security-policy", "referrer-policy", "permissions-policy", "x-content-type-options", "cross-origin-opener-policy", "cross-origin-resource-policy", "strict-transport-security"]) {
      expect(served, name).toHaveProperty(name);
    }
  });

  it("knows the Mac page and the SPA fallback as HTML routes", () => {
    expect(htmlRoutes()).toEqual(expect.arrayContaining(["/", "/index.html", "/mac", "/mac/", "/mac/index.html", "/no-such-page"]));
  });

  it.each(htmlRoutes())("serves %s with Cache-Control: no-transform, keeping max-age=0, must-revalidate", (route) => {
    const cc = headersFor(route, rules)["cache-control"];
    const directives = cc.split(",").map((d) => d.trim());
    expect(directives, `${route}: Cache-Control is "${cc}"`).toContain("no-transform");
    // The rest of the value is what Workers sent before, so browser caching is
    // unchanged: cache, but revalidate every time.
    expect(directives).toContain("public");
    expect(directives).toContain("max-age=0");
    expect(directives).toContain("must-revalidate");
    // No directive twice: a second Cache-Control line in a matching rule would
    // be joined onto the first, not replace it.
    expect(new Set(directives).size).toBe(directives.length);
  });

  it("does not change the Content-Security-Policy of any route (MAC-515 touches Cache-Control only)", () => {
    const csp = headersFor("/", rules)["content-security-policy"];
    expect(csp).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-src 'self' blob:; child-src 'self' blob:; worker-src 'self' blob:; form-action 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
    );
    for (const route of htmlRoutes()) expect(headersFor(route, rules)["content-security-policy"]).toBe(csp);
  });

  describe("the rule matcher, against Cloudflare's documented semantics", () => {
    const text = ["/*", "  X-A: one", "  Cache-Control: public, no-transform", "/secure/*", "  X-A: two", "  ! Cache-Control", "/movies/:title", "  X-Movie: :title"].join("\n");
    const r = parseHeaderRules(text);
    it("joins a header applied twice with a comma, and detaches with '! Name'", () => {
      expect(headersFor("/secure/page", r)).toEqual({ "x-a": "one, two" });
      expect(headersFor("/other", r)).toEqual({ "x-a": "one", "cache-control": "public, no-transform" });
    });
    it("matches a placeholder as one segment and a splat as anything", () => {
      expect(headersFor("/movies/alien", r)).toHaveProperty("x-movie");
      expect(headersFor("/movies/alien/2", r)).not.toHaveProperty("x-movie");
      expect(headersFor("/", r)).toHaveProperty("x-a", "one");
    });
  });
});
