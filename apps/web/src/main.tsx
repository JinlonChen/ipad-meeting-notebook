import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { App } from "./app/App.js";
import { composeProductionApp } from "./app/runtime.js";
import "./app/styles.css";

const appProps = composeProductionApp(import.meta.env);
createRoot(document.getElementById("root")!).render(<StrictMode><App {...appProps} /></StrictMode>);

registerSW({ immediate: true });
