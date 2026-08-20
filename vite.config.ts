/// <reference types="vitest/config" />
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/**
 * The commit this bundle was built from, stamped in at build time.
 *
 * A bug report that says "it broke" is worth much less than one that says which
 * build it broke on, and the app has no other way to know: it never talks to a
 * server, so it cannot ask. CI provides GITHUB_SHA; a local build asks git; a
 * build from a source tarball gets "unknown" rather than failing.
 */
function commitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

// The dev server mirrors the production CSP from public/_headers as closely as
// it can, so that "it worked locally" can never mean "it worked because the dev
// server was more permissive". If a change would break the privacy guarantee in
// production, it breaks here first.
const DEV_CSP = [
  "default-src 'self'",
  // Vite's HMR client is injected inline and eval's module code in dev only.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  // Dev needs a websocket back to Vite for hot reload; production is 'none'.
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_COMMIT__: JSON.stringify(commitSha()),
    __APP_VERSION__: JSON.stringify(version),
  },
  test: {
    // Most parser tests are pure byte-shuffling and need no DOM. The sanitizer
    // tests opt into jsdom per-file with a @vitest-environment docblock.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  server: {
    headers: {
      "Content-Security-Policy": DEV_CSP,
      "Referrer-Policy": "no-referrer",
    },
  },
  build: {
    target: "es2022",
    // Everything is bundled and served from our own origin. No CDN, no dynamic
    // remote imports -- which is what lets connect-src 'none' hold in prod.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
        },
      },
    },
  },
});
