import { describe, expect, test } from "vitest";
import type Database from "better-sqlite3";
import Fastify from "fastify";

import { buildApp } from "../../src/app.js";
import { Argon2VerificationGate } from "../../src/auth/service.js";
import { openDatabase } from "../../src/db/database.js";

const PASSWORD = "correct horse battery staple";
const NOW = new Date("2026-08-21T00:00:00.000Z");

function app(cookieSecure = false) {
  return buildApp({
    databasePath: ":memory:",
    adminPassword: PASSWORD,
    cookieSecure,
    now: () => NOW,
    tokenBytes: () => Buffer.alloc(32, 3),
  });
}

describe("auth routes", () => {
  test("sanitizes invalid and incorrect password responses", async () => {
    const server = await app();
    try {
      const invalid = await server.inject({ method: "POST", url: "/api/auth/login", payload: { password: "short" } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ code: "INVALID_REQUEST" });
      expect(invalid.body).not.toContain("short");

      const wrong = await server.inject({ method: "POST", url: "/api/auth/login", payload: { password: "wrong password long enough" } });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json()).toEqual({ code: "INVALID_CREDENTIALS" });
    } finally {
      await server.close();
    }
  });

  test("sets a strict private session cookie, authenticates it, and logs it out", async () => {
    const server = await app();
    try {
      const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { password: PASSWORD } });
      expect(login.statusCode).toBe(204);
      const cookie = login.headers["set-cookie"];
      expect(cookie).toContain("meeting_session=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Max-Age=2592000");
      expect(cookie).toContain("Expires=Sun, 20 Sep 2026 00:00:00 GMT");
      expect(cookie).not.toContain("Secure");
      expect(login.body).toBe("");

      const me = await server.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toEqual({ id: "owner", sessionExpiresAt: "2026-09-20T00:00:00.000Z" });

      const logout = await server.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
      expect(logout.statusCode).toBe(204);
      expect(logout.headers["set-cookie"]).toContain("meeting_session=;");
      expect(logout.headers["set-cookie"]).toContain("SameSite=Strict");
      expect(logout.headers["set-cookie"]).toContain("Path=/");
      expect((await server.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
      expect((await server.inject({ method: "GET", url: "/api/auth/me" })).json()).toEqual({ code: "AUTH_REQUIRED" });
    } finally {
      await server.close();
    }
  });

  test("emits Secure on session cookies when configured", async () => {
    const server = await app(true);
    try {
      const response = await server.inject({ method: "POST", url: "/api/auth/login", payload: { password: PASSWORD } });
      expect(response.headers["set-cookie"]).toContain("Secure");
    } finally {
      await server.close();
    }
  });

  test("limits valid login attempts per direct client IP, does not reset on success, and recovers after its window", async () => {
    let clock = NOW;
    const server = await buildApp({
      databasePath: ":memory:",
      adminPassword: PASSWORD,
      cookieSecure: false,
      now: () => clock,
      loginRateLimit: { maxAttempts: 2, windowMs: 60_000, now: () => clock },
    });
    const firstIp = "198.51.100.10";
    const wrongPassword = "wrong password long enough";
    try {
      const failed = await server.inject({ method: "POST", url: "/api/auth/login", remoteAddress: firstIp, payload: { password: wrongPassword } });
      expect(failed.statusCode).toBe(401);
      expect(failed.body).not.toContain(wrongPassword);

      const successful = await server.inject({ method: "POST", url: "/api/auth/login", remoteAddress: firstIp, payload: { password: PASSWORD } });
      expect(successful.statusCode).toBe(204);

      const limited = await server.inject({ method: "POST", url: "/api/auth/login", remoteAddress: firstIp, payload: { password: wrongPassword } });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toEqual({ code: "LOGIN_RATE_LIMITED" });
      expect(limited.headers["retry-after"]).toBe("60");
      expect(limited.body).not.toContain(wrongPassword);

      expect((await server.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.11", payload: { password: wrongPassword } })).statusCode).toBe(401);
      expect((await server.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.12", headers: { "x-forwarded-for": firstIp }, payload: { password: wrongPassword } })).statusCode).toBe(401);

      clock = new Date(clock.getTime() + 60_000);
      expect((await server.inject({ method: "POST", url: "/api/auth/login", remoteAddress: firstIp, payload: { password: wrongPassword } })).statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  test("does not trust rotating X-Forwarded-For values for one direct client", async () => {
    const server = await buildApp({
      databasePath: ":memory:",
      adminPassword: PASSWORD,
      cookieSecure: false,
      loginRateLimit: { maxAttempts: 2 },
    });
    const wrongPassword = "wrong password long enough";
    const remoteAddress = "198.51.100.15";
    try {
      expect((await server.inject({ method: "POST", url: "/api/auth/login", remoteAddress, headers: { "x-forwarded-for": "203.0.113.1" }, payload: { password: wrongPassword } })).statusCode).toBe(401);
      expect((await server.inject({ method: "POST", url: "/api/auth/login", remoteAddress, headers: { "x-forwarded-for": "203.0.113.2" }, payload: { password: wrongPassword } })).statusCode).toBe(401);
      expect((await server.inject({ method: "POST", url: "/api/auth/login", remoteAddress, headers: { "x-forwarded-for": "203.0.113.3" }, payload: { password: wrongPassword } })).statusCode).toBe(429);
    } finally {
      await server.close();
    }
  });

  test("rejects excess concurrent Argon2 verification without exceeding the configured process gate", async () => {
    const verificationGate = new Argon2VerificationGate(1);
    const server = await buildApp({
      databasePath: ":memory:",
      adminPassword: PASSWORD,
      cookieSecure: false,
      verificationGate,
      loginRateLimit: { maxAttempts: 5 },
    });
    try {
      const responses = await Promise.all(["198.51.100.21", "198.51.100.22", "198.51.100.23"].map((remoteAddress) => server.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress,
        payload: { password: PASSWORD },
      })));
      expect(responses.filter((response) => response.statusCode === 204)).toHaveLength(1);
      expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(2);
      expect(verificationGate.peak).toBe(1);
      expect(responses.every((response) => !response.body.includes(PASSWORD))).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("bounds tracked login IPs and evicts expired windows before admitting a new client", async () => {
    let clock = NOW;
    const server = await buildApp({
      databasePath: ":memory:",
      adminPassword: PASSWORD,
      cookieSecure: false,
      loginRateLimit: { maxAttempts: 5, maxTrackedIps: 2, windowMs: 60_000, now: () => clock },
    });
    const wrongPassword = "wrong password long enough";
    try {
      expect((await server.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.31", payload: { password: wrongPassword } })).statusCode).toBe(401);
      expect((await server.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.32", payload: { password: wrongPassword } })).statusCode).toBe(401);
      const full = await server.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.33", payload: { password: wrongPassword } });
      expect(full.statusCode).toBe(429);
      expect(full.headers["retry-after"]).toBe("60");

      clock = new Date(clock.getTime() + 60_000);
      expect((await server.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.33", payload: { password: wrongPassword } })).statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  test("closes its opened database handle when the app closes", async () => {
    const tracked = trackedDatabase();
    const server = await buildApp({
      databasePath: ":memory:",
      adminPassword: PASSWORD,
      cookieSecure: false,
      databaseFactory: () => tracked.database,
    });
    try {
      expect(tracked.closed()).toBe(false);
      await server.close();
      expect(tracked.closed()).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("closes an opened database when auth initialization fails", async () => {
    const tracked = trackedDatabase();
    await expect(buildApp({
      databasePath: ":memory:",
      adminPassword: PASSWORD,
      cookieSecure: false,
      databaseFactory: () => tracked.database,
      authServiceFactory: async () => {
        throw new Error("auth initialization failed");
      },
    })).rejects.toThrow("auth initialization failed");
    expect(tracked.closed()).toBe(true);
  });

  test("runs all Fastify close hooks when initialization fails after app creation", async () => {
    const app = Fastify();
    let hookRan = false;
    app.addHook("onClose", async () => { hookRan = true; });
    await expect(buildApp({
      databasePath: ":memory:",
      adminPassword: PASSWORD,
      cookieSecure: false,
      fastifyFactory: () => app,
      authServiceFactory: async () => { throw new Error("initialization failure"); },
    })).rejects.toThrow("initialization failure");
    expect(hookRan).toBe(true);
  });
});

function trackedDatabase(): { database: Database.Database; closed: () => boolean } {
  const database = openDatabase(":memory:");
  let closed = false;
  const proxy = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "close") return () => {
        closed = true;
        return target.close();
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: proxy, closed: () => closed };
}

const buildAppOptions = {
  databasePath: ":memory:",
  adminPassword: PASSWORD,
  cookieSecure: false,
  // @ts-expect-error Proxy trust is not configurable during the local deployment phase.
  trustProxy: true,
} satisfies import("../../src/app.js").BuildAppOptions;
void buildAppOptions;
