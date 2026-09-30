import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit } from "playwright";
import { Buffer } from "node:buffer";
import { buildCfb, storage, stream } from "../../src/lib/parse/__tests__/cfbBuilder.ts";
import { scratchFile, serveBuild } from "./harness.mjs";

/**
 * A message cut off at the MIME part limit has to be visible as such to the
 * person reading it -- who may be about to print it as a record. The warnings
 * bar says, specifically, that the message exceeds the limit and that only the
 * first 1,000 parts are shown. It does not say "damaged": nothing was. That
 * sentence stays for input that really is damaged.
 *
 * This runs the built app in real browsers rather than asserting on the
 * parser's `warnings` array, because an array nobody renders tells the reader
 * nothing. (It lives with the print tests because that is where the
 * real-browser harness is; nothing here prints.)
 */

const ENGINES = [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]];

function manyPartsEml(n) {
  let body = 'Content-Type: multipart/mixed; boundary="bb"\r\n\r\n';
  for (let i = 1; i <= n; i++) body += `--bb\r\nContent-Type: text/plain\r\n\r\npart ${i}\r\n`;
  body += "--bb--\r\n";
  return (
    "From: Sender <sender@fixture.invalid>\r\nTo: Reader <reader@fixture.invalid>\r\n" +
    `Subject: ${n} parts\r\nDate: Tue, 3 Jun 2025 09:14:00 -0400\r\nMIME-Version: 1.0\r\n` + body
  );
}

/** A .msg with an attachment that has a name and no data: genuinely damaged. */
function damagedMsg() {
  const utf16 = (s) => Buffer.from(s, "utf16le");
  const str = (tag, value) => stream(`__substg1.0_${tag}001F`, utf16(value));
  return Buffer.from(
    buildCfb([
      str("0037", "Damaged attachment"),
      str("0C1A", "Sender"),
      str("1000", "The body survives."),
      storage("__attach_version1.0_#00000000", [str("3707", "lost.pdf")]),
    ]),
  );
}

const PART_LIMIT_TEXT =
  "\u201c20000 parts\u201d has 20,000 MIME parts, which exceeds the 1,000-part limit. " +
  "Only the first 1,000 parts are shown; the other 19,000, and any attachments among them, are not.";
const DAMAGED_TEXT = "Opened with 1 problem \u2014 some messages were damaged and skipped.";

let server;

beforeAll(async () => {
  server = await serveBuild();
}, 120000);

afterAll(async () => {
  await server?.close();
});

async function open(page, file) {
  await page.goto(`${server.origin}/#/open`);
  await page.setInputFiles("input[type=file]", file);
  await page.waitForSelector(".msgrow", { timeout: 60000 });
  await page.locator(".msgrow").first().click();
  await page.waitForSelector(".msgview", { timeout: 30000 });
}

describe.each(ENGINES)("the warnings bar in %s", (_name, engine) => {
  let browser;

  beforeAll(async () => {
    browser = await engine.launch();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("says a message exceeded the 1,000-part limit and shows only the first 1,000 parts", async () => {
    const page = await browser.newPage();
    const started = Date.now();
    await open(page, scratchFile("capped-20000-parts.eml", manyPartsEml(20_000)));
    const elapsedMs = Date.now() - started;

    const bar = page.locator(".warnbar");
    await expect.poll(() => bar.count()).toBe(1);
    const said = (await bar.innerText()).replace(/\s+/g, " ");
    expect(said).toContain(PART_LIMIT_TEXT);
    // Nothing was damaged, and the bar must not say that it was.
    expect(said).not.toContain("damaged");
    expect(said).not.toContain("problem \u2014");

    const shown = await page.locator(".msgview").innerText();
    expect(shown).toContain("20000 parts");
    expect(shown).toContain("part 1000");
    expect(shown).not.toContain("part 1001");

    // Uncapped, parsing this file alone takes several seconds in every engine.
    expect(elapsedMs).toBeLessThan(5000);
    await page.close();
  });

  it("keeps the existing sentence for input that really is damaged", async () => {
    const page = await browser.newPage();
    await open(page, scratchFile("damaged-attachment.msg", damagedMsg()));
    const said = (await page.locator(".warnbar").innerText()).replace(/\s+/g, " ");
    expect(said).toContain(DAMAGED_TEXT);
    expect(said).not.toContain("part limit");
    expect(said).not.toContain("MIME parts");
    expect(await page.locator(".msgview").innerText()).toContain("The body survives.");
    await page.close();
  });

  it("says both when one file is over the limit and another is damaged", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/#/open`);
    await page.setInputFiles("input[type=file]", [
      scratchFile("capped-20000-parts.eml", manyPartsEml(20_000)),
      scratchFile("damaged-attachment.msg", damagedMsg()),
    ]);
    // Both files are open once the file list counts two messages.
    await expect
      .poll(async () => (await page.locator(".pane").first().innerText()).replace(/\s+/g, " "), { timeout: 60000 })
      .toContain("All messages 2");
    const said = (await page.locator(".warnbar").innerText()).replace(/\s+/g, " ");
    expect(said).toContain(PART_LIMIT_TEXT);
    expect(said).toContain(DAMAGED_TEXT);
    await page.close();
  });

  it("does not appear for an ordinary multipart message", async () => {
    const page = await browser.newPage();
    await open(page, scratchFile("ordinary-3-parts.eml", manyPartsEml(3)));
    expect(await page.locator(".warnbar").count()).toBe(0);
    expect(await page.locator(".msgview").innerText()).toContain("part 3");
    await page.close();
  });
});
