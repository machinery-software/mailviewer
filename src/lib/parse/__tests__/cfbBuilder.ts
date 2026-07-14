/**
 * A minimal Compound File Binary *writer*, for tests only.
 *
 * The point of testing the reader against a container we built ourselves --
 * rather than a checked-in .msg blob -- is that every field is something we
 * chose. When a round-trip fails we know exactly which byte we meant to write,
 * so a failure localises to a bug instead of to "the fixture is weird".
 *
 * It deliberately produces v3 (512-byte sector) files with a degenerate
 * directory tree: siblings are chained through `right` only, with `left` always
 * NOSTREAM. That is a legal red-black tree (all-black right spine) and it
 * exercises the reader's sibling walk without requiring us to implement
 * rebalancing.
 */

const SECTOR = 512;
const MINI_SECTOR = 64;
const MINI_CUTOFF = 4096;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;
const DIR_ENTRIES_PER_SECTOR = SECTOR / 128;
const FAT_ENTRIES_PER_SECTOR = SECTOR / 4;

export type BuildNode =
  | { kind: "stream"; name: string; data: Uint8Array }
  | { kind: "storage"; name: string; children: BuildNode[] };

export const stream = (name: string, data: Uint8Array | string): BuildNode => ({
  kind: "stream",
  name,
  data: typeof data === "string" ? new TextEncoder().encode(data) : data,
});

export const storage = (name: string, children: BuildNode[]): BuildNode => ({
  kind: "storage",
  name,
  children,
});

interface DirEntry {
  name: string;
  objectType: number; // 1 storage, 2 stream, 5 root
  left: number;
  right: number;
  child: number;
  startSector: number;
  size: number;
}

function chunk(data: Uint8Array, unit: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let off = 0; off < data.length; off += unit) {
    const block = new Uint8Array(unit);
    block.set(data.subarray(off, Math.min(off + unit, data.length)));
    out.push(block);
  }
  return out;
}

/** Build a CFB image containing the given tree under the root storage. */
export function buildCfb(children: BuildNode[]): Uint8Array {
  // --- 1. Flatten the tree into directory entries -------------------------
  const dir: DirEntry[] = [
    {
      name: "Root Entry",
      objectType: 5,
      left: NOSTREAM,
      right: NOSTREAM,
      child: NOSTREAM,
      startSector: ENDOFCHAIN,
      size: 0,
    },
  ];
  /** Streams, in directory-entry order, awaiting a home. */
  const streams: Array<{ id: number; data: Uint8Array }> = [];

  const addChildren = (parentId: number, nodes: BuildNode[]): void => {
    if (nodes.length === 0) return;
    const ids: number[] = [];
    for (const node of nodes) {
      const id = dir.length;
      ids.push(id);
      dir.push({
        name: node.name,
        objectType: node.kind === "storage" ? 1 : 2,
        left: NOSTREAM,
        right: NOSTREAM,
        child: NOSTREAM,
        startSector: ENDOFCHAIN,
        size: node.kind === "stream" ? node.data.length : 0,
      });
      if (node.kind === "stream") streams.push({ id, data: node.data });
    }
    // Sibling spine: first child hangs off the parent, the rest chain right.
    dir[parentId].child = ids[0];
    for (let i = 0; i + 1 < ids.length; i++) dir[ids[i]].right = ids[i + 1];
    // Recurse only after the whole level exists, so ids stay contiguous.
    nodes.forEach((node, i) => {
      if (node.kind === "storage") addChildren(ids[i], node.children);
    });
  };
  addChildren(0, children);

  // --- 2. Mini stream -----------------------------------------------------
  // Every stream below the 4096-byte cutoff lives here, packed into 64-byte
  // mini sectors. The mini stream itself is then stored as one ordinary chain.
  const miniParts: Uint8Array[] = [];
  let nextMiniSector = 0;
  const miniChains: number[][] = [];

  for (const s of streams) {
    if (s.data.length === 0 || s.data.length >= MINI_CUTOFF) continue;
    const blocks = chunk(s.data, MINI_SECTOR);
    const chain: number[] = [];
    for (const b of blocks) {
      miniParts.push(b);
      chain.push(nextMiniSector++);
    }
    dir[s.id].startSector = chain[0];
    miniChains.push(chain);
  }

  const miniStream = new Uint8Array(miniParts.length * MINI_SECTOR);
  miniParts.forEach((b, i) => miniStream.set(b, i * MINI_SECTOR));

  // MiniFAT: one entry per mini sector.
  const miniFat = new Uint32Array(
    Math.max(
      nextMiniSector,
      // Pad out to a whole sector so the serialised MiniFAT is sector-aligned.
      Math.ceil(nextMiniSector / FAT_ENTRIES_PER_SECTOR) * FAT_ENTRIES_PER_SECTOR,
    ),
  ).fill(FREESECT);
  for (const chain of miniChains) {
    for (let i = 0; i < chain.length; i++) {
      miniFat[chain[i]] = i + 1 < chain.length ? chain[i + 1] : ENDOFCHAIN;
    }
  }

  // --- 3. Allocate ordinary sectors ---------------------------------------
  // Each of these becomes one chain of consecutive sectors. Order is arbitrary;
  // consecutive-and-in-order is simply the easiest thing to verify by hand.
  const dataBlocks: Uint8Array[] = [];
  const alloc = (blocks: Uint8Array[]): { start: number; chain: number[] } => {
    if (blocks.length === 0) return { start: ENDOFCHAIN, chain: [] };
    const chain: number[] = [];
    for (const b of blocks) {
      chain.push(dataBlocks.length);
      dataBlocks.push(b);
    }
    return { start: chain[0], chain };
  };

  const chains: number[][] = [];

  // Directory.
  const dirBytes = new Uint8Array(
    Math.ceil(dir.length / DIR_ENTRIES_PER_SECTOR) * SECTOR,
  );
  const dirView = new DataView(dirBytes.buffer);
  // Unused directory slots must be marked unallocated, not left as type 0 with
  // a stale name; zeroing the whole buffer already gives objectType 0.
  for (let i = 0; i < dir.length; i++) writeDirEntry(dirView, i * 128, dir[i]);
  // The reader must not follow sibling ids into the padding.
  for (let i = dir.length; i < dirBytes.length / 128; i++) {
    dirView.setUint32(i * 128 + 68, NOSTREAM, true);
    dirView.setUint32(i * 128 + 72, NOSTREAM, true);
    dirView.setUint32(i * 128 + 76, NOSTREAM, true);
  }
  const dirAlloc = alloc(chunk(dirBytes, SECTOR));
  chains.push(dirAlloc.chain);

  // MiniFAT.
  const miniFatBytes = new Uint8Array(miniFat.length * 4);
  {
    const v = new DataView(miniFatBytes.buffer);
    for (let i = 0; i < miniFat.length; i++) v.setUint32(i * 4, miniFat[i], true);
  }
  const miniFatAlloc = alloc(chunk(miniFatBytes, SECTOR));
  chains.push(miniFatAlloc.chain);

  // Mini stream (pointed at by the root entry).
  const miniStreamAlloc = alloc(chunk(miniStream, SECTOR));
  chains.push(miniStreamAlloc.chain);
  dir[0].startSector = miniStreamAlloc.start;
  dir[0].size = miniStream.length;

  // Big streams.
  for (const s of streams) {
    if (s.data.length < MINI_CUTOFF) continue;
    const a = alloc(chunk(s.data, SECTOR));
    dir[s.id].startSector = a.start;
    chains.push(a.chain);
  }

  // The root entry and the directory were both written before the mini stream
  // got a home, so redo the directory bytes now that startSectors are final.
  for (let i = 0; i < dir.length; i++) writeDirEntry(dirView, i * 128, dir[i]);
  chunk(dirBytes, SECTOR).forEach((b, i) => dataBlocks[dirAlloc.chain[i]].set(b));

  // --- 4. FAT -------------------------------------------------------------
  // The FAT has to describe the FAT's own sectors, so its size depends on
  // itself. Grow until it fits.
  const dataSectorCount = dataBlocks.length;
  let fatSectorCount = 1;
  while (fatSectorCount * FAT_ENTRIES_PER_SECTOR < dataSectorCount + fatSectorCount) {
    fatSectorCount++;
  }
  if (fatSectorCount > 109) {
    throw new Error("test builder does not emit DIFAT sectors; keep fixtures small");
  }

  const totalSectors = dataSectorCount + fatSectorCount;
  const fat = new Uint32Array(fatSectorCount * FAT_ENTRIES_PER_SECTOR).fill(FREESECT);
  for (const chain of chains) {
    for (let i = 0; i < chain.length; i++) {
      fat[chain[i]] = i + 1 < chain.length ? chain[i + 1] : ENDOFCHAIN;
    }
  }
  for (let i = 0; i < fatSectorCount; i++) fat[dataSectorCount + i] = FATSECT;

  // --- 5. Serialise -------------------------------------------------------
  const out = new Uint8Array(SECTOR + totalSectors * SECTOR);
  const dv = new DataView(out.buffer);

  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  dv.setUint16(24, 0x003e, true); // minor version
  dv.setUint16(26, 3, true); // major version: v3
  dv.setUint16(28, 0xfffe, true); // little-endian
  dv.setUint16(30, 9, true); // sector shift: 512
  dv.setUint16(32, 6, true); // mini sector shift: 64
  dv.setUint32(40, 0, true); // directory sector count (v3: unused)
  dv.setUint32(44, fatSectorCount, true);
  dv.setUint32(48, dirAlloc.start, true);
  dv.setUint32(52, 0, true); // transaction signature
  dv.setUint32(56, MINI_CUTOFF, true);
  dv.setUint32(60, miniFatAlloc.start, true);
  dv.setUint32(64, miniFatAlloc.chain.length, true);
  dv.setUint32(68, ENDOFCHAIN, true); // no DIFAT sectors
  dv.setUint32(72, 0, true);

  for (let i = 0; i < 109; i++) {
    dv.setUint32(76 + i * 4, i < fatSectorCount ? dataSectorCount + i : FREESECT, true);
  }

  for (let i = 0; i < dataSectorCount; i++) {
    out.set(dataBlocks[i], SECTOR + i * SECTOR);
  }
  for (let i = 0; i < fatSectorCount; i++) {
    const base = SECTOR + (dataSectorCount + i) * SECTOR;
    for (let j = 0; j < FAT_ENTRIES_PER_SECTOR; j++) {
      dv.setUint32(base + j * 4, fat[i * FAT_ENTRIES_PER_SECTOR + j], true);
    }
  }

  return out;
}

function writeDirEntry(dv: DataView, base: number, e: DirEntry): void {
  for (let i = 0; i < 64; i++) dv.setUint8(base + i, 0);
  for (let i = 0; i < e.name.length && i < 31; i++) {
    dv.setUint16(base + i * 2, e.name.charCodeAt(i), true);
  }
  // Name length in bytes, including the UTF-16 NUL terminator.
  dv.setUint16(base + 64, (Math.min(e.name.length, 31) + 1) * 2, true);
  dv.setUint8(base + 66, e.objectType);
  dv.setUint8(base + 67, 1); // colour: black
  dv.setUint32(base + 68, e.left, true);
  dv.setUint32(base + 72, e.right, true);
  dv.setUint32(base + 76, e.child, true);
  dv.setUint32(base + 116, e.startSector, true);
  dv.setUint32(base + 120, e.size, true);
  dv.setUint32(base + 124, 0, true);
}
