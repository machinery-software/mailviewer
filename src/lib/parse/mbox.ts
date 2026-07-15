import type { Folder, Message, ParsedArchive, ProgressFn } from "../model";
import { parseEmlMessage } from "./eml";

const CHUNK = 8 * 1024 * 1024;

/**
 * mbox stores messages back-to-back, separated by a line beginning "From ".
 * Because that sequence can legitimately occur at the start of a body line, the
 * format escapes it on write by prefixing ">" (">From "), and readers are
 * expected to strip one level of quoting back off. That's mboxrd. We unescape on
 * read; if the file was written as plain mboxo the worst case is a body line
 * that keeps a leading ">", which is cosmetic rather than corrupting.
 */
function unescapeFromLines(bytes: Uint8Array): Uint8Array {
  // Fast path: the escape is rare, so scan first and only rebuild if needed.
  let needsWork = false;
  for (let i = 0; i < bytes.length - 5; i++) {
    if ((i === 0 || bytes[i - 1] === 0x0a) && bytes[i] === 0x3e) {
      let j = i;
      while (j < bytes.length && bytes[j] === 0x3e) j++;
      if (
        bytes[j] === 0x46 && bytes[j + 1] === 0x72 && bytes[j + 2] === 0x6f &&
        bytes[j + 3] === 0x6d && bytes[j + 4] === 0x20
      ) {
        needsWork = true;
        break;
      }
    }
  }
  if (!needsWork) return bytes;

  const out = new Uint8Array(bytes.length);
  let w = 0;
  for (let i = 0; i < bytes.length; i++) {
    const atLineStart = i === 0 || bytes[i - 1] === 0x0a;
    if (atLineStart && bytes[i] === 0x3e) {
      let j = i;
      while (j < bytes.length && bytes[j] === 0x3e) j++;
      const isFrom =
        bytes[j] === 0x46 && bytes[j + 1] === 0x72 && bytes[j + 2] === 0x6f &&
        bytes[j + 3] === 0x6d && bytes[j + 4] === 0x20;
      if (isFrom) {
        // Drop exactly one '>' and copy the rest of the run verbatim.
        for (let k = i + 1; k < j; k++) out[w++] = bytes[k];
        i = j - 1;
        continue;
      }
    }
    out[w++] = bytes[i];
  }
  return out.subarray(0, w);
}

/** True if a "From " separator starts at `i` and `i` is at the start of a line. */
function isSeparatorAt(buf: Uint8Array, i: number): boolean {
  if (i !== 0 && buf[i - 1] !== 0x0a) return false;
  return (
    buf[i] === 0x46 && buf[i + 1] === 0x72 && buf[i + 2] === 0x6f &&
    buf[i + 3] === 0x6d && buf[i + 4] === 0x20
  );
}

/**
 * Split an mbox into message byte-ranges by streaming it in chunks, so a 20 GB
 * Gmail Takeout doesn't have to be resident in memory to be indexed. We only
 * ever hold one chunk plus a small carry-over window at a time.
 */
async function findMessageOffsets(file: Blob, onProgress?: ProgressFn): Promise<number[]> {
  const offsets: number[] = [];
  let position = 0;
  // A separator could straddle a chunk boundary, so carry the last few bytes
  // forward and re-examine them alongside the next chunk.
  const OVERLAP = 8;
  let carry = new Uint8Array(0);
  let carryStart = 0;

  while (position < file.size) {
    const end = Math.min(position + CHUNK, file.size);
    const chunk = new Uint8Array(await file.slice(position, end).arrayBuffer());

    const buf = new Uint8Array(carry.length + chunk.length);
    buf.set(carry, 0);
    buf.set(chunk, carry.length);
    const bufStart = carry.length > 0 ? carryStart : position;

    const limit = end < file.size ? buf.length - OVERLAP : buf.length - 5;
    for (let i = 0; i < limit; i++) {
      if (isSeparatorAt(buf, i)) {
        const abs = bufStart + i;
        // Guard against double-counting a separator seen in the overlap window.
        if (offsets.length === 0 || abs > offsets[offsets.length - 1]) offsets.push(abs);
      }
    }

    if (end < file.size) {
      carry = buf.subarray(buf.length - OVERLAP);
      carryStart = bufStart + buf.length - OVERLAP;
    }
    position = end;

    onProgress?.({
      phase: "Scanning archive",
      fraction: file.size ? position / file.size : null,
      messagesFound: offsets.length,
    });
  }

  return offsets;
}

export async function parseMbox(
  file: Blob,
  name: string,
  onProgress?: ProgressFn,
): Promise<ParsedArchive> {
  const warnings: string[] = [];
  const offsets = await findMessageOffsets(file, onProgress);

  if (offsets.length === 0) {
    throw new Error("No messages found: this file has no mbox 'From ' separator lines.");
  }

  const messages: Message[] = [];
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : file.size;

    try {
      const raw = new Uint8Array(await file.slice(start, end).arrayBuffer());

      // Drop the "From " separator line itself; everything after it is RFC822.
      const nl = raw.indexOf(0x0a);
      const body = nl === -1 ? raw : raw.subarray(nl + 1);

      const message = await parseEmlMessage(
        unescapeFromLines(body),
        `msg-${i}`,
        [name],
        "mbox",
        warnings,
      );
      messages.push(message);
    } catch (err) {
      // One unparseable message must never cost the user the other 40,000.
      warnings.push(
        `Message ${i + 1} (byte offset ${start}) could not be parsed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (i % 25 === 0 || i === offsets.length - 1) {
      onProgress?.({
        phase: "Reading messages",
        fraction: (i + 1) / offsets.length,
        messagesFound: messages.length,
      });
    }
  }

  const root: Folder = {
    id: "root",
    name,
    path: [name],
    children: [],
    messageIds: messages.map((m) => m.id),
  };

  return { sourceName: name, format: "mbox", messages, root, warnings };
}
