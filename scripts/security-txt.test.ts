// public/.well-known/security.txt (RFC 9116). It must stay valid, and its
// Expires must be renewed: this fails 30 days before the date, on purpose, so
// CI says so while there is time (SECURITY.md).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const text = readFileSync(new URL("../public/.well-known/security.txt", import.meta.url), "utf8");
const fields = text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/:\s(.*)/s, 2) as [string, string]);
const values = (name: string) => fields.filter(([k]) => k === name).map(([, v]) => v);

describe("security.txt", () => {
  it("names the reporting address and GitHub's private reporting, as SECURITY.md does", () => {
    expect(values("Contact")).toEqual([
      "mailto:security@machinery.software",
      "https://github.com/machinery-software/mailviewer/security/advisories/new",
    ]);
    const policy = readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
    expect(policy).toContain("security@machinery.software");
    expect(policy).toContain("https://github.com/machinery-software/mailviewer/security/advisories/new");
    expect(values("Policy")).toEqual(["https://github.com/machinery-software/mailviewer/blob/main/SECURITY.md"]);
  });

  it("has one Expires, less than a year out and more than 30 days away", () => {
    const expires = values("Expires");
    expect(expires).toHaveLength(1);
    const at = Date.parse(expires[0]);
    expect(Number.isNaN(at)).toBe(false);
    const days = (at - Date.now()) / 86_400_000;
    expect(days, "renew Expires in public/.well-known/security.txt").toBeGreaterThan(30);
    expect(days).toBeLessThanOrEqual(366);
  });

  it("uses only fields RFC 9116 defines", () => {
    const known = new Set(["Acknowledgments", "Canonical", "Contact", "Encryption", "Expires", "Hiring", "Policy", "Preferred-Languages"]);
    for (const [k] of fields) expect(known.has(k), k).toBe(true);
  });
});
