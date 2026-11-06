import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * MAC-787: one design language. The web app's stylesheet and the Mac purchase
 * page declare the same palette, the same accent and the same lit buttons.
 * Whoever changes one of them changes the other, or this fails.
 *
 * In scripts/ rather than src/__tests__/ because it reads files from disk, and
 * src/ is compiled without Node's types.
 */
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const mac = readFileSync(new URL("../public/mac/index.html", import.meta.url), "utf8");

const tokens = (text: string, from: string) => {
  const start = text.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const block = text.slice(start, text.indexOf("}", start));
  return Object.fromEntries([...block.matchAll(/--([a-z0-9]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));
};

describe("the site and the Mac page", () => {
  const site = tokens(css, ":root {");
  const page = tokens(mac, ".mv{");

  it("declare the same palette", () => {
    for (const name of ["accent", "bg", "bg2", "card", "card2", "ink", "ink2", "ink3"]) {
      expect(site[name], `--${name}`).toBe(page[name]);
    }
    expect(page.accent).toBe("#3FD0B3");
    expect(page.bg).toBe("#0B1211");
    expect(page.card).toBe("#131D1B");
    expect(page.ink).toBe("#ECF2F0");
    expect(page.ink2).toBe("#A7B5B1");
    expect(page.ink3).toBe("#788683");
  });

  it("draw the primary button with the same gradient", () => {
    const flat = (s: string) => s.replace(/\s+/g, "");
    const lit = flat("linear-gradient(180deg,#5BE3C7 0%,#2FBB9E 100%)");
    expect(flat(mac)).toContain(`.btn-primary{color:#06201B!important;background:${lit}`);
    expect(flat(css)).toContain(`.btn-primary{color:var(--accent-ink);background:${lit}`);
    expect(css).toContain("--accent-ink: #06201B;");
  });

  it("leave no token of the old site palette behind", () => {
    expect(css).not.toMatch(/--(slate-\d+|bone|muted|dim|amber|teal)\b/);
    expect(css).not.toMatch(/#(ffb020|2dd4bf|0b0f14|e9eef4|8ea0b5|5f7189)\b/i);
  });
});
