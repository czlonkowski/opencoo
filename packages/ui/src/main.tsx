/**
 * SPA entrypoint.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./lib/i18n.js";

import { App } from "./App.js";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Management UI: #root element missing from index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
