import Dexie from "dexie";
import { afterEach, describe, expect, test } from "vitest";

import { MeetingCatalogDatabase } from "../../src/meetings/local-db.js";
import { ActiveRecordingExistsError, MeetingRecordingRepository } from "../../src/recording/repository.js";

const meetingA = "00000000-0000-4000-8000-00000000000a";
const meetingB = "00000000-0000-4000-8000-00000000000b";
const start = "2026-08-24T00:00:00.000Z";

describe("MeetingRecordingRepository", () => {
  const databases: MeetingCatalogDatabase[] = [];
  const names: string[] = [];

  function createRepository(name = `recording-repository-${crypto.randomUUID()}`) {
    names.push(name);
    const database = new MeetingCatalogDatabase(name);
    databases.push(database);
    return { repository: new MeetingRecordingRepository(database), database, name };
  }

  afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    await Promise.all([...new Set(names.splice(0))].map((name) => Dexie.delete(name)));
  });

  test("starts idempotently for one meeting and rejects a second active meeting", async () => {
    const { repository } = createRepository();

    const first = await repository.start(meetingA, start);
    const duplicate = await repository.start(meetingA, "2026-08-24T00:01:00.000Z");

    expect(duplicate).toEqual(first);
    await expect(repository.start(meetingB, start)).rejects.toBeInstanceOf(ActiveRecordingExistsError);
  });

  test("atomically allocates sequential chunks and persists their blobs across reopen", async () => {
    const { repository: first, database, name } = createRepository();
    await first.start(meetingA, start);

    await Promise.all([
      first.appendChunk(meetingA, new Blob(["first"], { type: "audio/webm" }), 0, 10_000, "2026-08-24T00:00:10.000Z"),
      first.appendChunk(meetingA, new Blob(["second"], { type: "audio/webm" }), 10_000, 20_000, "2026-08-24T00:00:20.000Z"),
    ]);

    expect((await first.listChunks(meetingA)).map((chunk) => chunk.sequence)).toEqual([0, 1]);
    expect(await first.session(meetingA)).toMatchObject({ nextSequence: 2, elapsedMs: 20_000 });
    database.close();
    const reopenedDatabase = new MeetingCatalogDatabase(name);
    databases.push(reopenedDatabase);
    const reopened = new MeetingRecordingRepository(reopenedDatabase);
    const chunks = await reopened.listChunks(meetingA);
    expect(chunks[0]).toMatchObject({ sizeBytes: 5, mimeType: "audio/webm" });
    expect(chunks[1]).toMatchObject({ sizeBytes: 6, mimeType: "audio/webm" });
    expect(chunks[0]!.blob).toBeDefined();
    expect(chunks[1]!.blob).toBeDefined();
    expect(chunks[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects empty audio without advancing the session", async () => {
    const { repository } = createRepository();
    await repository.start(meetingA, start);

    await expect(repository.appendChunk(meetingA, new Blob([], { type: "audio/webm" }), 0, 10_000, start)).rejects.toThrow("EMPTY_AUDIO_CHUNK");

    await expect(repository.listChunks(meetingA)).resolves.toEqual([]);
    await expect(repository.session(meetingA)).resolves.toMatchObject({ nextSequence: 0, elapsedMs: 0 });
  });

  test("marks an unclosed recording recoverable without inventing an end time", async () => {
    const { repository } = createRepository();
    await repository.start(meetingA, start);
    await repository.appendChunk(meetingA, new Blob(["audio"], { type: "audio/webm" }), 0, 10_000, "2026-08-24T00:00:10.000Z");

    await repository.recoverInterruptedSessions();

    await expect(repository.recoverableSessions()).resolves.toEqual([
      expect.objectContaining({ meetingId: meetingA, state: "recoverable", endedAt: null, elapsedMs: 10_000 }),
    ]);
    await expect(repository.completeRecovery(meetingA, "2026-08-24T00:02:00.000Z")).resolves.toMatchObject({
      state: "stopped",
      endedAt: "2026-08-24T00:02:00.000Z",
    });
  });

  test("deletes raw audio at 48 hours while preserving meetings and notes", async () => {
    const { repository, database } = createRepository();
    const meeting = {
      id: meetingA,
      title: "Retained meeting",
      folderId: null,
      status: "draft" as const,
      startedAt: null,
      endedAt: null,
      createdAt: start,
      updatedAt: start,
      trashedAt: null,
      syncVersion: 0,
      note: "永久保留的会议笔记",
    };
    await database.meetings.put(meeting);
    await repository.start(meetingA, start);
    await repository.appendChunk(meetingA, new Blob(["audio"], { type: "audio/webm" }), 0, 10_000, start);
    await repository.stop(meetingA, "2026-08-24T00:10:00.000Z");

    await expect(repository.deleteExpiredAudio("2026-08-25T23:59:59.999Z")).resolves.toBe(0);
    expect(await repository.listChunks(meetingA)).toHaveLength(1);
    await expect(repository.deleteExpiredAudio("2026-08-26T00:00:00.000Z")).resolves.toBe(1);
    await expect(repository.listChunks(meetingA)).resolves.toEqual([]);
    await expect(database.meetings.get(meetingA)).resolves.toEqual(meeting);
  });
});
