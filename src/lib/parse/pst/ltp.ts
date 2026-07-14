/**
 * LTP layer (MS-PST section 2.3): the structures Outlook builds on top of raw
 * nodes.
 *
 *   Heap-on-Node (HN)   a tiny allocator inside a node's data blocks
 *   BTree-on-Heap (BTH) a BTree whose pages are heap allocations
 *   Property Context    a BTH of propId -> value; one MAPI object
 *   Table Context       a row matrix + column descriptors; a list of objects
 */
import type { Ndb, SubnodeEntry } from "./ndb.ts";
import { MAX_BLOCK_DATA, PstDataError } from "./ndb.ts";
import { u16, u32, u8 } from "./reader.ts";
import type { PropEntry, PropValue } from "./props.ts";
import {
  decodeInline,
  decodeObjectRef,
  decodeValue,
  fixedSize,
  hnidIsHid,
  isInlinePc,
  PT_OBJECT,
  PidTagInternetCodepage,
  PidTagMessageCodepage,
  readKey,
} from "./props.ts";

/** Anything that can resolve a heap ID to bytes. Lets BTH be tested standalone. */
export interface HeapLike {
  getItem(hid: number): Uint8Array | null;
}

const HN_SIG = 0xec;

export const HN_CLIENT_TC = 0x7c;
export const HN_CLIENT_PC = 0xbc;

/**
 * Heap-on-Node. MS-PST 2.3.1.
 *
 * A heap item is addressed by an HID carrying a block index and a 1-based item
 * index. Every block in the node carries a page map at the offset named by its
 * first two bytes -- true for the HNHDR of block 0 and for the lighter headers
 * on later blocks alike, which is why we can read ibHnpm uniformly at offset 0.
 */
export class HeapNode implements HeapLike {
  readonly clientSig: number;
  readonly userRoot: number;

  private constructor(
    private readonly blocks: Uint8Array[],
    clientSig: number,
    userRoot: number,
  ) {
    this.clientSig = clientSig;
    this.userRoot = userRoot;
  }

  static async load(ndb: Ndb, bidData: bigint): Promise<HeapNode> {
    const blocks = await ndb.readDataTree(bidData);
    if (blocks.length === 0) throw new PstDataError("heap node has no data blocks");
    const first = blocks[0]!;
    if (first.length < 12) throw new PstDataError("heap node's first block is too small for an HNHDR");
    const sig = u8(first, 2);
    if (sig !== HN_SIG) {
      throw new PstDataError(`bad HNHDR signature 0x${sig.toString(16)}, expected 0xEC`);
    }
    return new HeapNode(blocks, u8(first, 3), u32(first, 4));
  }

  getItem(hid: number): Uint8Array | null {
    if (hid === 0) return null;
    if ((hid & 0x1f) !== 0) return null; // not a heap ID at all

    const idx = (hid >>> 5) & 0x7ff;
    const blockIdx = (hid >>> 16) & 0xffff;
    if (idx === 0) return null;

    const block = this.blocks[blockIdx];
    if (!block) return null;

    const mapOff = u16(block, 0);
    if (mapOff + 4 > block.length) return null;

    const cAlloc = u16(block, mapOff);
    if (idx > cAlloc) return null;

    // rgibAlloc holds cAlloc+1 offsets; item i spans [rgib[i-1], rgib[i]).
    const p = mapOff + 4 + (idx - 1) * 2;
    if (p + 4 > block.length) return null;

    const start = u16(block, p);
    const end = u16(block, p + 2);
    if (end < start || end > block.length) return null;

    return block.subarray(start, end);
  }
}

// ---------------------------------------------------------------- BTH

export interface BthHeader {
  cbKey: number;
  cbEnt: number;
  levels: number;
  hidRoot: number;
}

export function readBthHeader(heap: HeapLike, hid: number): BthHeader | null {
  const b = heap.getItem(hid);
  if (!b || b.length < 8) return null;
  const bType = u8(b, 0);
  if (bType !== 0xb5) {
    throw new PstDataError(`expected a BTH header (0xB5), found 0x${bType.toString(16)}`);
  }
  return { cbKey: u8(b, 1), cbEnt: u8(b, 2), levels: u8(b, 3), hidRoot: u32(b, 4) };
}

export interface BthRecord {
  key: bigint;
  data: Uint8Array;
}

/**
 * Walks every leaf record of a BTH, in key order.
 *
 * Intermediate levels hold (key, hidNextLevel) pairs; leaves hold (key, value).
 * `levels` in the header tells us how many indirections to expect, so we do not
 * have to sniff node types.
 */
export function bthEnumerate(heap: HeapLike, hdr: BthHeader): BthRecord[] {
  const out: BthRecord[] = [];
  if (hdr.hidRoot === 0) return out;
  walk(heap, hdr, hdr.hidRoot, hdr.levels, out);
  return out;
}

function walk(heap: HeapLike, hdr: BthHeader, hid: number, level: number, out: BthRecord[]): void {
  const b = heap.getItem(hid);
  if (!b) return;

  if (level === 0) {
    const recSize = hdr.cbKey + hdr.cbEnt;
    if (recSize === 0) return;
    const n = Math.floor(b.length / recSize);
    for (let i = 0; i < n; i++) {
      const off = i * recSize;
      out.push({
        key: readKey(b, off, hdr.cbKey),
        data: b.subarray(off + hdr.cbKey, off + recSize),
      });
    }
    return;
  }

  const recSize = hdr.cbKey + 4;
  const n = Math.floor(b.length / recSize);
  for (let i = 0; i < n; i++) {
    const off = i * recSize;
    walk(heap, hdr, u32(b, off + hdr.cbKey), level - 1, out);
  }
}

/** Descends a BTH to one key. O(depth) heap fetches rather than a full scan. */
export function bthLookup(heap: HeapLike, hdr: BthHeader, key: bigint): Uint8Array | null {
  let hid = hdr.hidRoot;
  if (hid === 0) return null;

  for (let level = hdr.levels; level > 0; level--) {
    const b = heap.getItem(hid);
    if (!b) return null;
    const recSize = hdr.cbKey + 4;
    const n = Math.floor(b.length / recSize);

    // Last entry whose key is <= the one we want.
    let chosen = -1;
    for (let i = 0; i < n; i++) {
      if (readKey(b, i * recSize, hdr.cbKey) <= key) chosen = i;
      else break;
    }
    if (chosen < 0) return null;
    hid = u32(b, chosen * recSize + hdr.cbKey);
  }

  const b = heap.getItem(hid);
  if (!b) return null;
  const recSize = hdr.cbKey + hdr.cbEnt;
  if (recSize === 0) return null;
  const n = Math.floor(b.length / recSize);
  for (let i = 0; i < n; i++) {
    const off = i * recSize;
    if (readKey(b, off, hdr.cbKey) === key) {
      return b.subarray(off + hdr.cbKey, off + recSize);
    }
  }
  return null;
}

// ---------------------------------------------------------------- HNID

/**
 * Resolves an HNID to bytes: heap item, or a subnode's whole data stream.
 *
 * The subnode path is what makes long message bodies and multi-megabyte
 * attachments work -- they are too big for the heap, so the PC stores a NID and
 * the real payload hangs off the node's subnode BTree as its own data tree.
 */
async function resolveHnid(
  ndb: Ndb,
  heap: HeapLike,
  subnodes: Map<number, SubnodeEntry>,
  hnid: number,
): Promise<Uint8Array | null> {
  if (hnid === 0) return null;
  if (hnidIsHid(hnid)) return heap.getItem(hnid);
  const sub = subnodes.get(hnid);
  if (!sub) return null;
  return ndb.readDataFlat(sub.bidData);
}

// ---------------------------------------------------------------- PC

/**
 * Property Context: the property bag for one MAPI object (message, folder,
 * attachment, recipient).
 */
export class PropertyContext {
  private constructor(
    readonly props: Map<number, PropEntry>,
    readonly codepage: number | undefined,
    readonly subnodes: Map<number, SubnodeEntry>,
  ) {}

  static async load(
    ndb: Ndb,
    bidData: bigint,
    subnodes: Map<number, SubnodeEntry>,
    fallbackCodepage?: number,
  ): Promise<PropertyContext> {
    const heap = await HeapNode.load(ndb, bidData);
    if (heap.clientSig !== HN_CLIENT_PC) {
      throw new PstDataError(
        `expected a Property Context (client sig 0xBC), found 0x${heap.clientSig.toString(16)}`,
      );
    }
    const hdr = readBthHeader(heap, heap.userRoot);
    if (!hdr) return new PropertyContext(new Map(), fallbackCodepage, subnodes);

    const records = bthEnumerate(heap, hdr);

    // Codepage first: PtypString8 values in this same PC are decoded with it,
    // so it has to be known before we decode anything else. It is a PtypInteger32
    // and therefore stored inline, so this pre-pass costs no extra reads.
    let codepage = fallbackCodepage;
    for (const rec of records) {
      const id = Number(rec.key);
      if (id !== PidTagInternetCodepage && id !== PidTagMessageCodepage) continue;
      if (rec.data.length >= 6) {
        const cp = u32(rec.data, 2);
        if (cp > 0) {
          codepage = cp;
          if (id === PidTagInternetCodepage) break; // preferred over message cp
        }
      }
    }

    const props = new Map<number, PropEntry>();
    for (const rec of records) {
      if (rec.data.length < 6) continue;
      const id = Number(rec.key);
      const type = u16(rec.data, 0);
      const dw = u32(rec.data, 2);

      try {
        let value: PropValue;

        if (isInlinePc(type)) {
          value = decodeInline(type, dw);
        } else if (type === PT_OBJECT) {
          // Points at an 8-byte heap item holding (subnode NID, size). This is
          // how an embedded message attachment is referenced.
          const item = heap.getItem(dw);
          value = item ? decodeObjectRef(item) : null;
        } else {
          const bytes = await resolveHnid(ndb, heap, subnodes, dw);
          value = bytes ? decodeValue(type, bytes, codepage) : null;
        }

        props.set(id, { id, type, value });
      } catch {
        // One unreadable property must not cost us the whole object.
      }
    }

    return new PropertyContext(props, codepage, subnodes);
  }

  get(id: number): PropValue | undefined {
    return this.props.get(id)?.value;
  }

  typeOf(id: number): number | undefined {
    return this.props.get(id)?.type;
  }

  getString(id: number): string | undefined {
    const v = this.get(id);
    if (typeof v === "string") return v.length ? v : undefined;
    return undefined;
  }

  getInt(id: number): number | undefined {
    const v = this.get(id);
    if (typeof v === "number") return v;
    if (typeof v === "bigint") return Number(v);
    return undefined;
  }

  getBool(id: number): boolean | undefined {
    const v = this.get(id);
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    return undefined;
  }

  getDate(id: number): Date | undefined {
    const v = this.get(id);
    return v instanceof Date ? v : undefined;
  }

  getBinary(id: number): Uint8Array | undefined {
    const v = this.get(id);
    return v instanceof Uint8Array ? v : undefined;
  }
}

// ---------------------------------------------------------------- TC

interface TColumn {
  id: number;
  type: number;
  ibData: number;
  cbData: number;
  iBit: number;
}

/**
 * Table Context: folder contents, folder hierarchy, recipients, attachments.
 *
 * Rows live in a "row matrix" of fixed-width records. Two subtleties:
 *
 *   1. Rows never straddle a block boundary. When the matrix spans several
 *      blocks, each block holds floor(8176 / rowSize) rows and the leftover
 *      bytes are slack. Indexing a flattened buffer would therefore drift out
 *      of alignment after the first block -- so we keep the blocks apart.
 *
 *   2. A cell is only meaningful if its bit is set in the Cell Existence
 *      Bitmap at the end of each row. An unset bit means "not present", which
 *      is different from present-and-empty.
 */
export class TableContext {
  private constructor(
    private readonly ndb: Ndb,
    private readonly heap: HeapNode,
    private readonly subnodes: Map<number, SubnodeEntry>,
    private readonly cols: TColumn[],
    private readonly rowSize: number,
    private readonly cebOff: number,
    private readonly blocks: Uint8Array[],
    private readonly rowsPerBlock: number,
    readonly rowIds: number[],
    private readonly codepage: number | undefined,
  ) {}

  static async load(
    ndb: Ndb,
    bidData: bigint,
    subnodes: Map<number, SubnodeEntry>,
    codepage?: number,
  ): Promise<TableContext> {
    const heap = await HeapNode.load(ndb, bidData);
    if (heap.clientSig !== HN_CLIENT_TC) {
      throw new PstDataError(
        `expected a Table Context (client sig 0x7C), found 0x${heap.clientSig.toString(16)}`,
      );
    }

    const info = heap.getItem(heap.userRoot);
    if (!info || info.length < 22) throw new PstDataError("TCINFO is missing or truncated");
    if (u8(info, 0) !== HN_CLIENT_TC) throw new PstDataError("TCINFO has the wrong signature");

    const cCols = u8(info, 1);
    // rgib[]: end offsets of the 4-byte, 2-byte, 1-byte and bitmap regions.
    const cebOff = u16(info, 2 + 4); // TCI_1b -- where the CEB starts
    const rowSize = u16(info, 2 + 6); // TCI_bm -- total row width
    const hidRowIndex = u32(info, 10);
    const hnidRows = u32(info, 14);

    if (rowSize === 0) throw new PstDataError("TCINFO reports a zero-width row");

    const cols: TColumn[] = [];
    for (let i = 0; i < cCols; i++) {
      const off = 22 + i * 8;
      if (off + 8 > info.length) break;
      const tag = u32(info, off);
      cols.push({
        id: (tag >>> 16) & 0xffff,
        type: tag & 0xffff,
        ibData: u16(info, off + 4),
        cbData: u8(info, off + 6),
        iBit: u8(info, off + 7),
      });
    }

    // The row index BTH maps dwRowID -> row number. For hierarchy and contents
    // tables dwRowID *is* the child folder / message NID, which is exactly what
    // the caller wants, so we surface the keys directly.
    const rowIds: number[] = [];
    const rowOrder: number[] = [];
    const idxHdr = readBthHeader(heap, hidRowIndex);
    if (idxHdr) {
      for (const rec of bthEnumerate(heap, idxHdr)) {
        if (rec.data.length < 4) continue;
        rowIds.push(Number(rec.key) >>> 0);
        rowOrder.push(u32(rec.data, 0));
      }
    }

    // Row matrix: a heap item for small tables, a subnode data tree for big ones.
    let blocks: Uint8Array[] = [];
    if (hnidRows !== 0) {
      if (hnidIsHid(hnidRows)) {
        const item = heap.getItem(hnidRows);
        if (item) blocks = [item];
      } else {
        const sub = subnodes.get(hnidRows);
        if (sub) blocks = await ndb.readDataTree(sub.bidData);
      }
    }

    // Single-buffer matrices are contiguous; multi-block ones re-align per block.
    const rowsPerBlock =
      blocks.length <= 1
        ? Math.max(1, Math.floor((blocks[0]?.length ?? 0) / rowSize) || 1)
        : Math.max(1, Math.floor(MAX_BLOCK_DATA / rowSize));

    // Reorder ids so index i in rowIds corresponds to matrix row i.
    //
    // dwRowIndex comes straight off the disk, so it is bounded by what the row
    // matrix can actually hold rather than trusted. Without this an corrupt
    // index (say 0xFFFFFFFF) would have us grow a sparse array of four billion
    // slots and take the Worker down with it.
    const capacity = blocks.length * rowsPerBlock;
    const ordered: number[] = [];
    for (let i = 0; i < rowIds.length; i++) {
      const at = rowOrder[i]!;
      if (at >= capacity) continue;
      ordered[at] = rowIds[i]!;
    }
    const finalIds = ordered.length ? Array.from(ordered, (v) => v ?? 0) : [];

    return new TableContext(
      ndb,
      heap,
      subnodes,
      cols,
      rowSize,
      cebOff,
      blocks,
      rowsPerBlock,
      finalIds,
      codepage,
    );
  }

  get rowCount(): number {
    return this.rowIds.length;
  }

  private rowBytes(row: number): Uint8Array | null {
    const blockIdx = Math.floor(row / this.rowsPerBlock);
    const within = row % this.rowsPerBlock;
    const block = this.blocks[blockIdx];
    if (!block) return null;
    const start = within * this.rowSize;
    if (start + this.rowSize > block.length) return null;
    return block.subarray(start, start + this.rowSize);
  }

  /** Cell Existence Bitmap: bit iBit, MSB-first within each byte. */
  private cellExists(row: Uint8Array, iBit: number): boolean {
    const byte = this.cebOff + (iBit >>> 3);
    if (byte >= row.length) return false;
    return (row[byte]! & (0x80 >>> (iBit & 7))) !== 0;
  }

  /** Decodes every present cell of one row into a property bag. */
  async getRow(row: number): Promise<Map<number, PropEntry>> {
    const out = new Map<number, PropEntry>();
    const bytes = this.rowBytes(row);
    if (!bytes) return out;

    for (const col of this.cols) {
      if (!this.cellExists(bytes, col.iBit)) continue;
      if (col.ibData + col.cbData > bytes.length) continue;
      const cell = bytes.subarray(col.ibData, col.ibData + col.cbData);

      try {
        const sz = fixedSize(col.type);
        let value: PropValue;

        if (sz !== null && sz <= 8) {
          value = decodeValue(col.type, cell, this.codepage);
        } else if (col.cbData === 4) {
          const hnid = u32(cell, 0);
          if (col.type === PT_OBJECT) {
            const item = this.heap.getItem(hnid);
            value = item ? decodeObjectRef(item) : null;
          } else {
            const resolved = await resolveHnid(this.ndb, this.heap, this.subnodes, hnid);
            value = resolved ? decodeValue(col.type, resolved, this.codepage) : null;
          }
        } else {
          value = decodeValue(col.type, cell, this.codepage);
        }

        out.set(col.id, { id: col.id, type: col.type, value });
      } catch {
        // Skip the bad cell, keep the row.
      }
    }
    return out;
  }
}

/** Reads a string out of a decoded TC row. */
export function rowString(row: Map<number, PropEntry>, id: number): string | undefined {
  const v = row.get(id)?.value;
  return typeof v === "string" && v.length ? v : undefined;
}

/** Reads an integer out of a decoded TC row. */
export function rowInt(row: Map<number, PropEntry>, id: number): number | undefined {
  const v = row.get(id)?.value;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return undefined;
}
