import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { MeetingSchema } from "@meeting/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { ZodError } from "zod";

import { migrate, openDatabase } from "../../src/db/database.js";
import {
  MeetingNotFoundError,
  SqliteMeetingRepository,
} from "../../src/meetings/repository.js";

const CREATED_AT = "2026-08-20T10:00:00.000Z";
const LATER = "2026-08-20T11:00:00.000Z";
const ID_ONE = "00000000-0000-4000-8000-000000000001";
const ID_TWO = "00000000-0000-4000-8000-000000000002";
const ID_THREE = "00000000-0000-4000-8000-000000000003";
const ID_FOUR = "00000000-0000-4000-8000-000000000004";

const databases: Database.Database[] = [];

function repository() {
  const db = openDatabase(":memory:");
  databases.push(db);
  return { db, meetings: new SqliteMeetingRepository(db) };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("SQLite database migration", () => {
  test("is idempotent and creates the required tables and indexes", () => {
    const memory = new Database(":memory:");
    migrate(memory);
    migrate(memory);
    expect(memory.pragma("foreign_keys", { simple: true })).toBe(1);
    const schemaObjects = memory.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as { name: string }[];
    expect(schemaObjects.map((object) => object.name)).toEqual(expect.arrayContaining([
      "folders",
      "meetings",
      "folders_name_idx",
      "meetings_updated_at_idx",
      "meetings_trashed_at_idx",
    ]));
    memory.close();
  });

  test("creates file parents and enables WAL and foreign keys for file-backed databases", () => {
    const directory = mkdtempSync(join(tmpdir(), "meeting-db-"));
    const path = join(directory, "nested", "catalog.sqlite");
    try {
      const fileDb = openDatabase(path);
      expect(existsSync(path)).toBe(true);
      expect(fileDb.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(fileDb.pragma("foreign_keys", { simple: true })).toBe(1);
      fileDb.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("enforces statuses and integer nonnegative sync versions in SQLite", () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    const insertMeeting = db.prepare(`
      INSERT INTO meetings (id, title, status, created_at, updated_at, sync_version)
      VALUES (?, 'Meeting', ?, ?, ?, ?)
    `);
    expect(() => insertMeeting.run(ID_ONE, "invalid", CREATED_AT, CREATED_AT, 0)).toThrow();
    expect(() => insertMeeting.run(ID_TWO, "draft", CREATED_AT, CREATED_AT, -1)).toThrow();
    expect(() => insertMeeting.run(ID_THREE, "draft", CREATED_AT, CREATED_AT, 0.5)).toThrow();
    expect(() => db.prepare(`
      INSERT INTO folders (id, name, created_at, updated_at, sync_version)
      VALUES (?, 'Folder', ?, ?, ?)
    `).run(ID_FOUR, CREATED_AT, CREATED_AT, -1)).toThrow();
    expect(() => db.prepare(`
      INSERT INTO folders (id, name, created_at, updated_at, sync_version)
      VALUES (?, 'Other Folder', ?, ?, ?)
    `).run("00000000-0000-4000-8000-000000000005", CREATED_AT, CREATED_AT, 0.5)).toThrow();
  });
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

  test("restores draft when a trashed meeting has no prior status", () => {
    const { db, meetings } = repository();
    meetings.create({ id: ID_ONE, title: "Fallback", folderId: null, clientCreatedAt: CREATED_AT });
    db.prepare("UPDATE meetings SET status = 'trashed', trashed_at = ?, status_before_trash = NULL WHERE id = ?").run(LATER, ID_ONE);

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
