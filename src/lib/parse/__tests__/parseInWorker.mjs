// Spawn olmWorker.mjs on a worker thread and hand back what it reports. Plain
// JavaScript so the TypeScript tests need no Node type definitions.
import { Worker } from "node:worker_threads";

export function parseInWorker(bytes, name, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./olmWorker.mjs", import.meta.url), {
      workerData: { bytes, name },
    });
    // A parser that hangs on a damaged file is a failure, not a slow test.
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`parsing ${name} did not finish within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    worker.once("message", (m) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(m);
    });
    worker.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
