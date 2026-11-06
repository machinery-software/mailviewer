import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, serveBuild } from "./harness.mjs";
import { productionHeaders } from "./server.mjs";

/**
 * MAC-715: the Mac purchase page, as built (dist/mac/index.html) and served
 * with the production headers from public/_headers, in real browsers.
 *
 * - It renders under the site's CSP with no violation, console error or
 *   request to another origin. A planted inline script proves the listener
 *   would see one.
 * - Every link resolves: an anchor on the page, a file or route in dist/, an
 *   https URL or an email.
 * - At phone width (390px) the page does not scroll sideways.
 */

const ENGINES = [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]];
const DIST = join(ROOT, "dist");
const BUILT = readFileSync(join(DIST, "mac/index.html"), "utf8");

/** The hash routes the app answers, read from App.tsx's currentRoute(). */
const APP_ROUTES = [...readFileSync(join(ROOT, "src/App.tsx"), "utf8").matchAll(/h === "([a-z]+)"/g)].map((m) => m[1]);

let server;
beforeAll(async () => {
  server = await serveBuild();
}, 120000);
afterAll(async () => {
  await server?.close();
});

/** Record CSP violations, console errors and warnings, page errors and foreign requests. */
async function watch(page) {
  const seen = [];
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.__violations.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  page.on("console", (m) => {
    if (!["error", "warning"].includes(m.type())) return;
    // Chromium warns about Permissions-Policy features it no longer knows
    // (public/_headers denies them for older browsers). Site-wide, every page,
    // not the CSP and not this page's doing. Only that exact warning is let by.
    if (/^Error with Permissions-Policy header: Unrecognized feature: '[a-z-]+'\.$/.test(m.text())) return;
    seen.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => seen.push(`pageerror: ${e.message}`));
  page.on("request", (r) => !r.url().startsWith(server.origin) && !r.url().startsWith("data:") && seen.push(`request: ${r.url()}`));
  return async () => [...seen, ...(await page.evaluate(() => window.__violations)).map((v) => `violation: ${v}`)];
}

describe("the Mac purchase page's links", () => {
  const hrefs = [...BUILT.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  const ids = new Set([...BUILT.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

  it("reads the app's routes from App.tsx", () => {
    expect(APP_ROUTES).toEqual(expect.arrayContaining(["privacy", "verify", "open", "report"]));
  });

  it.each(hrefs.map((h) => [h]))("%s resolves", (href) => {
    if (href === "#") return; // the top of the page
    if (href.startsWith("#")) return expect(ids, href).toContain(href.slice(1));
    if (/^mailto:[a-z]+@mailviewer\.app$/.test(href)) return;
    if (href.startsWith("https://")) return expect(() => new URL(href)).not.toThrow();
    expect(href, "a path on this site").toMatch(/^\/(?!\/)/);
    const [path, hash] = href.split("#");
    const file = [join(DIST, path), join(DIST, path, "index.html")].find((f) => existsSync(f) && !f.endsWith("/"));
    expect(file && !file.endsWith(DIST + "/"), `${path} in dist/`).toBeTruthy();
    if (hash !== undefined) {
      expect(file, "a hash route is the app's").toBe(join(DIST, "index.html"));
      expect(APP_ROUTES, href).toContain(hash.replace(/^\//, ""));
    }
  });
});

describe.each(ENGINES)("the Mac purchase page in %s", (_name, engine) => {
  let browser;
  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("is served at /mac and /mac/ with the production CSP", async () => {
    const csp = (await productionHeaders(join(ROOT, "public/_headers")))["Content-Security-Policy"];
    expect(csp).toContain("script-src 'self'");
    for (const path of ["/mac", "/mac/"]) {
      const page = await browser.newPage();
      const res = await page.goto(server.origin + path);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-security-policy"]).toBe(csp.replace(/;?\s*upgrade-insecure-requests/, ""));
      expect(await page.title()).toBe("Mailviewer for Mac: open any email file on your Mac");
      await page.close();
    }
  });

  it("renders under the CSP with no violation, console error or foreign request", async () => {
    const page = await browser.newPage();
    const problems = await watch(page);
    await page.goto(`${server.origin}/mac/`, { waitUntil: "load" });
    await page.waitForTimeout(250);
    expect(await problems()).toEqual([]);
    await page.close();
  });

  it("would see a violation if the page had one", async () => {
    const page = await browser.newPage();
    const problems = await watch(page);
    const res = await page.request.get(`${server.origin}/mac/`);
    await page.route(`${server.origin}/mac/planted`, (route) =>
      route.fulfill({
        status: 200,
        headers: res.headers(),
        body: BUILT.replace("</body>", "<script>document.title = 'ran'</script></body>"),
      }),
    );
    await page.goto(`${server.origin}/mac/planted`, { waitUntil: "load" });
    await expect.poll(problems).not.toEqual([]);
    expect(await page.title()).not.toBe("ran");
    await page.close();
  });

  it("shows the disabled Personal button as disabled: faded, no hover, no press, never reached by Tab", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/mac/`);
    const button = page.locator('.btn[aria-disabled="true"]', { hasText: "Coming to the Mac App Store" });
    const look = () => button.evaluate((el) => {
      const s = getComputedStyle(el);
      return { opacity: s.opacity, cursor: s.cursor, boxShadow: s.boxShadow, filter: s.filter, transform: s.transform, background: s.backgroundImage, pointer: s.pointerEvents };
    });
    const before = await look();
    expect(before).toMatchObject({ opacity: "0.55", cursor: "default", boxShadow: "none", filter: "none", transform: "none", pointer: "none" });
    const box = await button.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    expect(await look(), "hovering or pressing it changes nothing").toEqual(before);
    await page.mouse.up();
    expect(await button.getAttribute("tabindex")).toBe("-1");
    expect(await button.getAttribute("href")).toBeNull();
    // Tab through every focusable element on the page: the button is never focused.
    const stops = await page.evaluate(() => document.querySelectorAll("a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])").length);
    for (let i = 0; i <= stops; i++) {
      await page.keyboard.press(browser.browserType().name() === "webkit" ? "Alt+Tab" : "Tab");
      expect(await button.evaluate((el) => el === document.activeElement)).toBe(false);
    }
    await page.close();
  });

  it("does not scroll sideways at 390px", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${server.origin}/mac/`);
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(scroll).toBeLessThanOrEqual(client);
    await page.close();
  });

  it("adds a header link that still fits the web app at 390px", async () => {
    // Before the link, the five header links already pushed the app to
    // 493px wide at 390px; with six it was 595px. They now wrap on a phone.
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${server.origin}/#/`);
    await page.waitForSelector(".topbar");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.close();
  });

  it("is linked from the web app's header", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/#/`);
    const link = page.locator(".topbar .nav a.nav-link", { hasText: "Mailviewer for Mac" });
    expect(await link.getAttribute("href")).toBe("/mac");
    await Promise.all([page.waitForURL(`${server.origin}/mac`), link.click()]);
    expect(await page.title()).toBe("Mailviewer for Mac: open any email file on your Mac");
    await page.close();
  });
});
