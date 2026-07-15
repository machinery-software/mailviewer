import { useEffect, useState } from "react";
import Landing from "./ui/Landing";
import Privacy from "./ui/Privacy";
import Verify from "./ui/Verify";
import Viewer from "./ui/Viewer";
import { Logo } from "./ui/Logo";
import { SOURCE_URL } from "./config";

type Route = "home" | "privacy" | "verify" | "open";

function currentRoute(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  if (h === "privacy") return "privacy";
  if (h === "verify") return "verify";
  if (h === "open") return "open";
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
        </nav>
      </header>

      {route === "home" && <Landing />}
      {route === "privacy" && <Privacy />}
      {route === "verify" && <Verify />}
      {route === "open" && <Viewer />}
    </div>
  );
}
