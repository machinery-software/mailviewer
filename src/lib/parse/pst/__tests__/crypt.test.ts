import { describe, expect, it } from "vitest";
import {
  cyclic,
  decodeBlock,
  MPBB_I,
  MPBB_R,
  MPBB_S,
  NDB_CRYPT_CYCLIC,
  NDB_CRYPT_NONE,
  NDB_CRYPT_PERMUTE,
  permuteDecode,
  permuteEncode,
} from "../crypt.ts";

/**
 * The three substitution tables are transcribed constants, so the first thing
 * worth testing is that they are the tables they claim to be. Every algebraic
 * property the two ciphers rely on falls out of these three facts.
 */
describe("mpbb tables", () => {
  it("R, S and I are each permutations of 0..255", () => {
    for (const table of [MPBB_R, MPBB_S, MPBB_I]) {
      expect(table).toHaveLength(256);
      expect([...table].sort((a, b) => a - b)).toEqual([...Array(256).keys()]);
    }
  });

  it("I is exactly the inverse of R", () => {
    for (let i = 0; i < 256; i++) {
      expect(MPBB_I[MPBB_R[i]!]).toBe(i);
      expect(MPBB_R[MPBB_I[i]!]).toBe(i);
    }
  });

  it("S is self-inverse -- which is what makes the cyclic cipher involutive", () => {
    for (let i = 0; i < 256; i++) {
      expect(MPBB_S[MPBB_S[i]!]).toBe(i);
    }
  });
});

const everyByte = () => Uint8Array.from({ length: 256 }, (_, i) => i);

describe("NDB_CRYPT_PERMUTE", () => {
  it("decrypt(encrypt(x)) === x for every byte value", () => {
    const original = everyByte();
    const round = permuteDecode(permuteEncode(everyByte()));
    expect(round).toEqual(original);
  });

  it("encrypt(decrypt(x)) === x too", () => {
    const original = everyByte();
    const round = permuteEncode(permuteDecode(everyByte()));
    expect(round).toEqual(original);
  });

  it("actually changes the data (it is not accidentally the identity)", () => {
    expect(permuteEncode(everyByte())).not.toEqual(everyByte());
  });
});

describe("NDB_CRYPT_CYCLIC", () => {
  // The cyclic cipher is its own inverse: applying it twice with the same key
  // must return the original bytes.
  it("is involutive for a range of keys and lengths", () => {
    const keys = [0, 1, 0xffff, 0x10000, 0xdeadbeef, 0x7fffffff, 0xffffffff];
    for (const key of keys) {
      for (const len of [0, 1, 7, 64, 255, 256, 1000]) {
        const original = Uint8Array.from({ length: len }, (_, i) => (i * 31 + 7) & 0xff);
        const once = cyclic(original.slice(), key);
        const twice = cyclic(once.slice(), key);
        expect(twice, `key=${key} len=${len}`).toEqual(original);
      }
    }
  });

  it("depends on the key -- a different key gives different ciphertext", () => {
    const data = everyByte();
    expect(cyclic(data.slice(), 1)).not.toEqual(cyclic(data.slice(), 2));
  });

  it("depends on position -- the keystream advances per byte", () => {
    // Two identical bytes at different offsets must not encode identically,
    // otherwise the per-byte counter is not being applied.
    const flat = new Uint8Array(64).fill(0x41);
    const enc = cyclic(flat, 0x1234);
    expect(new Set(enc).size).toBeGreaterThan(1);
  });
});

describe("decodeBlock", () => {
  it("leaves data alone under NDB_CRYPT_NONE", () => {
    const data = everyByte();
    expect(decodeBlock(data.slice(), NDB_CRYPT_NONE, 0)).toEqual(everyByte());
  });

  it("dispatches to the permute scheme", () => {
    const encoded = permuteEncode(everyByte());
    expect(decodeBlock(encoded, NDB_CRYPT_PERMUTE, 0)).toEqual(everyByte());
  });

  it("dispatches to the cyclic scheme, using the block's BID as the key", () => {
    const key = 0x0badf00d;
    const encoded = cyclic(everyByte(), key);
    expect(decodeBlock(encoded, NDB_CRYPT_CYCLIC, key)).toEqual(everyByte());
  });

  it("passes unknown schemes through untouched rather than corrupting them", () => {
    const data = everyByte();
    expect(decodeBlock(data.slice(), 0x99, 0)).toEqual(everyByte());
  });
});
