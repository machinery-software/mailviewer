import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit } from "playwright";
import { containsText } from "./pdf.mjs";
import { PDF_CONTENTS, pdfContentsEml } from "./fixtures.mjs";
import { openAndPrepare, openPrintMenu, pdfFromChromium, scratchFile, serveBuild } from "./harness.mjs";

/**
 * What "Print or save as PDF" puts on paper, and the Safari hint for finding
 * Save as PDF.
 *
 * A guide quotes what the PDF contains, so the claim is held here: the
 * headers (subject, From, To, Cc, Date) and the attachment list are printed;
 * the attachments' bytes, Bcc and Reply-To are not. Chromium is checked in a
 * real PDF. Firefox's PDFs keep their text in compressed object streams that
 * pdf.mjs does not unpack, and Playwright cannot make a PDF from WebKit, so
 * those two are checked on the document the print job is made from, under
 * print media.
 */

const ENGINES = [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]];
const c = PDF_CONTENTS;
const name = (addr) => addr.replace(/\s*<.*$/, "");
const email = (addr) => addr.replace(/^.*<|>$/g, "");

/** Text that must be on the printed page. */
const PRINTED = [
  c.subject,
  "From", name(c.from), email(c.from),
  "To", ...c.to.map(name), ...c.to.map(email),
  "Cc", name(c.cc), email(c.cc),
  "Date",
  "Attached", ...c.attachments,
  c.bodyMarker,
];
/** Text that must not be. */
const NOT_PRINTED = [...c.attachmentMarkers, email(c.bcc), email(c.replyTo)];

let server;
beforeAll(async () => {
  server = await serveBuild();
}, 120000);
afterAll(async () => {
  await server?.close();
});

for (const [engine, type] of ENGINES) {
  describe(`print in ${engine}`, () => {
    let browser;
    let page;
    beforeAll(async () => {
      browser = await type.launch();
      page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await openAndPrepare(page, server.origin, scratchFile("pdf-contents.eml", pdfContentsEml()));
    }, 120000);
    afterAll(async () => {
      await browser?.close();
    });

    it(engine === "webkit" ? "shows the Save as PDF hint in Safari's engine" : "shows no Safari hint", async () => {
      await openPrintMenu(page, "message");
      const hint = page.locator(".printmenu-pop .printmenu-hint");
      if (engine === "webkit") {
        await expect.poll(() => hint.isVisible()).toBe(true);
        expect(await hint.innerText()).toBe("In the print sheet, choose PDF ▸ Save as PDF.");
        // One line, not wrapped inside the popover: its content box is one
        // line-height tall.
        const lines = await hint.evaluate((el) => {
          const cs = getComputedStyle(el);
          const content = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
          return content / parseFloat(cs.lineHeight);
        });
        expect(lines).toBe(1);
      } else {
        expect(await hint.count()).toBe(0);
      }
      await page.locator(".printmenu > summary").click();
    });

    it("prints the headers and the attachment list, not the attachments", async () => {
      await page.emulateMedia({ media: "print" });
      const shell = await page.evaluate(() => {
        const el = document.querySelector(".printout-shell.is-active");
        return { text: el.innerText, visible: getComputedStyle(el).display !== "none" };
      });
      // The body frames are sandbox="" (an opaque origin), so the page cannot
      // reach into them; Playwright can.
      const bodies = [];
      const imgs = [];
      for (const handle of await page.$$(".printout-shell.is-active iframe")) {
        const frame = await handle.contentFrame();
        bodies.push(await frame.evaluate(() => document.body.innerText));
        imgs.push(...(await frame.evaluate(() =>
          [...document.images].map((i) => ({ alt: i.alt, w: i.naturalWidth, h: i.naturalHeight })),
        )));
      }
      // null, not "screen": page.pdf() prints with whatever media is emulated.
      await page.emulateMedia({ media: null });
      const printed = { text: `${shell.text}\n${bodies.join("\n")}`, imgs, visible: shell.visible };

      expect(printed.visible).toBe(true);
      for (const t of PRINTED) expect(printed.text, `missing from the printed page: ${t}`).toContain(t);
      for (const t of NOT_PRINTED) expect(printed.text, `on the printed page but should not be: ${t}`).not.toContain(t);
      // The inline image is decoded and laid out at its real size.
      expect(printed.imgs).toEqual([{ alt: c.imageAlt, w: 240, h: 120 }]);
    });

    if (engine === "chromium") {
      it("puts the same in a real PDF", async () => {
        const pdf = await pdfFromChromium(page, "pdf-contents-chromium.pdf");
        for (const t of PRINTED) expect(containsText(pdf, t), `missing from the PDF: ${t}`).toBe(true);
        for (const t of NOT_PRINTED) expect(containsText(pdf, t), `in the PDF but should not be: ${t}`).toBe(false);
        expect(pdf.toString("latin1")).toMatch(/\/Subtype\s*\/Image/);
      });
    }
  });
}
