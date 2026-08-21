import { describe, expect, test } from "vitest";

import { createTestApp, login } from "../helpers.js";

const FOLDER_ONE = "00000000-0000-4000-8000-000000000201";
const FOLDER_TWO = "00000000-0000-4000-8000-000000000202";
const FOLDER_THREE = "00000000-0000-4000-8000-000000000203";
const MEETING_ONE = "00000000-0000-4000-8000-000000000204";
const CREATED_AT = "2026-08-20T10:00:00.000Z";

describe("folder routes", () => {
  test("requires an authenticated session for every folder endpoint", async () => {
    const server = await createTestApp();
    try {
      const requests = [
        { method: "GET", url: "/api/folders" },
        { method: "POST", url: "/api/folders", payload: {} },
        { method: "PATCH", url: `/api/folders/${FOLDER_ONE}`, payload: {} },
        { method: "DELETE", url: `/api/folders/${FOLDER_ONE}` },
      ] as const;
      for (const request of requests) {
        const response = await server.inject(request);
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ code: "AUTH_REQUIRED" });
      }
    } finally {
      await server.close();
    }
  });

  test("creates, retries, updates, and rejects name or client-id conflicts", async () => {
    const server = await createTestApp();
    try {
      const cookie = await login(server);
      const input = { id: FOLDER_ONE, name: "  Projects  ", clientCreatedAt: CREATED_AT };
      const created = await server.inject({ method: "POST", url: "/api/folders", headers: { cookie }, payload: input });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ id: FOLDER_ONE, name: "Projects", syncVersion: 0 });
      expect((await server.inject({ method: "POST", url: "/api/folders", headers: { cookie }, payload: input })).statusCode).toBe(200);
      expect((await server.inject({ method: "POST", url: "/api/folders", headers: { cookie }, payload: { ...input, name: "Other" } })).json()).toEqual({ code: "FOLDER_CONFLICT" });
      const duplicate = await server.inject({ method: "POST", url: "/api/folders", headers: { cookie }, payload: { id: FOLDER_TWO, name: "projects", clientCreatedAt: CREATED_AT } });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toEqual({ code: "FOLDER_NAME_CONFLICT" });

      const updated = await server.inject({ method: "PATCH", url: `/api/folders/${FOLDER_ONE}`, headers: { cookie }, payload: { name: " Archive " } });
      expect(updated.json()).toMatchObject({ name: "Archive", syncVersion: 1 });
    } finally {
      await server.close();
    }
  });

  test("deleting a folder leaves linked meetings unfiled and validates failures without internal details", async () => {
    const server = await createTestApp();
    try {
      const cookie = await login(server);
      await server.inject({ method: "POST", url: "/api/folders", headers: { cookie }, payload: { id: FOLDER_ONE, name: "Work", clientCreatedAt: CREATED_AT } });
      await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload: { id: MEETING_ONE, title: "Standup", folderId: FOLDER_ONE, clientCreatedAt: CREATED_AT } });

      expect((await server.inject({ method: "DELETE", url: `/api/folders/${FOLDER_ONE}`, headers: { cookie } })).statusCode).toBe(204);
      expect((await server.inject({ method: "GET", url: "/api/meetings", headers: { cookie } })).json()[0]).toMatchObject({ folderId: null, syncVersion: 1 });
      const missing = await server.inject({ method: "DELETE", url: `/api/folders/${FOLDER_THREE}`, headers: { cookie } });
      const invalid = await server.inject({ method: "PATCH", url: "/api/folders/not-a-uuid", headers: { cookie }, payload: { name: "Name", extra: true } });
      expect(missing).toMatchObject({ statusCode: 404, body: '{"code":"FOLDER_NOT_FOUND"}' });
      expect(invalid).toMatchObject({ statusCode: 400, body: '{"code":"INVALID_REQUEST"}' });
      expect(invalid.body).not.toContain("SQLITE");
    } finally {
      await server.close();
    }
  });
});
