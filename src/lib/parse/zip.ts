/**
 * A ZIP reader that never unzips the whole file.
 *
 * An Outlook for Mac export (.olm) is a ZIP that can run to many gigabytes. The
 * archive's own index -- the central directory at the end of the file -- says
 * where every entry starts and how big it is, so this reads that index first,
 * through Blob.slice(), and then reads and inflates one entry at a time when
 * asked. Nothing else is held in memory.
 *
 * Plain ECMAScript plus Blob: no DOM, no DecompressionStream, no Node APIs. The
 * same code runs in the browser's parse worker and in the Mac app's parse
 * service, whose JavaScriptCore host supplies only Blob, TextDecoder and
 * TextEncoder. Inflating is fflate's synchronous inflate, which is plain JS.
 *
 * Understands ZIP64, which is what an archive past 4 GB or 65,535 entries uses.
 * Refuses encrypted entries and compression methods other than stored and
 * deflate, which is everything Outlook writes.
 */
import { inflateSync } from "fflate";

export interface ZipEntry {
  /** The path inside the archive, as stored ("/"-separated). */
  name: string;
  /** 0 stored, 8 deflate. */
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** End-of-central-directory record (22 bytes) plus the longest comment allowed. */
const TAIL = 22 + 0xffff;

async function read(file: Blob, start: number, end: number): Promise<DataView> {
  const buf = await file.slice(start, end).arrayBuffer();
  return new DataView(buf);
}

const u64 = (dv: DataView, at: number): number => {
  const v = dv.getUint32(at, true) + dv.getUint32(at + 4, true) * 0x100000000;
  if (!Number.isSafeInteger(v)) throw new ZipError("A ZIP64 size or offset too large to address");
  return v;
};

const utf8 = new TextDecoder("utf-8");

/**
 * Read the archive's index. Throws ZipError when there is none, which is what
 * a file cut short in copying looks like: the index is the last thing written.
 */
export async function readZipIndex(file: Blob): Promise<ZipEntry[]> {
  const size = file.size;
  if (size < 22) throw new ZipError("The file is too short to be a ZIP archive");

  const tailStart = Math.max(0, size - TAIL);
  const tail = await read(file, tailStart, size);
  let eocd = -1;
  for (let p = tail.byteLength - 22; p >= 0; p--) {
    if (tail.getUint32(p, true) === SIG_EOCD) {
      // A real record's comment runs exactly to the end of the file. Checking
      // that keeps a stray signature inside the comment from being taken.
      if (p + 22 + tail.getUint16(p + 20, true) === tail.byteLength) {
        eocd = p;
        break;
      }
    }
  }
  if (eocd === -1) {
    throw new ZipError("The archive's index is missing from the end of the file");
  }

  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);
  const eocdAbs = tailStart + eocd;

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64: a locator sits immediately before the classic record and points
    // at the 64-bit one.
    if (eocdAbs < 20) throw new ZipError("A ZIP64 archive without its ZIP64 locator");
    const loc = await read(file, eocdAbs - 20, eocdAbs);
    if (loc.getUint32(0, true) !== SIG_ZIP64_LOCATOR) {
      throw new ZipError("A ZIP64 archive without its ZIP64 locator");
    }
    const at = u64(loc, 8);
    if (at + 56 > eocdAbs) throw new ZipError("The ZIP64 index points outside the file");
    const z = await read(file, at, at + 56);
    if (z.getUint32(0, true) !== SIG_ZIP64_EOCD) throw new ZipError("The ZIP64 index record is damaged");
    count = u64(z, 32);
    cdSize = u64(z, 40);
    cdOffset = u64(z, 48);
  }

  if (cdOffset + cdSize > eocdAbs) {
    throw new ZipError("The archive's index points past the end of the file");
  }

  const cd = await read(file, cdOffset, cdOffset + cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== SIG_CENTRAL) {
      throw new ZipError(`The archive's index is damaged at entry ${k + 1} of ${count}`);
    }
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    const crc32 = cd.getUint32(p + 16, true);
    let compressedSize = cd.getUint32(p + 20, true);
    let entrySize = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let localHeaderOffset = cd.getUint32(p + 42, true);
    const nameStart = p + 46;
    if (nameStart + nameLen + extraLen + commentLen > cd.byteLength) {
      throw new ZipError(`The archive's index is damaged at entry ${k + 1} of ${count}`);
    }
    const name = utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + nameStart, nameLen));

    // ZIP64 extended information: present only for the fields that overflowed,
    // in this fixed order.
    let x = nameStart + nameLen;
    const extraEnd = x + extraLen;
    while (x + 4 <= extraEnd) {
      const id = cd.getUint16(x, true);
      const len = cd.getUint16(x + 2, true);
      if (id === 0x0001) {
        let f = x + 4;
        const fEnd = f + len;
        if (entrySize === 0xffffffff && f + 8 <= fEnd) {
          entrySize = u64(cd, f);
          f += 8;
        }
        if (compressedSize === 0xffffffff && f + 8 <= fEnd) {
          compressedSize = u64(cd, f);
          f += 8;
        }
        if (localHeaderOffset === 0xffffffff && f + 8 <= fEnd) localHeaderOffset = u64(cd, f);
      }
      x += 4 + len;
    }

    entries.push({ name, method, flags, crc32, compressedSize, size: entrySize, localHeaderOffset });
    p = extraEnd + commentLen;
  }
  return entries;
}

let CRC_TABLE: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Read and decompress one entry. Throws ZipError on any damage. */
export async function readZipEntry(file: Blob, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.flags & 0x0001) throw new ZipError(`${entry.name} is encrypted`);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipError(`${entry.name} uses compression method ${entry.method}, which is not supported`);
  }
  const at = entry.localHeaderOffset;
  if (at + 30 > file.size) throw new ZipError(`${entry.name} starts past the end of the file`);
  const local = await read(file, at, at + 30);
  if (local.getUint32(0, true) !== SIG_LOCAL) throw new ZipError(`${entry.name}: its local header is damaged`);
  const dataStart = at + 30 + local.getUint16(26, true) + local.getUint16(28, true);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > file.size) throw new ZipError(`${entry.name} runs past the end of the file`);

  const data = new Uint8Array(await file.slice(dataStart, dataEnd).arrayBuffer());
  let out: Uint8Array;
  if (entry.method === 0) {
    out = data;
  } else {
    try {
      out = inflateSync(data);
    } catch (err) {
      throw new ZipError(`${entry.name}: its compressed data is damaged (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (out.byteLength !== entry.size || crc32(out) !== entry.crc32) {
    throw new ZipError(`${entry.name}: its contents fail the archive's checksum`);
  }
  return out;
}
