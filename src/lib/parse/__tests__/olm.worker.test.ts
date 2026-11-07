/**
 * The .olm parser, run in a worker thread with no DOM globals (MAC-513).
 *
 * The unit tests in olm.test.ts call the parser in-process; these run it the
 * way production does, off the main thread, where DOMParser, document and
 * window do not exist. The harness asserts that before it parses anything, so
 * a test environment that grows a DOM fails here rather than passing quietly.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs: the worker_threads plumbing, kept out of TypeScript
import { parseInWorker as spawn } from "./parseInWorker.mjs";
// @ts-expect-error -- plain .mjs generators shared with the print suite and the Mac app
import * as fx from "../../../../tests/print/formatFixtures.mjs";

type Addr = { name?: string; email: string };
interface WorkerMessage {
  subject: string;
  from?: Addr;
  to: Addr[];
  cc: Addr[];
  date: string | null;
  folderPath: string[];
  html?: string;
  text?: string;
  attachments: Array<{ filename: string; mimeType: string; inline: boolean; content: Uint8Array }>;
}

interface WorkerResult {
  globals: Record<string, string>;
  ok: boolean;
  error?: string;
  archive?: {
    format: string;
    warnings: string[];
    messages: WorkerMessage[];
  };
}

const parseInWorker = (bytes: Uint8Array, name: string): Promise<WorkerResult> => spawn(bytes, name);

describe(".olm in a DOM-free worker", () => {
  it("has no DOM to lean on", async () => {
    const r = await parseInWorker(fx.olm(), "fixture.olm");
    expect(r.globals).toEqual({ DOMParser: "undefined", document: "undefined", window: "undefined" });
  });

  it("opens the print-suite .olm and reads its message", async () => {
    const r = await parseInWorker(fx.olm(), "fixture.olm");
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.archive!.messages.map((m) => m.subject)).toEqual(["An .olm message"]);
    expect(r.archive!.messages[0].html).toContain("OLM-END-MARKER");
    expect(r.archive!.messages[0].from).toEqual({ name: "Adjuster", email: "adjuster@fixture.invalid" });
  });

  it("opens an Outlook 2016+ layout: folders, fields, inline image and attachments", async () => {
    const r = await parseInWorker(fx.olmOutlook(), "Outlook for Mac Archive.olm");
    expect(r.error).toBeUndefined();
    const a = r.archive!;
    expect(a.warnings).toEqual([]);
    // Two messages: the contacts, the categories and the attached .xml are not mail.
    expect(a.messages.map((m) => [m.subject, m.folderPath])).toEqual([
      ["Claim 4471 — surveyor's report", ["Inbox"]],
      ["Re: Claim 4471", ["Inbox", "Claims"]],
    ]);
    const m = r.archive!.messages[0] as WorkerMessage;
    expect(m.from).toEqual({ name: "Adjuster & Co", email: "adjuster@fixture.invalid" });
    expect(m.to).toEqual([{ name: "Counsel", email: "counsel@fixture.invalid" }]);
    expect(m.cc).toEqual([{ name: "Broker", email: "broker@fixture.invalid" }]);
    expect(m.date).not.toBeNull();
    expect(m.html).toContain('<img src="cid:logo@fixture.invalid"');
    expect(m.html).toContain("OLM-OUTLOOK-END-MARKER");
    expect(m.text).toContain("OLM-OUTLOOK-END-MARKER");
    expect(m.attachments.map((x) => [x.filename, x.mimeType, x.inline, x.content.length > 0])).toEqual([
      ["logo.png", "image/png", true, true],
      ["survey-schedule.pdf", "application/pdf", false, true],
      ["readings.xml", "text/xml", false, true],
    ]);
    expect(new TextDecoder().decode(m.attachments[1].content)).toMatch(/^%PDF-1\.4/);
  });

  // Each must end in one error -- one row in the "Couldn't open" list -- and
  // promptly: parseInWorker fails the test if the worker is still going at 10s.
  const broken: Array<[string, () => Uint8Array, RegExp]> = [
    ["a truncated .olm", () => fx.olmTruncated(), /incomplete or damaged \(the archive's index is missing/],
    ["a malformed .olm", () => fx.olmMalformed(), /None of the 1 message file in this \.olm could be read.*Malformed XML/],
    ["a file named .olm that is not a ZIP", () => new TextEncoder().encode("not an archive at all, just text"), /incomplete or damaged/],
  ];
  for (const [what, build, message] of broken) {
    it(`reports ${what} as one error, without hanging`, async () => {
      const r = await parseInWorker(build(), "broken.olm");
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(message);
    });
  }
});
