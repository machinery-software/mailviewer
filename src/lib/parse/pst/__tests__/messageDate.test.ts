import { describe, expect, it } from "vitest";
import { dateFromHeaderBlock } from "../messaging.ts";

/**
 * Regression tests for a bug found only by running the parser against a REAL
 * .pst: every message came back with no date at all.
 *
 * The cause was that the date was read from PidTagClientSubmitTime and
 * PidTagMessageDeliveryTime alone. Mail that actually travelled over a transport
 * carries those. A surprising amount of what sits in a real .pst never did --
 * drafts, unsent mail, imported or library-generated messages -- and carries
 * neither. Those messages do still have their original transport headers, so the
 * sender's own `Date:` line is the right place to look next.
 */
describe("dateFromHeaderBlock", () => {
  it("reads the Date header out of a preserved header block", () => {
    const raw = [
      "X-Unsent: 1",
      "From: Alice Martin <alice.martin@example.com>",
      "Subject: Welcome",
      "Date: Wed, 1 Apr 2026 09:00:00 +0000",
      "Message-ID: <abc@example.com>",
    ].join("\r\n");

    expect(dateFromHeaderBlock(raw)?.toISOString()).toBe("2026-04-01T09:00:00.000Z");
  });

  it("honours the sender's timezone offset rather than assuming UTC", () => {
    const raw = "Date: Wed, 1 Apr 2026 09:00:00 -0500";
    expect(dateFromHeaderBlock(raw)?.toISOString()).toBe("2026-04-01T14:00:00.000Z");
  });

  it("handles a Date folded across a continuation line", () => {
    const raw = "Date: Wed, 1 Apr 2026\r\n 09:00:00 +0000\r\nSubject: x";
    expect(dateFromHeaderBlock(raw)?.toISOString()).toBe("2026-04-01T09:00:00.000Z");
  });

  it("matches the header case-insensitively and only at the start of a line", () => {
    expect(dateFromHeaderBlock("date: Wed, 1 Apr 2026 09:00:00 +0000")).toBeInstanceOf(Date);
    // "Date:" appearing inside another header's value must not be mistaken for it.
    expect(dateFromHeaderBlock("Subject: re: Date: tomorrow?")).toBeNull();
  });

  it("returns null rather than an Invalid Date when the value is garbage", () => {
    expect(dateFromHeaderBlock("Date: not a date at all")).toBeNull();
    expect(dateFromHeaderBlock("Subject: no date here")).toBeNull();
    expect(dateFromHeaderBlock(undefined)).toBeNull();
    expect(dateFromHeaderBlock("")).toBeNull();
  });
});
