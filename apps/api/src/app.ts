import cookie from "@fastify/cookie";
import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance, type onRequestHookHandler } from "fastify";
import { ZodError } from "zod";

import { registerAuthRoutes, type LoginRateLimitOptions } from "./auth/routes.js";
import { Argon2VerificationGate, AuthRequiredError, AuthService, type AuthServiceOptions } from "./auth/service.js";
import { openDatabase } from "./db/database.js";
import { registerFolderRoutes } from "./folders/routes.js";
import { SqliteFolderRepository } from "./folders/repository.js";
import { registerMeetingRoutes } from "./meetings/routes.js";
import { SqliteMeetingRepository } from "./meetings/repository.js";

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
  fastifyFactory?: () => FastifyInstance;
};

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const db = (options.databaseFactory ?? openDatabase)(options.databasePath);
  let app: FastifyInstance | undefined;
  try {
    app = (options.fastifyFactory ?? (() => Fastify({ logger: false })))();
    app.addHook("onClose", async () => db.close());
    const auth = await (options.authServiceFactory ?? AuthService.create)({
      db,
      adminPassword: options.adminPassword,
      ...(options.now ? { now: options.now } : {}),
      ...(options.tokenBytes ? { tokenBytes: options.tokenBytes } : {}),
      ...(options.verificationGate ? { verificationGate: options.verificationGate } : {}),
    });
    await app.register(cookie);
    registerAuthRoutes(app, { auth, cookieSecure: options.cookieSecure, ...(options.loginRateLimit ? { loginRateLimit: options.loginRateLimit } : {}) });
    const requireAuth: onRequestHookHandler = async (request, reply) => {
      try {
        await auth.authenticate(request.cookies.meeting_session);
      } catch (error) {
        if (error instanceof AuthRequiredError) return reply.code(401).send({ code: "AUTH_REQUIRED" });
        throw error;
      }
    };
    const routeOptions = { onRequest: requireAuth, ...(options.now ? { now: options.now } : {}) };
    registerMeetingRoutes(app, { meetings: new SqliteMeetingRepository(db), ...routeOptions });
    registerFolderRoutes(app, { folders: new SqliteFolderRepository(db), ...routeOptions });
    app.setErrorHandler((error, _request, reply) => {
      const isBadRequest = error instanceof ZodError || (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 400);
      return reply.code(isBadRequest ? 400 : 500).send({ code: isBadRequest ? "INVALID_REQUEST" : "INTERNAL_ERROR" });
    });
    await app.ready();
    return app;
  } catch (error) {
    if (app) await app.close();
    else db.close();
    throw error;
  }
}
