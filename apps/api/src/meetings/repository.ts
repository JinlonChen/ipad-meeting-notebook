import type Database from "better-sqlite3";
import {
  CreateMeetingInputSchema,
  MeetingListQuerySchema,
  MeetingSchema,
  type CreateMeetingInput,
  type Meeting,
} from "@meeting/contracts";
import { z } from "zod";

const MeetingTitleSchema = z.string().trim().min(1).max(120);
const IsoDateTimeSchema = z.iso.datetime();

type MeetingRow = {
  id: string;
  title: string;
  folder_id: string | null;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  trashed_at: string | null;
  sync_version: number;
};

export interface MeetingRepository {
  create(input: CreateMeetingInput): Meeting;
  get(id: string): Meeting | null;
  list(query: { search: string; includeTrashed: boolean }): Meeting[];
  rename(id: string, title: string, now: string): Meeting;
  trash(id: string, now: string): Meeting;
  restore(id: string, now: string): Meeting;
  purgeTrashedBefore(cutoff: string): number;
}

export class MeetingNotFoundError extends Error {
  constructor(id: string) {
    super(`Meeting not found: ${id}`);
    this.name = "MeetingNotFoundError";
  }
}

function mapMeeting(row: MeetingRow): Meeting {
  return MeetingSchema.parse({
    id: row.id,
    title: row.title,
    folderId: row.folder_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trashedAt: row.trashed_at,
    syncVersion: row.sync_version,
  });
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export class SqliteMeetingRepository implements MeetingRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateMeetingInput): Meeting {
    const value = CreateMeetingInputSchema.parse(input);
    this.db.prepare(`
      INSERT INTO meetings (
        id, title, folder_id, status, started_at, ended_at,
        created_at, updated_at, trashed_at, sync_version
      ) VALUES (?, ?, ?, 'draft', NULL, NULL, ?, ?, NULL, 0)
      ON CONFLICT(id) DO NOTHING
    `).run(value.id, value.title, value.folderId, value.clientCreatedAt, value.clientCreatedAt);

    return this.require(value.id);
  }

  get(id: string): Meeting | null {
    const row = this.db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as MeetingRow | undefined;
    return row ? mapMeeting(row) : null;
  }

  list(query: { search: string; includeTrashed: boolean }): Meeting[] {
    const value = MeetingListQuerySchema.parse(query);
    const clauses: string[] = [];
    const parameters: string[] = [];

    if (!value.includeTrashed) clauses.push("trashed_at IS NULL");
    if (value.search) {
      clauses.push("title LIKE ? ESCAPE '\\'");
      parameters.push(`%${escapeLike(value.search)}%`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT * FROM meetings
      ${where}
      ORDER BY updated_at DESC, id ASC
    `).all(...parameters) as MeetingRow[];
    return rows.map(mapMeeting);
  }

  rename(id: string, title: string, now: string): Meeting {
    const normalizedTitle = MeetingTitleSchema.parse(title);
    const timestamp = IsoDateTimeSchema.parse(now);
    const result = this.db.prepare(`
      UPDATE meetings
      SET title = ?, updated_at = ?, sync_version = sync_version + 1
      WHERE id = ?
    `).run(normalizedTitle, timestamp, id);
    if (result.changes === 0) throw new MeetingNotFoundError(id);
    return this.require(id);
  }

  trash(id: string, now: string): Meeting {
    const timestamp = IsoDateTimeSchema.parse(now);
    const current = this.require(id);
    if (current.status === "trashed") return current;

    this.db.prepare(`
      UPDATE meetings
      SET status = 'trashed', status_before_trash = status, trashed_at = ?,
          updated_at = ?, sync_version = sync_version + 1
      WHERE id = ?
    `).run(timestamp, timestamp, id);
    return this.require(id);
  }

  restore(id: string, now: string): Meeting {
    const timestamp = IsoDateTimeSchema.parse(now);
    const current = this.require(id);
    if (current.status !== "trashed") return current;

    this.db.prepare(`
      UPDATE meetings
      SET status = COALESCE(status_before_trash, 'draft'), status_before_trash = NULL,
          trashed_at = NULL, updated_at = ?, sync_version = sync_version + 1
      WHERE id = ?
    `).run(timestamp, id);
    return this.require(id);
  }

  purgeTrashedBefore(cutoff: string): number {
    const timestamp = IsoDateTimeSchema.parse(cutoff);
    return this.db.prepare(`
      DELETE FROM meetings
      WHERE status = 'trashed' AND trashed_at < ?
    `).run(timestamp).changes;
  }

  private require(id: string): Meeting {
    const meeting = this.get(id);
    if (!meeting) throw new MeetingNotFoundError(id);
    return meeting;
  }
}
