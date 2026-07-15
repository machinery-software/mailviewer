import { describe, expect, it } from "vitest";
import { declineObsoleteFormat, detectFormat } from "../detect";

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

  it("identifies a compound file named .oft as an Outlook template", () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(detectFormat(cfb, "welcome.oft")).toBe("oft");
    // The identical bytes under any other name are still a plain .msg.
    expect(detectFormat(cfb, "welcome.msg")).toBe("msg");
    expect(detectFormat(cfb, "welcome")).toBe("msg");
  });

  it("identifies a ZIP named .olm as an Outlook for Mac archive", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(detectFormat(zip, "backup.olm")).toBe("olm");
    // A bare ZIP of something else is not an archive we claim to read.
    expect(detectFormat(zip, "photos.zip")).toBe("eml");
  });

  it("identifies an MHTML web archive as mht", () => {
    const mht = enc(
      "From: <Saved by Blink>\r\n" +
        "Subject: Saved page\r\n" +
        "MIME-Version: 1.0\r\n" +
        'Content-Type: multipart/related; boundary="----=_B"\r\n\r\n' +
        "------=_B\r\nContent-Type: text/html\r\n\r\n<html></html>\r\n------=_B--\r\n",
    );
    expect(detectFormat(mht, "page.mht")).toBe("mht");
    expect(detectFormat(mht, "page.mhtml")).toBe("mht");
    // Without the extension it falls back to the ordinary eml path, which still
    // reads the container -- only the Content-Location resolution is skipped.
    expect(detectFormat(mht, "page.eml")).toBe("eml");
  });
});

describe("declineObsoleteFormat", () => {
  const empty = new Uint8Array(0);

  it("declines Lotus Notes .nsf with a message that names the format and a next step", () => {
    const msg = declineObsoleteFormat(empty, "mail.nsf");
    expect(msg).toBeTruthy();
    expect(msg!).toMatch(/\.nsf|Lotus Notes|HCL Notes/i);
    expect(msg!).toMatch(/export|\.eml|\.mbox/i);
  });

  it("declines an .nsf recognised by its header even when renamed", () => {
    const nsf = new Uint8Array([0x1a, 0x00, 0x00, 0x04, 0x00, 0x00]);
    expect(declineObsoleteFormat(nsf, "renamed.bin")).toMatch(/Lotus Notes|HCL Notes/i);
  });

  it("declines Outlook Express .dbx with a helpful message", () => {
    const msg = declineObsoleteFormat(empty, "Inbox.dbx");
    expect(msg).toBeTruthy();
    expect(msg!).toMatch(/\.dbx|Outlook Express/i);
    expect(msg!).toMatch(/\.eml/i);
  });

  it("returns null for a format we actually handle", () => {
    expect(declineObsoleteFormat(enc("From: a@b.c\r\n\r\nhi"), "message.eml")).toBeNull();
  });
});
