import { describe, expect, test } from "vitest";

import { buildApp } from "../../src/app.js";
import { openDatabase } from "../../src/db/database.js";
import { createTestApp, login, NOW, PASSWORD } from "../helpers.js";

const MEETING_ONE = "00000000-0000-4000-8000-000000000101";
const MEETING_TWO = "00000000-0000-4000-8000-000000000102";
const FOLDER_ONE = "00000000-0000-4000-8000-000000000103";
const UNKNOWN_FOLDER = "00000000-0000-4000-8000-000000000199";
const CREATED_AT = "2026-08-20T10:00:00.000Z";

describe("meeting routes", () => {
  test("requires an authenticated session for every meeting endpoint", async () => {
    const server = await createTestApp();
    try {
      const requests = [
        { method: "GET", url: "/api/meetings" },
        { method: "POST", url: "/api/meetings", payload: {} },
        { method: "PATCH", url: `/api/meetings/${MEETING_ONE}`, payload: {} },
        { method: "DELETE", url: `/api/meetings/${MEETING_ONE}` },
        { method: "POST", url: `/api/meetings/${MEETING_ONE}/restore` },
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

  test("authenticates before JSON parsing and rejects unexpected input on no-input endpoints", async () => {
    const server = await createTestApp();
    try {
      const malformed = { method: "POST" as const, url: "/api/meetings", payload: "{", headers: { "content-type": "application/json" } };
      expect(await server.inject(malformed)).toMatchObject({ statusCode: 401, body: '{"code":"AUTH_REQUIRED"}' });
      const cookie = await login(server);
      expect(await server.inject({ ...malformed, headers: { ...malformed.headers, cookie } })).toMatchObject({ statusCode: 400, body: '{"code":"INVALID_REQUEST"}' });

      for (const request of [
        { method: "GET" as const, url: "/api/meetings?extra=true" },
        { method: "GET" as const, url: "/api/meetings", payload: { extra: true }, headers: { "content-type": "application/json", "content-length": "14" } },
        { method: "DELETE" as const, url: `/api/meetings/${MEETING_ONE}?extra=true` },
        { method: "DELETE" as const, url: `/api/meetings/${MEETING_ONE}`, payload: { extra: true }, headers: { "content-type": "application/json", "content-length": "14" } },
        { method: "POST" as const, url: `/api/meetings/${MEETING_ONE}/restore?extra=true` },
        { method: "POST" as const, url: `/api/meetings/${MEETING_ONE}/restore`, payload: { extra: true }, headers: { "content-type": "application/json", "content-length": "14" } },
      ]) {
        const response = await server.inject({ ...request, headers: { ...request.headers, cookie } });
        expect(response).toMatchObject({ statusCode: 400, body: '{"code":"INVALID_REQUEST"}' });
      }
    } finally {
      await server.close();
    }
  });

  test("creates idempotently, returns conflicts, and validates its response contract", async () => {
    const server = await createTestApp();
    try {
      const cookie = await login(server);
      const input = { id: MEETING_ONE, title: "Plan %_ review", folderId: null, clientCreatedAt: CREATED_AT };
      const created = await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload: input });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ id: input.id, title: input.title, folderId: input.folderId, createdAt: input.clientCreatedAt, status: "draft", syncVersion: 0 });

      const retried = await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload: input });
      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toEqual(created.json());

      const conflict = await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload: { ...input, title: "Other" } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({ code: "MEETING_CONFLICT" });

      expect((await server.inject({ method: "POST", url: "/api/meetings?extra=true", headers: { cookie }, payload: input })).json()).toEqual({ code: "INVALID_REQUEST" });
      expect((await server.inject({ method: "PATCH", url: `/api/meetings/${MEETING_ONE}?extra=true`, headers: { cookie }, payload: { title: "Ignored" } })).json()).toEqual({ code: "INVALID_REQUEST" });

      const updated = await server.inject({ method: "PATCH", url: `/api/meetings/${MEETING_ONE}`, headers: { cookie }, payload: { title: "Renamed", expectedSyncVersion: 0 } });
      expect(updated.statusCode).toBe(200);
      const replay = await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload: input });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ title: "Renamed" });
      expect((await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload: { ...input, clientCreatedAt: "2026-08-20T10:00:01.000Z" } })).json()).toEqual({ code: "MEETING_CONFLICT" });
    } finally {
      await server.close();
    }
  });

  test("returns stable client errors for media parsing but treats corrupted repository output as internal", async () => {
    const database = openDatabase(":memory:");
    const server = await buildApp({ databasePath: ":memory:", adminPassword: PASSWORD, cookieSecure: false, now: () => NOW, databaseFactory: () => database });
    try {
      const cookie = await login(server);
      const unsupported = await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie, "content-type": "application/xml" }, payload: "not json" });
      expect(unsupported).toMatchObject({ statusCode: 415, body: '{"code":"INVALID_REQUEST"}' });
      await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload: { id: MEETING_ONE, title: "Valid", folderId: null, clientCreatedAt: CREATED_AT } });
      database.pragma("ignore_check_constraints = ON");
      database.prepare("UPDATE meetings SET status = 'invalid' WHERE id = ?").run(MEETING_ONE);
      database.pragma("ignore_check_constraints = OFF");
      const corrupted = await server.inject({ method: "GET", url: "/api/meetings", headers: { cookie } });
      expect(corrupted).toMatchObject({ statusCode: 500, body: '{"code":"INTERNAL_ERROR"}' });
      expect(corrupted.body).not.toContain("invalid");
    } finally {
      await server.close();
    }
  });

  test("validates folder references and applies title and folder changes atomically", async () => {
    const server = await createTestApp();
    try {
      const cookie = await login(server);
      const unknownOnCreate = await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload: { id: MEETING_TWO, title: "Missing folder", folderId: UNKNOWN_FOLDER, clientCreatedAt: CREATED_AT } });
      expect(unknownOnCreate.statusCode).toBe(404);
      expect(unknownOnCreate.json()).toEqual({ code: "FOLDER_NOT_FOUND" });
      await server.inject({ method: "POST", url: "/api/folders", headers: { cookie }, payload: { id: FOLDER_ONE, name: "Work", clientCreatedAt: CREATED_AT } });
      await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload: { id: MEETING_ONE, title: "Before", folderId: null, clientCreatedAt: CREATED_AT } });

      const changed = await server.inject({ method: "PATCH", url: `/api/meetings/${MEETING_ONE}`, headers: { cookie }, payload: { title: " After ", folderId: FOLDER_ONE, expectedSyncVersion: 0 } });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({ title: "After", folderId: FOLDER_ONE, syncVersion: 1, updatedAt: "2026-08-21T00:00:00.000Z" });

      const unknownFolder = await server.inject({ method: "PATCH", url: `/api/meetings/${MEETING_ONE}`, headers: { cookie }, payload: { folderId: UNKNOWN_FOLDER, expectedSyncVersion: 1 } });
      expect(unknownFolder.statusCode).toBe(404);
      expect(unknownFolder.json()).toEqual({ code: "FOLDER_NOT_FOUND" });
      const afterFailure = await server.inject({ method: "GET", url: "/api/meetings", headers: { cookie } });
      expect(afterFailure.json()[0]).toMatchObject({ title: "After", folderId: FOLDER_ONE, syncVersion: 1 });

      const empty = await server.inject({ method: "PATCH", url: `/api/meetings/${MEETING_ONE}`, headers: { cookie }, payload: {} });
      const unknownField = await server.inject({ method: "PATCH", url: `/api/meetings/${MEETING_ONE}`, headers: { cookie }, payload: { status: "ready" } });
      expect(empty.json()).toEqual({ code: "INVALID_REQUEST" });
      expect(unknownField.json()).toEqual({ code: "INVALID_REQUEST" });
    } finally {
      await server.close();
    }
  });

  test("conditionally patches a strict meeting note and returns typed failures", async () => {
    const server = await createTestApp();
    try {
      const cookie = await login(server);
      await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload: { id: MEETING_ONE, title: "Notes", folderId: null, clientCreatedAt: CREATED_AT } });
      const key = "00000000-0000-4000-8000-000000000185";
      const saved = await server.inject({
        method: "PATCH",
        url: `/api/meetings/${MEETING_ONE}`,
        headers: { cookie, "idempotency-key": key },
        payload: { note: "结论\nNext step", expectedSyncVersion: 0 },
      });
      expect(saved).toMatchObject({ statusCode: 200 });
      expect(saved.json()).toMatchObject({ note: "结论\nNext step", syncVersion: 1 });
      expect((await server.inject({
        method: "PATCH",
        url: `/api/meetings/${MEETING_ONE}`,
        headers: { cookie, "idempotency-key": key },
        payload: { note: "结论\nNext step", expectedSyncVersion: 0 },
      })).json()).toEqual(saved.json());
      expect(await server.inject({ method: "PATCH", url: `/api/meetings/${MEETING_ONE}`, headers: { cookie }, payload: { note: "stale", expectedSyncVersion: 0 } }))
        .toMatchObject({ statusCode: 409, body: '{"code":"SYNC_VERSION_CONFLICT"}' });
      expect(await server.inject({ method: "PATCH", url: `/api/meetings/${MEETING_TWO}`, headers: { cookie }, payload: { note: "missing", expectedSyncVersion: 0 } }))
        .toMatchObject({ statusCode: 404, body: '{"code":"MEETING_NOT_FOUND"}' });
      for (const payload of [
        { note: "invalid", expectedSyncVersion: 1, updatedAt: CREATED_AT },
        { note: "invalid", title: "mixed", expectedSyncVersion: 1 },
        { note: "invalid" },
      ]) {
        expect(await server.inject({ method: "PATCH", url: `/api/meetings/${MEETING_ONE}`, headers: { cookie }, payload }))
          .toMatchObject({ statusCode: 400, body: '{"code":"INVALID_REQUEST"}' });
      }
    } finally {
      await server.close();
    }
  });

  test("accepts 200000 emoji note code points and rejects one more", async () => {
    const server = await createTestApp();
    try {
      const cookie = await login(server);
      await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload: { id: MEETING_ONE, title: "Notes", folderId: null, clientCreatedAt: CREATED_AT } });
      const accepted = await server.inject({
        method: "PATCH",
        url: `/api/meetings/${MEETING_ONE}`,
        headers: { cookie },
        payload: { note: "😀".repeat(200_000), expectedSyncVersion: 0 },
      });
      expect(accepted).toMatchObject({ statusCode: 200 });
      expect(Array.from(accepted.json().note)).toHaveLength(200_000);
      expect(await server.inject({
        method: "PATCH",
        url: `/api/meetings/${MEETING_ONE}`,
        headers: { cookie },
        payload: { note: "😀".repeat(200_001), expectedSyncVersion: 1 },
      })).toMatchObject({ statusCode: 400, body: '{"code":"INVALID_REQUEST"}' });
    } finally {
      await server.close();
    }
  });

  test("trashes, restores, filters literal search, and sanitizes invalid requests", async () => {
    const server = await createTestApp();
    try {
      const cookie = await login(server);
      await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload: { id: MEETING_ONE, title: "100%_done", folderId: null, clientCreatedAt: CREATED_AT } });
      await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload: { id: MEETING_TWO, title: "100AXdone", folderId: null, clientCreatedAt: CREATED_AT } });

      expect((await server.inject({ method: "GET", url: "/api/meetings?search=%25_", headers: { cookie } })).json().map((meeting: { id: string }) => meeting.id)).toEqual([MEETING_ONE]);
      const trashed = await server.inject({ method: "DELETE", url: `/api/meetings/${MEETING_ONE}`, headers: { cookie } });
      expect(trashed.statusCode).toBe(200);
      expect(trashed.json()).toMatchObject({ status: "trashed" });
      expect((await server.inject({ method: "GET", url: "/api/meetings", headers: { cookie } })).json().map((meeting: { id: string }) => meeting.id)).toEqual([MEETING_TWO]);
      expect((await server.inject({ method: "GET", url: "/api/meetings?includeTrashed=true", headers: { cookie } })).json()).toHaveLength(2);
      expect((await server.inject({ method: "POST", url: `/api/meetings/${MEETING_ONE}/restore`, headers: { cookie } })).json()).toMatchObject({ status: "draft", trashedAt: null });

      const malformed = await server.inject({ method: "GET", url: "/api/meetings?includeTrashed=yes", headers: { cookie } });
      const badId = await server.inject({ method: "DELETE", url: "/api/meetings/not-a-uuid", headers: { cookie } });
      const missing = await server.inject({ method: "DELETE", url: "/api/meetings/00000000-0000-4000-8000-000000000198", headers: { cookie } });
      expect(malformed).toMatchObject({ statusCode: 400, body: '{"code":"INVALID_REQUEST"}' });
      expect(badId).toMatchObject({ statusCode: 400, body: '{"code":"INVALID_REQUEST"}' });
      expect(missing.json()).toEqual({ code: "MEETING_NOT_FOUND" });
      expect(malformed.body).not.toContain("Zod");
    } finally {
      await server.close();
    }
  });

  test("rejects a stale conditional mutation without overwriting the first device", async () => {
    const server = await createTestApp();
    try {
      const cookie = await login(server);
      await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload: { id: MEETING_ONE, title: "Before", folderId: null, clientCreatedAt: CREATED_AT } });
      const first = await server.inject({ method: "PATCH", url: `/api/meetings/${MEETING_ONE}`, headers: { cookie }, payload: { title: "First", expectedSyncVersion: 0 } });
      const stale = await server.inject({ method: "PATCH", url: `/api/meetings/${MEETING_ONE}`, headers: { cookie }, payload: { title: "Second", expectedSyncVersion: 0 } });
      expect(first.statusCode).toBe(200);
      expect(stale).toMatchObject({ statusCode: 409, body: '{"code":"SYNC_VERSION_CONFLICT"}' });
      const staleTrash = await server.inject({ method: "DELETE", url: `/api/meetings/${MEETING_ONE}`, headers: { cookie, "idempotency-key": "00000000-0000-4000-8000-000000000191" }, payload: { expectedSyncVersion: 0 } });
      expect(staleTrash).toMatchObject({ statusCode: 409, body: '{"code":"SYNC_VERSION_CONFLICT"}' });
      await server.inject({ method: "DELETE", url: `/api/meetings/${MEETING_ONE}`, headers: { cookie, "idempotency-key": "00000000-0000-4000-8000-000000000192" }, payload: { expectedSyncVersion: 1 } });
      const staleRestore = await server.inject({ method: "POST", url: `/api/meetings/${MEETING_ONE}/restore`, headers: { cookie, "idempotency-key": "00000000-0000-4000-8000-000000000193" }, payload: { expectedSyncVersion: 1 } });
      expect(staleRestore).toMatchObject({ statusCode: 409, body: '{"code":"SYNC_VERSION_CONFLICT"}' });
      expect((await server.inject({ method: "GET", url: "/api/meetings?includeTrashed=true", headers: { cookie } })).json()[0]).toMatchObject({ title: "First", status: "trashed", syncVersion: 2 });
    } finally {
      await server.close();
    }
  });

  test("replays rename, trash, and restore after a lost response and rejects key misuse", async () => {
    const server = await createTestApp();
    try {
      const cookie = await login(server);
      await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload: { id: MEETING_ONE, title: "Before", folderId: null, clientCreatedAt: CREATED_AT } });
      const mutate = (method: "PATCH" | "DELETE" | "POST", url: string, key: string, payload: Record<string, unknown>) => server.inject({ method, url, headers: { cookie, "idempotency-key": key }, payload });
      const renameKey = "00000000-0000-4000-8000-000000000181";
      const renamed = await mutate("PATCH", `/api/meetings/${MEETING_ONE}`, renameKey, { title: "After", expectedSyncVersion: 0 });
      expect((await mutate("PATCH", `/api/meetings/${MEETING_ONE}`, renameKey, { title: "After", expectedSyncVersion: 0 })).json()).toEqual(renamed.json());
      expect(await mutate("PATCH", `/api/meetings/${MEETING_ONE}`, renameKey, { title: "Misuse", expectedSyncVersion: 0 })).toMatchObject({ statusCode: 409, body: '{"code":"IDEMPOTENCY_CONFLICT"}' });

      const trashKey = "00000000-0000-4000-8000-000000000182";
      const trashed = await mutate("DELETE", `/api/meetings/${MEETING_ONE}`, trashKey, { expectedSyncVersion: 1 });
      expect((await mutate("DELETE", `/api/meetings/${MEETING_ONE}`, trashKey, { expectedSyncVersion: 1 })).json()).toEqual(trashed.json());
      const restoreKey = "00000000-0000-4000-8000-000000000183";
      const restored = await mutate("POST", `/api/meetings/${MEETING_ONE}/restore`, restoreKey, { expectedSyncVersion: 2 });
      expect((await mutate("POST", `/api/meetings/${MEETING_ONE}/restore`, restoreKey, { expectedSyncVersion: 2 })).json()).toEqual(restored.json());
    } finally {
      await server.close();
    }
  });

  test("replays a legacy rename and rejects reuse of its key for another legacy request", async () => {
    const server = await createTestApp();
    try {
      const cookie = await login(server);
      await server.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload: { id: MEETING_ONE, title: "Before", folderId: null, clientCreatedAt: CREATED_AT } });
      const key = "00000000-0000-4000-8000-000000000184";
      const rename = (title: string) => server.inject({
        method: "PATCH",
        url: `/api/meetings/${MEETING_ONE}`,
        headers: { cookie, "idempotency-key": key },
        payload: { title },
      });

      const renamed = await rename("Legacy after");
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ title: "Legacy after", syncVersion: 1 });
      expect((await rename("Legacy after")).json()).toEqual(renamed.json());
      expect(await rename("Legacy misuse")).toMatchObject({ statusCode: 409, body: '{"code":"IDEMPOTENCY_CONFLICT"}' });
    } finally {
      await server.close();
    }
  });
});
