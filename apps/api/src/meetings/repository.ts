import type Database from "better-sqlite3";
import {
  CreateMeetingInputSchema,
  MeetingListQuerySchema,
  MeetingSchema,
  type CreateMeetingInput,
  type Meeting,
} from "@meeting/contracts";
import { z } from "zod";

import { canonicalizeTimestamp } from "../db/database.js";

const MeetingTitleSchema = z.string().trim().min(1).max(120);
const MeetingIdSchema = CreateMeetingInputSchema.shape.id;

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
  createOrReplay(input: CreateMeetingInput): { meeting: Meeting; created: boolean };
  get(id: string): Meeting | null;
  list(query: { search: string; includeTrashed: boolean }): Meeting[];
  rename(id: string, title: string, now: string): Meeting;
  update(id: string, patch: { title?: string | undefined; folderId?: string | null | undefined }, now: string): Meeting;
  trash(id: string, now: string): Meeting;
  restore(id: string, now: string): Meeting;
  purgeTrashedBefore(cutoff: string): number;
}

export class MeetingConflictError extends Error {
  constructor() {
    super("Meeting creation request conflicts with an existing meeting");
    this.name = "MeetingConflictError";
  }
}

export class MeetingFolderNotFoundError extends Error {
  constructor(id: string) {
    super(`Folder not found: ${id}`);
    this.name = "MeetingFolderNotFoundError";
  }
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
    return this.createInternal(input, false).meeting;
  }

  createOrReplay(input: CreateMeetingInput): { meeting: Meeting; created: boolean } {
    return this.createInternal(input, true);
  }

  private createInternal(input: CreateMeetingInput, rejectConflict: boolean): { meeting: Meeting; created: boolean } {
    const value = CreateMeetingInputSchema.parse(input);
    const clientCreatedAt = canonicalizeTimestamp(value.clientCreatedAt);
    return this.db.transaction(() => {
      const request = this.db.prepare(`
        SELECT title, folder_id, client_created_at
        FROM meeting_creation_requests WHERE meeting_id = ?
      `).get(value.id) as { title: string; folder_id: string | null; client_created_at: string } | undefined;
      if (request) {
        if (rejectConflict && (request.title !== value.title || request.folder_id !== value.folderId || request.client_created_at !== clientCreatedAt)) {
          throw new MeetingConflictError();
        }
        return { meeting: this.require(value.id), created: false };
      }

      this.db.prepare(`
        INSERT INTO meetings (
          id, title, folder_id, status, started_at, ended_at,
          created_at, updated_at, trashed_at, sync_version
        ) VALUES (?, ?, ?, 'draft', NULL, NULL, ?, ?, NULL, 0)
      `).run(value.id, value.title, value.folderId, clientCreatedAt, clientCreatedAt);
      this.db.prepare(`
        INSERT INTO meeting_creation_requests (meeting_id, title, folder_id, client_created_at)
        VALUES (?, ?, ?, ?)
      `).run(value.id, value.title, value.folderId, clientCreatedAt);
      return { meeting: this.require(value.id), created: true };
    }).immediate();
  }

  get(id: string): Meeting | null {
    const meetingId = MeetingIdSchema.parse(id);
    const row = this.db.prepare("SELECT * FROM meetings WHERE id = ?").get(meetingId) as MeetingRow | undefined;
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
    return this.update(id, { title }, now);
  }

  update(id: string, patch: { title?: string | undefined; folderId?: string | null | undefined }, now: string): Meeting {
    const meetingId = MeetingIdSchema.parse(id);
    const value = z.object({
      title: MeetingTitleSchema.optional(),
      folderId: MeetingIdSchema.nullable().optional(),
    }).strict().refine((candidate) => candidate.title !== undefined || candidate.folderId !== undefined).parse(patch);
    const timestamp = canonicalizeTimestamp(now);
    return this.db.transaction(() => {
      if (!this.get(meetingId)) throw new MeetingNotFoundError(meetingId);
      if (value.folderId && !this.db.prepare("SELECT 1 FROM folders WHERE id = ?").get(value.folderId)) {
        throw new MeetingFolderNotFoundError(value.folderId);
      }
      const fields: string[] = [];
      const parameters: (string | null)[] = [];
      if (value.title !== undefined) {
        fields.push("title = ?");
        parameters.push(value.title);
      }
      if (value.folderId !== undefined) {
        fields.push("folder_id = ?");
        parameters.push(value.folderId);
      }
      const row = this.db.prepare(`
        UPDATE meetings
        SET ${fields.join(", ")}, updated_at = ?, sync_version = sync_version + 1
        WHERE id = ?
        RETURNING *
      `).get(...parameters, timestamp, meetingId) as MeetingRow;
      return mapMeeting(row);
    }).immediate();
  }

  trash(id: string, now: string): Meeting {
    const meetingId = MeetingIdSchema.parse(id);
    const timestamp = canonicalizeTimestamp(now);
    return this.db.transaction(() => this.trashInTransaction(meetingId, timestamp)).immediate();
  }

  restore(id: string, now: string): Meeting {
    const meetingId = MeetingIdSchema.parse(id);
    const timestamp = canonicalizeTimestamp(now);
    return this.db.transaction(() => this.restoreInTransaction(meetingId, timestamp)).immediate();
  }

  purgeTrashedBefore(cutoff: string): number {
    const timestamp = canonicalizeTimestamp(cutoff);
    return this.db.prepare(`
      DELETE FROM meetings
      WHERE status = 'trashed' AND trashed_at < ?
    `).run(timestamp).changes;
  }

  private trashInTransaction(meetingId: string, timestamp: string): Meeting {
    const row = this.db.prepare(`
      UPDATE meetings
      SET status = 'trashed', status_before_trash = status, trashed_at = ?,
          updated_at = ?, sync_version = sync_version + 1
      WHERE id = ? AND status <> 'trashed'
      RETURNING *
    `).get(timestamp, timestamp, meetingId) as MeetingRow | undefined;
    if (row) return mapMeeting(row);

    const current = this.get(meetingId);
    if (current?.status === "trashed") return current;
    throw new MeetingNotFoundError(meetingId);
  }

  private restoreInTransaction(meetingId: string, timestamp: string): Meeting {
    const row = this.db.prepare(`
      UPDATE meetings
      SET status = COALESCE(status_before_trash, 'draft'), status_before_trash = NULL,
          trashed_at = NULL, updated_at = ?, sync_version = sync_version + 1
      WHERE id = ? AND status = 'trashed'
      RETURNING *
    `).get(timestamp, meetingId) as MeetingRow | undefined;
    if (row) return mapMeeting(row);

    const current = this.get(meetingId);
    if (current && current.status !== "trashed") return current;
    throw new MeetingNotFoundError(meetingId);
  }

  private require(id: string): Meeting {
    const meeting = this.get(id);
    if (!meeting) throw new MeetingNotFoundError(id);
    return meeting;
  }
}
