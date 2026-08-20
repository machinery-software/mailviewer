import { describe, expect, it } from "vitest";
import type { Message } from "../model";
import {
  NO_ATTACHMENTS_NOTE,
  describePlatform,
  reportDiagnostics,
  reportMailto,
} from "../report";
import { BUILD, SUPPORT_EMAIL } from "../../config";

/**
 * A message built entirely out of strings that must never leave the browser.
 * Every field is a distinct marker so a leak names the field that leaked.
 */
const SECRETS = {
  subject: "SECRET-SUBJECT-settlement-figure",
  fromName: "SECRET-FROM-NAME-Jane Privileged",
  fromEmail: "SECRET-FROM-jane@opposing-counsel.example",
  toEmail: "SECRET-TO-client@insurer.example",
  ccEmail: "SECRET-CC-paralegal@firm.example",
  bodyText: "SECRET-BODY-the number we will accept is 1.2m",
  bodyHtml: "<p>SECRET-HTML-do not disclose</p>",
  filename: "SECRET-FILENAME-Doe-v-Insurer.pst",
  attachment: "SECRET-ATTACHMENT-medical-report.pdf",
  messageId: "SECRET-MESSAGEID-<abc@opposing-counsel.example>",
  header: "SECRET-HEADER-Received: from mx.opposing-counsel.example",
};

function poisonedMessage(): Message {
  return {
    id: "m1",
    format: "pst",
    subject: SECRETS.subject,
    from: { name: SECRETS.fromName, email: SECRETS.fromEmail },
    replyTo: [],
    to: [{ email: SECRETS.toEmail }],
    cc: [{ email: SECRETS.ccEmail }],
    bcc: [],
    date: new Date("2025-06-03T13:14:00Z"),
    messageId: SECRETS.messageId,
    references: [],
    html: SECRETS.bodyHtml,
    text: SECRETS.bodyText,
    attachments: [
      {
        id: "a1",
        filename: SECRETS.attachment,
        mimeType: "application/pdf",
        size: 1234,
        inline: false,
        content: new Uint8Array([1, 2, 3]),
      },
    ],
    headers: [{ key: "Received", value: SECRETS.header }],
    folderPath: ["Inbox", SECRETS.filename],
    flags: { hasAttachments: true },
  };
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

describe("reportMailto", () => {
  it("addresses the support mailbox and prefills a subject", () => {
    const href = reportMailto({}, UA);
    expect(href.startsWith(`mailto:${SUPPORT_EMAIL}?`)).toBe(true);
    expect(decodeURIComponent(href)).toContain("Mailviewer: bug report");
  });

  it("says so when the report is about a file that would not open", () => {
    expect(decodeURIComponent(reportMailto({ failed: true }, UA)))
      .toContain("a file failed to open");
  });

  it("carries the build identifier, so a report can be tied to a bundle", () => {
    const body = decodeURIComponent(reportMailto({}, UA));
    expect(body).toContain(BUILD.version);
    expect(body).toContain(BUILD.commit);
  });

  it("describes the browser and OS rather than the raw user-agent", () => {
    const body = decodeURIComponent(reportMailto({}, UA));
    expect(body).toContain("Chrome 141 on macOS");
    expect(body).not.toContain("AppleWebKit/537.36");
  });

  it("names the format that failed, which is a keyword and not file content", () => {
    expect(decodeURIComponent(reportMailto({ format: "pst" }, UA)))
      .toContain("File format: pst");
    expect(decodeURIComponent(reportMailto({}, UA)))
      .toContain("File format: not known");
  });

  it("tells the user not to attach the mail file", () => {
    expect(decodeURIComponent(reportMailto({ failed: true }, UA)))
      .toContain(NO_ATTACHMENTS_NOTE);
  });

  // ---------------------------------------------------------------------------
  // The rule this whole module exists to keep. Users of a forensic mail viewer
  // are often holding privileged material; a single leaked filename or subject
  // in a prefilled mail body would be a serious breach of what the product
  // promises. The builder is never given a Message, so this asserts the
  // consequence of that design rather than trusting it.
  // ---------------------------------------------------------------------------
  it("leaks nothing derived from the loaded file", () => {
    const message = poisonedMessage();
    const href = reportMailto({ format: message.format, failed: true }, UA);
    const decoded = decodeURIComponent(href);

    for (const [field, secret] of Object.entries(SECRETS)) {
      expect(href, `raw mailto leaked ${field}`).not.toContain(secret);
      expect(decoded, `decoded mailto leaked ${field}`).not.toContain(secret);
      // Encoding is not a defence; check the escaped form has not slipped in.
      expect(href, `encoded mailto leaked ${field}`).not.toContain(encodeURIComponent(secret));
    }

    // And nothing recognisable from the message even in fragments: no address
    // local-parts, no attachment name, no date of the message itself.
    for (const fragment of [
      "opposing-counsel",
      "insurer.example",
      "medical-report",
      "Doe-v-Insurer",
      "settlement",
      "1.2m",
    ]) {
      expect(decoded.toLowerCase(), `mailto leaked "${fragment}"`)
        .not.toContain(fragment.toLowerCase());
    }
  });

  it("still leaks nothing when the message fields are the diagnostic labels", () => {
    // A subject line that happens to read like our own diagnostics must not be
    // able to smuggle itself through by looking like part of the template.
    const href = reportMailto({ format: "eml" }, UA);
    expect(decodeURIComponent(href).match(/File format:/g)).toHaveLength(1);
  });
});

describe("describePlatform", () => {
  const cases: Array<[string, string]> = [
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "Chrome 141 on Windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0",
      "Firefox 131 on macOS",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
      "Safari 18 on macOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      "Edge 141 on Windows",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/115.0.0.0",
      "Opera 115 on Linux",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
      "Chrome 141 on Android",
    ],
  ];

  for (const [ua, expected] of cases) {
    it(`reads ${expected}`, () => expect(describePlatform(ua)).toBe(expected));
  }

  it("falls back to the raw string when the browser is not recognised", () => {
    expect(describePlatform("SomeNewBrowser/1.0")).toBe("SomeNewBrowser/1.0");
  });

  it("handles an empty user-agent without throwing", () => {
    expect(describePlatform("")).toBe("unknown");
  });

  it("truncates an absurdly long unknown user-agent", () => {
    expect(describePlatform("x".repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

describe("reportDiagnostics", () => {
  it("is three lines and mentions no message data", () => {
    const lines = reportDiagnostics({ format: "msg" }, UA).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Build: /);
    expect(lines[1]).toBe("Browser: Chrome 141 on macOS");
    expect(lines[2]).toBe("File format: msg");
  });
});
