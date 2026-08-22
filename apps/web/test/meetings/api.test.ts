import { describe, expect, test, vi } from "vitest";

import { CatalogApiError } from "../../src/meetings/sync.js";
import { MeetingCatalogHttpApi } from "../../src/meetings/api.js";

const id = "00000000-0000-4000-8000-000000000001";
const folderId = "00000000-0000-4000-8000-000000000002";
const timestamp = "2026-08-21T00:00:00.000Z";
const meeting = { id, title: "Planning", folderId: null, status: "draft", startedAt: null, endedAt: null, createdAt: timestamp, updatedAt: timestamp, trashedAt: null, syncVersion: 0 };
const folder = { id: folderId, name: "Work", createdAt: timestamp, updatedAt: timestamp, syncVersion: 0 };

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("MeetingCatalogHttpApi", () => {
  test("maps every outbox operation to its authenticated API endpoint", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(meeting, 201))
      .mockResolvedValueOnce(response(meeting))
      .mockResolvedValueOnce(response(meeting))
      .mockResolvedValueOnce(response(meeting))
      .mockResolvedValueOnce(response(folder, 201))
      .mockResolvedValueOnce(response(folder))
      .mockResolvedValueOnce(response(undefined, 204));
    const api = new MeetingCatalogHttpApi(fetcher);

    await api.send({ id: "1", entityId: id, kind: "meeting.create", payload: { id, title: "Planning", folderId: null, clientCreatedAt: timestamp }, createdAt: timestamp, attempts: 0, lastError: null });
    await api.send({ id: "00000000-0000-4000-8000-000000000012", entityId: id, kind: "meeting.rename", payload: { title: "Renamed", updatedAt: timestamp, expectedSyncVersion: 0 }, createdAt: timestamp, attempts: 0, lastError: null });
    await api.send({ id: "00000000-0000-4000-8000-000000000013", entityId: id, kind: "meeting.trash", payload: { updatedAt: timestamp, expectedSyncVersion: 1 }, createdAt: timestamp, attempts: 0, lastError: null });
    await api.send({ id: "00000000-0000-4000-8000-000000000014", entityId: id, kind: "meeting.restore", payload: { updatedAt: timestamp, expectedSyncVersion: 2 }, createdAt: timestamp, attempts: 0, lastError: null });
    await api.send({ id: "5", entityId: folderId, kind: "folder.create", payload: { id: folderId, name: "Work", clientCreatedAt: timestamp }, createdAt: timestamp, attempts: 0, lastError: null });
    await api.send({ id: "00000000-0000-4000-8000-000000000016", entityId: folderId, kind: "folder.rename", payload: { name: "Renamed", updatedAt: timestamp, expectedSyncVersion: 0 }, createdAt: timestamp, attempts: 0, lastError: null });
    await api.send({ id: "00000000-0000-4000-8000-000000000017", entityId: folderId, kind: "folder.remove", payload: { updatedAt: timestamp, expectedSyncVersion: 1 }, createdAt: timestamp, attempts: 0, lastError: null });

    expect(fetcher.mock.calls).toEqual([
      ["/api/meetings", expect.objectContaining({ method: "POST", credentials: "include", body: JSON.stringify({ id, title: "Planning", folderId: null, clientCreatedAt: timestamp }) })],
      [`/api/meetings/${id}`, expect.objectContaining({ method: "PATCH", credentials: "include", headers: expect.objectContaining({ "idempotency-key": "00000000-0000-4000-8000-000000000012" }), body: JSON.stringify({ title: "Renamed", expectedSyncVersion: 0 }) })],
      [`/api/meetings/${id}`, expect.objectContaining({ method: "DELETE", credentials: "include", headers: expect.objectContaining({ "idempotency-key": "00000000-0000-4000-8000-000000000013" }), body: JSON.stringify({ expectedSyncVersion: 1 }) })],
      [`/api/meetings/${id}/restore`, expect.objectContaining({ method: "POST", credentials: "include", headers: expect.objectContaining({ "idempotency-key": "00000000-0000-4000-8000-000000000014" }), body: JSON.stringify({ expectedSyncVersion: 2 }) })],
      ["/api/folders", expect.objectContaining({ method: "POST", credentials: "include", body: JSON.stringify({ id: folderId, name: "Work", clientCreatedAt: timestamp }) })],
      [`/api/folders/${folderId}`, expect.objectContaining({ method: "PATCH", credentials: "include", headers: expect.objectContaining({ "idempotency-key": "00000000-0000-4000-8000-000000000016" }), body: JSON.stringify({ name: "Renamed", expectedSyncVersion: 0 }) })],
      [`/api/folders/${folderId}`, expect.objectContaining({ method: "DELETE", credentials: "include", headers: expect.objectContaining({ "idempotency-key": "00000000-0000-4000-8000-000000000017" }), body: JSON.stringify({ expectedSyncVersion: 1 }) })],
    ]);
  });

  test("replays legacy conditional outbox payloads without a sync version", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(meeting))
      .mockResolvedValueOnce(response(meeting))
      .mockResolvedValueOnce(response(meeting))
      .mockResolvedValueOnce(response(folder))
      .mockResolvedValueOnce(response(undefined, 204));
    const api = new MeetingCatalogHttpApi(fetcher);
    const operations = [
      { id: "legacy-meeting-rename", entityId: id, kind: "meeting.rename" as const, payload: { title: "Legacy title", updatedAt: timestamp } },
      { id: "legacy-meeting-trash", entityId: id, kind: "meeting.trash" as const, payload: { updatedAt: timestamp } },
      { id: "legacy-meeting-restore", entityId: id, kind: "meeting.restore" as const, payload: { updatedAt: timestamp } },
      { id: "legacy-folder-rename", entityId: folderId, kind: "folder.rename" as const, payload: { name: "Legacy folder", updatedAt: timestamp } },
      { id: "legacy-folder-remove", entityId: folderId, kind: "folder.remove" as const, payload: { updatedAt: timestamp } },
    ];

    for (const operation of operations) {
      await api.send({ ...operation, createdAt: timestamp, attempts: 0, lastError: null });
    }

    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls[0]).toEqual([
      `/api/meetings/${id}`,
      expect.objectContaining({ method: "PATCH", headers: expect.objectContaining({ "idempotency-key": "legacy-meeting-rename" }), body: JSON.stringify({ title: "Legacy title" }) }),
    ]);
    expect(fetcher.mock.calls[1]).toEqual([
      `/api/meetings/${id}`,
      expect.objectContaining({ method: "DELETE", headers: expect.objectContaining({ "idempotency-key": "legacy-meeting-trash" }) }),
    ]);
    expect(fetcher.mock.calls[2]).toEqual([
      `/api/meetings/${id}/restore`,
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "idempotency-key": "legacy-meeting-restore" }) }),
    ]);
    expect(fetcher.mock.calls[3]).toEqual([
      `/api/folders/${folderId}`,
      expect.objectContaining({ method: "PATCH", headers: expect.objectContaining({ "idempotency-key": "legacy-folder-rename" }), body: JSON.stringify({ name: "Legacy folder" }) }),
    ]);
    expect(fetcher.mock.calls[4]).toEqual([
      `/api/folders/${folderId}`,
      expect.objectContaining({ method: "DELETE", headers: expect.objectContaining({ "idempotency-key": "legacy-folder-remove" }) }),
    ]);
    for (const index of [1, 2, 4]) {
      expect(fetcher.mock.calls[index]?.[1]).not.toHaveProperty("body");
    }
  });

  test("lists all meetings and sanitizes typed failures and invalid responses", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response([meeting]))
      .mockResolvedValueOnce(response({ code: "SERVER_SECRET" }, 401))
      .mockResolvedValueOnce(response({ code: "CONFLICT" }, 409))
      .mockResolvedValueOnce(response([{ invalid: true }]));
    const api = new MeetingCatalogHttpApi(fetcher);

    await expect(api.listMeetings()).resolves.toEqual([meeting]);
    expect(fetcher).toHaveBeenLastCalledWith("/api/meetings?includeTrashed=true", expect.objectContaining({ credentials: "include" }));
    await expect(api.listFolders()).rejects.toEqual(new CatalogApiError(401, "AUTH_REQUIRED"));
    await expect(api.listFolders()).rejects.toEqual(new CatalogApiError(409, "CONFLICT"));
    await expect(api.listFolders()).rejects.toThrow();
  });

  test("normalizes transport, JSON and schema failures to fixed catalog errors", async () => {
    const api = new MeetingCatalogHttpApi(vi.fn()
      .mockRejectedValueOnce(new TypeError("network endpoint leaked"))
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }))
      .mockResolvedValueOnce(response([{ invalid: true }])));

    await expect(api.listFolders()).rejects.toMatchObject({ name: "CatalogApiError", status: 0, code: "REQUEST_FAILED" });
    await expect(api.listFolders()).rejects.toMatchObject({ name: "CatalogApiError", status: 200, code: "REQUEST_FAILED" });
    await expect(api.listFolders()).rejects.toMatchObject({ name: "CatalogApiError", status: 200, code: "REQUEST_FAILED" });
  });

  test("treats only an exact folder-not-found removal response as an idempotent success", async () => {
    const operation = { id: "00000000-0000-4000-8000-000000000099", entityId: folderId, kind: "folder.remove" as const, payload: { updatedAt: timestamp, expectedSyncVersion: 1 }, createdAt: timestamp, attempts: 0, lastError: null };
    await expect(new MeetingCatalogHttpApi(vi.fn().mockResolvedValue(response({ code: "FOLDER_NOT_FOUND" }, 404))).send(operation)).resolves.toEqual({});
    await expect(new MeetingCatalogHttpApi(vi.fn().mockResolvedValue(response({ code: "MEETING_NOT_FOUND" }, 404))).send(operation)).rejects.toMatchObject({ status: 404, code: "REQUEST_FAILED" });
    await expect(new MeetingCatalogHttpApi(vi.fn().mockResolvedValue(new Response("not-json", { status: 404 }))).send(operation)).rejects.toMatchObject({ status: 404, code: "REQUEST_FAILED" });
  });

  test.each([
    ["folder rename", { id: "00000000-0000-4000-8000-000000000021", entityId: folderId, kind: "folder.rename" as const, payload: { name: "Renamed", updatedAt: timestamp, expectedSyncVersion: 0 }, createdAt: timestamp, attempts: 0, lastError: null }, "FOLDER_NOT_FOUND"],
    ["meeting rename", { id: "00000000-0000-4000-8000-000000000022", entityId: id, kind: "meeting.rename" as const, payload: { title: "Renamed", updatedAt: timestamp, expectedSyncVersion: 0 }, createdAt: timestamp, attempts: 0, lastError: null }, "MEETING_NOT_FOUND"],
    ["meeting trash", { id: "00000000-0000-4000-8000-000000000023", entityId: id, kind: "meeting.trash" as const, payload: { updatedAt: timestamp, expectedSyncVersion: 0 }, createdAt: timestamp, attempts: 0, lastError: null }, "MEETING_NOT_FOUND"],
    ["meeting restore", { id: "00000000-0000-4000-8000-000000000024", entityId: id, kind: "meeting.restore" as const, payload: { updatedAt: timestamp, expectedSyncVersion: 0 }, createdAt: timestamp, attempts: 0, lastError: null }, "MEETING_NOT_FOUND"],
    ["meeting create folder reference", { id: "00000000-0000-4000-8000-000000000025", entityId: id, kind: "meeting.create" as const, payload: { id, title: "Planning", folderId, clientCreatedAt: timestamp }, createdAt: timestamp, attempts: 0, lastError: null }, "FOLDER_NOT_FOUND"],
  ])("preserves the exact typed 404 for %s", async (_name, operation, code) => {
    const api = new MeetingCatalogHttpApi(vi.fn().mockResolvedValue(response({ code }, 404)));

    await expect(api.send(operation)).rejects.toEqual(new CatalogApiError(404, code));
  });

  test.each([
    ["unrelated code", { id: "00000000-0000-4000-8000-000000000026", entityId: folderId, kind: "folder.rename" as const, payload: { name: "Renamed", updatedAt: timestamp, expectedSyncVersion: 0 }, createdAt: timestamp, attempts: 0, lastError: null }, "MEETING_NOT_FOUND"],
    ["legacy unconditional rename", { id: "legacy-folder-not-found", entityId: folderId, kind: "folder.rename" as const, payload: { name: "Renamed", updatedAt: timestamp }, createdAt: timestamp, attempts: 0, lastError: null }, "FOLDER_NOT_FOUND"],
    ["legacy meeting rename", { id: "legacy-meeting-rename-not-found", entityId: id, kind: "meeting.rename" as const, payload: { title: "Renamed", updatedAt: timestamp }, createdAt: timestamp, attempts: 0, lastError: null }, "MEETING_NOT_FOUND"],
    ["legacy meeting trash", { id: "legacy-meeting-trash-not-found", entityId: id, kind: "meeting.trash" as const, payload: { updatedAt: timestamp }, createdAt: timestamp, attempts: 0, lastError: null }, "MEETING_NOT_FOUND"],
    ["legacy meeting restore", { id: "legacy-meeting-restore-not-found", entityId: id, kind: "meeting.restore" as const, payload: { updatedAt: timestamp }, createdAt: timestamp, attempts: 0, lastError: null }, "MEETING_NOT_FOUND"],
    ["meeting create without a folder reference", { id: "00000000-0000-4000-8000-000000000027", entityId: id, kind: "meeting.create" as const, payload: { id, title: "Planning", folderId: null, clientCreatedAt: timestamp }, createdAt: timestamp, attempts: 0, lastError: null }, "FOLDER_NOT_FOUND"],
  ])("keeps a %s 404 as a generic request failure", async (_name, operation, code) => {
    const api = new MeetingCatalogHttpApi(vi.fn().mockResolvedValue(response({ code }, 404)));

    await expect(api.send(operation)).rejects.toEqual(new CatalogApiError(404, "REQUEST_FAILED"));
  });
});
