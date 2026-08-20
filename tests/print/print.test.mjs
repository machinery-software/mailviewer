import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit } from "playwright";
import { join } from "node:path";
import { pageCount, containsText } from "./pdf.mjs";
import { inlineImagesEml, longMessageEml, threadMbox, wideTableEml } from "./fixtures.mjs";
import {
  WORK,
  choosePrintList,
  firefoxPdf,
  firefoxPrintPrefs,
  measuredHeights,
  openAndPrepare,
  pdfFromChromium,
  scratchFile,
  serveBuild,
  undoFix,
  waitForMeasured,
} from "./harness.mjs";

/**
 * Printing was producing one page regardless of how long the message was.
 *
 * These tests assert against real PDFs rather than print preview, because
 * preview is not the artifact anyone complained about. A message body renders
 * in an iframe, an iframe is a replaced element, and a replaced element does
 * not paginate past the box it is given -- so the interesting question is
 * always "how many pages, and is the last line on one of them".
 */

let server;
let browser;

beforeAll(async () => {
  server = await serveBuild();
  browser = await chromium.launch();
}, 120000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function pageFor(file, opts) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openAndPrepare(page, server.origin, file, opts);
  return { page, errors };
}

describe("printing a single message", () => {
  it("paginates the whole body instead of stopping at the first page", async () => {
    const file = scratchFile("long.eml", longMessageEml(60));
    const { page, errors } = await pageFor(file);
    const pdf = await pdfFromChromium(page, "long.pdf");

    expect(errors).toEqual([]);
    expect(pageCount(pdf)).toBeGreaterThan(5);
    expect(containsText(pdf, "Paragraph 1.")).toBe(true);
    // The line that used to be cut off. This single assertion is the bug.
    expect(containsText(pdf, "FINAL-SENTINEL-LONG-MESSAGE")).toBe(true);
    await page.close();
  }, 120000);

  it("would have failed before the fix", async () => {
    const file = scratchFile("long.eml", longMessageEml(60));
    const { page } = await pageFor(file);
    await page.evaluate(undoFix);
    const pdf = await pdfFromChromium(page, "long-before.pdf");

    expect(pageCount(pdf)).toBe(1);
    expect(containsText(pdf, "FINAL-SENTINEL-LONG-MESSAGE")).toBe(false);
    await page.close();
  }, 120000);

  it("measures the body rather than falling back to the frame's placeholder", async () => {
    // A regression guard with history: inserting the measuring frame before
    // setting its srcdoc made it report the height of about:blank, so every
    // message measured as exactly the placeholder height and printed blank.
    const file = scratchFile("long.eml", longMessageEml(60));
    const { page } = await pageFor(file);
    const [height] = await measuredHeights(page);

    expect(height).toBeGreaterThan(5000);
    await page.close();
  }, 120000);

  it("keeps the message body sandboxed on paper", async () => {
    // The frame is a security boundary around untrusted HTML. Printing does not
    // get a more relaxed one, and no measuring frame is left behind afterwards.
    const file = scratchFile("long.eml", longMessageEml(60));
    const { page } = await pageFor(file);
    const frames = await page.evaluate(() =>
      [...document.querySelectorAll("iframe")].map((f) => ({
        sandbox: f.getAttribute("sandbox"),
        printed: !!f.closest(".printout"),
      })),
    );

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(frame.sandbox).toBe("");
    expect(frames.some((f) => f.printed)).toBe(true);
    await page.close();
  }, 120000);
});

describe("message shapes that print badly if the height is wrong", () => {
  it("prints a table far wider than the page without losing its last column", async () => {
    const file = scratchFile("table.eml", wideTableEml());
    const { page } = await pageFor(file);
    const pdf = await pdfFromChromium(page, "table.pdf");

    expect(pageCount(pdf)).toBeGreaterThan(1);
    expect(containsText(pdf, "R1C1-value")).toBe(true);
    expect(containsText(pdf, "FINAL-SENTINEL-WIDE-TABLE")).toBe(true);
    await page.close();
  }, 120000);

  it("waits for inline images to decode before deciding how tall the body is", async () => {
    // Inline mail images are data: URLs, which still decode asynchronously. A
    // synchronous measurement reports the height of a photo spread whose photos
    // have not arrived, and the bottom of the message is lost.
    const file = scratchFile("imgs.eml", inlineImagesEml(12));
    const { page } = await pageFor(file);
    const pdf = await pdfFromChromium(page, "imgs.pdf");

    expect(pageCount(pdf)).toBeGreaterThan(1);
    expect(containsText(pdf, "Exhibit 1")).toBe(true);
    expect(containsText(pdf, "Exhibit 12")).toBe(true);
    expect(containsText(pdf, "FINAL-SENTINEL-INLINE-IMAGES")).toBe(true);
    await page.close();
  }, 120000);
});

describe("printing everything currently listed", () => {
  it("prints every message in the list, each with its own headers", async () => {
    const file = scratchFile("chain.mbox", threadMbox(12));
    const { page } = await pageFor(file);

    const label = await choosePrintList(page);
    expect(label).toBe("All 12 messages listed");

    await waitForMeasured(page, 12);
    const pdf = await pdfFromChromium(page, "chain.pdf");

    expect(pageCount(pdf)).toBeGreaterThanOrEqual(12);
    for (let i = 1; i <= 12; i++) {
      expect(containsText(pdf, `SENTINEL-CHAIN-${i}`), `message ${i} missing`).toBe(true);
    }
    // A printed exhibit has to be self-describing: sender, recipient and date
    // on every message, and a statement of what the job covered.
    expect(containsText(pdf, "adjuster@fixture.invalid")).toBe(true);
    expect(containsText(pdf, "counsel@fixture.invalid")).toBe(true);
    expect(containsText(pdf, "Printed all 12 messages")).toBe(true);
    await page.close();
  }, 180000);

  it("prints only once the whole job has been measured", async () => {
    const file = scratchFile("chain.mbox", threadMbox(12));
    const { page } = await pageFor(file);
    await choosePrintList(page);
    await page.waitForFunction(() => window.__printCalls > 0, { timeout: 60000 });

    const state = await page.evaluate(() => ({
      calls: window.__printCalls,
      unmeasured: [...document.querySelectorAll(".printout iframe")]
        .filter((f) => !(parseInt(f.style.height, 10) > 0)).length,
      frames: document.querySelectorAll(".printout iframe").length,
    }));

    expect(state.calls).toBe(1);
    expect(state.frames).toBe(12);
    expect(state.unmeasured).toBe(0);
    await page.close();
  }, 180000);
});

describe("the rest of the app", () => {
  it("leaves the viewer untouched on screen", async () => {
    const file = scratchFile("long.eml", longMessageEml(60));
    const { page } = await pageFor(file);
    const screen = await page.evaluate(() => ({
      horizontalScroll:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
      viewerVisible: document.querySelector(".viewer").getBoundingClientRect().height > 0,
      printoutOffScreen: document.querySelector(".printout").getBoundingClientRect().right < 0,
    }));

    expect(screen.horizontalScroll).toBe(false);
    expect(screen.viewerVisible).toBe(true);
    expect(screen.printoutOffScreen).toBe(true);
    await page.close();
  }, 120000);

  it("does not change how the other pages print", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/#/privacy`);
    await page.emulateMedia({ media: "print" });
    const state = await page.evaluate(() => ({
      printout: !!document.querySelector(".printout"),
      topbar: getComputedStyle(document.querySelector(".topbar")).display,
    }));

    expect(state.printout).toBe(false);
    expect(state.topbar).toBe("flex");
    await page.close();
  }, 120000);
});

describe("other engines", () => {
  // Chrome, Safari and Firefox genuinely differ on printing iframes, so the fix
  // is checked on all three rather than assumed to carry over.
  it("paginates in Firefox too", async () => {
    const out = join(WORK, "firefox.pdf");
    const ff = await firefox.launch({ firefoxUserPrefs: firefoxPrintPrefs(out) });
    try {
      const page = await ff.newPage({ viewport: { width: 1280, height: 800 } });
      const file = scratchFile("long.eml", longMessageEml(60));
      await openAndPrepare(page, server.origin, file);
      const pdf = await firefoxPdf(page, out);

      // Page count only: Firefox writes its font tables into compressed object
      // streams, which the reader in pdf.mjs does not unpack, so text
      // extraction is not available here. The pagination is the claim anyway.
      expect(pageCount(pdf)).toBeGreaterThan(5);
    } finally {
      await ff.close();
    }
  }, 180000);

  it("lays out a full-height document in WebKit", async () => {
    // Playwright cannot produce a PDF from WebKit, so this asserts the
    // mechanism instead: under print media the document is as tall as the
    // measured message, rather than clipped to one viewport as it was before.
    const wk = await webkit.launch();
    try {
      const page = await wk.newPage({ viewport: { width: 1280, height: 800 } });
      const file = scratchFile("long.eml", longMessageEml(60));
      await openAndPrepare(page, server.origin, file);
      const [measured] = await measuredHeights(page);

      await page.emulateMedia({ media: "print" });
      const printed = await page.evaluate(() => ({
        docHeight: document.documentElement.scrollHeight,
        viewerHidden: getComputedStyle(document.querySelector(".viewer")).display === "none",
      }));

      expect(measured).toBeGreaterThan(5000);
      expect(printed.viewerHidden).toBe(true);
      expect(printed.docHeight).toBeGreaterThanOrEqual(measured);
    } finally {
      await wk.close();
    }
  }, 180000);
});
