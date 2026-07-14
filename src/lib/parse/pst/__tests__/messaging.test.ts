import { describe, expect, it } from "vitest";
import { parseHeaderBlock, stripSubjectPrefix } from "../messaging.ts";
import { parsePst } from "../index.ts";

/**
 * Builds the control prefix Outlook puts in front of PidTagSubject: the byte
 * 0x01, followed by a byte holding (length of the visible prefix + 1).
 *
 * Constructed with String.fromCharCode rather than pasted in literally --
 * raw control characters in a source file are invisible to the next reader and
 * are easily eaten by editors and formatters.
 */
const ctrl = (prefixLen: number) => String.fromCharCode(0x01) + String.fromCharCode(prefixLen + 1);

describe("stripSubjectPrefix", () => {
  /**
   * Only the two control characters come off. The prefix text itself ("RE: ")
   * is part of the subject a human actually wrote and has to survive --
   * stripping it as well would quietly rewrite the subject line.
   */
  it("removes the control characters but keeps the reply prefix", () => {
    expect(stripSubjectPrefix(`${ctrl(4)}RE: Hello`)).toBe("RE: Hello");
  });

  it("handles a forward prefix", () => {
    expect(stripSubjectPrefix(`${ctrl(4)}FW: Quarterly`)).toBe("FW: Quarterly");
  });

  it("handles the no-prefix marker, where the length byte is 0x01", () => {
    expect(stripSubjectPrefix(`${ctrl(0)}Plain subject`)).toBe("Plain subject");
  });

  it("leaves an ordinary subject alone", () => {
    expect(stripSubjectPrefix("Just a subject")).toBe("Just a subject");
    expect(stripSubjectPrefix("")).toBe("");
  });

  it("does not mangle an un-encoded subject that already reads RE:", () => {
    expect(stripSubjectPrefix("RE: not encoded")).toBe("RE: not encoded");
  });
});

describe("parseHeaderBlock", () => {
  it("splits headers and preserves order and duplicates", () => {
    const raw = ["Received: from a", "Received: from b", "Subject: Hi", "From: x@y.z"].join("\r\n");
    expect(parseHeaderBlock(raw)).toEqual([
      { key: "Received", value: "from a" },
      { key: "Received", value: "from b" },
      { key: "Subject", value: "Hi" },
      { key: "From", value: "x@y.z" },
    ]);
  });

  it("unfolds continuation lines", () => {
    const raw = "Subject: a very\r\n  long subject\r\nFrom: x@y.z";
    expect(parseHeaderBlock(raw)).toEqual([
      { key: "Subject", value: "a very long subject" },
      { key: "From", value: "x@y.z" },
    ]);
  });

  it("stops at the blank line that ends the header block", () => {
    const raw = "Subject: Hi\r\n\r\nThis is the body: not a header";
    expect(parseHeaderBlock(raw)).toEqual([{ key: "Subject", value: "Hi" }]);
  });

  it("ignores lines without a colon", () => {
    expect(parseHeaderBlock("garbage\r\nSubject: Hi")).toEqual([{ key: "Subject", value: "Hi" }]);
  });
});

describe("parsePst magic-byte check", () => {
  // The one thing the entry point promises to fail loudly on.
  it("throws a clear error when the file does not start with !BDN", async () => {
    const notAPst = new Blob([new Uint8Array(2048)]);
    await expect(parsePst(notAPst, "junk.pst")).rejects.toThrow(/!BDN/);
  });

  it("throws when the file is too short to hold a header", async () => {
    await expect(parsePst(new Blob([new Uint8Array(4)]), "tiny.pst")).rejects.toThrow();
  });

  it("names the format in the error when the magic is wrong", async () => {
    const zip = new Blob([Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])]);
    await expect(parsePst(zip, "actually.zip")).rejects.toThrow(/Not a PST\/OST file/);
  });
});
