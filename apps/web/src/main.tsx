import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { App } from "./app/App.js";
import "./app/styles.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

registerSW({ immediate: true });
