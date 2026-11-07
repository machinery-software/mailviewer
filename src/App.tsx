import { useEffect, useState } from "react";
import Contact from "./ui/Contact";
import Landing from "./ui/Landing";
import Privacy from "./ui/Privacy";
import Report from "./ui/ReportProblem";
import Terms from "./ui/Terms";
import Verify from "./ui/Verify";
import Viewer from "./ui/Viewer";
import { type Route, Topbar } from "./ui/Topbar";
import { HOME } from "./site/pages";

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
  // The home page's title is the static page's (src/site/pages.ts), so the
  // tab says the same thing before and after the app boots.
  home: HOME.title,
  open: "Open a file · Mailviewer",
  privacy: "Privacy · Mailviewer",
  verify: "Verify · Mailviewer",
  report: "Report a problem · Mailviewer",
  terms: "Terms · Mailviewer",
  contact: "Contact · Mailviewer",
};

/**
 * `initialRoute` is for the build, which renders the home page to static HTML
 * (scripts/build-static.mjs) where there is no location to read.
 */
export default function App({ initialRoute }: { initialRoute?: Route }) {
  const [route, setRoute] = useState<Route>(() => initialRoute ?? currentRoute());

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

  return (
    <div className="shell">
      <Topbar current={route} />

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
