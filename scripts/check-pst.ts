/**
 * Run the PST reader against a real .pst and print what it found.
 *
 * The parser is browser-only by design (Blob + slice, no fs), so this harness
 * reads the file with Node and hands it over as a Blob -- the parser itself is
 * untouched and exercises exactly the code path the Worker runs.
 *
 * Usage: npx vite-node scripts/check-pst.ts <file.pst>
 */
import { readFileSync } from "node:fs";
import { parsePst } from "../src/lib/parse/pst/index.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: check-pst.ts <file.pst>");
  process.exit(1);
}

const bytes = readFileSync(path);
const blob = new Blob([bytes]);
console.log(`file: ${path} (${(bytes.length / 1024).toFixed(0)} KB)\n`);

const archive = await parsePst(blob, path.split("/").pop()!, (p) => {
  if (p.fraction === null) process.stdout.write(`  ${p.phase}…\r`);
});

console.log(`format:   ${archive.format}`);
console.log(`messages: ${archive.messages.length}`);
console.log(`warnings: ${archive.warnings.length}`);

const walk = (f: typeof archive.root, depth = 0): void => {
  console.log(`${"  ".repeat(depth + 1)}${f.name}  (${f.messageIds.length})`);
  for (const c of f.children) walk(c, depth + 1);
};
console.log("\nfolders:");
walk(archive.root);

console.log("\nmessages:");
for (const m of archive.messages) {
  const att = m.attachments.filter((a) => !a.inline);
  console.log(
    `  [${m.folderPath.join("/")}] "${m.subject}"\n` +
      `      from: ${m.from ? `${m.from.name ?? ""} <${m.from.email}>` : "(none)"}\n` +
      `      to:   ${m.to.map((t) => t.email).join(", ") || "(none)"}\n` +
      `      date: ${m.date ? m.date.toISOString() : "(none)"}\n` +
      `      body: ${m.html ? `html ${m.html.length}b` : m.text ? `text ${m.text.length}b` : "NONE"}\n` +
      `      att:  ${att.length ? att.map((a) => `${a.filename} (${a.size}b)`).join(", ") : "none"}`,
  );
}

if (archive.warnings.length) {
  console.log("\nwarnings:");
  for (const w of archive.warnings.slice(0, 20)) console.log(`  - ${w}`);
}
