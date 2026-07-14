/**
 * LZFu decompression for PidTagRtfCompressed (MS-OXRTFCP).
 *
 * Outlook stores the RTF body of a message in a compressed form that predates
 * every general-purpose compressor you have heard of. It is LZ77 with a 4096
 * byte ring-buffer dictionary that starts out pre-filled with a 207 byte chunk
 * of boilerplate RTF -- so the most common opening bytes of any RTF document
 * compress to a couple of back-references before a single literal is emitted.
 *
 * Shared with the PST parser: PidTagRtfCompressed appears there too, byte for
 * byte identical. Keep this module free of any MSG/PST specifics.
 */

/** Ring-buffer size. Offsets in a back-reference are 12 bits, hence 4096. */
const DICT_SIZE = 4096;

/**
 * The dictionary is pre-seeded with this exact 207-byte string before
 * decompression starts, and `writeOffset` starts at its end. The bytes are
 * pure ASCII, so a char-code copy is a faithful encoding.
 *
 * Do not "tidy" this string. Every byte -- including the CRLF and the trailing
 * space after `\par` -- is load-bearing: a compressor referenced these exact
 * offsets, and changing one shifts every back-reference in every file.
 */
const PREBUF =
  "{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}" +
  "{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript " +
  "\\fdecor MS Sans SerifSymbolArialTimes New RomanCourier" +
  "{\\colortbl\\red0\\green0\\blue0\r\n\\par " +
  "\\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx";

/** 0x75465a4c, "LZFu" little-endian: the payload is compressed. */
const MAGIC_COMPRESSED = 0x75465a4c;
/** 0x414c454d, "MELA" little-endian: the payload is stored verbatim. */
const MAGIC_UNCOMPRESSED = 0x414c454d;

export class LzfuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LzfuError";
  }
}

/** Byte length of the initial dictionary contents. Exported for tests. */
export const LZFU_PREBUF_SIZE = PREBUF.length;

/**
 * A fresh 4096-byte ring buffer with the prebuffer copied in and the rest left
 * zeroed. Exported so tests can pin the exact bytes of the seed.
 */
export function seedLzfuDictionary(): Uint8Array {
  const dict = new Uint8Array(DICT_SIZE);
  for (let i = 0; i < PREBUF.length; i++) dict[i] = PREBUF.charCodeAt(i) & 0xff;
  return dict;
}

/** The 16-byte header that precedes every compressed RTF stream. */
export interface LzfuHeader {
  /** Size of everything after this field, i.e. `bytes.length - 4` when sane. */
  compressedSize: number;
  /** Size of the decompressed RTF. */
  rawSize: number;
  magic: number;
  crc: number;
  compressed: boolean;
}

export function readLzfuHeader(bytes: Uint8Array): LzfuHeader {
  if (bytes.length < 16) {
    throw new LzfuError(
      `compressed RTF stream is ${bytes.length} bytes, need at least a 16-byte header`,
    );
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(8, true);
  if (magic !== MAGIC_COMPRESSED && magic !== MAGIC_UNCOMPRESSED) {
    throw new LzfuError(
      `unknown compressed-RTF magic 0x${magic.toString(16).padStart(8, "0")}`,
    );
  }
  return {
    compressedSize: dv.getUint32(0, true),
    rawSize: dv.getUint32(4, true),
    magic,
    crc: dv.getUint32(12, true),
    compressed: magic === MAGIC_COMPRESSED,
  };
}

/**
 * Decompress a PidTagRtfCompressed stream into raw RTF bytes.
 *
 * Handles both the compressed ("LZFu") and the stored ("MELA") variants. The
 * output is truncated to the header's `rawSize`, which is authoritative -- a
 * stream can legitimately carry trailing padding inside its last control run.
 */
export function decompressLzfu(bytes: Uint8Array): Uint8Array {
  const header = readLzfuHeader(bytes);

  if (!header.compressed) {
    // "MELA": the RTF follows the header uncompressed. rawSize is still the
    // authority on how much of it is real.
    const end = Math.min(bytes.length, 16 + header.rawSize);
    return bytes.slice(16, end);
  }

  // compressedSize counts itself out: it covers rawSize, magic, crc and the
  // payload. Trust it only as far as the buffer actually goes -- truncated
  // streams are common enough in the wild that dying on them is unhelpful.
  const declaredEnd = 4 + header.compressedSize;
  const end = Math.min(bytes.length, declaredEnd > 16 ? declaredEnd : bytes.length);

  const dict = seedLzfuDictionary();
  let writeOffset = LZFU_PREBUF_SIZE;

  // rawSize is a hint, not a contract: allocate to it but grow if a malformed
  // stream over-produces, and truncate at the end if it under-produces.
  const out: number[] = [];
  const limit = header.rawSize > 0 ? header.rawSize : Number.MAX_SAFE_INTEGER;

  let pos = 16;
  while (pos < end && out.length < limit) {
    const control = bytes[pos++];
    for (let bit = 0; bit < 8; bit++) {
      if (pos >= end || out.length >= limit) break;

      if ((control & (1 << bit)) === 0) {
        // Literal byte: straight through to the output and into the dictionary.
        const b = bytes[pos++];
        out.push(b);
        dict[writeOffset] = b;
        writeOffset = (writeOffset + 1) % DICT_SIZE;
        continue;
      }

      // Back-reference: 12-bit dictionary offset + 4-bit length.
      if (pos + 1 >= end) return finish(out, header.rawSize);
      const hi = bytes[pos++];
      const lo = bytes[pos++];
      const offset = (hi << 4) | (lo >> 4);
      const length = (lo & 0x0f) + 2;

      // A reference pointing at the current write cursor is the documented
      // end-of-stream marker, not a zero-length copy.
      if (offset === writeOffset) return finish(out, header.rawSize);

      let src = offset;
      for (let i = 0; i < length; i++) {
        const b = dict[src % DICT_SIZE];
        src++;
        out.push(b);
        dict[writeOffset] = b;
        writeOffset = (writeOffset + 1) % DICT_SIZE;
      }
    }
  }

  return finish(out, header.rawSize);
}

function finish(out: number[], rawSize: number): Uint8Array {
  const n = rawSize > 0 ? Math.min(out.length, rawSize) : out.length;
  const result = new Uint8Array(n);
  for (let i = 0; i < n; i++) result[i] = out[i];
  return result;
}
