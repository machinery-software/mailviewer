import { defineConfig } from "vitest/config";

/**
 * The print tests drive real browsers and produce real PDFs, so they are kept
 * out of `npm test`: that suite is pure and fast and runs on every push, and
 * these need `npm run build` plus a Playwright browser download first.
 *
 * Run them with `npm run test:print`.
 */
export default defineConfig({
  test: {
    include: ["tests/print/**/*.test.mjs"],
    environment: "node",
    // One browser, several tabs, and PDF generation is not quick.
    testTimeout: 180000,
    hookTimeout: 120000,
    // Page count depends on layout; parallel tabs competing for one engine
    // make a failure hard to read.
    fileParallelism: false,
  },
});
