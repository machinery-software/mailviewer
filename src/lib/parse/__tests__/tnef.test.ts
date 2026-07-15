import { describe, expect, it } from "vitest";
import { parseEml } from "../eml";
import { PID, PT } from "../msg";
import {
  decodeMapiProps,
  extractTnefAttachments,
  isTnef,
  parseTnef,
  propsById,
  readTnefAttributes,
  tnefChecksum,
} from "../tnef";

// ---------------------------------------------------------------------------
// Builders. Everything below writes real TNEF bytes -- signature, key,
// levelled attributes, correct checksums, 4-byte-aligned MAPI values -- so the
// tests exercise the parser against the format rather than against a mock.
// ---------------------------------------------------------------------------

const TNEF_SIG = [0x78, 0x9f, 0x3e, 0x22];

const LVL_MESSAGE = 1;
const LVL_ATTACHMENT = 2;

const ATT_FROM = 0x8000;
const ATT_SUBJECT = 0x8004;
const ATT_DATE_SENT = 0x8005;
const ATT_MESSAGE_CLASS = 0x8008;
const ATT_BODY = 0x800c;
const ATT_ATTACH_DATA = 0x800f;
const ATT_ATTACH_TITLE = 0x8010;
const ATT_ATTACH_REND_DATA = 0x9002;
const ATT_MSG_PROPS = 0x9003;
const ATT_ATTACHMENT = 0x9005;
const ATT_OEM_CODEPAGE = 0x9007;

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function ascii(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}
/** A NUL-terminated 8-bit string, the way TNEF writes attribute strings. */
function cstr(s: string): number[] {
  return [...ascii(s), 0];
}
/** A NUL-terminated UTF-16LE string, the way MAPI PT_UNICODE values are written. */
function wstr(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(...u16(s.charCodeAt(i)));
  out.push(0, 0);
  return out;
}
function pad4(bytes: number[]): number[] {
  return [...bytes, ...new Array((4 - (bytes.length % 4)) % 4).fill(0)];
}

interface AttrSpec {
  level: number;
  id: number;
  dataType?: number;
  data: number[];
  /** Force a wrong checksum, to prove a bad one does not sink the parse. */
  breakChecksum?: boolean;
}

function attribute(a: AttrSpec): number[] {
  const sum = tnefChecksum(new Uint8Array(a.data));
  const checksum = a.breakChecksum ? (sum + 1) & 0xffff : sum;
  return [
    a.level,
    ...u32((((a.dataType ?? 6) & 0xffff) << 16) | (a.id & 0xffff)),
    ...u32(a.data.length),
    ...a.data,
    ...u16(checksum),
  ];
}

function buildTnef(attrs: AttrSpec[], key = 0x0009): Uint8Array {
  const out: number[] = [...TNEF_SIG, ...u16(key)];
  for (const a of attrs) out.push(...attribute(a));
  return new Uint8Array(out);
}

// --- MAPI property stream --------------------------------------------------

type Named =
  | { guid: number[]; kind: 0; id: number }
  | { guid: number[]; kind: 1; name: string };

interface PropSpec {
  id: number;
  type: number;
  /** One entry per value. Multi-valued props simply have more than one. */
  values: number[][];
  named?: Named;
}

/** PS_PUBLIC_STRINGS, {00020329-0000-0000-C000-000000000046}, mixed-endian. */
const PS_PUBLIC_STRINGS = [
  0x29, 0x03, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
];

function isVariable(type: number): boolean {
  const base = type & ~0x1000;
  return base === PT.STRING || base === PT.STRING8 || base === PT.BINARY || base === PT.OBJECT;
}

function mapiStream(props: PropSpec[]): number[] {
  const out: number[] = [...u32(props.length)];
  for (const p of props) {
    out.push(...u32(((p.id & 0xffff) << 16) | (p.type & 0xffff)));
    if (p.named) {
      out.push(...p.named.guid);
      out.push(...u32(p.named.kind));
      if (p.named.kind === 0) {
        out.push(...u32(p.named.id));
      } else {
        const name = wstr(p.named.name);
        out.push(...u32(name.length));
        out.push(...pad4(name));
      }
    }
    const variable = isVariable(p.type);
    const mv = (p.type & 0x1000) !== 0;
    if (variable || mv) out.push(...u32(p.values.length));
    for (const v of p.values) {
      if (variable) out.push(...u32(v.length));
      out.push(...pad4(v));
    }
  }
  return out;
}

/** An uncompressed ("MELA") PidTagRtfCompressed stream. */
function melaRtf(rtf: string): number[] {
  const raw = ascii(rtf);
  return [
    ...u32(raw.length + 12), // compressedSize: everything after this field
    ...u32(raw.length),
    ...u32(0x414c454d), // "MELA"
    ...u32(0),
    ...raw,
  ];
}

const ENCAPSULATED_HTML =
  "{\\rtf1\\ansi\\ansicpg1252\\fromhtml1{\\*\\htmltag64 <html><body><p>Hello from TNEF</p></body></html>}}";

// ---------------------------------------------------------------------------

describe("isTnef", () => {
  it("accepts the winmail.dat signature", () => {
    expect(isTnef(new Uint8Array([0x78, 0x9f, 0x3e, 0x22, 0x00, 0x00]))).toBe(true);
  });

  it("rejects anything else, including a near miss and a short buffer", () => {
    expect(isTnef(new Uint8Array([0x78, 0x9f, 0x3e, 0x23]))).toBe(false);
    expect(isTnef(new TextEncoder().encode("From: a@b.c\r\n"))).toBe(false);
    expect(isTnef(new Uint8Array([0x78, 0x9f]))).toBe(false);
  });
});

describe("readTnefAttributes", () => {
  it("rejects a non-TNEF buffer with a clear error", () => {
    const notTnef = new TextEncoder().encode("Subject: not a winmail.dat\r\n\r\nhi");
    expect(() => readTnefAttributes(notTnef, () => {})).toThrow(/TNEF/i);
  });

  it("walks levelled attributes and verifies their checksums", () => {
    const bytes = buildTnef([
      { level: LVL_MESSAGE, id: ATT_MESSAGE_CLASS, data: cstr("IPM.Note") },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: [1, 2, 3, 4] },
    ]);
    const warnings: string[] = [];
    const attrs = readTnefAttributes(bytes, (m) => warnings.push(m));

    expect(warnings).toEqual([]);
    expect(attrs).toHaveLength(2);
    expect(attrs[0]).toMatchObject({ level: 1, id: ATT_MESSAGE_CLASS, checksumOk: true });
    expect(attrs[1]).toMatchObject({ level: 2, id: ATT_ATTACH_DATA, checksumOk: true });
    expect(Array.from(attrs[1].data)).toEqual([1, 2, 3, 4]);
  });

  it("warns about a truncated attribute instead of throwing", () => {
    const full = buildTnef([{ level: LVL_MESSAGE, id: ATT_SUBJECT, data: cstr("cut short") }]);
    const truncated = full.subarray(0, full.length - 4);
    const warnings: string[] = [];
    const attrs = readTnefAttributes(truncated, (m) => warnings.push(m));

    expect(attrs).toHaveLength(0);
    expect(warnings.join(" ")).toMatch(/truncated|claims/i);
  });
});

describe("decodeMapiProps", () => {
  it("decodes fixed, string and binary properties with 4-byte alignment", () => {
    const stream = new Uint8Array(
      mapiStream([
        { id: 0x0e07, type: PT.INT32, values: [u32(9)] }, // PidTagMessageFlags
        { id: PID.Subject, type: PT.STRING, values: [wstr("Quarterly report")] },
        { id: 0x0e1b, type: PT.BOOLEAN, values: [u16(1)] }, // 2 bytes + 2 padding
        { id: PID.AttachDataBinary, type: PT.BINARY, values: [[0xde, 0xad, 0xbe]] }, // 3 bytes + 1 pad
        { id: PID.Body, type: PT.STRING, values: [wstr("body")] },
      ]),
    );
    const warnings: string[] = [];
    const props = decodeMapiProps(stream, 1252, (m) => warnings.push(m));

    expect(warnings).toEqual([]);
    expect(props).toHaveLength(5);
    const map = propsById(props);
    expect(map.get(0x0e07)?.value).toBe(9);
    expect(map.get(PID.Subject)?.value).toBe("Quarterly report");
    expect(map.get(0x0e1b)?.value).toBe(true);
    expect(Array.from(map.get(PID.AttachDataBinary)?.value as Uint8Array)).toEqual([
      0xde, 0xad, 0xbe,
    ]);
    // The property after the odd-length binary is only readable if the padding
    // was consumed correctly.
    expect(map.get(PID.Body)?.value).toBe("body");
  });

  it("skips a named property's GUID/kind preamble so later properties stay aligned", () => {
    const stream = new Uint8Array(
      mapiStream([
        {
          // String-kind name: 7 UTF-16 code units + NUL = 16 bytes, no padding.
          id: 0x8041,
          type: PT.STRING,
          values: [wstr("expenses")],
          named: { guid: PS_PUBLIC_STRINGS, kind: 1, name: "x-label" },
        },
        {
          // Numeric-kind name.
          id: 0x8042,
          type: PT.INT32,
          values: [u32(42)],
          named: { guid: PS_PUBLIC_STRINGS, kind: 0, id: 0x8503 },
        },
        // If either preamble were mis-skipped, this last one would be garbage.
        { id: PID.Subject, type: PT.STRING, values: [wstr("still aligned")] },
      ]),
    );
    const warnings: string[] = [];
    const props = decodeMapiProps(stream, 1252, (m) => warnings.push(m));

    expect(warnings).toEqual([]);
    expect(props).toHaveLength(3);
    expect(props[0]).toMatchObject({ id: 0x8041, name: "x-label", value: "expenses" });
    expect(props[0].guid).toMatch(/^\{00020329-/);
    expect(props[1]).toMatchObject({ id: 0x8042, nameId: 0x8503, value: 42 });
    expect(props[2]).toMatchObject({ id: PID.Subject, value: "still aligned" });
  });

  it("handles a string-kind name whose length is not a multiple of four", () => {
    const stream = new Uint8Array(
      mapiStream([
        {
          // "ab" -> 2 code units + NUL = 6 bytes, so 2 bytes of padding follow.
          id: 0x8001,
          type: PT.INT32,
          values: [u32(7)],
          named: { guid: PS_PUBLIC_STRINGS, kind: 1, name: "ab" },
        },
        { id: PID.Subject, type: PT.STRING, values: [wstr("after")] },
      ]),
    );
    const props = decodeMapiProps(stream, 1252, () => {});
    expect(props[0]).toMatchObject({ name: "ab", value: 7 });
    expect(props[1]).toMatchObject({ id: PID.Subject, value: "after" });
  });

  it("decodes a multi-valued string property", () => {
    const stream = new Uint8Array(
      mapiStream([
        { id: 0x1039, type: PT.STRING | PT.MV_FLAG, values: [wstr("one"), wstr("two")] },
        { id: PID.Subject, type: PT.STRING, values: [wstr("tail")] },
      ]),
    );
    const props = decodeMapiProps(stream, 1252, () => {});
    expect(props[0].value).toEqual(["one", "two"]);
    expect(props[1].value).toBe("tail");
  });

  it("warns rather than throws when the stream is truncated mid-value", () => {
    const full = mapiStream([
      { id: PID.Subject, type: PT.STRING, values: [wstr("truncated")] },
    ]);
    const warnings: string[] = [];
    const props = decodeMapiProps(new Uint8Array(full.slice(0, 12)), 1252, (m) =>
      warnings.push(m),
    );
    expect(props.length).toBeLessThanOrEqual(1);
    expect(warnings.join(" ")).toMatch(/ends mid-/);
  });
});

describe("parseTnef", () => {
  const goodFile = () =>
    buildTnef([
      { level: LVL_MESSAGE, id: ATT_OEM_CODEPAGE, data: [...u32(1252), ...u32(0)] },
      { level: LVL_MESSAGE, id: ATT_MESSAGE_CLASS, data: cstr("IPM.Note") },
      { level: LVL_MESSAGE, id: ATT_SUBJECT, data: cstr("Q3 numbers") },
      {
        level: LVL_MESSAGE,
        id: ATT_DATE_SENT,
        data: [...u16(2024), ...u16(3), ...u16(9), ...u16(14), ...u16(30), ...u16(5), ...u16(6)],
      },
      {
        level: LVL_MESSAGE,
        id: ATT_FROM,
        // 8-byte TRP header, then name and address, both NUL-terminated.
        data: [...u16(4), ...u16(0), ...u16(6), ...u16(16), ...cstr("Dana"), ...cstr("dana@example.com")],
      },
      { level: LVL_MESSAGE, id: ATT_BODY, data: cstr("plain text body") },
      {
        level: LVL_MESSAGE,
        id: ATT_MSG_PROPS,
        data: mapiStream([
          { id: PID.RtfCompressed, type: PT.BINARY, values: [melaRtf(ENCAPSULATED_HTML)] },
          { id: PID.DisplayTo, type: PT.STRING, values: [wstr("Sam Recipient")] },
        ]),
      },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: new Array(14).fill(0) },
      // The 8.3-mangled name is all a pre-MAPI reader would get.
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_TITLE, data: cstr("QUART~1.PDF") },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: ascii("%PDF-1.4 fake pdf") },
      {
        level: LVL_ATTACHMENT,
        id: ATT_ATTACHMENT,
        data: mapiStream([
          { id: PID.AttachLongFilename, type: PT.STRING, values: [wstr("Quarterly Report.pdf")] },
          { id: PID.AttachMimeTag, type: PT.STRING, values: [wstr("application/pdf")] },
        ]),
      },
    ]);

  it("round-trips a message, its RTF body and its attachment", async () => {
    const archive = await parseTnef(goodFile(), "winmail.dat");

    expect(archive.format).toBe("tnef");
    expect(archive.warnings).toEqual([]);
    expect(archive.messages).toHaveLength(1);

    const m = archive.messages[0];
    expect(m.subject).toBe("Q3 numbers");
    expect(m.from).toEqual({ name: "Dana", email: "dana@example.com" });
    expect(m.date?.toISOString()).toBe("2024-03-09T14:30:05.000Z");
    expect(m.text).toBe("plain text body");
    // The HTML only exists inside the compressed, encapsulated RTF.
    expect(m.html).toContain("<p>Hello from TNEF</p>");
    expect(m.headers).toContainEqual({ key: "X-TNEF-Message-Class", value: "IPM.Note" });
    expect(m.headers).toContainEqual({ key: "To", value: "Sam Recipient" });

    expect(m.attachments).toHaveLength(1);
    const att = m.attachments[0];
    // PidTagAttachLongFilename beats the mangled attAttachTitle.
    expect(att.filename).toBe("Quarterly Report.pdf");
    expect(att.mimeType).toBe("application/pdf");
    expect(new TextDecoder().decode(att.content)).toBe("%PDF-1.4 fake pdf");
    expect(att.size).toBe(17);
    expect(m.flags.hasAttachments).toBe(true);
  });

  it("falls back to attAttachTitle when there are no MAPI attachment props", () => {
    const bytes = buildTnef([
      { level: LVL_MESSAGE, id: ATT_MESSAGE_CLASS, data: cstr("IPM.Note") },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: new Array(14).fill(0) },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_TITLE, data: cstr("NOTES~1.TXT") },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: ascii("hello") },
    ]);
    const { attachments, warnings } = extractTnefAttachments(bytes);

    expect(warnings).toEqual([]);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe("NOTES~1.TXT");
    expect(attachments[0].mimeType).toBe("text/plain");
  });

  it("separates two attachments on their attAttachRendData boundaries", () => {
    const bytes = buildTnef([
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: new Array(14).fill(0) },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_TITLE, data: cstr("one.txt") },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: ascii("first") },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: new Array(14).fill(0) },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_TITLE, data: cstr("two.txt") },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: ascii("second") },
    ]);
    const { attachments } = extractTnefAttachments(bytes);

    expect(attachments.map((a) => a.filename)).toEqual(["one.txt", "two.txt"]);
    expect(attachments.map((a) => new TextDecoder().decode(a.content))).toEqual([
      "first",
      "second",
    ]);
    expect(new Set(attachments.map((a) => a.id)).size).toBe(2);
  });

  it("records a warning for a bad checksum but still returns the data", async () => {
    const bytes = buildTnef([
      { level: LVL_MESSAGE, id: ATT_SUBJECT, data: cstr("Checksum is wrong"), breakChecksum: true },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: new Array(14).fill(0) },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_TITLE, data: cstr("still-here.txt") },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: ascii("payload") },
    ]);
    const archive = await parseTnef(bytes, "winmail.dat");

    expect(archive.warnings.join(" ")).toMatch(/bad checksum/i);
    // The whole point: a wrong checksum costs a warning, not the message.
    expect(archive.messages[0].subject).toBe("Checksum is wrong");
    expect(archive.messages[0].attachments[0].filename).toBe("still-here.txt");
  });

  it("rejects a buffer that is not TNEF", async () => {
    const notTnef = new TextEncoder().encode("Subject: hello\r\n\r\nnot a winmail.dat");
    await expect(parseTnef(notTnef, "winmail.dat")).rejects.toThrow(/TNEF/i);
    expect(() => extractTnefAttachments(notTnef)).toThrow(/TNEF/i);
  });

  it("keeps going after a malformed attribute rather than losing the message", async () => {
    // A second attribute whose declared length runs off the end of the file.
    const good = Array.from(
      buildTnef([{ level: LVL_MESSAGE, id: ATT_SUBJECT, data: cstr("Survives") }]),
    );
    const bogus = [LVL_MESSAGE, ...u32(0x0006800c), ...u32(0xffff), 1, 2, 3];
    const archive = await parseTnef(new Uint8Array([...good, ...bogus]), "winmail.dat");

    expect(archive.messages[0].subject).toBe("Survives");
    expect(archive.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The case that actually matters: a winmail.dat hanging off a normal .eml.
// ---------------------------------------------------------------------------

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return (b64.match(/.{1,76}/g) ?? []).join("\r\n");
}

function emlWithPart(body: string, contentType: string, filename: string): Uint8Array {
  const eml = [
    "From: Dana <dana@example.com>",
    "To: Sam <sam@example.com>",
    "Subject: Rich mail from Outlook",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="BOUND"',
    "",
    "--BOUND",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "This message is in TNEF format.",
    "",
    "--BOUND",
    `Content-Type: ${contentType}; name="${filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${filename}"`,
    "",
    body,
    "",
    "--BOUND--",
    "",
  ].join("\r\n");
  return new TextEncoder().encode(eml);
}

describe("eml auto-expansion", () => {
  const winmail = () =>
    buildTnef([
      { level: LVL_MESSAGE, id: ATT_MESSAGE_CLASS, data: cstr("IPM.Note") },
      {
        level: LVL_MESSAGE,
        id: ATT_MSG_PROPS,
        data: mapiStream([
          { id: PID.RtfCompressed, type: PT.BINARY, values: [melaRtf(ENCAPSULATED_HTML)] },
        ]),
      },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: new Array(14).fill(0) },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_TITLE, data: cstr("CONTR~1.PDF") },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: ascii("%PDF-1.7 contract") },
      {
        level: LVL_ATTACHMENT,
        id: ATT_ATTACHMENT,
        data: mapiStream([
          { id: PID.AttachLongFilename, type: PT.STRING, values: [wstr("Contract.pdf")] },
        ]),
      },
    ]);

  it("replaces an application/ms-tnef part with the attachments inside it", async () => {
    const eml = emlWithPart(base64(winmail()), "application/ms-tnef", "winmail.dat");
    const archive = await parseEml(eml, "outlook.eml");
    const m = archive.messages[0];

    expect(m.attachments.map((a) => a.filename)).toEqual(["Contract.pdf"]);
    expect(new TextDecoder().decode(m.attachments[0].content)).toBe("%PDF-1.7 contract");
    // The formatted body only existed inside the TNEF.
    expect(m.html).toContain("Hello from TNEF");
    // The MIME text/plain part still wins for the text body.
    expect(m.text).toContain("This message is in TNEF format.");
    expect(m.flags.hasAttachments).toBe(true);
    expect(archive.warnings).toEqual([]);
  });

  it("expands a part identified only by the name winmail.dat", async () => {
    const eml = emlWithPart(base64(winmail()), "application/octet-stream", "winmail.dat");
    const archive = await parseEml(eml, "outlook.eml");

    expect(archive.messages[0].attachments.map((a) => a.filename)).toEqual(["Contract.pdf"]);
  });

  it("leaves the original attachment in place, with a warning, when expansion fails", async () => {
    const junk = new TextEncoder().encode("this is not TNEF at all, sorry");
    const eml = emlWithPart(base64(junk), "application/ms-tnef", "winmail.dat");
    const archive = await parseEml(eml, "outlook.eml");
    const m = archive.messages[0];

    expect(m.attachments.map((a) => a.filename)).toEqual(["winmail.dat"]);
    expect(new TextDecoder().decode(m.attachments[0].content)).toContain("not TNEF");
    expect(archive.warnings.join(" ")).toMatch(/could not be expanded/i);
  });

  it("leaves a normal attachment alone", async () => {
    const eml = emlWithPart(base64(new TextEncoder().encode("hi")), "text/plain", "notes.txt");
    const archive = await parseEml(eml, "plain.eml");

    expect(archive.messages[0].attachments.map((a) => a.filename)).toEqual(["notes.txt"]);
    expect(archive.warnings).toEqual([]);
  });
});
