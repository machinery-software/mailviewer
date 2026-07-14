import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { startNetGuard } from "./lib/netguard";
import "./styles.css";

// Start watching our own network activity before anything else runs, so the
// monitor can account for every request the page makes -- including the ones
// that load the app itself. Anything we did after this point that touched the
// network would show up in the user's face.
startNetGuard();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
