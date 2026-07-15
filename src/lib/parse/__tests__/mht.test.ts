/**
 * @vitest-environment jsdom
 *
 * MHTML is MIME, so postal-mime opens the container; the only work is resolving
 * the body's Content-Location references (which stand in for cid:) against the
 * archive's own parts. This builds a real MHTML byte string with a
 * Content-Location image and proves the image is inlined into the body as a
 * data: URL -- and that nothing is left pointing at the network.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { parseEml } from "../eml";
import { sanitizeMessageHtml } from "../../sanitize";

// An 8-byte PNG signature stands in for a real image; the bytes are arbitrary,
// what matters is that they survive base64 -> attachment -> data: URL intact.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_B64 = btoa(String.fromCharCode(...PNG));

function buildMhtml(): Uint8Array {
  const B = "----=_NextPart_Boundary";
  const lines = [
    "From: <Saved by Blink>",
    "Subject: Saved page",
    "MIME-Version: 1.0",
    `Content-Type: multipart/related; type="text/html"; boundary="${B}"`,
    "",
    `--${B}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "Content-Location: http://example.com/page.html",
    "",
    '<html><body><p>Hi</p><img src="http://example.com/pixel.png"></body></html>',
    `--${B}`,
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-Location: http://example.com/pixel.png",
    "",
    PNG_B64,
    `--${B}--`,
    "",
  ];
  return new TextEncoder().encode(lines.join("\r\n"));
}

beforeAll(() => {
  let n = 0;
  URL.createObjectURL = () => `blob:mock/${n++}`;
  URL.revokeObjectURL = () => {};
});

describe("MHTML (.mht)", () => {
  it("recovers the Content-Location of an inline part", async () => {
    const archive = await parseEml(buildMhtml(), "page.mht", "mht");

    expect(archive.format).toBe("mht");
    expect(archive.messages).toHaveLength(1);

    const m = archive.messages[0];
    expect(m.subject).toBe("Saved page");
    expect(m.attachments).toHaveLength(1);

    const img = m.attachments[0];
    expect(img.mimeType).toBe("image/png");
    expect(img.contentLocation).toBe("http://example.com/pixel.png");
    expect(img.content).toEqual(PNG);
  });

  it("inlines the Content-Location image into the body as a data: URL", async () => {
    const archive = await parseEml(buildMhtml(), "page.mht", "mht");
    const m = archive.messages[0];

    const { html, blockedRemote } = sanitizeMessageHtml(m.html ?? "", m.attachments);

    // The remote-looking src has been resolved locally, so nothing is blocked...
    expect(blockedRemote).toEqual([]);
    // ...and the image now carries the part's bytes as a data: URL, which is the
    // only form that survives the opaque-origin sandbox.
    expect(html).toContain(`data:image/png;base64,${PNG_B64}`);
    expect(html).not.toContain("http://example.com/pixel.png");
  });
});
