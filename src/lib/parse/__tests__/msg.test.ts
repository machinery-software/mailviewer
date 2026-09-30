import { describe, expect, it } from "vitest";
import {
  PT,
  codepageToLabel,
  decodeGuid,
  filetimeToDate,
  formatTag,
  isMultiValued,
  baseType,
  parseMsg,
  parseSubstgName,
  parseTransportHeaders,
  readFiletime,
  readPropertyBag,
} from "../msg.ts";
import { parseCfb } from "../cfb.ts";
import { buildCfb, storage, stream, type BuildNode } from "./cfbBuilder.ts";

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// .msg fixture helpers -- real structures, not hand-waved blobs
// ---------------------------------------------------------------------------

const utf16 = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), true);
  return out;
};

const tagName = (id: number, type: number) => `__substg1.0_${formatTag(id, type)}`;

/** A PtypString (unicode) property stream. */
const strProp = (id: number, value: string): BuildNode =>
  stream(tagName(id, PT.STRING), utf16(value));

/** A PtypString8 property stream, in whatever bytes the caller supplies. */
const str8Prop = (id: number, bytes: Uint8Array): BuildNode =>
  stream(tagName(id, PT.STRING8), bytes);

/** A PtypBinary property stream. */
const binProp = (id: number, bytes: Uint8Array): BuildNode =>
  stream(tagName(id, PT.BINARY), bytes);

interface FixedProp {
  id: number;
  type: number;
  /** Exactly 8 bytes: the inline value slot of a property record. */
  data: Uint8Array;
}

const int32 = (id: number, v: number): FixedProp => {
  const data = new Uint8Array(8);
  new DataView(data.buffer).setInt32(0, v, true);
  return { id, type: PT.INT32, data };
};

const bool = (id: number, v: boolean): FixedProp => {
  const data = new Uint8Array(8);
  data[0] = v ? 1 : 0;
  return { id, type: PT.BOOLEAN, data };
};

const time = (id: number, ticks: bigint): FixedProp => {
  const data = new Uint8Array(8);
  new DataView(data.buffer).setBigUint64(0, ticks, true);
  return { id, type: PT.TIME, data };
};

/** `__properties_version1.0`: a header, then 16 bytes per fixed-size property. */
const propsStream = (headerSize: number, props: FixedProp[]): BuildNode => {
  const out = new Uint8Array(headerSize + props.length * 16);
  const dv = new DataView(out.buffer);
  props.forEach((p, i) => {
    const off = headerSize + i * 16;
    dv.setUint32(off, ((p.id << 16) >>> 0) | p.type, true);
    dv.setUint32(off + 4, 0, true); // flags
    out.set(p.data, off + 8);
  });
  return stream("__properties_version1.0", out);
};

const PROPS_TOPLEVEL = 32;
const PROPS_EMBEDDED = 24;
const PROPS_SUB = 8;

/** 2021-01-01T00:00:00Z as a FILETIME. */
const FT_2021 = 132539328000000000n;

// ---------------------------------------------------------------------------

describe("property tag names", () => {
  it("decodes a plain substg name", () => {
    expect(parseSubstgName("__substg1.0_0037001F")).toEqual({ id: 0x0037, type: 0x001f });
    expect(parseSubstgName("__substg1.0_10130102")).toEqual({ id: 0x1013, type: 0x0102 });
  });

  it("decodes a multi-valued element name", () => {
    expect(parseSubstgName("__substg1.0_1013101F-00000002")).toEqual({
      id: 0x1013,
      type: 0x101f,
      index: 2,
    });
  });

  it("accepts lowercase hex, which some writers emit", () => {
    expect(parseSubstgName("__substg1.0_0037001f")).toEqual({ id: 0x0037, type: 0x001f });
  });

  it("rejects names that are not property streams", () => {
    expect(parseSubstgName("__properties_version1.0")).toBeNull();
    expect(parseSubstgName("__recip_version1.0_#00000000")).toBeNull();
    expect(parseSubstgName("__substg1.0_ZZZZZZZZ")).toBeNull();
    expect(parseSubstgName("__substg1.0_0037")).toBeNull();
    expect(parseSubstgName("__substg1.0_0037001F-XYZ")).toBeNull();
  });

  it("round-trips through formatTag", () => {
    expect(formatTag(0x0037, 0x001f)).toBe("0037001F");
    expect(formatTag(0x3701, 0x0102)).toBe("37010102");
    expect(parseSubstgName(`__substg1.0_${formatTag(0x0c1f, 0x001e)}`)).toEqual({
      id: 0x0c1f,
      type: 0x001e,
    });
  });

  it("identifies multi-valued types and strips the flag", () => {
    expect(isMultiValued(0x101f)).toBe(true);
    expect(isMultiValued(0x001f)).toBe(false);
    expect(baseType(0x101f)).toBe(0x001f);
    expect(baseType(0x1102)).toBe(0x0102);
  });
});

describe("FILETIME conversion", () => {
  it("maps the FILETIME epoch offset to the Unix epoch", () => {
    // 11644473600 seconds between 1601-01-01 and 1970-01-01, in 100ns ticks.
    expect(filetimeToDate(116444736000000000n)?.toISOString()).toBe(
      "1970-01-01T00:00:00.000Z",
    );
  });

  it("converts a real timestamp", () => {
    expect(filetimeToDate(FT_2021)?.toISOString()).toBe("2021-01-01T00:00:00.000Z");
  });

  it("keeps sub-second precision", () => {
    // +1.5 seconds = 15,000,000 ticks.
    expect(filetimeToDate(116444736000000000n + 15000000n)?.toISOString()).toBe(
      "1970-01-01T00:00:01.500Z",
    );
  });

  it("treats zero and negatives as unset", () => {
    expect(filetimeToDate(0n)).toBeNull();
    expect(filetimeToDate(-1n)).toBeNull();
  });

  it("still produces a Date for the largest FILETIME a uint64 can hold", () => {
    // 2^64-1 ticks is only ~1.8e15 ms past 1601, comfortably inside Date's
    // +/-8.64e15 ms range -- so no well-formed FILETIME can overflow. The
    // guard below exists for callers that hand us a bigint from elsewhere.
    expect(filetimeToDate(0xffffffffffffffffn)).toBeInstanceOf(Date);
  });

  it("rejects a bigint outside the range a Date can hold", () => {
    expect(filetimeToDate(10n ** 25n)).toBeNull();
  });

  it("reads a little-endian FILETIME out of a buffer", () => {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, FT_2021, true);
    expect(readFiletime(buf)?.toISOString()).toBe("2021-01-01T00:00:00.000Z");
    expect(readFiletime(new Uint8Array(4))).toBeNull(); // too short
  });
});

describe("codepage mapping", () => {
  it("defaults to windows-1252", () => {
    expect(codepageToLabel(undefined)).toBe("windows-1252");
    expect(codepageToLabel(0)).toBe("windows-1252");
    expect(codepageToLabel(999999)).toBe("windows-1252");
  });

  it("maps the codepages Outlook actually emits", () => {
    expect(codepageToLabel(1252)).toBe("windows-1252");
    expect(codepageToLabel(65001)).toBe("utf-8");
    expect(codepageToLabel(1251)).toBe("windows-1251");
    expect(codepageToLabel(932)).toBe("shift_jis");
  });
});

describe("decodeGuid", () => {
  it("renders the mixed-endian form", () => {
    const b = new Uint8Array([
      0x04, 0x03, 0x02, 0x01, 0x06, 0x05, 0x08, 0x07, 0x09, 0x0a, 0x0b, 0x0c,
      0x0d, 0x0e, 0x0f, 0x10,
    ]);
    expect(decodeGuid(b)).toBe("{01020304-0506-0708-090A-0B0C0D0E0F10}");
  });
});

describe("parseTransportHeaders", () => {
  it("preserves order and duplicates", () => {
    const raw = [
      "Received: from a.example",
      "Received: from b.example",
      "Subject: Hi",
      "Received: from c.example",
    ].join("\r\n");
    expect(parseTransportHeaders(raw)).toEqual([
      { key: "Received", value: "from a.example" },
      { key: "Received", value: "from b.example" },
      { key: "Subject", value: "Hi" },
      { key: "Received", value: "from c.example" },
    ]);
  });

  it("unfolds continuation lines", () => {
    const raw =
      "Received: from mail.example.com (mail.example.com [10.0.0.1])\r\n" +
      "\tby mx.example.net with ESMTP id abc123;\r\n" +
      " Fri, 1 Jan 2021 00:00:00 +0000\r\n" +
      "Subject: Folded";
    const headers = parseTransportHeaders(raw);
    expect(headers).toHaveLength(2);
    expect(headers[0].key).toBe("Received");
    expect(headers[0].value).toBe(
      "from mail.example.com (mail.example.com [10.0.0.1]) by mx.example.net with ESMTP id abc123; Fri, 1 Jan 2021 00:00:00 +0000",
    );
    expect(headers[1]).toEqual({ key: "Subject", value: "Folded" });
  });

  it("stops at the blank line that ends the header block", () => {
    const raw = "Subject: Hi\r\n\r\nThis: is body text, not a header";
    expect(parseTransportHeaders(raw)).toEqual([{ key: "Subject", value: "Hi" }]);
  });

  it("copes with bare LF and with junk lines", () => {
    const raw = "Subject: Hi\nnot-a-header-line\nTo: someone@example.com";
    expect(parseTransportHeaders(raw)).toEqual([
      { key: "Subject", value: "Hi" },
      { key: "To", value: "someone@example.com" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a .msg assembled from real CFB structures
// ---------------------------------------------------------------------------

describe("parseMsg", () => {
  it("rejects a file that is not a compound file", () => {
    return expect(parseMsg(enc.encode("From: nope\r\n\r\nhi"), "x.msg")).rejects.toThrow(
      /compound file/i,
    );
  });

  it("parses a full message: headers, addresses, bodies, recipients, attachments", async () => {
    const headerBlock =
      "Received: from mx1.example.com\r\n" +
      "Received: from mx2.example.com\r\n" +
      "Message-ID: <abc@example.com>\r\n" +
      "Reply-To: Support <support@example.com>\r\n" +
      "Subject: Quarterly report\r\n";

    const attachData = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const bytes = buildCfb([
      strProp(0x0037, "Quarterly report"),
      strProp(0x007d, headerBlock),
      strProp(0x0c1a, "Alice Sender"),
      strProp(0x0c1f, "alice@example.com"),
      strProp(0x1000, "The plain text body."),
      strProp(0x1035, "<abc@example.com>"),
      strProp(0x1039, "<r1@example.com> <r2@example.com>"),
      binProp(0x1013, enc.encode("<html><body>Hi <img src=\"cid:img1\"></body></html>")),
      propsStream(PROPS_TOPLEVEL, [
        time(0x0039, FT_2021), // ClientSubmitTime
        int32(0x0e07, 0x0001), // MessageFlags: read
        int32(0x3fde, 65001), // InternetCodepage: utf-8
      ]),

      storage("__recip_version1.0_#00000000", [
        strProp(0x3001, "Bob Recipient"),
        strProp(0x3003, "bob@example.com"),
        strProp(0x3002, "SMTP"),
        propsStream(PROPS_SUB, [int32(0x0c15, 1)]), // RecipientType: To
      ]),
      storage("__recip_version1.0_#00000001", [
        strProp(0x3001, "Carol Copied"),
        strProp(0x3003, "carol@example.com"),
        propsStream(PROPS_SUB, [int32(0x0c15, 2)]), // Cc
      ]),
      storage("__recip_version1.0_#00000002", [
        strProp(0x3003, "dan@example.com"),
        propsStream(PROPS_SUB, [int32(0x0c15, 3)]), // Bcc
      ]),

      storage("__attach_version1.0_#00000000", [
        strProp(0x3707, "report.pdf"),
        strProp(0x370e, "application/pdf"),
        binProp(0x3701, attachData),
        propsStream(PROPS_SUB, [int32(0x3705, 1)]), // AttachMethod: by value
      ]),
      storage("__attach_version1.0_#00000001", [
        strProp(0x3704, "img1.png"),
        strProp(0x3712, "img1"), // AttachContentId -> inline
        binProp(0x3701, imageData),
        propsStream(PROPS_SUB, [int32(0x3705, 1), int32(0x3714, 0x04)]),
      ]),
    ]);

    const archive = await parseMsg(bytes, "report.msg");
    expect(archive.warnings).toEqual([]);
    expect(archive.format).toBe("msg");
    expect(archive.sourceName).toBe("report.msg");
    expect(archive.messages).toHaveLength(1);
    expect(archive.root.name).toBe("report");
    expect(archive.root.messageIds).toEqual(["msg-0"]);

    const m = archive.messages[0];
    expect(m.subject).toBe("Quarterly report");
    expect(m.from).toEqual({ name: "Alice Sender", email: "alice@example.com" });
    expect(m.date?.toISOString()).toBe("2021-01-01T00:00:00.000Z");
    expect(m.messageId).toBe("<abc@example.com>");
    expect(m.references).toEqual(["<r1@example.com>", "<r2@example.com>"]);
    expect(m.text).toBe("The plain text body.");
    expect(m.html).toContain("<img src=\"cid:img1\">");
    expect(m.folderPath).toEqual(["report"]);
    expect(m.raw).toBe(bytes);

    // Headers keep their order and their duplicates.
    expect(m.headers.map((h) => h.key)).toEqual([
      "Received",
      "Received",
      "Message-ID",
      "Reply-To",
      "Subject",
    ]);
    expect(m.headers[0].value).toBe("from mx1.example.com");
    expect(m.headers[1].value).toBe("from mx2.example.com");

    expect(m.replyTo).toEqual([{ name: "Support", email: "support@example.com" }]);
    expect(m.to).toEqual([{ name: "Bob Recipient", email: "bob@example.com" }]);
    expect(m.cc).toEqual([{ name: "Carol Copied", email: "carol@example.com" }]);
    expect(m.bcc).toEqual([{ email: "dan@example.com" }]);

    expect(m.flags.read).toBe(true);
    expect(m.flags.draft).toBe(false);
    expect(m.flags.hasAttachments).toBe(true);

    expect(m.attachments).toHaveLength(2);
    const [pdf, png] = m.attachments;
    expect(pdf.filename).toBe("report.pdf");
    expect(pdf.mimeType).toBe("application/pdf");
    expect(pdf.size).toBe(4);
    expect(pdf.content).toEqual(attachData);
    expect(pdf.inline).toBe(false);
    expect(png.filename).toBe("img1.png");
    expect(png.contentId).toBe("img1");
    expect(png.inline).toBe(true);
    expect(png.mimeType).toBe("image/png"); // guessed from the extension
  });

  it("falls back to SentRepresenting when there is no Sender", async () => {
    const bytes = buildCfb([
      strProp(0x0037, "On behalf of"),
      strProp(0x0042, "Dana Delegate"),
      strProp(0x0065, "dana@example.com"),
      propsStream(PROPS_TOPLEVEL, []),
    ]);
    const m = (await parseMsg(bytes, "x.msg")).messages[0];
    expect(m.from).toEqual({ name: "Dana Delegate", email: "dana@example.com" });
    expect(m.sender).toBeUndefined();
  });

  it("prefers the SMTP address over an Exchange X.500 DN", async () => {
    const bytes = buildCfb([
      strProp(0x0c1a, "Eve Exchange"),
      strProp(0x0c1e, "EX"),
      strProp(0x0c1f, "/O=CONTOSO/OU=EXCHANGE/CN=RECIPIENTS/CN=EVE"),
      strProp(0x5d01, "eve@contoso.com"), // PidTagSenderSmtpAddress
      propsStream(PROPS_TOPLEVEL, []),
    ]);
    const m = (await parseMsg(bytes, "x.msg")).messages[0];
    expect(m.from).toEqual({ name: "Eve Exchange", email: "eve@contoso.com" });
  });

  it("attributes an on-behalf-of message to the person it is from, not the submitter", async () => {
    // Assistant sends on behalf of Boss. Outlook shows "Assistant on behalf of
    // Boss"; RFC 5322 writes `From: Boss` / `Sender: Assistant`. The message is
    // *from* Boss -- attributing it to the assistant would misattribute the
    // authorship of every delegated message in a mailbox.
    const bytes = buildCfb([
      strProp(0x0c1a, "Assistant"), // PidTagSenderName        -- who submitted it
      strProp(0x0c1f, "assistant@example.com"),
      strProp(0x0042, "Boss"), // PidTagSentRepresentingName   -- who it is from
      strProp(0x0065, "boss@example.com"),
      propsStream(PROPS_TOPLEVEL, []),
    ]);
    const m = (await parseMsg(bytes, "x.msg")).messages[0];
    expect(m.from).toEqual({ name: "Boss", email: "boss@example.com" });
    expect(m.sender).toEqual({ name: "Assistant", email: "assistant@example.com" });
  });

  it("leaves `sender` unset when the submitter and the author are the same person", async () => {
    const bytes = buildCfb([
      strProp(0x0c1a, "Solo"),
      strProp(0x0c1f, "solo@example.com"),
      strProp(0x0042, "Solo"),
      strProp(0x0065, "solo@example.com"),
      propsStream(PROPS_TOPLEVEL, []),
    ]);
    const m = (await parseMsg(bytes, "x.msg")).messages[0];
    expect(m.from).toEqual({ name: "Solo", email: "solo@example.com" });
    // No delegation happened, so there is no second party to surface.
    expect(m.sender).toBeUndefined();
  });

  it("decodes PtypString8 using the message codepage", async () => {
    // windows-1251: 0xCF 0xF0 0xE8 0xE2 0xE5 0xF2 == "Привет"
    const cyrillic = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    const bytes = buildCfb([
      str8Prop(0x0037, cyrillic),
      propsStream(PROPS_TOPLEVEL, [int32(0x3fde, 1251)]),
    ]);
    const m = (await parseMsg(bytes, "x.msg")).messages[0];
    expect(m.subject).toBe("Привет");
  });

  it("defaults an ANSI string to windows-1252 when no codepage is declared", async () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café"
    const bytes = buildCfb([
      str8Prop(0x0037, latin1),
      propsStream(PROPS_TOPLEVEL, []),
    ]);
    const m = (await parseMsg(bytes, "x.msg")).messages[0];
    expect(m.subject).toBe("café");
  });

  it("falls back to MessageDeliveryTime when there is no submit time", async () => {
    const bytes = buildCfb([
      strProp(0x0037, "Delivered"),
      propsStream(PROPS_TOPLEVEL, [time(0x0e06, FT_2021)]),
    ]);
    const m = (await parseMsg(bytes, "x.msg")).messages[0];
    expect(m.date?.toISOString()).toBe("2021-01-01T00:00:00.000Z");
  });

  it("leaves the date null when the message genuinely has none", async () => {
    const bytes = buildCfb([strProp(0x0037, "No date"), propsStream(PROPS_TOPLEVEL, [])]);
    expect((await parseMsg(bytes, "x.msg")).messages[0].date).toBeNull();
  });

  it("recovers an HTML body from compressed RTF when there is no HTML property", async () => {
    // Uncompressed ("MELA") payload: the LZFu layer is tested separately, and
    // using the stored form here keeps this test about the RTF path.
    const rtf = enc.encode(
      "{\\rtf1\\ansi\\fromhtml1{\\*\\htmltag64 <p>}Recovered{\\*\\htmltag68 </p>}}",
    );
    const compressed = new Uint8Array(16 + rtf.length);
    const dv = new DataView(compressed.buffer);
    dv.setUint32(0, 12 + rtf.length, true);
    dv.setUint32(4, rtf.length, true);
    dv.setUint32(8, 0x414c454d, true); // "MELA"
    compressed.set(rtf, 16);

    const bytes = buildCfb([
      strProp(0x0037, "RTF only"),
      binProp(0x1009, compressed),
      propsStream(PROPS_TOPLEVEL, []),
    ]);
    const m = (await parseMsg(bytes, "x.msg")).messages[0];
    expect(m.html).toBe("<p>Recovered</p>");
    expect(m.text).toBe("Recovered");
  });

  it("does not let RTF override an HTML body that is already present", async () => {
    const rtf = enc.encode("{\\rtf1\\ansi\\fromhtml1{\\*\\htmltag64 <p>}From RTF{\\*\\htmltag68 </p>}}");
    const compressed = new Uint8Array(16 + rtf.length);
    const dv = new DataView(compressed.buffer);
    dv.setUint32(0, 12 + rtf.length, true);
    dv.setUint32(4, rtf.length, true);
    dv.setUint32(8, 0x414c454d, true);
    compressed.set(rtf, 16);

    const bytes = buildCfb([
      binProp(0x1013, enc.encode("<p>From HTML</p>")),
      binProp(0x1009, compressed),
      propsStream(PROPS_TOPLEVEL, []),
    ]);
    const m = (await parseMsg(bytes, "x.msg")).messages[0];
    expect(m.html).toBe("<p>From HTML</p>");
  });

  it("recurses into an embedded message", async () => {
    const bytes = buildCfb([
      strProp(0x0037, "Outer"),
      strProp(0x1000, "See attached."),
      propsStream(PROPS_TOPLEVEL, []),
      storage("__attach_version1.0_#00000000", [
        strProp(0x3707, "forwarded.msg"),
        propsStream(PROPS_SUB, [int32(0x3705, 5)]), // AttachMethod: embedded
        storage("__substg1.0_3701000D", [
          strProp(0x0037, "Inner"),
          strProp(0x0c1a, "Inner Sender"),
          strProp(0x0c1f, "inner@example.com"),
          strProp(0x1000, "The inner body."),
          propsStream(PROPS_EMBEDDED, [time(0x0039, FT_2021)]),
        ]),
      ]),
    ]);

    const archive = await parseMsg(bytes, "outer.msg");
    expect(archive.warnings).toEqual([]);
    expect(archive.messages).toHaveLength(2);

    const outer = archive.messages[0];
    expect(outer.subject).toBe("Outer");
    expect(outer.attachments).toHaveLength(1);
    expect(outer.attachments[0].mimeType).toBe("message/rfc822");
    expect(outer.attachments[0].filename).toBe("forwarded.msg");
    // The embedded message has no original bytes to hand back, so it is
    // rendered to RFC 822 for download.
    const eml = new TextDecoder().decode(outer.attachments[0].content);
    expect(eml).toContain("Subject: Inner");
    expect(eml).toContain("The inner body.");

    const inner = archive.messages[1];
    expect(inner.subject).toBe("Inner");
    expect(inner.from).toEqual({ name: "Inner Sender", email: "inner@example.com" });
    expect(inner.text).toBe("The inner body.");
    expect(inner.date?.toISOString()).toBe("2021-01-01T00:00:00.000Z");
    // Both messages are reachable from the single synthetic root folder.
    expect(archive.root.messageIds).toEqual([outer.id, inner.id]);
  });

  it("reads a boolean fixed property", async () => {
    const bytes = buildCfb([
      strProp(0x0037, "Flagged"),
      propsStream(PROPS_TOPLEVEL, [
        int32(0x1090, 2), // FlagStatus: flagged
        int32(0x0e07, 0x0008), // MessageFlags: unsent -> draft
        bool(0x0e1b, true),
      ]),
    ]);
    const m = (await parseMsg(bytes, "x.msg")).messages[0];
    expect(m.flags.flagged).toBe(true);
    expect(m.flags.draft).toBe(true);
  });
});

describe("parseMsg: robustness", () => {
  it("warns and carries on when an attachment has no data", async () => {
    const bytes = buildCfb([
      strProp(0x0037, "Broken attachment"),
      propsStream(PROPS_TOPLEVEL, []),
      storage("__attach_version1.0_#00000000", [
        strProp(0x3707, "ghost.pdf"),
        propsStream(PROPS_SUB, [int32(0x3705, 1)]),
        // ...but no 0x3701 data stream.
      ]),
    ]);
    const archive = await parseMsg(bytes, "x.msg");
    expect(archive.messages[0].subject).toBe("Broken attachment");
    expect(archive.messages[0].attachments).toHaveLength(0);
    expect(archive.messages[0].flags.hasAttachments).toBe(false);
    expect(archive.warnings.join(" ")).toMatch(/ghost\.pdf.*no data/);
  });

  it("warns and carries on when compressed RTF is corrupt", async () => {
    const bytes = buildCfb([
      strProp(0x0037, "Bad RTF"),
      strProp(0x1000, "Plain text survives."),
      binProp(0x1009, new Uint8Array([1, 2, 3, 4, 5])), // too short for a header
      propsStream(PROPS_TOPLEVEL, []),
    ]);
    const archive = await parseMsg(bytes, "x.msg");
    expect(archive.messages[0].text).toBe("Plain text survives.");
    expect(archive.warnings.join(" ")).toMatch(/RTF/i);
  });

  it("warns when an embedded message storage is missing", async () => {
    const bytes = buildCfb([
      strProp(0x0037, "Lying attachment"),
      propsStream(PROPS_TOPLEVEL, []),
      storage("__attach_version1.0_#00000000", [
        propsStream(PROPS_SUB, [int32(0x3705, 5)]), // claims embedded...
      ]),
    ]);
    const archive = await parseMsg(bytes, "x.msg");
    expect(archive.messages).toHaveLength(1);
    expect(archive.warnings.join(" ")).toMatch(/embedded message/i);
  });

  it("parses a message with no properties at all", async () => {
    const archive = await parseMsg(buildCfb([]), "empty.msg");
    const m = archive.messages[0];
    expect(m.subject).toBe("");
    expect(m.from).toBeUndefined();
    expect(m.to).toEqual([]);
    expect(m.date).toBeNull();
    expect(m.attachments).toEqual([]);
    expect(m.headers).toEqual([]);
  });

  it("reports progress and finishes at fraction 1", async () => {
    const seen: Array<{ phase: string; fraction: number | null }> = [];
    await parseMsg(buildCfb([strProp(0x0037, "P")]), "p.msg", (p) =>
      seen.push({ phase: p.phase, fraction: p.fraction }),
    );
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1].fraction).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Multi-valued property elements
// ---------------------------------------------------------------------------

describe("parseMsg: multi-valued property elements", () => {
  /** One element stream of a multi-valued string property: `...101F-0000000N`. */
  const mvElement = (id: number, index: number, value: string): BuildNode =>
    stream(
      `${tagName(id, PT.MV_FLAG | PT.STRING)}-${index.toString(16).toUpperCase().padStart(8, "0")}`,
      utf16(value),
    );

  it("is not slowed down by an element that claims index 0xFFFFFFFE", async () => {
    // A 3 KB file. The element's index comes straight from its stream name, and
    // it used to be stored at that index of an array that was then walked slot
    // by slot: four billion iterations for one element, over a minute in which
    // the parse worker (and anything else running these parsers) is stuck.
    const bytes = buildCfb([
      strProp(0x0037, "Sparse multi-valued property"),
      strProp(0x1000, "The body is still readable."),
      mvElement(0x8000, 0xfffffffe, "x"),
    ]);
    expect(bytes.length).toBeLessThan(4096);

    const started = performance.now();
    const archive = await parseMsg(bytes, "sparse.msg");
    const elapsedMs = performance.now() - started;

    expect(archive.messages[0].subject).toBe("Sparse multi-valued property");
    expect(archive.messages[0].text).toBe("The body is still readable.");
    // Measured cost is the number of streams in the file, not the largest
    // index any of them names. A second is three orders of magnitude of slack.
    expect(elapsedMs).toBeLessThan(1000);
    // The timeout is long on purpose: if the loop ever comes back, this should
    // fail on the assertion above, saying how long it took, rather than on a
    // bare "test timed out".
  }, 600_000);

  it("keeps elements in index order and skips gaps, whatever order the streams are in", () => {
    const cfb = parseCfb(
      buildCfb([
        mvElement(0x8000, 2, "two"),
        mvElement(0x8000, 0, "zero"),
        mvElement(0x8001, 0xfffffffe, "far"),
        mvElement(0x8001, 1, "near"),
        mvElement(0x8002, 0, "only"),
      ]),
    );
    const bag = readPropertyBag(cfb, cfb.root, { headerSize: 32, warn: () => {} });
    expect(bag.get(0x8000)?.value).toEqual(["zero", "two"]);
    expect(bag.get(0x8001)?.value).toEqual(["near", "far"]);
    expect(bag.get(0x8002)?.value).toEqual(["only"]);
  });

  it("decodes a multi-valued property whose only stream is its length table as empty", () => {
    // Outlook writes a bare `...101F` stream (the element-length table) next to
    // the `-0000000N` element streams; with no elements the value is [].
    const cfb = parseCfb(buildCfb([stream(tagName(0x8003, PT.MV_FLAG | PT.STRING), new Uint8Array(4))]));
    const bag = readPropertyBag(cfb, cfb.root, { headerSize: 32, warn: () => {} });
    expect(bag.get(0x8003)?.value).toEqual([]);
  });
});
