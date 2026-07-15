import type { SourceFormat } from "../model";

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const PST_MAGIC = [0x21, 0x42, 0x44, 0x4e]; // "!BDN"
const TNEF_MAGIC = [0x78, 0x9f, 0x3e, 0x22]; // 0x223E9F78, little-endian

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

/**
 * Identify a file by content, not by extension.
 *
 * Extensions lie constantly in this domain: people rename .msg to .eml, mail
 * clients hand you .eml files that are really mbox archives with one message,
 * and .ost is byte-identical to .pst at the header. Sniffing the magic bytes is
 * both more reliable and the only thing that works for a drag-and-dropped file
 * with no extension at all.
 */
export function detectFormat(head: Uint8Array, filename: string): SourceFormat {
  if (startsWith(head, CFB_MAGIC)) return "msg";
  // A bare winmail.dat. Normally TNEF arrives as an attachment inside an .eml
  // and is expanded there, but people do save the thing to disk and open it.
  if (startsWith(head, TNEF_MAGIC)) return "tnef";
  if (startsWith(head, PST_MAGIC)) {
    return filename.toLowerCase().endsWith(".ost") ? "ost" : "pst";
  }

  // Apple Mail .emlx: the file opens with a decimal byte-count line, then the
  // RFC822 message, then a plist. Recognise the leading integer line.
  if (/^\s*\d+\s*\r?\n/.test(latin1(head.subarray(0, 24)))) {
    // Only trust this if what follows actually looks like a header line, so we
    // don't misfire on some other text file that happens to start with a number.
    const text = latin1(head.subarray(0, 512));
    const afterFirstLine = text.slice(text.indexOf("\n") + 1);
    if (/^[A-Za-z-]+:\s/.test(afterFirstLine)) return "emlx";
  }

  const text = latin1(head.subarray(0, 2048));

  // mbox: the archive begins with a "From " separator line (note: "From "
  // with a space -- "From:" is a header and means we're looking at a bare EML).
  if (/^From \S+.*\r?\n/.test(text)) return "mbox";

  const lower = filename.toLowerCase();
  if (lower.endsWith(".mbox") || lower.endsWith(".mbx")) return "mbox";

  // Anything else with a plausible header block is a single RFC822 message.
  return "eml";
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
