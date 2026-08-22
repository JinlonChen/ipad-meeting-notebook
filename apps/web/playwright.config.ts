import { existsSync } from "node:fs";

import { chromium, defineConfig } from "@playwright/test";

const browserChannel = existsSync(chromium.executablePath()) ? undefined : "chrome";

export default defineConfig({
  testDir: "./e2e",
  use: {
    channel: browserChannel,
  },
  projects: [
    {
      name: "root",
      testIgnore: /pages-base-path\.spec\.ts/,
      use: { baseURL: "http://127.0.0.1:4173" },
    },
    {
      name: "github-pages",
      testMatch: /pages-base-path\.spec\.ts/,
      use: { baseURL: "http://127.0.0.1:4174/ipad-meeting-notebook/" },
    },
  ],
  webServer: [
    {
      command: "npm run build && npm exec vite -- preview --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      env: {
        E2E_BUILD_OUT_DIR: "dist/e2e-root",
        VITE_SUPABASE_URL: "http://127.0.0.1:54321",
        VITE_SUPABASE_ANON_KEY: "e2e-public-anon-key",
      },
    },
    {
      command: "npm run build && npm exec vite -- preview --host 127.0.0.1 --port 4174",
      url: "http://127.0.0.1:4174/ipad-meeting-notebook/",
      reuseExistingServer: false,
      env: {
        E2E_BUILD_OUT_DIR: "dist/e2e-pages",
        VITE_BASE_PATH: "/ipad-meeting-notebook/",
        VITE_SUPABASE_URL: "http://127.0.0.1:54321",
        VITE_SUPABASE_ANON_KEY: "e2e-public-anon-key",
      },
    },
  ],
});
