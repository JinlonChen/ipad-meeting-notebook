import { afterEach, describe, expect, test, vi } from "vitest";

import { MeetingCatalogRepository } from "../../src/meetings/repository.js";
import { MeetingCatalogHttpApi } from "../../src/meetings/api.js";
import { CatalogApiError, CatalogSync, type MeetingCatalogApi } from "../../src/meetings/sync.js";

const now = "2026-08-21T00:00:00.000Z";
const userA = "00000000-0000-4000-8000-00000000000a";
const userB = "00000000-0000-4000-8000-00000000000b";
let databaseNumber = 0;

async function catalog(): Promise<MeetingCatalogRepository> {
  const repository = new MeetingCatalogRepository(`meeting-catalog-sync-${databaseNumber++}`);
  await repository.activateUser(userA);
  return repository;
}

function api(send: MeetingCatalogApi["send"]): MeetingCatalogApi {
  return { send, listMeetings: vi.fn().mockResolvedValue([]), listFolders: vi.fn().mockResolvedValue([]) };
}

describe("CatalogSync", () => {
  const catalogs: MeetingCatalogRepository[] = [];

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(catalogs.splice(0).map((item) => item.deleteDatabase()));
  });

  test("does not call the remote catalog without an active user context", async () => {
    const store = new MeetingCatalogRepository(`meeting-catalog-sync-${databaseNumber++}`);
    catalogs.push(store);
    const client = api(vi.fn());

    await expect(new CatalogSync(store, client).flush()).resolves.toEqual({ state: "paused_auth" });
    expect(client.send).not.toHaveBeenCalled();
  });

  test("pauses pull synchronization on a 401 with an empty outbox until login resumes it", async () => {
    const store = await catalog();
    catalogs.push(store);
    const client: MeetingCatalogApi = {
      send: vi.fn(),
      listFolders: vi.fn().mockRejectedValueOnce(new CatalogApiError(401, "AUTH_REQUIRED")).mockResolvedValue([]),
      listMeetings: vi.fn().mockResolvedValue([]),
    };
    const sync = new CatalogSync(store, client);

    await expect(sync.refresh()).resolves.toEqual({ state: "paused_auth" });
    await expect(sync.refresh()).resolves.toEqual({ state: "paused_auth" });
    expect(client.listFolders).toHaveBeenCalledTimes(1);
    sync.resumeAfterLogin();
    await expect(sync.refresh()).resolves.toEqual({ state: "idle" });
  });

  test("starts a new refresh epoch after login instead of coalescing with a stale unauthorized pull", async () => {
    const store = await catalog();
    catalogs.push(store);
    let rejectOld!: (error: CatalogApiError) => void;
    const oldPull = new Promise<never>((_, reject) => { rejectOld = reject; });
    const client: MeetingCatalogApi = {
      send: vi.fn(),
      listFolders: vi.fn().mockImplementationOnce(() => oldPull).mockResolvedValueOnce([]),
      listMeetings: vi.fn().mockResolvedValue([]),
    };
    const sync = new CatalogSync(store, client);
    const beforeLogin = sync.refresh();
    await vi.waitFor(() => expect(client.listFolders).toHaveBeenCalledTimes(1));
    sync.resumeAfterLogin();
    const afterLogin = sync.refresh();
    expect(afterLogin).not.toBe(beforeLogin);
    rejectOld(new CatalogApiError(401, "AUTH_REQUIRED"));

    await expect(beforeLogin).resolves.toEqual({ state: "paused_auth" });
    await expect(afterLogin).resolves.toEqual({ state: "idle" });
    expect(client.listFolders).toHaveBeenCalledTimes(2);
  });

  test("flushes durable operations in sequence so folders arrive before referencing meetings", async () => {
    const store = await catalog();
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

  test("flushes only the active user's outbox and preserves another user's pending work", async () => {
    const store = await catalog();
    catalogs.push(store);
    await store.activateUser(userA);
    const meetingA = await store.create("A pending", null, now);
    await store.activateUser(userB);
    const meetingB = await store.create("B pending", null, "2026-08-21T00:01:00.000Z");
    const send = vi.fn().mockResolvedValue({ meeting: meetingB });

    await expect(new CatalogSync(store, api(send)).flush()).resolves.toEqual({ state: "idle" });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ entityId: meetingB.id }), userB);
    await expect(store.pendingOperations()).resolves.toEqual([]);
    await store.activateUser(userA);
    await expect(store.pendingOperations()).resolves.toEqual([expect.objectContaining({ entityId: meetingA.id })]);
  });

  test("applies an in-flight acknowledgement to its source user database after a switch", async () => {
    const store = await catalog();
    catalogs.push(store);
    await store.activateUser(userA);
    const meetingA = await store.create("A pending", null, now);
    let release!: (value: { meeting: typeof meetingA }) => void;
    const response = new Promise<{ meeting: typeof meetingA }>((resolve) => { release = resolve; });
    const send = vi.fn(() => response);
    const sync = new CatalogSync(store, api(send));
    const flushing = sync.flush();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ entityId: meetingA.id }), userA);

    await store.activateUser(userB);
    const meetingB = await store.create("B local", null, "2026-08-21T00:01:00.000Z");
    release({ meeting: meetingA });
    await expect(flushing).resolves.toEqual({ state: "idle" });

    await expect(store.list({ includeTrashed: true })).resolves.toEqual([meetingB]);
    await expect(store.pendingOperations()).resolves.toEqual([expect.objectContaining({ entityId: meetingB.id })]);
    await store.activateUser(userA);
    await expect(store.pendingOperations()).resolves.toEqual([]);
  });

  test("stops a stale multi-operation flush after acknowledging its in-flight operation", async () => {
    const store = await catalog();
    catalogs.push(store);
    await store.activateUser(userA);
    const first = await store.create("A first", null, now);
    const second = await store.create("A second", null, "2026-08-21T00:01:00.000Z");
    let release!: (value: { meeting: typeof first }) => void;
    const firstResponse = new Promise<{ meeting: typeof first }>((resolve) => { release = resolve; });
    const send = vi.fn().mockImplementationOnce(() => firstResponse).mockResolvedValue({ meeting: second });
    const sync = new CatalogSync(store, api(send));
    const flushing = sync.flush();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

    sync.pauseForUserChange();
    await store.activateUser(userB);
    release({ meeting: first });

    await expect(flushing).resolves.toEqual({ state: "paused_auth" });
    expect(send).toHaveBeenCalledOnce();
    await expect(store.pendingOperations()).resolves.toEqual([]);
    await store.activateUser(userA);
    await expect(store.pendingOperations()).resolves.toEqual([expect.objectContaining({ entityId: second.id })]);
  });

  test("discards a stale pull response after switching users", async () => {
    const store = await catalog();
    catalogs.push(store);
    await store.activateUser(userA);
    const remoteA = {
      id: crypto.randomUUID(), title: "A remote", folderId: null, status: "ready" as const,
      startedAt: null, endedAt: null, createdAt: now, updatedAt: now, trashedAt: null, syncVersion: 1, note: "",
    };
    let releaseFolders!: (value: []) => void;
    let releaseMeetings!: (value: [typeof remoteA]) => void;
    const client: MeetingCatalogApi = {
      send: vi.fn(),
      listFolders: vi.fn(() => new Promise<[]>((resolve) => { releaseFolders = resolve; })),
      listMeetings: vi.fn(() => new Promise<[typeof remoteA]>((resolve) => { releaseMeetings = resolve; })),
    };
    const sync = new CatalogSync(store, client);
    const refreshing = sync.refresh();
    await vi.waitFor(() => expect(client.listMeetings).toHaveBeenCalledOnce());

    sync.pauseForUserChange();
    await store.activateUser(userB);
    const localB = await store.create("B local", null, "2026-08-21T00:01:00.000Z");
    releaseFolders([]);
    releaseMeetings([remoteA]);

    await expect(refreshing).resolves.toEqual({ state: "paused_auth" });
    await expect(store.list({ includeTrashed: true })).resolves.toEqual([localB]);
    await store.activateUser(userA);
    await expect(store.list({ includeTrashed: true })).resolves.toEqual([]);
  });

  test("retains a failed operation with one bounded retry attempt and succeeds on a later flush", async () => {
    const store = await catalog();
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
    const store = await catalog();
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

  test("clears a rejected current task without creating an unhandled rejection", async () => {
    const failure = new Error("indexeddb unavailable");
    const repository = {
      currentUserId: vi.fn().mockReturnValue(userA),
      pendingOperations: vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce([]),
    } as unknown as MeetingCatalogRepository;
    const sync = new CatalogSync(repository, api(vi.fn()));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(sync.flush()).rejects.toBe(failure);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
      await expect(sync.flush()).resolves.toEqual({ state: "idle" });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("flushes only its starting outbox snapshot and leaves in-flight additions for the next call", async () => {
    const store = await catalog();
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

  test("queues one trailing refresh for mutations added while the current refresh is pulling", async () => {
    const store = await catalog();
    catalogs.push(store);
    let resolveFolders: ((value: []) => void) | undefined;
    let resolveMeetings: ((value: []) => void) | undefined;
    const foldersPull = new Promise<[]>((resolve) => { resolveFolders = resolve; });
    const meetingsPull = new Promise<[]>((resolve) => { resolveMeetings = resolve; });
    let remoteMeeting: Awaited<ReturnType<MeetingCatalogRepository["get"]>>;
    const client: MeetingCatalogApi = {
      send: vi.fn(async (operation) => {
        remoteMeeting = await store.get(operation.entityId);
        return { meeting: remoteMeeting! };
      }),
      listFolders: vi.fn().mockImplementationOnce(() => foldersPull).mockResolvedValue([]),
      listMeetings: vi.fn().mockImplementationOnce(() => meetingsPull).mockImplementation(() => Promise.resolve(remoteMeeting ? [remoteMeeting] : [])),
    };
    const sync = new CatalogSync(store, client);
    const refreshing = sync.refresh();
    await vi.waitFor(() => expect(client.listMeetings).toHaveBeenCalledTimes(1));
    await store.create("Created during pull", null, "2026-08-21T00:01:00.000Z");
    const trailing = sync.scheduleRefresh();
    const coalesced = sync.scheduleRefresh();

    expect(coalesced).toBe(trailing);
    expect(client.send).not.toHaveBeenCalled();
    resolveFolders?.([]);
    resolveMeetings?.([]);

    await expect(refreshing).resolves.toEqual({ state: "idle" });
    await expect(trailing).resolves.toEqual({ state: "idle" });
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.listMeetings).toHaveBeenCalledTimes(2);
    await expect(store.pendingOperations()).resolves.toEqual([]);
  });

  test("serializes a stale refresh ahead of flush so pending local data and the later acknowledgement win", async () => {
    const store = await catalog();
    catalogs.push(store);
    const meeting = {
      id: crypto.randomUUID(), title: "Version one", folderId: null, status: "draft" as const,
      startedAt: null, endedAt: null, createdAt: now, updatedAt: now, trashedAt: null, syncVersion: 1, note: "",
    };
    let resolveMeetings: ((value: typeof meeting[]) => void) | undefined;
    const stalePull = new Promise<typeof meeting[]>((resolve) => { resolveMeetings = resolve; });
    const client: MeetingCatalogApi = {
      send: vi.fn(async (operation) => ({ meeting: { ...meeting, title: "Version two", syncVersion: 2, updatedAt: operation.createdAt } })),
      listFolders: vi.fn().mockResolvedValue([]),
      listMeetings: vi.fn().mockResolvedValueOnce([meeting]).mockImplementationOnce(() => stalePull),
    };
    const sync = new CatalogSync(store, client);
    await sync.refresh();
    const refreshing = sync.refresh();
    await vi.waitFor(() => expect(client.listMeetings).toHaveBeenCalledTimes(2));
    await store.rename(meeting.id, "Local rename", "2026-08-21T00:01:00.000Z");
    const flushing = sync.flush();
    expect(client.send).not.toHaveBeenCalled();
    resolveMeetings?.([meeting]);

    await expect(refreshing).resolves.toEqual({ state: "idle" });
    await expect(store.get(meeting.id)).resolves.toMatchObject({ title: "Local rename", syncVersion: 2 });
    await expect(flushing).resolves.toEqual({ state: "idle" });
    await expect(store.get(meeting.id)).resolves.toMatchObject({ title: "Version two", syncVersion: 2 });
    await expect(store.pendingOperations()).resolves.toEqual([]);
  });

  test("queues refresh behind an active flush", async () => {
    const store = await catalog();
    catalogs.push(store);
    const meeting = await store.create("Pending", null, now);
    let release: (() => void) | undefined;
    const sent = new Promise<void>((resolve) => { release = resolve; });
    const client: MeetingCatalogApi = {
      send: vi.fn(async () => { await sent; return { meeting }; }),
      listFolders: vi.fn().mockResolvedValue([]),
      listMeetings: vi.fn().mockResolvedValue([]),
    };
    const sync = new CatalogSync(store, client);
    const flushing = sync.flush();
    await vi.waitFor(() => expect(client.send).toHaveBeenCalledTimes(1));
    const refreshing = sync.refresh();

    expect(client.listFolders).not.toHaveBeenCalled();
    release?.();
    await Promise.all([flushing, refreshing]);
    expect(client.listFolders).toHaveBeenCalledTimes(1);
    expect(client.listMeetings).toHaveBeenCalledTimes(1);
  });

  test("coalesces a refresh requested during a failed flush without retrying the retained operation", async () => {
    const store = await catalog();
    catalogs.push(store);
    await store.create("Pending", null, now);
    let rejectSend: ((error: Error) => void) | undefined;
    const sendFailure = new Promise<never>((_, reject) => { rejectSend = reject; });
    const client: MeetingCatalogApi = {
      send: vi.fn(() => sendFailure), listFolders: vi.fn(), listMeetings: vi.fn(),
    };
    const sync = new CatalogSync(store, client);
    const flushing = sync.flush();
    await vi.waitFor(() => expect(client.send).toHaveBeenCalledTimes(1));
    const refreshing = sync.refresh();
    rejectSend?.(new Error("offline"));

    await expect(flushing).resolves.toEqual({ state: "error" });
    await expect(refreshing).resolves.toEqual({ state: "error" });
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.listFolders).not.toHaveBeenCalled();
    expect(client.listMeetings).not.toHaveBeenCalled();
    await expect(store.pendingOperations()).resolves.toEqual([expect.objectContaining({ attempts: 1 })]);
  });

  test("coalesces a flush requested during a refresh whose internal flush fails", async () => {
    const store = await catalog();
    catalogs.push(store);
    await store.create("Pending", null, now);
    let rejectSend: ((error: Error) => void) | undefined;
    const sendFailure = new Promise<never>((_, reject) => { rejectSend = reject; });
    const client: MeetingCatalogApi = {
      send: vi.fn(() => sendFailure), listFolders: vi.fn(), listMeetings: vi.fn(),
    };
    const sync = new CatalogSync(store, client);
    const refreshing = sync.refresh();
    await vi.waitFor(() => expect(client.send).toHaveBeenCalledTimes(1));
    const flushing = sync.flush();
    rejectSend?.(new Error("offline"));

    await expect(refreshing).resolves.toEqual({ state: "error" });
    await expect(flushing).resolves.toEqual({ state: "error" });
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.listFolders).not.toHaveBeenCalled();
    expect(client.listMeetings).not.toHaveBeenCalled();
    await expect(store.pendingOperations()).resolves.toEqual([expect.objectContaining({ attempts: 1 })]);
  });

  test.each([
    [new CatalogApiError(401, "AUTH_REQUIRED"), { state: "paused_auth" }],
    [new CatalogApiError(409, "MEETING_CONFLICT"), { state: "conflict" }],
  ] as const)("coalesces %s without immediately retrying", async (error, expected) => {
    const store = await catalog();
    catalogs.push(store);
    await store.create("Pending", null, now);
    let rejectSend: ((error: CatalogApiError) => void) | undefined;
    const sendFailure = new Promise<never>((_, reject) => { rejectSend = reject; });
    const client: MeetingCatalogApi = {
      send: vi.fn(() => sendFailure), listFolders: vi.fn(), listMeetings: vi.fn(),
    };
    const sync = new CatalogSync(store, client);
    const flushing = sync.flush();
    await vi.waitFor(() => expect(client.send).toHaveBeenCalledTimes(1));
    const refreshing = sync.refresh();
    rejectSend?.(error);

    await expect(flushing).resolves.toEqual(expected);
    await expect(refreshing).resolves.toEqual(expected);
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.listFolders).not.toHaveBeenCalled();
    expect(client.listMeetings).not.toHaveBeenCalled();
  });

  test("pauses on unauthorized and exposes conflicts without losing operations", async () => {
    const store = await catalog();
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
    const store = await catalog();
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
    const store = await catalog();
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
    const store = await catalog();
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
    const store = await catalog();
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
    const store = await catalog();
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
    const store = await catalog();
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

  test("does not roll a meeting back when a create acknowledgement predates a pending folder removal", async () => {
    const store = await catalog();
    catalogs.push(store);
    const folder = await store.createFolder("Work", now);
    const meeting = await store.create("Agenda", folder.id, "2026-08-21T00:01:00.000Z");
    await store.removeFolder(folder.id, "2026-08-21T00:02:00.000Z");
    const operations = await store.pendingOperations();
    await store.syncApplySuccessfulOperation(operations[0]!, { folder });
    await store.syncApplySuccessfulOperation(operations[1]!, { meeting });

    expect(await store.get(meeting.id)).toMatchObject({ folderId: null, syncVersion: 1 });
    expect((await store.pendingOperations()).find((item) => item.kind === "folder.remove")?.payload).toMatchObject({ expectedSyncVersion: 0 });
  });

  test("clears a folder removal when the first 204 was lost and retry returns only FOLDER_NOT_FOUND", async () => {
    const store = await catalog();
    catalogs.push(store);
    const folder = await store.createFolder("Work", now);
    const send = vi.fn()
      .mockResolvedValueOnce({ folder })
      .mockRejectedValueOnce(new Error("response lost after 204"))
      .mockRejectedValueOnce(new CatalogApiError(404, "FOLDER_NOT_FOUND"));
    const sync = new CatalogSync(store, api(send));
    await expect(sync.flush()).resolves.toEqual({ state: "idle" });
    await store.removeFolder(folder.id, "2026-08-21T00:01:00.000Z");
    await expect(sync.flush()).resolves.toEqual({ state: "error" });
    await expect(sync.flush()).resolves.toEqual({ state: "idle" });
    await expect(store.pendingOperations()).resolves.toEqual([]);
  });

  test("flushes a conditional rename through the HTTP adapter with its stable operation key", async () => {
    const store = await catalog();
    catalogs.push(store);
    const created = await store.create("Before", null, now);
    await store.syncApplySuccessfulOperation((await store.pendingOperations())[0]!, { meeting: created });
    const renamed = await store.rename(created.id, "After", "2026-08-21T00:01:00.000Z");
    const operation = (await store.pendingOperations())[0]!;
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(renamed), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(new CatalogSync(store, new MeetingCatalogHttpApi(fetcher)).flush()).resolves.toEqual({ state: "idle" });
    expect(fetcher).toHaveBeenCalledWith(`/api/meetings/${created.id}`, expect.objectContaining({
      method: "PATCH",
      headers: expect.objectContaining({ "idempotency-key": operation.id }),
      body: JSON.stringify({ title: "After", expectedSyncVersion: 0 }),
    }));
  });

  test("turns a typed missing-folder rename response into a resolvable conflict and resumes pulling", async () => {
    const store = await catalog();
    catalogs.push(store);
    const remoteFolder = { id: crypto.randomUUID(), name: "Server folder", createdAt: now, updatedAt: now, syncVersion: 2 };
    await store.syncRefresh([remoteFolder], []);
    await store.renameFolder(remoteFolder.id, "Offline rename", "2026-08-21T00:01:00.000Z");
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ code: "FOLDER_NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
      }
      if (String(input) === "/api/folders") return new Response(JSON.stringify([]), { status: 200 });
      if (String(input) === "/api/meetings?includeTrashed=true") return new Response(JSON.stringify([]), { status: 200 });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    const sync = new CatalogSync(store, new MeetingCatalogHttpApi(fetcher));

    await expect(sync.refresh()).resolves.toEqual({ state: "conflict" });
    const pending = await store.pendingStatus();
    expect(pending).toEqual({
      count: 1,
      conflict: expect.objectContaining({ kind: "folder.rename", entityName: "Offline rename" }),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await store.resolveConflict(pending.conflict!.sequence);
    await expect(sync.refresh()).resolves.toEqual({ state: "idle" });
    await expect(store.pendingOperations()).resolves.toEqual([]);
    await expect(store.listFolders()).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test.each(["meeting.rename", "meeting.trash", "meeting.restore"] as const)("turns a typed missing meeting during conditional %s into a resolvable conflict", async (kind) => {
    const store = await catalog();
    catalogs.push(store);
    const remoteMeeting = {
      id: crypto.randomUUID(), title: "Server meeting", folderId: null,
      status: (kind === "meeting.restore" ? "trashed" : "draft") as "trashed" | "draft",
      startedAt: null, endedAt: null, createdAt: now, updatedAt: now,
      trashedAt: kind === "meeting.restore" ? now : null, syncVersion: 2,
    };
    await store.syncRefresh([], [remoteMeeting]);
    if (kind === "meeting.rename") await store.rename(remoteMeeting.id, "Offline rename", "2026-08-21T00:01:00.000Z");
    if (kind === "meeting.trash") await store.trash(remoteMeeting.id, "2026-08-21T00:01:00.000Z");
    if (kind === "meeting.restore") await store.restore(remoteMeeting.id, "2026-08-21T00:01:00.000Z");
    const sync = new CatalogSync(store, api(async () => { throw new CatalogApiError(404, "MEETING_NOT_FOUND"); }));

    await expect(sync.refresh()).resolves.toEqual({ state: "conflict" });
    const pending = await store.pendingStatus();
    expect(pending.conflict).toEqual(expect.objectContaining({ kind, entityName: kind === "meeting.rename" ? "Offline rename" : "Server meeting" }));

    await store.resolveConflict(pending.conflict!.sequence);
    await expect(sync.refresh()).resolves.toEqual({ state: "idle" });
    await expect(store.pendingOperations()).resolves.toEqual([]);
    await expect(store.get(remoteMeeting.id)).resolves.toBeNull();
  });

  test("turns a typed missing folder reference during meeting create into a resolvable conflict", async () => {
    const store = await catalog();
    catalogs.push(store);
    const remoteFolder = { id: crypto.randomUUID(), name: "Deleted folder", createdAt: now, updatedAt: now, syncVersion: 1 };
    await store.syncRefresh([remoteFolder], []);
    const localMeeting = await store.create("Offline meeting", remoteFolder.id, "2026-08-21T00:01:00.000Z");
    const sync = new CatalogSync(store, api(async () => { throw new CatalogApiError(404, "FOLDER_NOT_FOUND"); }));

    await expect(sync.refresh()).resolves.toEqual({ state: "conflict" });
    const pending = await store.pendingStatus();
    expect(pending.conflict).toEqual(expect.objectContaining({ kind: "meeting.create", entityName: "Offline meeting" }));

    await store.resolveConflict(pending.conflict!.sequence);
    await expect(sync.refresh()).resolves.toEqual({ state: "idle" });
    await expect(store.pendingOperations()).resolves.toEqual([]);
    await expect(store.get(localMeeting.id)).resolves.toBeNull();
  });

  test("keeps FOLDER_NOT_FOUND for a meeting create without a folder reference as a normal sync error", async () => {
    const store = await catalog();
    catalogs.push(store);
    await store.create("Unfiled meeting", null, now);

    await expect(new CatalogSync(store, api(async () => { throw new CatalogApiError(404, "FOLDER_NOT_FOUND"); })).flush()).resolves.toEqual({ state: "error" });
    await expect(store.pendingOperations()).resolves.toEqual([expect.objectContaining({ attempts: 1, lastError: "SYNC_FAILED" })]);
  });

  test.each([
    ["folder rename with a meeting code", "folder"],
    ["meeting rename with a folder code", "meeting"],
  ] as const)("keeps %s as a normal sync error", async (_name, entity) => {
    const store = await catalog();
    catalogs.push(store);
    if (entity === "folder") {
      const remoteFolder = { id: crypto.randomUUID(), name: "Remote", createdAt: now, updatedAt: now, syncVersion: 1 };
      await store.syncRefresh([remoteFolder], []);
      await store.renameFolder(remoteFolder.id, "Local", "2026-08-21T00:01:00.000Z");
    } else {
      const remoteMeeting = { id: crypto.randomUUID(), title: "Remote", folderId: null, status: "draft" as const, startedAt: null, endedAt: null, createdAt: now, updatedAt: now, trashedAt: null, syncVersion: 1 };
      await store.syncRefresh([], [remoteMeeting]);
      await store.rename(remoteMeeting.id, "Local", "2026-08-21T00:01:00.000Z");
    }
    const code = entity === "folder" ? "MEETING_NOT_FOUND" : "FOLDER_NOT_FOUND";

    await expect(new CatalogSync(store, api(async () => { throw new CatalogApiError(404, code); })).flush()).resolves.toEqual({ state: "error" });
    await expect(store.pendingOperations()).resolves.toEqual([expect.objectContaining({ attempts: 1, lastError: "SYNC_FAILED" })]);
  });

  test("hydrates a clean device from the server catalog", async () => {
    const store = await catalog();
    catalogs.push(store);
    const remoteFolder = {
      id: crypto.randomUUID(), name: "Remote", createdAt: now, updatedAt: now, syncVersion: 3,
    };
    const remoteMeeting = {
      id: crypto.randomUUID(), title: "Server note", folderId: remoteFolder.id, status: "ready" as const,
      startedAt: null, endedAt: null, createdAt: now, updatedAt: now, trashedAt: null, syncVersion: 3, note: "",
    };
    const client: MeetingCatalogApi = {
      send: vi.fn(), listFolders: vi.fn().mockResolvedValue([remoteFolder]), listMeetings: vi.fn().mockResolvedValue([remoteMeeting]),
    };

    await expect(new CatalogSync(store, client).refresh()).resolves.toEqual({ state: "idle" });
    await expect(store.listFolders()).resolves.toEqual([remoteFolder]);
    await expect(store.list({ includeTrashed: true })).resolves.toEqual([remoteMeeting]);
  });

  test("refreshes from one authenticated snapshot when the API provides pull", async () => {
    const store = await catalog();
    catalogs.push(store);
    const pull = vi.fn().mockResolvedValue({ folders: [], meetings: [] });
    const client: MeetingCatalogApi = {
      send: vi.fn(),
      pull,
      listFolders: vi.fn().mockRejectedValue(new Error("split pull must not run")),
      listMeetings: vi.fn().mockRejectedValue(new Error("split pull must not run")),
    };

    await expect(new CatalogSync(store, client).refresh()).resolves.toEqual({ state: "idle" });
    expect(pull).toHaveBeenCalledWith(userA);
    expect(client.listFolders).not.toHaveBeenCalled();
    expect(client.listMeetings).not.toHaveBeenCalled();
  });

  test("keeps pull-in-flight local changes and does not revive a pending folder removal", async () => {
    const store = await catalog();
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
    const store = await catalog();
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
    const store = await catalog();
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
