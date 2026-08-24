import Dexie from "dexie";
import { afterEach, describe, expect, test } from "vitest";

import { MeetingCatalogDatabase } from "../../src/meetings/local-db.js";

describe("MeetingCatalogDatabase recording migration", () => {
  const names: string[] = [];

  afterEach(async () => {
    await Promise.all(names.splice(0).map((name) => Dexie.delete(name)));
  });

  test("upgrades a v3 catalog with empty recording stores and preserves catalog rows", async () => {
    const name = `recording-migration-${crypto.randomUUID()}`;
    names.push(name);
    const meeting = {
      id: crypto.randomUUID(),
      title: "Existing meeting",
      folderId: null,
      status: "draft",
      startedAt: null,
      endedAt: null,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
      trashedAt: null,
      syncVersion: 0,
      note: "kept",
    };
    const legacy = new Dexie(name);
    legacy.version(3).stores({
      meetings: "id,updatedAt,status,folderId,title",
      folders: "id,name,updatedAt",
      outbox: "++sequence,id,entityId,kind,createdAt",
      settings: "key",
    });
    await legacy.table("meetings").put(meeting);
    legacy.close();

    const database = new MeetingCatalogDatabase(name);
    await database.open();

    await expect(database.meetings.get(meeting.id)).resolves.toEqual(meeting);
    await expect(database.recordingSessions.count()).resolves.toBe(0);
    await expect(database.audioChunks.count()).resolves.toBe(0);
    expect(database.tables.map((table) => table.name)).toEqual(expect.arrayContaining([
      "meetings", "folders", "outbox", "settings", "recordingSessions", "audioChunks",
    ]));
    database.close();
  });
});
