import { describe, expect, it } from "vitest";
import { CfbError, parseCfb } from "../cfb.ts";
import { buildCfb, storage, stream } from "./cfbBuilder.ts";

/** Deterministic pseudo-random bytes, so a failure is reproducible. */
function pattern(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

describe("parseCfb: header validation", () => {
  it("rejects a file without the magic", () => {
    const bytes = new Uint8Array(1024);
    expect(() => parseCfb(bytes)).toThrow(CfbError);
    expect(() => parseCfb(bytes)).toThrow(/signature/i);
  });

  it("rejects a file too short to hold a header", () => {
    const bytes = new Uint8Array(64);
    bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(() => parseCfb(bytes)).toThrow(/too short/i);
  });

  it("rejects an unsupported sector shift", () => {
    const bytes = buildCfb([stream("x", "hello")]);
    new DataView(bytes.buffer).setUint16(30, 10, true); // neither 9 nor 12
    expect(() => parseCfb(bytes)).toThrow(/sector shift/i);
  });

  it("accepts a well-formed v3 container", () => {
    const cfb = parseCfb(buildCfb([stream("x", "hello")]));
    expect(cfb.version).toBe(3);
    expect(cfb.sectorSize).toBe(512);
    expect(cfb.miniSectorSize).toBe(64);
    expect(cfb.root.type).toBe("root");
    expect(cfb.warnings).toEqual([]);
  });
});

describe("parseCfb: stream round-trips", () => {
  it("reads a small stream out of the mini stream", () => {
    const data = pattern(100);
    const cfb = parseCfb(buildCfb([stream("small", data)]));

    const entry = cfb.getEntry("small");
    expect(entry?.type).toBe("stream");
    expect(entry?.size).toBe(100);
    // 100 bytes is well under the 4096 cutoff, so this must have come out of
    // the mini stream -- the whole point of the fixture.
    expect(entry!.size).toBeLessThan(4096);
    expect(cfb.readStream(entry!)).toEqual(data);
  });

  it("reads a large stream out of ordinary sectors", () => {
    const data = pattern(10_000, 7);
    const cfb = parseCfb(buildCfb([stream("big", data)]));

    const entry = cfb.getEntry("big")!;
    expect(entry.size).toBe(10_000);
    expect(entry.size).toBeGreaterThanOrEqual(4096);
    expect(cfb.readStream(entry)).toEqual(data);
  });

  it("round-trips mini and regular streams side by side", () => {
    const small = pattern(63, 11); // one byte short of a full mini sector
    const exact = pattern(64, 12); // exactly one mini sector
    const big = pattern(4096, 13); // exactly at the cutoff -> regular sectors
    const huge = pattern(9999, 14);

    const cfb = parseCfb(
      buildCfb([
        stream("small", small),
        stream("exact", exact),
        stream("big", big),
        stream("huge", huge),
      ]),
    );

    expect(cfb.readPath("small")).toEqual(small);
    expect(cfb.readPath("exact")).toEqual(exact);
    expect(cfb.readPath("big")).toEqual(big);
    expect(cfb.readPath("huge")).toEqual(huge);
    expect(cfb.warnings).toEqual([]);
  });

  it("handles a stream that straddles many mini sectors", () => {
    // 4095 is the largest size that still lands in the mini stream: 64 mini
    // sectors, the last one partly filled.
    const data = pattern(4095, 21);
    const cfb = parseCfb(buildCfb([stream("edge", data)]));
    expect(cfb.readPath("edge")).toEqual(data);
  });

  it("reads a zero-length stream", () => {
    const cfb = parseCfb(buildCfb([stream("empty", new Uint8Array(0))]));
    expect(cfb.readPath("empty")).toEqual(new Uint8Array(0));
  });

  it("spans multiple FAT sectors when the file is large enough", () => {
    // One FAT sector maps 128 sectors = 64 KiB. Force at least two.
    const data = pattern(200_000, 31);
    const cfb = parseCfb(buildCfb([stream("verybig", data)]));
    expect(cfb.readPath("verybig")).toEqual(data);
  });
});

describe("parseCfb: directory tree", () => {
  it("reconstructs nested storages and their paths", () => {
    const cfb = parseCfb(
      buildCfb([
        stream("top", "a"),
        storage("dir", [
          stream("inner", "b"),
          storage("nested", [stream("deep", "c")]),
        ]),
      ]),
    );

    expect(cfb.listPaths().sort()).toEqual(
      ["dir", "dir/inner", "dir/nested", "dir/nested/deep", "top"].sort(),
    );

    expect(cfb.getEntry("dir")?.type).toBe("storage");
    expect(cfb.getEntry(["dir", "nested"])?.type).toBe("storage");
    expect(new TextDecoder().decode(cfb.readPath(["dir", "nested", "deep"])!)).toBe("c");
    expect(new TextDecoder().decode(cfb.readPath("dir/inner")!)).toBe("b");
  });

  it("exposes children in the parent entry", () => {
    const cfb = parseCfb(
      buildCfb([storage("s", [stream("a", "1"), stream("b", "2"), stream("c", "3")])]),
    );
    const s = cfb.getEntry("s")!;
    expect(s.children.map((c) => c.name).sort()).toEqual(["a", "b", "c"]);
    expect(cfb.root.children.map((c) => c.name)).toEqual(["s"]);
  });

  it("survives a directory whose sibling ids form a cycle", () => {
    const bytes = buildCfb([stream("a", "1"), stream("b", "2")]);
    // Entry 1's right sibling is entry 2; point entry 2's right back at 1.
    // The reader must notice and stop rather than recurse forever.
    const cfb0 = parseCfb(bytes);
    const dirSector = new DataView(bytes.buffer).getUint32(48, true);
    const dirBase = 512 + dirSector * 512;
    new DataView(bytes.buffer).setUint32(dirBase + 2 * 128 + 72, 1, true);

    const cfb = parseCfb(bytes);
    expect(cfb.warnings.join(" ")).toMatch(/twice/i);
    // The entries it did reach are still readable.
    expect(cfb0.listPaths().length).toBe(2);
    expect(cfb.getEntry("a")).toBeDefined();
  });

  it("throws when the first directory entry is not a root", () => {
    const bytes = buildCfb([stream("a", "1")]);
    const dirSector = new DataView(bytes.buffer).getUint32(48, true);
    const dirBase = 512 + dirSector * 512;
    new DataView(bytes.buffer).setUint8(dirBase + 66, 2); // claim it is a stream
    expect(() => parseCfb(bytes)).toThrow(/not the root/i);
  });
});

describe("parseCfb: reading interface", () => {
  it("returns undefined for a missing path", () => {
    const cfb = parseCfb(buildCfb([stream("a", "1")]));
    expect(cfb.readPath("nope")).toBeUndefined();
    expect(cfb.getEntry("nope")).toBeUndefined();
  });

  it("returns undefined rather than bytes when the path is a storage", () => {
    const cfb = parseCfb(buildCfb([storage("s", [stream("a", "1")])]));
    expect(cfb.readPath("s")).toBeUndefined();
  });

  it("throws when asked to read a storage as a stream", () => {
    const cfb = parseCfb(buildCfb([storage("s", [])]));
    expect(() => cfb.readStream(cfb.getEntry("s")!)).toThrow(/not a stream/i);
  });

  it("does not hand back a view aliasing the source buffer", () => {
    // Callers keep attachment bytes around long after the file is gone; a
    // subarray into the original would quietly pin (or expose) the whole file.
    const data = pattern(9000, 41);
    const source = buildCfb([stream("big", data)]);
    const cfb = parseCfb(source);
    const read = cfb.readStream(cfb.getEntry("big")!);
    read[0] = read[0] ^ 0xff;
    expect(cfb.readStream(cfb.getEntry("big")!)[0]).toBe(data[0]);
  });
});
