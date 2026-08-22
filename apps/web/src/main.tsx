import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { App } from "./app/App.js";
import { supabaseAuthApi } from "./auth/api.js";
import { MeetingCatalogSupabaseApi } from "./meetings/api.js";
import { MeetingCatalogRepository } from "./meetings/repository.js";
import { CatalogSync } from "./meetings/sync.js";
import { createMeetingSupabaseClient, readSupabaseConfig, SupabaseConfigurationError } from "./supabase/client.js";
import "./app/styles.css";

function composeRuntimeApp() {
  try {
    const config = readSupabaseConfig(import.meta.env);
    const client = createMeetingSupabaseClient(config);
    const repository = new MeetingCatalogRepository();
    const auth = supabaseAuthApi(client);
    const catalog = new MeetingCatalogSupabaseApi(client);
    const synchronizer = new CatalogSync(repository, catalog);
    return { repository, auth, catalog, synchronizer };
  } catch (error) {
    // Configuration errors are intentionally reduced to a fixed UI state.
    if (error instanceof SupabaseConfigurationError) return { configurationError: true as const };
    return { configurationError: true as const };
  }
}

const appProps = composeRuntimeApp();
createRoot(document.getElementById("root")!).render(<StrictMode><App {...appProps} /></StrictMode>);

registerSW({ immediate: true });
