import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

export async function start() {
  const config = loadConfig();
  const app = await buildApp({
    databasePath: config.databasePath,
    adminPassword: config.adminPassword,
    cookieSecure: config.cookieSecure,
  });
  try {
    await app.listen({ host: config.apiHost, port: config.apiPort });
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function run(): Promise<void> {
  const app = await start();
  const close = () => void app.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Unable to start API server");
    process.exitCode = 1;
  });
}
