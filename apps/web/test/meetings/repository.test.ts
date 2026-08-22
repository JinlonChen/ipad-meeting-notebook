import { afterEach, describe, expect, test } from "vitest";
import Dexie from "dexie";

import { MeetingCatalogRepository } from "../../src/meetings/repository.js";

const now = "2026-08-21T00:00:00.000Z";

describe("MeetingCatalogRepository", () => {
  const repositories: MeetingCatalogRepository[] = [];
  let databaseNumber = 0;

  function repository(): MeetingCatalogRepository {
    const value = new MeetingCatalogRepository(`meeting-catalog-test-${databaseNumber++}`);
    repositories.push(value);
    return value;
  }

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(repositories.splice(0).map((repository) => repository.deleteDatabase()));
  });

  test("creates a meeting immediately with one durable create operation", async () => {
    const catalog = repository();

    const meeting = await catalog.create("  Sprint planning  ", null, now);

    await expect(catalog.list()).resolves.toEqual([meeting]);
    await expect(catalog.pendingOperations()).resolves.toEqual([
      expect.objectContaining({
        entityId: meeting.id,
        kind: "meeting.create",
        payload: {
          id: meeting.id,
          title: "Sprint planning",
          folderId: null,
          clientCreatedAt: now,
        },
        attempts: 0,
        lastError: null,
      }),
    ]);
  });

  test("backfills one stable UUID for a legacy outbox row without an operation id", async () => {
    const name = `meeting-catalog-test-${databaseNumber++}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores({ meetings: "id,updatedAt,status,folderId,title", folders: "id,name,updatedAt", outbox: "++sequence,id,entityId,kind,createdAt", settings: "key" });
    await legacy.table("outbox").add({ entityId: crypto.randomUUID(), kind: "meeting.create", payload: {}, createdAt: now, attempts: 0, lastError: null });
    legacy.close();
    const catalog = new MeetingCatalogRepository(name);
    repositories.push(catalog);

    const first = (await catalog.pendingOperations())[0]!;
    const second = (await catalog.pendingOperations())[0]!;
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.id).toBe(first.id);
  });

  test("rejects an unknown folder without writing either side of the mutation", async () => {
    const catalog = repository();

    await expect(catalog.create("Cannot save", "00000000-0000-4000-8000-000000000001", now)).rejects.toMatchObject({ name: "FolderNotFoundError" });

    await expect(catalog.list({ includeTrashed: true })).resolves.toEqual([]);
    await expect(catalog.pendingOperations()).resolves.toEqual([]);
  });

  test("removing a folder leaves its meetings unfiled and records only the folder mutation", async () => {
    const catalog = repository();
    const folder = await catalog.createFolder("Work", now);
    const meeting = await catalog.create("Notes", folder.id, "2026-08-21T00:01:00.000Z");

    await catalog.removeFolder(folder.id, "2026-08-21T00:02:00.000Z");

    await expect(catalog.get(meeting.id)).resolves.toMatchObject({ folderId: null, updatedAt: "2026-08-21T00:02:00.000Z", syncVersion: 1 });
    await expect(catalog.pendingOperations()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "folder.create", entityId: folder.id }),
      expect.objectContaining({ kind: "meeting.create", entityId: meeting.id }),
      expect.objectContaining({ kind: "folder.remove", entityId: folder.id }),
    ]));
  });

  test("makes trash and restore idempotent while preserving their one-operation transitions", async () => {
    const catalog = repository();
    const meeting = await catalog.create("Notes", null, now);
    const trashed = await catalog.trash(meeting.id, "2026-08-21T00:01:00.000Z");
    const duplicateTrash = await catalog.trash(meeting.id, "2026-08-21T00:02:00.000Z");
    const restored = await catalog.restore(meeting.id, "2026-08-21T00:03:00.000Z");
    const duplicateRestore = await catalog.restore(meeting.id, "2026-08-21T00:04:00.000Z");

    expect(duplicateTrash).toEqual(trashed);
    expect(duplicateRestore).toEqual(restored);
    expect(restored).toMatchObject({ status: "draft", trashedAt: null, syncVersion: 2 });
    await expect(catalog.pendingOperations()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "meeting.trash" }),
      expect.objectContaining({ kind: "meeting.restore" }),
    ]));
    expect((await catalog.pendingOperations()).filter((item) => item.kind === "meeting.trash" || item.kind === "meeting.restore")).toHaveLength(2);
  });

  test("restores the prior active status and falls back to draft for remotely trashed meetings", async () => {
    const catalog = repository();
    const ready = {
      id: crypto.randomUUID(), title: "Completed", folderId: null, status: "ready" as const,
      startedAt: now, endedAt: "2026-08-21T00:30:00.000Z", createdAt: now, updatedAt: now, trashedAt: null, syncVersion: 1,
    };
    await catalog.syncRefresh([], [ready]);

    await catalog.trash(ready.id, "2026-08-21T00:31:00.000Z");
    const restored = await catalog.restore(ready.id, "2026-08-21T00:32:00.000Z");
    expect(restored).toMatchObject({ status: "ready", trashedAt: null });
    const restoreOperation = (await catalog.pendingOperations()).find((item) => item.kind === "meeting.restore")!;
    await catalog.syncApplySuccessfulOperation(restoreOperation, { meeting: restored });
    await expect(catalog.get(ready.id)).resolves.toMatchObject({ status: "ready" });

    const remoteTrashed = { ...ready, id: crypto.randomUUID(), status: "trashed" as const, trashedAt: now };
    await catalog.syncRefresh([], [remoteTrashed]);
    await expect(catalog.restore(remoteTrashed.id, "2026-08-21T00:33:00.000Z")).resolves.toMatchObject({ status: "draft", trashedAt: null });
  });

  test("filters a literal, case-insensitive search string", async () => {
    const catalog = repository();
    await catalog.create("100%_Done", null, now);
    await catalog.create("100AXDone", null, "2026-08-21T00:01:00.000Z");

    await expect(catalog.list({ search: "%_dOnE" })).resolves.toMatchObject([{ title: "100%_Done" }]);
  });

  test("keeps catalog data on logout while dropping an expired or cleared device marker", async () => {
    const catalog = repository();
    const meeting = await catalog.create("Offline", null, now);
    const access = await catalog.authorizeDevice("2026-09-20T00:00:00.000Z", now);
    await expect(catalog.validDeviceAccess("2026-08-22T00:00:00.000Z")).resolves.toEqual(access);
    await expect(catalog.hasDeviceAccess("2026-08-22T00:00:00.000Z")).resolves.toBe(true);
    await expect(catalog.validDeviceAccess("2026-09-20T00:00:00.000Z")).resolves.toBeNull();
    await expect(catalog.hasDeviceAccess("2026-09-20T00:00:00.000Z")).resolves.toBe(false);

    await catalog.clearDeviceAccess();

    await expect(catalog.hasDeviceAccess("2026-08-22T00:00:00.000Z")).resolves.toBe(false);
    await expect(catalog.get(meeting.id)).resolves.toEqual(meeting);
    await expect(catalog.pendingOperations()).resolves.toHaveLength(1);
  });

  test("uses shared schemas to reject invalid titles and identifiers", async () => {
    const catalog = repository();

    await expect(catalog.create("   ", null, now)).rejects.toBeInstanceOf(Error);
    await expect(catalog.rename("not-a-uuid", "Valid", now)).rejects.toBeInstanceOf(Error);
    await expect(catalog.createFolder(" ".repeat(81), now)).rejects.toBeInstanceOf(Error);
  });

  test("rolls back an entity when its durable outbox write fails", async () => {
    const catalog = new MeetingCatalogRepository(`meeting-catalog-failing-outbox-${databaseNumber++}`, {
      beforeOutboxWrite: () => { throw new Error("outbox unavailable"); },
    });
    repositories.push(catalog);

    await expect(catalog.create("Cannot persist", null, now)).rejects.toThrow("outbox unavailable");

    await expect(catalog.list({ includeTrashed: true })).resolves.toEqual([]);
    await expect(catalog.pendingOperations()).resolves.toEqual([]);
  });

  test("always writes the outbox row after a non-throwing synchronous hook", async () => {
    const catalog = new MeetingCatalogRepository(`meeting-catalog-outbox-hook-${databaseNumber++}`, {
      beforeOutboxWrite: () => undefined,
    });
    repositories.push(catalog);

    const meeting = await catalog.create("Durable", null, now);

    await expect(catalog.pendingOperations()).resolves.toEqual([
      expect.objectContaining({ entityId: meeting.id, kind: "meeting.create" }),
    ]);
  });

  const invalidAsyncOutboxHook: import("../../src/meetings/repository.js").MeetingCatalogRepositoryOptions = {
    // @ts-expect-error Hooks are deliberately synchronous so no external async work can escape the Dexie transaction.
    beforeOutboxWrite: async () => undefined,
  };
  void invalidAsyncOutboxHook;

  test("writes exact ordered payloads for meeting and folder mutations", async () => {
    const catalog = repository();
    const folder = await catalog.createFolder("Work", now);
    await catalog.renameFolder(folder.id, " Work renamed ", "2026-08-21T00:01:00.000Z");
    const meeting = await catalog.create(" Agenda ", folder.id, "2026-08-21T00:02:00.000Z");
    await catalog.rename(meeting.id, " Agenda renamed ", "2026-08-21T00:03:00.000Z");
    await catalog.removeFolder(folder.id, "2026-08-21T00:04:00.000Z");

    await expect(catalog.pendingOperations()).resolves.toEqual([
      expect.objectContaining({ kind: "folder.create", entityId: folder.id, payload: { id: folder.id, name: "Work", clientCreatedAt: now } }),
      expect.objectContaining({ kind: "folder.rename", entityId: folder.id, payload: { name: "Work renamed", updatedAt: "2026-08-21T00:01:00.000Z", expectedSyncVersion: 0 } }),
      expect.objectContaining({ kind: "meeting.create", entityId: meeting.id, payload: { id: meeting.id, title: "Agenda", folderId: folder.id, clientCreatedAt: "2026-08-21T00:02:00.000Z" } }),
      expect.objectContaining({ kind: "meeting.rename", entityId: meeting.id, payload: { title: "Agenda renamed", updatedAt: "2026-08-21T00:03:00.000Z", expectedSyncVersion: 0 } }),
      expect.objectContaining({ kind: "folder.remove", entityId: folder.id, payload: { updatedAt: "2026-08-21T00:04:00.000Z", expectedSyncVersion: 1 } }),
    ]);
  });

  test("summarizes the first conflict with a local name and pending count", async () => {
    const catalog = repository();
    const meeting = await catalog.create("冲突会议", null, now);
    const operation = (await catalog.pendingOperations())[0]!;
    await catalog.syncRecordFailure(operation, "CONFLICT");

    await expect(catalog.pendingStatus()).resolves.toEqual({
      count: 1,
      conflict: {
        sequence: operation.sequence,
        kind: "meeting.create",
        entityName: "冲突会议",
      },
    });
  });

  test("abandons a conflicted meeting create and only its later entity mutations", async () => {
    const catalog = repository();
    const earlier = await catalog.create("其他会议", null, now);
    const abandoned = await catalog.create("放弃会议", null, "2026-08-21T00:01:00.000Z");
    await catalog.rename(abandoned.id, "放弃会议新名", "2026-08-21T00:02:00.000Z");
    const later = await catalog.create("后续会议", null, "2026-08-21T00:03:00.000Z");
    const conflict = (await catalog.pendingOperations()).find((item) => item.entityId === abandoned.id && item.kind === "meeting.create")!;
    await catalog.syncRecordFailure(conflict, "CONFLICT");

    await catalog.resolveConflict(conflict.sequence!);

    await expect(catalog.get(abandoned.id)).resolves.toBeNull();
    await expect(catalog.pendingOperations()).resolves.toEqual([
      expect.objectContaining({ entityId: earlier.id, kind: "meeting.create" }),
      expect.objectContaining({ entityId: later.id, kind: "meeting.create" }),
    ]);
    await expect(catalog.pendingStatus()).resolves.toEqual({ count: 2, conflict: null });
  });

  test("abandons a conflicted meeting mutation and later mutations without deleting earlier work", async () => {
    const catalog = repository();
    const remote = {
      id: crypto.randomUUID(), title: "服务端标题", folderId: null, status: "draft" as const,
      startedAt: null, endedAt: null, createdAt: now, updatedAt: now, trashedAt: null, syncVersion: 4,
    };
    const other = await catalog.create("其他会议", null, "2026-08-21T00:01:00.000Z");
    await catalog.syncRefresh([], [remote]);
    await catalog.rename(remote.id, "本地标题", "2026-08-21T00:02:00.000Z");
    await catalog.trash(remote.id, "2026-08-21T00:03:00.000Z");
    const conflict = (await catalog.pendingOperations()).find((item) => item.kind === "meeting.rename")!;
    await catalog.syncRecordFailure(conflict, "CONFLICT");

    await catalog.resolveConflict(conflict.sequence!);

    await expect(catalog.pendingOperations()).resolves.toEqual([
      expect.objectContaining({ entityId: other.id, kind: "meeting.create" }),
    ]);
    await expect(catalog.get(remote.id)).resolves.toMatchObject({ title: "本地标题", status: "trashed" });
  });

  test("abandons a conflicted folder create transactionally and unfiles pending meeting creates without changing versions", async () => {
    const catalog = repository();
    const other = await catalog.createFolder("其他分类", now);
    const folder = await catalog.createFolder("放弃分类", "2026-08-21T00:01:00.000Z");
    const meeting = await catalog.create("仍需同步", folder.id, "2026-08-21T00:02:00.000Z");
    await catalog.renameFolder(folder.id, "放弃分类新名", "2026-08-21T00:03:00.000Z");
    const conflict = (await catalog.pendingOperations()).find((item) => item.entityId === folder.id && item.kind === "folder.create")!;
    await catalog.syncRecordFailure(conflict, "CONFLICT");

    await catalog.resolveConflict(conflict.sequence!);

    await expect(catalog.listFolders()).resolves.toEqual([expect.objectContaining({ id: other.id })]);
    await expect(catalog.get(meeting.id)).resolves.toMatchObject({ folderId: null, syncVersion: 0 });
    await expect(catalog.pendingOperations()).resolves.toEqual([
      expect.objectContaining({ entityId: other.id, kind: "folder.create" }),
      expect.objectContaining({
        entityId: meeting.id,
        kind: "meeting.create",
        payload: expect.objectContaining({ folderId: null }),
        lastError: null,
      }),
    ]);
  });

  test("abandons a conflicted folder mutation and later folder mutations for authoritative refresh", async () => {
    const catalog = repository();
    const remoteFolder = { id: crypto.randomUUID(), name: "服务端分类", createdAt: now, updatedAt: now, syncVersion: 2 };
    const remoteMeeting = {
      id: crypto.randomUUID(), title: "服务端会议", folderId: remoteFolder.id, status: "draft" as const,
      startedAt: null, endedAt: null, createdAt: now, updatedAt: now, trashedAt: null, syncVersion: 2,
    };
    const other = await catalog.createFolder("其他分类", "2026-08-21T00:01:00.000Z");
    await catalog.syncRefresh([remoteFolder], [remoteMeeting]);
    await catalog.renameFolder(remoteFolder.id, "本地分类", "2026-08-21T00:02:00.000Z");
    await catalog.removeFolder(remoteFolder.id, "2026-08-21T00:03:00.000Z");
    const conflict = (await catalog.pendingOperations()).find((item) => item.kind === "folder.rename")!;
    await catalog.syncRecordFailure(conflict, "CONFLICT");

    await catalog.resolveConflict(conflict.sequence!);

    await expect(catalog.pendingOperations()).resolves.toEqual([
      expect.objectContaining({ entityId: other.id, kind: "folder.create" }),
    ]);
    await catalog.syncRefresh([remoteFolder], [remoteMeeting]);
    await expect(catalog.listFolders()).resolves.toEqual(expect.arrayContaining([remoteFolder]));
    await expect(catalog.get(remoteMeeting.id)).resolves.toEqual(remoteMeeting);
  });
});
