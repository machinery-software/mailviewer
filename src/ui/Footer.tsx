import type { ReactNode } from "react";
import { COMPANY_NAME, COMPANY_URL, SECURITY_URL, SOURCE_URL } from "../config";

/**
 * The footer shown on every page, in the same shape as the Mac purchase page's
 * and the Mac release host's (MAC-787): the company on the left, the standard
 * links on the right. `note` is the page-specific line underneath. `base` is
 * as in Topbar: "/" on a static page, where the app's routes are another
 * document.
 */
export function Footer({ note, base = "" }: { note?: ReactNode; base?: string }) {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span className="footer-company">
          © 2026{" "}
          <a href={COMPANY_URL} target="_blank" rel="noopener noreferrer">
            {COMPANY_NAME} LLC
          </a>
        </span>
        <nav className="footer-links" aria-label="Footer">
          <a href={`${base}#/privacy`}>Privacy</a>
          <a href={`${base}#/terms`}>Terms</a>
          <a href={SECURITY_URL} target="_blank" rel="noopener noreferrer">
            Security
          </a>
          <a href="/mac">Mac app</a>
          <a href={`${base}#/contact`}>Contact</a>
          <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
            Source
          </a>
        </nav>
        {note && <span className="footer-note">{note}</span>}
      </div>
    </footer>
  );
}
