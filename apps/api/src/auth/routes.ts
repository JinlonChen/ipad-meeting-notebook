import { LoginInputSchema } from "@meeting/contracts";
import type { FastifyInstance } from "fastify";

import { AuthRequiredError, type AuthService, InvalidCredentialsError } from "./service.js";

const SESSION_COOKIE = "meeting_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function registerAuthRoutes(app: FastifyInstance, options: { auth: AuthService; cookieSecure: boolean }): void {
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict" as const,
    path: "/",
    secure: options.cookieSecure,
  };

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = LoginInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: "INVALID_REQUEST" });
    try {
      const session = await options.auth.login(parsed.data.password);
      return reply
        .setCookie(SESSION_COOKIE, session.token, {
          ...cookieOptions,
          expires: new Date(session.expiresAt),
          maxAge: SESSION_MAX_AGE_SECONDS,
        })
        .code(204)
        .send();
    } catch (error) {
      if (error instanceof InvalidCredentialsError) return reply.code(401).send({ code: "INVALID_CREDENTIALS" });
      throw error;
    }
  });

  app.get("/api/auth/me", async (request, reply) => {
    try {
      return reply.send(await options.auth.authenticate(request.cookies[SESSION_COOKIE]));
    } catch (error) {
      if (error instanceof AuthRequiredError) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      throw error;
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await options.auth.logout(request.cookies[SESSION_COOKIE]);
    return reply.clearCookie(SESSION_COOKIE, cookieOptions).code(204).send();
  });
}
