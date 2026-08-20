import type Database from "better-sqlite3";
import {
  CreateFolderInputSchema,
  FolderSchema,
  type CreateFolderInput,
  type Folder,
} from "@meeting/contracts";
import { z } from "zod";

const FolderNameSchema = z.string().trim().min(1).max(80);
const IsoDateTimeSchema = z.iso.datetime();

type FolderRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  sync_version: number;
};

export interface FolderRepository {
  create(input: CreateFolderInput): Folder;
  list(): Folder[];
  rename(id: string, name: string, now: string): Folder;
  remove(id: string, now: string): void;
}

export class FolderNotFoundError extends Error {
  constructor(id: string) {
    super(`Folder not found: ${id}`);
    this.name = "FolderNotFoundError";
  }
}

function mapFolder(row: FolderRow): Folder {
  return FolderSchema.parse({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncVersion: row.sync_version,
  });
}

export class SqliteFolderRepository implements FolderRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateFolderInput): Folder {
    const value = CreateFolderInputSchema.parse(input);
    this.db.prepare(`
      INSERT INTO folders (id, name, created_at, updated_at, sync_version)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(id) DO NOTHING
    `).run(value.id, value.name, value.clientCreatedAt, value.clientCreatedAt);
    return this.require(value.id);
  }

  list(): Folder[] {
    const rows = this.db.prepare(`
      SELECT * FROM folders
      ORDER BY name COLLATE NOCASE ASC, id ASC
    `).all() as FolderRow[];
    return rows.map(mapFolder);
  }

  rename(id: string, name: string, now: string): Folder {
    const normalizedName = FolderNameSchema.parse(name);
    const timestamp = IsoDateTimeSchema.parse(now);
    const result = this.db.prepare(`
      UPDATE folders
      SET name = ?, updated_at = ?, sync_version = sync_version + 1
      WHERE id = ?
    `).run(normalizedName, timestamp, id);
    if (result.changes === 0) throw new FolderNotFoundError(id);
    return this.require(id);
  }

  remove(id: string, now: string): void {
    const timestamp = IsoDateTimeSchema.parse(now);
    this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM folders WHERE id = ?").get(id);
      if (!existing) throw new FolderNotFoundError(id);

      this.db.prepare(`
        UPDATE meetings
        SET folder_id = NULL, updated_at = ?, sync_version = sync_version + 1
        WHERE folder_id = ?
      `).run(timestamp, id);
      this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
    })();
  }

  private require(id: string): Folder {
    const row = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id) as FolderRow | undefined;
    if (!row) throw new FolderNotFoundError(id);
    return mapFolder(row);
  }
}
