import type { ReactNode } from "react";
import { COMPANY_NAME, COMPANY_URL, SOURCE_URL } from "../config";

/**
 * The footer shown on every page. `note` is the page-specific line on the left;
 * the maintainer attribution and standard links are the same everywhere so the
 * "free tool from Machinery Software" message and the link home never drift.
 */
export function Footer({ note }: { note?: ReactNode }) {
  return (
    <footer className="footer">
      <div className="footer-inner">
        {note && <span className="footer-note">{note}</span>}
        <nav className="footer-links">
          <a href="#/privacy">Privacy</a>
          <a href="#/verify">Verify</a>
          <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
            Source
          </a>
        </nav>
        <span className="footer-attr">
          A free tool from{" "}
          <a href={COMPANY_URL} target="_blank" rel="noopener noreferrer">
            {COMPANY_NAME} ↗
          </a>
        </span>
      </div>
    </footer>
  );
}
