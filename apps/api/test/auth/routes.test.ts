import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../src/app.js";
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

  test("closes its database handle when the app closes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meeting-auth-app-"));
    const databasePath = join(directory, "session.sqlite");
    const server = await buildApp({ databasePath, adminPassword: PASSWORD, cookieSecure: false });
    try {
      await server.close();
      const reopened = openDatabase(databasePath);
      reopened.close();
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
