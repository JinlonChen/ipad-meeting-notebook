import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { MeetingSchema } from "@meeting/contracts";
import { afterEach, describe, expect, test } from "vitest";

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
  test("is idempotent, enables foreign keys, and creates a parent directory for file databases", () => {
    const memory = new Database(":memory:");
    migrate(memory);
    migrate(memory);
    expect(memory.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(memory.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meetings'").get()).toBeTruthy();
    memory.close();

    const directory = mkdtempSync(join(tmpdir(), "meeting-db-"));
    const path = join(directory, "nested", "catalog.sqlite");
    const fileDb = openDatabase(path);
    expect(existsSync(path)).toBe(true);
    fileDb.close();
    rmSync(directory, { recursive: true, force: true });
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
});
