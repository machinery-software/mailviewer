/**
 * MAPI property types and tags, and the decoding of a raw property value into
 * a JS value.
 *
 * Two storage rules matter and they differ between the two containers:
 *
 *   Property Context: a value that fits in 4 bytes is stored *inline* in the
 *   dwValueHnid field. Anything larger is an HNID -- either a heap ID pointing
 *   into the same Heap-on-Node, or a NID pointing at a subnode. Long bodies and
 *   attachment payloads always take the subnode route.
 *
 *   Table Context: the column descriptor's cbData decides. Fixed types up to 8
 *   bytes sit inline in the row; everything else is a 4-byte HNID.
 */
import { f32, f64, i64, u16, u32, u64, uint } from "./reader.ts";

// ---------------------------------------------------------------- types

export const PT_UNSPECIFIED = 0x0000;
export const PT_NULL = 0x0001;
export const PT_I2 = 0x0002; // PtypInteger16
export const PT_LONG = 0x0003; // PtypInteger32
export const PT_R4 = 0x0004; // PtypFloating32
export const PT_DOUBLE = 0x0005; // PtypFloating64
export const PT_CURRENCY = 0x0006;
export const PT_APPTIME = 0x0007; // PtypFloatingTime
export const PT_ERROR = 0x000a;
export const PT_BOOLEAN = 0x000b;
export const PT_OBJECT = 0x000d;
export const PT_I8 = 0x0014; // PtypInteger64
export const PT_STRING8 = 0x001e; // codepage string
export const PT_UNICODE = 0x001f; // UTF-16LE
export const PT_SYSTIME = 0x0040; // FILETIME
export const PT_CLSID = 0x0048; // GUID
export const PT_SVREID = 0x00fb;
export const PT_SRESTRICT = 0x00fd;
export const PT_ACTIONS = 0x00fe;
export const PT_BINARY = 0x0102;

export const MV_FLAG = 0x1000;

/** An embedded-object reference: PtypObject points at a subnode, not bytes. */
export interface ObjectRef {
  nid: number;
  size: number;
}

export type PropValue =
  | number
  | bigint
  | boolean
  | string
  | Uint8Array
  | Date
  | ObjectRef
  | null
  | PropValue[];

export interface PropEntry {
  id: number;
  type: number;
  value: PropValue;
}

/**
 * Byte width of a fixed-size type, or null if the type is variable-length.
 *
 * Note PtypGuid (16 bytes) is deliberately *not* here: although it is a fixed
 * size, it exceeds the 8-byte inline budget and so is always stored as an HNID
 * in both containers.
 */
export function fixedSize(type: number): number | null {
  switch (type) {
    case PT_I2:
    case PT_BOOLEAN:
      return 2;
    case PT_LONG:
    case PT_R4:
    case PT_ERROR:
      return 4;
    case PT_DOUBLE:
    case PT_CURRENCY:
    case PT_APPTIME:
    case PT_I8:
    case PT_SYSTIME:
      return 8;
    default:
      return null;
  }
}

/** True when a PC stores this type's value directly in dwValueHnid. */
export function isInlinePc(type: number): boolean {
  const sz = fixedSize(type);
  return sz !== null && sz <= 4;
}

export function isMultiValued(type: number): boolean {
  return (type & MV_FLAG) !== 0 && type !== PT_BINARY;
}

// ---------------------------------------------------------------- FILETIME

/**
 * Windows FILETIME: 100-nanosecond ticks since 1601-01-01 UTC.
 *
 * Done in BigInt because the tick count overflows a double's integer range
 * long before it overflows the epoch; converting via Number() first would
 * silently lose sub-second (and eventually second) precision.
 */
const FILETIME_EPOCH_DIFF_MS = 11644473600000n;

export function filetimeToDate(ticks: bigint): Date | null {
  if (ticks <= 0n) return null;
  const ms = ticks / 10000n - FILETIME_EPOCH_DIFF_MS;
  // Outside what a JS Date can represent (roughly +/-8.64e15 ms).
  if (ms > 8640000000000000n || ms < -8640000000000000n) return null;
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------- GUID

export function formatGuid(b: Uint8Array, off = 0): string {
  if (b.length - off < 16) return "";
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const d1 = u32(b, off).toString(16).padStart(8, "0");
  const d2 = u16(b, off + 4).toString(16).padStart(4, "0");
  const d3 = u16(b, off + 6).toString(16).padStart(4, "0");
  let d4 = "";
  for (let i = 8; i < 10; i++) d4 += hex(b[off + i]!);
  let d5 = "";
  for (let i = 10; i < 16; i++) d5 += hex(b[off + i]!);
  return `${d1}-${d2}-${d3}-${d4}-${d5}`.toUpperCase();
}

// ---------------------------------------------------------------- codepages

/**
 * Maps a Windows codepage number to a label TextDecoder understands.
 *
 * TextDecoder ships every encoding in the WHATWG index, which covers all the
 * legacy codepages Outlook actually emits, so no lookup tables of our own.
 */
export function codepageLabel(cp: number | undefined): string {
  switch (cp) {
    case undefined:
    case 0:
      return "windows-1252";
    case 65001:
      return "utf-8";
    case 1200:
      return "utf-16le";
    case 20127:
      return "windows-1252"; // US-ASCII; 1252 is a superset
    case 28591:
      return "iso-8859-1";
    case 28592:
      return "iso-8859-2";
    case 28593:
      return "iso-8859-3";
    case 28594:
      return "iso-8859-4";
    case 28595:
      return "iso-8859-5";
    case 28596:
      return "iso-8859-6";
    case 28597:
      return "iso-8859-7";
    case 28598:
      return "iso-8859-8";
    case 28599:
      return "windows-1254";
    case 28603:
      return "iso-8859-13";
    case 28605:
      return "iso-8859-15";
    case 866:
      return "ibm866";
    case 874:
      return "windows-874";
    case 932:
      return "shift_jis";
    case 936:
      return "gbk";
    case 949:
      return "euc-kr";
    case 950:
      return "big5";
    case 1250:
      return "windows-1250";
    case 1251:
      return "windows-1251";
    case 1252:
      return "windows-1252";
    case 1253:
      return "windows-1253";
    case 1254:
      return "windows-1254";
    case 1255:
      return "windows-1255";
    case 1256:
      return "windows-1256";
    case 1257:
      return "windows-1257";
    case 1258:
      return "windows-1258";
    case 20866:
      return "koi8-r";
    case 21866:
      return "koi8-u";
    case 50220:
    case 50221:
    case 50222:
      return "iso-2022-jp";
    case 51932:
      return "euc-jp";
    case 51949:
      return "euc-kr";
    case 52936:
    case 54936:
      return "gb18030";
    default:
      return "windows-1252";
  }
}

const decoders = new Map<string, TextDecoder>();

export function decodeText(bytes: Uint8Array, label: string): string {
  let dec = decoders.get(label);
  if (!dec) {
    try {
      dec = new TextDecoder(label);
    } catch {
      dec = new TextDecoder("windows-1252");
    }
    decoders.set(label, dec);
  }
  return dec.decode(bytes);
}

/** UTF-16LE, tolerating an odd trailing byte rather than throwing. */
export function decodeUtf16(bytes: Uint8Array): string {
  const usable = bytes.length & ~1;
  return decodeText(bytes.subarray(0, usable), "utf-16le");
}

/** Strips the trailing NUL some producers leave on string properties. */
function trimNul(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0) end--;
  return end === s.length ? s : s.slice(0, end);
}

// ---------------------------------------------------------------- decoding

/**
 * Decodes a value that lives in a byte buffer -- either an inline fixed-size
 * cell, or the bytes an HNID resolved to.
 */
export function decodeValue(type: number, bytes: Uint8Array, codepage: number | undefined): PropValue {
  if (isMultiValued(type)) return decodeMulti(type, bytes, codepage);

  switch (type) {
    case PT_UNSPECIFIED:
    case PT_NULL:
      return null;

    case PT_I2:
      return bytes.length >= 2 ? (u16(bytes, 0) << 16) >> 16 : 0;

    case PT_LONG:
    case PT_ERROR:
      return bytes.length >= 4 ? u32(bytes, 0) | 0 : 0;

    case PT_R4:
      return bytes.length >= 4 ? f32(bytes, 0) : 0;

    case PT_DOUBLE:
      return bytes.length >= 8 ? f64(bytes, 0) : 0;

    case PT_APPTIME: {
      // OLE automation date: days since 1899-12-30.
      if (bytes.length < 8) return null;
      const days = f64(bytes, 0);
      const ms = Math.round((days - 25569) * 86400000);
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    case PT_CURRENCY:
    case PT_I8:
      return bytes.length >= 8 ? i64(bytes, 0) : 0n;

    case PT_BOOLEAN:
      return bytes.length >= 1 && bytes[0] !== 0;

    case PT_SYSTIME:
      return bytes.length >= 8 ? filetimeToDate(u64(bytes, 0)) : null;

    case PT_CLSID:
      return formatGuid(bytes, 0);

    case PT_UNICODE:
      return trimNul(decodeUtf16(bytes));

    case PT_STRING8:
      return trimNul(decodeText(bytes, codepageLabel(codepage)));

    case PT_BINARY:
    case PT_SVREID:
    case PT_SRESTRICT:
    case PT_ACTIONS:
      return bytes;

    default:
      // Unknown type: hand back the raw bytes rather than guessing.
      return bytes;
  }
}

/**
 * Multi-valued blob layout (MS-PST 2.3.3.4).
 *
 * Fixed-width element types are a bare packed array. Variable-width element
 * types carry a count and an offset table; element i runs from offsets[i] to
 * offsets[i+1], with the last element ending at the blob's end.
 */
function decodeMulti(type: number, bytes: Uint8Array, codepage: number | undefined): PropValue[] {
  const base = type & ~MV_FLAG;
  const elemSize = fixedSize(base) ?? (base === PT_CLSID ? 16 : null);

  if (elemSize !== null) {
    const out: PropValue[] = [];
    const n = Math.floor(bytes.length / elemSize);
    for (let i = 0; i < n; i++) {
      out.push(decodeValue(base, bytes.subarray(i * elemSize, (i + 1) * elemSize), codepage));
    }
    return out;
  }

  if (bytes.length < 4) return [];
  const count = u32(bytes, 0);
  // Each entry needs a 4-byte offset; reject counts the blob cannot back.
  if (count > (bytes.length - 4) / 4) return [];

  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(u32(bytes, 4 + i * 4));

  const out: PropValue[] = [];
  for (let i = 0; i < count; i++) {
    const start = offsets[i]!;
    const end = i + 1 < count ? offsets[i + 1]! : bytes.length;
    if (start > bytes.length || end > bytes.length || end < start) continue;
    out.push(decodeValue(base, bytes.subarray(start, end), codepage));
  }
  return out;
}

/** Decodes a PC's inline 4-byte value. */
export function decodeInline(type: number, dw: number): PropValue {
  switch (type) {
    case PT_I2:
      return ((dw & 0xffff) << 16) >> 16;
    case PT_BOOLEAN:
      return (dw & 0xff) !== 0;
    case PT_LONG:
    case PT_ERROR:
      return dw | 0;
    case PT_R4: {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, dw >>> 0, true);
      return f32(b, 0);
    }
    default:
      return dw | 0;
  }
}

/** Reads the 8-byte heap item a PtypObject HID points at. */
export function decodeObjectRef(bytes: Uint8Array): ObjectRef | null {
  if (bytes.length < 8) return null;
  return { nid: u32(bytes, 0), size: u32(bytes, 4) };
}

// ---------------------------------------------------------------- HNID

/** An HNID is a heap ID when its low 5 bits (the NID type nibble) are zero. */
export function hnidIsHid(hnid: number): boolean {
  return (hnid & 0x1f) === 0;
}

// ---------------------------------------------------------------- tags

export const PidTagMessageClass = 0x001a;
export const PidTagSubject = 0x0037;
export const PidTagClientSubmitTime = 0x0039;
export const PidTagSentRepresentingName = 0x0042;
export const PidTagSentRepresentingAddressType = 0x0064;
export const PidTagSentRepresentingEmailAddress = 0x0065;
export const PidTagConversationTopic = 0x0070;
export const PidTagTransportMessageHeaders = 0x007d;

export const PidTagSenderName = 0x0c1a;
export const PidTagSenderAddressType = 0x0c1e;
export const PidTagSenderEmailAddress = 0x0c1f;

export const PidTagDisplayBcc = 0x0e02;
export const PidTagDisplayCc = 0x0e03;
export const PidTagDisplayTo = 0x0e04;
export const PidTagMessageDeliveryTime = 0x0e06;
export const PidTagMessageFlags = 0x0e07;
export const PidTagMessageSize = 0x0e08;
export const PidTagHasAttachments = 0x0e1b;
export const PidTagAttachSize = 0x0e20;

export const PidTagBody = 0x1000;
export const PidTagRtfCompressed = 0x1009;
export const PidTagHtml = 0x1013;
export const PidTagInternetMessageId = 0x1035;
export const PidTagInternetReferences = 0x1039;
export const PidTagInReplyToId = 0x1042;
export const PidTagFlagStatus = 0x1090;

export const PidTagDisplayName = 0x3001;
export const PidTagAddressType = 0x3002;
export const PidTagEmailAddress = 0x3003;

export const PidTagAttachDataBinary = 0x3701; // PtypBinary, or PtypObject when embedded
export const PidTagAttachFilename = 0x3704;
export const PidTagAttachMethod = 0x3705;
export const PidTagAttachLongFilename = 0x3707;
export const PidTagAttachMimeTag = 0x370e;
export const PidTagAttachContentId = 0x3712;
export const PidTagAttachFlags = 0x3714;

export const PidTagInternetCodepage = 0x3fde;
export const PidTagMessageCodepage = 0x3ffd;

export const PidTagSmtpAddress = 0x39fe; // aka PidTagPrimarySmtpAddress
export const PidTagSenderSmtpAddress = 0x5d01;
export const PidTagSentRepresentingSmtpAddress = 0x5d02;

export const PidTagRecipientType = 0x0c15;
export const PidTagRecipientDisplayName = 0x5ff6;

export const PidTagAttachmentHidden = 0x7ffe;

export const PidTagLtpRowId = 0x67f2;

// Name-to-ID map properties (on NID_NAME_TO_ID_MAP).
export const PidTagNameidStreamEntry = 0x0003;
export const PidTagNameidStreamString = 0x0004;
export const PidTagNameidStreamGuid = 0x0002;

/** MessageFlags bits we care about. */
export const MSGFLAG_READ = 0x0001;
export const MSGFLAG_UNSENT = 0x0008; // a draft
export const MSGFLAG_HASATTACH = 0x0010;

/** AttachMethod values. */
export const ATTACH_BY_VALUE = 1;
export const ATTACH_EMBEDDED_MESSAGE = 5;

/** AttachFlags bits. */
export const ATT_RENDERED_IN_BODY = 0x00000004;

/** Recipient types. */
export const RECIP_TO = 1;
export const RECIP_CC = 2;
export const RECIP_BCC = 3;

/** Reads an unsigned LE integer of arbitrary width as a BigInt (BTH keys). */
export function readKey(bytes: Uint8Array, off: number, len: number): bigint {
  return uint(bytes, off, len);
}
