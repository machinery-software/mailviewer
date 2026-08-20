import { useMemo } from "react";
import { ISSUES_URL, SUPPORT_EMAIL } from "../config";
import { NO_ATTACHMENTS_NOTE, type ReportContext, reportDiagnostics, reportMailto } from "../lib/report";
import { Footer } from "./Footer";

function ua(): string {
  return typeof navigator === "undefined" ? "" : navigator.userAgent;
}

/**
 * The two ways to reach a human, plus the two things a user needs to be told
 * before they use either.
 *
 * Rendered inline in the failure path as well as on its own page, because the
 * moment a file refuses to open is exactly when someone wants to report it and
 * exactly when they should not go hunting through a nav bar for the link.
 */
export function ReportBlock({ context = {}, compact = false }: {
  context?: ReportContext;
  compact?: boolean;
}) {
  const agent = ua();
  const mailto = useMemo(() => reportMailto(context, agent), [context, agent]);
  const diagnostics = useMemo(() => reportDiagnostics(context, agent), [context, agent]);

  return (
    <div className={`report ${compact ? "report-compact" : ""}`}>
      <div className="report-actions">
        <a className="btn btn-primary" href={mailto}>
          Email {SUPPORT_EMAIL}
        </a>
        <a className="btn" href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
          Open a GitHub issue ↗
        </a>
      </div>

      <p className="report-warn">{NO_ATTACHMENTS_NOTE}</p>

      {!compact && (
        <>
          <p className="report-note">
            The email link comes prefilled with the block below and nothing else. It carries no
            filename, no addresses, no subject line and no part of your message — only which build
            you are on, which browser, and which file format was involved.
          </p>
          <pre className="report-diag">{diagnostics}</pre>
          <p className="report-note">
            Filing on GitHub is public. If the problem is easier to describe with details you would
            rather not post, use the email link.
          </p>
        </>
      )}
    </div>
  );
}

/** The `#/report` page. */
export default function Report() {
  return (
    <>
      <section className="section section-narrow">
        <h2>Support</h2>
        <h3>Report a problem</h3>
        <p>
          There is no crash reporter in this app, and there is not going to be one. Every page is
          served with <code>connect-src 'none'</code>, which tells your browser to refuse every
          outbound request the page could make — so it cannot quietly send us a stack trace any
          more than it can send us your mail. Nothing reaches us unless you write it and send it
          yourself.
        </p>
        <p>
          That is the trade, and it is the right way round: you get a viewer that physically
          cannot leak the file you opened, and we get bug reports only when someone takes the
          trouble to describe one. If you have hit something broken, that trouble is genuinely
          appreciated.
        </p>

        <ReportBlock />

        <div className="prose-block">
          <h4>What's worth including</h4>
          <p>
            What you were doing and what happened instead; the <em>format</em> of the file — .pst,
            .eml, .msg and so on — and roughly how big it was; and whether the same thing happens
            with a different file of that format, if you have one you don't mind testing. The
            diagnostic block above identifies the exact build you are running, which is usually
            the first thing we'd otherwise have to ask for.
          </p>

          <h4>Please don't send us the file</h4>
          <p>
            Mail opened in this tool is often privileged, evidentiary, or both. We would much
            rather debug from a description than be sent something we should never have been
            trusted with. If a specific file reproduces a bug and you cannot describe it any other
            way, say so in the report and we will work out an approach that doesn't involve
            handing it over.
          </p>

          <h4>Email or GitHub</h4>
          <p>
            Both reach a person. GitHub is public, so anything you write there is visible to
            anyone — useful for a reproducible rendering bug, less so if describing the problem
            means describing a matter you are working on. Use email when in doubt.
          </p>

          <h4>If you have found a way to make this page leak data</h4>
          <p>
            That is a security bug rather than an ordinary one, and it is the most valuable report
            we can receive. Email it rather than filing it publicly, and we will get to it before
            anything else.
          </p>
        </div>
      </section>
      <Footer note="Reports reach a person, not a service." />
    </>
  );
}
