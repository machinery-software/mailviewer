import { describe, expect, it } from "vitest";
import {
  codepageLabel,
  decodeInline,
  decodeObjectRef,
  decodeValue,
  filetimeToDate,
  fixedSize,
  formatGuid,
  hnidIsHid,
  isInlinePc,
  PT_BINARY,
  PT_BOOLEAN,
  PT_CLSID,
  PT_I2,
  PT_I8,
  PT_LONG,
  PT_STRING8,
  PT_SYSTIME,
  PT_UNICODE,
} from "../props.ts";

const le = (...bytes: number[]) => Uint8Array.from(bytes);

describe("filetimeToDate", () => {
  /**
   * FILETIME counts 100ns ticks from 1601-01-01. The interesting failure mode
   * is precision: the tick count blows past Number.MAX_SAFE_INTEGER for modern
   * dates, so the conversion has to stay in BigInt until after the divide.
   */
  it("maps the Unix epoch exactly", () => {
    const d = filetimeToDate(116444736000000000n);
    expect(d?.toISOString()).toBe("1970-01-01T00:00:00.000Z");
  });

  it("converts modern timestamps without losing precision", () => {
    expect(filetimeToDate(130000000000000000n)?.toISOString()).toBe("2012-12-14T23:06:40.000Z");
    expect(filetimeToDate(132000000000000000n)?.toISOString()).toBe("2019-04-17T18:40:00.000Z");
  });

  it("keeps millisecond resolution", () => {
    // One extra millisecond = 10,000 ticks. A float64 round-trip would lose this.
    const d = filetimeToDate(116444736000000000n + 10000n);
    expect(d?.toISOString()).toBe("1970-01-01T00:00:00.001Z");
  });

  it("treats zero and negative tick counts as 'no date'", () => {
    expect(filetimeToDate(0n)).toBeNull();
    expect(filetimeToDate(-1n)).toBeNull();
  });

  it("handles the largest representable tick counts without producing an Invalid Date", () => {
    // Worth being precise here: no 64-bit FILETIME can actually overflow a JS
    // Date. Even 2^64-1 ticks only reaches the year ~60056, well inside Date's
    // +/-275760 range. So these must come back as real Dates, not null.
    expect(filetimeToDate(0x7fffffffffffffffn)).toBeInstanceOf(Date);
    expect(filetimeToDate(0xffffffffffffffffn)).toBeInstanceOf(Date);
  });

  it("returns null when a tick count is beyond what a Date can represent", () => {
    // Unreachable from a real uint64 field, but the guard has to hold if a
    // caller hands us a crafted BigInt rather than 8 bytes off the disk.
    expect(filetimeToDate(10n ** 25n)).toBeNull();
  });

  it("decodes a PtypTime property from its 8 raw bytes", () => {
    // 116444736000000000 = 0x019DB1DED53E8000, little-endian on the wire.
    const raw = le(0x00, 0x80, 0x3e, 0xd5, 0xde, 0xb1, 0x9d, 0x01);
    const v = decodeValue(PT_SYSTIME, raw, undefined);
    expect(v).toBeInstanceOf(Date);
    expect((v as Date).toISOString()).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("fixedSize / isInlinePc", () => {
  it("knows which types fit inline in a PC's dwValueHnid", () => {
    expect(isInlinePc(PT_I2)).toBe(true);
    expect(isInlinePc(PT_LONG)).toBe(true);
    expect(isInlinePc(PT_BOOLEAN)).toBe(true);
    // 8 bytes: too wide for the 4-byte inline slot, so it becomes an HNID.
    expect(isInlinePc(PT_I8)).toBe(false);
    expect(isInlinePc(PT_SYSTIME)).toBe(false);
    expect(isInlinePc(PT_UNICODE)).toBe(false);
    expect(isInlinePc(PT_BINARY)).toBe(false);
  });

  it("reports PtypGuid as variable-length, because 16 bytes never sit inline", () => {
    expect(fixedSize(PT_CLSID)).toBeNull();
  });
});

describe("decodeValue", () => {
  it("sign-extends PtypInteger16", () => {
    expect(decodeValue(PT_I2, le(0xff, 0xff), undefined)).toBe(-1);
    expect(decodeValue(PT_I2, le(0x2a, 0x00), undefined)).toBe(42);
  });

  it("sign-extends PtypInteger32", () => {
    expect(decodeValue(PT_LONG, le(0xff, 0xff, 0xff, 0xff), undefined)).toBe(-1);
  });

  it("decodes PtypInteger64 as a BigInt", () => {
    expect(decodeValue(PT_I8, le(0x01, 0, 0, 0, 0, 0, 0, 0), undefined)).toBe(1n);
    expect(decodeValue(PT_I8, le(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), undefined)).toBe(-1n);
  });

  it("decodes PtypBoolean", () => {
    expect(decodeValue(PT_BOOLEAN, le(0x01), undefined)).toBe(true);
    expect(decodeValue(PT_BOOLEAN, le(0x00), undefined)).toBe(false);
  });

  it("decodes PtypString as UTF-16LE and drops the trailing NUL", () => {
    // "hi\0" in UTF-16LE
    const raw = le(0x68, 0x00, 0x69, 0x00, 0x00, 0x00);
    expect(decodeValue(PT_UNICODE, raw, undefined)).toBe("hi");
  });

  it("survives an odd-length UTF-16 buffer instead of throwing", () => {
    expect(decodeValue(PT_UNICODE, le(0x68, 0x00, 0x69), undefined)).toBe("h");
  });

  it("decodes PtypString8 against the supplied codepage", () => {
    // 0xE9 is e-acute in windows-1252 but a different letter in 1251.
    expect(decodeValue(PT_STRING8, le(0x63, 0x61, 0x66, 0xe9), 1252)).toBe("café");
    expect(decodeValue(PT_STRING8, le(0xe9), 1251)).toBe("й");
  });

  it("hands PtypBinary back untouched", () => {
    const raw = le(1, 2, 3);
    expect(decodeValue(PT_BINARY, raw, undefined)).toEqual(raw);
  });

  it("formats PtypGuid", () => {
    // 00112233-4455-6677-8899-aabbccddeeff, mixed-endian as on the wire.
    const raw = le(
      0x33, 0x22, 0x11, 0x00, 0x55, 0x44, 0x77, 0x66, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
    );
    expect(formatGuid(raw)).toBe("00112233-4455-6677-8899-AABBCCDDEEFF");
  });
});

describe("multi-valued properties", () => {
  it("decodes a fixed-width multi-value as a packed array", () => {
    // PtypMultipleInteger32: three packed int32s, no offset table.
    const raw = le(1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0);
    expect(decodeValue(PT_LONG | 0x1000, raw, undefined)).toEqual([1, 2, 3]);
  });

  it("decodes a variable-width multi-value via its offset table", () => {
    /**
     * PtypMultipleString layout: a uint32 count, then `count` uint32 offsets,
     * then the items. Item i runs to the next offset, and the last runs to the
     * end of the blob -- there is no terminating offset.
     */
    const count = 2;
    const headerLen = 4 + count * 4;
    const a = [0x61, 0x00, 0x62, 0x00]; // "ab" UTF-16LE
    const b = [0x63, 0x00]; // "c"
    const raw = new Uint8Array(headerLen + a.length + b.length);
    const dv = new DataView(raw.buffer);
    dv.setUint32(0, count, true);
    dv.setUint32(4, headerLen, true);
    dv.setUint32(8, headerLen + a.length, true);
    raw.set(a, headerLen);
    raw.set(b, headerLen + a.length);

    expect(decodeValue(PT_UNICODE | 0x1000, raw, undefined)).toEqual(["ab", "c"]);
  });

  it("refuses a count the blob cannot possibly back", () => {
    const raw = new Uint8Array(8);
    new DataView(raw.buffer).setUint32(0, 0xffffff, true);
    expect(decodeValue(PT_UNICODE | 0x1000, raw, undefined)).toEqual([]);
  });
});

describe("decodeInline", () => {
  it("reads a PC's 4-byte inline slot by type", () => {
    expect(decodeInline(PT_LONG, 0xffffffff)).toBe(-1);
    expect(decodeInline(PT_I2, 0xffff)).toBe(-1);
    expect(decodeInline(PT_BOOLEAN, 1)).toBe(true);
    expect(decodeInline(PT_BOOLEAN, 0)).toBe(false);
  });
});

describe("hnidIsHid", () => {
  /**
   * The HNID discriminator: low 5 bits zero means it is a heap ID, otherwise it
   * is an NID naming a subnode. Get this backwards and every long body reads as
   * a heap offset into the wrong block.
   */
  it("treats a zero type nibble as a heap ID", () => {
    expect(hnidIsHid(0x0020)).toBe(true); // HID, index 1, block 0
    expect(hnidIsHid(0x0000)).toBe(true);
  });

  it("treats a non-zero type nibble as a subnode NID", () => {
    expect(hnidIsHid(0x0692)).toBe(false); // NID_RECIPIENT_TABLE
    expect(hnidIsHid(0x8005)).toBe(false);
  });
});

describe("decodeObjectRef", () => {
  it("reads the (nid, size) pair a PtypObject points at", () => {
    const raw = le(0x0d, 0x80, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00);
    expect(decodeObjectRef(raw)).toEqual({ nid: 0x800d, size: 64 });
  });

  it("returns null on a truncated item", () => {
    expect(decodeObjectRef(le(1, 2, 3))).toBeNull();
  });
});

describe("codepageLabel", () => {
  it("maps the codepages Outlook actually emits", () => {
    expect(codepageLabel(65001)).toBe("utf-8");
    expect(codepageLabel(1252)).toBe("windows-1252");
    expect(codepageLabel(932)).toBe("shift_jis");
    expect(codepageLabel(28591)).toBe("iso-8859-1");
  });

  it("falls back to windows-1252 for absent or unknown codepages", () => {
    expect(codepageLabel(undefined)).toBe("windows-1252");
    expect(codepageLabel(0)).toBe("windows-1252");
    expect(codepageLabel(999999)).toBe("windows-1252");
  });
});
