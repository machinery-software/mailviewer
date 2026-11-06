import { useEffect, useState } from "react";
import { SALES_EMAIL, SECURITY_EMAIL, SUPPORT_EMAIL } from "../config";
import { Footer } from "./Footer";

/**
 * The #/contact page (MAC-787): the support address with a Copy button, the
 * way the Mac app's support sheet offers it ("Copy Address" and "Open in
 * Mail"), and the two other addresses that exist.
 *
 * Copying uses the clipboard API, which is not a network request; the page's
 * connect-src 'none' is untouched. Where the API is unavailable (an insecure
 * context, an old browser) the address is still plain text to select.
 */
function Address({ address, label }: { address: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const canCopy = typeof navigator !== "undefined" && !!navigator.clipboard;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className="contact-card">
      <div className="contact-label">{label}</div>
      <div className="contact-addr">{address}</div>
      <div className="contact-actions">
        {canCopy && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(address);
                setCopied(true);
              } catch {
                // Denied or unavailable: the address is right there to select.
              }
            }}
          >
            Copy Address
          </button>
        )}
        <a className="btn btn-sm" href={`mailto:${address}`}>
          Open in Mail
        </a>
        <span className="contact-status" role="status" aria-live="polite">
          {copied ? "Copied" : ""}
        </span>
      </div>
    </div>
  );
}

export default function Contact() {
  return (
    <>
      <section className="section section-narrow">
        <h2>Contact</h2>
        <h3>Email reaches a person</h3>
        <p>
          Copy the address, or open a new message to it in your mail app. There is no form here:
          this site cannot send anything, by design, so the message has to come from you.
        </p>

        <div className="contact-list">
          <Address label="Support, and anything else" address={SUPPORT_EMAIL} />
          <Address label="Licenses, invoices and purchase orders for the Mac app" address={SALES_EMAIL} />
          <Address label="Security vulnerabilities" address={SECURITY_EMAIL} />
        </div>

        <div className="prose-block">
          <h4>Please don't send us a mail file</h4>
          <p>
            Mail opened in this tool is often privileged, evidentiary, or both. Describe the problem
            instead; if a file is the only way to show it, say so and we will work out an approach
            that doesn't involve handing it over. The <a href="#/report">report page</a> builds a
            message with the build and browser details already filled in.
          </p>
          <h4>How quickly we answer</h4>
          <p>
            Within two business days for the free web app and Team licenses, and within one for
            Business and Site licenses. Security reports go to the front of the queue.
          </p>
        </div>
      </section>
      <Footer note="Reports reach a person, not a service." />
    </>
  );
}
