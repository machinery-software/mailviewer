/**
 * The streaming ZIP reader behind the .olm parser (MAC-513): the archive's
 * index first, then one entry at a time, never the whole file at once.
 */
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { crc32, readZipEntry, readZipIndex, ZipError } from "../zip";

const blob = (u8: Uint8Array): Blob => new Blob([u8 as BlobPart]);

/** A Blob that records every byte range read from it. */
function recording(u8: Uint8Array) {
  const reads: Array<[number, number]> = [];
  const base = blob(u8);
  const wrap = (b: Blob, offset: number): Blob =>
    ({
      size: b.size,
      slice(start = 0, end = b.size) {
        reads.push([offset + start, offset + Math.min(end, b.size)]);
        return wrap(b.slice(start, end), offset + start);
      },
      arrayBuffer: () => b.arrayBuffer(),
    }) as unknown as Blob;
  return { file: wrap(base, 0), reads };
}

/**
 * A stored-only ZIP written by hand, so the ZIP64 records can be forced on an
 * archive small enough for a unit test. fflate never writes ZIP64.
 */
function handZip(files: Record<string, Uint8Array>, { zip64 = false, comment = "" } = {}): Uint8Array {
  const parts: number[] = [];
  const central: number[] = [];
  const u16 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const u64 = (a: number[], v: number) => (u32(a, v >>> 0), u32(a, Math.floor(v / 0x100000000)));
  const names = Object.keys(files);
  for (const name of names) {
    const data = files[name];
    const nameBytes = strToU8(name);
    const offset = parts.length;
    const crc = crc32(data);
    u32(parts, 0x04034b50); u16(parts, 20); u16(parts, 0x0800); u16(parts, 0); u16(parts, 0); u16(parts, 0);
    u32(parts, crc); u32(parts, data.length); u32(parts, data.length); u16(parts, nameBytes.length); u16(parts, 0);
    parts.push(...nameBytes, ...data);

    const extra: number[] = [];
    if (zip64) {
      u16(extra, 0x0001); u16(extra, 24); u64(extra, data.length); u64(extra, data.length); u64(extra, offset);
    }
    u32(central, 0x02014b50); u16(central, 45); u16(central, 45); u16(central, 0x0800); u16(central, 0);
    u16(central, 0); u16(central, 0); u32(central, crc);
    u32(central, zip64 ? 0xffffffff : data.length); u32(central, zip64 ? 0xffffffff : data.length);
    u16(central, nameBytes.length); u16(central, extra.length); u16(central, 0); u16(central, 0); u16(central, 0);
    u32(central, 0); u32(central, zip64 ? 0xffffffff : offset);
    central.push(...nameBytes, ...extra);
  }
  const cdOffset = parts.length;
  parts.push(...central);
  const tail: number[] = [];
  if (zip64) {
    const z64At = parts.length;
    u32(tail, 0x06064b50); u64(tail, 44); u16(tail, 45); u16(tail, 45); u32(tail, 0); u32(tail, 0);
    u64(tail, names.length); u64(tail, names.length); u64(tail, central.length); u64(tail, cdOffset);
    u32(tail, 0x07064b50); u32(tail, 0); u64(tail, z64At); u32(tail, 1);
  }
  const commentBytes = strToU8(comment);
  u32(tail, 0x06054b50); u16(tail, 0); u16(tail, 0);
  u16(tail, zip64 ? 0xffff : names.length); u16(tail, zip64 ? 0xffff : names.length);
  u32(tail, zip64 ? 0xffffffff : central.length); u32(tail, zip64 ? 0xffffffff : cdOffset);
  u16(tail, commentBytes.length);
  return new Uint8Array([...parts, ...tail, ...commentBytes]);
}

describe("readZipIndex / readZipEntry", () => {
  it("lists entries from the index, then reads one without touching the rest", async () => {
    const big = new Uint8Array(400_000).map((_, i) => (i * 31) & 0xff);
    const zip = zipSync({ "a/one.xml": strToU8("<one/>"), "b/big.bin": [big, { level: 0 }], "c/two.xml": strToU8("<two/>") });
    const { file, reads } = recording(zip);

    const index = await readZipIndex(file);
    expect(index.map((e) => e.name)).toEqual(["a/one.xml", "b/big.bin", "c/two.xml"]);
    // Only the tail of the file, where the index lives.
    expect(reads.every(([s]) => s >= zip.length - (22 + 0xffff) - 200)).toBe(true);

    reads.length = 0;
    const two = await readZipEntry(file, index[2]);
    expect(new TextDecoder().decode(two)).toBe("<two/>");
    const touched = reads.reduce((n, [s, e]) => n + (e - s), 0);
    expect(touched).toBeLessThan(200);
  });

  it("inflates deflated entries and returns stored ones as they are", async () => {
    const text = strToU8("compress me ".repeat(500));
    const zip = zipSync({ "d.txt": [text, { level: 9 }], "s.txt": [text, { level: 0 }] });
    const index = await readZipIndex(blob(zip));
    expect(index.map((e) => e.method)).toEqual([8, 0]);
    for (const e of index) expect(await readZipEntry(blob(zip), e)).toEqual(text);
  });

  it("finds the index behind an archive comment", async () => {
    const zip = handZip({ "x.txt": strToU8("x") }, { comment: "PK\u0005\u0006 decoy in the comment" });
    const index = await readZipIndex(blob(zip));
    expect(index.map((e) => e.name)).toEqual(["x.txt"]);
  });

  it("reads ZIP64 archives, which is what an export past 4 GB is", async () => {
    const zip = handZip({ "Accounts/a/com.microsoft.__Messages/Inbox/m.xml": strToU8("<emails/>"), "y.bin": strToU8("yy") }, { zip64: true });
    const index = await readZipIndex(blob(zip));
    expect(index.map((e) => [e.name, e.size])).toEqual([
      ["Accounts/a/com.microsoft.__Messages/Inbox/m.xml", 9],
      ["y.bin", 2],
    ]);
    expect(new TextDecoder().decode(await readZipEntry(blob(zip), index[0]))).toBe("<emails/>");
  });

  it("says a truncated archive has no index", async () => {
    const zip = zipSync({ "a.txt": strToU8("a".repeat(5000)) });
    await expect(readZipIndex(blob(zip.slice(0, zip.length - 30)))).rejects.toThrow(ZipError);
    await expect(readZipIndex(blob(new Uint8Array(10)))).rejects.toThrow(/too short/);
  });

  it("refuses an entry whose bytes fail the checksum", async () => {
    const zip = zipSync({ "a.txt": [strToU8("hello world"), { level: 0 }] });
    const index = await readZipIndex(blob(zip));
    const damaged = zip.slice();
    damaged[30 + "a.txt".length] ^= 0xff; // first data byte of the only entry
    await expect(readZipEntry(blob(damaged), index[0])).rejects.toThrow(/checksum/);
  });

  it("refuses damaged deflate data rather than returning garbage", async () => {
    const zip = zipSync({ "a.txt": [strToU8("hello world ".repeat(100)), { level: 9 }] });
    const index = await readZipIndex(blob(zip));
    const damaged = zip.slice();
    for (let k = 0; k < 8; k++) damaged[30 + 5 + k] = 0xff;
    await expect(readZipEntry(blob(damaged), index[0])).rejects.toThrow(ZipError);
  });

  it("computes the standard CRC-32", () => {
    expect(crc32(strToU8("123456789"))).toBe(0xcbf43926);
  });
});
