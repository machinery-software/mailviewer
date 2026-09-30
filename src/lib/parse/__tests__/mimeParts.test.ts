import { describe, expect, it } from "vitest";
import PostalMime from "postal-mime";
import { parseEml } from "../eml";
import { parseMbox } from "../mbox";
import { MAX_MIME_PARTS, capMimeParts, declaredBoundaries, describeOmittedParts } from "../mimeParts";

const enc = new TextEncoder();
const HEAD = "From: a@example.com\r\nTo: b@example.com\r\nSubject: parts\r\nMIME-Version: 1.0\r\n";

/** A multipart/mixed message of `n` one-line text parts, numbered from 1. */
function manyParts(n: number, contentType = 'Content-Type: multipart/mixed; boundary="bb"', boundary = "bb"): Uint8Array {
  let body = `${contentType}\r\n\r\n`;
  for (let i = 1; i <= n; i++) body += `--${boundary}\r\nContent-Type: text/plain\r\n\r\npart ${i}\r\n`;
  body += `--${boundary}--\r\n`;
  return enc.encode(HEAD + body);
}

describe("MIME part cap", () => {
  it("opens a 20,000-part message quickly, reads the first 1,000 parts, and records what it left out", async () => {
    // 870 KB. postal-mime is quadratic in sibling parts: uncapped, this message
    // holds the parse worker for about seven seconds, and a larger one for as
    // long as its author likes.
    const bytes = manyParts(20_000);

    const started = performance.now();
    const archive = await parseEml(bytes, "many.eml");
    const elapsedMs = performance.now() - started;

    const message = archive.messages[0];
    // Not a warning: nothing is damaged. The message says what was left out.
    expect(archive.warnings).toEqual([]);
    expect(message.omittedParts).toEqual({ total: 20_000, shown: 1000 });
    expect(message.subject).toBe("parts");
    expect(message.text).toContain("part 1\n");
    expect(message.text).toContain("part 1000\n");
    expect(message.text).not.toContain("part 1001");
    // "Download original" must still hand back the whole file.
    expect(message.raw).toBe(bytes);
    expect(elapsedMs).toBeLessThan(2000);
  }, 120_000);

  it("leaves a message at the cap exactly as it is", async () => {
    const bytes = manyParts(MAX_MIME_PARTS);
    expect(capMimeParts(bytes)).toEqual({ bytes, totalParts: 0, omittedParts: 0 });

    const archive = await parseEml(bytes, "at-cap.eml");
    expect(archive.warnings).toEqual([]);
    expect(archive.messages[0].omittedParts).toBeUndefined();
    expect(archive.messages[0].text).toContain(`part ${MAX_MIME_PARTS}\n`);
  });

  it("cuts one part over the cap, at the start of that part's delimiter", () => {
    const bytes = manyParts(MAX_MIME_PARTS + 1);
    const capped = capMimeParts(bytes);
    expect(capped.totalParts).toBe(MAX_MIME_PARTS + 1);
    expect(capped.omittedParts).toBe(1);
    const kept = new TextDecoder().decode(capped.bytes);
    expect(kept.endsWith(`part ${MAX_MIME_PARTS}\r\n`)).toBe(true);
    expect(kept).not.toContain(`part ${MAX_MIME_PARTS + 1}`);
  });

  it("does not mistake dashed lines in a plain-text body for parts", async () => {
    // Signature separators, rules of hyphens and diffs all begin with "--".
    const lines = Array.from({ length: 5000 }, (_, i) => (i % 3 === 0 ? "-- " : i % 3 === 1 ? "----------" : "--- a/file"));
    const bytes = enc.encode(`${HEAD}Content-Type: text/plain\r\n\r\n${lines.join("\r\n")}\r\nEND-OF-BODY\r\n`);

    expect(capMimeParts(bytes).omittedParts).toBe(0);
    const archive = await parseEml(bytes, "dashes.eml");
    expect(archive.warnings).toEqual([]);
    expect(archive.messages[0].text).toContain("END-OF-BODY");
  });

  it("does not count dashed lines inside a part of a real multipart message", async () => {
    const dashes = Array.from({ length: 5000 }, () => "--------").join("\r\n");
    const bytes = enc.encode(
      `${HEAD}Content-Type: multipart/mixed; boundary="bb"\r\n\r\n` +
        `--bb\r\nContent-Type: text/plain\r\n\r\n${dashes}\r\nFIRST-PART-END\r\n` +
        `--bb\r\nContent-Type: text/plain\r\n\r\nSECOND-PART\r\n--bb--\r\n`,
    );
    expect(capMimeParts(bytes).omittedParts).toBe(0);
    const archive = await parseEml(bytes, "dashes-in-part.eml");
    expect(archive.warnings).toEqual([]);
    expect(archive.messages[0].text).toContain("FIRST-PART-END");
    expect(archive.messages[0].text).toContain("SECOND-PART");
  });

  it("counts parts across nested multiparts together", () => {
    // 600 parts in an inner multipart, 600 in the outer one: 1,200 in all.
    let body = 'Content-Type: multipart/mixed; boundary="outer"\r\n\r\n';
    body += '--outer\r\nContent-Type: multipart/mixed; boundary="inner"\r\n\r\n';
    for (let i = 0; i < 599; i++) body += "--inner\r\nContent-Type: text/plain\r\n\r\nx\r\n";
    body += "--inner--\r\n";
    for (let i = 0; i < 600; i++) body += "--outer\r\nContent-Type: text/plain\r\n\r\ny\r\n";
    body += "--outer--\r\n";
    const capped = capMimeParts(enc.encode(HEAD + body));
    expect(capped.totalParts).toBe(1200);
    expect(capped.omittedParts).toBe(200);
  });

  // However a boundary is spelled, if postal-mime honours the spelling then
  // the cap has to see it too -- otherwise the spelling is a way round the cap.
  const spellings: Array<[string, string, string]> = [
    ["quoted", 'Content-Type: multipart/mixed; boundary="bb"', "bb"],
    ["bare", "Content-Type: multipart/mixed; boundary=bb", "bb"],
    ["upper-case parameter name", 'Content-Type: multipart/mixed; BOUNDARY="bb"', "bb"],
    ["folded onto the next line", 'Content-Type: multipart/mixed;\r\n boundary="bb"', "bb"],
    ["with spaces and punctuation", 'Content-Type: multipart/mixed; boundary="=_b b:1/2?"', "=_b b:1/2?"],
    ["RFC 2231 encoded", "Content-Type: multipart/mixed; boundary*=utf-8''b%62", "bb"],
    ["RFC 2231 continued", 'Content-Type: multipart/mixed; boundary*0="b"; boundary*1="b"', "bb"],
    ["after another parameter", 'Content-Type: multipart/mixed; charset=utf-8; boundary="bb"', "bb"],
  ];

  it.each(spellings)("sees a boundary declared %s whenever postal-mime does", async (_label, contentType, boundary) => {
    const small = await new PostalMime().parse(manyParts(3, contentType, boundary));
    const honoured = (small.text ?? "").includes("part 1\n") && (small.text ?? "").includes("part 3\n");

    const capped = capMimeParts(manyParts(MAX_MIME_PARTS + 5, contentType, boundary));
    if (honoured) {
      expect(capped.omittedParts).toBe(5);
    } else {
      // Not a boundary as far as the MIME parser is concerned: there are no
      // parts to be quadratic in, and nothing to cut.
      expect(capped.omittedParts === 0 || capped.omittedParts === 5).toBe(true);
    }
  });

  it("at least the ordinary spellings are honoured, so the test above is not vacuous", async () => {
    for (const [label, contentType, boundary] of spellings.slice(0, 4)) {
      const small = await new PostalMime().parse(manyParts(3, contentType, boundary));
      expect(small.text, label).toContain("part 3\n");
    }
  });

  it("finds every declared boundary in a message", () => {
    const text =
      'Content-Type: multipart/mixed; boundary="a"\r\n\r\n--a\r\n' +
      "Content-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\n" +
      "content-type: multipart/related;\r\n\tBoundary = \"c \\\"q\\\"\"\r\n";
    expect([...declaredBoundaries(text)].sort()).toEqual(["a", "b", 'c "q"']);
  });

  it("reports the capped message in an mbox without losing the others", async () => {
    const big = new TextDecoder().decode(manyParts(MAX_MIME_PARTS + 250));
    const mbox =
      "From a@example.com Thu Jan  1 00:00:00 2026\r\n" + big +
      "\r\nFrom a@example.com Thu Jan  1 00:00:01 2026\r\n" +
      "From: c@example.com\r\nSubject: ordinary\r\n\r\nhello\r\n";
    const archive = await parseMbox(new Blob([mbox]), "two.mbox");
    expect(archive.messages.map((m) => m.subject)).toEqual(["parts", "ordinary"]);
    expect(archive.messages.map((m) => m.omittedParts)).toEqual([{ total: 1250, shown: 1000 }, undefined]);
    expect(archive.warnings).toEqual([]);
  });
});

describe("what the reader is told about a capped message", () => {
  const capped = (subject: string, total = 20_000) => ({ subject, omittedParts: { total, shown: 1000 } });

  it("says nothing when no message is over the limit", () => {
    expect(describeOmittedParts([])).toBeNull();
    expect(describeOmittedParts([{ subject: "fine" }])).toBeNull();
  });

  it("names the message, the limit, how much is shown and how much is not", () => {
    expect(describeOmittedParts([{ subject: "fine" }, capped("Schedule of loss")])).toBe(
      "\u201cSchedule of loss\u201d has 20,000 MIME parts, which exceeds the 1,000-part limit. " +
        "Only the first 1,000 parts are shown; the other 19,000, and any attachments among them, are not.",
    );
  });

  it("copes with a missing or very long subject", () => {
    expect(describeOmittedParts([capped("  ", 1001)])).toBe(
      "A message with no subject has 1,001 MIME parts, which exceeds the 1,000-part limit. " +
        "Only the first 1,000 parts are shown; the other 1, and any attachments among them, are not.",
    );
    const long = describeOmittedParts([capped("x".repeat(200))])!;
    expect(long.startsWith(`\u201c${"x".repeat(60)}\u2026\u201d has 20,000`)).toBe(true);
  });

  it("summarises several messages without listing them all", () => {
    expect(describeOmittedParts(["a", "b", "c", "d", "e"].map((s) => capped(s)))).toBe(
      "5 messages exceed the 1,000-part limit. Only the first 1,000 MIME parts of each are shown; later parts, " +
        "and any attachments among them, are not: \u201ca\u201d, \u201cb\u201d, \u201cc\u201d and 2 more.",
    );
  });

  it("does not use the word the warnings bar uses for damaged input", () => {
    for (const text of [describeOmittedParts([capped("a")])!, describeOmittedParts([capped("a"), capped("b")])!]) {
      expect(text).not.toMatch(/damaged|skipped|problem/i);
    }
  });
});
