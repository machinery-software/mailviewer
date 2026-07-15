import { describe, expect, it } from "vitest";
import { detectFormat } from "../detect";

const enc = (s: string) => new TextEncoder().encode(s);

describe("detectFormat", () => {
  it("identifies a compound file as .msg regardless of its name", () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    // The whole point of sniffing: someone renamed an Outlook message to .eml.
    expect(detectFormat(cfb, "invoice.eml")).toBe("msg");
  });

  it("identifies a bare winmail.dat by its TNEF signature", () => {
    const tnef = new Uint8Array([0x78, 0x9f, 0x3e, 0x22, 0x09, 0x00, 0x01]);
    expect(detectFormat(tnef, "winmail.dat")).toBe("tnef");
    // ...and even when someone has renamed it to something friendlier.
    expect(detectFormat(tnef, "attachment.bin")).toBe("tnef");
  });

  it("distinguishes .pst from .ost only by name, since the headers are identical", () => {
    const pst = enc("!BDN\x00\x00\x00\x00");
    expect(detectFormat(pst, "archive.pst")).toBe("pst");
    expect(detectFormat(pst, "outlook.ost")).toBe("ost");
  });

  it("treats a leading 'From ' separator line as mbox", () => {
    const mbox = enc("From dave@example.com Mon Jan  1 00:00:00 2024\r\nFrom: a@b.c\r\n\r\nhi");
    expect(detectFormat(mbox, "Takeout.mbox")).toBe("mbox");
  });

  it("does not mistake a 'From:' header for an mbox separator", () => {
    // "From:" is a header; "From " is a separator. One character apart, and
    // getting it wrong would shred every .eml we open.
    const eml = enc("From: dave@example.com\r\nSubject: hello\r\n\r\nbody");
    expect(detectFormat(eml, "message.eml")).toBe("eml");
  });

  it("recognises the Apple Mail .emlx byte-count prefix", () => {
    const emlx = enc("1234\nFrom: dave@example.com\r\nSubject: hi\r\n\r\nbody");
    expect(detectFormat(emlx, "1234.emlx")).toBe("emlx");
  });

  it("does not call a plain text file starting with a number .emlx", () => {
    const notEmlx = enc("42\nthis is just a text file, not a message\n");
    expect(detectFormat(notEmlx, "notes.txt")).toBe("eml");
  });
});
