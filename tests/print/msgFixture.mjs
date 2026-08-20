// Builders for .msg fixtures.
//
// Reuses the CFB writer the parser's own unit tests use rather than carrying a
// second one: a .msg is a compound file, and hand-rolling a second writer here
// would mean print fixtures that are only approximately the shape the parser
// actually reads.
import { buildCfb, storage, stream } from "../../src/lib/parse/__tests__/cfbBuilder.ts";

const PID = { MessageClass: 0x001a, Subject: 0x0037, Body: 0x1000, RtfCompressed: 0x1009, BodyHtml: 0x1013,
              SenderName: 0x0c1a, SenderEmail: 0x0c1f, DisplayTo: 0x0e04 };
const PT = { STRING: 0x001f, BINARY: 0x0102 };

const utf16 = (s) => {
  const out = new Uint8Array(s.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), true);
  return out;
};
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");
const tagName = (id, type) => `__substg1.0_${hex4(id)}${hex4(type)}`;
const strProp = (id, value) => stream(tagName(id, PT.STRING), utf16(value));
const binProp = (id, bytes) => stream(tagName(id, PT.BINARY), bytes);

/**
 * Wrap RTF in the "MELA" stored variant of a PidTagRtfCompressed stream --
 * the uncompressed form, which the parser accepts and which avoids needing an
 * LZFu *compressor* just to build a fixture.
 */
export function melaRtf(rtfText) {
  const rtf = new TextEncoder().encode(rtfText);
  const out = new Uint8Array(16 + rtf.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length - 4, true);   // compressedSize
  dv.setUint32(4, rtf.length, true);       // rawSize
  dv.setUint32(8, 0x414c454d, true);       // "MELA"
  dv.setUint32(12, 0, true);               // crc (unchecked for stored streams)
  out.set(rtf, 16);
  return out;
}

function baseNodes(subject) {
  return [
    strProp(PID.MessageClass, "IPM.Note"),
    strProp(PID.Subject, subject),
    strProp(PID.SenderName, "Adjuster"),
    strProp(PID.SenderEmail, "adjuster@fixture.invalid"),
    strProp(PID.DisplayTo, "counsel@fixture.invalid"),
  ];
}

/** A .msg whose only body is PidTagBody: plain text. */
export function msgPlainText(paragraphs = 40, marker = "MSG-PLAIN-END-MARKER") {
  const body = Array.from({ length: paragraphs }, (_, i) =>
    `Paragraph ${i + 1}. The surveyor confirmed that no temporary repairs had been undertaken ` +
    `prior to inspection. Following the storm event of 12 March, the affected elevation was ` +
    `photographed and measured, and the readings are reproduced in the appended schedule.`,
  ).join("\r\n\r\n");
  return buildCfb([...baseNodes("Long plain-text .msg"), strProp(PID.Body, `${body}\r\n\r\n${marker}`)]);
}

/** A .msg carrying PidTagBodyHtml. */
export function msgHtml(paragraphs = 40, marker = "MSG-HTML-END-MARKER") {
  const body = Array.from({ length: paragraphs }, (_, i) =>
    `<p>Paragraph ${i + 1}. The surveyor confirmed that no temporary repairs had been undertaken ` +
    `prior to inspection, and the readings are reproduced in the appended schedule.</p>`,
  ).join("\n");
  return buildCfb([...baseNodes("Long HTML .msg"),
    strProp(PID.BodyHtml, `<div><h2>Claim narrative</h2>${body}<p>${marker}</p></div>`)]);
}

/** A .msg whose body is genuine (not HTML-encapsulated) rich text. */
export function msgRtfText(paragraphs = 40, marker = "MSG-RTF-TEXT-END-MARKER") {
  const paras = Array.from({ length: paragraphs }, (_, i) =>
    `Paragraph ${i + 1}. The surveyor confirmed that no temporary repairs had been undertaken ` +
    `prior to inspection, and the readings are reproduced in the appended schedule.\\par\n`,
  ).join("");
  const rtf = `{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Calibri;}}\n${paras}${marker}\\par\n}`;
  return buildCfb([...baseNodes("Long RTF .msg"), binProp(PID.RtfCompressed, melaRtf(rtf))]);
}

/** A .msg whose body is HTML encapsulated inside RTF, as Outlook writes it. */
export function msgRtfEncapsulatedHtml(paragraphs = 40, marker = "MSG-RTF-HTML-END-MARKER") {
  const paras = Array.from({ length: paragraphs }, (_, i) =>
    `{\\*\\htmltag64 <p>}Paragraph ${i + 1}. The surveyor confirmed that no temporary repairs ` +
    `had been undertaken prior to inspection.{\\*\\htmltag64 </p>}\n`,
  ).join("");
  const rtf =
    `{\\rtf1\\ansi\\ansicpg1252\\fromhtml1\\deff0{\\fonttbl{\\f0 Calibri;}}\n` +
    `{\\*\\htmltag64 <html><body>}\n${paras}` +
    `{\\*\\htmltag64 <p>}${marker}{\\*\\htmltag64 </p></body></html>}\n}`;
  return buildCfb([...baseNodes("Encapsulated-HTML .msg"), binProp(PID.RtfCompressed, melaRtf(rtf))]);
}

/**
 * A Word-authored .msg whose body is wrapped in viewport-pinned CSS.
 *
 * This is the shape that collapsed the measuring frame: `height: 100vh` means
 * whatever the frame is tall, and the frame used to be 10px. Kept as a print
 * fixture so that regression is caught through the real control as well as
 * through the measurement unit.
 */
export function msgWordViewportBody(paragraphs = 30, marker = "MSG-WORD-END-MARKER") {
  const body = Array.from({ length: paragraphs }, (_, i) =>
    `<p class=MsoNormal>Paragraph ${i + 1}. The surveyor confirmed that no temporary repairs ` +
    `had been undertaken prior to inspection.<o:p></o:p></p>`,
  ).join("\n");

  const html =
    `<style><!--\n` +
    `p.MsoNormal{margin:0cm;font-size:11.0pt;font-family:"Calibri",sans-serif;}\n` +
    `@page WordSection1{size:612.0pt 792.0pt;margin:72.0pt;}\n` +
    `div.WordSection1{page:WordSection1;}\n--></style>` +
    `<div class=WordSection1 style="height:100vh;overflow:auto">${body}<p>${marker}</p></div>`;

  return buildCfb([...baseNodes("Word-authored .msg"), strProp(PID.BodyHtml, html)]);
}
