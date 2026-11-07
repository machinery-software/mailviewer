import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit } from "playwright";
import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { threadMbox } from "./fixtures.mjs";
import { msgHtml } from "./msgFixture.mjs";
import { emlHtml, emlx, mht, oft, olm, olmMalformed, olmOutlook, olmTruncated, winmailDat } from "./formatFixtures.mjs";
import { WORK, scratchFile, serveBuild } from "./harness.mjs";

/**
 * MAC-513: every format the site says it opens, opened by the production build
 * in a real browser, with the parsing done in the parse Web Worker.
 *
 * The .olm parser passed its unit tests in jsdom and failed for every user,
 * because the worker it runs in has no DOMParser. A unit test cannot tell a
 * test environment from the runtime; this can. Each file goes in through the
 * same <input type=file> a user's file does, and the test records that a
 * worker was started for it.
 *
 * .pst and .ost are not here: the repo has no PST writer and no PST fixture
 * (MAC-526), so neither is verified by any test. The results table is written
 * to $TMPDIR/mailviewer-print-tests/formats.json for the PR.
 */

const ENGINES = [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]];

// [extension as advertised, file name, bytes, what a successful open shows]
const OPENS = [
  [".eml", "fmt.eml", () => emlHtml(), { rows: 1, subject: "HTML .eml", marker: "EML-HTML-END-MARKER" }],
  [".emlx", "fmt.emlx", () => Buffer.from(emlx()), { rows: 1, subject: "An .emlx", marker: "EMLX-END-MARKER" }],
  [".msg", "fmt.msg", () => Buffer.from(msgHtml(30)), { rows: 1, marker: "MSG-HTML-END-MARKER" }],
  [".oft", "fmt.oft", () => Buffer.from(oft()), { rows: 1, subject: "An .oft template", marker: "OFT-END-MARKER" }],
  [".mbox", "fmt.mbox", () => threadMbox(12), { rows: 12 }],
  [".mbx", "fmt.mbx", () => threadMbox(3), { rows: 3 }],
  [".olm (print-suite layout)", "fmt.olm", () => Buffer.from(olm()), { rows: 1, subject: "An .olm message", marker: "OLM-END-MARKER" }],
  [".olm (Outlook 2016+ layout)", "Outlook for Mac Archive.olm", () => Buffer.from(olmOutlook()),
    { rows: 2, subject: "Claim 4471 — surveyor's report", marker: "OLM-OUTLOOK-END-MARKER", attachments: ["survey-schedule.pdf", "readings.xml"] }],
  [".mht", "fmt.mht", () => Buffer.from(mht()), { rows: 1, subject: "Saved page", marker: "MHT-END-MARKER" }],
  [".mhtml", "fmt.mhtml", () => Buffer.from(mht()), { rows: 1, subject: "Saved page", marker: "MHT-END-MARKER" }],
  ["winmail.dat", "winmail.dat", () => Buffer.from(winmailDat()), { rows: 1, subject: "A winmail.dat", marker: "TNEF-END-MARKER" }],
];

// A PST/OST header with nothing behind it. There is no PST fixture (MAC-526), so
// this is all the browser suite can say about .pst/.ost: the worker loads the
// PST reader and it fails cleanly rather than on a missing browser API. It is
// not evidence that a real mailbox opens.
const pstHeaderOnly = () => Buffer.concat([Buffer.from("!BDN"), Buffer.alloc(1020)]);

// Damaged files: one row in the "Couldn't open" list, promptly, no crash.
const FAILS = [
  [".pst header only (reaches the PST reader)", "header-only.pst", pstHeaderOnly, /^header-only\.pst: (?!.*(is not defined|Can't find variable))/],
  [".ost header only (reaches the PST reader)", "header-only.ost", pstHeaderOnly, /^header-only\.ost: (?!.*(is not defined|Can't find variable))/],
  [".olm truncated", "cut-short.olm", () => Buffer.from(olmTruncated()), /incomplete or damaged/],
  [".olm malformed XML", "malformed.olm", () => Buffer.from(olmMalformed()), /None of the 1 message file in this \.olm could be read/],
];

let server;
const table = [];

beforeAll(async () => {
  server = await serveBuild();
}, 120000);
afterAll(async () => {
  await server?.close();
  writeFileSync(join(WORK, "formats.json"), JSON.stringify(table, null, 2));
});

/** Open one file through the real input; resolve with what the page showed. */
async function open(page, file) {
  let workers = 0;
  page.on("worker", () => workers++);
  await page.goto(`${server.origin}/#/open`);
  await page.setInputFiles("input[type=file]", file);
  await page.waitForSelector(".msgrow, .callout.bad", { timeout: 30000 });
  const errors = await page.$$eval(".callout.bad li", (lis) => lis.map((li) => li.textContent));
  return { workers, errors };
}

/** Does any frame on the page (the message body is a sandboxed srcdoc frame) contain `text`? */
async function framesContain(page, text) {
  for (const frame of page.frames()) {
    const body = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (body.includes(text)) return true;
  }
  return (await page.locator(".msgbody").first().innerText().catch(() => "")).includes(text);
}

for (const [engine, type] of ENGINES) {
  describe(`advertised formats in ${engine}`, () => {
    let browser;
    beforeAll(async () => {
      browser = await type.launch();
    }, 120000);
    afterAll(async () => {
      await browser?.close();
    });

    for (const [ext, name, build, want] of OPENS) {
      it(`opens ${ext}`, async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        const pageErrors = [];
        page.on("pageerror", (e) => pageErrors.push(e.message));
        const row = { engine, format: ext, file: name, opened: false, detail: "" };
        table.push(row);
        try {
          const { workers, errors } = await open(page, scratchFile(name, build()));
          row.detail = errors.join(" | ");
          expect(errors, `${ext} did not open`).toEqual([]);
          expect(workers, "the file was not parsed in a Web Worker").toBeGreaterThanOrEqual(1);
          await expect.poll(() => page.locator(".msgrow").count()).toBe(want.rows);
          await page.locator(".msgrow").first().click();
          await page.waitForSelector(".msgview");
          if (want.subject) {
            expect(await page.locator(".msgrow-subject").first().innerText()).toContain(want.subject);
          }
          if (want.marker) await expect.poll(() => framesContain(page, want.marker), { timeout: 15000 }).toBe(true);
          if (want.attachments) {
            const names = await page.$$eval(".attach-list .attach", (as) => as.map((a) => a.getAttribute("download")));
            expect(names).toEqual(want.attachments);
          }
          expect(pageErrors).toEqual([]);
          row.opened = true;
          row.detail = `${want.rows} message${want.rows === 1 ? "" : "s"}, ${workers} worker`;
        } finally {
          await page.close();
        }
      }, 120000);
    }

    for (const [what, name, build, message] of FAILS) {
      it(`reports ${what} as one error row`, async () => {
        const page = await browser.newPage();
        const row = { engine, format: what, file: name, opened: false, detail: "" };
        table.push(row);
        try {
          const started = Date.now();
          const { errors } = await open(page, scratchFile(name, build()));
          row.detail = errors.join(" | ");
          expect(errors).toHaveLength(1);
          expect(errors[0]).toMatch(message);
          expect(Date.now() - started).toBeLessThan(15000);
          row.opened = "error row, as intended";
        } finally {
          await page.close();
        }
      }, 60000);
    }
  });
}
