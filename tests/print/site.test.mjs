import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit } from "playwright";
import { serveBuild } from "./harness.mjs";

/**
 * MAC-787: the site as one product, in real browsers against the build.
 *
 * - Every route has its own document title.
 * - The "Mac app" tab is in the header on every page and opens /mac.
 * - The home page's grids never end a row in an empty tile, at desktop,
 *   tablet and phone widths.
 * - The terms and contact pages exist, and the contact page's Copy Address
 *   button puts the support address on the clipboard (Chromium, which is the
 *   engine that lets a test read the clipboard back).
 * - Nothing scrolls sideways at 390px.
 * - None of it causes a console error, a CSP violation or a foreign request.
 */

const ENGINES = [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]];
const WIDTHS = [1280, 900, 390];
const ROUTES = {
  "#/": "Mailviewer",
  "#/open": "Open a file · Mailviewer",
  "#/privacy": "Privacy · Mailviewer",
  "#/verify": "Verify · Mailviewer",
  "#/report": "Report a problem · Mailviewer",
  "#/terms": "Terms · Mailviewer",
  "#/contact": "Contact · Mailviewer",
};

let server;
beforeAll(async () => {
  server = await serveBuild();
}, 120000);
afterAll(async () => {
  await server?.close();
});

async function watch(page) {
  const seen = [];
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__violations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  page.on("console", (m) => {
    if (!["error", "warning"].includes(m.type())) return;
    if (/^Error with Permissions-Policy header: Unrecognized feature: '[a-z-]+'\.$/.test(m.text())) return;
    seen.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => seen.push(`pageerror: ${e.message}`));
  page.on("request", (r) => !r.url().startsWith(server.origin) && !r.url().startsWith("data:") && seen.push(`request: ${r.url()}`));
  return async () => [...seen, ...(await page.evaluate(() => window.__violations)).map((v) => `violation: ${v}`)];
}

/** For each grid: how many cards, how many columns the browser laid out, and whether the last row is full. */
function gridFill(page, selector) {
  return page.$$eval(selector, (grids) =>
    grids.map((g) => {
      const cols = getComputedStyle(g).gridTemplateColumns.split(" ").filter(Boolean).length;
      const cards = g.children.length;
      return { cols, cards, full: cards % cols === 0 };
    }),
  );
}

describe.each(ENGINES)("the site in %s", (name, engine) => {
  let browser;
  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it.each(Object.entries(ROUTES))("%s is titled %s", async (hash, title) => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/${hash}`);
    await page.waitForSelector(".topbar");
    await expect.poll(() => page.title()).toBe(title);
    await page.close();
  });

  it("has the Mac app tab in the header of every page, and it opens /mac", async () => {
    const page = await browser.newPage();
    for (const hash of Object.keys(ROUTES)) {
      await page.goto(`${server.origin}/${hash}`);
      await page.waitForSelector(".topbar");
      const tab = page.locator(".topbar .nav a.nav-link", { hasText: "Mac app" });
      expect(await tab.getAttribute("href"), hash).toBe("/mac");
    }
    await page.goto(`${server.origin}/#/`);
    await Promise.all([page.waitForURL(`${server.origin}/mac`), page.locator(".topbar .nav a.nav-link", { hasText: "Mac app" }).click()]);
    expect(await page.title()).toBe("Mailviewer for Mac: open any email file on your Mac");
    // And the Mac page's own header has the same tab, current.
    expect(await page.locator('header nav a[aria-current="page"]').innerText()).toBe("Mac app");
    await page.close();
  });

  it("has the Mac app card under the hero, and it opens /mac", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/#/`);
    const card = page.locator("a.maccard");
    expect(await card.innerText()).toContain("Mailviewer for Mac");
    expect(await card.innerText()).toContain("Download free, license for teams");
    const hero = await page.locator(".hero2").boundingBox();
    const box = await card.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(hero.y + hero.height - 1);
    await Promise.all([page.waitForURL(`${server.origin}/mac`), card.click()]);
    await page.close();
  });

  it.each(WIDTHS.map((w) => [w]))("fills every row of the home page's grids at %spx", async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${server.origin}/#/`);
    await page.waitForSelector(".formats");
    const grids = await gridFill(page, ".formats, .privacy-cards");
    expect(grids).toHaveLength(2);
    for (const g of grids) expect(g, JSON.stringify(g)).toMatchObject({ full: true });
    expect(grids[0].cards).toBe(8);
    expect(grids[1].cards).toBe(3);
    await page.close();
  });

  it.each(WIDTHS.map((w) => [w]))("fills every row of the Mac page's grids at %spx", async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${server.origin}/mac/`);
    const grids = await gridFill(page, ".plans, .grid4");
    expect(grids).toHaveLength(3);
    for (const g of grids) expect(g, JSON.stringify(g)).toMatchObject({ full: true, cards: 4 });
    await page.close();
  });

  it("sends the Mac page's Terms to the release host, and the site's Terms to its own terms page", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/mac/`);
    expect(await page.locator("footer a", { hasText: "Terms" }).getAttribute("href")).toBe("https://updates.mailviewer.app/terms/");
    await page.goto(`${server.origin}/#/`);
    await page.waitForSelector(".footer");
    await Promise.all([page.waitForURL(`${server.origin}/#/terms`), page.locator(".footer a", { hasText: "Terms" }).click()]);
    await expect.poll(() => page.title()).toBe("Terms · Mailviewer");
    const text = await page.locator(".section").innerText();
    expect(text).toContain("The web app is free, and these are its terms");
    expect(await page.locator('.section a[href="https://updates.mailviewer.app/terms/"]').count()).toBe(1);
    await page.close();
  });

  it("offers Copy Address and Open in Mail on the contact page, like the Mac app's sheet", async () => {
    const context = await browser.newContext();
    if (name === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.origin });
    const page = await context.newPage();
    await page.goto(`${server.origin}/#/contact`);
    const first = page.locator(".contact-card").first();
    expect(await first.locator(".contact-addr").innerText()).toBe("support@mailviewer.app");
    expect(await first.locator("a.btn", { hasText: "Open in Mail" }).getAttribute("href")).toBe("mailto:support@mailviewer.app");
    const copy = first.locator("button", { hasText: "Copy Address" });
    expect(await copy.count(), "the clipboard API exists in a secure context, so the button is offered").toBe(1);
    if (name === "chromium") {
      await copy.click();
      await expect.poll(() => first.locator(".contact-status").innerText()).toBe("Copied");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("support@mailviewer.app");
    }
    await context.close();
  });

  it.each(["#/", "#/privacy", "#/terms", "#/contact", "#/report", "#/verify"].map((h) => [h]))("%s does not scroll sideways at 390px", async (hash) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${server.origin}/${hash}`);
    await page.waitForSelector(".topbar");
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(scroll).toBeLessThanOrEqual(client);
    await page.close();
  });

  it("renders home, terms and contact under the CSP with no violation, console error or foreign request", async () => {
    for (const hash of ["#/", "#/terms", "#/contact"]) {
      const page = await browser.newPage();
      const problems = await watch(page);
      await page.goto(`${server.origin}/${hash}`, { waitUntil: "load" });
      await page.waitForSelector(".footer");
      await page.waitForTimeout(250);
      expect(await problems(), hash).toEqual([]);
      await page.close();
    }
  });
});
