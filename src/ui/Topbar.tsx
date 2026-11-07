import { SOURCE_URL } from "../config";
import { Logo } from "./Logo";

export type Route = "home" | "privacy" | "verify" | "open" | "report" | "terms" | "contact";

/**
 * The site header, on every route and on the static pages.
 *
 * `base` is "" inside the app, where every route is a hash on the same
 * document, and "/" on the static pages built from it (the guides, the
 * not-found page): those are other documents, so "#/open" has to be "/#/open".
 */
export function Topbar({ current, base = "" }: { current?: Route; base?: string }) {
  const aria = (r: Route) => (current === r ? "page" : undefined);
  return (
    <header className="topbar">
      <a className="brand" href={`${base}#/`}>
        <Logo />
        Mailviewer
      </a>
      <nav className="nav" aria-label="Main">
        <a className="nav-link" href={`${base}#/open`} aria-current={aria("open")}>
          Open a file
        </a>
        {/* The Mac app's purchase page, public/mac/index.html (MAC-715, MAC-787). */}
        <a className="nav-link" href="/mac">
          Mac app
        </a>
        <a className="nav-link" href={`${base}#/privacy`} aria-current={aria("privacy")}>
          Privacy
        </a>
        <a className="nav-link" href={`${base}#/verify`} aria-current={aria("verify")}>
          Verify
        </a>
        <a className="nav-link" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
          Source
        </a>
        {/*
          Reachable from every route, including the viewer, which has no
          footer -- someone whose file just refused to open is looking at the
          viewer, and that is precisely when they need this link.
        */}
        <a className="nav-link" href={`${base}#/report`} aria-current={aria("report")}>
          Report a problem
        </a>
      </nav>
    </header>
  );
}
