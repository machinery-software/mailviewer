// Runs the .olm parser where parsers actually run: a worker thread with no DOM.
//
// Node's worker_threads has no DOMParser, document or window -- the same as the
// browser's parse Web Worker and the Mac app's parse service -- and Node 24
// strips the TypeScript types itself, so this loads olm.ts as it is, with no
// bundler and nothing provided behind its back. jsdom is what let the old
// parser pass its tests while failing every real user (MAC-513).
import { parentPort, workerData } from "node:worker_threads";

const globals = {
  DOMParser: typeof globalThis.DOMParser,
  document: typeof globalThis.document,
  window: typeof globalThis.window,
};

try {
  const { parseOlm } = await import("../olm.ts");
  const archive = await parseOlm(new Blob([workerData.bytes]), workerData.name);
  parentPort.postMessage({
    globals,
    ok: true,
    archive: {
      format: archive.format,
      warnings: archive.warnings,
      messages: archive.messages.map((m) => ({
        subject: m.subject,
        from: m.from,
        to: m.to,
        cc: m.cc,
        date: m.date?.toISOString() ?? null,
        html: m.html,
        text: m.text,
        folderPath: m.folderPath,
        attachments: m.attachments.map((a) => ({
          filename: a.filename,
          mimeType: a.mimeType,
          inline: a.inline,
          contentId: a.contentId,
          content: a.content,
        })),
      })),
    },
  });
} catch (err) {
  parentPort.postMessage({ globals, ok: false, error: err instanceof Error ? err.message : String(err) });
}
