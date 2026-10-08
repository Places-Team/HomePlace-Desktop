import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/design.css";
import "./styles/usability.css";
import "./styles/theme-polish.css";
import "./styles/windows-quick-share.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
