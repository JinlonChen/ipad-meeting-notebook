import { describe, expect, test } from "vitest";

import { LoginInputSchema, SessionUserSchema } from "./auth";

describe("authentication contracts", () => {
  test("rejects passwords under 12 characters and accepts a 12-character password", () => {
    expect(() => LoginInputSchema.parse({ password: "short-pass" })).toThrow();
    expect(LoginInputSchema.parse({ password: "twelve-chars" })).toEqual({ password: "twelve-chars" });
  });

  test("accepts the owner session with valid expiry", () => {
    expect(SessionUserSchema.parse({
      id: "owner",
      sessionExpiresAt: "2025-01-01T10:00:00.000Z",
    })).toEqual({ id: "owner", sessionExpiresAt: "2025-01-01T10:00:00.000Z" });
  });

  test("rejects invalid session expiries and non-owner ids", () => {
    expect(() => SessionUserSchema.parse({ id: "owner", sessionExpiresAt: "invalid" })).toThrow();
    expect(() => SessionUserSchema.parse({ id: "admin", sessionExpiresAt: "2025-01-01T10:00:00.000Z" })).toThrow();
  });
});
