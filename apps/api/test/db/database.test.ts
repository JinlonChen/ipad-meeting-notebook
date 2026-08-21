import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { migrate, openDatabase } from "../../src/db/database.js";

const FOLDER_ID = "00000000-0000-4000-8000-000000000021";
const MEETING_ID = "00000000-0000-4000-8000-000000000022";
const ORPHAN_MEETING_ID = "00000000-0000-4000-8000-000000000030";
const CREATED_AT = "2026-08-20T10:00:00.000Z";

describe("SQLite migrations", () => {
  test("creates file parents, enables WAL and foreign keys, and records schema version", () => {
    const directory = mkdtempSync(join(tmpdir(), "meeting-db-"));
    const path = join(directory, "nested", "catalog.sqlite");
    let db: Database.Database | undefined;
    try {
      db = openDatabase(path);
      expect(existsSync(path)).toBe(true);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("user_version", { simple: true })).toBe(1);
      migrate(db);
      const schemaObjects = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as { name: string }[];
      expect(schemaObjects.map((object) => object.name)).toEqual(expect.arrayContaining([
        "folders",
        "meetings",
        "folders_name_idx",
        "meetings_updated_at_idx",
        "meetings_trashed_at_idx",
      ]));
    } finally {
      db?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rebuilds legacy version-zero tables and preserves valid folder references", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE meetings (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, folder_id TEXT,
          status TEXT NOT NULL, started_at TEXT, ended_at TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, trashed_at TEXT
        );
      `);
      db.prepare("INSERT INTO folders VALUES (?, 'Legacy', ?, ?)").run(FOLDER_ID, CREATED_AT, CREATED_AT);
      db.prepare("INSERT INTO meetings VALUES (?, 'Legacy meeting', ?, 'trashed', NULL, NULL, ?, ?, ?)").run(MEETING_ID, FOLDER_ID, CREATED_AT, "2026-08-20T10:00:00.1239Z", CREATED_AT);
      db.prepare("INSERT INTO meetings VALUES (?, 'Orphaned legacy meeting', ?, 'draft', NULL, NULL, ?, ?, NULL)").run(ORPHAN_MEETING_ID, "00000000-0000-4000-8000-000000000099", CREATED_AT, CREATED_AT);

      migrate(db);

      expect(db.pragma("user_version", { simple: true })).toBe(1);
      expect(db.prepare("SELECT sync_version FROM folders WHERE id = ?").get(FOLDER_ID)).toEqual({ sync_version: 0 });
      expect(db.prepare("SELECT folder_id, status_before_trash, sync_version FROM meetings WHERE id = ?").get(MEETING_ID)).toEqual({
        folder_id: FOLDER_ID,
        status_before_trash: "draft",
        sync_version: 0,
      });
      expect(db.prepare("SELECT updated_at FROM meetings WHERE id = ?").get(MEETING_ID)).toEqual({
        updated_at: "2026-08-20T10:00:00.123Z",
      });
      expect(db.prepare("SELECT folder_id FROM meetings WHERE id = ?").get(ORPHAN_MEETING_ID)).toEqual({ folder_id: null });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => db.prepare("INSERT INTO meetings (id, title, status, created_at, updated_at, trashed_at) VALUES (?, 'Bad', 'draft', ?, ?, ?)").run("00000000-0000-4000-8000-000000000023", CREATED_AT, CREATED_AT, CREATED_AT)).toThrow();
    } finally {
      db.close();
    }
  });

  test("rejects databases newer than the supported migration version", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("user_version = 2");
      expect(() => migrate(db)).toThrow(/newer/);
    } finally {
      db.close();
    }
  });

  test("enforces SQLite status, version, and trash-state invariants", () => {
    const db = openDatabase(":memory:");
    try {
      const insertMeeting = db.prepare(`
        INSERT INTO meetings (id, title, status, created_at, updated_at, sync_version)
        VALUES (?, 'Meeting', ?, ?, ?, ?)
      `);
      expect(() => insertMeeting.run("00000000-0000-4000-8000-000000000024", "invalid", CREATED_AT, CREATED_AT, 0)).toThrow();
      expect(() => insertMeeting.run("00000000-0000-4000-8000-000000000025", "draft", CREATED_AT, CREATED_AT, -1)).toThrow();
      expect(() => insertMeeting.run("00000000-0000-4000-8000-000000000026", "draft", CREATED_AT, CREATED_AT, 0.5)).toThrow();
      expect(() => db.prepare(`
        INSERT INTO folders (id, name, created_at, updated_at, sync_version)
        VALUES (?, 'Folder', ?, ?, ?)
      `).run("00000000-0000-4000-8000-000000000027", CREATED_AT, CREATED_AT, 0.5)).toThrow();
      expect(() => db.prepare(`
        INSERT INTO meetings (id, title, status, created_at, updated_at, trashed_at)
        VALUES (?, 'Bad active', 'draft', ?, ?, ?)
      `).run("00000000-0000-4000-8000-000000000028", CREATED_AT, CREATED_AT, CREATED_AT)).toThrow();
      expect(() => db.prepare(`
        INSERT INTO meetings (id, title, status, created_at, updated_at, trashed_at)
        VALUES (?, 'Bad trash', 'trashed', ?, ?, ?)
      `).run("00000000-0000-4000-8000-000000000029", CREATED_AT, CREATED_AT, CREATED_AT)).toThrow();
    } finally {
      db.close();
    }
  });
});
