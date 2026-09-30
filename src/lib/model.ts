/**
 * The one message shape every parser produces.
 *
 * EML, MSG, MBOX and PST disagree about almost everything -- character sets,
 * how a recipient is spelled, whether a "folder" exists at all -- so each parser
 * is responsible for flattening its format into this model. The UI never learns
 * which format a message came from except to display a badge.
 */

export type SourceFormat =
  | "eml"
  | "emlx"
  | "msg"
  | "mbox"
  | "pst"
  | "ost"
  | "tnef"
  | "mht"
  | "oft"
  | "olm";

export interface Address {
  name?: string;
  email: string;
}

export interface Attachment {
  /** Stable id, unique within a message. Used as a React key and download name. */
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Set when the attachment is referenced by a cid: URL in the HTML body. */
  contentId?: string;
  /**
   * The part's Content-Location. MHTML web archives reference their inline
   * sub-resources by this URL from the body's `src` attributes, the way ordinary
   * mail uses cid:. Set only by the MHTML path; sanitize.ts resolves it.
   */
  contentLocation?: string;
  /** True for images displayed inline rather than listed as a download. */
  inline: boolean;
  content: Uint8Array;
}

export interface Message {
  id: string;
  format: SourceFormat;

  subject: string;
  from?: Address;
  /** Present on messages sent on behalf of someone else; worth surfacing. */
  sender?: Address;
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];

  /** The best available send date. Null when the format genuinely lacks one. */
  date: Date | null;
  messageId?: string;
  inReplyTo?: string;
  references: string[];

  /** Sanitized at render time, never at parse time -- see sanitize.ts. */
  html?: string;
  text?: string;

  attachments: Attachment[];

  /**
   * Every header, in original order, duplicates preserved. Needed for the raw
   * view and for anything that inspects Received/DKIM chains.
   */
  headers: Array<{ key: string; value: string }>;

  /** The original bytes, when we have them. Enables "download original". */
  raw?: Uint8Array;

  /**
   * Set when the message has more MIME parts than the parser reads (see
   * parse/mimeParts.ts): how many it declares, and how many are shown. Nothing
   * is damaged -- the later parts were left out -- so this is reported on its
   * own terms rather than counted among the archive's warnings.
   */
  omittedParts?: { total: number; shown: number };

  /** Path within the containing archive, e.g. ["Inbox", "Clients"]. */
  folderPath: string[];

  flags: {
    read?: boolean;
    flagged?: boolean;
    draft?: boolean;
    hasAttachments: boolean;
  };
}

export interface Folder {
  id: string;
  name: string;
  path: string[];
  children: Folder[];
  messageIds: string[];
}

/** What a parser hands back: a flat message pool plus the folder tree over it. */
export interface ParsedArchive {
  sourceName: string;
  format: SourceFormat;
  messages: Message[];
  /** Single-message formats produce one synthetic root folder. */
  root: Folder;
  /** Non-fatal problems. A corrupt message should never sink the whole file. */
  warnings: string[];
}

export interface ParseProgress {
  phase: string;
  /** 0..1, or null when the total is not yet known. */
  fraction: number | null;
  messagesFound: number;
}

export type ProgressFn = (p: ParseProgress) => void;
