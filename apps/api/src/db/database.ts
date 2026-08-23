import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { CreateMeetingInputSchema } from "@meeting/contracts";
import Database from "better-sqlite3";

export const CURRENT_DATABASE_VERSION = 6;

const IsoDateTimeSchema = CreateMeetingInputSchema.shape.clientCreatedAt;
const ActiveStatuses = "'draft', 'recording', 'recoverable', 'uploading', 'processing', 'ready', 'failed'";
const AllStatuses = `${ActiveStatuses}, 'trashed'`;
const migrations = [
  { version: 1, migrate: migrateVersionZero },
  { version: 2, migrate: migrateVersionTwo },
  { version: 3, migrate: migrateVersionThree },
  { version: 4, migrate: migrateVersionFour },
  { version: 5, migrate: migrateVersionFive },
  { version: 6, migrate: migrateVersionSix },
];

export function canonicalizeTimestamp(value: string): string {
  // JavaScript Date intentionally stores sub-millisecond input at millisecond precision.
  return new Date(IsoDateTimeSchema.parse(value)).toISOString();
}

export function migrate(db: Database.Database): void {
  db.pragma("journal_mode = WAL");

  let version = db.pragma("user_version", { simple: true }) as number;
  if (version > CURRENT_DATABASE_VERSION) {
    throw new Error(`Database version ${version} is newer than supported version ${CURRENT_DATABASE_VERSION}`);
  }

  while (version < CURRENT_DATABASE_VERSION) {
    const nextMigration = migrations.find((migration) => migration.version === version + 1);
    if (!nextMigration) throw new Error(`No migration is available from database version ${version}`);
    nextMigration.migrate(db);
    version = db.pragma("user_version", { simple: true }) as number;
  }
  db.pragma("foreign_keys = ON");
}

export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  try {
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrateVersionZero(db: Database.Database): void {
  const foreignKeysWereEnabled = db.pragma("foreign_keys", { simple: true }) === 1;
  let migrated = false;
  db.pragma("foreign_keys = OFF");

  try {
    db.transaction(() => {
      const hasFolders = tableExists(db, "folders");
      const hasMeetings = tableExists(db, "meetings");

      // Existing index names must be released before legacy tables are renamed.
      db.exec(`
        DROP INDEX IF EXISTS folders_name_idx;
        DROP INDEX IF EXISTS folders_name_nocase;
        DROP INDEX IF EXISTS meetings_updated_at_idx;
        DROP INDEX IF EXISTS meetings_updated_at_desc;
        DROP INDEX IF EXISTS meetings_trashed_at_idx;
        DROP INDEX IF EXISTS meetings_trashed_at;
      `);
      if (hasMeetings) db.exec("ALTER TABLE meetings RENAME TO meetings_legacy_v0");
      if (hasFolders) db.exec("ALTER TABLE folders RENAME TO folders_legacy_v0");

      createCurrentSchema(db);
      if (hasFolders) copyLegacyFolders(db);
      if (hasMeetings) copyLegacyMeetings(db);

      if (hasMeetings) db.exec("DROP TABLE meetings_legacy_v0");
      if (hasFolders) db.exec("DROP TABLE folders_legacy_v0");
      if (db.prepare("PRAGMA foreign_key_check").get()) {
        throw new Error("Foreign key check failed during database migration");
      }
      db.pragma("user_version = 1");
    })();
    migrated = true;
  } finally {
    db.pragma(`foreign_keys = ${migrated || foreignKeysWereEnabled ? "ON" : "OFF"}`);
  }
}

function migrateVersionTwo(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL CHECK (user_id = 'owner'),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
    `);
    db.pragma("user_version = 2");
  })();
}

function migrateVersionThree(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE meeting_creation_requests (
        meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        folder_id TEXT,
        client_created_at TEXT NOT NULL
      );

      CREATE TABLE folder_creation_requests (
        folder_id TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        client_created_at TEXT NOT NULL
      );
    `);
    const meetingColumns = legacyColumns(db, "meetings");
    const folderColumns = legacyColumns(db, "folders");
    db.exec(`
      INSERT INTO meeting_creation_requests (meeting_id, title, folder_id, client_created_at)
      SELECT id, title, ${column(meetingColumns, "folder_id", "NULL")}, ${canonicalColumn(meetingColumns, "created_at", "'1970-01-01T00:00:00.000Z'")}
      FROM meetings;

      INSERT INTO folder_creation_requests (folder_id, name, client_created_at)
      SELECT id, name, ${canonicalColumn(folderColumns, "created_at", "'1970-01-01T00:00:00.000Z'")}
      FROM folders;
    `);
    db.pragma("user_version = 3");
  })();
}

function migrateVersionFour(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE meeting_creation_requests_v4 (
        meeting_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        folder_id TEXT,
        client_created_at TEXT NOT NULL
      );
      INSERT INTO meeting_creation_requests_v4
      SELECT meeting_id, title, folder_id, client_created_at FROM meeting_creation_requests;
      DROP TABLE meeting_creation_requests;
      ALTER TABLE meeting_creation_requests_v4 RENAME TO meeting_creation_requests;

      CREATE TABLE folder_creation_requests_v4 (
        folder_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        client_created_at TEXT NOT NULL
      );
      INSERT INTO folder_creation_requests_v4
      SELECT folder_id, name, client_created_at FROM folder_creation_requests;
      DROP TABLE folder_creation_requests;
      ALTER TABLE folder_creation_requests_v4 RENAME TO folder_creation_requests;
    `);
    db.pragma("user_version = 4");
  })();
}

function migrateVersionFive(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_mutation_replays (
        operation_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        response_json TEXT
      );
    `);
    db.pragma("user_version = 5");
  })();
}

function migrateVersionSix(db: Database.Database): void {
  db.transaction(() => {
    if (!legacyColumns(db, "meetings").has("note")) {
      db.exec("ALTER TABLE meetings ADD COLUMN note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200000)");
    }
    db.pragma("user_version = 6");
  })();
}

function createCurrentSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sync_version INTEGER NOT NULL DEFAULT 0 CHECK (
        sync_version >= 0 AND typeof(sync_version) = 'integer'
      )
    );

    CREATE UNIQUE INDEX folders_name_idx ON folders (name COLLATE NOCASE);

    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN (${AllStatuses})),
      status_before_trash TEXT CHECK (status_before_trash IN (${ActiveStatuses})),
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      trashed_at TEXT,
      sync_version INTEGER NOT NULL DEFAULT 0 CHECK (
        sync_version >= 0 AND typeof(sync_version) = 'integer'
      ),
      note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200000),
      CHECK (
        (status = 'trashed' AND trashed_at IS NOT NULL AND status_before_trash IS NOT NULL)
        OR
        (status <> 'trashed' AND trashed_at IS NULL AND status_before_trash IS NULL)
      )
    );

    CREATE INDEX meetings_updated_at_idx ON meetings (updated_at DESC);
    CREATE INDEX meetings_trashed_at_idx ON meetings (trashed_at);
  `);
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function legacyColumns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));
}

function column(columns: Set<string>, name: string, fallback: string): string {
  return columns.has(name) ? `"${name}"` : fallback;
}

function canonicalColumn(columns: Set<string>, name: string, fallback: string): string {
  const value = column(columns, name, "NULL");
  const fractionalSeconds = `CASE WHEN instr(${value}, '.') > 0
    THEN replace(substr(${value}, instr(${value}, '.') + 1), 'Z', '')
    ELSE '' END`;
  return `COALESCE(CASE WHEN ${value} IS NOT NULL THEN
    substr(${value}, 1, 19) || '.' || substr(${fractionalSeconds} || '000', 1, 3) || 'Z'
  ELSE NULL END, ${fallback})`;
}

function copyLegacyFolders(db: Database.Database): void {
  const columns = legacyColumns(db, "folders_legacy_v0");
  const syncVersion = column(columns, "sync_version", "0");
  db.exec(`
    INSERT INTO folders (id, name, created_at, updated_at, sync_version)
    SELECT
      ${column(columns, "id", "NULL")},
      ${column(columns, "name", "''")},
      ${canonicalColumn(columns, "created_at", "'1970-01-01T00:00:00.000Z'")},
      ${canonicalColumn(columns, "updated_at", "'1970-01-01T00:00:00.000Z'")},
      CASE WHEN typeof(${syncVersion}) = 'integer' AND ${syncVersion} >= 0 THEN ${syncVersion} ELSE 0 END
    FROM folders_legacy_v0;
  `);
}

function copyLegacyMeetings(db: Database.Database): void {
  const columns = legacyColumns(db, "meetings_legacy_v0");
  const rawStatus = column(columns, "status", "'draft'");
  const status = `CASE WHEN ${rawStatus} IN (${AllStatuses}) THEN ${rawStatus} ELSE 'draft' END`;
  const rawPriorStatus = column(columns, "status_before_trash", "NULL");
  const rawFolderId = column(columns, "folder_id", "NULL");
  const rawSyncVersion = column(columns, "sync_version", "0");
  const createdAt = canonicalColumn(columns, "created_at", "'1970-01-01T00:00:00.000Z'");
  const updatedAt = canonicalColumn(columns, "updated_at", "'1970-01-01T00:00:00.000Z'");
  const trashedAt = `CASE WHEN ${status} = 'trashed' THEN COALESCE(
    strftime('%Y-%m-%dT%H:%M:%fZ', ${column(columns, "trashed_at", "NULL")}),
    ${updatedAt}, ${createdAt}
  ) ELSE NULL END`;
  const priorStatus = `CASE WHEN ${status} = 'trashed' THEN CASE
    WHEN ${rawPriorStatus} IN (${ActiveStatuses}) THEN ${rawPriorStatus}
    ELSE 'draft'
  END ELSE NULL END`;

  db.exec(`
    INSERT INTO meetings (
      id, title, folder_id, status, status_before_trash, started_at, ended_at,
      created_at, updated_at, trashed_at, sync_version, note
    ) SELECT
      ${column(columns, "id", "NULL")},
      ${column(columns, "title", "''")},
      CASE WHEN ${rawFolderId} IS NOT NULL AND EXISTS (
        SELECT 1 FROM folders WHERE id = ${rawFolderId}
      ) THEN ${rawFolderId} ELSE NULL END,
      ${status},
      ${priorStatus},
      ${canonicalColumn(columns, "started_at", "NULL")},
      ${canonicalColumn(columns, "ended_at", "NULL")},
      ${createdAt},
      ${updatedAt},
      ${trashedAt},
      CASE WHEN typeof(${rawSyncVersion}) = 'integer' AND ${rawSyncVersion} >= 0 THEN ${rawSyncVersion} ELSE 0 END,
      ${column(columns, "note", "''")}
    FROM meetings_legacy_v0;
  `);
}
