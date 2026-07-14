import type { Folder, Message, ParsedArchive, SourceFormat } from "../model";

/** Wrap a single parsed message in the folder shape the UI expects. */
export function singleMessageArchive(
  message: Message,
  sourceName: string,
  format: SourceFormat,
  warnings: string[] = [],
): ParsedArchive {
  const root: Folder = {
    id: "root",
    name: sourceName,
    path: [sourceName],
    children: [],
    messageIds: [message.id],
  };
  return { sourceName, format, messages: [message], root, warnings };
}
