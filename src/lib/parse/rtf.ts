/**
 * RTF de-encapsulation and text extraction (MS-OXRTFEX).
 *
 * When Outlook has an HTML message and an RTF-only recipient, it wraps the
 * original HTML *inside* RTF: the markup is carried in `\*\htmltag` groups and
 * as literal text, while the RTF that renders it is fenced off between
 * `\htmlrtf` and `\htmlrtf0` so a de-encapsulator can drop it. Recovering the
 * HTML is therefore a matter of emitting what is outside the fences.
 *
 * We deliberately do NOT implement RTF rendering. There are two cases worth
 * anything:
 *
 *   - The RTF is HTML-encapsulated (`\fromhtml1`). We pull the HTML back out
 *     verbatim -- that is a lossless recovery, not a conversion.
 *
 *   - Anything else. We strip to plain text and stop. Turning genuine RTF into
 *     faithful HTML is a rabbit hole with no bottom, and a wrong rendering is
 *     worse than an honest plain-text one.
 *
 * Shared by the .msg and PST parsers; both hand us the *decompressed* RTF
 * bytes (see `./lzfu.ts`). Keep this module free of any MSG/PST specifics, and
 * free of anything to do with the LZFu codec.
 */

import { codepageToLabel, decodeBytes } from "./codepage.ts";

/** Control words whose whole group is RTF plumbing, never content. */
const SKIP_DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "colorschememapping",
  "stylesheet",
  "listtable",
  "listoverridetable",
  "revtbl",
  "rsidtable",
  "rsidtbl",
  "filetbl",
  "info",
  "pntext",
  "pntxta",
  "pntxtb",
  "generator",
  "themedata",
  "latentstyles",
  "datastore",
  "xmlnstbl",
  "mmathPr",
  "objdata",
  "pict",
]);

const SYMBOL_TEXT: Record<string, string> = {
  par: "\r\n",
  line: "\r\n",
  tab: "\t",
  lquote: "‘",
  rquote: "’",
  ldblquote: "“",
  rdblquote: "”",
  bullet: "•",
  endash: "–",
  emdash: "—",
  emspace: " ",
  enspace: " ",
  qmspace: " ",
};

interface RtfGroup {
  htmlrtf: boolean;
  ignore: boolean;
  htmltag: boolean;
  uc: number;
}

export interface RtfResult {
  /** Set only when the RTF was HTML-encapsulated (`\fromhtml1`). */
  html?: string;
  /** The visible text. Empty when nothing was recovered. */
  text: string;
  encapsulatedHtml: boolean;
}

/** How far into the stream we look for the leading declarations. */
const HEAD_BYTES = 8192;

/**
 * True when the RTF is an HTML document in disguise.
 *
 * `\fromhtml1` is the documented marker and appears in the header. Some
 * producers omit it but still encapsulate, so the presence of a `\*\htmltag`
 * destination anywhere near the top counts as well.
 */
function isHtmlEncapsulated(head: string): boolean {
  return /\\fromhtml1?\b/.test(head.slice(0, 4096)) || /\\\*\\htmltag/.test(head);
}

/**
 * Pull content back out of an RTF body.
 *
 * The stream declares its own codepage with `\ansicpg`, and that wins.
 * `codepageHint` (the message's PidTagInternetCodepage, say) is only consulted
 * when the RTF does not say; failing both, windows-1252, as Outlook assumes.
 *
 * This is not an RTF renderer, and is not trying to be. For RTF that is
 * genuinely RTF -- a message actually composed in rich text -- we throw away
 * the formatting and keep the words, which is all the plain-text fallback
 * needs.
 */
export function deencapsulateRtf(rtf: Uint8Array, codepageHint?: number): RtfResult {
  // The leading control words tell us the codepage and whether this is
  // encapsulated HTML. Scan the first chunk as ASCII to find out.
  const head = decodeBytes(rtf.subarray(0, Math.min(rtf.length, HEAD_BYTES)), "windows-1252");
  const encapsulatedHtml = isHtmlEncapsulated(head);
  const cpgMatch = /\\ansicpg(\d+)/.exec(head);
  const codepage = cpgMatch ? parseInt(cpgMatch[1], 10) : codepageHint;
  const label = codepageToLabel(codepage);

  const stack: RtfGroup[] = [{ htmlrtf: false, ignore: false, htmltag: false, uc: 1 }];
  const out: string[] = [];
  // Bytes emitted in the message codepage are buffered so that multi-byte
  // encodings survive; they are flushed whenever a Unicode escape or the end
  // of the stream forces the issue.
  let pending: number[] = [];
  let starPending = false;
  /** After \uN we must swallow the ANSI fallback characters that follow. */
  let skipChars = 0;

  const top = (): RtfGroup => stack[stack.length - 1];
  const emitting = (): boolean => {
    const g = top();
    return !g.ignore && (g.htmltag || !g.htmlrtf);
  };
  const flush = () => {
    if (pending.length === 0) return;
    out.push(decodeBytes(new Uint8Array(pending), label));
    pending = [];
  };
  const pushByte = (b: number) => {
    if (emitting()) pending.push(b);
  };
  const pushText = (s: string) => {
    if (!emitting()) return;
    flush();
    out.push(s);
  };

  const isAlpha = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
  const isDigit = (c: number) => c >= 48 && c <= 57;
  const hexVal = (c: number): number => {
    if (isDigit(c)) return c - 48;
    if (c >= 97 && c <= 102) return c - 87;
    if (c >= 65 && c <= 70) return c - 55;
    return -1;
  };

  let i = 0;
  const n = rtf.length;
  while (i < n) {
    const c = rtf[i];

    if (c === 0x7b /* { */) {
      flush();
      const g = top();
      stack.push({ htmlrtf: g.htmlrtf, ignore: g.ignore, htmltag: false, uc: g.uc });
      starPending = false;
      i++;
      continue;
    }
    if (c === 0x7d /* } */) {
      flush();
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }
    if (c === 0x0d || c === 0x0a) {
      // Raw line breaks in the RTF source are formatting, not content.
      i++;
      continue;
    }
    if (c !== 0x5c /* \ */) {
      if (skipChars > 0) {
        skipChars--;
      } else {
        pushByte(c);
      }
      i++;
      continue;
    }

    // A control sequence.
    i++;
    if (i >= n) break;
    const c1 = rtf[i];

    if (!isAlpha(c1)) {
      i++;
      switch (c1) {
        case 0x27: {
          // \'hh -- one byte in the current codepage.
          const h1 = i < n ? hexVal(rtf[i]) : -1;
          const h2 = i + 1 < n ? hexVal(rtf[i + 1]) : -1;
          if (h1 >= 0 && h2 >= 0) {
            i += 2;
            if (skipChars > 0) skipChars--;
            else pushByte((h1 << 4) | h2);
          }
          break;
        }
        case 0x5c: // \\
        case 0x7b: // \{
        case 0x7d: // \}
          if (skipChars > 0) skipChars--;
          else pushByte(c1);
          break;
        case 0x2a: // \* -- the next control word names an ignorable destination
          starPending = true;
          break;
        case 0x7e: // \~ nonbreaking space
          pushText(" ");
          break;
        case 0x5f: // \_ nonbreaking hyphen
          pushText("‑");
          break;
        case 0x2d: // \- optional hyphen: contributes nothing
          break;
        case 0x0d:
        case 0x0a:
          pushText("\r\n");
          break;
        default:
          break;
      }
      continue;
    }

    // \word, optionally followed by a (possibly negative) numeric parameter
    // and then a single space that acts purely as a delimiter.
    let word = "";
    while (i < n && isAlpha(rtf[i])) {
      word += String.fromCharCode(rtf[i]);
      i++;
    }
    let param: number | undefined;
    let negative = false;
    if (i < n && rtf[i] === 0x2d) {
      negative = true;
      i++;
    }
    if (i < n && isDigit(rtf[i])) {
      let digits = "";
      while (i < n && isDigit(rtf[i])) {
        digits += String.fromCharCode(rtf[i]);
        i++;
      }
      param = parseInt(digits, 10);
      if (negative) param = -param;
    }
    if (i < n && rtf[i] === 0x20) i++; // the delimiter space is not content

    if (starPending) {
      starPending = false;
      if (word === "htmltag") {
        top().htmltag = true;
      } else {
        top().ignore = true;
        continue;
      }
    }

    switch (word) {
      case "htmlrtf":
        top().htmlrtf = param !== 0;
        continue;
      case "htmltag":
        top().htmltag = true;
        continue;
      case "uc":
        if (param !== undefined && param >= 0) top().uc = param;
        continue;
      case "u": {
        if (param === undefined) continue;
        // RTF writes code units, and signed ones at that.
        const code = param < 0 ? param + 65536 : param;
        pushText(String.fromCharCode(code));
        skipChars = top().uc;
        continue;
      }
      case "bin": {
        // \binN is followed by N raw bytes that are not RTF at all.
        const len = param && param > 0 ? param : 0;
        i += len;
        continue;
      }
      case "fromhtml":
      case "fromtext":
        continue;
    }

    const sym = SYMBOL_TEXT[word];
    if (sym !== undefined) {
      pushText(sym);
      continue;
    }

    if (SKIP_DESTINATIONS.has(word)) {
      top().ignore = true;
      continue;
    }
    // Any other control word is formatting we do not care about.
  }
  flush();

  const joined = out.join("");
  if (encapsulatedHtml) {
    const html = joined.trim();
    return html
      ? { html, text: htmlToRoughText(html), encapsulatedHtml: true }
      : { text: "", encapsulatedHtml: true };
  }
  return { text: joined.replace(/\r\n/g, "\n").trim(), encapsulatedHtml: false };
}

/**
 * A crude HTML-to-text reduction, used only to give a message *some* plain
 * text when the only body we recovered is HTML. The real rendering path
 * sanitises and displays the HTML; this exists for search and previews.
 */
function htmlToRoughText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
