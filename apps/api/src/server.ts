import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import type { FastifyInstance } from "fastify";

import { buildApp, type BuildAppOptions } from "./app.js";
import { loadConfig, type Config } from "./config.js";

export type ServerDependencies = {
  loadConfig: () => Config;
  buildApp: (options: BuildAppOptions) => Promise<FastifyInstance>;
};

type SignalTarget = {
  exitCode?: string | number | null | undefined;
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

const defaults: ServerDependencies = { loadConfig, buildApp };

export async function start(dependencies: ServerDependencies = defaults): Promise<FastifyInstance> {
  const config = dependencies.loadConfig();
  const app = await dependencies.buildApp({
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

export function installShutdownHandlers(
  app: FastifyInstance,
  target: SignalTarget = process,
  log: (message: string) => void = console.error,
): () => void {
  let stopping = false;
  let installed = true;
  const remove = () => {
    if (!installed) return;
    installed = false;
    target.removeListener("SIGINT", close);
    target.removeListener("SIGTERM", close);
  };
  const close = () => {
    if (stopping) return;
    stopping = true;
    remove();
    void app.close().catch(() => log("Unable to stop API server"));
  };
  target.once("SIGINT", close);
  target.once("SIGTERM", close);
  return remove;
}

export async function run(
  dependencies: ServerDependencies = defaults,
  target: SignalTarget = process,
  log: (message: string) => void = console.error,
): Promise<{ app: FastifyInstance; removeShutdownHandlers: () => void }> {
  try {
    const app = await start(dependencies);
    return { app, removeShutdownHandlers: installShutdownHandlers(app, target) };
  } catch (error) {
    target.exitCode = 1;
    log("Unable to start API server");
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void run().catch(() => undefined);
}
