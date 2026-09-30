import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit } from "playwright";
import { scratchFile, serveBuild } from "./harness.mjs";

/**
 * A message cut off at the MIME part cap has to be visible as such to the
 * person reading it: the warnings bar appears, and the part of the message
 * that was read is there to read.
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

  it("appears for a message cut off at the MIME part cap, and the message is still readable", async () => {
    const page = await browser.newPage();
    const started = Date.now();
    await open(page, scratchFile("capped-20000-parts.eml", manyPartsEml(20_000)));
    const elapsedMs = Date.now() - started;

    const bar = page.locator(".warnbar");
    await expect.poll(() => bar.count()).toBe(1);
    expect(await bar.innerText()).toContain("Opened with 1 problem");

    const shown = await page.locator(".msgview").innerText();
    expect(shown).toContain("20000 parts");
    expect(shown).toContain("part 1000");
    expect(shown).not.toContain("part 1001");

    // Uncapped, parsing this file alone takes several seconds in every engine.
    expect(elapsedMs).toBeLessThan(5000);
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
