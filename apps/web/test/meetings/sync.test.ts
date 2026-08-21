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

  test("keeps pending local changes, does not revive a pending folder removal, and nulls orphan references", async () => {
    const store = catalog();
    catalogs.push(store);
    const localFolder = await store.createFolder("Local", now);
    const localMeeting = await store.create("Local draft", localFolder.id, now);
    await store.rename(localMeeting.id, "Unsynced title", "2026-08-21T00:01:00.000Z");
    await store.removeFolder(localFolder.id, "2026-08-21T00:02:00.000Z");
    const remoteFolder = { ...localFolder, name: "Server says present", syncVersion: 4 };
    const remoteMeeting = {
      ...localMeeting, title: "Server title", folderId: remoteFolder.id, status: "draft" as const, updatedAt: "2026-08-21T00:02:00.000Z", syncVersion: 4,
    };
    const client: MeetingCatalogApi = {
      send: vi.fn(), listFolders: vi.fn().mockResolvedValue([remoteFolder]), listMeetings: vi.fn().mockResolvedValue([remoteMeeting]),
    };

    await new CatalogSync(store, client).refresh();

    await expect(store.listFolders()).resolves.toEqual([]);
    await expect(store.get(localMeeting.id)).resolves.toMatchObject({ title: "Unsynced title", folderId: null });
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
});
