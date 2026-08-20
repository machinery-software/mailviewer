import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "./server.mjs";

export const ROOT = new URL("../../", import.meta.url).pathname;
export const WORK = join(tmpdir(), "mailviewer-print-tests");

export function scratchFile(name, content) {
  mkdirSync(WORK, { recursive: true });
  const path = join(WORK, name);
  writeFileSync(path, content);
  return path;
}

export function serveBuild() {
  if (!existsSync(join(ROOT, "dist", "index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build` before the print tests.");
  }
  return startServer(join(ROOT, "dist"), join(ROOT, "public/_headers"));
}

/**
 * Open a mail file in the viewer and wait until the printable document is
 * fully measured.
 *
 * Waiting on the measured height rather than on a timeout is the point: an
 * unmeasured frame has no height, and printing one is the bug under test.
 */
export async function openAndPrepare(page, origin, file, { expectFrames = 1 } = {}) {
  await page.goto(`${origin}/#/open`);
  await page.setInputFiles("input[type=file]", file);
  await page.waitForSelector(".msgrow", { timeout: 30000 });
  await page.locator(".msgrow").first().click();
  await page.waitForSelector(".msgview", { timeout: 30000 });
  await waitForMeasured(page, expectFrames);
}

/**
 * Wait until the print document is ready to be printed.
 *
 * `expectFrames: 0` is the case for a body that never reaches a frame at all --
 * plain text and non-encapsulated RTF render as a <pre> in the parent document
 * and have nothing to measure. Those still have to be waited for, so this waits
 * on the print document being populated rather than on frames existing.
 */
export function waitForMeasured(page, expectFrames) {
  return page.waitForFunction(
    (n) => {
      // The active document is the one a print job would produce. While the
      // print menu is open there is a second, inactive one alongside it.
      const shell = document.querySelector(".printout-shell.is-active");
      if (!shell || !shell.querySelector(".printmsg")) return false;
      const frames = [...shell.querySelectorAll("iframe")];
      if (frames.length < n) return false;
      return frames.every((f) => parseInt(f.style.height, 10) > 0);
    },
    expectFrames,
    { timeout: 60000 },
  );
}

/** Heights the app decided each printed body needs, in document order. */
export function measuredHeights(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".printout-shell.is-active iframe")].map((f) =>
      parseInt(f.style.height, 10),
    ),
  );
}

/**
 * Stub the print dialog, recording each call and -- the part that matters --
 * whether it happened inside the click that asked for it.
 */
export function stubPrint(page) {
  return page.evaluate(() => {
    // window.print() opens a modal the test cannot dismiss. Recording the call
    // is not enough on its own: the broken build called it too, just a task
    // late, and a browser defers the modal to the next interaction when the
    // gesture has lapsed.
    window.__printCalls = [];
    window.__gestureAt = null;
    window.__inGesture = false;
    document.addEventListener(
      "click",
      () => {
        window.__gestureAt = performance.now();
        window.__inGesture = true;
        // Cleared on the next task. Anything that had to await -- a frame load,
        // a measurement, even an already-resolved promise -- lands after this
        // runs, so the flag answers "inside the click, or merely soon after it"
        // with no timing threshold to tune.
        setTimeout(() => {
          window.__inGesture = false;
        }, 0);
      },
      true,
    );
    window.print = () => {
      window.__printCalls.push({
        duringGesture: window.__inGesture,
        sinceGestureMs:
          window.__gestureAt === null ? null : performance.now() - window.__gestureAt,
        activationLive: navigator.userActivation ? navigator.userActivation.isActive : null,
      });
    };
  });
}

/** Open the print menu and wait until the given scope can actually be printed. */
export async function openPrintMenu(page, scope) {
  const index = scope === "message" ? 0 : 1;
  await page.locator(".printmenu > summary").click();
  await page.locator(".printmenu-pop button").nth(index).waitFor({ state: "visible" });
  await page.waitForFunction(
    (i) => !document.querySelectorAll(".printmenu-pop button")[i].disabled,
    index,
    { timeout: 60000 },
  );
  return index;
}

/** Click a scope option and return what the control said it would do. */
export async function choosePrintScope(page, scope) {
  const index = await openPrintMenu(page, scope);
  const option = page.locator(".printmenu-pop button").nth(index);
  // The "Preparing…" hint is a child of the button and is gone by now; strip it
  // anyway so the assertion stays about what the option is called.
  const label = (await option.textContent()).replace("Preparing…", "").trim();
  await option.click();
  return label;
}

/** Choose the all-messages scope, stubbing the print dialog first. */
export async function choosePrintList(page) {
  await stubPrint(page);
  return choosePrintScope(page, "list");
}

/**
 * Print to a real PDF.
 *
 * Chromium is the only engine Playwright can produce a PDF from directly.
 * Firefox can be driven into it through its silent-print preferences, which is
 * worth the trouble: the engines paginate differently and this bug was about
 * pagination. WebKit has no equivalent, so those checks assert print-media
 * layout instead and say so.
 */
export async function pdfFromChromium(page, name) {
  mkdirSync(WORK, { recursive: true });
  const path = join(WORK, name);
  await page.pdf({ path, format: "Letter", printBackground: true });
  return readFileSync(path);
}

export function firefoxPrintPrefs(outPath) {
  rmSync(outPath, { force: true });
  return {
    "print.always_print_silent": true,
    "print.show_print_progress": false,
    print_printer: "Mozilla Save to PDF",
    "print.printer_Mozilla_Save_to_PDF.print_to_file": true,
    "print.printer_Mozilla_Save_to_PDF.print_to_filename": outPath,
  };
}

export async function firefoxPdf(page, outPath, timeoutMs = 30000) {
  await page.evaluate(() => window.print());
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    if (existsSync(outPath)) {
      const buf = readFileSync(outPath);
      // The file appears as soon as printing starts and is appended to as
      // pages are laid out, so "it exists" is not "it is finished". A PDF ends
      // with %%EOF; waiting for that is the only reliable signal available.
      if (buf.length > 0 && buf.subarray(-64).toString("latin1").includes("%%EOF")) return buf;
      last = buf.length;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Firefox produced no complete PDF at ${outPath}` +
      (last === null ? " (file never appeared)" : ` (stalled at ${last} bytes)`),
  );
}

/**
 * Undo the fix at runtime, to prove the tests would have caught the bug.
 *
 * Removes the printable document and lets the viewer's own layout be printed,
 * which is exactly the situation this change replaced.
 */
export const undoFix = () => {
  document.querySelector(".printout-shell")?.remove();
  const style = document.createElement("style");
  style.textContent =
    "@media print{ .topbar{display:flex!important} .viewer{display:grid!important} }";
  document.head.appendChild(style);
};
