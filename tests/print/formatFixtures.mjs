// Fixtures for the formats that reach the printer through different parsers.
//
// The click-to-print path is shared by every format, so in principle one would
// do. In practice the formats differ in how long preparation takes and in which
// render path the body lands on, and that is exactly what this bug turned on --
// so each supported format gets driven through the real control.
//
// Where the parsers' own unit tests already know how to build a valid file,
// this reuses that knowledge rather than inventing a second, subtly different
// version of the same format.
import { zipSync, strToU8 } from "fflate";
import { tnefChecksum } from "../../src/lib/parse/tnef.ts";
import { buildCfb, stream } from "../../src/lib/parse/__tests__/cfbBuilder.ts";

const enc = new TextEncoder();

function paragraphs(n, wrap = (t) => `<p>${t}</p>`) {
  return Array.from({ length: n }, (_, i) =>
    wrap(
      `Paragraph ${i + 1}. The surveyor confirmed that no temporary repairs had been ` +
      `undertaken prior to inspection, and the readings are reproduced in the appended schedule.`,
    ),
  ).join("\n");
}

function rfc822(headers, contentType, body) {
  return [...headers, "MIME-Version: 1.0", `Content-Type: ${contentType}`, "", body].join("\r\n");
}

const HEADERS = (subject) => [
  "From: Adjuster <adjuster@fixture.invalid>",
  "To: Counsel <counsel@fixture.invalid>",
  `Subject: ${subject}`,
  "Date: Tue, 3 Jun 2025 09:14:00 -0400",
];

/** .eml with an HTML body. */
export function emlHtml(marker = "EML-HTML-END-MARKER", n = 30) {
  return rfc822(HEADERS("HTML .eml"), "text/html; charset=utf-8",
    `<div>${paragraphs(n)}<p>${marker}</p></div>`);
}

/** .eml with a plain-text body -- the <pre> render path. */
export function emlPlain(marker = "EML-PLAIN-END-MARKER", n = 30) {
  return rfc822(HEADERS("Plain .eml"), "text/plain; charset=utf-8",
    `${paragraphs(n, (t) => t)}\r\n\r\n${marker}`);
}

/**
 * .emlx -- Apple Mail. A decimal byte count, the RFC822 message, then a plist.
 */
export function emlx(marker = "EMLX-END-MARKER", n = 30) {
  const message = rfc822(HEADERS("An .emlx"), "text/html; charset=utf-8",
    `<div>${paragraphs(n)}<p>${marker}</p></div>`);
  const bytes = enc.encode(message);
  const plist = '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>';
  return enc.encode(`${bytes.length}\n${message}${plist}`);
}

/** .mht -- a saved web archive, parsed through the eml path. */
export function mht(marker = "MHT-END-MARKER", n = 30) {
  const boundary = "----=_NextPart_Fixture";
  return enc.encode([
    "From: <Saved by Blink>",
    "Subject: Saved page",
    "MIME-Version: 1.0",
    `Content-Type: multipart/related; type="text/html"; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "Content-Location: http://example.invalid/page.html",
    "",
    `<html><body>${paragraphs(n)}<p>${marker}</p></body></html>`,
    `--${boundary}--`,
    "",
  ].join("\r\n"));
}

/** .olm -- Outlook for Mac, a ZIP of per-message XML. */
export function olm(marker = "OLM-END-MARKER", n = 30) {
  const escaped = `<div>${paragraphs(n)}<p>${marker}</p></div>`
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<emails>
  <email>
    <OPFMessageCopySubject>An .olm message</OPFMessageCopySubject>
    <OPFMessageCopyFrom>
      <emailAddress OPFContactEmailAddressAddress="adjuster@fixture.invalid" OPFContactEmailAddressName="Adjuster"/>
    </OPFMessageCopyFrom>
    <OPFMessageCopyToAddresses>
      <emailAddress OPFContactEmailAddressAddress="counsel@fixture.invalid" OPFContactEmailAddressName="Counsel"/>
    </OPFMessageCopyToAddresses>
    <OPFMessageCopySentTime>2025-06-03T09:14:00Z</OPFMessageCopySentTime>
    <OPFMessageCopyHTMLBody>${escaped}</OPFMessageCopyHTMLBody>
  </email>
</emails>`;
  return zipSync({
    "Accounts/Fixture/Message/Inbox/1a/message_00001.xml": strToU8(xml),
    "Accounts/Fixture/settings.plist": strToU8("<plist/>"),
  });
}

/*
 * An .olm laid out the way Outlook for Mac 2016 and later export one, with
 * synthetic content: a message directory named "com.microsoft.__Messages", a
 * subfolder, attachment bytes under "com.microsoft.__Attachments" (one of them
 * an .xml that must not be taken for a message), an inline image by Content-ID,
 * contacts and categories alongside, and both stored and deflated entries.
 *
 * It is modelled on descriptions of the format, not copied from a real export:
 * no real .olm was available to check it against (MAC-513, MAC-526). Treat a
 * pass as "reads the layout we believe Outlook writes", not "reads Outlook".
 */
const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
const PDF_BYTES = enc.encode("%PDF-1.4\n% synthetic fixture attachment\n%%EOF\n");

const xmlEscape = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const ACCOUNT = "Accounts/adjuster@fixture.invalid";
const MESSAGES = `${ACCOUNT}/com.microsoft.__Messages`;

function olmEmail({ subject, html, text, attachments = "", cc = "" }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<emails>
  <email>
    <OPFMessageCopySubject xml:space="preserve">${xmlEscape(subject)}</OPFMessageCopySubject>
    <OPFMessageCopyFromAddresses>
      <emailAddress OPFContactEmailAddressAddress="adjuster@fixture.invalid" OPFContactEmailAddressName="Adjuster &amp; Co" OPFContactEmailAddressType="0"/>
    </OPFMessageCopyFromAddresses>
    <OPFMessageCopyToAddresses>
      <emailAddress OPFContactEmailAddressAddress="counsel@fixture.invalid" OPFContactEmailAddressName="Counsel" OPFContactEmailAddressType="0"/>
    </OPFMessageCopyToAddresses>${cc}
    <OPFMessageCopySentTime>2025-06-03T13:14:00</OPFMessageCopySentTime>
    <OPFMessageCopyReceivedTime>2025-06-03T13:15:02</OPFMessageCopyReceivedTime>
    <OPFMessageCopyMessageID>&lt;olm-fixture-${subject.length}@fixture.invalid&gt;</OPFMessageCopyMessageID>
    <OPFMessageGetHasHTML>1</OPFMessageGetHasHTML>${text === undefined ? "" : `
    <OPFMessageCopyBody xml:space="preserve">${xmlEscape(text)}</OPFMessageCopyBody>`}${html === undefined ? "" : `
    <OPFMessageCopyHTMLBody xml:space="preserve">${xmlEscape(html)}</OPFMessageCopyHTMLBody>`}${attachments}
  </email>
</emails>`;
}

/** .olm -- an Outlook for Mac 2016+ export (synthetic content, see above). */
export function olmOutlook(marker = "OLM-OUTLOOK-END-MARKER", n = 30) {
  const inbox = olmEmail({
    subject: "Claim 4471 — surveyor's report",
    html:
      `<html><body><p><img src="cid:logo@fixture.invalid" alt="logo" width="1" height="1"></p>` +
      `${paragraphs(n)}<p>${marker}</p></body></html>`,
    text: `${paragraphs(n, (t) => t)}\n\n${marker}`,
    cc: `
    <OPFMessageCopyCCAddresses>
      <emailAddress OPFContactEmailAddressAddress="broker@fixture.invalid" OPFContactEmailAddressName="Broker"/>
    </OPFMessageCopyCCAddresses>`,
    attachments: `
    <OPFMessageCopyAttachmentList>
      <messageAttachment OPFAttachmentContentID="logo@fixture.invalid" OPFAttachmentContentType="image/png" OPFAttachmentName="logo.png" OPFAttachmentURL="${MESSAGES}/Inbox/com.microsoft.__Attachments/message_00000/logo.png"/>
      <messageAttachment OPFAttachmentContentType="application/pdf" OPFAttachmentName="survey-schedule.pdf" OPFAttachmentURL="${MESSAGES}/Inbox/com.microsoft.__Attachments/message_00000/survey-schedule.pdf"/>
      <messageAttachment OPFAttachmentContentType="text/xml" OPFAttachmentName="readings.xml" OPFAttachmentURL="${MESSAGES}/Inbox/com.microsoft.__Attachments/message_00000/readings.xml"/>
    </OPFMessageCopyAttachmentList>`,
  });
  const claims = olmEmail({
    subject: "Re: Claim 4471",
    text: "Received, thank you. We will respond by Friday.",
  });
  return zipSync({
    [`${MESSAGES}/Inbox/message_00000.xml`]: strToU8(inbox),
    [`${MESSAGES}/Inbox/com.microsoft.__Attachments/message_00000/logo.png`]: [PNG_1X1, { level: 0 }],
    [`${MESSAGES}/Inbox/com.microsoft.__Attachments/message_00000/survey-schedule.pdf`]: PDF_BYTES,
    [`${MESSAGES}/Inbox/com.microsoft.__Attachments/message_00000/readings.xml`]: strToU8(
      '<?xml version="1.0"?><readings><email>not a message</email></readings>',
    ),
    [`${MESSAGES}/Inbox/Claims/message_00001.xml`]: [strToU8(claims), { level: 0 }],
    [`${ACCOUNT}/com.microsoft.__Contacts/Contacts/contact_00000.xml`]: strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><contacts><contact><OPFContactCopyDisplayName>Counsel</OPFContactCopyDisplayName></contact></contacts>',
    ),
    "Categories.xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><categories/>'),
  });
}

/** An .olm cut short, as a copy that ran out of disk or was interrupted would be. */
export function olmTruncated() {
  const whole = olmOutlook();
  return whole.slice(0, Math.floor(whole.length * 0.6));
}

/** An .olm whose ZIP is sound but whose only message XML is not well-formed. */
export function olmMalformed() {
  return zipSync({
    [`${MESSAGES}/Inbox/message_00000.xml`]: strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>\n<emails><email><OPFMessageCopySubject>Never closed</email></emails>',
    ),
  });
}

// --- TNEF ------------------------------------------------------------------

const TNEF_SIG = [0x78, 0x9f, 0x3e, 0x22];
const LVL_MESSAGE = 1;
const ATT_SUBJECT = 0x8004;
const ATT_BODY = 0x800c;

const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const cstr = (s) => [...enc.encode(s), 0];

function attribute({ level, id, dataType = 6, data }) {
  return [
    level,
    ...u32((((dataType & 0xffff) << 16) >>> 0) | (id & 0xffff)),
    ...u32(data.length),
    ...data,
    ...u16(tnefChecksum(new Uint8Array(data))),
  ];
}

/** winmail.dat -- a bare TNEF with a plain-text body. */
export function winmailDat(marker = "TNEF-END-MARKER", n = 30) {
  const body = `${paragraphs(n, (t) => t)}\r\n\r\n${marker}`;
  const out = [...TNEF_SIG, ...u16(0x0009)];
  out.push(...attribute({ level: LVL_MESSAGE, id: ATT_SUBJECT, data: cstr("A winmail.dat") }));
  out.push(...attribute({ level: LVL_MESSAGE, id: ATT_BODY, data: cstr(body) }));
  return new Uint8Array(out);
}

// --- .oft ------------------------------------------------------------------

const PT_STRING = 0x001f;
const utf16 = (s) => {
  const out = new Uint8Array(s.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), true);
  return out;
};
const hex4 = (v) => v.toString(16).toUpperCase().padStart(4, "0");
const strProp = (id, value) => stream(`__substg1.0_${hex4(id)}${hex4(PT_STRING)}`, utf16(value));

/**
 * .oft -- an Outlook template. Byte-for-byte the same compound file as a .msg;
 * only the extension distinguishes them, which is worth having a case for.
 */
export function oft(marker = "OFT-END-MARKER", n = 30) {
  return buildCfb([
    strProp(0x001a, "IPM.Note"),
    strProp(0x0037, "An .oft template"),
    strProp(0x0c1a, "Adjuster"),
    strProp(0x0c1f, "adjuster@fixture.invalid"),
    strProp(0x0e04, "counsel@fixture.invalid"),
    strProp(0x1013, `<div>${paragraphs(n)}<p>${marker}</p></div>`),
    stream("__properties_version1.0", new Uint8Array(32)),
  ]);
}
