import { existsSync } from "node:fs";

import { chromium, defineConfig } from "@playwright/test";

const browserChannel = existsSync(chromium.executablePath()) ? undefined : "chrome";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: browserChannel,
  },
  webServer: {
    command: "npm run build && npm exec vite -- preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
