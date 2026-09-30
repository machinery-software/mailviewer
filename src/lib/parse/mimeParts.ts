/**
 * A ceiling on how many MIME parts one message may have.
 *
 * postal-mime's cost grows with the *square* of the number of sibling parts:
 * on every boundary line it revisits every part it has seen so far. A message
 * is cheap to build and expensive to open --
 *
 *     1,000 parts      25 ms
 *     5,000 parts     460 ms
 *    20,000 parts   7,200 ms      (a 740 KB file)
 *   100,000 parts     minutes
 *
 * (Node 24, one text part of one byte each) -- and for the whole of that time
 * the parse worker can do nothing else. So a message with more parts than any
 * real one has is cut off *before* it reaches postal-mime, and the message
 * records that it was (`Message.omittedParts`) so the viewer can say so.
 *
 * Only the bytes handed to the MIME parser are shortened. `Message.raw` keeps
 * the original, so "download original" still gives back the whole file.
 */

/**
 * Generous: a message with a thousand attachments and inline images is already
 * far outside anything a mail client produces, and costs 25 ms.
 */
export const MAX_MIME_PARTS = 1000;

export interface CappedMime {
  /** The message as it should be parsed: the input itself when under the cap. */
  bytes: Uint8Array;
  /** How many parts the message declares in total, when it is over the cap. */
  totalParts: number;
  /** Parts past the cap that were not read. 0 when nothing was cut. */
  omittedParts: number;
}

const DASH = 0x2d;
const LF = 0x0a;

/**
 * Every multipart boundary the message declares, anywhere in it (nested parts
 * and attached messages included).
 *
 * Deliberately broader than the grammar: it is matched against raw text, not
 * parsed headers, so it accepts any spelling postal-mime might -- quoted or
 * bare, any case, folded, RFC 2231 encoded (`boundary*=`) and continued
 * (`boundary*0=`, `boundary*1=`). Finding a boundary that is not really one is
 * harmless; it only matters if a line equal to it occurs over a thousand times.
 */
export function declaredBoundaries(text: string): Set<string> {
  const found = new Set<string>();
  const re = /boundary(\*(\d+)?(\*)?)?\s*=\s*(?:"((?:[^"\\]|\\[\s\S])*)"|([^\s;"]+))/gi;

  const percentDecode = (s: string) => s.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // RFC 2231 extended value: charset'language'percent-encoded
  const extended = (s: string) => {
    const second = s.indexOf("'", s.indexOf("'") + 1);
    return percentDecode(second === -1 ? s : s.slice(second + 1));
  };

  let continued: string | null = null;
  const flush = () => {
    if (continued !== null && continued !== "") found.add(continued);
    continued = null;
  };

  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const [, star, index, encoded, quoted, bare] = m;
    const value = quoted !== undefined ? quoted.replace(/\\([\s\S])/g, "$1") : bare;

    if (star === undefined) {
      flush();
      if (value !== "") found.add(value);
    } else if (index === undefined) {
      // boundary*=utf-8''value
      flush();
      const v = extended(value);
      if (v !== "") found.add(v);
    } else {
      // boundary*0=, boundary*1=, ... : pieces of one value, in order.
      if (index === "0") flush();
      const piece = encoded ? (index === "0" ? extended(value) : percentDecode(value)) : value;
      continued = (continued ?? "") + piece;
    }
  }
  flush();
  return found;
}

/**
 * Cut a message off after its first `max` MIME parts.
 *
 * A "part" here is a delimiter line: `--` followed by a declared boundary. The
 * closing delimiter (`--boundary--`) is not a part. Lines that merely begin
 * with two dashes -- a signature separator, a rule of hyphens, a diff -- are
 * not counted unless they *are* a declared boundary, in which case the MIME
 * parser would have treated them as one too.
 */
export function capMimeParts(bytes: Uint8Array, max = MAX_MIME_PARTS): CappedMime {
  const untouched: CappedMime = { bytes, totalParts: 0, omittedParts: 0 };

  // Pass 1, on the bytes alone: where are the lines that begin "--"? Nearly
  // every message has fewer than `max` of them and is done here.
  const candidates: number[] = [];
  for (let i = 0; i < bytes.length; ) {
    if (bytes[i] === DASH && bytes[i + 1] === DASH) candidates.push(i);
    const nl = bytes.indexOf(LF, i);
    if (nl === -1) break;
    i = nl + 1;
  }
  if (candidates.length <= max) return untouched;

  // Pass 2, only for the rare message that gets here: which of those lines are
  // real delimiters? latin1 maps bytes to characters one for one, so offsets
  // in the text are offsets in the bytes.
  const text = new TextDecoder("latin1").decode(bytes);
  const boundaries = declaredBoundaries(text);
  if (boundaries.size === 0) return untouched;

  let parts = 0;
  let cutAt = -1;
  for (const start of candidates) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    // RFC 2046 allows padding after the boundary; the MIME parser ignores it.
    const line = text.slice(start + 2, end).replace(/[ \t\r]+$/, "");
    if (!boundaries.has(line)) continue;
    parts++;
    if (parts === max + 1) cutAt = start;
  }
  if (cutAt === -1) return untouched;

  return { bytes: bytes.subarray(0, cutAt), totalParts: parts, omittedParts: parts - max };
}

/**
 * What the viewer tells the reader about messages that were cut off at the cap.
 *
 * This is its own sentence, not one of the archive's warnings. Those mean
 * "something here was damaged"; nothing here was. The reader -- who may be
 * about to print the message as a record -- needs to know that what they are
 * looking at is incomplete, by how much, and why.
 *
 * Returns null when no message is over the limit.
 */
export function describeOmittedParts(
  messages: ReadonlyArray<{ subject: string; omittedParts?: { total: number; shown: number } }>,
): string | null {
  const over = messages.filter((m) => m.omittedParts);
  if (over.length === 0) return null;

  const n = (x: number) => x.toLocaleString("en-US");
  const name = (subject: string) => {
    const s = subject.trim();
    if (s === "") return "A message with no subject";
    return `\u201c${s.length > 60 ? `${s.slice(0, 60)}\u2026` : s}\u201d`;
  };
  const limit = n(over[0].omittedParts!.shown);

  if (over.length === 1) {
    const { total } = over[0].omittedParts!;
    return (
      `${name(over[0].subject)} has ${n(total)} MIME parts, which exceeds the ${limit}-part limit. ` +
      `Only the first ${limit} parts are shown; the other ${n(total - over[0].omittedParts!.shown)}, ` +
      "and any attachments among them, are not."
    );
  }

  const listed = over.slice(0, 3).map((m) => name(m.subject));
  const more = over.length - listed.length;
  return (
    `${n(over.length)} messages exceed the ${limit}-part limit. Only the first ${limit} MIME parts of each ` +
    `are shown; later parts, and any attachments among them, are not: ${listed.join(", ")}` +
    `${more > 0 ? ` and ${n(more)} more` : ""}.`
  );
}
