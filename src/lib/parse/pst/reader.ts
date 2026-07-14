/**
 * Random-access byte source.
 *
 * A PST can easily be several GB. Nothing in this parser is allowed to hold the
 * whole file, so every layer below reaches the disk through this interface and
 * pulls only the 512-byte page or <=8KB block it actually needs. Backed by
 * `Blob.slice()` in the browser, which the UA services straight off the file
 * handle without materialising the rest.
 */
export interface ByteReader {
  readonly size: number;
  readAt(offset: number, length: number): Promise<Uint8Array>;
}

export function blobReader(blob: Blob): ByteReader {
  return {
    size: blob.size,
    async readAt(offset: number, length: number): Promise<Uint8Array> {
      if (!Number.isFinite(offset) || !Number.isFinite(length)) {
        throw new RangeError(`bad read: offset=${offset} length=${length}`);
      }
      if (offset < 0 || length < 0) {
        throw new RangeError(`negative read: offset=${offset} length=${length}`);
      }
      if (offset >= blob.size) return new Uint8Array(0);
      const end = Math.min(offset + length, blob.size);
      return new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    },
  };
}

/** Insertion-ordered LRU. Keeps the hot upper BTree pages resident. */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }
}

// Little-endian scalar reads. PST is little-endian throughout.

export function u8(b: Uint8Array, off: number): number {
  return b[off]!;
}

export function u16(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8);
}

export function u32(b: Uint8Array, off: number): number {
  return (
    (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0
  );
}

export function i32(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24);
}

export function u64(b: Uint8Array, off: number): bigint {
  return BigInt(u32(b, off)) | (BigInt(u32(b, off + 4)) << 32n);
}

export function i64(b: Uint8Array, off: number): bigint {
  const lo = BigInt(u32(b, off));
  const hi = BigInt(i32(b, off + 4));
  return (hi << 32n) | lo;
}

export function f32(b: Uint8Array, off: number): number {
  return new DataView(b.buffer, b.byteOffset + off, 4).getFloat32(0, true);
}

export function f64(b: Uint8Array, off: number): number {
  return new DataView(b.buffer, b.byteOffset + off, 8).getFloat64(0, true);
}

/** Reads an unsigned little-endian integer of `len` bytes as a BigInt. */
export function uint(b: Uint8Array, off: number, len: number): bigint {
  let v = 0n;
  for (let i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]!);
  return v;
}
