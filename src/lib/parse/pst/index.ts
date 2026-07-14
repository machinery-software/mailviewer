/**
 * PST / OST reader.
 *
 * Pure TypeScript, no dependencies, no network, no WASM. Runs in a Web Worker
 * against a Blob, reading slices on demand -- a 10 GB archive costs us a few
 * hundred KB of resident memory plus whatever the messages themselves weigh.
 *
 * Layered exactly like MS-PST itself:
 *   header.ts     the file header and the two BTree roots
 *   ndb.ts        nodes, blocks, data trees, subnode BTrees, block decoding
 *   ltp.ts        heaps, BTrees-on-heap, property contexts, table contexts
 *   messaging.ts  folders, messages, recipients, attachments
 *
 * Compressed RTF bodies are handled by the shared ../lzfu.ts (the codec) and
 * ../rtf.ts (de-encapsulation), which the .msg parser uses too.
 */
import type { Folder, Message, ParsedArchive, ProgressFn, SourceFormat } from "../../model.ts";
import { blobReader } from "./reader.ts";
import { readHeader } from "./header.ts";
import { Ndb } from "./ndb.ts";
import {
  buildMessage,
  errText,
  NID_ROOT_FOLDER,
  planFolders,
  readNamedPropertyMap,
  toFolder,
} from "./messaging.ts";
import type { FolderPlan, WalkContext } from "./messaging.ts";

export { parsePst as default };

export async function parsePst(
  file: Blob,
  name: string,
  onProgress?: ProgressFn,
): Promise<ParsedArchive> {
  const warnings: string[] = [];
  const messages: Message[] = [];

  const format: SourceFormat = name.toLowerCase().endsWith(".ost") ? "ost" : "pst";

  const report = (phase: string, fraction: number | null) => {
    onProgress?.({ phase, fraction, messagesFound: messages.length });
  };

  report("Reading header", null);

  const reader = blobReader(file);
  // Throws with a clear message when the magic bytes are not !BDN.
  const header = await readHeader(reader);
  const ndb = new Ndb(reader, header);

  const ctx: WalkContext = {
    ndb,
    warnings,
    messages,
    namedProps: new Map(),
  };

  report("Reading the name-to-ID map", null);
  ctx.namedProps = await readNamedPropertyMap(ndb, warnings);

  report("Reading folder tree", null);

  let plan: FolderPlan;
  try {
    plan = await planFolders(ctx, NID_ROOT_FOLDER);
  } catch (err) {
    throw new Error(
      `The PST header parsed, but its folder tree could not be read: ${errText(err)}`,
    );
  }

  // Flatten the plan so progress has a real denominator.
  const flat: FolderPlan[] = [];
  (function collect(p: FolderPlan) {
    flat.push(p);
    p.children.forEach(collect);
  })(plan);

  const total = flat.reduce((n, f) => n + f.messageNids.length, 0);
  let done = 0;

  const idsByFolder = new Map<FolderPlan, string[]>();

  for (const folder of flat) {
    const ids: string[] = [];
    idsByFolder.set(folder, ids);

    const label = folder.path.length ? folder.path.join(" / ") : "Top of Personal Folders";

    for (const nid of folder.messageNids) {
      try {
        const msg = await buildMessage(ctx, nid, folder.path);
        if (msg) {
          messages.push(msg);
          ids.push(msg.id);
        }
      } catch (err) {
        // A single corrupt message must never sink the file.
        warnings.push(`Skipped a message in "${label}": ${errText(err)}`);
      }

      done++;
      if (done % 25 === 0 || done === total) {
        report(`Reading ${label}`, total > 0 ? done / total : null);
      }
    }
  }

  const root: Folder = toFolder(plan, (p) => idsByFolder.get(p) ?? []);

  report("Done", 1);

  return { sourceName: name, format, messages, root, warnings };
}
