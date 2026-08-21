import { afterEach, describe, expect, test, vi } from "vitest";

import { MeetingCatalogRepository } from "../../src/meetings/repository.js";
import { CatalogApiError, CatalogSync, type MeetingCatalogApi } from "../../src/meetings/sync.js";

const now = "2026-08-21T00:00:00.000Z";
let databaseNumber = 0;

function catalog(): MeetingCatalogRepository {
  return new MeetingCatalogRepository(`meeting-catalog-sync-${databaseNumber++}`);
}

function api(send: MeetingCatalogApi["send"]): MeetingCatalogApi {
  return { send, listMeetings: vi.fn().mockResolvedValue([]), listFolders: vi.fn().mockResolvedValue([]) };
}

describe("CatalogSync", () => {
  const catalogs: MeetingCatalogRepository[] = [];

  afterEach(async () => {
    await Promise.all(catalogs.splice(0).map((item) => item.deleteDatabase()));
  });

  test("flushes durable operations in sequence so folders arrive before referencing meetings", async () => {
    const store = catalog();
    catalogs.push(store);
    const folder = await store.createFolder("Work", now);
    const meeting = await store.create("Agenda", folder.id, "2026-08-21T00:01:00.000Z");
    const sent: string[] = [];
    const client = api(async (operation) => {
      sent.push(operation.kind);
      return operation.entityId === folder.id ? { folder } : { meeting };
    });

    await expect(new CatalogSync(store, client).flush()).resolves.toEqual({ state: "idle" });

    expect(sent).toEqual(["folder.create", "meeting.create"]);
    await expect(store.pendingOperations()).resolves.toEqual([]);
  });

  test("retains a failed operation with one bounded retry attempt and succeeds on a later flush", async () => {
    const store = catalog();
    catalogs.push(store);
    const meeting = await store.create("Agenda", null, now);
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("https://user:secret@example.test/?token=should-not-persist"))
      .mockResolvedValueOnce({ meeting });
    const sync = new CatalogSync(store, api(send));

    await expect(sync.flush()).resolves.toEqual({ state: "error" });
    await expect(store.pendingOperations()).resolves.toEqual([
      expect.objectContaining({ attempts: 1, lastError: "SYNC_FAILED" }),
    ]);
    await expect(sync.flush()).resolves.toEqual({ state: "idle" });
    expect(send).toHaveBeenCalledTimes(2);
    await expect(store.pendingOperations()).resolves.toEqual([]);
  });

  test("serializes concurrent flush calls so an operation is sent once", async () => {
    const store = catalog();
    catalogs.push(store);
    const meeting = await store.create("Agenda", null, now);
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const send = vi.fn(async () => { await waiting; return { meeting }; });
    const sync = new CatalogSync(store, api(send));
    const first = sync.flush();
    const second = sync.flush();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    release?.();

    await Promise.all([first, second]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("flushes only its starting outbox snapshot and leaves in-flight additions for the next call", async () => {
    const store = catalog();
    catalogs.push(store);
    const first = await store.create("First", null, now);
    const sent: string[] = [];
    const sync = new CatalogSync(store, api(async (operation) => {
      sent.push(operation.entityId);
      if (operation.entityId === first.id) await store.create("Later", null, "2026-08-21T00:01:00.000Z");
      return { meeting: (await store.get(operation.entityId))! };
    }));

    await expect(sync.flush()).resolves.toEqual({ state: "idle" });

    expect(sent).toEqual([first.id]);
    await expect(store.pendingOperations()).resolves.toEqual([
      expect.objectContaining({ kind: "meeting.create", payload: expect.objectContaining({ title: "Later" }) }),
    ]);
    await sync.flush();
    expect(sent).toHaveLength(2);
  });

  test("pauses on unauthorized and exposes conflicts without losing operations", async () => {
    const store = catalog();
    catalogs.push(store);
    await store.create("Agenda", null, now);
    const authSync = new CatalogSync(store, api(async () => { throw new CatalogApiError(401, "AUTH_REQUIRED"); }));

    await expect(authSync.flush()).resolves.toEqual({ state: "paused_auth" });
    await expect(store.pendingOperations()).resolves.toHaveLength(1);

    const conflictSync = new CatalogSync(store, api(async () => { throw new CatalogApiError(409, "MEETING_CONFLICT"); }));
    await expect(conflictSync.flush()).resolves.toEqual({ state: "conflict" });
    await expect(store.pendingOperations()).resolves.toEqual([
      expect.objectContaining({ attempts: 0, lastError: "CONFLICT" }),
    ]);
  });

  test("does not resend after a 401 until login explicitly resumes synchronization", async () => {
    const store = catalog();
    catalogs.push(store);
    const meeting = await store.create("Agenda", null, now);
    const client = api(vi.fn(async () => { throw new CatalogApiError(401, "AUTH_REQUIRED"); }));
    const sync = new CatalogSync(store, client);

    await expect(sync.flush()).resolves.toEqual({ state: "paused_auth" });
    await expect(sync.flush()).resolves.toEqual({ state: "paused_auth" });
    expect(client.send).toHaveBeenCalledTimes(1);

    client.send = vi.fn().mockResolvedValue({ meeting });
    sync.resumeAfterLogin();

    await expect(sync.flush()).resolves.toEqual({ state: "idle" });
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  test("does not discard an operation when an API response is invalid or for another entity", async () => {
    const store = catalog();
    catalogs.push(store);
    const meeting = await store.create("Agenda", null, now);
    const bad = { ...meeting, id: crypto.randomUUID() };
    const sync = new CatalogSync(store, api(async () => ({ meeting: bad })));

    await expect(sync.flush()).resolves.toEqual({ state: "error" });
    await expect(store.pendingOperations()).resolves.toEqual([
      expect.objectContaining({ entityId: meeting.id, attempts: 1, lastError: "SYNC_FAILED" }),
    ]);
  });

  test("accepts a returned Meeting for trash and restore operations", async () => {
    const store = catalog();
    catalogs.push(store);
    const created = await store.create("Agenda", null, now);
    const client = api(async (operation) => {
      const meeting = await store.get(operation.entityId);
      return { meeting: meeting! };
    });
    const sync = new CatalogSync(store, client);
    await sync.flush();
    await store.trash(created.id, "2026-08-21T00:01:00.000Z");

    await expect(sync.flush()).resolves.toEqual({ state: "idle" });
    await expect(store.pendingOperations()).resolves.toEqual([]);
  });

  test("does not let a create acknowledgement roll back a later local meeting rename", async () => {
    const store = catalog();
    catalogs.push(store);
    const created = await store.create("Before", null, now);
    await store.rename(created.id, "After", "2026-08-21T00:01:00.000Z");
    const sync = new CatalogSync(store, api(async (operation) => {
      if (operation.kind === "meeting.create") return { meeting: created };
      expect(await store.get(created.id)).toMatchObject({ title: "After" });
      return { meeting: { ...(await store.get(created.id))!, syncVersion: 2 } };
    }));

    await expect(sync.flush()).resolves.toEqual({ state: "idle" });
    await expect(store.get(created.id)).resolves.toMatchObject({ title: "After", syncVersion: 2 });
  });

  test("does not let a rename acknowledgement undo a later local trash", async () => {
    const store = catalog();
    catalogs.push(store);
    const created = await store.create("Before", null, now);
    const client = api(async () => ({ meeting: created }));
    const sync = new CatalogSync(store, client);
    await sync.flush();
    await store.rename(created.id, "After", "2026-08-21T00:01:00.000Z");
    const trashed = await store.trash(created.id, "2026-08-21T00:02:00.000Z");
    const calls: string[] = [];
    client.send = async (operation) => {
      calls.push(operation.kind);
      if (operation.kind === "meeting.rename") return { meeting: { ...created, title: "After", syncVersion: 1 } };
      expect(await store.get(created.id)).toMatchObject({ status: "trashed" });
      return { meeting: trashed };
    };

    await expect(sync.flush()).resolves.toEqual({ state: "idle" });
    expect(calls).toEqual(["meeting.rename", "meeting.trash"]);
    await expect(store.get(created.id)).resolves.toMatchObject({ status: "trashed" });
  });

  test("keeps a removed folder absent after acknowledging earlier folder and meeting creates", async () => {
    const store = catalog();
    catalogs.push(store);
    const folder = await store.createFolder("Work", now);
    const meeting = await store.create("Agenda", folder.id, "2026-08-21T00:01:00.000Z");
    await store.removeFolder(folder.id, "2026-08-21T00:02:00.000Z");
    const sync = new CatalogSync(store, api(async (operation) => {
      if (operation.kind === "folder.create") return { folder };
      if (operation.kind === "meeting.create") return { meeting };
      return {};
    }));

    await expect(sync.flush()).resolves.toEqual({ state: "idle" });
    await expect(store.listFolders()).resolves.toEqual([]);
    await expect(store.get(meeting.id)).resolves.toMatchObject({ folderId: null });
  });

  test("hydrates a clean device from the server catalog", async () => {
    const store = catalog();
    catalogs.push(store);
    const remoteFolder = {
      id: crypto.randomUUID(), name: "Remote", createdAt: now, updatedAt: now, syncVersion: 3,
    };
    const remoteMeeting = {
      id: crypto.randomUUID(), title: "Server note", folderId: remoteFolder.id, status: "ready" as const,
      startedAt: null, endedAt: null, createdAt: now, updatedAt: now, trashedAt: null, syncVersion: 3,
    };
    const client: MeetingCatalogApi = {
      send: vi.fn(), listFolders: vi.fn().mockResolvedValue([remoteFolder]), listMeetings: vi.fn().mockResolvedValue([remoteMeeting]),
    };

    await expect(new CatalogSync(store, client).refresh()).resolves.toEqual({ state: "idle" });
    await expect(store.listFolders()).resolves.toEqual([remoteFolder]);
    await expect(store.list({ includeTrashed: true })).resolves.toEqual([remoteMeeting]);
  });

  test("keeps pull-in-flight local changes and does not revive a pending folder removal", async () => {
    const store = catalog();
    catalogs.push(store);
    const remoteFolder = { id: crypto.randomUUID(), name: "Remote", createdAt: now, updatedAt: now, syncVersion: 1 };
    const remoteMeeting = {
      id: crypto.randomUUID(), title: "Server title", folderId: remoteFolder.id, status: "draft" as const,
      startedAt: null, endedAt: null, createdAt: now, updatedAt: now, trashedAt: null, syncVersion: 1,
    };
    let resolveFolders: ((value: typeof remoteFolder[]) => void) | undefined;
    let resolveMeetings: ((value: typeof remoteMeeting[]) => void) | undefined;
    const foldersPull = new Promise<typeof remoteFolder[]>((resolve) => { resolveFolders = resolve; });
    const meetingsPull = new Promise<typeof remoteMeeting[]>((resolve) => { resolveMeetings = resolve; });
    const client: MeetingCatalogApi = {
      send: vi.fn(), listFolders: vi.fn().mockResolvedValueOnce([remoteFolder]).mockImplementationOnce(() => foldersPull),
      listMeetings: vi.fn().mockResolvedValueOnce([remoteMeeting]).mockImplementationOnce(() => meetingsPull),
    };
    const sync = new CatalogSync(store, client);
    await sync.refresh();
    const refreshing = sync.refresh();
    await vi.waitFor(() => expect(client.listFolders).toHaveBeenCalledTimes(2));
    await store.rename(remoteMeeting.id, "Unsynced title", "2026-08-21T00:01:00.000Z");
    await store.removeFolder(remoteFolder.id, "2026-08-21T00:02:00.000Z");
    resolveFolders?.([remoteFolder]);
    resolveMeetings?.([remoteMeeting]);

    await expect(refreshing).resolves.toEqual({ state: "idle" });
    expect(client.listMeetings).toHaveBeenCalledTimes(2);
    await expect(store.listFolders()).resolves.toEqual([]);
    await expect(store.get(remoteMeeting.id)).resolves.toMatchObject({ title: "Unsynced title", folderId: null });
  });

  test("removes server-backed rows missing from a later authoritative refresh", async () => {
    const store = catalog();
    catalogs.push(store);
    const remoteFolder = { id: crypto.randomUUID(), name: "Remote", createdAt: now, updatedAt: now, syncVersion: 1 };
    const remoteMeeting = {
      id: crypto.randomUUID(), title: "Remote", folderId: remoteFolder.id, status: "draft" as const,
      startedAt: null, endedAt: null, createdAt: now, updatedAt: now, trashedAt: null, syncVersion: 1,
    };
    const client: MeetingCatalogApi = {
      send: vi.fn(), listFolders: vi.fn().mockResolvedValue([remoteFolder]), listMeetings: vi.fn().mockResolvedValue([remoteMeeting]),
    };
    const sync = new CatalogSync(store, client);
    await sync.refresh();
    client.listFolders = vi.fn().mockResolvedValue([]);
    client.listMeetings = vi.fn().mockResolvedValue([]);

    await sync.refresh();

    await expect(store.listFolders()).resolves.toEqual([]);
    await expect(store.list({ includeTrashed: true })).resolves.toEqual([]);
  });

  test("refreshes through the API and rewrites a pending create payload when its folder is authoritatively deleted", async () => {
    const store = catalog();
    catalogs.push(store);
    const remoteFolder = { id: crypto.randomUUID(), name: "Remote", createdAt: now, updatedAt: now, syncVersion: 1 };
    let resolveFolders: ((value: typeof remoteFolder[]) => void) | undefined;
    let resolveMeetings: ((value: []) => void) | undefined;
    const foldersPull = new Promise<typeof remoteFolder[]>((resolve) => { resolveFolders = resolve; });
    const meetingsPull = new Promise<[]>((resolve) => { resolveMeetings = resolve; });
    const client: MeetingCatalogApi = {
      send: vi.fn(), listFolders: vi.fn().mockResolvedValueOnce([remoteFolder]).mockImplementationOnce(() => foldersPull),
      listMeetings: vi.fn().mockResolvedValueOnce([]).mockImplementationOnce(() => meetingsPull),
    };
    const sync = new CatalogSync(store, client);
    await sync.refresh();
    const refreshing = sync.refresh();
    await vi.waitFor(() => expect(client.listFolders).toHaveBeenCalledTimes(2));
    const meeting = await store.create("Offline", remoteFolder.id, "2026-08-21T00:01:00.000Z");
    resolveFolders?.([]);
    resolveMeetings?.([]);

    await expect(refreshing).resolves.toEqual({ state: "idle" });
    expect(client.listMeetings).toHaveBeenCalledTimes(2);
    await expect(store.get(meeting.id)).resolves.toMatchObject({ folderId: null });
    await expect(store.pendingOperations()).resolves.toEqual([
      expect.objectContaining({ entityId: meeting.id, payload: expect.objectContaining({ folderId: null }) }),
    ]);
  });
});
