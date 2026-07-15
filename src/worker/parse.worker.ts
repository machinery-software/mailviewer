/// <reference lib="webworker" />
import type { ParsedArchive, ParseProgress } from "../lib/model";
import { declineObsoleteFormat, detectFormat } from "../lib/parse/detect";
import { parseEml } from "../lib/parse/eml";
import { parseMbox } from "../lib/parse/mbox";
import { parseMsg } from "../lib/parse/msg";
import { parseOlm } from "../lib/parse/olm";
import { parsePst } from "../lib/parse/pst";
import { parseTnef } from "../lib/parse/tnef";

/**
 * Parsing happens off the main thread so that a 4 GB PST doesn't freeze the tab.
 *
 * This worker is also where the privacy story is easiest to verify: it has no
 * network code in it at all, and the CSP's `worker-src 'self'` means the browser
 * will only ever run a worker script served from this origin.
 */

export type WorkerRequest = { type: "parse"; file: File };

export type WorkerResponse =
  | { type: "progress"; progress: ParseProgress }
  | { type: "done"; archive: ParsedArchive }
  | { type: "error"; message: string };

const post = (msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg);

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  if (e.data.type !== "parse") return;
  const { file } = e.data;

  const onProgress = (progress: ParseProgress) => post({ type: "progress", progress });

  try {
    // Sniff on the first 4 KB rather than reading the whole file, which matters
    // when "the whole file" is a multi-gigabyte archive.
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());

    // Some formats we recognise only to refuse them, with copy that tells the
    // user what to do instead. Do this before dispatch so they never hit a
    // confusing generic parse error.
    const declined = declineObsoleteFormat(head, file.name);
    if (declined) throw new Error(declined);

    const format = detectFormat(head, file.name);

    onProgress({ phase: `Reading ${format.toUpperCase()}`, fraction: null, messagesFound: 0 });

    let archive: ParsedArchive;
    switch (format) {
      case "mbox":
        archive = await parseMbox(file, file.name, onProgress);
        break;
      case "pst":
      case "ost":
        archive = await parsePst(file, file.name, onProgress);
        break;
      case "msg":
      case "oft":
        // An .oft is a MAPI compound file just like a .msg.
        archive = await parseMsg(new Uint8Array(await file.arrayBuffer()), file.name, onProgress);
        break;
      case "olm":
        archive = await parseOlm(file, file.name, onProgress);
        break;
      case "tnef":
        archive = await parseTnef(new Uint8Array(await file.arrayBuffer()), file.name, onProgress);
        break;
      case "eml":
      case "emlx":
      case "mht":
        archive = await parseEml(new Uint8Array(await file.arrayBuffer()), file.name, format);
        break;
    }

    post({ type: "done", archive });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
