import type { Folder, Message, ParsedArchive } from "./model";

/**
 * Rewrite every id in an archive so it can coexist with other archives.
 *
 * Each parser numbers its own messages from zero ("msg-0", "root", ...), so the
 * moment a second file is opened those ids collide. Prefixing every message,
 * attachment and folder id -- and the folder->message references that point at
 * them -- with a per-file key keeps React keys and selection unambiguous once
 * several files share one view.
 */
export function namespaceArchive(archive: ParsedArchive, key: string): ParsedArchive {
  const mid = (id: string) => `${key}:${id}`;

  const messages: Message[] = archive.messages.map((m) => ({
    ...m,
    id: mid(m.id),
    attachments: m.attachments.map((a) => ({ ...a, id: `${key}:${a.id}` })),
  }));

  const remap = (f: Folder): Folder => ({
    ...f,
    id: mid(f.id),
    messageIds: f.messageIds.map(mid),
    children: f.children.map(remap),
  });

  return { ...archive, root: remap(archive.root), messages };
}
