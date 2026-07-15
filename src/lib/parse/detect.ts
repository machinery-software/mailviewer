import type { SourceFormat } from "../model";

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const PST_MAGIC = [0x21, 0x42, 0x44, 0x4e]; // "!BDN"
const TNEF_MAGIC = [0x78, 0x9f, 0x3e, 0x22]; // 0x223E9F78, little-endian
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04" -- a local file header
// Lotus Notes .nsf/.ntf databases open with this fixed prefix. We only use it to
// recognise the format well enough to decline it helpfully.
const NSF_MAGIC = [0x1a, 0x00, 0x00, 0x04];

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
  const lower = filename.toLowerCase();

  if (startsWith(head, CFB_MAGIC)) {
    // An Outlook template (.oft) is a compound file identical in shape to a
    // .msg -- same MAPI property store -- so it parses through the same path.
    // The only thing distinguishing the two is the extension.
    return lower.endsWith(".oft") ? "oft" : "msg";
  }
  // A bare winmail.dat. Normally TNEF arrives as an attachment inside an .eml
  // and is expanded there, but people do save the thing to disk and open it.
  if (startsWith(head, TNEF_MAGIC)) return "tnef";
  // An Outlook for Mac archive (.olm) is a ZIP. Require the extension too: a
  // bare ZIP of anything else is not an archive we know how to read.
  if (startsWith(head, ZIP_MAGIC) && lower.endsWith(".olm")) return "olm";
  if (startsWith(head, PST_MAGIC)) {
    return lower.endsWith(".ost") ? "ost" : "pst";
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

  // MHTML web archive: MIME, so postal-mime parses the container. It is still an
  // .eml at heart -- the "mht" tag only tells the eml path to recover the
  // Content-Location links that MHTML uses in place of cid:. Gate on the
  // extension plus the tell-tale MIME-Version header and either a
  // multipart/related content type or the "From: <Saved by ...>" line browsers
  // and Word write at the top of a saved page.
  if (
    (lower.endsWith(".mht") || lower.endsWith(".mhtml")) &&
    /^mime-version:/im.test(text) &&
    (/^content-type:\s*multipart\/related/im.test(text) ||
      /^from:\s*<?saved by/im.test(text))
  ) {
    return "mht";
  }

  // mbox: the archive begins with a "From " separator line (note: "From "
  // with a space -- "From:" is a header and means we're looking at a bare EML).
  if (/^From \S+.*\r?\n/.test(text)) return "mbox";

  if (lower.endsWith(".mbox") || lower.endsWith(".mbx")) return "mbox";

  // Anything else with a plausible header block is a single RFC822 message.
  return "eml";
}

/**
 * Some formats we recognise only to refuse them, on purpose. Lotus Notes .nsf
 * and Outlook Express .dbx are proprietary, undocumented and effectively dead;
 * there is no honest way to read them in a browser. Rather than fail with a
 * confusing generic error, spot them up front and hand back copy that tells the
 * user what actually happened and what to do about it.
 *
 * Returns the user-facing message, or null when the file is not one of these.
 */
export function declineObsoleteFormat(head: Uint8Array, filename: string): string | null {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".nsf") || lower.endsWith(".ntf") || startsWith(head, NSF_MAGIC)) {
    return (
      "This is a Lotus Notes / HCL Notes database (.nsf). It is a closed, " +
      "proprietary format with no published specification, and Notes is the only " +
      "software that can read one reliably — so this viewer can't open it. Open " +
      "the database in HCL Notes (or IBM/Lotus Notes), select the mail you want, " +
      "and export it to .eml or .mbox. Those files open here."
    );
  }

  if (lower.endsWith(".dbx")) {
    return (
      "This is an Outlook Express message store (.dbx). Outlook Express was " +
      "discontinued in 2006, the format was never documented, and no current mail " +
      "client writes it — so this viewer can't open it. If you still have Outlook " +
      "Express or Windows Mail, drag the messages out to a folder as .eml files " +
      "and open those here instead."
    );
  }

  return null;
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
