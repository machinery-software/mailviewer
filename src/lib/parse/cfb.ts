/**
 * Compound File Binary reader (MS-CFB), from scratch.
 *
 * A CFB file is a FAT filesystem in a trenchcoat: a header, a sector
 * allocation table, a directory of entries arranged as a red-black tree, and
 * -- because 512-byte sectors are wasteful for the many tiny streams a .msg
 * contains -- a second "mini" filesystem with 64-byte sectors that itself
 * lives inside one ordinary stream.
 *
 * We are deliberately not depending on a CFB library. This is a privacy tool;
 * every third-party package is audit surface. The format is small enough to
 * own outright, and owning it means we can be strict about bounds and lenient
 * about the sloppiness real files exhibit, rather than inheriting someone
 * else's choices on both.
 *
 * Browser only: ArrayBuffer / Uint8Array / DataView. No Node APIs.
 */

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Highest sector number that addresses real data; above this are sentinels. */
const MAXREGSECT = 0xfffffffa;
/** Sector is part of the DIFAT. */
const DIFSECT = 0xfffffffc;
/** Sector is part of the FAT. */
const FATSECT = 0xfffffffd;
/** Terminates a sector chain. */
const ENDOFCHAIN = 0xfffffffe;
/** Sector is unallocated. */
const FREESECT = 0xffffffff;
/** Directory entry id meaning "no such sibling / no child". */
export const NOSTREAM = 0xffffffff;

/** Mini sectors are always 64 bytes; the header's mini sector shift says so. */
const DEFAULT_MINI_SECTOR_SHIFT = 6;
/** Streams smaller than this live in the mini stream. */
const DEFAULT_MINI_CUTOFF = 4096;

/**
 * A hard ceiling on chain length, to stop a corrupt or hostile file from
 * spinning us forever. Any real chain is bounded by the number of sectors in
 * the file, so this only ever fires on a cycle we failed to spot.
 */
const MAX_CHAIN = 1 << 22;

export class CfbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfbError";
  }
}

export type CfbEntryType = "root" | "storage" | "stream";

export interface CfbEntry {
  /** Index into the directory, and the id siblings/children refer to. */
  id: number;
  name: string;
  type: CfbEntryType;
  /**
   * Path segments from the root, root's own name excluded. The root entry has
   * an empty path; a stream directly under it has a single segment.
   */
  path: string[];
  /** Stream length in bytes. Zero for storages. */
  size: number;
  children: CfbEntry[];
  /** First sector of the stream's chain. Internal, but harmless to expose. */
  startSector: number;
}

export interface CfbFile {
  /** CFB major version: 3 (512-byte sectors) or 4 (4096-byte sectors). */
  version: number;
  sectorSize: number;
  miniSectorSize: number;
  root: CfbEntry;
  /** Every allocated entry reachable from the root, root included. */
  entries: CfbEntry[];
  /** Look up an entry by path, e.g. `["__attach_version1.0_#00000000"]`. */
  getEntry(path: string[] | string): CfbEntry | undefined;
  /** Read a stream's bytes. Throws if the entry is a storage. */
  readStream(entry: CfbEntry): Uint8Array;
  /** Read by path. Returns undefined when absent or not a stream. */
  readPath(path: string[] | string): Uint8Array | undefined;
  /** Every entry path, "/"-joined. Handy for debugging and for tests. */
  listPaths(): string[];
  /** Non-fatal oddities noticed while parsing (cycles, truncation, ...). */
  warnings: string[];
}

function joinPath(path: string[] | string): string {
  return Array.isArray(path) ? path.join("/") : path;
}

/**
 * Parse a CFB container. Throws CfbError if the magic is absent or the header
 * is structurally impossible; tolerates most other damage by warning.
 */
export function parseCfb(bytes: Uint8Array): CfbFile {
  if (bytes.length < 512) {
    throw new CfbError(
      `file is ${bytes.length} bytes, too short to be a compound file (need 512)`,
    );
  }
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIGNATURE[i]) {
      throw new CfbError(
        "not a compound file: missing D0 CF 11 E0 A1 B1 1A E1 signature",
      );
    }
  }

  const warnings: string[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const version = dv.getUint16(26, true);
  const sectorShift = dv.getUint16(30, true);
  if (sectorShift !== 9 && sectorShift !== 12) {
    throw new CfbError(
      `unsupported sector shift ${sectorShift} (expected 9 for v3 or 12 for v4)`,
    );
  }
  const sectorSize = 1 << sectorShift;

  let miniSectorShift = dv.getUint16(32, true);
  if (miniSectorShift !== DEFAULT_MINI_SECTOR_SHIFT) {
    warnings.push(
      `unusual mini sector shift ${miniSectorShift}; assuming 6 (64-byte mini sectors)`,
    );
    miniSectorShift = DEFAULT_MINI_SECTOR_SHIFT;
  }
  const miniSectorSize = 1 << miniSectorShift;

  const numFatSectors = dv.getUint32(44, true);
  const firstDirSector = dv.getUint32(48, true);
  let miniCutoff = dv.getUint32(56, true);
  if (miniCutoff !== DEFAULT_MINI_CUTOFF) {
    // The spec fixes this at 4096. A different value is a sign of a generator
    // bug; honouring it would send us looking for streams in the wrong table.
    warnings.push(`mini stream cutoff is ${miniCutoff}, not 4096; using 4096`);
    miniCutoff = DEFAULT_MINI_CUTOFF;
  }
  const firstMiniFatSector = dv.getUint32(60, true);
  const numMiniFatSectors = dv.getUint32(64, true);
  const firstDifatSector = dv.getUint32(68, true);
  const numDifatSectors = dv.getUint32(72, true);

  /** Byte offset of sector n. The header occupies the slot before sector 0. */
  const sectorOffset = (n: number): number => (n + 1) * sectorSize;

  /**
   * Total sectors the file can actually hold. Used to reject out-of-range
   * sector ids before they turn into wild reads.
   */
  const sectorCount = Math.max(
    0,
    Math.floor((bytes.length - sectorSize) / sectorSize),
  );

  const readSector = (n: number): Uint8Array => {
    const start = sectorOffset(n);
    if (start >= bytes.length) return new Uint8Array(sectorSize);
    // A file truncated mid-sector is recoverable: zero-pad the tail rather
    // than refusing to read the (probably intact) bytes before it.
    const end = Math.min(start + sectorSize, bytes.length);
    if (end - start === sectorSize) return bytes.subarray(start, end);
    const padded = new Uint8Array(sectorSize);
    padded.set(bytes.subarray(start, end));
    return padded;
  };

  // ---- DIFAT: the list of FAT sector numbers -----------------------------
  // The first 109 entries are inline in the header. Beyond that the DIFAT
  // spills into its own chain of sectors, each holding (sectorSize/4 - 1)
  // FAT sector numbers plus a pointer to the next DIFAT sector in its last
  // slot. Files this large are rare, but .msg with big attachments hit it.
  const difat: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = dv.getUint32(76 + i * 4, true);
    if (s > MAXREGSECT) continue;
    difat.push(s);
  }

  const entriesPerSector = sectorSize / 4;
  {
    let next = firstDifatSector;
    const seen = new Set<number>();
    let guard = 0;
    while (next <= MAXREGSECT && guard++ < MAX_CHAIN) {
      if (seen.has(next)) {
        warnings.push(`DIFAT chain loops at sector ${next}; stopping`);
        break;
      }
      seen.add(next);
      if (next >= sectorCount) {
        warnings.push(`DIFAT sector ${next} is past end of file; stopping`);
        break;
      }
      const sec = readSector(next);
      const sdv = new DataView(sec.buffer, sec.byteOffset, sec.byteLength);
      for (let i = 0; i < entriesPerSector - 1; i++) {
        const s = sdv.getUint32(i * 4, true);
        if (s > MAXREGSECT) continue;
        difat.push(s);
      }
      next = sdv.getUint32((entriesPerSector - 1) * 4, true);
    }
    if (numDifatSectors > 0 && seen.size !== numDifatSectors) {
      warnings.push(
        `header claims ${numDifatSectors} DIFAT sectors, walked ${seen.size}`,
      );
    }
  }

  if (difat.length > numFatSectors && numFatSectors > 0) {
    // Extra trailing entries are usually FREESECT padding we already filtered;
    // anything left over we simply ignore rather than trusting it.
    difat.length = numFatSectors;
  }

  // ---- FAT ---------------------------------------------------------------
  const fat = new Uint32Array(difat.length * entriesPerSector);
  for (let i = 0; i < difat.length; i++) {
    const sec = readSector(difat[i]);
    const sdv = new DataView(sec.buffer, sec.byteOffset, sec.byteLength);
    for (let j = 0; j < entriesPerSector; j++) {
      fat[i * entriesPerSector + j] = sdv.getUint32(j * 4, true);
    }
  }
  if (fat.length === 0) {
    throw new CfbError("compound file has an empty FAT");
  }

  /** Walk a sector chain through a given allocation table. */
  const chain = (start: number, table: Uint32Array, what: string): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    let s = start;
    let guard = 0;
    while (s <= MAXREGSECT && guard++ < MAX_CHAIN) {
      if (seen.has(s)) {
        warnings.push(`${what} chain loops at sector ${s}; truncating`);
        break;
      }
      if (s >= table.length) {
        warnings.push(`${what} chain leaves the allocation table at ${s}`);
        break;
      }
      seen.add(s);
      out.push(s);
      s = table[s];
    }
    return out;
  };

  const concatSectors = (sectors: number[], read: (n: number) => Uint8Array, unit: number): Uint8Array => {
    const buf = new Uint8Array(sectors.length * unit);
    for (let i = 0; i < sectors.length; i++) buf.set(read(sectors[i]), i * unit);
    return buf;
  };

  // ---- MiniFAT -----------------------------------------------------------
  const miniFatSectors = chain(firstMiniFatSector, fat, "MiniFAT");
  if (numMiniFatSectors > 0 && miniFatSectors.length !== numMiniFatSectors) {
    warnings.push(
      `header claims ${numMiniFatSectors} MiniFAT sectors, chain walked ${miniFatSectors.length}`,
    );
  }
  const miniFatBytes = concatSectors(miniFatSectors, readSector, sectorSize);
  const miniFat = new Uint32Array(miniFatBytes.length / 4);
  {
    const mdv = new DataView(
      miniFatBytes.buffer,
      miniFatBytes.byteOffset,
      miniFatBytes.byteLength,
    );
    for (let i = 0; i < miniFat.length; i++) miniFat[i] = mdv.getUint32(i * 4, true);
  }

  // ---- Directory ---------------------------------------------------------
  const dirSectors = chain(firstDirSector, fat, "directory");
  const dirBytes = concatSectors(dirSectors, readSector, sectorSize);
  const entryCount = Math.floor(dirBytes.length / 128);
  if (entryCount === 0) throw new CfbError("compound file has no directory entries");

  const ddv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);

  interface RawEntry {
    name: string;
    objectType: number;
    left: number;
    right: number;
    child: number;
    startSector: number;
    size: number;
  }

  const raw: RawEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    const base = i * 128;
    let nameLen = ddv.getUint16(base + 64, true);
    // nameLen counts bytes including the UTF-16 NUL terminator.
    if (nameLen > 64) nameLen = 64;
    const chars = nameLen >= 2 ? nameLen / 2 - 1 : 0;
    let name = "";
    for (let c = 0; c < chars; c++) {
      const code = ddv.getUint16(base + c * 2, true);
      if (code === 0) break;
      name += String.fromCharCode(code);
    }

    // Stream size is a 64-bit field, but v3 files are only required to fill
    // the low 32 bits (the high half is often garbage). Anything past 4 GiB is
    // not something we can hold in a Uint8Array anyway.
    const sizeLo = ddv.getUint32(base + 120, true);
    const sizeHi = ddv.getUint32(base + 124, true);
    const size = version <= 3 ? sizeLo : sizeHi * 0x100000000 + sizeLo;

    raw.push({
      name,
      objectType: ddv.getUint8(base + 66),
      left: ddv.getUint32(base + 68, true),
      right: ddv.getUint32(base + 72, true),
      child: ddv.getUint32(base + 76, true),
      startSector: ddv.getUint32(base + 116, true),
      size,
    });
  }

  if (raw[0].objectType !== 5) {
    throw new CfbError(
      `first directory entry is not the root (object type ${raw[0].objectType})`,
    );
  }

  // ---- Mini stream -------------------------------------------------------
  // The root entry's own "stream" is the backing store for every mini sector.
  // It lives in ordinary sectors; mini sectors are just offsets into it.
  let miniStream: Uint8Array | null = null;
  const getMiniStream = (): Uint8Array => {
    if (miniStream) return miniStream;
    const sectors = chain(raw[0].startSector, fat, "mini stream");
    const full = concatSectors(sectors, readSector, sectorSize);
    miniStream = raw[0].size > 0 && raw[0].size <= full.length
      ? full.subarray(0, raw[0].size)
      : full;
    return miniStream;
  };

  const readMiniSector = (n: number): Uint8Array => {
    const ms = getMiniStream();
    const start = n * miniSectorSize;
    if (start >= ms.length) return new Uint8Array(miniSectorSize);
    const end = Math.min(start + miniSectorSize, ms.length);
    if (end - start === miniSectorSize) return ms.subarray(start, end);
    const padded = new Uint8Array(miniSectorSize);
    padded.set(ms.subarray(start, end));
    return padded;
  };

  // ---- Tree ---------------------------------------------------------------
  // The directory is a red-black tree per storage, but we do not care about
  // the colouring: we only need the set of children. Walk left/right for
  // siblings, `child` to descend. A visited set keeps a corrupt tree with a
  // cycle in it from becoming an infinite one.
  const visited = new Set<number>();
  const entries: CfbEntry[] = [];

  const makeEntry = (id: number, path: string[]): CfbEntry => {
    const r = raw[id];
    const type: CfbEntryType =
      r.objectType === 5 ? "root" : r.objectType === 1 ? "storage" : "stream";
    const e: CfbEntry = {
      id,
      name: r.name,
      type,
      path,
      size: type === "stream" ? r.size : 0,
      children: [],
      startSector: r.startSector,
    };
    entries.push(e);
    return e;
  };

  const collectSiblings = (id: number, into: number[]): void => {
    if (id === NOSTREAM || id >= raw.length) return;
    if (visited.has(id)) {
      warnings.push(`directory entry ${id} appears twice; ignoring the repeat`);
      return;
    }
    visited.add(id);
    const r = raw[id];
    if (r.objectType === 0) return; // unallocated
    collectSiblings(r.left, into);
    into.push(id);
    collectSiblings(r.right, into);
  };

  const buildChildren = (parent: CfbEntry): void => {
    const childId = raw[parent.id].child;
    if (childId === NOSTREAM || childId >= raw.length) return;
    const ids: number[] = [];
    collectSiblings(childId, ids);
    for (const id of ids) {
      const child = makeEntry(id, [...parent.path, raw[id].name]);
      parent.children.push(child);
      if (child.type === "storage") buildChildren(child);
    }
  };

  visited.add(0);
  const root = makeEntry(0, []);
  buildChildren(root);

  const byPath = new Map<string, CfbEntry>();
  for (const e of entries) {
    if (e.id === 0) continue;
    const key = e.path.join("/");
    if (byPath.has(key)) {
      warnings.push(`duplicate path "${key}"; keeping the first`);
      continue;
    }
    byPath.set(key, e);
  }

  const readStream = (entry: CfbEntry): Uint8Array => {
    if (entry.type !== "stream") {
      throw new CfbError(`"${entry.name}" is a ${entry.type}, not a stream`);
    }
    if (entry.size === 0) return new Uint8Array(0);

    if (entry.size < miniCutoff) {
      const sectors = chain(entry.startSector, miniFat, `mini stream "${entry.name}"`);
      const buf = concatSectors(sectors, readMiniSector, miniSectorSize);
      return buf.length >= entry.size ? buf.slice(0, entry.size) : buf.slice();
    }

    const sectors = chain(entry.startSector, fat, `stream "${entry.name}"`);
    const buf = concatSectors(sectors, readSector, sectorSize);
    if (buf.length < entry.size) {
      warnings.push(
        `stream "${entry.name}" declares ${entry.size} bytes but its chain yields ${buf.length}`,
      );
      return buf.slice();
    }
    return buf.slice(0, entry.size);
  };

  const getEntry = (path: string[] | string): CfbEntry | undefined =>
    byPath.get(joinPath(path));

  return {
    version,
    sectorSize,
    miniSectorSize,
    root,
    entries,
    warnings,
    getEntry,
    readStream,
    readPath: (path) => {
      const e = getEntry(path);
      return e && e.type === "stream" ? readStream(e) : undefined;
    },
    listPaths: () => entries.filter((e) => e.id !== 0).map((e) => e.path.join("/")),
  };
}

/** Sentinel values, exported so tests and the MSG layer can assert on them. */
export const CFB_SENTINELS = {
  MAXREGSECT,
  DIFSECT,
  FATSECT,
  ENDOFCHAIN,
  FREESECT,
  NOSTREAM,
} as const;
