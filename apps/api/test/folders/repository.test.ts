import { FolderSchema, MeetingSchema } from "@meeting/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ZodError } from "zod";

import { openDatabase } from "../../src/db/database.js";
import {
  FolderNotFoundError,
  FolderSyncVersionConflictError,
  SqliteFolderRepository,
} from "../../src/folders/repository.js";
import { SqliteMeetingRepository } from "../../src/meetings/repository.js";

const CREATED_AT = "2026-08-20T10:00:00.000Z";
const LATER = "2026-08-20T11:00:00.000Z";
const FOLDER_ONE = "00000000-0000-4000-8000-000000000011";
const FOLDER_TWO = "00000000-0000-4000-8000-000000000012";
const FOLDER_THREE = "00000000-0000-4000-8000-000000000013";
const MEETING_ONE = "00000000-0000-4000-8000-000000000014";

const databases: ReturnType<typeof openDatabase>[] = [];

function repositories() {
  const db = openDatabase(":memory:");
  databases.push(db);
  return {
    folders: new SqliteFolderRepository(db),
    meetings: new SqliteMeetingRepository(db),
  };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("SqliteFolderRepository", () => {
  test("creates idempotently, lists case-insensitively, renames, and returns contract folders", () => {
    const { folders } = repositories();
    const created = folders.create({ id: FOLDER_ONE, name: "  Zeta  ", clientCreatedAt: CREATED_AT });
    const repeated = folders.create({ id: FOLDER_ONE, name: "Ignored", clientCreatedAt: LATER });
    folders.create({ id: FOLDER_TWO, name: "alpha", clientCreatedAt: CREATED_AT });

    expect(repeated).toEqual(created);
    expect(folders.list().map((folder) => folder.name)).toEqual(["alpha", "Zeta"]);
    const renamed = folders.rename(FOLDER_ONE, "  Beta  ", LATER);
    expect(renamed).toMatchObject({ name: "Beta", updatedAt: LATER, syncVersion: 1 });
    expect(FolderSchema.parse(renamed)).toEqual(renamed);
  });

  test("rejects names duplicated only by case and throws typed not-found errors", () => {
    const { folders } = repositories();
    folders.create({ id: FOLDER_ONE, name: "Projects", clientCreatedAt: CREATED_AT });

    let duplicateNameError: unknown;
    try {
      folders.create({ id: FOLDER_TWO, name: "projects", clientCreatedAt: CREATED_AT });
    } catch (error) {
      duplicateNameError = error;
    }
    expect(duplicateNameError).toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE" });
    expect(() => folders.rename(FOLDER_THREE, "Missing", LATER)).toThrow(FolderNotFoundError);
    expect(() => folders.remove(FOLDER_THREE, LATER)).toThrow(FolderNotFoundError);
  });

  test("removes folders atomically while retaining linked meetings with cleared folders and updated versions", () => {
    const { folders, meetings } = repositories();
    folders.create({ id: FOLDER_ONE, name: "Project", clientCreatedAt: CREATED_AT });
    meetings.create({ id: MEETING_ONE, title: "Standup", folderId: FOLDER_ONE, clientCreatedAt: CREATED_AT });

    folders.remove(FOLDER_ONE, LATER);

    expect(folders.list()).toEqual([]);
    const meeting = meetings.get(MEETING_ONE);
    expect(meeting).toMatchObject({ folderId: null, updatedAt: LATER, syncVersion: 1 });
    expect(MeetingSchema.parse(meeting)).toEqual(meeting);
  });

  test("validates folder inputs before mutations and reserves typed not-found errors for valid IDs", () => {
    const { folders } = repositories();
    const invalidId = "not-a-uuid";

    expect(() => folders.create({ id: invalidId, name: "Folder", clientCreatedAt: CREATED_AT })).toThrow(ZodError);
    expect(() => folders.create({ id: FOLDER_ONE, name: " ", clientCreatedAt: CREATED_AT })).toThrow(ZodError);
    expect(() => folders.create({ id: FOLDER_ONE, name: "Folder", clientCreatedAt: "not-a-date" })).toThrow(ZodError);
    expect(() => folders.rename(invalidId, " ", "not-a-date")).toThrow(ZodError);
    expect(() => folders.rename(invalidId, "Folder", LATER)).toThrow(ZodError);
    expect(() => folders.rename(FOLDER_ONE, " ", LATER)).toThrow(ZodError);
    expect(() => folders.rename(FOLDER_ONE, "Folder", "not-a-date")).toThrow(ZodError);
    expect(() => folders.remove(invalidId, "not-a-date")).toThrow(ZodError);
    expect(() => folders.remove(invalidId, LATER)).toThrow(ZodError);
    expect(() => folders.remove(FOLDER_ONE, "not-a-date")).toThrow(ZodError);
    expect(() => folders.rename(FOLDER_THREE, "Missing", LATER)).toThrow(FolderNotFoundError);
    expect(() => folders.remove(FOLDER_THREE, LATER)).toThrow(FolderNotFoundError);
  });

  test("classifies stale writes across two database connections and rolls back a stale removal", () => {
    const directory = mkdtempSync(join(tmpdir(), "folder-conditional-"));
    const path = join(directory, "catalog.sqlite");
    const firstDb = openDatabase(path);
    const secondDb = openDatabase(path);
    try {
      const first = new SqliteFolderRepository(firstDb);
      const second = new SqliteFolderRepository(secondDb);
      const meetings = new SqliteMeetingRepository(firstDb);
      first.create({ id: FOLDER_ONE, name: "Shared", clientCreatedAt: CREATED_AT });
      meetings.create({ id: MEETING_ONE, title: "Linked", folderId: FOLDER_ONE, clientCreatedAt: CREATED_AT });
      expect(first.rename(FOLDER_ONE, "First", LATER, 0)).toMatchObject({ syncVersion: 1 });
      expect(() => second.rename(FOLDER_ONE, "Stale", LATER, 0)).toThrow(FolderSyncVersionConflictError);
      expect(() => second.remove(FOLDER_ONE, LATER, 0)).toThrow(FolderSyncVersionConflictError);
      expect(meetings.get(MEETING_ONE)).toMatchObject({ folderId: FOLDER_ONE, syncVersion: 0 });
    } finally {
      secondDb.close();
      firstDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
