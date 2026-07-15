/**
 * TNEF ("Transport Neutral Encapsulation Format") reader -- the `winmail.dat`
 * problem.
 *
 * When Outlook sends rich mail to a client it does not consider Outlook, it
 * moves everything it cannot express in MIME -- the RTF body, the real
 * attachments, a pile of MAPI properties -- into a single opaque attachment
 * called `winmail.dat`. The recipient sees a message with no formatting, no
 * attachments, and one useless binary blob. Expanding that blob back into
 * ordinary attachments and an ordinary body is the whole point of this module.
 *
 * The file itself is deliberately simple: a signature, a key, and then a flat
 * run of length-prefixed, checksummed attributes. The complexity is entirely in
 * two of those attributes (`attMsgProps` and `attAttachment`), which carry a
 * MAPI property stream -- the same property model the .msg parser already
 * understands, in a different serialisation. So the property *types* are decoded
 * with msg.ts's decoder, the RTF body is decompressed with lzfu.ts and
 * de-encapsulated with rtf.ts, and nothing about MAPI, LZFu or RTF is
 * reimplemented here. What is new is only the container.
 *
 * Everything is best-effort. Real winmail.dat files in the wild have wrong
 * checksums, truncated attributes and property streams that run off the end;
 * none of that is a reason to hand the user back nothing, so failures become
 * warnings and the parse continues to the next attribute.
 */

import type {
  Address,
  Attachment,
  Message,
  ParsedArchive,
  ProgressFn,
} from "../model";
import { singleMessageArchive } from "./archive";
import { codepageToLabel, decodeBytes } from "./codepage";
import { decompressLzfu } from "./lzfu";
import {
  PID,
  PT,
  baseType,
  decodeGuid,
  decodeScalar,
  formatTag,
  guessMimeType,
  isMultiValued,
  type PropValue,
} from "./msg";
import { deencapsulateRtf } from "./rtf";

// ---------------------------------------------------------------------------
// Container constants
// ---------------------------------------------------------------------------

/** uint32 LE at offset 0. The one thing about TNEF that is never in doubt. */
export const TNEF_SIGNATURE = 0x223e9f78;

const LVL_MESSAGE = 1;
const LVL_ATTACHMENT = 2;

/**
 * Attribute ids. A TNEF attribute's uint32 packs the data type in the high 16
 * bits and the id in the low 16; only the id identifies the attribute, and the
 * declared "data type" is advisory (writers disagree about it), so we key off
 * the id alone and interpret the payload ourselves.
 */
const ATT = {
  From: 0x8000,
  Subject: 0x8004,
  DateSent: 0x8005,
  DateRecd: 0x8006,
  MessageClass: 0x8008,
  MessageId: 0x8009,
  Body: 0x800c,
  AttachData: 0x800f,
  AttachTitle: 0x8010,
  AttachMetaFile: 0x8011,
  AttachCreateDate: 0x8012,
  AttachModifyDate: 0x8013,
  AttachTransportFilename: 0x9001,
  AttachRendData: 0x9002,
  MsgProps: 0x9003,
  RecipTable: 0x9004,
  Attachment: 0x9005,
  TnefVersion: 0x9006,
  OemCodepage: 0x9007,
} as const;

/** PidTagAttachFlags bit: the attachment is referenced from the HTML body. */
const ATT_MHTML_REF = 0x00000004;

const utf16le = new TextDecoder("utf-16le");

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** TNEF strings are NUL-terminated; the terminator is inside the length. */
function trimNuls(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0) end--;
  return s.slice(0, end);
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

export function isTnef(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return (
    bytes[0] === 0x78 && bytes[1] === 0x9f && bytes[2] === 0x3e && bytes[3] === 0x22
  );
}

// ---------------------------------------------------------------------------
// Attribute layer
// ---------------------------------------------------------------------------

export interface TnefAttribute {
  /** 1 = message level, 2 = attachment level. */
  level: number;
  /** Low 16 bits of the attribute word: what the attribute *is*. */
  id: number;
  /** High 16 bits: the writer's claim about how to read the payload. */
  dataType: number;
  data: Uint8Array;
  /** False when the stored checksum disagreed with the data. */
  checksumOk: boolean;
}

/** The checksum TNEF stores after every attribute: bytes summed mod 2^16. */
export function tnefChecksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  return sum & 0xffff;
}

/**
 * Walk the flat attribute list.
 *
 * A bad checksum is recorded and ignored: plenty of real files have them, and
 * refusing to read a message because a 16-bit sum came out wrong would be
 * pedantry at the user's expense. A truncated attribute, on the other hand,
 * ends the walk -- once a length has run off the end of the buffer there is no
 * way to find where the next attribute would have started.
 */
export function readTnefAttributes(
  bytes: Uint8Array,
  warn: (msg: string) => void,
): TnefAttribute[] {
  if (!isTnef(bytes)) {
    throw new Error(
      "Not a TNEF file: expected the winmail.dat signature 0x223E9F78 at offset 0.",
    );
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: TnefAttribute[] = [];

  // 4 bytes signature, 2 bytes "key" (an attachment-correlation id we do not
  // need, but must step over).
  let off = 6;
  if (bytes.length < off) {
    warn("TNEF file ends before its 6-byte header is complete.");
    return out;
  }

  while (off < bytes.length) {
    if (off + 9 > bytes.length) {
      warn(
        `TNEF stream truncated: ${bytes.length - off} trailing byte(s) are too few for an attribute header.`,
      );
      break;
    }
    const level = bytes[off];
    const word = dv.getUint32(off + 1, true);
    const length = dv.getUint32(off + 5, true);
    const dataStart = off + 9;

    if (level !== LVL_MESSAGE && level !== LVL_ATTACHMENT) {
      warn(`TNEF attribute at offset ${off} has unknown level ${level}; stopping.`);
      break;
    }
    // 2 checksum bytes follow the data.
    if (length > bytes.length - dataStart - 2) {
      warn(
        `TNEF attribute 0x${(word & 0xffff).toString(16)} at offset ${off} claims ${length} bytes but only ${Math.max(
          0,
          bytes.length - dataStart,
        )} remain; stopping.`,
      );
      break;
    }

    const data = bytes.subarray(dataStart, dataStart + length);
    const stored = dv.getUint16(dataStart + length, true);
    const actual = tnefChecksum(data);
    const checksumOk = stored === actual;
    if (!checksumOk) {
      warn(
        `TNEF attribute 0x${(word & 0xffff).toString(16).padStart(4, "0")} has a bad checksum ` +
          `(stored ${stored}, computed ${actual}); reading it anyway.`,
      );
    }

    out.push({
      level,
      id: word & 0xffff,
      dataType: (word >>> 16) & 0xffff,
      data,
      checksumOk,
    });

    off = dataStart + length + 2;
  }

  return out;
}

// ---------------------------------------------------------------------------
// The embedded MAPI property stream
// ---------------------------------------------------------------------------

export interface TnefProp {
  id: number;
  type: number;
  value: PropValue;
  /** Set for named properties (id >= 0x8000): the property set GUID. */
  guid?: string;
  /** Named property, numeric kind. */
  nameId?: number;
  /** Named property, string kind. */
  name?: string;
}

/**
 * Byte width of a fixed-size MAPI value as TNEF writes it. Variable-length
 * types return null: their values carry their own uint32 length.
 */
function fixedValueSize(type: number): number | null {
  switch (baseType(type)) {
    case PT.INT16:
    case PT.BOOLEAN:
      return 2;
    case PT.INT32:
    case PT.FLOAT32:
    case PT.ERROR:
      return 4;
    case PT.FLOAT64:
    case PT.CURRENCY:
    case PT.FLOATING_TIME:
    case PT.INT64:
    case PT.TIME:
      return 8;
    case PT.GUID:
      return 16;
    default:
      // STRING, STRING8, BINARY, OBJECT and anything we do not know.
      return null;
  }
}

/** Every value in the stream is padded out to a 4-byte boundary. */
function padding(len: number): number {
  return (4 - (len % 4)) % 4;
}

function decodeOne(type: number, bytes: Uint8Array, codepage: number): PropValue {
  const v = decodeScalar(type, bytes, codepage);
  // TNEF stores the NUL terminator inside the length; MAPI property values in
  // a .msg do not. Strip it, or every subject ends in an invisible U+0000.
  if (typeof v === "string") {
    const bt = baseType(type);
    if (bt === PT.STRING || bt === PT.STRING8) return trimNuls(v);
  }
  return v;
}

/**
 * Decode `attMsgProps` / `attAttachment`: a uint32 property count followed by
 * that many properties.
 *
 * Each property is a uint32 tag (type in the low 16 bits, id in the high 16).
 * A property whose id is >= 0x8000 is a *named* property and carries a 16-byte
 * GUID plus a kind discriminator before its value; skipping that preamble
 * wrongly does not corrupt one property, it desynchronises the whole rest of
 * the stream, which is why it is handled here rather than being waved past.
 *
 * Variable-length values (and all multi-valued ones) are preceded by a uint32
 * value count, each value by its own uint32 length, and every value is padded
 * to a 4-byte boundary.
 */
export function decodeMapiProps(
  bytes: Uint8Array,
  codepage: number,
  warn: (msg: string) => void,
): TnefProp[] {
  const props: TnefProp[] = [];
  if (bytes.length < 4) {
    if (bytes.length > 0) warn("MAPI property stream is too short to hold a property count.");
    return props;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(0, true);
  let off = 4;

  const short = (what: string, i: number): void => {
    warn(`MAPI property stream ends mid-${what} at property ${i + 1} of ${count}.`);
  };

  for (let i = 0; i < count; i++) {
    if (off + 4 > bytes.length) {
      short("tag", i);
      break;
    }
    const tag = dv.getUint32(off, true);
    off += 4;
    const type = tag & 0xffff;
    const id = (tag >>> 16) & 0xffff;
    const prop: TnefProp = { id, type, value: null };

    if (id >= 0x8000) {
      if (off + 20 > bytes.length) {
        short("named-property header", i);
        break;
      }
      prop.guid = decodeGuid(bytes.subarray(off, off + 16));
      off += 16;
      const kind = dv.getUint32(off, true);
      off += 4;
      if (kind === 0) {
        if (off + 4 > bytes.length) {
          short("named-property id", i);
          break;
        }
        prop.nameId = dv.getUint32(off, true);
        off += 4;
      } else if (kind === 1) {
        if (off + 4 > bytes.length) {
          short("named-property name length", i);
          break;
        }
        const nameLen = dv.getUint32(off, true);
        off += 4;
        if (nameLen > bytes.length - off) {
          short("named-property name", i);
          break;
        }
        prop.name = trimNuls(utf16le.decode(bytes.subarray(off, off + (nameLen & ~1))));
        off += nameLen + padding(nameLen);
      } else {
        // We no longer know how long the preamble is, so we no longer know
        // where anything after this point begins.
        warn(
          `MAPI named property 0x${formatTag(id, type)} has unknown kind ${kind}; abandoning the rest of the stream.`,
        );
        break;
      }
    }

    const fixed = fixedValueSize(type);
    const variable = fixed === null;
    const mv = isMultiValued(type);

    let nValues = 1;
    if (mv || variable) {
      if (off + 4 > bytes.length) {
        short("value count", i);
        break;
      }
      nValues = dv.getUint32(off, true);
      off += 4;
    }

    const values: PropValue[] = [];
    let truncated = false;
    for (let j = 0; j < nValues; j++) {
      let len: number;
      if (variable) {
        if (off + 4 > bytes.length) {
          short("value length", i);
          truncated = true;
          break;
        }
        len = dv.getUint32(off, true);
        off += 4;
      } else {
        len = fixed as number;
      }
      if (len > bytes.length - off) {
        short("value", i);
        truncated = true;
        break;
      }
      values.push(decodeOne(type, bytes.subarray(off, off + len), codepage));
      off += len + padding(len);
    }

    prop.value = mv ? (values as PropValue) : (values.length > 0 ? values[0] : null);
    props.push(prop);
    if (truncated) break;
  }

  return props;
}

/**
 * Index properties by id. A tag can appear twice as a Unicode and an ANSI
 * variant of the same property; Unicode wins, otherwise first writer wins.
 */
export function propsById(props: TnefProp[]): Map<number, TnefProp> {
  const map = new Map<number, TnefProp>();
  for (const p of props) {
    const existing = map.get(p.id);
    if (existing) {
      if (existing.type === PT.STRING && p.type === PT.STRING8) continue;
      if (existing.type !== PT.STRING8 || p.type !== PT.STRING) continue;
    }
    map.set(p.id, p);
  }
  return map;
}

function propString(
  map: Map<number, TnefProp>,
  id: number,
  codepage: number,
): string | undefined {
  const p = map.get(id);
  if (!p) return undefined;
  let s: string | undefined;
  if (typeof p.value === "string") s = p.value;
  else if (p.value instanceof Uint8Array) s = decodeBytes(p.value, codepageToLabel(codepage));
  if (s === undefined) return undefined;
  s = trimNuls(s);
  return s.trim() === "" ? undefined : s;
}

function propBinary(map: Map<number, TnefProp>, id: number): Uint8Array | undefined {
  const p = map.get(id);
  return p && p.value instanceof Uint8Array ? p.value : undefined;
}

function propInt(map: Map<number, TnefProp>, id: number): number | undefined {
  const p = map.get(id);
  if (!p) return undefined;
  if (typeof p.value === "number") return p.value;
  if (typeof p.value === "bigint") return Number(p.value);
  if (typeof p.value === "boolean") return p.value ? 1 : 0;
  return undefined;
}

function propDate(map: Map<number, TnefProp>, id: number): Date | undefined {
  const p = map.get(id);
  return p && p.value instanceof Date ? p.value : undefined;
}

// ---------------------------------------------------------------------------
// Attribute payload helpers
// ---------------------------------------------------------------------------

/** attDateSent and friends: seven uint16s, not a FILETIME. */
function readDtr(data: Uint8Array): Date | null {
  if (data.length < 14) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const year = dv.getUint16(0, true);
  const month = dv.getUint16(2, true);
  const day = dv.getUint16(4, true);
  const hour = dv.getUint16(6, true);
  const minute = dv.getUint16(8, true);
  const second = dv.getUint16(10, true);
  if (year < 1601 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

function attrString(data: Uint8Array, codepage: number): string {
  return trimNuls(decodeBytes(data, codepageToLabel(codepage))).trim();
}

/**
 * attFrom is a "triple": an 8-byte header, then a NUL-terminated display name,
 * then a NUL-terminated address. Writers disagree about the header fields, so
 * we step over it and take the two strings, which is the only part anyone
 * actually uses.
 */
function readTriple(data: Uint8Array, codepage: number): Address | undefined {
  if (data.length <= 8) return undefined;
  const rest = data.subarray(8);
  const label = codepageToLabel(codepage);
  const nul = rest.indexOf(0);
  const name = trimNuls(decodeBytes(nul === -1 ? rest : rest.subarray(0, nul), label)).trim();
  let email = "";
  if (nul !== -1) {
    const after = rest.subarray(nul + 1);
    const end = after.indexOf(0);
    email = trimNuls(decodeBytes(end === -1 ? after : after.subarray(0, end), label)).trim();
  }
  if (!name && !email) return undefined;
  if (!email) return { name, email: "" };
  return name && name !== email ? { name, email } : { email };
}

/** SMTP address, or an Exchange DN if that is genuinely all there is. */
function resolveSender(map: Map<number, TnefProp>, codepage: number): Address | undefined {
  const name =
    propString(map, PID.SentRepresentingName, codepage) ??
    propString(map, PID.SenderName, codepage);
  const smtp =
    propString(map, PID.SentRepresentingSmtpAddress, codepage) ??
    propString(map, PID.SenderSmtpAddress, codepage) ??
    propString(map, PID.SmtpAddress, codepage);
  const raw =
    propString(map, PID.SentRepresentingEmailAddress, codepage) ??
    propString(map, PID.SenderEmailAddress, codepage);

  // An Exchange DN ("/O=CONTOSO/...") is not an address you can mail, so an
  // SMTP mirror property beats it; with neither, the DN at least names someone.
  const email = smtp ?? raw;
  if (!email && !name) return undefined;
  if (!email) return { name, email: "" };
  return name && name !== email ? { name, email } : { email };
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

interface AttachmentWip {
  title?: string;
  transportName?: string;
  data?: Uint8Array;
  metafile?: Uint8Array;
  props: Map<number, TnefProp>;
}

export interface TnefContent {
  messageClass?: string;
  subject?: string;
  dateSent: Date | null;
  dateReceived: Date | null;
  messageId?: string;
  from?: Address;
  html?: string;
  text?: string;
  attachments: Attachment[];
  /** The message-level MAPI properties, for callers that want more than this. */
  props: Map<number, TnefProp>;
  codepage: number;
  warnings: string[];
}

/**
 * Read a TNEF stream into its parts. The two public entry points are both thin
 * wrappers over this.
 */
export function readTnef(bytes: Uint8Array): TnefContent {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  const attrs = readTnefAttributes(bytes, warn); // throws on a bad signature

  // The codepage governs how every 8-bit string in the file is decoded, and it
  // arrives as an attribute of its own -- which may come *after* the strings it
  // governs. So settle it before decoding anything.
  let codepage = 0;
  for (const a of attrs) {
    if (a.level === LVL_MESSAGE && a.id === ATT.OemCodepage && a.data.length >= 4) {
      const dv = new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength);
      const cp = dv.getUint32(0, true);
      if (cp > 0) codepage = cp;
    }
  }

  const content: TnefContent = {
    dateSent: null,
    dateReceived: null,
    attachments: [],
    props: new Map(),
    codepage,
    warnings,
  };

  const wips: AttachmentWip[] = [];
  let current: AttachmentWip | null = null;
  const newAttachment = (): AttachmentWip => {
    const wip: AttachmentWip = { props: new Map() };
    wips.push(wip);
    current = wip;
    return wip;
  };
  // Some writers omit attAttachRendData; the first attachment-level payload we
  // see then has to open an attachment itself, or its data would be dropped.
  const attachmentFor = (): AttachmentWip => current ?? newAttachment();

  let rtfBytes: Uint8Array | undefined;
  let bodyText: string | undefined;

  for (const a of attrs) {
    try {
      if (a.level === LVL_MESSAGE) {
        switch (a.id) {
          case ATT.MessageClass:
            content.messageClass = attrString(a.data, codepage);
            break;
          case ATT.Subject:
            content.subject = attrString(a.data, codepage);
            break;
          case ATT.MessageId:
            content.messageId = attrString(a.data, codepage) || undefined;
            break;
          case ATT.Body:
            bodyText = trimNuls(decodeBytes(a.data, codepageToLabel(codepage)));
            break;
          case ATT.DateSent:
            content.dateSent = readDtr(a.data);
            break;
          case ATT.DateRecd:
            content.dateReceived = readDtr(a.data);
            break;
          case ATT.From:
            content.from = readTriple(a.data, codepage);
            break;
          case ATT.MsgProps: {
            let props = decodeMapiProps(a.data, codepage, warn);
            let map = propsById(props);
            // The message's own codepage property, if it has one, is better
            // than the container's. Re-decode rather than leave ANSI strings
            // decoded against the wrong table.
            const cp = propInt(map, PID.InternetCodepage) ?? propInt(map, PID.MessageCodepage);
            if (cp && cp > 0 && cp !== codepage) {
              codepage = cp;
              content.codepage = cp;
              props = decodeMapiProps(a.data, codepage, () => {});
              map = propsById(props);
            }
            content.props = map;
            break;
          }
          default:
            break; // attTnefVersion, attRecipTable, attPriority, ... : not needed
        }
        continue;
      }

      // --- attachment level ---
      switch (a.id) {
        case ATT.AttachRendData:
          newAttachment();
          break;
        case ATT.AttachTitle:
          attachmentFor().title = attrString(a.data, codepage) || undefined;
          break;
        case ATT.AttachTransportFilename:
          attachmentFor().transportName = attrString(a.data, codepage) || undefined;
          break;
        case ATT.AttachData:
          attachmentFor().data = a.data;
          break;
        case ATT.AttachMetaFile:
          attachmentFor().metafile = a.data;
          break;
        case ATT.Attachment: {
          const wip = attachmentFor();
          const props = decodeMapiProps(a.data, codepage, warn);
          wip.props = propsById(props);
          break;
        }
        default:
          break; // attAttachCreateDate / ModifyDate: no home in the model
      }
    } catch (e) {
      warn(
        `TNEF attribute 0x${a.id.toString(16).padStart(4, "0")} could not be read: ${errMsg(e)}`,
      );
    }
  }

  // --- bodies ---
  const props = content.props;
  const htmlProp = props.get(PID.BodyHtml);
  if (htmlProp) {
    if (typeof htmlProp.value === "string") content.html = htmlProp.value;
    else if (htmlProp.value instanceof Uint8Array) {
      content.html = decodeBytes(htmlProp.value, codepageToLabel(codepage));
    }
  }
  content.text = bodyText || propString(props, PID.Body, codepage);

  rtfBytes = propBinary(props, PID.RtfCompressed);
  if (rtfBytes && rtfBytes.length > 0) {
    try {
      const result = deencapsulateRtf(decompressLzfu(rtfBytes), codepage);
      if (!content.html && result.html) content.html = result.html;
      if (!content.text && result.text) content.text = result.text;
    } catch (e) {
      warn(`TNEF compressed RTF body could not be decoded: ${errMsg(e)}`);
    }
  }

  if (!content.subject) content.subject = propString(props, PID.Subject, codepage);
  if (!content.messageClass) content.messageClass = propString(props, PID.MessageClass, codepage);
  if (!content.messageId) content.messageId = propString(props, PID.InternetMessageId, codepage);
  if (!content.dateSent) {
    content.dateSent = propDate(props, PID.ClientSubmitTime) ?? null;
  }
  if (!content.dateReceived) {
    content.dateReceived = propDate(props, PID.MessageDeliveryTime) ?? null;
  }
  const sender = resolveSender(props, codepage);
  if (sender) content.from = content.from ?? sender;

  // --- attachments ---
  content.attachments = wips
    .map((wip, i) => finishAttachment(wip, i, codepage, warn))
    .filter((a): a is Attachment => a !== null);

  return content;
}

function finishAttachment(
  wip: AttachmentWip,
  index: number,
  codepage: number,
  warn: (msg: string) => void,
): Attachment | null {
  const p = wip.props;

  // attAttachTitle is whatever survived an 8.3 mangling ("REPOR~1.PDF"); the
  // MAPI long filename is the one the sender actually typed.
  const filename =
    propString(p, PID.AttachLongFilename, codepage) ??
    propString(p, PID.AttachFilename, codepage) ??
    wip.transportName ??
    wip.title ??
    propString(p, PID.DisplayName, codepage) ??
    `attachment-${index + 1}`;

  const content = wip.data ?? propBinary(p, PID.AttachDataBinary);
  if (!content) {
    // A metafile-only entry is a rendering hint (an icon), not a file anyone
    // asked for; dropping it is right, but say so.
    warn(`TNEF attachment "${filename}" carries no data; skipped.`);
    return null;
  }

  const contentId = propString(p, PID.AttachContentId, codepage);
  const flags = propInt(p, PID.AttachFlags) ?? 0;
  const mimeType = propString(p, PID.AttachMimeTag, codepage) ?? guessMimeType(filename);

  return {
    id: `tnef-att-${index}`,
    filename,
    mimeType,
    size: content.length,
    contentId,
    inline: !!contentId || (flags & ATT_MHTML_REF) !== 0,
    content,
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * The low-level entry point, and the one that matters: a winmail.dat is almost
 * never a file someone opens, it is a part hanging off an ordinary message.
 * The EML parser calls this to expand it in place.
 *
 * Throws only when the bytes are not TNEF at all. Everything else is a warning.
 */
export function extractTnefAttachments(bytes: Uint8Array): {
  attachments: Attachment[];
  html?: string;
  text?: string;
  warnings: string[];
} {
  const content = readTnef(bytes);
  return {
    attachments: content.attachments,
    html: content.html,
    text: content.text,
    warnings: content.warnings,
  };
}

/** Parse a standalone winmail.dat as a one-message archive. */
export async function parseTnef(
  bytes: Uint8Array,
  name: string,
  onProgress?: ProgressFn,
): Promise<ParsedArchive> {
  onProgress?.({ phase: "Reading TNEF", fraction: 0, messagesFound: 0 });

  const content = readTnef(bytes); // throws when the signature is wrong

  onProgress?.({ phase: "Reading properties", fraction: 0.6, messagesFound: 1 });

  const props = content.props;
  const codepage = content.codepage;

  const message: Message = {
    id: "msg-0",
    format: "tnef",
    subject: content.subject ?? "",
    from: content.from,
    replyTo: [],
    to: [],
    cc: [],
    bcc: [],
    date: content.dateSent ?? content.dateReceived ?? null,
    messageId: content.messageId,
    references: [],
    html: content.html,
    text: content.text,
    attachments: content.attachments,
    headers: [],
    raw: bytes,
    folderPath: [name],
    flags: { hasAttachments: content.attachments.some((a) => !a.inline) },
  };

  // A winmail.dat carries no RFC 822 header block, so the closest thing to
  // "headers" is the handful of transport properties it does have. Surfacing
  // the message class matters: it is how you tell a meeting request from mail.
  const displayTo = propString(props, PID.DisplayTo, codepage);
  const displayCc = propString(props, PID.DisplayCc, codepage);
  if (content.messageClass) {
    message.headers.push({ key: "X-TNEF-Message-Class", value: content.messageClass });
  }
  if (displayTo) message.headers.push({ key: "To", value: displayTo });
  if (displayCc) message.headers.push({ key: "Cc", value: displayCc });

  onProgress?.({ phase: "Done", fraction: 1, messagesFound: 1 });

  return singleMessageArchive(message, name, "tnef", content.warnings);
}
