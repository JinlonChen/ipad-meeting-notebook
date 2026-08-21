import { LoginInputSchema } from "@meeting/contracts";
import type { FastifyInstance } from "fastify";

import {
  AuthRequiredError,
  type AuthService,
  InvalidCredentialsError,
  LoginVerificationCapacityError,
} from "./service.js";

const SESSION_COOKIE = "meeting_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export type LoginRateLimitOptions = {
  maxAttempts?: number;
  maxTrackedIps?: number;
  windowMs?: number;
  now?: () => Date;
};

type LoginAttempt = { count: number; startedAt: number };

class LoginRateLimiter {
  private readonly attempts = new Map<string, LoginAttempt>();
  private readonly maxAttempts: number;
  private readonly maxTrackedIps: number;
  private readonly windowMs: number;
  private readonly now: () => Date;

  constructor(options: LoginRateLimitOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.maxTrackedIps = options.maxTrackedIps ?? 10_000;
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) throw new Error("Login attempt limit must be a positive integer");
    if (!Number.isInteger(this.maxTrackedIps) || this.maxTrackedIps < 1) throw new Error("Tracked login IP limit must be a positive integer");
    if (!Number.isInteger(this.windowMs) || this.windowMs < 1) throw new Error("Login rate-limit window must be a positive integer");
  }

  take(ip: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const now = this.now().getTime();
    const attempt = this.attempts.get(ip);
    if (!attempt || now >= attempt.startedAt + this.windowMs) {
      this.pruneExpired(now);
      if (this.attempts.size >= this.maxTrackedIps) {
        return { allowed: false, retryAfterSeconds: this.retryAfterCapacity(now) };
      }
      this.attempts.set(ip, { count: 1, startedAt: now });
      return { allowed: true };
    }
    if (attempt.count >= this.maxAttempts) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((attempt.startedAt + this.windowMs - now) / 1_000)) };
    }
    attempt.count += 1;
    return { allowed: true };
  }

  private pruneExpired(now: number): void {
    for (const [ip, attempt] of this.attempts) {
      if (now >= attempt.startedAt + this.windowMs) this.attempts.delete(ip);
    }
  }

  private retryAfterCapacity(now: number): number {
    const earliestExpiry = Math.min(...[...this.attempts.values()].map((attempt) => attempt.startedAt + this.windowMs));
    return Math.max(1, Math.ceil((earliestExpiry - now) / 1_000));
  }
}

export function registerAuthRoutes(app: FastifyInstance, options: {
  auth: AuthService;
  cookieSecure: boolean;
  loginRateLimit?: LoginRateLimitOptions;
}): void {
  const rateLimiter = new LoginRateLimiter(options.loginRateLimit);
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict" as const,
    path: "/",
    secure: options.cookieSecure,
  };

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = LoginInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: "INVALID_REQUEST" });
    const rateLimit = rateLimiter.take(request.ip);
    if (!rateLimit.allowed) {
      return reply.header("Retry-After", String(rateLimit.retryAfterSeconds)).code(429).send({ code: "LOGIN_RATE_LIMITED" });
    }
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
      if (error instanceof LoginVerificationCapacityError) {
        return reply.header("Retry-After", "1").code(429).send({ code: "LOGIN_RATE_LIMITED" });
      }
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
