// Mail fixtures are BUILT here rather than committed, because .gitignore refuses
// to track *.eml/*.mbox at all -- a deliberate guard against a real mail file
// ever landing in the repo by accident. Same approach as cfbBuilder.ts.

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
