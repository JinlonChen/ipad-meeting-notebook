import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export function migrate(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sync_version INTEGER NOT NULL DEFAULT 0 CHECK (
        sync_version >= 0 AND typeof(sync_version) = 'integer'
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS folders_name_idx
      ON folders (name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN (
        'draft', 'recording', 'recoverable', 'uploading',
        'processing', 'ready', 'failed', 'trashed'
      )),
      status_before_trash TEXT CHECK (status_before_trash IN (
        'draft', 'recording', 'recoverable', 'uploading',
        'processing', 'ready', 'failed'
      )),
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      trashed_at TEXT,
      sync_version INTEGER NOT NULL DEFAULT 0 CHECK (
        sync_version >= 0 AND typeof(sync_version) = 'integer'
      )
    );

    CREATE INDEX IF NOT EXISTS meetings_updated_at_idx
      ON meetings (updated_at DESC);
    CREATE INDEX IF NOT EXISTS meetings_trashed_at_idx
      ON meetings (trashed_at);
  `);
}

export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  migrate(db);
  return db;
}
