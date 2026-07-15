/**
 * MHTML (multipart/related web archive) is ordinary MIME, so postal-mime parses
 * the container, the bodies and the attachment bytes for us. The one thing it
 * drops is each part's `Content-Location` header -- the URL an MHTML body's
 * `<img src="...">` points at instead of a `cid:`. This recovers those URLs.
 *
 * It is deliberately NOT a MIME parser: it splits the top-level related part on
 * its boundary and reads a couple of headers per part. Bodies are never decoded
 * here (postal-mime already did that), so the two agree on ordering: postal-mime
 * emits its attachments in document order, and this returns the Content-Location
 * of every non-text part in that same order, so eml.ts can zip them together by
 * index.
 */

function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** Read a single header value out of a part's header block, case-insensitively. */
function header(block: string, name: string): string | null {
  // Headers may be folded across continuation lines (leading whitespace).
  const re = new RegExp(`^${name}:[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)`, "im");
  const m = re.exec(block);
  if (!m) return null;
  return m[1].replace(/\r?\n[ \t]+/g, " ").trim();
}

/** Pull the multipart boundary out of the message's top Content-Type header. */
function topBoundary(headerBlock: string): string | null {
  const ct = header(headerBlock, "content-type");
  if (!ct || !/multipart\/related/i.test(ct)) return null;
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(ct);
  return m ? m[1] ?? m[2] : null;
}

/**
 * The Content-Location of every part postal-mime would treat as an attachment
 * (i.e. not the text/html or text/plain body), in document order. Entries are
 * empty strings where a part carried no Content-Location, so indices still line
 * up one-to-one with postal-mime's attachment list.
 */
export function partContentLocations(bytes: Uint8Array): string[] {
  // The message header block ends at the first blank line.
  const text = latin1(bytes);
  const headerEnd = text.search(/\r?\n\r?\n/);
  if (headerEnd === -1) return [];

  const boundary = topBoundary(text.slice(0, headerEnd));
  if (!boundary) return [];

  const delimiter = `--${boundary}`;
  const locations: string[] = [];

  // Split on the boundary. The first chunk is the preamble/top headers; the last
  // is the closing "--boundary--" epilogue. Everything between is one part each.
  const chunks = text.split(delimiter);
  for (let i = 1; i < chunks.length; i++) {
    let part = chunks[i];
    if (part.startsWith("--")) break; // closing delimiter: no parts follow
    part = part.replace(/^\r?\n/, "");

    const sep = part.search(/\r?\n\r?\n/);
    const partHeaders = sep === -1 ? part : part.slice(0, sep);

    const ct = header(partHeaders, "content-type") ?? "text/plain";
    const cd = header(partHeaders, "content-disposition") ?? "";
    // postal-mime folds text/html and text/plain parts into the body rather than
    // the attachment list, unless they are explicitly dispositioned attachment.
    const isBody =
      /^text\/(html|plain)\b/i.test(ct) && !/attachment/i.test(cd);
    if (isBody) continue;

    locations.push(header(partHeaders, "content-location") ?? "");
  }

  return locations;
}
