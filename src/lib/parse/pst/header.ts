/**
 * MS-PST 2.2.2.6 HEADER, plus the ROOT it embeds (2.2.2.5).
 *
 * The field *order* differs between ANSI and Unicode, not just the field
 * widths, so the two layouts are spelled out separately rather than derived
 * from a width parameter.
 */
import type { ByteReader } from "./reader.ts";
import { u16, u32, u64, u8 } from "./reader.ts";
import { NDB_CRYPT_EDPCRYPTED } from "./crypt.ts";

/** A BID/IB pair: "block N lives at file offset M". MS-PST 2.2.2.4. */
export interface Bref {
  bid: bigint;
  ib: number;
}

export interface PstHeader {
  /** Unicode (64-bit) layout when true, ANSI (32-bit) when false. */
  isUnicode: boolean;
  /** wVer as found: 14/15 = ANSI, >=23 = Unicode. */
  ver: number;
  /** bCryptMethod: 0 none, 1 permute, 2 cyclic. */
  cryptMethod: number;
  /** Root of the node BTree. */
  nbtRoot: Bref;
  /** Root of the block BTree. */
  bbtRoot: Bref;
  /** ibFileEof from ROOT -- the logical end of the file. */
  fileEof: number;
}

const MAGIC = [0x21, 0x42, 0x44, 0x4e]; // "!BDN"

/** Header is 564 bytes for Unicode, 512 for ANSI. Read the larger and slice. */
const HEADER_READ = 564;

function bref(b: Uint8Array, off: number, isUnicode: boolean): Bref {
  if (isUnicode) {
    return { bid: u64(b, off), ib: Number(u64(b, off + 8)) };
  }
  return { bid: BigInt(u32(b, off)), ib: u32(b, off + 4) };
}

export async function readHeader(reader: ByteReader): Promise<PstHeader> {
  const b = await reader.readAt(0, HEADER_READ);

  if (b.length < 24) {
    throw new Error("Not a PST/OST file: the file is too short to contain a header.");
  }
  for (let i = 0; i < 4; i++) {
    if (b[i] !== MAGIC[i]) {
      throw new Error(
        "Not a PST/OST file: expected the magic bytes !BDN at offset 0. " +
          "This looks like a different format entirely.",
      );
    }
  }

  const ver = u16(b, 10);

  // Per MS-PST: 14 or 15 => ANSI; anything >= 23 => Unicode. There is no
  // separate "v36" layout -- 36 is just a later Unicode build stamp and parses
  // identically to 23. Version 37 additionally signals that the file *may* be
  // WIP-protected, which we detect below via bCryptMethod rather than via wVer.
  let isUnicode: boolean;
  if (ver === 14 || ver === 15) {
    isUnicode = false;
  } else if (ver >= 23) {
    isUnicode = true;
  } else {
    throw new Error(
      `Unsupported PST format version ${ver}. Expected 14/15 (ANSI) or >=23 (Unicode).`,
    );
  }

  if (isUnicode && b.length < 564) {
    throw new Error("Truncated PST: the Unicode header needs 564 bytes.");
  }
  if (!isUnicode && b.length < 512) {
    throw new Error("Truncated PST: the ANSI header needs 512 bytes.");
  }

  const cryptMethod = isUnicode ? u8(b, 513) : u8(b, 461);

  if (cryptMethod === NDB_CRYPT_EDPCRYPTED) {
    throw new Error(
      "This file is protected with Windows Information Protection (NDB_CRYPT_EDPCRYPTED). " +
        "Its contents are genuinely encrypted and cannot be read without the enterprise key.",
    );
  }

  // ROOT: at 180 (Unicode, 72 bytes) or 164 (ANSI, 40 bytes).
  const rootOff = isUnicode ? 180 : 164;

  let fileEof: number;
  let nbtRoot: Bref;
  let bbtRoot: Bref;

  if (isUnicode) {
    fileEof = Number(u64(b, rootOff + 4));
    nbtRoot = bref(b, rootOff + 36, true);
    bbtRoot = bref(b, rootOff + 52, true);
  } else {
    fileEof = u32(b, rootOff + 4);
    nbtRoot = bref(b, rootOff + 20, false);
    bbtRoot = bref(b, rootOff + 28, false);
  }

  return { isUnicode, ver, cryptMethod, nbtRoot, bbtRoot, fileEof };
}
