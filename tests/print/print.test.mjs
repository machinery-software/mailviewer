import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit } from "playwright";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { pageCount, containsText } from "./pdf.mjs";
import {
  inlineImagesEml,
  longMessageEml,
  longPlainTextEml,
  threadMbox,
  wideTableEml,
} from "./fixtures.mjs";
import { msgHtml, msgPlainText, msgRtfEncapsulatedHtml, msgRtfText } from "./msgFixture.mjs";
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
    }));

    expect(screen.horizontalScroll).toBe(false);
    expect(screen.viewerVisible).toBe(true);
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

/**
 * The print document must not be visible on screen.
 *
 * This is asserted directly rather than inferred from the container's
 * position, because inferring it is exactly how it was missed: the container
 * sat off-screen with a 703px-wide box, and a <pre> inside it overflowed that
 * box by thousands of pixels and painted its right-hand end back across the
 * live app. Every geometric assertion about the *box* passed while message
 * text was being drawn over the message list.
 *
 * So the test removes the print document and compares the pixels. If the print
 * document is drawing anything a user can see, the two screenshots differ --
 * whatever the mechanism, and without needing to predict it.
 */
describe("the print document has no on-screen footprint", () => {
  const engines = [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]];

  for (const [name, type] of engines) {
    it(`paints nothing in the viewport in ${name}`, async () => {
      const browser2 = await type.launch();
      try {
        const page = await browser2.newPage({ viewport: { width: 1280, height: 900 } });
        // A plain-text body: the shape that produced the unwrapped line.
        const file = scratchFile("plain.eml", longPlainTextEml(40));
        await openAndPrepare(page, server.origin, file, { expectFrames: 0 });

        const geometry = await page.evaluate(() => {
          const shell = document.querySelector(".printout-shell");
          const box = shell.getBoundingClientRect();
          return {
            area: Math.round(box.width * box.height),
            overflow: getComputedStyle(shell).overflow,
            // Content that cannot overflow its box cannot escape the clip.
            unwrapped: [...shell.querySelectorAll("pre")]
              .filter((pre) => pre.scrollWidth > Math.ceil(pre.getBoundingClientRect().width))
              .length,
          };
        });

        expect(geometry.area).toBe(0);
        expect(geometry.overflow).toBe("hidden");
        expect(geometry.unwrapped).toBe(0);

        const withPrintDocument = await page.screenshot();
        await page.evaluate(() => document.querySelector(".printout-shell").remove());
        const withoutPrintDocument = await page.screenshot();

        expect(
          Buffer.compare(withPrintDocument, withoutPrintDocument),
          "removing the print document changed what is on screen, so it was painting there",
        ).toBe(0);
      } finally {
        await browser2.close();
      }
    }, 180000);
  }
});

/**
 * Bodies that never reach the sandboxed frame.
 *
 * Every print fixture before this one was HTML, so every one of them exercised
 * the iframe path and none of them exercised the other two. A .msg in
 * particular can arrive as any of four different body shapes depending on what
 * Outlook wrote, and which shape you get decides which render path runs.
 */
describe("non-HTML bodies", () => {
  const cases = [
    ["a long plain-text .eml", "plain.eml", () => longPlainTextEml(40), "END-OF-DOCUMENT-MARKER"],
    ["a .msg carrying only PidTagBody text", "plain.msg", () => Buffer.from(msgPlainText(40)), "MSG-PLAIN-END-MARKER"],
    ["a .msg carrying PidTagBodyHtml", "html.msg", () => Buffer.from(msgHtml(40)), "MSG-HTML-END-MARKER"],
    ["a .msg whose body is genuine RTF", "rtf.msg", () => Buffer.from(msgRtfText(40)), "MSG-RTF-TEXT-END-MARKER"],
    ["a .msg whose body is HTML encapsulated in RTF", "rtfhtml.msg", () => Buffer.from(msgRtfEncapsulatedHtml(40)), "MSG-RTF-HTML-END-MARKER"],
  ];

  for (const [label, filename, build, marker] of cases) {
    it(`paginates ${label}`, async () => {
      const file = scratchFile(filename, build());
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await openAndPrepare(page, server.origin, file, { expectFrames: 0 });
      const pdf = await pdfFromChromium(page, `${filename}.pdf`);

      expect(errors).toEqual([]);
      expect(pageCount(pdf)).toBeGreaterThan(1);
      expect(containsText(pdf, "Paragraph 1.")).toBe(true);
      // The end marker is the whole point: truncation is only detectable by
      // looking for the last thing in the document.
      expect(containsText(pdf, marker), `${label}: end marker missing from the PDF`).toBe(true);
      await page.close();
    }, 180000);
  }
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
