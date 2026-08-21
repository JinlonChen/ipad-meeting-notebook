import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";

export const PASSWORD = "correct horse battery staple";
export const NOW = new Date("2026-08-21T00:00:00.000Z");

export async function createTestApp(): Promise<FastifyInstance> {
  return buildApp({
    databasePath: ":memory:",
    adminPassword: PASSWORD,
    cookieSecure: false,
    now: () => NOW,
    tokenBytes: () => Buffer.alloc(32, 9),
  });
}

export async function login(server: FastifyInstance): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password: PASSWORD },
  });
  if (response.statusCode !== 204 || typeof response.headers["set-cookie"] !== "string") {
    throw new Error("Test login failed");
  }
  return response.headers["set-cookie"];
}
