import PostalMime from "postal-mime";
import type { Address, Attachment, Message, ParsedArchive } from "../model";
import { singleMessageArchive } from "./archive";

/**
 * Apple Mail's .emlx wraps a plain RFC822 message in a byte-count prefix line
 * and a trailing plist of Apple-internal flags. Strip both and we have an .eml.
 */
export function stripEmlxWrapper(bytes: Uint8Array): Uint8Array {
  const nl = bytes.indexOf(0x0a);
  if (nl === -1) return bytes;

  const firstLine = new TextDecoder("latin1").decode(bytes.subarray(0, nl)).trim();
  const declaredLength = Number.parseInt(firstLine, 10);
  if (!Number.isFinite(declaredLength) || declaredLength <= 0) return bytes;

  const start = nl + 1;
  // Trust the declared length, but never read past the end of the buffer -- a
  // truncated .emlx should still render whatever message body survived.
  const end = Math.min(start + declaredLength, bytes.length);
  return bytes.subarray(start, end);
}

function toAddress(a: { address?: string | null; name?: string | null } | null | undefined): Address | undefined {
  if (!a?.address) return undefined;
  return { email: a.address, name: a.name || undefined };
}

function toAddresses(list: Array<{ address?: string | null; name?: string | null }> | null | undefined): Address[] {
  if (!list) return [];
  return list.map(toAddress).filter((a): a is Address => !!a);
}

/** Parse one RFC822/MIME message into the common model. */
export async function parseEmlMessage(
  bytes: Uint8Array,
  id: string,
  folderPath: string[],
  format: "eml" | "emlx" | "mbox",
): Promise<Message> {
  const source = format === "emlx" ? stripEmlxWrapper(bytes) : bytes;

  // postal-mime wants a standalone ArrayBuffer; a subarray's buffer may be the
  // whole multi-gigabyte mbox, so copy the slice we actually mean.
  const buf = source.slice().buffer as ArrayBuffer;
  const email = await new PostalMime().parse(buf);

  const attachments: Attachment[] = (email.attachments ?? []).map((att, i) => {
    const content =
      typeof att.content === "string"
        ? new TextEncoder().encode(att.content)
        : new Uint8Array(att.content as ArrayBuffer);

    const contentId = att.contentId?.replace(/^<|>$/g, "") || undefined;

    return {
      id: `${id}:att:${i}`,
      filename: att.filename || `attachment-${i + 1}`,
      mimeType: att.mimeType || "application/octet-stream",
      size: content.byteLength,
      contentId,
      // "related" means the part is referenced from the body (an inline image)
      // rather than offered to the user as a file to save.
      inline: att.disposition === "inline" || !!att.related,
      content,
    };
  });

  const headers = (email.headers ?? []).map((h) => ({ key: h.key, value: h.value }));

  const references = (email.references ?? "")
    .split(/\s+/)
    .map((r) => r.trim())
    .filter(Boolean);

  return {
    id,
    format,
    subject: email.subject || "(no subject)",
    from: toAddress(email.from),
    sender: toAddress((email as { sender?: { address?: string; name?: string } }).sender),
    replyTo: toAddresses(email.replyTo),
    to: toAddresses(email.to),
    cc: toAddresses(email.cc),
    bcc: toAddresses(email.bcc),
    date: email.date ? new Date(email.date) : null,
    messageId: email.messageId,
    inReplyTo: email.inReplyTo,
    references,
    html: email.html || undefined,
    text: email.text || undefined,
    attachments,
    headers,
    raw: source,
    folderPath,
    flags: {
      hasAttachments: attachments.some((a) => !a.inline),
    },
  };
}

export async function parseEml(
  bytes: Uint8Array,
  name: string,
  format: "eml" | "emlx" = "eml",
): Promise<ParsedArchive> {
  const message = await parseEmlMessage(bytes, "msg-0", [name], format);
  return singleMessageArchive(message, name, format);
}
