import type { SourceFormat } from "./model";
import { BUILD, SUPPORT_EMAIL } from "../config";

/**
 * Everything a bug report is allowed to know.
 *
 * This type is the enforcement mechanism, not documentation. A report is
 * assembled from *this* and nothing else, so there is no code path by which a
 * subject line, a filename, an address or a byte of someone's mail can reach a
 * prefilled message -- the builder is never handed one to begin with.
 *
 * `format` is the one thing carried over from the file, and it is a fixed
 * keyword from a closed set ("pst", "eml", ...), not text taken from the file.
 * Users of this tool are often handling privileged or evidentiary mail; a
 * leaked filename in a mailto: body would be a real breach, so the safe design
 * is one where leaking is not expressible.
 */
export interface ReportContext {
  /** The mail format involved, when one is known. */
  format?: SourceFormat;
  /** Whether the report was started from a failure or from the ordinary link. */
  failed?: boolean;
}

/**
 * The format keyword implied by a filename's extension, or undefined.
 *
 * A filename goes in and a keyword from a closed set comes out -- never a
 * substring of the input. That asymmetry is the point: the failure path knows
 * the name of the file it could not open, and this is the only thing it is
 * allowed to learn from it.
 *
 * This is a weaker signal than detect.ts's magic-byte sniffing, which is
 * unavailable here precisely because the file failed to get that far.
 */
export function formatFromFilename(name: string): SourceFormat | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith("winmail.dat")) return "tnef";
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  const table: Record<string, SourceFormat> = {
    eml: "eml", emlx: "emlx", msg: "msg", oft: "oft",
    mbox: "mbox", mbx: "mbox", pst: "pst", ost: "ost",
    olm: "olm", mht: "mht", mhtml: "mht",
  };
  return table[ext];
}

/**
 * A short, human-readable browser and OS guess from a user-agent string.
 *
 * Deliberately coarse. The point is to tell a maintainer "Firefox on Windows"
 * so a rendering bug can be reproduced -- not to fingerprint anybody. Returns
 * the raw string only when nothing is recognised, since an unknown browser is
 * exactly the case where the detail matters.
 */
export function describePlatform(ua: string): string {
  if (!ua.trim()) return "unknown";

  const os =
    /Windows NT 10/.test(ua) ? "Windows"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Linux/.test(ua) ? "Linux"
    : null;

  // Order matters: every Chromium browser also claims "Safari", and Edge and
  // Opera both claim "Chrome", so the most specific brand has to win first.
  const browser =
    /Edg\//.test(ua) ? match(ua, /Edg\/(\d+)/, "Edge")
    : /OPR\//.test(ua) ? match(ua, /OPR\/(\d+)/, "Opera")
    : /Firefox\//.test(ua) ? match(ua, /Firefox\/(\d+)/, "Firefox")
    : /Chrome\//.test(ua) ? match(ua, /Chrome\/(\d+)/, "Chrome")
    : /Safari\//.test(ua) ? match(ua, /Version\/(\d+)/, "Safari")
    : null;

  if (!browser && !os) return ua.slice(0, 120);
  return [browser, os].filter(Boolean).join(" on ");
}

function match(ua: string, re: RegExp, name: string): string {
  const m = ua.match(re);
  return m ? `${name} ${m[1]}` : name;
}

/** The diagnostic block appended to a report. Contains no file-derived data. */
export function reportDiagnostics(ctx: ReportContext, ua: string): string {
  return [
    `Build: ${BUILD.version} (${BUILD.commit})`,
    `Browser: ${describePlatform(ua)}`,
    `File format: ${ctx.format ?? "not known"}`,
  ].join("\n");
}

export const NO_ATTACHMENTS_NOTE =
  "Please don't attach the mail file — it may be privileged or evidentiary, " +
  "and we don't need it. A description of what you saw is more useful.";

/**
 * A `mailto:` URL with the subject and a diagnostic block prefilled.
 *
 * mailto: rather than a form because a form would have to POST somewhere, and
 * `connect-src 'none'` means this page cannot send anything anywhere. That is
 * the guarantee working as designed, not a gap in it.
 */
export function reportMailto(ctx: ReportContext, ua: string): string {
  const subject = ctx.failed
    ? "Mailviewer: a file failed to open"
    : "Mailviewer: bug report";

  const body = [
    "What happened:",
    "",
    "",
    "What you expected instead:",
    "",
    "",
    NO_ATTACHMENTS_NOTE,
    "",
    "--- diagnostics (no message data) ---",
    reportDiagnostics(ctx, ua),
  ].join("\n");

  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
