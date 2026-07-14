/**
 * Windows codepage -> TextDecoder, shared by everything that has to decode
 * 8-bit MAPI text.
 *
 * Kept apart from the format parsers because both the .msg property store and
 * the RTF de-encapsulator need it, and neither owns it.
 */

/**
 * TextDecoder implements the WHATWG encoding set, which covers every legacy
 * codepage Outlook realistically emits; anything outside it falls back to
 * windows-1252, which is also what Outlook itself assumes when a message lies
 * about its charset.
 */
const CODEPAGE_LABELS: Record<number, string> = {
  437: "ibm866", // not exact, but the closest single-byte page TextDecoder has
  708: "iso-8859-6",
  720: "iso-8859-6",
  737: "iso-8859-7",
  775: "iso-8859-4",
  850: "windows-1252",
  852: "iso-8859-2",
  855: "iso-8859-5",
  857: "iso-8859-9",
  860: "windows-1252",
  861: "iso-8859-1",
  862: "iso-8859-8",
  863: "windows-1252",
  865: "iso-8859-1",
  866: "ibm866",
  869: "iso-8859-7",
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1200: "utf-16le",
  1201: "utf-16be",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  10000: "macintosh",
  10007: "x-mac-cyrillic",
  20127: "windows-1252", // US-ASCII; 1252 is a superset
  20866: "koi8-r",
  21866: "koi8-u",
  28591: "windows-1252", // ISO-8859-1; browsers alias it to 1252 anyway
  28592: "iso-8859-2",
  28593: "iso-8859-3",
  28594: "iso-8859-4",
  28595: "iso-8859-5",
  28596: "iso-8859-6",
  28597: "iso-8859-7",
  28598: "iso-8859-8",
  28599: "iso-8859-9",
  28603: "iso-8859-13",
  28605: "iso-8859-15",
  50220: "iso-2022-jp",
  50221: "iso-2022-jp",
  50222: "iso-2022-jp",
  51932: "euc-jp",
  51936: "gbk",
  51949: "euc-kr",
  52936: "gbk",
  54936: "gb18030",
  65000: "utf-8", // UTF-7; TextDecoder cannot do it, and 8 is the safer guess
  65001: "utf-8",
};

export function codepageToLabel(cp: number | undefined): string {
  if (!cp) return "windows-1252";
  return CODEPAGE_LABELS[cp] ?? "windows-1252";
}

const decoderCache = new Map<string, TextDecoder>();

export function decodeBytes(bytes: Uint8Array, label: string): string {
  let dec = decoderCache.get(label);
  if (!dec) {
    try {
      dec = new TextDecoder(label);
    } catch {
      dec = new TextDecoder("windows-1252");
    }
    decoderCache.set(label, dec);
  }
  return dec.decode(bytes);
}
