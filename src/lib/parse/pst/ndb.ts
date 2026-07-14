/**
 * NDB layer (MS-PST section 2.2.2): the node/block database underneath
 * everything else.
 *
 * Two BTrees sit on top of the raw file:
 *   NBT  nid -> (data block, subnode block)
 *   BBT  bid -> (file offset, byte count)
 *
 * Both are descended lazily. We never materialise either tree: a lookup walks
 * from the root page down, and only the 512-byte pages actually touched are
 * read (and cached). That is what keeps a 10 GB PST inside a Worker's memory
 * budget.
 *
 * Above the raw blocks sit two composite structures, both of which this module
 * flattens for callers:
 *   - data trees: XBLOCK / XXBLOCK indirection, so a logical stream can exceed
 *     the 8176-byte block payload limit.
 *   - subnode BTrees: SLBLOCK / SIBLOCK, mapping a nid to nested data.
 */
import type { ByteReader } from "./reader.ts";
import type { Bref, PstHeader } from "./header.ts";
import { Lru, u16, u32, u64, u8 } from "./reader.ts";
import { decodeBlock, NDB_CRYPT_NONE } from "./crypt.ts";

/** Every page in a PST is exactly 512 bytes, in both ANSI and Unicode. */
const PAGE_SIZE = 512;

/** Largest payload a single data block can carry. */
export const MAX_BLOCK_DATA = 8176;

const PTYPE_BBT = 0x80;
const PTYPE_NBT = 0x81;

export interface NodeEntry {
  nid: number;
  bidData: bigint;
  bidSub: bigint;
  nidParent: number;
}

export interface BlockEntry {
  bid: bigint;
  ib: number;
  cb: number;
}

/** One entry in a node's subnode BTree. Subnodes can nest (bidSub again). */
export interface SubnodeEntry {
  nid: number;
  bidData: bigint;
  bidSub: bigint;
}

/** Raised for structural damage. Callers downgrade these to warnings. */
export class PstDataError extends Error {}

/** BIDs carry a reserved low bit that must be cleared before any lookup. */
function bidKey(bid: bigint): bigint {
  return bid & ~1n;
}

/** Bit 1 marks an internal (never-encoded) block: XBLOCK/XXBLOCK/SL/SI. */
function isInternalBid(bid: bigint): boolean {
  return (bid & 2n) !== 0n;
}

export class Ndb {
  private readonly pageCache: Lru<number, Uint8Array>;
  private readonly blockCache: Lru<string, Uint8Array[]>;

  constructor(
    private readonly reader: ByteReader,
    readonly header: PstHeader,
  ) {
    // ~1000 pages = 512KB, which comfortably holds the upper levels of both
    // BTrees for a very large file.
    this.pageCache = new Lru(1000);
    // Small block cache; heap nodes get hit repeatedly while a message is built.
    this.blockCache = new Lru(64);
  }

  private get isUnicode(): boolean {
    return this.header.isUnicode;
  }

  private get blockTrailerSize(): number {
    return this.isUnicode ? 16 : 12;
  }

  private async readPage(ib: number): Promise<Uint8Array> {
    const hit = this.pageCache.get(ib);
    if (hit) return hit;
    if (ib < 0 || ib + PAGE_SIZE > this.reader.size) {
      throw new PstDataError(`page offset ${ib} is outside the file`);
    }
    const page = await this.reader.readAt(ib, PAGE_SIZE);
    if (page.length < PAGE_SIZE) {
      throw new PstDataError(`short read for page at ${ib}`);
    }
    this.pageCache.set(ib, page);
    return page;
  }

  // ---------------------------------------------------------------- BTrees

  /**
   * Descends a BTree page to the leaf entry whose key matches `key`.
   *
   * BTPAGE puts its bookkeeping at the tail of the 512-byte page: cEnt, cbEnt
   * and cLevel live just before the page trailer. cLevel > 0 means the entries
   * are BTENTRY (key + BREF) and we recurse; cLevel == 0 means we are at the
   * leaves.
   */
  private async btreeFind(root: Bref, key: bigint, wantNbt: boolean): Promise<Uint8Array | null> {
    const keyLen = this.isUnicode ? 8 : 4;
    const metaOff = this.isUnicode ? 488 : 496;

    let ib = root.ib;
    // A BTree over a file this size is a handful of levels deep; the bound just
    // stops a corrupt page from spinning us forever.
    for (let depth = 0; depth < 32; depth++) {
      const page = await this.readPage(ib);

      const cEnt = u8(page, metaOff);
      const cbEnt = u8(page, metaOff + 2);
      const cLevel = u8(page, metaOff + 3);

      const ptype = u8(page, this.isUnicode ? 496 : 500);
      const expected = wantNbt ? PTYPE_NBT : PTYPE_BBT;
      if (cLevel === 0 && ptype !== expected) {
        throw new PstDataError(
          `expected a ${wantNbt ? "NBT" : "BBT"} leaf page at ${ib}, found ptype 0x${ptype.toString(16)}`,
        );
      }

      if (cbEnt === 0 || cEnt === 0) return null;
      if (cbEnt * cEnt > metaOff) {
        throw new PstDataError(`BTree page at ${ib} claims ${cEnt} entries of ${cbEnt} bytes`);
      }

      if (cLevel === 0) {
        for (let i = 0; i < cEnt; i++) {
          const off = i * cbEnt;
          const entKey = wantNbt
            ? // NBT leaf: nid occupies 8 bytes in Unicode but only the low 32
              // are meaningful. Mask so a dirty high word cannot break equality.
              BigInt(u32(page, off))
            : bidKey(this.isUnicode ? u64(page, off) : BigInt(u32(page, off)));
          if (entKey === key) return page.subarray(off, off + cbEnt);
        }
        return null;
      }

      // Intermediate: find the last entry whose key is <= the one we want.
      let chosen = -1;
      for (let i = 0; i < cEnt; i++) {
        const off = i * cbEnt;
        const entKey = this.isUnicode ? u64(page, off) : BigInt(u32(page, off));
        const cmp = wantNbt ? entKey & 0xffffffffn : bidKey(entKey);
        if (cmp <= key) chosen = i;
        else break;
      }
      if (chosen < 0) return null;

      // BTENTRY is btkey followed by a BREF (bid then ib).
      const off = chosen * cbEnt + keyLen;
      ib = this.isUnicode ? Number(u64(page, off + 8)) : u32(page, off + 4);
    }
    throw new PstDataError("BTree deeper than 32 levels; refusing to continue");
  }

  async lookupNode(nid: number): Promise<NodeEntry | null> {
    const raw = await this.btreeFind(this.header.nbtRoot, BigInt(nid >>> 0), true);
    if (!raw) return null;
    if (this.isUnicode) {
      return {
        nid: u32(raw, 0),
        bidData: u64(raw, 8),
        bidSub: u64(raw, 16),
        nidParent: u32(raw, 24),
      };
    }
    return {
      nid: u32(raw, 0),
      bidData: BigInt(u32(raw, 4)),
      bidSub: BigInt(u32(raw, 8)),
      nidParent: u32(raw, 12),
    };
  }

  async lookupBlock(bid: bigint): Promise<BlockEntry | null> {
    const key = bidKey(bid);
    const raw = await this.btreeFind(this.header.bbtRoot, key, false);
    if (!raw) return null;
    if (this.isUnicode) {
      return { bid: u64(raw, 0), ib: Number(u64(raw, 8)), cb: u16(raw, 16) };
    }
    return { bid: BigInt(u32(raw, 0)), ib: u32(raw, 4), cb: u16(raw, 8) };
  }

  // ---------------------------------------------------------------- blocks

  /**
   * Reads one physical block and decodes it if it carries user data.
   *
   * On-disk a block is `cb` payload bytes, zero padding up to a 64-byte
   * boundary, then a BLOCKTRAILER. Internal blocks are structural and are
   * stored in the clear; only external (leaf data) blocks are obfuscated.
   */
  private async readRawBlock(bid: bigint): Promise<{ data: Uint8Array; internal: boolean }> {
    const entry = await this.lookupBlock(bid);
    if (!entry) throw new PstDataError(`block ${bid} is not in the BBT`);

    const trailer = this.blockTrailerSize;
    const onDisk = Math.ceil((entry.cb + trailer) / 64) * 64;
    if (entry.cb > MAX_BLOCK_DATA) {
      throw new PstDataError(`block ${bid} claims ${entry.cb} bytes, over the ${MAX_BLOCK_DATA} limit`);
    }
    const buf = await this.reader.readAt(entry.ib, onDisk);
    if (buf.length < entry.cb) {
      throw new PstDataError(`short read for block ${bid} at ${entry.ib}`);
    }

    // Copy: the slice is about to be decoded in place, and callers cache it.
    const data = buf.slice(0, entry.cb);
    const internal = isInternalBid(bid);

    if (!internal && this.header.cryptMethod !== NDB_CRYPT_NONE) {
      decodeBlock(data, this.header.cryptMethod, Number(bidKey(entry.bid) & 0xffffffffn));
    }
    return { data, internal };
  }

  /**
   * Resolves a data tree to its leaf buffers, in order.
   *
   * Returns the *individual* leaves rather than one concatenated buffer, and
   * that is deliberate. Heap-on-Node addresses items by (block index, item
   * index), and Table Context rows are laid out per-block with slack at the end
   * of each block. Both need the block boundaries preserved; flattening first
   * would destroy exactly the information they depend on.
   */
  async readDataTree(bid: bigint): Promise<Uint8Array[]> {
    if (bid === 0n) return [];
    const cacheKey = bid.toString();
    const hit = this.blockCache.get(cacheKey);
    if (hit) return hit;
    const out: Uint8Array[] = [];
    await this.collectDataTree(bid, out, 0);
    this.blockCache.set(cacheKey, out);
    return out;
  }

  private async collectDataTree(bid: bigint, out: Uint8Array[], depth: number): Promise<void> {
    if (depth > 8) throw new PstDataError("data tree nested too deeply");
    if (out.length > 200_000) throw new PstDataError("data tree has an implausible number of blocks");

    const { data, internal } = await this.readRawBlock(bid);

    if (!internal) {
      out.push(data);
      return;
    }

    // XBLOCK (cLevel 1) points at leaves; XXBLOCK (cLevel 2) points at XBLOCKs.
    const btype = u8(data, 0);
    const cLevel = u8(data, 1);
    if (btype !== 0x01) {
      throw new PstDataError(`expected an XBLOCK (btype 1) for bid ${bid}, found btype ${btype}`);
    }
    const cEnt = u16(data, 2);
    const idSize = this.isUnicode ? 8 : 4;
    const base = 8; // btype, cLevel, cEnt, lcbTotal
    if (base + cEnt * idSize > data.length) {
      throw new PstDataError(`XBLOCK ${bid} claims ${cEnt} children but is only ${data.length} bytes`);
    }
    if (cLevel !== 1 && cLevel !== 2) {
      throw new PstDataError(`XBLOCK ${bid} has unexpected level ${cLevel}`);
    }

    for (let i = 0; i < cEnt; i++) {
      const off = base + i * idSize;
      const child = this.isUnicode ? u64(data, off) : BigInt(u32(data, off));
      await this.collectDataTree(child, out, depth + 1);
    }
  }

  /** Convenience: a data tree flattened into one buffer. */
  async readDataFlat(bid: bigint): Promise<Uint8Array> {
    const parts = await this.readDataTree(bid);
    if (parts.length === 1) return parts[0]!;
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  // -------------------------------------------------------------- subnodes

  /** Flattens a node's subnode BTree (SLBLOCK leaves, SIBLOCK internals). */
  async readSubnodes(bidSub: bigint): Promise<Map<number, SubnodeEntry>> {
    const out = new Map<number, SubnodeEntry>();
    if (bidSub === 0n) return out;
    await this.collectSubnodes(bidSub, out, 0);
    return out;
  }

  private async collectSubnodes(
    bid: bigint,
    out: Map<number, SubnodeEntry>,
    depth: number,
  ): Promise<void> {
    if (depth > 8) throw new PstDataError("subnode BTree nested too deeply");

    const { data } = await this.readRawBlock(bid);
    const btype = u8(data, 0);
    const cLevel = u8(data, 1);
    if (btype !== 0x02) {
      throw new PstDataError(`expected an SLBLOCK/SIBLOCK (btype 2) for bid ${bid}, found ${btype}`);
    }
    const cEnt = u16(data, 2);
    // Unicode inserts 4 bytes of padding after cEnt; ANSI does not.
    const base = this.isUnicode ? 8 : 4;

    if (cLevel === 0) {
      const entSize = this.isUnicode ? 24 : 12;
      if (base + cEnt * entSize > data.length) {
        throw new PstDataError(`SLBLOCK ${bid} claims ${cEnt} entries but is ${data.length} bytes`);
      }
      for (let i = 0; i < cEnt; i++) {
        const off = base + i * entSize;
        if (this.isUnicode) {
          const nid = u32(data, off); // stored as 8 bytes, low 32 are the nid
          out.set(nid, { nid, bidData: u64(data, off + 8), bidSub: u64(data, off + 16) });
        } else {
          const nid = u32(data, off);
          out.set(nid, {
            nid,
            bidData: BigInt(u32(data, off + 4)),
            bidSub: BigInt(u32(data, off + 8)),
          });
        }
      }
      return;
    }

    if (cLevel === 1) {
      const entSize = this.isUnicode ? 16 : 8;
      if (base + cEnt * entSize > data.length) {
        throw new PstDataError(`SIBLOCK ${bid} claims ${cEnt} entries but is ${data.length} bytes`);
      }
      for (let i = 0; i < cEnt; i++) {
        const off = base + i * entSize;
        const child = this.isUnicode ? u64(data, off + 8) : BigInt(u32(data, off + 4));
        await this.collectSubnodes(child, out, depth + 1);
      }
      return;
    }

    throw new PstDataError(`subnode block ${bid} has unexpected level ${cLevel}`);
  }
}
