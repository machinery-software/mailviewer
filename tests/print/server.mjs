// A static file server for dist/ that replays the *production* response headers
// from public/_headers, so a print test cannot pass because the test server was
// more permissive than the real one. Same reasoning as the DEV_CSP block in
// vite.config.ts.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/** Parse the `/*` block of public/_headers into a plain header map. */
export async function productionHeaders(headersFile) {
  const text = await readFile(headersFile, "utf8");
  const out = {};
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line) || !/^\s+\S/.test(line)) continue;
    const m = line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export async function startServer(distDir, headersFile) {
  const root = resolve(distDir);
  const headers = await productionHeaders(headersFile);
  // Only meaningful over HTTPS, and it would force the test browser to upgrade
  // its own http://127.0.0.1 requests into nothing.
  delete headers["Strict-Transport-Security"];
  headers["Content-Security-Policy"] = headers["Content-Security-Policy"]
    ?.replace(/;?\s*upgrade-insecure-requests/, "");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let file = join(root, url.pathname);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    if (!existsSync(file) || url.pathname === "/") file = join(root, "index.html");
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        ...headers,
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}
