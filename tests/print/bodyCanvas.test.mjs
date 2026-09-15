import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit } from "playwright";
import { Buffer } from "node:buffer";
import { SENDER_COLOURS, colouredTextEml, longPlainTextEml } from "./fixtures.mjs";
import { msgRtfEncapsulatedColouredHtml, msgRtfText, msgWordColouredBody } from "./msgFixture.mjs";
import { openAndPrepare, scratchFile, serveBuild } from "./harness.mjs";
import { analyse, contrast, hex, histogram, rgb, sameColour } from "./pixels.mjs";

/**
 * A message body renders on a light canvas, in the colours its sender chose,
 * whatever the app around it is doing and whatever the OS prefers -- and it
 * prints in the same colours it shows.
 *
 * Every assertion here is made on rendered pixels: screenshots of the body on
 * screen and in the print layout, decoded and counted. None of them reads a
 * computed style or the CSS the app writes. The bug this guards was exactly a
 * disagreement between the two -- the frame element's style said white, while
 * the document inside it painted #141417 over the top -- so a test that reads
 * styles could pass on the build that was broken.
 */

const ENGINES = [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]];

/**
 * One body per render path. Sanitized HTML and HTML recovered from RTF land in
 * the sandboxed frame; plain text and genuine RTF land in a <pre> in the app's
 * own document. The .msg HTML case carries Word's viewport-pinned wrapper CSS.
 */
const BODIES = [
  { label: "an HTML .eml that sets text colours and no background", file: "coloured.eml",
    build: () => colouredTextEml(), frames: 1, declared: true },
  { label: "a Word-authored .msg with wrapper CSS", file: "coloured-word.msg",
    build: () => Buffer.from(msgWordColouredBody()), frames: 1, declared: true },
  { label: "a .msg whose coloured HTML is encapsulated in RTF", file: "coloured-rtf.msg",
    build: () => Buffer.from(msgRtfEncapsulatedColouredHtml()), frames: 1, declared: true },
  { label: "a .msg whose body is genuine RTF", file: "canvas-rtf.msg",
    build: () => Buffer.from(msgRtfText(6)), frames: 0, declared: false },
  { label: "a plain-text .eml", file: "canvas-plain.eml",
    build: () => longPlainTextEml(6), frames: 0, declared: false },
];

/** The colours text must be legible in. SENDER_COLOURS.pale is excluded on purpose. */
const BODY_TEXT = ["navy", "purple"];

/** Enough same-coloured pixels that they are glyphs, not a stray blend. */
const GLYPH_PIXELS = 50;

let server;

beforeAll(async () => {
  server = await serveBuild();
}, 120000);

afterAll(async () => {
  await server?.close();
});

/**
 * Screenshot a body once it has finished painting.
 *
 * The on-screen frame is sandboxed with an opaque origin, so nothing can ask it
 * whether it has loaded. For a body with declared colours, wait until they are
 * on screen; for one without, wait until two captures in a row agree.
 */
async function bodyShot(browser, locator, declared) {
  let previous = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const shot = await locator.screenshot();
    if (declared) {
      const seen = analyse(await histogram(browser, shot));
      if (seen.pixelsOf(SENDER_COLOURS.navy) > GLYPH_PIXELS) return shot;
    } else if (previous && Buffer.compare(previous, shot) === 0) {
      return shot;
    }
    previous = shot;
    await new Promise((r) => setTimeout(r, 250));
  }
  return previous;
}

async function renderBody(browser, colorScheme, body) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openAndPrepare(page, server.origin, scratchFile(body.file, body.build()), {
    expectFrames: body.frames,
  });
  const screen = analyse(await histogram(browser, await bodyShot(browser, page.locator(".msgbody"), body.declared)));

  await page.emulateMedia({ media: "print" });
  const printed = page.locator(".printout-shell.is-active .printmsg-body");
  const print = analyse(await histogram(browser, await bodyShot(browser, printed, body.declared)));

  return { context, page, errors, screen, print };
}

for (const [engineName, engine] of ENGINES) {
  describe(`message body canvas in ${engineName}`, () => {
    let browser;

    beforeAll(async () => {
      browser = await engine.launch();
    }, 120000);

    afterAll(async () => {
      await browser?.close();
    });

    for (const colorScheme of ["dark", "light"]) {
      for (const body of BODIES) {
        it(`renders ${body.label} legibly, as sent, with the OS preferring ${colorScheme}`, async () => {
          const { context, errors, screen, print } = await renderBody(browser, colorScheme, body);
          try {
            expect(errors).toEqual([]);

            // A light canvas, on screen and on paper alike.
            expect.soft(hex(screen.backdrop), "the canvas behind the body on screen").toBe("#ffffff");
            expect.soft(hex(print.backdrop), "the canvas behind the printed body").toBe(hex(screen.backdrop));

            if (body.declared) {
              for (const [name, colour] of Object.entries(SENDER_COLOURS)) {
                // Exactly the colour the sender wrote, not a "corrected" one.
                expect.soft(screen.pixelsOf(colour), `${name} ${colour} painted on screen`)
                  .toBeGreaterThan(GLYPH_PIXELS);
                expect.soft(print.pixelsOf(colour), `${name} ${colour} painted in print`)
                  .toBeGreaterThan(GLYPH_PIXELS);
              }
              for (const name of BODY_TEXT) {
                const ratio = contrast(rgb(SENDER_COLOURS[name]), screen.backdrop);
                expect.soft(ratio, `${name} text against the on-screen canvas`).toBeGreaterThanOrEqual(4.5);
              }
            } else {
              const ink = screen.ink();
              const printedInk = print.ink();
              expect.soft(contrast(ink, screen.backdrop), `text ${hex(ink)} on ${hex(screen.backdrop)}`)
                .toBeGreaterThanOrEqual(4.5);
              expect.soft(
                sameColour(ink, printedInk),
                `text is ${hex(ink)} on screen but ${hex(printedInk)} in print`,
              ).toBe(true);
            }
          } finally {
            await context.close();
          }
        }, 180000);
      }
    }
  });
}

/**
 * The colour assertions above have to be able to fail on a body that is
 * legible but no longer as sent -- the tempting wrong fix. Every assertion in
 * the suite fails against the build before this change, but that build never
 * recoloured anything, so it cannot show this particular check biting. This
 * applies the classic "dark mode for email" filter and shows that it does.
 */
describe("the sender-colour check", () => {
  it("rejects a body that has been recoloured instead of rendered as sent", async () => {
    const browser = await chromium.launch();
    try {
      const body = BODIES[0];
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
      const page = await context.newPage();
      await openAndPrepare(page, server.origin, scratchFile(body.file, body.build()));
      await page.addStyleTag({ content: ".msgbody iframe{filter:invert(1) hue-rotate(180deg)}" });
      await new Promise((r) => setTimeout(r, 500));
      const seen = analyse(await histogram(browser, await page.locator(".msgbody").screenshot()));
      for (const [name, colour] of Object.entries(SENDER_COLOURS)) {
        expect(seen.pixelsOf(colour), `${name} survived the filter`).toBeLessThanOrEqual(GLYPH_PIXELS);
      }
      await context.close();
    } finally {
      await browser.close();
    }
  }, 180000);
});
