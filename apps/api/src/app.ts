import cookie from "@fastify/cookie";
import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";

import { registerAuthRoutes, type LoginRateLimitOptions } from "./auth/routes.js";
import { Argon2VerificationGate, AuthService, type AuthServiceOptions } from "./auth/service.js";
import { openDatabase } from "./db/database.js";

export type BuildAppOptions = {
  databasePath: string;
  adminPassword: string;
  cookieSecure: boolean;
  now?: () => Date;
  tokenBytes?: () => Buffer;
  databaseFactory?: (path: string) => Database.Database;
  authServiceFactory?: (options: AuthServiceOptions) => Promise<AuthService>;
  loginRateLimit?: LoginRateLimitOptions;
  verificationGate?: Argon2VerificationGate;
};

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const db = (options.databaseFactory ?? openDatabase)(options.databasePath);
  try {
    const app = Fastify({ logger: false });
    const auth = await (options.authServiceFactory ?? AuthService.create)({
      db,
      adminPassword: options.adminPassword,
      ...(options.now ? { now: options.now } : {}),
      ...(options.tokenBytes ? { tokenBytes: options.tokenBytes } : {}),
      ...(options.verificationGate ? { verificationGate: options.verificationGate } : {}),
    });
    await app.register(cookie);
    registerAuthRoutes(app, { auth, cookieSecure: options.cookieSecure, ...(options.loginRateLimit ? { loginRateLimit: options.loginRateLimit } : {}) });
    app.addHook("onClose", async () => db.close());
    return app;
  } catch (error) {
    db.close();
    throw error;
  }
}
