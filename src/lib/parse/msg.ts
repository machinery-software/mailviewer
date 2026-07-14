/**
 * MAPI .msg parser, layered on the CFB reader.
 *
 * Outlook does not serialise a message; it serialises a MAPI property store
 * into a compound file. Each variable-length property gets its own stream
 * named `__substg1.0_<TAG>`, the fixed-size ones are packed into
 * `__properties_version1.0`, and recipients and attachments are sub-storages
 * with property stores of their own. There is no RFC 822 anywhere -- the
 * closest thing is PidTagTransportMessageHeaders, and only when the message
 * actually arrived from the internet.
 *
 * Everything here is best-effort by design: a message with one unreadable
 * attachment is still a message worth showing. Failures land in
 * `ParsedArchive.warnings` and parsing continues.
 */

import type {
  Address,
  Attachment,
  Folder,
  Message,
  ParsedArchive,
  ProgressFn,
} from "../model.ts";
import { parseCfb, type CfbEntry, type CfbFile } from "./cfb.ts";
import { codepageToLabel, decodeBytes } from "./codepage.ts";
import { decompressLzfu } from "./lzfu.ts";
import { deencapsulateRtf } from "./rtf.ts";

export { codepageToLabel };

// ---------------------------------------------------------------------------
// Property types (MS-OXCDATA 2.11.1)
// ---------------------------------------------------------------------------

export const PT = {
  UNSPECIFIED: 0x0000,
  NULL: 0x0001,
  INT16: 0x0002,
  INT32: 0x0003,
  FLOAT32: 0x0004,
  FLOAT64: 0x0005,
  CURRENCY: 0x0006,
  FLOATING_TIME: 0x0007,
  ERROR: 0x000a,
  BOOLEAN: 0x000b,
  OBJECT: 0x000d,
  INT64: 0x0014,
  STRING8: 0x001e,
  STRING: 0x001f,
  TIME: 0x0040,
  GUID: 0x0048,
  BINARY: 0x0102,
  MV_FLAG: 0x1000,
} as const;

/** Property ids we actually reach for. Names follow the MS-OXPROPS spelling. */
export const PID = {
  MessageClass: 0x001a,
  SentRepresentingName: 0x0042,
  SentRepresentingAddressType: 0x0064,
  SentRepresentingEmailAddress: 0x0065,
  Subject: 0x0037,
  ClientSubmitTime: 0x0039,
  ReplyRecipientNames: 0x0050,
  TransportMessageHeaders: 0x007d,
  SenderName: 0x0c1a,
  SenderAddressType: 0x0c1e,
  SenderEmailAddress: 0x0c1f,
  RecipientType: 0x0c15,
  DisplayName: 0x3001,
  EmailAddress: 0x3003,
  AddressType: 0x3002,
  MessageDeliveryTime: 0x0e06,
  MessageFlags: 0x0e07,
  HasAttachments: 0x0e1b,
  Body: 0x1000,
  RtfCompressed: 0x1009,
  BodyHtml: 0x1013,
  InternetMessageId: 0x1035,
  InternetReferences: 0x1039,
  InReplyToId: 0x1042,
  FlagStatus: 0x1090,
  AttachDataBinary: 0x3701,
  AttachDataObject: 0x3701,
  AttachFilename: 0x3704,
  AttachMethod: 0x3705,
  AttachLongFilename: 0x3707,
  AttachMimeTag: 0x370e,
  AttachContentId: 0x3712,
  AttachFlags: 0x3714,
  AttachSize: 0x0e20,
  DisplayTo: 0x0e04,
  DisplayCc: 0x0e03,
  DisplayBcc: 0x0e02,
  InternetCodepage: 0x3fde,
  MessageCodepage: 0x3ffd,
  SmtpAddress: 0x39fe,
  SenderSmtpAddress: 0x5d01,
  SentRepresentingSmtpAddress: 0x5d02,
  AttachmentHidden: 0x7ffe,
} as const;

/** PidTagAttachMethod == 5: the attachment "data" is an embedded message. */
const ATTACH_METHOD_EMBEDDED = 5;
/** PidTagAttachFlags bit: the attachment is referenced by the HTML body. */
const ATT_MHTML_REF = 0x00000004;

/** PidTagMessageFlags bits. */
const MSGFLAG_READ = 0x0001;
const MSGFLAG_UNSENT = 0x0008;

const SUBSTG_PREFIX = "__substg1.0_";
const PROPERTIES_STREAM = "__properties_version1.0";
const RECIP_PREFIX = "__recip_version1.0_#";
const ATTACH_PREFIX = "__attach_version1.0_#";

/**
 * Header sizes for `__properties_version1.0`, which differ by what the storage
 * describes (MS-OXMSG 2.4.1). Getting this wrong shifts every fixed property
 * by a few bytes and produces plausible-looking garbage, so it is worth being
 * explicit about.
 */
const PROPS_HEADER_TOPLEVEL = 32;
const PROPS_HEADER_EMBEDDED = 24;
const PROPS_HEADER_SUB = 8;

const utf16le = new TextDecoder("utf-16le");

// ---------------------------------------------------------------------------
// FILETIME
// ---------------------------------------------------------------------------

/** 100ns ticks between 1601-01-01 and 1970-01-01. */
const FILETIME_EPOCH_DIFF_MS = 11644473600000n;

/**
 * Convert a Windows FILETIME (100-nanosecond ticks since 1601-01-01 UTC) to a
 * Date. Returns null for zero (MAPI's "unset") and for values that fall
 * outside the range a Date can hold, which is how corrupt properties usually
 * present themselves.
 */
export function filetimeToDate(ticks: bigint): Date | null {
  if (ticks <= 0n) return null;
  const ms = ticks / 10000n - FILETIME_EPOCH_DIFF_MS;
  // Date's representable range is +/- 8.64e15 ms around the epoch.
  if (ms < -8640000000000000n || ms > 8640000000000000n) return null;
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function readFiletime(bytes: Uint8Array, offset = 0): Date | null {
  if (bytes.length < offset + 8) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return filetimeToDate(dv.getBigUint64(offset, true));
}

// ---------------------------------------------------------------------------
// Property tag helpers
// ---------------------------------------------------------------------------

export interface PropTag {
  id: number;
  type: number;
  /** Present only on an element of a multi-valued property, e.g. `-00000001`. */
  index?: number;
}

/**
 * Parse a `__substg1.0_0037001F` stream name into its tag, or a multi-valued
 * element name like `__substg1.0_1013101F-00000002`.
 *
 * Returns null for names that are not property streams at all.
 */
export function parseSubstgName(name: string): PropTag | null {
  if (!name.startsWith(SUBSTG_PREFIX)) return null;
  const rest = name.slice(SUBSTG_PREFIX.length);
  if (rest.length < 8) return null;

  const tagHex = rest.slice(0, 8);
  if (!/^[0-9A-Fa-f]{8}$/.test(tagHex)) return null;
  const id = parseInt(tagHex.slice(0, 4), 16);
  const type = parseInt(tagHex.slice(4, 8), 16);

  const suffix = rest.slice(8);
  if (suffix === "") return { id, type };
  const m = /^-([0-9A-Fa-f]{8})$/.exec(suffix);
  if (!m) return null;
  return { id, type, index: parseInt(m[1], 16) };
}

/** Format a tag the way Outlook names its streams. Inverse of the above. */
export function formatTag(id: number, type: number): string {
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
  return `${hex(id)}${hex(type)}`;
}

export function isMultiValued(type: number): boolean {
  return (type & PT.MV_FLAG) !== 0;
}

export function baseType(type: number): number {
  return type & ~PT.MV_FLAG;
}

// ---------------------------------------------------------------------------
// Property values
// ---------------------------------------------------------------------------

export type PropValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Uint8Array
  | null
  | string[]
  | number[]
  | bigint[]
  | Date[]
  | Uint8Array[];

export interface Prop {
  id: number;
  type: number;
  value: PropValue;
}

/** A parsed property store: one MAPI object's worth of properties. */
export class PropertyBag {
  readonly props = new Map<number, Prop>();
  /** Sub-storages whose name did not look like a property (embedded messages). */
  readonly storage: CfbEntry;
  readonly codepage: number;

  constructor(storage: CfbEntry, codepage: number) {
    this.storage = storage;
    this.codepage = codepage;
  }

  get(id: number): Prop | undefined {
    return this.props.get(id);
  }

  has(id: number): boolean {
    return this.props.has(id);
  }

  set(p: Prop): void {
    // A tag can legitimately show up twice (a unicode and an ANSI variant of
    // the same property). Unicode wins; otherwise first writer wins.
    const existing = this.props.get(p.id);
    if (existing && existing.type === PT.STRING && p.type === PT.STRING8) return;
    this.props.set(p.id, p);
  }

  getString(id: number): string | undefined {
    const p = this.props.get(id);
    if (!p) return undefined;
    if (typeof p.value === "string") return p.value;
    if (p.value instanceof Uint8Array) {
      return decodeBytes(p.value, codepageToLabel(this.codepage));
    }
    return undefined;
  }

  /** A string property, but empty/whitespace-only reads as absent. */
  getNonEmptyString(id: number): string | undefined {
    const s = this.getString(id);
    return s && s.trim() !== "" ? s : undefined;
  }

  getBinary(id: number): Uint8Array | undefined {
    const p = this.props.get(id);
    return p && p.value instanceof Uint8Array ? p.value : undefined;
  }

  getInt(id: number): number | undefined {
    const p = this.props.get(id);
    if (!p) return undefined;
    if (typeof p.value === "number") return p.value;
    if (typeof p.value === "bigint") return Number(p.value);
    if (typeof p.value === "boolean") return p.value ? 1 : 0;
    return undefined;
  }

  getBool(id: number): boolean | undefined {
    const p = this.props.get(id);
    if (!p) return undefined;
    if (typeof p.value === "boolean") return p.value;
    if (typeof p.value === "number") return p.value !== 0;
    return undefined;
  }

  getDate(id: number): Date | null | undefined {
    const p = this.props.get(id);
    if (!p) return undefined;
    if (p.value instanceof Date) return p.value;
    return undefined;
  }
}

/** Decode a GUID (PtypGuid) into the usual braced, mixed-endian rendering. */
export function decodeGuid(b: Uint8Array): string {
  if (b.length < 16) return "";
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const d1 = dv.getUint32(0, true).toString(16).padStart(8, "0");
  const d2 = dv.getUint16(4, true).toString(16).padStart(4, "0");
  const d3 = dv.getUint16(6, true).toString(16).padStart(4, "0");
  const d4 = [hex(b[8]), hex(b[9])].join("");
  const d5 = Array.from(b.subarray(10, 16), hex).join("");
  return `{${d1}-${d2}-${d3}-${d4}-${d5}}`.toUpperCase();
}

/**
 * Turn the bytes of a `__substg1.0_*` stream into a value, given its type.
 * Multi-valued types are handled by the caller, which gathers the elements
 * first; this function only ever sees one element's worth of bytes.
 */
function decodeScalar(
  type: number,
  bytes: Uint8Array,
  codepage: number,
): PropValue {
  const dv = () => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (baseType(type)) {
    case PT.STRING:
      // UTF-16LE. An odd byte count means a truncated stream; drop the stray.
      return utf16le.decode(bytes.subarray(0, bytes.length & ~1));
    case PT.STRING8:
      return decodeBytes(bytes, codepageToLabel(codepage));
    case PT.BINARY:
      return bytes;
    case PT.INT16:
      return bytes.length >= 2 ? dv().getInt16(0, true) : 0;
    case PT.INT32:
    case PT.ERROR:
      return bytes.length >= 4 ? dv().getInt32(0, true) : 0;
    case PT.FLOAT32:
      return bytes.length >= 4 ? dv().getFloat32(0, true) : 0;
    case PT.FLOAT64:
    case PT.FLOATING_TIME:
      return bytes.length >= 8 ? dv().getFloat64(0, true) : 0;
    case PT.INT64:
    case PT.CURRENCY:
      return bytes.length >= 8 ? dv().getBigInt64(0, true) : 0n;
    case PT.BOOLEAN:
      return bytes.length >= 1 ? bytes[0] !== 0 : false;
    case PT.TIME:
      return readFiletime(bytes);
    case PT.GUID:
      return decodeGuid(bytes);
    default:
      // Unknown type: hand back the bytes rather than pretending we understood.
      return bytes;
  }
}

/** Fixed-size types are stored inline in `__properties_version1.0`. */
function isFixedSize(type: number): boolean {
  switch (type) {
    case PT.INT16:
    case PT.INT32:
    case PT.FLOAT32:
    case PT.FLOAT64:
    case PT.CURRENCY:
    case PT.FLOATING_TIME:
    case PT.ERROR:
    case PT.BOOLEAN:
    case PT.INT64:
    case PT.TIME:
      return true;
    default:
      return false;
  }
}

/**
 * Read `__properties_version1.0`: an 8/24/32-byte header followed by 16-byte
 * records of (tag, flags, value-or-length).
 */
function readPropertiesStream(
  bytes: Uint8Array,
  headerSize: number,
  onProp: (id: number, type: number, value: PropValue) => void,
): void {
  if (bytes.length <= headerSize) return;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let off = headerSize; off + 16 <= bytes.length; off += 16) {
    const tag = dv.getUint32(off, true);
    const type = tag & 0xffff;
    const id = (tag >>> 16) & 0xffff;
    if (id === 0) continue;
    if (!isFixedSize(type)) {
      // Variable-length: the 8 value bytes are just a length, and the payload
      // lives in a __substg stream we will read separately.
      continue;
    }
    const value = decodeScalar(type, bytes.subarray(off + 8, off + 16), 0);
    onProp(id, type, value);
  }
}

// ---------------------------------------------------------------------------
// Building a property bag from a CFB storage
// ---------------------------------------------------------------------------

interface BagOptions {
  headerSize: number;
  /** Codepage inherited from the parent message, for sub-objects. */
  codepage?: number;
  warn: (msg: string) => void;
}

function readPropertyBag(
  cfb: CfbFile,
  storage: CfbEntry,
  opts: BagOptions,
): PropertyBag {
  const { warn } = opts;

  // Pass 1: pull the raw bytes of every property stream, and group the
  // elements of multi-valued properties by tag. We cannot decode yet -- the
  // codepage that ANSI strings depend on is itself a property.
  const scalars = new Map<number, { tag: PropTag; bytes: Uint8Array }>();
  const multi = new Map<number, { tag: PropTag; elements: Uint8Array[] }>();

  for (const child of storage.children) {
    if (child.type !== "stream") continue;
    const tag = parseSubstgName(child.name);
    if (!tag) continue;
    let bytes: Uint8Array;
    try {
      bytes = cfb.readStream(child);
    } catch (e) {
      warn(`could not read property stream "${child.name}": ${errMsg(e)}`);
      continue;
    }
    if (tag.index !== undefined) {
      let slot = multi.get(tag.id);
      if (!slot) {
        slot = { tag, elements: [] };
        multi.set(tag.id, slot);
      }
      slot.elements[tag.index] = bytes;
    } else if (isMultiValued(tag.type)) {
      // The bare stream of a multi-valued property is the length/offset table.
      // For MV strings and binaries the elements are the `-NNNNNNNN` streams,
      // so the table tells us nothing we cannot get from the elements
      // themselves -- except for the packed numeric types, where the bare
      // stream *is* the data.
      const bt = baseType(tag.type);
      if (bt === PT.STRING || bt === PT.STRING8 || bt === PT.BINARY) {
        if (!multi.has(tag.id)) multi.set(tag.id, { tag, elements: [] });
      } else {
        scalars.set(tag.id, { tag, bytes });
      }
    } else {
      scalars.set(tag.id, { tag, bytes });
    }
  }

  // Pass 2: fixed-size properties, which also give us the codepage.
  const fixed: Array<{ id: number; type: number; value: PropValue }> = [];
  const propsEntry = storage.children.find(
    (c) => c.type === "stream" && c.name === PROPERTIES_STREAM,
  );
  if (propsEntry) {
    try {
      readPropertiesStream(cfb.readStream(propsEntry), opts.headerSize, (id, type, value) =>
        fixed.push({ id, type, value }),
      );
    } catch (e) {
      warn(`could not read ${PROPERTIES_STREAM}: ${errMsg(e)}`);
    }
  }

  let codepage = opts.codepage ?? 0;
  if (!codepage) {
    for (const f of fixed) {
      if (f.id === PID.InternetCodepage && typeof f.value === "number" && f.value > 0) {
        codepage = f.value;
      }
    }
    if (!codepage) {
      for (const f of fixed) {
        if (f.id === PID.MessageCodepage && typeof f.value === "number" && f.value > 0) {
          codepage = f.value;
        }
      }
    }
  }

  const bag = new PropertyBag(storage, codepage);
  for (const f of fixed) bag.set(f);

  // Pass 3: decode everything now that the codepage is settled.
  for (const { tag, bytes } of scalars.values()) {
    try {
      if (isMultiValued(tag.type)) {
        bag.set({ id: tag.id, type: tag.type, value: decodePackedMulti(tag.type, bytes) });
      } else {
        bag.set({ id: tag.id, type: tag.type, value: decodeScalar(tag.type, bytes, codepage) });
      }
    } catch (e) {
      warn(`could not decode property 0x${formatTag(tag.id, tag.type)}: ${errMsg(e)}`);
    }
  }

  for (const { tag, elements } of multi.values()) {
    try {
      const values: PropValue[] = [];
      for (const el of elements) {
        if (!el) continue; // sparse: an element stream was missing
        values.push(decodeScalar(tag.type, el, codepage));
      }
      bag.set({ id: tag.id, type: tag.type, value: values as PropValue });
    } catch (e) {
      warn(`could not decode multi-valued property 0x${formatTag(tag.id, tag.type)}: ${errMsg(e)}`);
    }
  }

  return bag;
}

/** Multi-valued numeric/time/guid types are packed into a single stream. */
function decodePackedMulti(type: number, bytes: Uint8Array): PropValue {
  const bt = baseType(type);
  const width =
    bt === PT.INT16 ? 2 : bt === PT.INT32 || bt === PT.FLOAT32 ? 4 : bt === PT.GUID ? 16 : 8;
  const out: PropValue[] = [];
  for (let off = 0; off + width <= bytes.length; off += width) {
    out.push(decodeScalar(bt, bytes.subarray(off, off + width), 0));
  }
  return out as PropValue;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Transport headers
// ---------------------------------------------------------------------------

/**
 * Parse an RFC 822 header block into ordered key/value pairs, duplicates and
 * all. Order and repetition are the whole point: a Received chain read out of
 * order is worse than no Received chain.
 */
export function parseTransportHeaders(raw: string): Array<{ key: string; value: string }> {
  const headers: Array<{ key: string; value: string }> = [];
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  let key: string | null = null;
  let value = "";

  const commit = () => {
    if (key !== null) headers.push({ key, value: value.trim() });
    key = null;
    value = "";
  };

  for (const line of lines) {
    if (line === "") {
      // A blank line ends the header block; anything after it is body, which
      // this property should not contain -- but if it does, stop here.
      break;
    }
    if (/^[ \t]/.test(line)) {
      // Folded continuation of the previous header.
      if (key !== null) value += " " + line.trim();
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) continue; // not a header line; skip rather than guess
    commit();
    key = line.slice(0, idx).trim();
    value = line.slice(idx + 1);
  }
  commit();
  return headers;
}

// ---------------------------------------------------------------------------
// Address helpers
// ---------------------------------------------------------------------------

/**
 * Exchange stores internal recipients as X.500 DNs ("/O=CONTOSO/OU=..."),
 * which are useless to a reader and dangerous to treat as an email address.
 */
function isExchangeDn(addr: string | undefined): boolean {
  return !!addr && addr.startsWith("/");
}

function looksLikeEmail(s: string | undefined): boolean {
  return !!s && s.includes("@") && !s.includes(" ");
}

/**
 * Resolve one party's address from the several places MAPI might have put it,
 * preferring an SMTP address over an Exchange DN.
 */
function resolveAddress(
  bag: PropertyBag,
  nameId: number,
  emailId: number,
  addrTypeId: number,
  smtpIds: number[],
): Address | undefined {
  const name = bag.getNonEmptyString(nameId);
  const primary = bag.getNonEmptyString(emailId);
  const addrType = bag.getNonEmptyString(addrTypeId);

  let email: string | undefined;

  // A non-SMTP address type (EX, X400, ...) means `primary` is a directory
  // name, not something you can mail. Reach for the SMTP mirror properties.
  const primaryIsSmtp =
    primary && !isExchangeDn(primary) && (addrType === undefined || addrType.toUpperCase() === "SMTP");

  if (primaryIsSmtp) {
    email = primary;
  } else {
    for (const id of smtpIds) {
      const smtp = bag.getNonEmptyString(id);
      if (looksLikeEmail(smtp)) {
        email = smtp;
        break;
      }
    }
    // Nothing better available: fall back to the DN so the address at least
    // identifies *someone*, rather than silently dropping the sender.
    if (!email && primary) email = primary;
  }

  if (!email && !name) return undefined;
  if (!email) return { name, email: "" };
  return name && name !== email ? { name, email } : { email };
}

// ---------------------------------------------------------------------------
// Message assembly
// ---------------------------------------------------------------------------

interface Ctx {
  cfb: CfbFile;
  warnings: string[];
  /** Monotonic counter behind attachment ids, unique within a message. */
  nextAttachSeq: number;
  /**
   * Messages found inside attachment storages, in discovery order. Collected
   * as we go rather than re-walked afterwards: the attachment pass has already
   * paid for parsing them, and matching them back up by index later would go
   * wrong the moment one attachment is skipped.
   */
  embedded: Message[];
  /** Depth guard: an embedded message can itself embed messages. */
  depth: number;
}

/** A .msg can nest messages arbitrarily; real ones do not nest this far. */
const MAX_EMBED_DEPTH = 16;

function warn(ctx: Ctx, msg: string): void {
  ctx.warnings.push(msg);
}

function buildMessage(
  ctx: Ctx,
  storage: CfbEntry,
  id: string,
  headerSize: number,
  folderPath: string[],
  parentCodepage?: number,
): Message {
  const bag = readPropertyBag(ctx.cfb, storage, {
    headerSize,
    codepage: parentCodepage,
    warn: (m) => warn(ctx, `${id}: ${m}`),
  });

  const message: Message = {
    id,
    format: "msg",
    subject: bag.getString(PID.Subject) ?? "",
    replyTo: [],
    to: [],
    cc: [],
    bcc: [],
    date: null,
    references: [],
    attachments: [],
    headers: [],
    folderPath,
    flags: { hasAttachments: false },
  };

  // --- headers ---
  const rawHeaders = bag.getNonEmptyString(PID.TransportMessageHeaders);
  if (rawHeaders) {
    try {
      message.headers = parseTransportHeaders(rawHeaders);
    } catch (e) {
      warn(ctx, `${id}: transport headers unparseable: ${errMsg(e)}`);
    }
  }
  const headerValue = (name: string): string | undefined => {
    const want = name.toLowerCase();
    return message.headers.find((h) => h.key.toLowerCase() === want)?.value;
  };

  // --- sender ---
  //
  // MAPI splits authorship across two property sets, and the mapping to RFC 5322
  // is the opposite of what the names suggest. When Alice sends on behalf of Bob:
  //
  //   PidTagSentRepresenting*  = Bob    -- who the message is presented as from
  //   PidTagSender*            = Alice  -- who actually submitted it
  //
  // Outlook shows that as "Alice on behalf of Bob", and RFC 5322 writes it as
  // `From: Bob` / `Sender: Alice`. So SentRepresenting is our `from`. Getting
  // this backwards would attribute every delegated message to the assistant who
  // sent it rather than the person it is from, which is exactly the kind of
  // misattribution that matters if anyone reads these messages as evidence.
  const submitter = resolveAddress(
    bag,
    PID.SenderName,
    PID.SenderEmailAddress,
    PID.SenderAddressType,
    [PID.SenderSmtpAddress, PID.SmtpAddress],
  );
  const representing = resolveAddress(
    bag,
    PID.SentRepresentingName,
    PID.SentRepresentingEmailAddress,
    PID.SentRepresentingAddressType,
    [PID.SentRepresentingSmtpAddress, PID.SmtpAddress],
  );

  message.from = representing ?? submitter;
  // Only worth surfacing when the two genuinely differ -- an on-behalf-of send.
  // For the overwhelmingly common case where Alice sends as herself, both
  // property sets name Alice and there is no distinction to draw.
  if (submitter && representing && submitter.email && submitter.email !== representing.email) {
    message.sender = submitter;
  }

  // --- recipients ---
  for (const child of storage.children) {
    if (child.type !== "storage" || !child.name.startsWith(RECIP_PREFIX)) continue;
    try {
      const r = readPropertyBag(ctx.cfb, child, {
        headerSize: PROPS_HEADER_SUB,
        codepage: bag.codepage,
        warn: (m) => warn(ctx, `${id}: ${m}`),
      });
      const addr = resolveAddress(
        r,
        PID.DisplayName,
        PID.EmailAddress,
        PID.AddressType,
        [PID.SmtpAddress],
      );
      if (!addr) continue;
      switch (r.getInt(PID.RecipientType)) {
        case 1:
          message.to.push(addr);
          break;
        case 2:
          message.cc.push(addr);
          break;
        case 3:
          message.bcc.push(addr);
          break;
        default:
          // Unspecified recipient type: To is the least surprising home.
          message.to.push(addr);
      }
    } catch (e) {
      warn(ctx, `${id}: recipient "${child.name}" skipped: ${errMsg(e)}`);
    }
  }

  // --- reply-to ---
  const replyToHeader = headerValue("reply-to");
  if (replyToHeader) {
    message.replyTo = parseAddressList(replyToHeader);
  } else {
    const names = bag.getNonEmptyString(PID.ReplyRecipientNames);
    if (names) message.replyTo = parseAddressList(names);
  }

  // --- date ---
  message.date =
    bag.getDate(PID.ClientSubmitTime) ??
    bag.getDate(PID.MessageDeliveryTime) ??
    null;

  // --- identity ---
  message.messageId = bag.getNonEmptyString(PID.InternetMessageId) ?? headerValue("message-id");
  message.inReplyTo = bag.getNonEmptyString(PID.InReplyToId) ?? headerValue("in-reply-to");
  const refs = bag.getNonEmptyString(PID.InternetReferences) ?? headerValue("references");
  if (refs) message.references = refs.split(/\s+/).filter(Boolean);

  // --- bodies ---
  const plain = bag.getNonEmptyString(PID.Body);
  if (plain) message.text = plain;

  const htmlProp = bag.get(PID.BodyHtml);
  if (htmlProp) {
    if (typeof htmlProp.value === "string") {
      message.html = htmlProp.value;
    } else if (htmlProp.value instanceof Uint8Array) {
      message.html = decodeBytes(htmlProp.value, codepageToLabel(bag.codepage));
    }
  }

  const rtfBytes = bag.getBinary(PID.RtfCompressed);
  if (rtfBytes && rtfBytes.length > 0) {
    try {
      const rtf = decompressLzfu(rtfBytes);
      const result = deencapsulateRtf(rtf);
      if (!message.html && result.html) message.html = result.html;
      if (!message.text && result.text) message.text = result.text;
    } catch (e) {
      warn(ctx, `${id}: compressed RTF body could not be decoded: ${errMsg(e)}`);
    }
  }

  // --- attachments ---
  for (const child of storage.children) {
    if (child.type !== "storage" || !child.name.startsWith(ATTACH_PREFIX)) continue;
    try {
      const att = buildAttachment(ctx, child, bag.codepage, id, folderPath);
      if (att) message.attachments.push(att);
    } catch (e) {
      warn(ctx, `${id}: attachment "${child.name}" skipped: ${errMsg(e)}`);
    }
  }

  // --- flags ---
  const flags = bag.getInt(PID.MessageFlags) ?? 0;
  message.flags = {
    read: (flags & MSGFLAG_READ) !== 0,
    draft: (flags & MSGFLAG_UNSENT) !== 0,
    flagged: bag.getInt(PID.FlagStatus) === 2,
    hasAttachments: message.attachments.length > 0,
  };

  return message;
}

function buildAttachment(
  ctx: Ctx,
  storage: CfbEntry,
  codepage: number,
  parentId: string,
  folderPath: string[],
): Attachment | null {
  const bag = readPropertyBag(ctx.cfb, storage, {
    headerSize: PROPS_HEADER_SUB,
    codepage,
    warn: (m) => warn(ctx, `${parentId}: ${m}`),
  });

  const seq = ctx.nextAttachSeq++;
  const attId = `${parentId}-att${seq}`;
  const method = bag.getInt(PID.AttachMethod) ?? 1;
  const contentId = bag.getNonEmptyString(PID.AttachContentId);
  const attachFlags = bag.getInt(PID.AttachFlags) ?? 0;

  let filename =
    bag.getNonEmptyString(PID.AttachLongFilename) ??
    bag.getNonEmptyString(PID.AttachFilename) ??
    bag.getNonEmptyString(PID.DisplayName);
  let mimeType = bag.getNonEmptyString(PID.AttachMimeTag) ?? "";
  let content: Uint8Array;

  if (method === ATTACH_METHOD_EMBEDDED) {
    // The "data" property is a storage, not a stream: a whole nested message.
    const nested = storage.children.find(
      (c) => c.type === "storage" && parseSubstgName(c.name)?.id === PID.AttachDataObject,
    );
    if (!nested) {
      warn(ctx, `${parentId}: attachment claims an embedded message but has no storage for it`);
      return null;
    }
    if (ctx.depth >= MAX_EMBED_DEPTH) {
      warn(ctx, `${parentId}: embedded messages nested deeper than ${MAX_EMBED_DEPTH}; not recursing`);
      return null;
    }
    ctx.depth++;
    let embedded: Message;
    try {
      embedded = buildMessage(
        ctx,
        nested,
        `${attId}-msg`,
        PROPS_HEADER_EMBEDDED,
        folderPath,
        codepage,
      );
    } finally {
      ctx.depth--;
    }
    ctx.embedded.push(embedded);

    // The model has no "nested message" slot, and the original bytes of an
    // embedded message do not exist as a contiguous blob -- it is a directory
    // tree, not a stream. Render it back to RFC 822 so that "download" still
    // produces something a mail client can open.
    content = synthesizeEml(embedded);
    mimeType = mimeType || "message/rfc822";
    filename = filename ?? `${sanitizeFilename(embedded.subject) || "message"}.eml`;
  } else {
    const data = bag.getBinary(PID.AttachDataBinary);
    if (!data) {
      warn(ctx, `${parentId}: attachment "${filename ?? storage.name}" has no data; skipped`);
      return null;
    }
    content = data;
  }

  if (!filename) filename = `attachment-${seq}`;
  if (!mimeType) mimeType = guessMimeType(filename);

  return {
    id: attId,
    filename,
    mimeType,
    size: content.length,
    contentId,
    // An attachment is inline if the body refers to it. A content id is the
    // strong signal; ATT_MHTML_REF is the flag Outlook sets alongside it.
    inline: !!contentId || (attachFlags & ATT_MHTML_REF) !== 0,
    content,
  };
}

function sanitizeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>| -]/g, "_").trim().slice(0, 120);
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  htm: "text/html",
  html: "text/html",
  csv: "text/csv",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  eml: "message/rfc822",
  msg: "application/vnd.ms-outlook",
};

function guessMimeType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = filename.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Render a parsed message back to RFC 822, well enough to be downloadable.
 *
 * Only used for embedded messages, which have no original bytes to hand back.
 * Where the embedded message carried its own transport headers we reuse them
 * verbatim; otherwise we synthesise the handful that matter.
 */
function synthesizeEml(m: Message): Uint8Array {
  const lines: string[] = [];
  const fmt = (a: Address) => (a.name ? `"${a.name.replace(/"/g, "'")}" <${a.email}>` : a.email);

  if (m.headers.length > 0) {
    for (const h of m.headers) lines.push(`${h.key}: ${h.value}`);
  } else {
    if (m.date) lines.push(`Date: ${m.date.toUTCString()}`);
    if (m.from) lines.push(`From: ${fmt(m.from)}`);
    if (m.to.length) lines.push(`To: ${m.to.map(fmt).join(", ")}`);
    if (m.cc.length) lines.push(`Cc: ${m.cc.map(fmt).join(", ")}`);
    lines.push(`Subject: ${m.subject}`);
    lines.push("MIME-Version: 1.0");
    lines.push(
      m.html
        ? 'Content-Type: text/html; charset="utf-8"'
        : 'Content-Type: text/plain; charset="utf-8"',
    );
  }
  lines.push("");
  lines.push(m.html ?? m.text ?? "");

  return new TextEncoder().encode(lines.join("\r\n"));
}

/** A deliberately forgiving address-list split. Good enough for Reply-To. */
function parseAddressList(raw: string): Address[] {
  const out: Address[] = [];
  for (const part of raw.split(/[,;]/)) {
    const s = part.trim();
    if (!s) continue;
    const angle = /^(.*?)<([^>]+)>\s*$/.exec(s);
    if (angle) {
      const name = angle[1].trim().replace(/^"(.*)"$/, "$1").trim();
      const email = angle[2].trim();
      out.push(name ? { name, email } : { email });
    } else if (looksLikeEmail(s)) {
      out.push({ email: s });
    } else {
      out.push({ name: s, email: "" });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse a .msg file into the shared archive model.
 *
 * A .msg holds exactly one top-level message, so the archive gets one
 * synthetic root folder named after the file. Messages embedded as
 * attachments are parsed too and joined to the pool, because they are real
 * messages a reader will want to open -- the attachment entry that carries
 * them stays put so the relationship is still visible.
 */
export async function parseMsg(
  bytes: Uint8Array,
  name: string,
  onProgress?: ProgressFn,
): Promise<ParsedArchive> {
  const warnings: string[] = [];

  onProgress?.({ phase: "Reading compound file", fraction: 0, messagesFound: 0 });

  const cfb = parseCfb(bytes); // throws CfbError when the magic is missing
  warnings.push(...cfb.warnings);

  onProgress?.({ phase: "Reading properties", fraction: 0.3, messagesFound: 0 });

  const ctx: Ctx = { cfb, warnings, nextAttachSeq: 0, embedded: [], depth: 0 };
  const rootName = name.replace(/\.msg$/i, "") || name;

  const message = buildMessage(ctx, cfb.root, "msg-0", PROPS_HEADER_TOPLEVEL, [rootName]);
  message.raw = bytes;

  // Embedded messages were parsed during the attachment pass. They are real
  // messages with real bodies, so they join the pool rather than being locked
  // inside an attachment blob -- the attachment entry that carries each one
  // stays put, so the relationship is still visible in the UI.
  const messages: Message[] = [message, ...ctx.embedded];

  onProgress?.({ phase: "Done", fraction: 1, messagesFound: messages.length });

  const root: Folder = {
    id: "root",
    name: rootName,
    path: [rootName],
    children: [],
    messageIds: messages.map((m) => m.id),
  };

  return {
    sourceName: name,
    format: "msg",
    messages,
    root,
    warnings,
  };
}
