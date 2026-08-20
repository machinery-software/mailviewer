import { useEffect, useState } from "react";
import Landing from "./ui/Landing";
import Privacy from "./ui/Privacy";
import Report from "./ui/ReportProblem";
import Verify from "./ui/Verify";
import Viewer from "./ui/Viewer";
import { Logo } from "./ui/Logo";
import { SOURCE_URL } from "./config";

type Route = "home" | "privacy" | "verify" | "open" | "report";

function currentRoute(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  if (h === "privacy") return "privacy";
  if (h === "verify") return "verify";
  if (h === "open") return "open";
  if (h === "report") return "report";
  return "home";
}

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

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          <Logo />
          mailviewer
        </a>
        <nav className="nav">
          <a className="nav-link" href="#/open" aria-current={route === "open" ? "page" : undefined}>
            Open a file
          </a>
          <a
            className="nav-link"
            href="#/privacy"
            aria-current={route === "privacy" ? "page" : undefined}
          >
            Privacy
          </a>
          <a
            className="nav-link"
            href="#/verify"
            aria-current={route === "verify" ? "page" : undefined}
          >
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
          <a
            className="nav-link"
            href="#/report"
            aria-current={route === "report" ? "page" : undefined}
          >
            Report a problem
          </a>
        </nav>
      </header>

      {route === "home" && <Landing />}
      {route === "privacy" && <Privacy />}
      {route === "verify" && <Verify />}
      {route === "open" && <Viewer />}
      {route === "report" && <Report />}
    </div>
  );
}
