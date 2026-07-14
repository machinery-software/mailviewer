import { useEffect, useState } from "react";
import Landing from "./ui/Landing";
import Verify from "./ui/Verify";
import Viewer from "./ui/Viewer";
import { Logo } from "./ui/Logo";

type Route = "home" | "verify" | "open";

function currentRoute(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  if (h === "verify") return "verify";
  if (h === "open") return "open";
  return "home";
}

export default function App() {
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
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
          <a
            className="nav-link"
            href="#/open"
            aria-current={route === "open" ? "page" : undefined}
          >
            Open a file
          </a>
          <a
            className="nav-link"
            href="#/verify"
            aria-current={route === "verify" ? "page" : undefined}
          >
            Verify it yourself
          </a>
          <a
            className="nav-link"
            href="https://github.com/dminnema/mailviewer"
            target="_blank"
            rel="noopener noreferrer"
          >
            Source
          </a>
        </nav>
      </header>

      {route === "home" && <Landing />}
      {route === "verify" && <Verify />}
      {route === "open" && <Viewer />}
    </div>
  );
}
