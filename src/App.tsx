import { useEffect, useState } from "react";
import Contact from "./ui/Contact";
import Landing from "./ui/Landing";
import Privacy from "./ui/Privacy";
import Report from "./ui/ReportProblem";
import Terms from "./ui/Terms";
import Verify from "./ui/Verify";
import Viewer from "./ui/Viewer";
import { Logo } from "./ui/Logo";
import { SOURCE_URL } from "./config";

type Route = "home" | "privacy" | "verify" | "open" | "report" | "terms" | "contact";

function currentRoute(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  if (h === "privacy") return "privacy";
  if (h === "verify") return "verify";
  if (h === "open") return "open";
  if (h === "report") return "report";
  if (h === "terms") return "terms";
  if (h === "contact") return "contact";
  return "home";
}

/**
 * One document title per route, so a tab, the history and a bookmark can tell
 * the privacy page from the viewer (MAC-787). The Mac purchase page at /mac is
 * its own document and names itself.
 */
export const TITLES: Record<Route, string> = {
  home: "Mailviewer",
  open: "Open a file · Mailviewer",
  privacy: "Privacy · Mailviewer",
  verify: "Verify · Mailviewer",
  report: "Report a problem · Mailviewer",
  terms: "Terms · Mailviewer",
  contact: "Contact · Mailviewer",
};

export default function App() {
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    const onHash = () => {
      setRoute(currentRoute());
      // A route change should start at the top, not wherever the last page was.
      window.scrollTo(0, 0);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    document.title = TITLES[route];
  }, [route]);

  const current = (r: Route) => (route === r ? "page" : undefined);

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          <Logo />
          Mailviewer
        </a>
        <nav className="nav" aria-label="Main">
          <a className="nav-link" href="#/open" aria-current={current("open")}>
            Open a file
          </a>
          {/* The Mac app's purchase page, public/mac/index.html (MAC-715, MAC-787). */}
          <a className="nav-link" href="/mac">
            Mac app
          </a>
          <a className="nav-link" href="#/privacy" aria-current={current("privacy")}>
            Privacy
          </a>
          <a className="nav-link" href="#/verify" aria-current={current("verify")}>
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
          <a className="nav-link" href="#/report" aria-current={current("report")}>
            Report a problem
          </a>
        </nav>
      </header>

      {route === "home" && <Landing />}
      {route === "privacy" && <Privacy />}
      {route === "verify" && <Verify />}
      {route === "open" && <Viewer />}
      {route === "report" && <Report />}
      {route === "terms" && <Terms />}
      {route === "contact" && <Contact />}
    </div>
  );
}
