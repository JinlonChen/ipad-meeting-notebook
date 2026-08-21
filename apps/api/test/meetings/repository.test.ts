import Database from "better-sqlite3";
import { MeetingSchema } from "@meeting/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { ZodError } from "zod";

import { openDatabase } from "../../src/db/database.js";
import {
  MeetingNotFoundError,
  SqliteMeetingRepository,
} from "../../src/meetings/repository.js";

const CREATED_AT = "2026-08-20T10:00:00.000Z";
const LATER = "2026-08-20T11:00:00.000Z";
const ID_ONE = "00000000-0000-4000-8000-000000000001";
const ID_TWO = "00000000-0000-4000-8000-000000000002";
const ID_THREE = "00000000-0000-4000-8000-000000000003";

const databases: Database.Database[] = [];

function repository() {
  const db = openDatabase(":memory:");
  databases.push(db);
  return { db, meetings: new SqliteMeetingRepository(db) };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("SqliteMeetingRepository", () => {
  test("creates idempotently, supports Chinese title search, and returns contract meetings", () => {
    const { meetings } = repository();
    const input = { id: ID_ONE, title: "  项目复盘会议  ", folderId: null, clientCreatedAt: CREATED_AT };

    const created = meetings.create(input);
    const repeated = meetings.create({ ...input, title: "different" });

    expect(created).toEqual(repeated);
    expect(created.title).toBe("项目复盘会议");
    expect(meetings.list({ search: "复盘", includeTrashed: false })).toEqual([created]);
    expect(MeetingSchema.parse(created)).toEqual(created);
  });

  test("treats LIKE percent, underscore, and backslash characters literally", () => {
    const { meetings } = repository();
    meetings.create({ id: ID_ONE, title: "100%_done\\path", folderId: null, clientCreatedAt: CREATED_AT });
    meetings.create({ id: ID_TWO, title: "100AXdoneXpath", folderId: null, clientCreatedAt: CREATED_AT });

    expect(meetings.list({ search: "%_done\\", includeTrashed: false }).map((meeting) => meeting.id)).toEqual([ID_ONE]);
    expect(meetings.list({ search: "100%", includeTrashed: false }).map((meeting) => meeting.id)).toEqual([ID_ONE]);
  });

  test("lists equal timestamps in ascending id order after updatedAt ordering", () => {
    const { meetings } = repository();
    meetings.create({ id: ID_TWO, title: "Second", folderId: null, clientCreatedAt: CREATED_AT });
    meetings.create({ id: ID_ONE, title: "First", folderId: null, clientCreatedAt: CREATED_AT });
    meetings.create({ id: ID_THREE, title: "Later", folderId: null, clientCreatedAt: LATER });

    expect(meetings.list({ search: "", includeTrashed: false }).map((meeting) => meeting.id)).toEqual([
      ID_THREE,
      ID_ONE,
      ID_TWO,
    ]);
  });

  test("normalizes timestamp precision so list order is chronological", () => {
    const { meetings } = repository();
    meetings.create({ id: ID_ONE, title: "Whole second", folderId: null, clientCreatedAt: "2026-08-20T10:00:00Z" });
    meetings.create({ id: ID_TWO, title: "Milliseconds", folderId: null, clientCreatedAt: "2026-08-20T10:00:00.999Z" });

    expect(meetings.list({ search: "", includeTrashed: false }).map((meeting) => meeting.id)).toEqual([ID_TWO, ID_ONE]);
    expect(meetings.get(ID_ONE)?.createdAt).toBe("2026-08-20T10:00:00.000Z");
    expect(meetings.create({ id: ID_THREE, title: "Extra precision", folderId: null, clientCreatedAt: "2026-08-20T10:00:00.1239Z" }).createdAt).toBe("2026-08-20T10:00:00.123Z");
  });

  test("renames with a trimmed title, increments version, and rejects invalid or absent mutations", () => {
    const { meetings } = repository();
    meetings.create({ id: ID_ONE, title: "Before", folderId: null, clientCreatedAt: CREATED_AT });

    expect(meetings.rename(ID_ONE, "  After  ", LATER)).toMatchObject({ title: "After", updatedAt: LATER, syncVersion: 1 });
    expect(() => meetings.rename(ID_ONE, "   ", LATER)).toThrow();
    expect(() => meetings.rename(ID_THREE, "Missing", LATER)).toThrow(MeetingNotFoundError);
  });

  test("hides trashed meetings, makes repeated trash and restore idempotent, and restores prior status", () => {
    const { db, meetings } = repository();
    meetings.create({ id: ID_ONE, title: "Ready meeting", folderId: null, clientCreatedAt: CREATED_AT });
    db.prepare("UPDATE meetings SET status = 'ready' WHERE id = ?").run(ID_ONE);

    const trashed = meetings.trash(ID_ONE, LATER);
    const repeatedTrash = meetings.trash(ID_ONE, "2026-08-20T12:00:00.000Z");
    expect(trashed).toMatchObject({ status: "trashed", trashedAt: LATER, syncVersion: 1 });
    expect(repeatedTrash).toEqual(trashed);
    expect(meetings.list({ search: "", includeTrashed: false })).toEqual([]);
    expect(meetings.list({ search: "", includeTrashed: true })).toEqual([trashed]);

    const restored = meetings.restore(ID_ONE, "2026-08-20T13:00:00.000Z");
    expect(restored).toMatchObject({ status: "ready", trashedAt: null, syncVersion: 2 });
    expect(meetings.restore(ID_ONE, "2026-08-20T14:00:00.000Z")).toEqual(restored);
  });

  test("does not overwrite a concurrent trash between lifecycle check and write", () => {
    const { db, meetings } = repository();
    meetings.create({ id: ID_ONE, title: "Race", folderId: null, clientCreatedAt: CREATED_AT });
    db.prepare("UPDATE meetings SET status = 'ready' WHERE id = ?").run(ID_ONE);

    const originalPrepare = db.prepare;
    let injected = false;
    Object.defineProperty(db, "prepare", {
      configurable: true,
      value(source: string) {
        const statement = originalPrepare.call(db, source);
        if (injected || !source.includes("SET status = 'trashed'")) return statement;
        return new Proxy(statement, {
          get(target, property, receiver) {
            if (property === "run" || property === "get") {
              return (...args: unknown[]) => {
                injected = true;
                const concurrentUpdate = originalPrepare.call(db, `
                  UPDATE meetings
                  SET status = 'trashed', status_before_trash = 'ready', trashed_at = ?,
                      updated_at = ?, sync_version = sync_version + 1
                  WHERE id = ?
                `) as unknown as { run(...values: unknown[]): unknown };
                concurrentUpdate.run("2026-08-20T10:30:00.000Z", "2026-08-20T10:30:00.000Z", ID_ONE);
                const method = Reflect.get(target, property, receiver) as (...values: unknown[]) => unknown;
                return method.apply(target, args);
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });

    try {
      expect(meetings.trash(ID_ONE, LATER)).toMatchObject({
        status: "trashed",
        trashedAt: "2026-08-20T10:30:00.000Z",
        syncVersion: 1,
      });
    } finally {
      Object.defineProperty(db, "prepare", { configurable: true, value: originalPrepare });
    }
  });

  test("restores draft when a trashed meeting has no prior status", () => {
    const { db, meetings } = repository();
    meetings.create({ id: ID_ONE, title: "Fallback", folderId: null, clientCreatedAt: CREATED_AT });
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE meetings SET status = 'trashed', trashed_at = ?, status_before_trash = NULL WHERE id = ?").run(LATER, ID_ONE);
    db.pragma("ignore_check_constraints = OFF");

    expect(meetings.restore(ID_ONE, "2026-08-20T12:00:00.000Z")).toMatchObject({
      status: "draft",
      trashedAt: null,
      syncVersion: 1,
    });
  });

  test("purges only trashed meetings strictly older than the cutoff", () => {
    const { meetings } = repository();
    meetings.create({ id: ID_ONE, title: "Old", folderId: null, clientCreatedAt: CREATED_AT });
    meetings.create({ id: ID_TWO, title: "Equal", folderId: null, clientCreatedAt: CREATED_AT });
    meetings.create({ id: ID_THREE, title: "Active", folderId: null, clientCreatedAt: CREATED_AT });
    meetings.trash(ID_ONE, "2026-08-20T10:30:00.000Z");
    meetings.trash(ID_TWO, "2026-08-20T11:00:00.000Z");

    expect(meetings.purgeTrashedBefore("2026-08-20T11:00:00.000Z")).toBe(1);
    expect(meetings.get(ID_ONE)).toBeNull();
    expect(meetings.get(ID_TWO)).not.toBeNull();
    expect(meetings.get(ID_THREE)).not.toBeNull();
  });

  test("purges against canonical timestamp values", () => {
    const { meetings } = repository();
    meetings.create({ id: ID_ONE, title: "Old", folderId: null, clientCreatedAt: CREATED_AT });
    meetings.trash(ID_ONE, "2026-08-20T10:00:00Z");

    expect(meetings.purgeTrashedBefore("2026-08-20T10:00:00.500Z")).toBe(1);
  });

  test("keeps a purged meeting creation tombstone and rejects every replay", () => {
    const { meetings } = repository();
    const input = { id: ID_ONE, title: "Purged", folderId: null, clientCreatedAt: CREATED_AT };
    meetings.createOrReplay(input);
    meetings.trash(ID_ONE, LATER);
    expect(meetings.purgeTrashedBefore("2026-08-20T12:00:00.000Z")).toBe(1);
    expect(() => meetings.createOrReplay(input)).toThrow("conflicts");
    expect(() => meetings.createOrReplay({ ...input, title: "Different" })).toThrow("conflicts");
  });

  test("rejects meetings whose folder does not exist", () => {
    const { meetings } = repository();

    let error: unknown;
    try {
      meetings.create({
        id: ID_ONE,
        title: "Unlinked",
        folderId: "00000000-0000-4000-8000-000000000099",
        clientCreatedAt: CREATED_AT,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
  });

  test("validates meeting inputs before reads or mutations and preserves typed not-found errors for valid IDs", () => {
    const { meetings } = repository();
    const invalidId = "not-a-uuid";

    expect(() => meetings.create({ id: invalidId, title: "Meeting", folderId: null, clientCreatedAt: CREATED_AT })).toThrow(ZodError);
    expect(() => meetings.create({ id: ID_ONE, title: " ", folderId: null, clientCreatedAt: CREATED_AT })).toThrow(ZodError);
    expect(() => meetings.create({ id: ID_ONE, title: "Meeting", folderId: null, clientCreatedAt: "not-a-date" })).toThrow(ZodError);
    expect(() => meetings.get(invalidId)).toThrow(ZodError);
    expect(() => meetings.rename(invalidId, " ", "not-a-date")).toThrow(ZodError);
    expect(() => meetings.rename(invalidId, "Meeting", LATER)).toThrow(ZodError);
    expect(() => meetings.rename(ID_ONE, " ", LATER)).toThrow(ZodError);
    expect(() => meetings.rename(ID_ONE, "Meeting", "not-a-date")).toThrow(ZodError);
    expect(() => meetings.trash(invalidId, "not-a-date")).toThrow(ZodError);
    expect(() => meetings.trash(invalidId, LATER)).toThrow(ZodError);
    expect(() => meetings.trash(ID_ONE, "not-a-date")).toThrow(ZodError);
    expect(() => meetings.restore(invalidId, "not-a-date")).toThrow(ZodError);
    expect(() => meetings.restore(invalidId, LATER)).toThrow(ZodError);
    expect(() => meetings.restore(ID_ONE, "not-a-date")).toThrow(ZodError);
    expect(() => meetings.purgeTrashedBefore("not-a-date")).toThrow(ZodError);
    expect(() => meetings.trash(ID_THREE, LATER)).toThrow(MeetingNotFoundError);
  });
});
