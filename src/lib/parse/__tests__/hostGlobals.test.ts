/**
 * Which non-ECMAScript globals can the .olm parser reach? (MAC-513)
 *
 * The parser shipped calling DOMParser, which neither of its runtimes has: the
 * browser's parse worker, and the Mac app's parse service on bare
 * JavaScriptCore, whose host supplies Blob, TextDecoder and TextEncoder and
 * nothing else. This type-checks the parser's whole import closure against the
 * ES2022 library alone -- no DOM, no WebWorker -- so any other host global is a
 * "cannot find name" and fails here, on paths no fixture runs. It is the web
 * half of mailviewer-mac's js/api-audit.mjs.
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";

const HOST_SUPPLIED = new Set(["Blob", "TextDecoder", "TextEncoder"]);

function hostGlobals(entry: string): string[] {
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    types: [],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
  });
  const found: string[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.fileName.includes("/node_modules/")) continue;
    for (const d of program.getSemanticDiagnostics(sf)) {
      const name = /Cannot find name '([^']+)'/.exec(ts.flattenDiagnosticMessageText(d.messageText, " "))?.[1];
      if (name && !HOST_SUPPLIED.has(name)) {
        const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
        found.push(`${name} at ${sf.fileName.replace(/.*\/src\//, "src/")}:${line + 1}`);
      }
    }
  }
  return found;
}

describe("the .olm parser's host globals", () => {
  it("uses nothing but ECMAScript, Blob, TextDecoder and TextEncoder", () => {
    const entry = new URL("../olm.ts", import.meta.url).pathname;
    expect(hostGlobals(entry)).toEqual([]);
  }, 30000);
});
