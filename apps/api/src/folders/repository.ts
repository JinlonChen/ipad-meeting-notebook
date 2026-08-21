import type Database from "better-sqlite3";
import {
  CreateFolderInputSchema,
  FolderSchema,
  type CreateFolderInput,
  type Folder,
} from "@meeting/contracts";
import { z } from "zod";

import { canonicalizeTimestamp } from "../db/database.js";

const FolderNameSchema = z.string().trim().min(1).max(80);
const FolderIdSchema = CreateFolderInputSchema.shape.id;

type FolderRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  sync_version: number;
};

export interface FolderRepository {
  create(input: CreateFolderInput): Folder;
  createOrReplay(input: CreateFolderInput): { folder: Folder; created: boolean };
  get(id: string): Folder | null;
  list(): Folder[];
  rename(id: string, name: string, now: string): Folder;
  remove(id: string, now: string): void;
}

export class FolderConflictError extends Error {
  constructor() {
    super("Folder creation request conflicts with an existing folder");
    this.name = "FolderConflictError";
  }
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
    return this.createInternal(input, false).folder;
  }

  createOrReplay(input: CreateFolderInput): { folder: Folder; created: boolean } {
    return this.createInternal(input, true);
  }

  private createInternal(input: CreateFolderInput, rejectConflict: boolean): { folder: Folder; created: boolean } {
    const value = CreateFolderInputSchema.parse(input);
    const clientCreatedAt = canonicalizeTimestamp(value.clientCreatedAt);
    return this.db.transaction(() => {
      const request = this.db.prepare(`
        SELECT name, client_created_at
        FROM folder_creation_requests WHERE folder_id = ?
      `).get(value.id) as { name: string; client_created_at: string } | undefined;
      if (request) {
        const folder = this.get(value.id);
        if (!folder) throw new FolderConflictError();
        if (rejectConflict && (request.name !== value.name || request.client_created_at !== clientCreatedAt)) {
          throw new FolderConflictError();
        }
        return { folder, created: false };
      }

      this.db.prepare(`
        INSERT INTO folders (id, name, created_at, updated_at, sync_version)
        VALUES (?, ?, ?, ?, 0)
      `).run(value.id, value.name, clientCreatedAt, clientCreatedAt);
      this.db.prepare(`
        INSERT INTO folder_creation_requests (folder_id, name, client_created_at)
        VALUES (?, ?, ?)
      `).run(value.id, value.name, clientCreatedAt);
      return { folder: this.require(value.id), created: true };
    }).immediate();
  }

  get(id: string): Folder | null {
    const folderId = FolderIdSchema.parse(id);
    const row = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(folderId) as FolderRow | undefined;
    return row ? mapFolder(row) : null;
  }

  list(): Folder[] {
    const rows = this.db.prepare(`
      SELECT * FROM folders
      ORDER BY name COLLATE NOCASE ASC, id ASC
    `).all() as FolderRow[];
    return rows.map(mapFolder);
  }

  rename(id: string, name: string, now: string): Folder {
    const folderId = FolderIdSchema.parse(id);
    const normalizedName = FolderNameSchema.parse(name);
    const timestamp = canonicalizeTimestamp(now);
    const result = this.db.prepare(`
      UPDATE folders
      SET name = ?, updated_at = ?, sync_version = sync_version + 1
      WHERE id = ?
    `).run(normalizedName, timestamp, folderId);
    if (result.changes === 0) throw new FolderNotFoundError(folderId);
    return this.require(folderId);
  }

  remove(id: string, now: string): void {
    const folderId = FolderIdSchema.parse(id);
    const timestamp = canonicalizeTimestamp(now);
    this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM folders WHERE id = ?").get(folderId);
      if (!existing) throw new FolderNotFoundError(folderId);

      this.db.prepare(`
        UPDATE meetings
        SET folder_id = NULL, updated_at = ?, sync_version = sync_version + 1
        WHERE folder_id = ?
      `).run(timestamp, folderId);
      this.db.prepare("DELETE FROM folders WHERE id = ?").run(folderId);
    })();
  }

  private require(id: string): Folder {
    const row = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id) as FolderRow | undefined;
    if (!row) throw new FolderNotFoundError(id);
    return mapFolder(row);
  }
}
