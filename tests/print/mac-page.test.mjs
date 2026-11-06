import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, serveBuild } from "./harness.mjs";

/** The Payment Links, read from src/lib/mac-purchase-links.ts: team, business, and site by term. */
const LINKS = (() => {
  const src = readFileSync(join(ROOT, "src/lib/mac-purchase-links.ts"), "utf8");
  const site = Object.fromEntries([...src.matchAll(/^\s+(\d): "(https:\/\/buy\.stripe\.com\/[A-Za-z0-9]+)",$/gm)].map((m) => [m[1], m[2]]));
  return { site };
})();
import { productionHeaders } from "./server.mjs";
import { MAC_PLANS, perMacLine, siteBreakEvenLine, usd } from "../../src/lib/mac-pricing.ts";

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

  it("sells the Site license by term: 1 year by default, by click and by arrow key, one Buy link at a time, no script (MAC-787)", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/mac/`);
    const shown = async () => {
      const buttons = page.locator('.plan.site a.btn:visible');
      expect(await buttons.count(), "one Buy link visible").toBe(1);
      const price = await page.locator(".plan.site .price:visible").innerText();
      const total = await page.locator(".plan.site .term-total:visible").innerText();
      return { href: await buttons.getAttribute("href"), price, total, checked: await page.locator('input[name="site-term"]:checked').getAttribute("value") };
    };
    expect(await shown()).toEqual({ href: LINKS.site[1], price: "$6,000", total: "$6,000 billed yearly", checked: "1" });

    await page.locator('label[for="site-2y"]').click();
    expect(await shown()).toEqual({ href: LINKS.site[2], price: "$5,700", total: "$11,400 billed once for 2 years", checked: "2" });

    // Keyboard: the group is one Tab stop after Buy Business; arrows move within it.
    await page.locator("a", { hasText: "Buy Business" }).focus();
    await page.keyboard.press(browser.browserType().name() === "webkit" ? "Alt+Tab" : "Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("site-2y");
    await page.keyboard.press("ArrowRight");
    expect(await shown()).toEqual({ href: LINKS.site[3], price: "$5,400", total: "$16,200 billed once for 3 years", checked: "3" });
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    expect(await shown()).toEqual({ href: LINKS.site[1], price: "$6,000", total: "$6,000 billed yearly", checked: "1" });

    // The selected segment is the one the card shows, and it is drawn as selected.
    const selected = await page.locator('label[for="site-1y"]').evaluate((el) => getComputedStyle(el).backgroundImage);
    const other = await page.locator('label[for="site-2y"]').evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(selected).not.toBe("none");
    expect(other).toBe("none");
    await page.close();
  });

  it("reads each card's price and then its per-Mac line, in that order, as one paragraph; the Site break-even stays put across terms (MAC-791)", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/mac/`);
    for (const [name, plan] of [["Team", MAC_PLANS.team], ["Business", MAC_PLANS.business]]) {
      const card = page.locator(".plan", { has: page.locator("h3", { hasText: new RegExp(`^${name}$`) }) });
      // The accessibility tree, as a screen reader walks it: one paragraph, the price first.
      const tree = await card.ariaSnapshot();
      // The snapshot folds the non-breaking spaces into plain ones; innerText keeps them.
      expect(tree, name).toContain(`- paragraph: ${usd(plan.price)} / year ${perMacLine(plan).replaceAll("\u00a0", " ")}`);
      expect(await card.locator("p.price-block").innerText(), name).toBe(`${usd(plan.price)} / year\n${perMacLine(plan)}`);
      // Laid out, the figure and its unit are on one line: the span is at most two line boxes, and the second starts at "about".
      const lines = await card.locator(".per-mac").evaluate((el) => {
        const range = document.createRange();
        const tops = [];
        for (const node of el.childNodes) {
          for (let i = 0; i < node.textContent.length; i++) {
            range.setStart(node, i); range.setEnd(node, i + 1);
            const r = range.getBoundingClientRect();
            if (r.width && !tops.some((t) => Math.abs(t.top - r.top) < 1)) tops.push({ top: r.top, text: node.textContent.slice(i) });
          }
        }
        return tops.map((t) => t.text);
      });
      expect(lines.length, `${name}: ${JSON.stringify(lines)}`).toBeLessThanOrEqual(2);
      if (lines.length === 2) expect(lines[1]).toBe(perMacLine(plan).slice("Works out to ".length));
      // The line is visibly secondary: smaller than the price, and dimmer than it, but legible.
      const [price, line] = await Promise.all(
        [".price", ".per-mac"].map((sel) => card.locator(sel).evaluate((el) => ({ size: parseFloat(getComputedStyle(el).fontSize), color: getComputedStyle(el).color, display: getComputedStyle(el).display }))),
      );
      expect(line.size, name).toBeLessThan(price.size);
      expect(line.display).toBe("block");
      expect(line.color).toBe("rgb(167, 181, 177)");
      expect(price.color).toBe("rgb(236, 242, 240)");
    }
    const personal = page.locator(".plan", { has: page.locator("h3", { hasText: /^Personal$/ }) });
    expect(await personal.ariaSnapshot()).toContain(`- paragraph: ${usd(MAC_PLANS.personal.price)} / year`);
    expect(await personal.innerText()).not.toMatch(/one[- ]time/i);

    const site = page.locator(".plan.site");
    const breakEven = site.locator(".site-per-mac");
    for (const years of [1, 2, 3]) {
      await page.locator(`label[for="site-${years}y"]`).click();
      expect(await breakEven.innerText(), `${years}y`).toBe(siteBreakEvenLine());
      const priceBox = await page.locator(".plan.site .price:visible").boundingBox();
      const totalBox = await page.locator(".plan.site .term-total:visible").boundingBox();
      const lineBox = await breakEven.boundingBox();
      expect(lineBox.y, `${years}y: below the price`).toBeGreaterThan(priceBox.y + priceBox.height - 1);
      expect(lineBox.y, `${years}y: below the billed line`).toBeGreaterThanOrEqual(totalBox.y + totalBox.height - 1);
      // Reading order in the tree: the visible price, its billed line, then the break-even.
      const tree = await site.ariaSnapshot();
      const total = await page.locator(".plan.site .term-total:visible").innerText();
      expect(tree.indexOf(total), `${years}y`).toBeGreaterThan(-1);
      expect(tree.indexOf(siteBreakEvenLine())).toBeGreaterThan(tree.indexOf(total));
    }
    await page.close();
  });

  it("falls back to the 1-year link with its stylesheet gone: every term shows and the first Buy link is 1 year", async () => {
    const page = await browser.newPage();
    await page.route(`${server.origin}/mac/`, async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace(/<style>[^]*?<\/style>/, "");
      await route.fulfill({ response: res, body, headers: { ...res.headers(), "content-length": String(Buffer.byteLength(body)) } });
    });
    await page.goto(`${server.origin}/mac/`);
    const hrefs = await page.$$eval(".plan.site a.btn", (as) => as.map((a) => a.href));
    expect(hrefs).toEqual([LINKS.site[1], LINKS.site[2], LINKS.site[3]]);
    expect(await page.locator(".plan.site a.btn:visible").count()).toBe(3);
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
    const link = page.locator(".topbar .nav a.nav-link", { hasText: "Mac app" });
    expect(await link.getAttribute("href")).toBe("/mac");
    await Promise.all([page.waitForURL(`${server.origin}/mac`), link.click()]);
    expect(await page.title()).toBe("Mailviewer for Mac: open any email file on your Mac");
    await page.close();
  });
});
