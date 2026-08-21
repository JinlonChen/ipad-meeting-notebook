import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";

import { registerAuthRoutes } from "./auth/routes.js";
import { AuthService } from "./auth/service.js";
import { openDatabase } from "./db/database.js";

export type BuildAppOptions = {
  databasePath: string;
  adminPassword: string;
  cookieSecure: boolean;
  now?: () => Date;
  tokenBytes?: () => Buffer;
};

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const db = openDatabase(options.databasePath);
  try {
    const app = Fastify({ logger: false });
    const auth = await AuthService.create({
      db,
      adminPassword: options.adminPassword,
      ...(options.now ? { now: options.now } : {}),
      ...(options.tokenBytes ? { tokenBytes: options.tokenBytes } : {}),
    });
    await app.register(cookie);
    registerAuthRoutes(app, { auth, cookieSecure: options.cookieSecure });
    app.addHook("onClose", async () => db.close());
    return app;
  } catch (error) {
    db.close();
    throw error;
  }
}
