import { describe, expect, it } from "vitest";
import {
  LZFU_PREBUF_SIZE,
  LzfuError,
  decompressLzfu,
  readLzfuHeader,
  seedLzfuDictionary,
} from "../lzfu.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (hex: string) => Uint8Array.from(hex.trim().split(/\s+/), (h) => parseInt(h, 16));
const ascii = (b: Uint8Array) => new TextDecoder("windows-1252").decode(b);

/** Assemble an LZFu stream header + payload. */
function withHeader(
  payload: Uint8Array,
  opts: { rawSize: number; magic: number; crc?: number; compressedSize?: number },
): Uint8Array {
  const out = new Uint8Array(16 + payload.length);
  const dv = new DataView(out.buffer);
  // compressedSize covers everything after its own four bytes.
  dv.setUint32(0, opts.compressedSize ?? 12 + payload.length, true);
  dv.setUint32(4, opts.rawSize, true);
  dv.setUint32(8, opts.magic, true);
  dv.setUint32(12, opts.crc ?? 0, true);
  out.set(payload, 16);
  return out;
}

const MAGIC_LZFU = 0x75465a4c;
const MAGIC_MELA = 0x414c454d;

/**
 * A literals-only compressor. Every control byte is 0x00, meaning "the next
 * eight bytes are literals", so the output is the input. This exercises the
 * literal path and the control-byte bit walk without depending on any
 * particular back-reference choices.
 */
function compressLiteralsOnly(raw: Uint8Array): Uint8Array {
  const body: number[] = [];
  for (let i = 0; i < raw.length; i += 8) {
    body.push(0x00);
    for (let j = i; j < Math.min(i + 8, raw.length); j++) body.push(raw[j]);
  }
  return withHeader(new Uint8Array(body), { rawSize: raw.length, magic: MAGIC_LZFU });
}

describe("LZFu: the initial dictionary", () => {
  it("is 207 bytes, as the spec fixes it", () => {
    // Every back-reference in every compressed stream is an offset into this
    // dictionary. If its length drifts, every file in the world decodes to
    // garbage -- so pin it.
    expect(LZFU_PREBUF_SIZE).toBe(207);
  });

  it("starts with the RTF preamble the format mandates", () => {
    const dict = seedLzfuDictionary();
    expect(ascii(dict.subarray(0, 42))).toBe("{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}");
    // ...and ends with \tx, immediately before the zero fill.
    expect(ascii(dict.subarray(204, 207))).toBe("\\tx");
    expect(dict[207]).toBe(0);
    expect(dict).toHaveLength(4096);
  });
});

describe("LZFu: header", () => {
  it("reads the four header fields", () => {
    const s = withHeader(new Uint8Array([1, 2, 3]), {
      rawSize: 42,
      magic: MAGIC_LZFU,
      crc: 0xdeadbeef,
    });
    const h = readLzfuHeader(s);
    expect(h.rawSize).toBe(42);
    expect(h.crc).toBe(0xdeadbeef);
    expect(h.compressed).toBe(true);
    expect(h.compressedSize).toBe(15); // 12 + 3 payload bytes
  });

  it("rejects an unknown magic", () => {
    const s = withHeader(new Uint8Array(4), { rawSize: 4, magic: 0x11223344 });
    expect(() => readLzfuHeader(s)).toThrow(LzfuError);
    expect(() => readLzfuHeader(s)).toThrow(/magic/i);
  });

  it("rejects a stream shorter than its header", () => {
    expect(() => decompressLzfu(new Uint8Array(8))).toThrow(/16-byte header/);
  });

  it("rejects a runt stream rather than pretending it decoded to nothing", () => {
    // Four bytes cannot be a compressed-RTF stream. Callers wrap this in a
    // try/catch and record a warning; silently handing back an empty body
    // would hide a corrupt property.
    expect(() => decompressLzfu(bytes("00 00 00 00"))).toThrow(LzfuError);
  });

  it("rejects an unknown magic from decompressLzfu, not just the header reader", () => {
    const input = new Uint8Array(20);
    new DataView(input.buffer).setUint32(8, 0x12345678, true);
    expect(() => decompressLzfu(input)).toThrow(/magic/i);
  });
});

describe("LZFu: decompression", () => {
  /**
   * The worked example from MS-OXRTFCP. This is the vector that proves the
   * dictionary is seeded correctly: the opening `{\rtf1\ansi\ansicpg1252\pard`
   * is produced almost entirely from back-references into the prebuffer, before
   * a single literal has been written.
   */
  it("matches the spec's worked example", () => {
    const compressed = new Uint8Array([
      0x2d, 0x00, 0x00, 0x00, // compressedSize = 45
      0x2b, 0x00, 0x00, 0x00, // rawSize = 43
      0x4c, 0x5a, 0x46, 0x75, // "LZFu"
      0xf1, 0xc5, 0xc7, 0xa7, // crc
      0x03, 0x00, 0x0a, 0x00, 0x72, 0x63, 0x70, 0x67, 0x31, 0x32, 0x35, 0x42,
      0x32, 0x0a, 0xf3, 0x20, 0x68, 0x65, 0x6c, 0x09, 0x00, 0x20, 0x62, 0x77,
      0x05, 0xb0, 0x6c, 0x64, 0x7d, 0x0a, 0x80, 0x0f, 0xa0,
    ]);

    const out = decompressLzfu(compressed);
    expect(dec.decode(out)).toBe("{\\rtf1\\ansi\\ansicpg1252\\pard hello world}\r\n");
    expect(out.length).toBe(43);
  });

  it("returns an uncompressed (MELA) payload verbatim", () => {
    const raw = enc.encode("{\\rtf1\\ansi plain}");
    const s = withHeader(raw, { rawSize: raw.length, magic: MAGIC_MELA });
    expect(dec.decode(decompressLzfu(s))).toBe("{\\rtf1\\ansi plain}");
  });

  it("truncates a MELA payload to rawSize", () => {
    const raw = enc.encode("abcdefghij");
    const s = withHeader(raw, { rawSize: 4, magic: MAGIC_MELA });
    expect(dec.decode(decompressLzfu(s))).toBe("abcd");
  });

  it("round-trips a literals-only stream", () => {
    const raw = enc.encode(
      "{\\rtf1\\ansi\\deff0 The quick brown fox jumps over the lazy dog.}",
    );
    expect(decompressLzfu(compressLiteralsOnly(raw))).toEqual(raw);
  });

  it("round-trips binary content through the literal path", () => {
    const raw = new Uint8Array(300);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 37) & 0xff;
    expect(decompressLzfu(compressLiteralsOnly(raw))).toEqual(raw);
  });

  it("resolves a back-reference into the seeded dictionary", () => {
    // Dictionary offset 0, length 6 -> the first six prebuffer bytes, "{\rtf1".
    // Control byte 0x01: bit 0 set (a reference), the rest unused.
    const lenBits = 6 - 2;
    const payload = new Uint8Array([0x01, 0x00, (0x0 << 4) | lenBits]);
    const s = withHeader(payload, { rawSize: 6, magic: MAGIC_LZFU });
    expect(dec.decode(decompressLzfu(s))).toBe("{\\rtf1");
  });

  it("stops at the end-of-stream marker", () => {
    // Two literals ("ab"), then a reference whose offset equals the current
    // write cursor (207 + 2 = 209) -- the documented terminator.
    const cursor = LZFU_PREBUF_SIZE + 2;
    const payload = new Uint8Array([
      0x04, // bits: literal, literal, reference
      0x61, // 'a'
      0x62, // 'b'
      cursor >> 4,
      ((cursor & 0x0f) << 4) | 0x0,
      0x99, // trailing junk that must never be reached
      0x99,
    ]);
    // rawSize deliberately overstates the output; the terminator must win.
    const s = withHeader(payload, { rawSize: 100, magic: MAGIC_LZFU });
    expect(dec.decode(decompressLzfu(s))).toBe("ab");
  });

  it("does not overrun a truncated stream", () => {
    const full = compressLiteralsOnly(enc.encode("hello world, this is a body"));
    const truncated = full.subarray(0, full.length - 5);
    // Nothing to assert about the content beyond "it terminated and produced a
    // prefix"; the point is that it neither throws nor spins.
    const out = decompressLzfu(truncated);
    expect(out.length).toBeLessThanOrEqual(26);
    expect(dec.decode(out).startsWith("hello")).toBe(true);
  });

  it("does not over-allocate when rawSize is a lie", () => {
    // A corrupt header claiming 4GB of output must not take the worker down:
    // the payload is the only thing that can actually produce bytes.
    const input = bytes("10 00 00 00 ff ff ff ff 4c 5a 46 75 00 00 00 00 00 00 00 00");
    let out: Uint8Array | undefined;
    expect(() => (out = decompressLzfu(input))).not.toThrow();
    expect(out!.length).toBeLessThan(16);
  });

  it("clamps output at rawSize even if the payload keeps going", () => {
    const raw = enc.encode("abcdefghijklmnop");
    const s = compressLiteralsOnly(raw);
    new DataView(s.buffer).setUint32(4, 5, true); // claim only 5 raw bytes
    expect(dec.decode(decompressLzfu(s))).toBe("abcde");
  });
});
