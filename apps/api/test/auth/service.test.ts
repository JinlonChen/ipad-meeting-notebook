import { createHash } from "node:crypto";

import argon2 from "argon2";
import { describe, expect, test } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import {
  AuthRequiredError,
  AuthService,
  InvalidCredentialsError,
} from "../../src/auth/service.js";

const PASSWORD = "correct horse battery staple";
const NOW = new Date("2026-08-21T00:00:00.000Z");

async function service(options: { now?: () => Date; tokenBytes?: () => Buffer } = {}) {
  const db = openDatabase(":memory:");
  return {
    db,
    service: await AuthService.create({
      db,
      adminPassword: PASSWORD,
      now: options.now ?? (() => NOW),
      tokenBytes: options.tokenBytes ?? (() => Buffer.alloc(32, 7)),
    }),
  };
}

describe("AuthService", () => {
  test("rejects bad credentials and creates a hashed thirty-day session for correct credentials", async () => {
    const { db, service: auth } = await service();
    try {
      await expect(auth.login("wrong password that is long enough")).rejects.toBeInstanceOf(InvalidCredentialsError);
      const session = await auth.login(PASSWORD);
      const expectedToken = Buffer.alloc(32, 7).toString("base64url");
      expect(session).toEqual({ token: expectedToken, expiresAt: "2026-09-20T00:00:00.000Z" });
      const row = db.prepare("SELECT token_hash, user_id, created_at, expires_at FROM sessions").get() as Record<string, string>;
      expect(row).toEqual({
        token_hash: createHash("sha256").update(expectedToken).digest("hex"),
        user_id: "owner",
        created_at: NOW.toISOString(),
        expires_at: "2026-09-20T00:00:00.000Z",
      });
      expect(JSON.stringify(row)).not.toContain(expectedToken);
    } finally {
      db.close();
    }
  });

  test("authenticates only unexpired sessions and removes expired rows", async () => {
    let clock = NOW;
    const { db, service: auth } = await service({ now: () => clock });
    try {
      const { token } = await auth.login(PASSWORD);
      await expect(auth.authenticate("unknown")).rejects.toBeInstanceOf(AuthRequiredError);
      expect(await auth.authenticate(token)).toEqual({ id: "owner", sessionExpiresAt: "2026-09-20T00:00:00.000Z" });
      clock = new Date("2026-09-20T00:00:00.000Z");
      await expect(auth.authenticate(token)).rejects.toBeInstanceOf(AuthRequiredError);
      expect(db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  test("logs out idempotently and generates base64url tokens with 32-byte entropy by default", async () => {
    const { db, service: auth } = await service();
    try {
      const { token } = await auth.login(PASSWORD);
      await auth.logout(token);
      await auth.logout(token);
      await auth.logout(undefined);
      expect(db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }

    const defaultDb = openDatabase(":memory:");
    try {
      const auth = await AuthService.create({ db: defaultDb, adminPassword: PASSWORD });
      const { token } = await auth.login(PASSWORD);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
    } finally {
      defaultDb.close();
    }
  });

  test("uses a valid Argon2id admin-password hash and rejects malformed claimed hashes without exposing them", async () => {
    const db = openDatabase(":memory:");
    const prehashedPassword = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    const malformedPrefix = "$argon2id$not-a-real-hash";
    try {
      const prehashedAuth = await AuthService.create({ db, adminPassword: prehashedPassword });
      await expect(prehashedAuth.login(PASSWORD)).resolves.toMatchObject({ expiresAt: expect.any(String) });

      let caught: unknown;
      try {
        await AuthService.create({ db, adminPassword: malformedPrefix });
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toContain("Argon2id");
      expect(String(caught)).not.toContain(malformedPrefix);
    } finally {
      db.close();
    }
  });
});
