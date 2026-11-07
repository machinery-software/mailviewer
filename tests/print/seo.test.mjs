import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { ROOT } from "./harness.mjs";
import { productionHeaders } from "./server.mjs";

/**
 * The SEO pass against Cloudflare's own asset server: `wrangler dev` serving
 * dist/ with wrangler.jsonc, locally (workerd on 127.0.0.1, metrics off).
 *
 * The bug this replaces lived in Cloudflare's not-found handling, not in our
 * files -- /robots.txt, /sitemap.xml and every typo got the app with a 200 --
 * so it is checked against the thing that does the handling, not a stand-in.
 */

const SITE = "https://mailviewer.app";
const BROWSER = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};

let origin;
let wrangler;
let log = "";

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

beforeAll(async () => {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  wrangler = spawn(join(ROOT, "node_modules/.bin/wrangler"), ["dev", "--ip", "127.0.0.1", "--port", String(port)], {
    cwd: ROOT,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" },
  });
  wrangler.stdout.on("data", (d) => (log += d));
  wrangler.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      if ((await fetch(`${origin}/favicon.svg`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`wrangler dev did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}, 90000);

afterAll(() => {
  wrangler?.kill();
});

const get = (path, headers = BROWSER) => fetch(`${origin}${path}`, { headers, redirect: "manual" });
const local = (url) => url.replace(SITE, origin);

/** The tags search engines and link previews read, from a page's HTML. */
function tags(html) {
  const meta = (attr, name) => html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1];
  return {
    title: html.match(/<title>([^<]*)<\/title>/)?.[1],
    description: meta("name", "description"),
    canonical: html.match(/<link rel="canonical" href="([^"]+)"/)?.[1],
    ogTitle: meta("property", "og:title"),
    ogDescription: meta("property", "og:description"),
    ogUrl: meta("property", "og:url"),
    ogImage: meta("property", "og:image"),
    noindex: /<meta name="robots" content="noindex">/.test(html),
  };
}

describe("not-found handling", () => {
  for (const [label, headers] of [["a browser", BROWSER], ["a crawler without fetch metadata", { "User-Agent": "Googlebot/2.1" }]]) {
    it(`answers a made-up path with 404 and the not-found page, for ${label}`, async () => {
      const res = await get("/no-such-page-7f3a", headers);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      const html = await res.text();
      expect(html).toContain("There is no page here");
      expect(tags(html).noindex).toBe(true);
    });
  }

  it("still serves the app at /, the one path it has", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root"><div class="shell">');
  });

  it("sends the production headers on a 404 too: the CSP, and no-transform", async () => {
    const want = await productionHeaders(join(ROOT, "public/_headers"));
    const res = await get("/no-such-page-7f3a");
    expect(res.headers.get("content-security-policy")).toBe(want["Content-Security-Policy"]);
    expect(res.headers.get("cache-control")).toBe(want["Cache-Control"]);
  });
});

describe("robots.txt", () => {
  it("is the file in public/, as text/plain", async () => {
    const res = await get("/robots.txt", { "User-Agent": "Googlebot/2.1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(readFileSync(join(ROOT, "public/robots.txt"), "utf8"));
  });
});

describe("sitemap.xml", () => {
  let xml;
  let locs;
  beforeAll(async () => {
    const res = await get("/sitemap.xml", { "User-Agent": "Googlebot/2.1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/xml/);
    xml = await res.text();
    locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  });

  it("is well-formed XML in the sitemaps namespace (a browser's XML parser says so)", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const result = await page.evaluate((text) => {
        const doc = new DOMParser().parseFromString(text, "application/xml");
        return {
          error: doc.getElementsByTagName("parsererror")[0]?.textContent ?? null,
          root: doc.documentElement.localName,
          ns: doc.documentElement.namespaceURI,
          urls: doc.getElementsByTagName("url").length,
        };
      }, xml);
      expect(result).toEqual({ error: null, root: "urlset", ns: "http://www.sitemaps.org/schemas/sitemap/0.9", urls: locs.length });
    } finally {
      await browser.close();
    }
  });

  it("lists / and /mac/", () => {
    expect(locs.slice(0, 2)).toEqual([`${SITE}/`, `${SITE}/mac/`]);
  });

  it("lists only URLs that answer 200, each the canonical of the page it names", async () => {
    for (const loc of locs) {
      const res = await get(new URL(local(loc)).pathname);
      expect(res.status, loc).toBe(200);
      const t = tags(await res.text());
      expect(t.canonical, loc).toBe(loc);
      expect(t.noindex, loc).toBe(false);
    }
  });
});

describe("every static page", () => {
  const PAGES = ["/", "/mac/", "/guides/template-check/"];
  const seen = new Map();

  for (const path of PAGES) {
    it(`${path} has its own title, a description, canonical and Open Graph tags`, async () => {
      const res = await get(path);
      expect(res.status).toBe(200);
      const t = tags(await res.text());
      for (const [k, v] of Object.entries(t)) if (k !== "noindex") expect(v, `${path} ${k}`).toBeTruthy();
      expect(t.canonical).toBe(`${SITE}${path}`);
      expect(t.ogUrl).toBe(t.canonical);
      expect(t.ogTitle).toBe(t.title);
      expect(t.ogDescription).toBe(t.description);
      expect(t.ogImage).toBe(`${SITE}/og.png`);
      expect(seen.has(t.title), `title shared with ${seen.get(t.title)}`).toBe(false);
      seen.set(t.title, path);
    });
  }

  it("og:image is served from this origin, a 1200×630 PNG", async () => {
    const res = await get("/og.png", { "User-Agent": "facebookexternalhit/1.1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const png = new Uint8Array(await res.arrayBuffer());
    const dv = new DataView(png.buffer);
    expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([1200, 630]);
  });
});

describe("the home page without JavaScript", () => {
  it("carries the hero, the format list, and links to /mac and the app", async () => {
    const html = await (await get("/", { "User-Agent": "Googlebot/2.1" })).text();
    const body = html.slice(html.indexOf("<body>"));
    expect(body).toContain("Open any email file.");
    for (const ext of [".eml", ".msg", ".mbox", ".emlx", ".oft", ".mht"]) expect(body).toContain(`>${ext}<`);
    expect(body).toContain('href="/mac"');
    expect(body).toContain('href="#/open"');
    expect(tags(html).title).toBe("Mailviewer: read .eml, .msg and .mbox files in your browser");
  });
});

describe("the app boots on top of it", () => {
  it("mounts over the static page with one copy of it, no error and nothing from elsewhere", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const seen = [];
      await page.addInitScript(() => {
        window.__violations = [];
        document.addEventListener("securitypolicyviolation", (e) => window.__violations.push(`${e.violatedDirective} ${e.blockedURI}`));
      });
      page.on("console", (m) => {
        if (!["error", "warning"].includes(m.type())) return;
        if (/^Error with Permissions-Policy header: Unrecognized feature/.test(m.text())) return;
        seen.push(`console ${m.type()}: ${m.text()}`);
      });
      page.on("pageerror", (e) => seen.push(`pageerror: ${e.message}`));
      page.on("request", (r) => !r.url().startsWith(origin) && !r.url().startsWith("data:") && seen.push(`request: ${r.url()}`));

      await page.goto(`${origin}/`);
      await page.waitForFunction(() => document.querySelectorAll(".hero2").length === 1);
      // The app is live: the drop area hands a click to its file input.
      await page.locator(".nav-link", { hasText: "Open a file" }).click();
      await page.waitForSelector(".viewer, .dropzone, input[type=file]");
      expect(await page.title()).toBe("Open a file · Mailviewer");
      expect([...seen, ...(await page.evaluate(() => window.__violations))]).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
