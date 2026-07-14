import { describe, expect, it } from "vitest";
import { bthEnumerate, bthLookup, readBthHeader } from "../ltp.ts";
import type { HeapLike } from "../ltp.ts";

/**
 * A stand-in heap.
 *
 * BTree-on-Heap only ever talks to the heap through getItem(hid), so we can
 * exercise the tree logic -- multi-level descent, key ordering, misses -- without
 * hand-rolling HNHDRs and page maps. That keeps this test about the BTH
 * algorithm rather than about our own byte-packing.
 */
class FakeHeap implements HeapLike {
  private readonly items = new Map<number, Uint8Array>();
  private next = 0x20; // HIDs have a zero type nibble; step by 0x20.

  add(bytes: Uint8Array): number {
    const hid = this.next;
    this.next += 0x20;
    this.items.set(hid, bytes);
    return hid;
  }

  getItem(hid: number): Uint8Array | null {
    return this.items.get(hid) ?? null;
  }
}

/** Packs BTH leaf records: cbKey-byte key followed by cbEnt bytes of value. */
function leafPage(entries: Array<[number, number[]]>, cbKey: number, cbEnt: number): Uint8Array {
  const rec = cbKey + cbEnt;
  const out = new Uint8Array(entries.length * rec);
  entries.forEach(([key, data], i) => {
    const dv = new DataView(out.buffer, i * rec, cbKey);
    if (cbKey === 2) dv.setUint16(0, key, true);
    else dv.setUint32(0, key, true);
    out.set(data, i * rec + cbKey);
  });
  return out;
}

/** Packs BTH intermediate records: key followed by a 4-byte child HID. */
function indexPage(entries: Array<[number, number]>, cbKey: number): Uint8Array {
  const rec = cbKey + 4;
  const out = new Uint8Array(entries.length * rec);
  entries.forEach(([key, hid], i) => {
    const dv = new DataView(out.buffer, i * rec, rec);
    if (cbKey === 2) dv.setUint16(0, key, true);
    else dv.setUint32(0, key, true);
    dv.setUint32(cbKey, hid, true);
  });
  return out;
}

function bthHeaderItem(cbKey: number, cbEnt: number, levels: number, hidRoot: number): Uint8Array {
  const b = new Uint8Array(8);
  b[0] = 0xb5;
  b[1] = cbKey;
  b[2] = cbEnt;
  b[3] = levels;
  new DataView(b.buffer).setUint32(4, hidRoot, true);
  return b;
}

describe("readBthHeader", () => {
  it("reads the header fields", () => {
    const heap = new FakeHeap();
    const hid = heap.add(bthHeaderItem(2, 6, 1, 0x40));
    expect(readBthHeader(heap, hid)).toEqual({ cbKey: 2, cbEnt: 6, levels: 1, hidRoot: 0x40 });
  });

  it("rejects an item that is not a BTH", () => {
    const heap = new FakeHeap();
    const bad = new Uint8Array(8);
    bad[0] = 0x7c; // a TCINFO signature, not 0xB5
    const hid = heap.add(bad);
    expect(() => readBthHeader(heap, hid)).toThrow(/BTH header/i);
  });

  it("returns null when the HID resolves to nothing", () => {
    expect(readBthHeader(new FakeHeap(), 0x9999)).toBeNull();
  });
});

describe("BTH -- single level", () => {
  const heap = new FakeHeap();
  const leaf = heap.add(
    leafPage(
      [
        [0x0037, [1, 1, 1, 1, 1, 1]],
        [0x1000, [2, 2, 2, 2, 2, 2]],
        [0x3001, [3, 3, 3, 3, 3, 3]],
      ],
      2,
      6,
    ),
  );
  const hdr = { cbKey: 2, cbEnt: 6, levels: 0, hidRoot: leaf };

  it("finds every key", () => {
    expect(bthLookup(heap, hdr, 0x0037n)).toEqual(Uint8Array.from([1, 1, 1, 1, 1, 1]));
    expect(bthLookup(heap, hdr, 0x1000n)).toEqual(Uint8Array.from([2, 2, 2, 2, 2, 2]));
    expect(bthLookup(heap, hdr, 0x3001n)).toEqual(Uint8Array.from([3, 3, 3, 3, 3, 3]));
  });

  it("returns null for keys that are not there", () => {
    expect(bthLookup(heap, hdr, 0x0001n)).toBeNull(); // below the first
    expect(bthLookup(heap, hdr, 0x0500n)).toBeNull(); // between two
    expect(bthLookup(heap, hdr, 0xffffn)).toBeNull(); // above the last
  });

  it("enumerates in key order", () => {
    expect(bthEnumerate(heap, hdr).map((r) => Number(r.key))).toEqual([0x0037, 0x1000, 0x3001]);
  });
});

describe("BTH -- two levels", () => {
  /**
   * Root
   *   0x0037 -> leaf A [0x0037, 0x0039, 0x0e07]
   *   0x1000 -> leaf B [0x1000, 0x3001]
   *
   * The descent rule is "last index entry whose key is <= the target", which is
   * what makes a lookup for 0x0039 (absent from the root) still land in leaf A.
   */
  const heap = new FakeHeap();

  const leafA = heap.add(
    leafPage(
      [
        [0x0037, [0xa1, 0, 0, 0, 0, 0]],
        [0x0039, [0xa2, 0, 0, 0, 0, 0]],
        [0x0e07, [0xa3, 0, 0, 0, 0, 0]],
      ],
      2,
      6,
    ),
  );
  const leafB = heap.add(
    leafPage(
      [
        [0x1000, [0xb1, 0, 0, 0, 0, 0]],
        [0x3001, [0xb2, 0, 0, 0, 0, 0]],
      ],
      2,
      6,
    ),
  );
  const root = heap.add(
    indexPage(
      [
        [0x0037, leafA],
        [0x1000, leafB],
      ],
      2,
    ),
  );
  const hdr = { cbKey: 2, cbEnt: 6, levels: 1, hidRoot: root };

  it("descends to the right leaf", () => {
    expect(bthLookup(heap, hdr, 0x0037n)?.[0]).toBe(0xa1);
    expect(bthLookup(heap, hdr, 0x0039n)?.[0]).toBe(0xa2);
    expect(bthLookup(heap, hdr, 0x0e07n)?.[0]).toBe(0xa3);
    expect(bthLookup(heap, hdr, 0x1000n)?.[0]).toBe(0xb1);
    expect(bthLookup(heap, hdr, 0x3001n)?.[0]).toBe(0xb2);
  });

  it("returns null for a key that would live in a leaf but does not", () => {
    // 0x0100 sorts into leaf A's range; leaf A does not contain it.
    expect(bthLookup(heap, hdr, 0x0100n)).toBeNull();
    // 0x9999 sorts into leaf B's range; leaf B does not contain it.
    expect(bthLookup(heap, hdr, 0x9999n)).toBeNull();
  });

  it("returns null for a key below the whole tree", () => {
    expect(bthLookup(heap, hdr, 0x0001n)).toBeNull();
  });

  it("enumerates every leaf across both pages, in order", () => {
    expect(bthEnumerate(heap, hdr).map((r) => Number(r.key))).toEqual([
      0x0037, 0x0039, 0x0e07, 0x1000, 0x3001,
    ]);
  });

  it("survives a dangling child HID instead of throwing", () => {
    const broken = { cbKey: 2, cbEnt: 6, levels: 1, hidRoot: heap.add(indexPage([[0x0000, 0xdead0]], 2)) };
    expect(bthEnumerate(heap, broken)).toEqual([]);
    expect(bthLookup(heap, broken, 0x0037n)).toBeNull();
  });
});

describe("BTH -- 4-byte keys", () => {
  // Table Contexts index their row matrix with a 4-byte key (the row ID, which
  // for a contents table is the message NID).
  const heap = new FakeHeap();
  const leaf = heap.add(
    leafPage(
      [
        [0x00200024, [0, 0, 0, 0]],
        [0x00200064, [1, 0, 0, 0]],
      ],
      4,
      4,
    ),
  );
  const hdr = { cbKey: 4, cbEnt: 4, levels: 0, hidRoot: leaf };

  it("handles keys wider than 16 bits", () => {
    expect(bthLookup(heap, hdr, 0x00200024n)).toEqual(Uint8Array.from([0, 0, 0, 0]));
    expect(bthLookup(heap, hdr, 0x00200064n)).toEqual(Uint8Array.from([1, 0, 0, 0]));
    expect(bthLookup(heap, hdr, 0x00200025n)).toBeNull();
  });

  it("enumerates row IDs and their row numbers", () => {
    const recs = bthEnumerate(heap, hdr);
    expect(recs.map((r) => Number(r.key))).toEqual([0x00200024, 0x00200064]);
    expect(recs[1]!.data[0]).toBe(1);
  });
});

describe("BTH -- empty", () => {
  it("treats a zero hidRoot as an empty tree", () => {
    const heap = new FakeHeap();
    const hdr = { cbKey: 2, cbEnt: 6, levels: 0, hidRoot: 0 };
    expect(bthEnumerate(heap, hdr)).toEqual([]);
    expect(bthLookup(heap, hdr, 0x0037n)).toBeNull();
  });
});
