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
    await api.send({ id: "2", entityId: id, kind: "meeting.rename", payload: { title: "Renamed", updatedAt: timestamp }, createdAt: timestamp, attempts: 0, lastError: null });
    await api.send({ id: "3", entityId: id, kind: "meeting.trash", payload: { updatedAt: timestamp }, createdAt: timestamp, attempts: 0, lastError: null });
    await api.send({ id: "4", entityId: id, kind: "meeting.restore", payload: { updatedAt: timestamp }, createdAt: timestamp, attempts: 0, lastError: null });
    await api.send({ id: "5", entityId: folderId, kind: "folder.create", payload: { id: folderId, name: "Work", clientCreatedAt: timestamp }, createdAt: timestamp, attempts: 0, lastError: null });
    await api.send({ id: "6", entityId: folderId, kind: "folder.rename", payload: { name: "Renamed", updatedAt: timestamp }, createdAt: timestamp, attempts: 0, lastError: null });
    await api.send({ id: "7", entityId: folderId, kind: "folder.remove", payload: { updatedAt: timestamp }, createdAt: timestamp, attempts: 0, lastError: null });

    expect(fetcher.mock.calls).toEqual([
      ["/api/meetings", expect.objectContaining({ method: "POST", credentials: "include", body: JSON.stringify({ id, title: "Planning", folderId: null, clientCreatedAt: timestamp }) })],
      [`/api/meetings/${id}`, expect.objectContaining({ method: "PATCH", credentials: "include", body: JSON.stringify({ title: "Renamed" }) })],
      [`/api/meetings/${id}`, expect.objectContaining({ method: "DELETE", credentials: "include" })],
      [`/api/meetings/${id}/restore`, expect.objectContaining({ method: "POST", credentials: "include" })],
      ["/api/folders", expect.objectContaining({ method: "POST", credentials: "include", body: JSON.stringify({ id: folderId, name: "Work", clientCreatedAt: timestamp }) })],
      [`/api/folders/${folderId}`, expect.objectContaining({ method: "PATCH", credentials: "include", body: JSON.stringify({ name: "Renamed" }) })],
      [`/api/folders/${folderId}`, expect.objectContaining({ method: "DELETE", credentials: "include" })],
    ]);
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
});
