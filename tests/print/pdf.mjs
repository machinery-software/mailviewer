// A deliberately small PDF reader. Only two questions are ever asked of a PDF
// here -- how many pages, and does this text appear on them -- and pulling in a
// full PDF library to answer them would add a dependency to a repo whose whole
// pitch is that you can audit everything it ships.
import { inflateSync } from "node:zlib";

/**
 * Page count, read from the page tree root (`/Type /Pages ... /Count N`).
 * Chromium writes that dictionary uncompressed, so no inflation is needed.
 */
export function pageCount(buf) {
  const s = buf.toString("latin1");
  const counts = [...s.matchAll(/\/Type\s*\/Pages[\s\S]{0,400}?\/Count\s+(\d+)/g)]
    .map((m) => Number(m[1]));
  if (counts.length === 0) throw new Error("no /Type /Pages dictionary found in PDF");
  // Nested page trees each carry a /Count; the root's is the largest.
  return Math.max(...counts);
}

/** Index every `N 0 obj ... endobj` in the file by object number. */
function indexObjects(buf) {
  const s = buf.toString("latin1");
  const objects = new Map();
  for (const m of s.matchAll(/(\d+)\s+\d+\s+obj\b/g)) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endobj", start);
    if (end < 0) continue;
    const body = s.slice(start, end);
    const sm = body.match(/stream\r?\n/);
    let stream = null;
    if (sm) {
      const from = start + sm.index + sm[0].length;
      const to = s.indexOf("endstream", from);
      if (to > 0) {
        const raw = buf.subarray(from, to);
        try {
          stream = inflateSync(raw).toString("latin1");
        } catch {
          stream = raw.toString("latin1");
        }
      }
    }
    objects.set(Number(m[1]), { dict: sm ? body.slice(0, sm.index) : body, stream });
  }
  return objects;
}

/** Follow `N 0 R` one hop, or return the literal text unchanged. */
function deref(objects, text) {
  const ref = text?.match(/^\s*(\d+)\s+\d+\s+R\s*$/);
  return ref ? objects.get(Number(ref[1]))?.dict ?? "" : text ?? "";
}

/** Extract the value following `/Key` from a dictionary, balancing `<< >>`. */
function dictValue(dict, key) {
  const at = dict.indexOf(`/${key}`);
  if (at < 0) return null;
  let i = at + key.length + 1;
  while (/\s/.test(dict[i])) i++;
  if (dict[i] === "<" && dict[i + 1] === "<") {
    let depth = 0;
    const from = i;
    for (; i < dict.length; i++) {
      if (dict[i] === "<" && dict[i + 1] === "<") { depth++; i++; }
      else if (dict[i] === ">" && dict[i + 1] === ">") { depth--; i++; if (!depth) return dict.slice(from, i + 1); }
    }
    return dict.slice(from);
  }
  const rest = dict.slice(i);
  const ref = rest.match(/^\d+\s+\d+\s+R/);
  if (ref) return ref[0];
  return rest.match(/^[^\s/>\]]+/)?.[0] ?? null;
}

/**
 * Parse a /ToUnicode CMap into a glyph-code -> text map.
 *
 * Chromium subsets every font it embeds, so the bytes inside a text operator
 * are glyph ids private to that subset, not characters -- searching the raw
 * stream for a word finds nothing even when the word is plainly on the page.
 * The CMap is the table that undoes that, and it is the only reason a content
 * assertion here can mean anything.
 */
function parseCMap(text) {
  if (!text || (!text.includes("beginbfchar") && !text.includes("beginbfrange"))) return null;
  const map = new Map();
  const hexToStr = (h) => {
    let out = "";
    for (let i = 0; i + 3 < h.length + 1; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return out;
  };
  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(m[1], 16), hexToStr(m[2]));
    }
  }
  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const dst = parseInt(m[3], 16);
      if (hi - lo > 0xffff) continue; // guard a malformed range
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(dst + (c - lo)));
    }
  }
  return map.size ? map : null;
}

/**
 * Build `/Fn` -> {cmap, width} for every font reachable from a page's
 * resources. Pairing each font with its *own* ToUnicode is what makes decoding
 * exact: Chromium mixes simple fonts (one byte per glyph) with composite Type0
 * ones (two bytes) on the same page, and guessing produces text that is subtly
 * wrong rather than obviously wrong.
 */
function fontTable(objects) {
  const fonts = new Map();
  for (const { dict } of objects.values()) {
    if (!/\/Font\b/.test(dict)) continue;
    const fontDict = dictValue(dict, "Font");
    if (!fontDict || !fontDict.startsWith("<<")) continue;
    for (const m of fontDict.matchAll(/\/(F\d+)\s+(\d+)\s+\d+\s+R/g)) {
      const font = objects.get(Number(m[2]));
      if (!font) continue;
      const toUni = font.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
      const cmap = toUni ? parseCMap(objects.get(Number(toUni[1]))?.stream) : null;
      const composite = /\/Subtype\s*\/Type0/.test(font.dict);
      // A simple font with no ToUnicode is almost always using a standard
      // encoding, where the byte already is the character. Firefox writes text
      // that way; assuming otherwise would silently drop it from the extract.
      fonts.set(m[1], { cmap, width: composite ? 2 : 1 });
    }
  }
  return fonts;
}

/** Decode one PDF string token into raw bytes. */
function tokenBytes(hex, literal) {
  if (hex !== undefined) {
    const clean = hex.replace(/\s+/g, "");
    if (clean.length < 2 || clean.length % 2) return null;
    const bytes = [];
    for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
    return bytes;
  }
  const bytes = [];
  for (let i = 0; i < literal.length; i++) {
    if (literal[i] === "\\") {
      const n = literal[++i];
      const esc = { n: 10, r: 13, t: 9, b: 8, f: 12 }[n];
      if (esc !== undefined) bytes.push(esc);
      else if (/[0-7]/.test(n)) {
        let oct = n;
        while (oct.length < 3 && /[0-7]/.test(literal[i + 1])) oct += literal[++i];
        bytes.push(parseInt(oct, 8));
      } else bytes.push(literal.charCodeAt(i));
    } else bytes.push(literal.charCodeAt(i));
  }
  return bytes;
}

/**
 * All text drawn on the page, decoded through each run's own font.
 *
 * Chromium draws a line of prose as many one- and two-character runs and
 * interleaves runs from different fonts, so the content stream is walked in
 * order while tracking the most recent `/Fn ... Tf`.
 */
export function extractText(buf) {
  const objects = indexObjects(buf);
  const fonts = fontTable(objects);
  let out = "";
  for (const { stream } of objects.values()) {
    if (!stream || !stream.includes("BT") || stream.includes("begincmap")) continue;
    const token = /\/(F\d+)\s+[\d.-]+\s+Tf|<([0-9A-Fa-f\s]*)>|\(((?:\\[\s\S]|[^\\()])*)\)/g;
    let font = null;
    let m;
    while ((m = token.exec(stream))) {
      if (m[1] !== undefined) {
        font = fonts.get(m[1]) ?? null;
        continue;
      }
      if (!font) continue;
      const bytes = tokenBytes(m[2], m[3]);
      if (!bytes) continue;
      for (let i = 0; i + font.width - 1 < bytes.length; i += font.width) {
        const code = font.width === 1 ? bytes[i] : (bytes[i] << 8) | bytes[i + 1];
        if (font.cmap) out += font.cmap.get(code) ?? "";
        else if (font.width === 1 && code >= 0x20 && code < 0x7f) out += String.fromCharCode(code);
      }
    }
  }
  return out;
}

/**
 * True if `needle` appears in the PDF's rendered text. Whitespace is stripped
 * from both sides because the text operators split a line into runs at
 * arbitrary points, so the spacing in the extracted string is not meaningful.
 */
export function containsText(buf, needle) {
  return extractText(buf).replace(/\s+/g, "").includes(needle.replace(/\s+/g, ""));
}
