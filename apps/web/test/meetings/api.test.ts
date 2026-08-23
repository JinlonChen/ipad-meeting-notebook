import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, test, vi } from "vitest";

import { CatalogApiError } from "../../src/meetings/sync.js";
import { MeetingCatalogHttpApi, MeetingCatalogSupabaseApi } from "../../src/meetings/api.js";
import type { Database } from "../../src/supabase/types.js";

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

type SupabaseCatalogClient = Pick<SupabaseClient<Database>, "from" | "rpc">;

type SupabaseResult = { data: unknown; error: unknown; status?: unknown };

function supabaseClient(options: {
  rpcResults?: SupabaseResult[];
  tableResults?: Partial<Record<"folders" | "meetings", SupabaseResult>>;
} = {}): {
  client: SupabaseCatalogClient;
  rpc: ReturnType<typeof vi.fn>;
  queries: Record<string, { select: ReturnType<typeof vi.fn>; order: ReturnType<typeof vi.fn> }>;
} {
  const rpcResults = [...(options.rpcResults ?? [])];
  const rpc = vi.fn().mockImplementation(async () => rpcResults.shift() ?? { data: null, error: null });
  const queries: Record<string, { select: ReturnType<typeof vi.fn>; order: ReturnType<typeof vi.fn> }> = {};
  const from = vi.fn().mockImplementation((table: "folders" | "meetings") => {
    const result = options.tableResults?.[table] ?? { data: [], error: null };
    const query: {
      select: ReturnType<typeof vi.fn>;
      order: ReturnType<typeof vi.fn>;
      then: PromiseLike<SupabaseResult>["then"];
    } = {
      select: vi.fn(),
      order: vi.fn(),
      then: (onfulfilled, onrejected) => Promise.resolve(result).then(onfulfilled, onrejected),
    };
    query.select.mockReturnValue(query);
    query.order.mockReturnValue(query);
    queries[table] = query;
    return query;
  });
  return { client: { from, rpc } as unknown as SupabaseCatalogClient, rpc, queries };
}

const meetingRow = {
  user_id: "550e8400-e29b-41d4-a716-446655440000",
  id,
  title: "Planning",
  folder_id: folderId,
  status: "draft",
  started_at: null,
  ended_at: null,
  created_at: timestamp,
  updated_at: timestamp,
  trashed_at: null,
  sync_version: 2,
};

const folderRow = {
  user_id: "550e8400-e29b-41d4-a716-446655440000",
  id: folderId,
  name: "Work",
  created_at: timestamp,
  updated_at: timestamp,
  sync_version: 1,
};

const operations = [
  { id: "00000000-0000-4000-8000-000000000011", entityId: id, kind: "meeting.create" as const, payload: { id, title: "Planning", folderId, clientCreatedAt: timestamp } },
  { id: "00000000-0000-4000-8000-000000000012", entityId: id, kind: "meeting.rename" as const, payload: { title: "Renamed", updatedAt: timestamp, expectedSyncVersion: 0 } },
  { id: "00000000-0000-4000-8000-000000000013", entityId: id, kind: "meeting.trash" as const, payload: { updatedAt: timestamp, expectedSyncVersion: 1 } },
  { id: "00000000-0000-4000-8000-000000000014", entityId: id, kind: "meeting.restore" as const, payload: { updatedAt: timestamp, expectedSyncVersion: 2 } },
  { id: "00000000-0000-4000-8000-000000000015", entityId: folderId, kind: "folder.create" as const, payload: { id: folderId, name: "Work", clientCreatedAt: timestamp } },
  { id: "00000000-0000-4000-8000-000000000016", entityId: folderId, kind: "folder.rename" as const, payload: { name: "Renamed", updatedAt: timestamp, expectedSyncVersion: 0 } },
  { id: "00000000-0000-4000-8000-000000000017", entityId: folderId, kind: "folder.remove" as const, payload: { updatedAt: timestamp, expectedSyncVersion: 1 } },
].map((operation) => ({ ...operation, createdAt: timestamp, attempts: 0, lastError: null }));

describe("MeetingCatalogSupabaseApi", () => {
  test("sends every outbox operation through the mutation RPC with exact parameters", async () => {
    const { client, rpc } = supabaseClient({ rpcResults: operations.map((operation) => ({
      data: operation.kind === "folder.remove"
        ? { status: 200 }
        : operation.kind.startsWith("folder.")
          ? { status: 200, folder: folderRow }
          : { status: 200, meeting: meetingRow },
      error: null,
    })) });
    const api = new MeetingCatalogSupabaseApi(client);

    for (const operation of operations) await api.send(operation, folderRow.user_id);

    expect(rpc.mock.calls).toEqual(operations.map((operation) => ["apply_catalog_mutation", {
      p_operation_id: operation.id,
      p_kind: operation.kind,
      p_entity_id: operation.entityId,
      p_payload: operation.payload,
      p_expected_user_id: folderRow.user_id,
    }]));
  });

  test("maps snake-case mutation rows and deterministic replay responses to contracts", async () => {
    const { client } = supabaseClient({ rpcResults: [
      { data: { status: 200, meeting: meetingRow }, error: null },
      { data: { status: 200, meeting: meetingRow }, error: null },
      { data: { status: 200, folder: folderRow }, error: null },
    ] });
    const api = new MeetingCatalogSupabaseApi(client);

    await expect(api.send(operations[0]!, folderRow.user_id)).resolves.toEqual({ meeting: {
      id, title: "Planning", folderId, status: "draft", startedAt: null, endedAt: null,
      createdAt: timestamp, updatedAt: timestamp, trashedAt: null, syncVersion: 2,
    } });
    await expect(api.send(operations[0]!, folderRow.user_id)).resolves.toEqual({ meeting: expect.objectContaining({ id, syncVersion: 2 }) });
    await expect(api.send(operations[4]!, folderRow.user_id)).resolves.toEqual({ folder: {
      id: folderId, name: "Work", createdAt: timestamp, updatedAt: timestamp, syncVersion: 1,
    } });
  });

  test("canonicalizes offset Postgres timestamps in an RPC row and preserves null timestamps", async () => {
    const { client } = supabaseClient({ rpcResults: [{ data: { status: 200, meeting: {
      ...meetingRow,
      created_at: "2026-08-21T08:00:00+08:00",
      updated_at: "2026-08-21T00:30:00+00:00",
      started_at: "2026-08-21T02:00:00+01:30",
      ended_at: null,
      trashed_at: null,
    } }, error: null }] });

    await expect(new MeetingCatalogSupabaseApi(client).send(operations[0]!, folderRow.user_id)).resolves.toEqual({ meeting: {
      id,
      title: "Planning",
      folderId,
      status: "draft",
      startedAt: "2026-08-21T00:30:00.000Z",
      endedAt: null,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:30:00.000Z",
      trashedAt: null,
      syncVersion: 2,
    } });
  });

  test("pulls complete catalogs in deterministic server order and maps snake-case rows", async () => {
    const { client, queries } = supabaseClient({ tableResults: {
      folders: { data: [folderRow], error: null },
      meetings: { data: [meetingRow], error: null },
    } });
    const api = new MeetingCatalogSupabaseApi(client);

    await expect(api.listFolders()).resolves.toEqual([{
      id: folderId, name: "Work", createdAt: timestamp, updatedAt: timestamp, syncVersion: 1,
    }]);
    await expect(api.listMeetings()).resolves.toEqual([{
      id, title: "Planning", folderId, status: "draft", startedAt: null, endedAt: null,
      createdAt: timestamp, updatedAt: timestamp, trashedAt: null, syncVersion: 2,
    }]);
    expect(queries.folders?.select).toHaveBeenCalledWith("user_id,id,name,created_at,updated_at,sync_version");
    expect(queries.folders?.order.mock.calls).toEqual([
      ["name", { ascending: true }],
      ["id", { ascending: true }],
    ]);
    expect(queries.meetings?.select).toHaveBeenCalledWith("user_id,id,title,folder_id,status,started_at,ended_at,created_at,updated_at,trashed_at,sync_version");
    expect(queries.meetings?.order.mock.calls).toEqual([
      ["updated_at", { ascending: false }],
      ["id", { ascending: true }],
    ]);
  });

  test("rejects pull rows owned by a different actor", async () => {
    const { client } = supabaseClient({ tableResults: {
      folders: { data: [{ ...folderRow, user_id: "00000000-0000-4000-8000-00000000000b" }], error: null },
    } });

    await expect(new MeetingCatalogSupabaseApi(client).listFolders(folderRow.user_id))
      .rejects.toEqual(new CatalogApiError(401, "AUTH_REQUIRED"));
  });

  test("canonicalizes offset Postgres timestamps across complete list responses", async () => {
    const { client } = supabaseClient({ tableResults: {
      folders: { data: [{
        ...folderRow,
        created_at: "2026-08-21T00:00:00+00:00",
        updated_at: "2026-08-21T09:00:00+08:00",
      }], error: null },
      meetings: { data: [{
        ...meetingRow,
        created_at: "2026-08-21T00:00:00+00:00",
        updated_at: "2026-08-21T09:00:00+08:00",
      }], error: null },
    } });
    const api = new MeetingCatalogSupabaseApi(client);

    await expect(api.listFolders()).resolves.toEqual([expect.objectContaining({
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T01:00:00.000Z",
    })]);
    await expect(api.listMeetings()).resolves.toEqual([expect.objectContaining({
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T01:00:00.000Z",
    })]);
  });

  test.each([
    [{ data: null, error: { message: "expired jwt secret" }, status: 401 }, new CatalogApiError(401, "AUTH_REQUIRED")],
    [{ data: null, error: { message: "private upstream detail" }, status: 503 }, new CatalogApiError(503, "REQUEST_FAILED")],
    [{ data: { status: 401, code: "AUTH_REQUIRED" }, error: null }, new CatalogApiError(401, "AUTH_REQUIRED")],
    [{ data: { status: 401, code: "AUTH_CONTEXT_CHANGED" }, error: null }, new CatalogApiError(401, "AUTH_REQUIRED")],
    [{ data: { status: 409, code: "CONFLICT" }, error: null }, new CatalogApiError(409, "CONFLICT")],
  ])("maps Supabase and RPC failures to fixed catalog errors", async (result, expected) => {
    const { client } = supabaseClient({ rpcResults: [result] });

    await expect(new MeetingCatalogSupabaseApi(client).send(operations[1]!, folderRow.user_id)).rejects.toEqual(expected);
  });

  test("maps a list response HTTP 401 to auth required without exposing its error", async () => {
    const { client } = supabaseClient({ tableResults: {
      folders: { data: null, error: { message: "expired private access token" }, status: 401 },
    } });

    await expect(new MeetingCatalogSupabaseApi(client).listFolders()).rejects.toEqual(new CatalogApiError(401, "AUTH_REQUIRED"));
  });

  test.each([
    [operations[1], "MEETING_NOT_FOUND"],
    [operations[5], "FOLDER_NOT_FOUND"],
  ])("preserves typed RPC 404 conflicts", async (operation, code) => {
    const { client } = supabaseClient({ rpcResults: [{ data: { status: 404, code }, error: null }] });

    await expect(new MeetingCatalogSupabaseApi(client).send(operation!, folderRow.user_id)).rejects.toEqual(new CatalogApiError(404, code));
  });

  test("normalizes thrown failures without exposing raw Supabase details", async () => {
    const rpc = vi.fn().mockRejectedValue(new TypeError("https://secret.supabase.co?token=private"));
    const client = { rpc, from: vi.fn() } as unknown as SupabaseCatalogClient;

    const error = await new MeetingCatalogSupabaseApi(client).send(operations[1]!, folderRow.user_id).catch((caught: unknown) => caught);

    expect(error).toEqual(new CatalogApiError(0, "REQUEST_FAILED"));
    expect(JSON.stringify(error)).not.toContain("secret.supabase.co");
    expect(String(error)).not.toContain("private");
  });

  test.each([
    ["missing RPC data", { data: null, error: null }],
    ["malformed RPC status", { data: { status: "200", meeting: meetingRow }, error: null }],
    ["RPC status below the HTTP range", { data: { status: 99, meeting: meetingRow }, error: null }],
    ["RPC status above the HTTP range", { data: { status: 600, meeting: meetingRow }, error: null }],
    ["missing success entity", { data: { status: 200 }, error: null }],
    ["malformed success row", { data: { status: 200, meeting: { ...meetingRow, sync_version: -1 } }, error: null }],
  ])("rejects %s as a safe request failure", async (_label, result) => {
    const { client } = supabaseClient({ rpcResults: [result] });

    await expect(new MeetingCatalogSupabaseApi(client).send(operations[0]!, folderRow.user_id)).rejects.toEqual(new CatalogApiError(500, "REQUEST_FAILED"));
  });

  test("rejects a non-JSON outbox payload before calling the RPC", async () => {
    const { client, rpc } = supabaseClient();
    const operation = { ...operations[1]!, payload: { title: "Renamed", expectedSyncVersion: 0n } };

    await expect(new MeetingCatalogSupabaseApi(client).send(operation, folderRow.user_id)).rejects.toEqual(new CatalogApiError(500, "REQUEST_FAILED"));
    expect(rpc).not.toHaveBeenCalled();
  });

  test("rejects a malformed row without returning any part of a catalog response", async () => {
    const { client } = supabaseClient({ tableResults: {
      folders: { data: [folderRow, { ...folderRow, id: "not-a-uuid" }], error: null },
      meetings: { data: [meetingRow, { ...meetingRow, status: "private-invalid-status" }], error: null },
    } });
    const api = new MeetingCatalogSupabaseApi(client);

    await expect(api.listFolders()).rejects.toEqual(new CatalogApiError(500, "REQUEST_FAILED"));
    await expect(api.listMeetings()).rejects.toEqual(new CatalogApiError(500, "REQUEST_FAILED"));
  });

  test.each([
    ["timezone-less", "2026-08-21T00:00:00"],
    ["invalid", "not-a-timestamp"],
  ])("rejects %s Postgres timestamps instead of guessing a timezone", async (_label, createdAt) => {
    const { client } = supabaseClient({ tableResults: {
      folders: { data: [{ ...folderRow, created_at: createdAt }], error: null },
    } });

    await expect(new MeetingCatalogSupabaseApi(client).listFolders()).rejects.toEqual(new CatalogApiError(500, "REQUEST_FAILED"));
  });
});
