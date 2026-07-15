import { describe, expect, it } from "vitest";
import { classify, type BlockedEvent, type NetworkEvent } from "../netguard";

const ev = (over: Partial<NetworkEvent>): NetworkEvent => ({
  url: "https://app.example/x.js",
  kind: "script",
  bytes: 0,
  at: 0,
  sameOrigin: true,
  ...over,
});

/**
 * This is the safety-critical decision on the whole site: which network activity
 * counts as our code doing its job, which as the browser protecting the user, and
 * which as an actual leak. Getting the third one wrong -- calling a real
 * exfiltration "fine" -- is the failure that matters, so it is pinned here.
 */
describe("classify", () => {
  it("counts same-origin resources as loaded, never as leaks", () => {
    const s = classify([ev({ sameOrigin: true, bytes: 5000 }), ev({ sameOrigin: true })], []);
    expect(s.events).toHaveLength(2);
    expect(s.leakedCount).toBe(0);
    expect(s.blocked).toHaveLength(0);
  });

  it("treats a foreign resource that moved 0 bytes as blocked, not leaked", () => {
    // This is the Cloudflare-beacon case: injected by the host, refused by the
    // CSP, reports 0 bytes. It must read as the policy working, not as a leak.
    const s = classify(
      [ev({ sameOrigin: false, bytes: 0, url: "https://static.cloudflareinsights.com/beacon.min.js" })],
      [],
    );
    expect(s.leakedCount).toBe(0);
    expect(s.blocked).toHaveLength(1);
    expect(s.blocked[0].uri).toContain("cloudflareinsights");
    expect(s.blocked[0].directive).toBe("script-src");
  });

  it("RAISES the alarm for a foreign resource that actually transferred data", () => {
    // The one case that must never be silent: bytes actually left for another
    // origin. If this ever regresses, the site lies to users.
    const s = classify(
      [ev({ sameOrigin: false, bytes: 1200, url: "https://evil.example/steal" })],
      [],
    );
    expect(s.leakedCount).toBe(1);
  });

  it("collapses repeat blocked requests to one row per host", () => {
    const beacon = "https://static.cloudflareinsights.com/beacon.min.js";
    const s = classify(
      [
        ev({ sameOrigin: false, bytes: 0, url: beacon }),
        ev({ sameOrigin: false, bytes: 0, url: beacon }),
        ev({ sameOrigin: false, bytes: 0, url: beacon }),
      ],
      [],
    );
    expect(s.blocked).toHaveLength(1);
  });

  it("prefers the authoritative directive from a CSP violation over the guess", () => {
    const violation: BlockedEvent = {
      uri: "https://static.cloudflareinsights.com/beacon.min.js",
      directive: "script-src-elem",
      at: 1,
    };
    const s = classify(
      [ev({ sameOrigin: false, bytes: 0, kind: "other", url: "https://static.cloudflareinsights.com/beacon.min.js" })],
      [violation],
    );
    expect(s.blocked).toHaveLength(1);
    expect(s.blocked[0].directive).toBe("script-src-elem");
  });

  it("maps request kinds to the directive that would stop them", () => {
    const s = classify(
      [
        ev({ sameOrigin: false, url: "https://a.example/i.png", kind: "img" }),
        ev({ sameOrigin: false, url: "https://b.example/d", kind: "fetch" }),
      ],
      [],
    );
    const byHost = Object.fromEntries(s.blocked.map((b) => [new URL(b.uri).host, b.directive]));
    expect(byHost["a.example"]).toBe("img-src");
    expect(byHost["b.example"]).toBe("connect-src");
  });
});
