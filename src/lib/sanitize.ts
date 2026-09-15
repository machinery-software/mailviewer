import DOMPurify from "dompurify";
import type { Attachment } from "./model";

export interface SanitizeResult {
  html: string;
  /** Remote resources we neutralised, so the UI can tell the user what it did. */
  blockedRemote: BlockedResource[];
}

/**
 * Encode attachment bytes as a data: URL.
 *
 * Inline images have to be data: rather than blob: because the body renders in a
 * fully sandboxed iframe, which the browser gives an opaque origin. blob: URLs
 * are scoped to the origin that created them, so a blob minted here is
 * unreadable from inside that frame -- the image would silently break.
 *
 * The alternative, adding `allow-same-origin` to the sandbox so blob: resolves,
 * would hand every message body a same-origin handle back into the app. Paying
 * ~33% of base64 overhead on inline images is the cheaper side of that trade.
 */
function toDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  const CHUNK = 0x8000; // Chunked: String.fromCharCode(...millions) blows the stack.
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mimeType || "application/octet-stream"};base64,${btoa(binary)}`;
}

export interface BlockedResource {
  kind: "image" | "link" | "media" | "other";
  url: string;
  /** A 1x1 image with a query string is a read receipt, not a picture. */
  likelyTracker: boolean;
}

const TRACKER_HINTS = [
  /open\.?(rate|track)/i, /\btrack(ing)?\b/i, /\bbeacon\b/i, /\bpixel\b/i,
  /\bopen\.gif\b/i, /\bimp\b/i, /\/o\/[a-z0-9]{16,}/i, /utm_/i, /\bmailstat\b/i,
];

function looksLikeTracker(url: string, width: string | null, height: string | null): boolean {
  const tiny = (v: string | null) => v !== null && /^\s*[01](px)?\s*$/.test(v);
  if (tiny(width) && tiny(height)) return true;
  return TRACKER_HINTS.some((re) => re.test(url));
}

/**
 * Turn an untrusted message body into HTML that is safe to put in front of a
 * user, and — just as importantly — that cannot make a network request.
 *
 * There are two independent layers stopping a tracking pixel from firing:
 *
 *   1. This function, which rewrites every remote `src` into a data-* attribute
 *      so nothing with a remote URL is ever handed to the parser as a live
 *      resource reference.
 *   2. The Content-Security-Policy (`img-src 'self' data: blob:`), which the
 *      srcdoc iframe inherits from this document, and which would refuse the
 *      request even if layer 1 had a bug.
 *
 * Layer 1 exists so we can *tell the user what we blocked*. Layer 2 is what
 * makes the guarantee true regardless of whether layer 1 is correct.
 */
export function sanitizeMessageHtml(
  rawHtml: string,
  attachments: Attachment[],
): SanitizeResult {
  const blockedRemote: BlockedResource[] = [];

  // Inline images are referenced from the body as cid:<content-id>. Resolve
  // those against the message's own attachments and inline them as data: URLs,
  // which cost no network request and work inside the opaque-origin sandbox.
  const byCid = new Map<string, Attachment>();
  for (const att of attachments) {
    if (att.contentId) byCid.set(att.contentId.replace(/^<|>$/g, "").toLowerCase(), att);
  }

  // MHTML web archives point their body's `src` at a part's Content-Location URL
  // rather than a cid:. Those URLs are usually absolute (http://...), so without
  // this they would be treated as remote and blocked. Resolve them against the
  // archive's own parts first, and inline the bytes as data: URLs -- the same
  // opaque-origin reasoning as cid: (see toDataUrl above).
  const byLocation = new Map<string, Attachment>();
  for (const att of attachments) {
    if (att.contentLocation) byLocation.set(att.contentLocation.toLowerCase(), att);
  }

  const hook = (node: Element) => {
    for (const attr of ["src", "background", "poster"]) {
      const value = node.getAttribute(attr);
      if (!value) continue;

      if (/^cid:/i.test(value)) {
        const cid = value.slice(4).replace(/^<|>$/g, "").toLowerCase();
        const att = byCid.get(cid);
        if (att) {
          node.setAttribute(attr, toDataUrl(att.content, att.mimeType));
        } else {
          // A cid: with no matching part is a dangling reference. Leaving it in
          // place would make the browser try to resolve it; drop it instead.
          node.removeAttribute(attr);
        }
        continue;
      }

      const located = byLocation.get(value.toLowerCase());
      if (located) {
        node.setAttribute(attr, toDataUrl(located.content, located.mimeType));
        continue;
      }

      // data: and blob: are already local. Everything else is remote.
      if (/^(https?:)?\/\//i.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^(data|blob):/i.test(value)) {
        blockedRemote.push({
          kind: node.tagName === "IMG" ? "image" : node.tagName === "VIDEO" || node.tagName === "AUDIO" ? "media" : "other",
          url: value,
          likelyTracker:
            node.tagName === "IMG" &&
            looksLikeTracker(value, node.getAttribute("width"), node.getAttribute("height")),
        });
        node.removeAttribute(attr);
        // Keep the URL around (inert) so the UI can offer "show remote images"
        // as a deliberate, clearly-labelled network request the user opts into.
        node.setAttribute(`data-blocked-${attr}`, value);
      }
    }

    // Links stay clickable but must not silently navigate the viewer away, and
    // must not leak a referrer identifying the message they came from.
    if (node.tagName === "A") {
      const href = node.getAttribute("href");
      if (href && !/^(https?|mailto):/i.test(href)) node.removeAttribute("href");
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  };

  DOMPurify.addHook("afterSanitizeAttributes", hook);
  let clean: string;
  try {
    clean = DOMPurify.sanitize(rawHtml, {
      WHOLE_DOCUMENT: false,
      FORBID_TAGS: ["form", "input", "button", "textarea", "select", "base", "meta"],
      FORBID_ATTR: ["formaction", "ping", "srcset"],
      ALLOW_DATA_ATTR: true,
      // Message bodies are documents, not apps. Nothing here needs script,
      // and DOMPurify strips it by default -- this just makes it explicit.
      USE_PROFILES: { html: true, svg: true, svgFilters: true },
    });
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes");
  }

  return { html: clean, blockedRemote };
}

/**
 * Wrap sanitized body HTML in a self-contained document for the srcdoc iframe.
 *
 * The body renders on a light canvas always -- on screen and on paper, whatever
 * the app's own theme and whatever the OS prefers -- because that is the canvas
 * its sender composed against: mail clients render HTML mail on white. This
 * used to take a dark-mode flag, the viewer passed `true`, and mail declaring
 * dark text and no background of its own was painted onto #141417.
 *
 * Nothing here adjusts a colour the message declares. Every colour below sits
 * inside :where(), which has no specificity, so any rule the message carries --
 * even a bare `*` -- wins over it. A message shown in colours its sender did
 * not choose is a different document, and this tool produces exhibits.
 */
export function buildIframeDocument(bodyHtml: string): string {
  // A restrictive CSP *inside* the frame as well. The frame already inherits the
  // parent's policy; this is a second, independent statement of the same rule,
  // so that a future change to the parent policy can't silently widen the frame.
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'">
<style>
  :where(html){color-scheme:light;background:#ffffff;color:#16161a;}
  html,body{margin:0;padding:16px;
    font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    word-break:break-word;overflow-wrap:anywhere;}
  :where(a){color:#2a5bd7;}
  img,video{max-width:100%;height:auto;}
  /* An image we refused to fetch should look refused, not merely broken --
     otherwise the reader thinks the app is buggy rather than protecting them. */
  img[data-blocked-src]{
    border:1px dashed #c4ccd6;
    border-radius:4px;
    background:#f4f6f9;
    min-width:32px;min-height:32px;
    color:#8a94a2;
    font:12px/1.4 ui-monospace,monospace;
    padding:6px;
  }
  table{max-width:100%;}
  blockquote{margin:0 0 0 12px;padding-left:12px;}
  :where(blockquote){border-left:2px solid #dcdce4;color:#5a5a68;}
  pre{white-space:pre-wrap;}
  /* Search-match highlight injected by highlightHtml(). */
  mark.mvh{background:#ffb020;color:#1a1204;border-radius:2px;padding:0 1px;}
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}
