// Mail fixtures are BUILT here rather than committed, because .gitignore refuses
// to track *.eml/*.mbox at all -- a deliberate guard against a real mail file
// ever landing in the repo by accident. Same approach as cfbBuilder.ts.
import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";

/** A 1x1 transparent PNG, small enough to inline. */
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function headers({ subject, from, to, date, cc }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <${subject.replace(/\W+/g, "-").toLowerCase()}@fixture.invalid>`,
    "MIME-Version: 1.0",
  ];
}

function htmlPart(html) {
  return ["Content-Type: text/html; charset=utf-8", "", html].join("\r\n");
}

/**
 * Text colours a sender declared: the navy and purple from Word's own colour
 * picker, and one pale colour chosen *because* it reads poorly on white. A
 * renderer that "corrects" low-contrast text would change that one first, so
 * it is what shows the body was rendered as sent rather than improved.
 */
export const SENDER_COLOURS = { navy: "#1F3864", purple: "#7030A0", pale: "#C9A0DC" };

/** Large, bold, and one colour per line, so each colour paints solid glyph cores. */
export const COLOURED_LINE_STYLE = "margin:0;font:bold 32px/44px Arial,sans-serif";

export const colouredLines = () => [
  [SENDER_COLOURS.navy, "Navy body text"],
  [SENDER_COLOURS.purple, "Purple body text"],
  [SENDER_COLOURS.pale, "Pale body text"],
];

/**
 * The shape that made bodies unreadable: text colours declared, no background
 * declared anywhere, so the sender was relying on the white canvas every mail
 * client gives HTML mail. Colours are inline, the way Outlook writes them.
 */
export function colouredTextEml(marker = "COLOURED-TEXT-END-MARKER") {
  const lines = colouredLines()
    .map(([colour, text]) =>
      `<p class=MsoNormal style="${COLOURED_LINE_STYLE}"><span style="color:${colour}">${text}</span></p>`)
    .join("\n");
  return [
    ...headers({
      subject: "Coloured text without a background",
      from: "Adjuster <adjuster@fixture.invalid>",
      to: "Counsel <counsel@fixture.invalid>",
      date: "Tue, 3 Jun 2025 09:14:00 -0400",
    }),
    htmlPart(`<div class=WordSection1>${lines}<p class=MsoNormal>${marker}</p></div>`),
  ].join("\r\n");
}

/**
 * A single message whose body is long enough to span many printed pages.
 * `paragraphs` controls the length; each one is a full paragraph of prose.
 */
export function longMessageEml(paragraphs = 60) {
  const body = Array.from({ length: paragraphs }, (_, i) =>
    `<p data-para="${i + 1}">Paragraph ${i + 1}. ` +
    "This clause exists to give the renderer a realistic amount of flowing text " +
    "so that pagination has something to paginate. It is repeated verbatim so " +
    "that the only thing distinguishing one paragraph from another is its number. "
      .repeat(3) +
    `End of paragraph ${i + 1}.</p>`,
  ).join("\n");

  return [
    ...headers({
      subject: "Long single message",
      from: "Adjuster <adjuster@fixture.invalid>",
      to: "Counsel <counsel@fixture.invalid>",
      date: "Tue, 3 Jun 2025 09:14:00 -0400",
    }),
    htmlPart(
      `<div><h2>Claim narrative</h2>${body}` +
      `<p id="last-line">FINAL-SENTINEL-LONG-MESSAGE</p></div>`,
    ),
  ].join("\r\n");
}

/** A message with a table far wider than the page -- common in insurance mail. */
export function wideTableEml() {
  const cols = 18;
  const head = Array.from({ length: cols }, (_, i) => `<th>Column ${i + 1}</th>`).join("");
  const rows = Array.from({ length: 40 }, (_, r) =>
    `<tr>${Array.from({ length: cols }, (_, c) => `<td>R${r + 1}C${c + 1}-value</td>`).join("")}</tr>`,
  ).join("\n");

  return [
    ...headers({
      subject: "Schedule of loss",
      from: "Broker <broker@fixture.invalid>",
      to: "Adjuster <adjuster@fixture.invalid>",
      date: "Wed, 4 Jun 2025 11:02:00 -0400",
    }),
    htmlPart(
      `<table border="1"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` +
      `<p id="last-line">FINAL-SENTINEL-WIDE-TABLE</p>`,
    ),
  ].join("\r\n");
}

/** A multipart/related message with genuinely inline (cid:) images. */
export function inlineImagesEml(images = 12) {
  const boundary = "----=_fixture_related";
  const parts = [];

  const body = Array.from({ length: images }, (_, i) =>
    `<p>Exhibit ${i + 1}</p><img src="cid:img${i}@fixture.invalid" width="400" height="220" alt="Exhibit ${i + 1}">`,
  ).join("\n");

  parts.push(
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    `<div>${body}<p id="last-line">FINAL-SENTINEL-INLINE-IMAGES</p></div>`,
  );

  for (let i = 0; i < images; i++) {
    parts.push(
      `--${boundary}`,
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      `Content-ID: <img${i}@fixture.invalid>`,
      "Content-Disposition: inline",
      "",
      PNG_1PX,
    );
  }
  parts.push(`--${boundary}--`, "");

  return [
    ...headers({
      subject: "Site photographs",
      from: "Surveyor <surveyor@fixture.invalid>",
      to: "Adjuster <adjuster@fixture.invalid>",
      date: "Thu, 5 Jun 2025 16:40:00 -0400",
    }),
    `Content-Type: multipart/related; boundary="${boundary}"`,
    "",
    ...parts,
  ].join("\r\n");
}

/**
 * An mbox carrying `count` messages that reply to each other, so the viewer
 * shows a list with more than ten entries. Each body is long enough that the
 * set cannot possibly fit on one printed page.
 */
export function threadMbox(count = 12) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const subject = i === 0 ? "Policy 4471-B" : "Re: Policy 4471-B";
    const who = i % 2 === 0
      ? { from: "Adjuster <adjuster@fixture.invalid>", to: "Counsel <counsel@fixture.invalid>" }
      : { from: "Counsel <counsel@fixture.invalid>", to: "Adjuster <adjuster@fixture.invalid>" };

    const paras = Array.from({ length: 8 }, (_, p) =>
      `<p>Message ${i + 1}, paragraph ${p + 1}. ` +
      "Text long enough that a dozen of these cannot share a single page. ".repeat(4) +
      "</p>",
    ).join("\n");

    out.push(
      `From fixture@fixture.invalid ${new Date(Date.UTC(2025, 5, 3 + i, 12)).toUTCString()}`,
      `From: ${who.from}`,
      `To: ${who.to}`,
      `Subject: ${subject}`,
      `Date: ${new Date(Date.UTC(2025, 5, 3 + i, 12)).toUTCString()}`,
      `Message-ID: <chain-${i}@fixture.invalid>`,
      ...(i > 0 ? [`In-Reply-To: <chain-${i - 1}@fixture.invalid>`] : []),
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      `<div><h3>Message ${i + 1} of ${count}</h3>${paras}` +
        `<p>SENTINEL-CHAIN-${i + 1}</p></div>`,
      "",
    );
  }
  return out.join("\r\n");
}

/**
 * A long message with **no HTML part at all**.
 *
 * The marker matches the one in David's `1-long-single.eml` so the assertions
 * line up if that file is dropped in place of this generated one.
 *
 * This is the shape every earlier print fixture missed. A plain-text body does
 * not render through the sandboxed frame -- it is a <pre> in the parent
 * document -- so nothing about the iframe measuring path is exercised by it,
 * and the <pre> brought its own problem: it did not wrap, which is what painted
 * message text across the live UI.
 */
export function longPlainTextEml(paragraphs = 40, marker = "END-OF-DOCUMENT-MARKER") {
  const body = Array.from({ length: paragraphs }, (_, i) =>
    `Paragraph ${i + 1}. The surveyor confirmed that no temporary repairs had been ` +
    `undertaken prior to inspection. Following the storm event of 12 March, the ` +
    `affected elevation was photographed and measured, and the readings are ` +
    `reproduced in the schedule appended to this correspondence.`,
  ).join("\n\n");

  return [
    "From: Adjuster <adjuster@fixture.invalid>",
    "To: Counsel <counsel@fixture.invalid>",
    "Subject: Long plain-text message",
    "Date: Tue, 3 Jun 2025 09:14:00 -0400",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "",
    marker,
  ].join("\r\n");
}

/**
 * A body that sizes itself against the viewport.
 *
 * Word- and Outlook-authored mail does this often enough to matter: `100vh`,
 * an absolutely-positioned block pinned top-to-bottom, a percentage-height
 * chain. Whatever the measuring frame is tall, such a body believes a page is,
 * which is why the frame has to be a plausible page rather than a placeholder.
 */
export function viewportSizedEml(kind = "vh", paragraphs = 40, marker = "VIEWPORT-SIZED-END-MARKER") {
  const body = Array.from({ length: paragraphs }, (_, i) =>
    `<p>Paragraph ${i + 1}. The surveyor confirmed that no temporary repairs had been ` +
    `undertaken prior to inspection.</p>`,
  ).join("\n");

  const wrapper = {
    vh: `<div style="height:100vh;overflow:auto">`,
    absolute: `<div style="position:absolute;top:0;left:0;right:0;bottom:0;overflow:auto">`,
    fixed: `<div style="position:fixed;top:0;left:0;overflow:auto">`,
  }[kind];

  return [
    "From: Adjuster <adjuster@fixture.invalid>",
    "To: Counsel <counsel@fixture.invalid>",
    `Subject: Viewport-sized body (${kind})`,
    "Date: Tue, 3 Jun 2025 09:14:00 -0400",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    `${wrapper}${body}<p>${marker}</p></div>`,
  ].join("\r\n");
}

// --- What a printed PDF contains ----------------------------------------------

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A solid-colour PNG big enough to see on a printed page. */
function solidPng(width, height, [r, g, b]) {
  const be32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const chunk = (type, data) => {
    const body = [...Buffer.from(type, "latin1"), ...data];
    return [...be32(data.length), ...body, ...be32(crc32(body))];
  };
  const row = [0, ...Array.from({ length: width }, () => [r, g, b]).flat()];
  const raw = Buffer.from(Array.from({ length: height }, () => row).flat());
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [...be32(width), ...be32(height), 8, 2, 0, 0, 0]),
    ...chunk("IDAT", [...deflateSync(raw)]),
    ...chunk("IEND", []),
  ]);
}

/**
 * One message carrying everything a printed PDF might or might not include:
 * From, To (two), Cc, Bcc, Reply-To, Subject, Date, an HTML body, an inline
 * image by Content-ID, and two attachments whose bytes carry markers that
 * must never appear on paper. The answers in the Safari-hint PR, and the claims
 * a guide makes about the PDF, are checked against this.
 */
export const PDF_CONTENTS = {
  subject: "PDF contents check 0417",
  from: "Adjuster <adjuster@fixture.invalid>",
  to: ["Counsel <counsel@fixture.invalid>", "Second Counsel <second@fixture.invalid>"],
  cc: "Broker <broker@fixture.invalid>",
  bcc: "Hidden Reader <bcc-only@fixture.invalid>",
  replyTo: "Claims Desk <reply-only@fixture.invalid>",
  date: "Tue, 3 Jun 2025 09:14:00 -0400",
  bodyMarker: "PDF-CONTENTS-BODY-END-MARKER",
  imageAlt: "Inline chart 0417",
  attachments: ["schedule.txt", "survey.pdf"],
  attachmentMarkers: ["ATTACHED-TEXT-BYTES-MUST-NOT-PRINT", "ATTACHED-PDF-BYTES-MUST-NOT-PRINT"],
};

export function pdfContentsEml() {
  const c = PDF_CONTENTS;
  const mixed = "----=_fixture_mixed";
  const related = "----=_fixture_related_pdf";
  const png = solidPng(240, 120, [0xd9, 0x35, 0x2b]).toString("base64").replace(/.{76}/g, "$&\r\n");
  const b64 = (s) => Buffer.from(s).toString("base64");
  return [
    `From: ${c.from}`,
    `To: ${c.to.join(", ")}`,
    `Cc: ${c.cc}`,
    `Bcc: ${c.bcc}`,
    `Reply-To: ${c.replyTo}`,
    `Subject: ${c.subject}`,
    `Date: ${c.date}`,
    "Message-ID: <pdf-contents-0417@fixture.invalid>",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/related; boundary="${related}"`,
    "",
    `--${related}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    `<div><p>The surveyor's schedule is attached.</p>` +
      `<p><img src="cid:chart0417@fixture.invalid" width="240" height="120" alt="${c.imageAlt}"></p>` +
      `<p>${c.bodyMarker}</p></div>`,
    `--${related}`,
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <chart0417@fixture.invalid>",
    "Content-Disposition: inline; filename=chart.png",
    "",
    png,
    `--${related}--`,
    `--${mixed}`,
    'Content-Type: text/plain; charset=utf-8; name="schedule.txt"',
    'Content-Disposition: attachment; filename="schedule.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(`Readings schedule.\n${c.attachmentMarkers[0]}\n`),
    `--${mixed}`,
    'Content-Type: application/pdf; name="survey.pdf"',
    'Content-Disposition: attachment; filename="survey.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(`%PDF-1.4\n% ${c.attachmentMarkers[1]}\n%%EOF\n`),
    `--${mixed}--`,
    "",
  ].join("\r\n");
}
