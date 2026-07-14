import type { ParsedArchive, ParseProgress } from "./model";
import type { WorkerRequest, WorkerResponse } from "../worker/parse.worker";

/**
 * Drive the parse worker from the UI thread.
 *
 * A fresh worker per file: parsing a hostile or malformed archive can leave the
 * worker in a bad state, and throwing it away afterwards is cheaper and safer
 * than trying to reason about what a half-failed PST walk left behind.
 */
export function parseFile(
  file: File,
  onProgress: (p: ParseProgress) => void,
): { promise: Promise<ParsedArchive>; cancel: () => void } {
  const worker = new Worker(new URL("../worker/parse.worker.ts", import.meta.url), {
    type: "module",
  });

  const promise = new Promise<ParsedArchive>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === "progress") onProgress(msg.progress);
      else if (msg.type === "done") {
        resolve(msg.archive);
        worker.terminate();
      } else {
        reject(new Error(msg.message));
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      reject(new Error(e.message || "The parser crashed while reading this file."));
      worker.terminate();
    };
  });

  const req: WorkerRequest = { type: "parse", file };
  worker.postMessage(req);

  return { promise, cancel: () => worker.terminate() };
}
