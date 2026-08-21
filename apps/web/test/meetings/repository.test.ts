import { afterEach, describe, expect, test } from "vitest";

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

  test("filters a literal, case-insensitive search string", async () => {
    const catalog = repository();
    await catalog.create("100%_Done", null, now);
    await catalog.create("100AXDone", null, "2026-08-21T00:01:00.000Z");

    await expect(catalog.list({ search: "%_dOnE" })).resolves.toMatchObject([{ title: "100%_Done" }]);
  });

  test("keeps catalog data on logout while dropping an expired or cleared device marker", async () => {
    const catalog = repository();
    const meeting = await catalog.create("Offline", null, now);
    await catalog.authorizeDevice("2026-09-20T00:00:00.000Z", now);
    await expect(catalog.hasDeviceAccess("2026-08-22T00:00:00.000Z")).resolves.toBe(true);
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
      expect.objectContaining({ kind: "folder.rename", entityId: folder.id, payload: { name: "Work renamed", updatedAt: "2026-08-21T00:01:00.000Z" } }),
      expect.objectContaining({ kind: "meeting.create", entityId: meeting.id, payload: { id: meeting.id, title: "Agenda", folderId: folder.id, clientCreatedAt: "2026-08-21T00:02:00.000Z" } }),
      expect.objectContaining({ kind: "meeting.rename", entityId: meeting.id, payload: { title: "Agenda renamed", updatedAt: "2026-08-21T00:03:00.000Z" } }),
      expect.objectContaining({ kind: "folder.remove", entityId: folder.id, payload: { updatedAt: "2026-08-21T00:04:00.000Z" } }),
    ]);
  });
});
