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

function versionSixDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE folders (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, sync_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      status TEXT NOT NULL,
      status_before_trash TEXT,
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      trashed_at TEXT,
      sync_version INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200000)
    );
    CREATE INDEX meetings_updated_at_idx ON meetings (updated_at DESC);
    CREATE INDEX meetings_trashed_at_idx ON meetings (trashed_at);
    CREATE TABLE catalog_mutation_replays (
      operation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      request_json TEXT NOT NULL,
      response_json TEXT
    );
  `);
  db.pragma("user_version = 6");
  return db;
}

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
      expect(db.pragma("user_version", { simple: true })).toBe(7);
      migrate(db);
      const schemaObjects = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as { name: string }[];
      expect(schemaObjects.map((object) => object.name)).toEqual(expect.arrayContaining([
        "folders",
        "meetings",
        "folders_name_idx",
        "meetings_updated_at_idx",
        "meetings_trashed_at_idx",
        "sessions",
        "sessions_expires_at_idx",
        "catalog_mutation_replays",
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

      expect(db.pragma("user_version", { simple: true })).toBe(7);
      expect(db.prepare("SELECT sync_version FROM folders WHERE id = ?").get(FOLDER_ID)).toEqual({ sync_version: 0 });
      expect(db.prepare("SELECT folder_id, status_before_trash, sync_version, note FROM meetings WHERE id = ?").get(MEETING_ID)).toEqual({
        folder_id: FOLDER_ID,
        status_before_trash: "draft",
        sync_version: 0,
        note: "",
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

  test("upgrades version-one data while preserving meetings and folders", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, folder_id TEXT);
      `);
      db.prepare("INSERT INTO folders VALUES (?, ?)").run(FOLDER_ID, "Preserved");
      db.prepare("INSERT INTO meetings VALUES (?, ?, ?)").run(MEETING_ID, "Preserved meeting", FOLDER_ID);
      db.pragma("user_version = 1");

      migrate(db);

      expect(db.pragma("user_version", { simple: true })).toBe(7);
      expect(db.prepare("SELECT * FROM folders WHERE id = ?").get(FOLDER_ID)).toEqual({ id: FOLDER_ID, name: "Preserved" });
      expect(db.prepare("SELECT * FROM meetings WHERE id = ?").get(MEETING_ID)).toMatchObject({ id: MEETING_ID, title: "Preserved meeting", folder_id: FOLDER_ID, note: "" });
      expect(db.prepare("PRAGMA table_info(sessions)").all()).toEqual([
        { cid: 0, name: "token_hash", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: "user_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 2, name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 3, name: "expires_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      ]);
      expect(db.prepare("PRAGMA index_list(sessions)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "sessions_expires_at_idx" }),
      ]));
    } finally {
      db.close();
    }
  });

  test("rejects databases newer than the supported migration version", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("user_version = 8");
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

  test("defaults meeting notes and enforces the 200000 Unicode code-point boundary", () => {
    const db = openDatabase(":memory:");
    try {
      const insert = db.prepare(`
        INSERT INTO meetings (id, title, status, created_at, updated_at, note)
        VALUES (?, 'Meeting', 'draft', ?, ?, ?)
      `);
      insert.run("00000000-0000-4000-8000-000000000031", CREATED_AT, CREATED_AT, "a".repeat(200_000));
      insert.run("00000000-0000-4000-8000-000000000032", CREATED_AT, CREATED_AT, "😀".repeat(200_000));
      expect(() => insert.run("00000000-0000-4000-8000-000000000033", CREATED_AT, CREATED_AT, "a".repeat(200_001))).toThrow();
      expect(() => insert.run("00000000-0000-4000-8000-000000000034", CREATED_AT, CREATED_AT, "😀".repeat(200_001))).toThrow();
      expect(() => insert.run("00000000-0000-4000-8000-000000000036", CREATED_AT, CREATED_AT, "before\u0000after")).toThrow();
      db.prepare("INSERT INTO meetings (id, title, status, created_at, updated_at) VALUES (?, 'Default note', 'draft', ?, ?)")
        .run("00000000-0000-4000-8000-000000000035", CREATED_AT, CREATED_AT);
      expect(db.prepare("SELECT note FROM meetings WHERE id = ?").get("00000000-0000-4000-8000-000000000035")).toEqual({ note: "" });
    } finally {
      db.close();
    }
  });

  test("upgrades version-five meetings by backfilling notes without changing catalog data", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
      CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE meetings (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, folder_id TEXT, status TEXT NOT NULL,
        status_before_trash TEXT, started_at TEXT, ended_at TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, trashed_at TEXT, sync_version INTEGER NOT NULL DEFAULT 0
      )`);
      db.prepare("INSERT INTO meetings (id, title, status, created_at, updated_at, sync_version) VALUES (?, ?, 'draft', ?, ?, 3)")
        .run(MEETING_ID, "Preserved meeting", CREATED_AT, CREATED_AT);
      db.pragma("user_version = 5");

      migrate(db);

      expect(db.pragma("user_version", { simple: true })).toBe(7);
      expect(db.prepare("SELECT title, status, sync_version, note FROM meetings WHERE id = ?").get(MEETING_ID)).toEqual({
        title: "Preserved meeting",
        status: "draft",
        sync_version: 3,
        note: "",
      });
    } finally {
      db.close();
    }
  });

  test("upgrades valid version-six notes without changing data, indexes, or mutation replays", () => {
    const db = versionSixDatabase();
    try {
      const note = "会议结论 \ud83d\ude00";
      db.prepare("INSERT INTO folders VALUES (?, 'Preserved folder', ?, ?, 2)").run(FOLDER_ID, CREATED_AT, CREATED_AT);
      db.prepare(`
        INSERT INTO meetings (
          id, title, folder_id, status, status_before_trash, started_at, ended_at,
          created_at, updated_at, trashed_at, sync_version, note
        ) VALUES (?, 'Preserved meeting', ?, 'ready', NULL, NULL, NULL, ?, ?, NULL, 3, ?)
      `).run(MEETING_ID, FOLDER_ID, CREATED_AT, CREATED_AT, note);
      db.prepare("INSERT INTO catalog_mutation_replays VALUES (?, 'meeting.update', ?, ?, ?)")
        .run("00000000-0000-4000-8000-000000000041", MEETING_ID, '{"note":"preserved"}', '{"status":200}');

      migrate(db);

      expect(db.pragma("user_version", { simple: true })).toBe(7);
      expect(db.prepare("SELECT title, folder_id, status, sync_version, note FROM meetings WHERE id = ?").get(MEETING_ID)).toEqual({
        title: "Preserved meeting",
        folder_id: FOLDER_ID,
        status: "ready",
        sync_version: 3,
        note,
      });
      expect(db.prepare("SELECT * FROM catalog_mutation_replays").all()).toEqual([{
        operation_id: "00000000-0000-4000-8000-000000000041",
        kind: "meeting.update",
        entity_id: MEETING_ID,
        request_json: '{"note":"preserved"}',
        response_json: '{"status":200}',
      }]);
      expect(db.prepare("PRAGMA index_list(meetings)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "meetings_updated_at_idx" }),
        expect.objectContaining({ name: "meetings_trashed_at_idx" }),
      ]));
    } finally {
      db.close();
    }
  });

  test("deterministically normalizes NUL notes while upgrading version six", () => {
    const db = versionSixDatabase();
    const oversizedId = "00000000-0000-4000-8000-000000000042";
    try {
      db.prepare("INSERT INTO meetings (id, title, status, created_at, updated_at, note) VALUES (?, 'NUL note', 'draft', ?, ?, ?)")
        .run(MEETING_ID, CREATED_AT, CREATED_AT, "before\u0000middle\u0000after");
      db.prepare("INSERT INTO meetings (id, title, status, created_at, updated_at, note) VALUES (?, 'Hidden overflow', 'draft', ?, ?, ?)")
        .run(oversizedId, CREATED_AT, CREATED_AT, `${"a".repeat(200_000)}\u0000tail`);

      migrate(db);

      expect(db.prepare("SELECT note FROM meetings WHERE id = ?").get(MEETING_ID)).toEqual({ note: "before\uFFFDmiddle\uFFFDafter" });
      expect(db.prepare("SELECT note FROM meetings WHERE id = ?").get(oversizedId)).toEqual({ note: "a".repeat(200_000) });
      expect(db.pragma("user_version", { simple: true })).toBe(7);
    } finally {
      db.close();
    }
  });

  test("backfills immutable creation requests when upgrading a version-two database", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec("DROP TABLE meeting_creation_requests; DROP TABLE folder_creation_requests;");
      db.prepare("INSERT INTO folders (id, name, created_at, updated_at, sync_version) VALUES (?, ?, ?, ?, 0)").run(FOLDER_ID, "Original folder", CREATED_AT, CREATED_AT);
      db.prepare("INSERT INTO meetings (id, title, folder_id, status, created_at, updated_at, sync_version) VALUES (?, ?, ?, 'draft', ?, ?, 0)").run(MEETING_ID, "Original meeting", FOLDER_ID, CREATED_AT, CREATED_AT);
      db.pragma("user_version = 2");

      migrate(db);

      expect(db.pragma("user_version", { simple: true })).toBe(7);
      expect(db.prepare("SELECT title, folder_id, client_created_at FROM meeting_creation_requests WHERE meeting_id = ?").get(MEETING_ID)).toEqual({ title: "Original meeting", folder_id: FOLDER_ID, client_created_at: CREATED_AT });
      expect(db.prepare("SELECT name, client_created_at FROM folder_creation_requests WHERE folder_id = ?").get(FOLDER_ID)).toEqual({ name: "Original folder", client_created_at: CREATED_AT });
    } finally {
      db.close();
    }
  });

  test("upgrades version-three creation ledgers without foreign keys or cascades", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE meeting_creation_requests (
          meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
          title TEXT NOT NULL, folder_id TEXT, client_created_at TEXT NOT NULL
        );
        CREATE TABLE folder_creation_requests (
          folder_id TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
          name TEXT NOT NULL, client_created_at TEXT NOT NULL
        );
      `);
      db.prepare("INSERT INTO folders VALUES (?, 'Original folder')").run(FOLDER_ID);
      db.prepare("INSERT INTO meetings VALUES (?, 'Original meeting')").run(MEETING_ID);
      db.prepare("INSERT INTO meeting_creation_requests VALUES (?, 'Original meeting', ?, ?)").run(MEETING_ID, FOLDER_ID, CREATED_AT);
      db.prepare("INSERT INTO folder_creation_requests VALUES (?, 'Original folder', ?)").run(FOLDER_ID, CREATED_AT);
      db.pragma("user_version = 3");

      migrate(db);

      expect(db.pragma("user_version", { simple: true })).toBe(7);
      expect(db.prepare("SELECT * FROM meeting_creation_requests").all()).toEqual([{ meeting_id: MEETING_ID, title: "Original meeting", folder_id: FOLDER_ID, client_created_at: CREATED_AT }]);
      expect(db.prepare("SELECT * FROM folder_creation_requests").all()).toEqual([{ folder_id: FOLDER_ID, name: "Original folder", client_created_at: CREATED_AT }]);
      expect(db.prepare("PRAGMA foreign_key_list(meeting_creation_requests)").all()).toEqual([]);
      expect(db.prepare("PRAGMA foreign_key_list(folder_creation_requests)").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
