import { describe, expect, test, vi } from "vitest";

import type { LocalAudioChunk } from "../../src/meetings/local-db.js";
import {
  RecordingUploadConflictError,
  RecordingUploadWorker,
  SupabaseRecordingStorage,
  createSupabaseRecordingStorage,
  type RemoteAudioChunk,
  type SupabaseRecordingStoragePort,
} from "../../src/recording/storage.js";

const userId = "00000000-0000-4000-8000-000000000101";
const otherUserId = "00000000-0000-4000-8000-000000000102";
const meetingId = "00000000-0000-4000-8000-000000000201";
const hash = "a".repeat(64);
const path = `${userId}/${meetingId}/7.webm`;

function chunk(overrides: Partial<LocalAudioChunk> = {}): LocalAudioChunk {
  return {
    id: "00000000-0000-4000-8000-000000000301",
    meetingId,
    sequence: 7,
    startedOffsetMs: 60_000,
    endedOffsetMs: 70_000,
    capturedAt: "2026-08-24T00:01:10.000Z",
    expiresAt: "2026-08-26T00:01:10.000Z",
    mimeType: "audio/webm;codecs=opus",
    sizeBytes: 5,
    sha256: hash,
    uploadState: "pending",
    remotePath: null,
    attempts: 0,
    lastError: null,
    blob: new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
    ...overrides,
  };
}

function port(overrides: Partial<SupabaseRecordingStoragePort> = {}): SupabaseRecordingStoragePort {
  return {
    currentUserId: vi.fn().mockResolvedValue(userId),
    findMetadata: vi.fn().mockResolvedValue(null),
    findObject: vi.fn().mockResolvedValue(null),
    uploadObject: vi.fn().mockResolvedValue(undefined),
    insertMetadata: vi.fn().mockResolvedValue("inserted"),
    ...overrides,
  };
}

describe("SupabaseRecordingStorage", () => {
  test("adapts the authenticated Supabase client, private bucket, and metadata table", async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: userId } }, error: null });
    const list = vi.fn().mockResolvedValue({ data: [], error: null });
    const upload = vi.fn().mockResolvedValue({ data: { path }, error: null });
    const bucket = { list, upload };
    const fromBucket = vi.fn().mockReturnValue(bucket);
    const metadataQuery = {
      select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    metadataQuery.select.mockReturnValue(metadataQuery);
    metadataQuery.eq.mockReturnValue(metadataQuery);
    const insert = vi.fn().mockResolvedValue({ error: null });
    const fromTable = vi.fn().mockReturnValue({ ...metadataQuery, insert });
    const client = { auth: { getUser }, storage: { from: fromBucket }, from: fromTable };

    await expect(createSupabaseRecordingStorage(client as never).uploadChunk(userId, chunk()))
      .resolves.toEqual({ remotePath: path });

    expect(fromBucket).toHaveBeenCalledWith("meeting-audio");
    expect(list).toHaveBeenCalledWith(`${userId}/${meetingId}`, { limit: 100, search: "7.webm" });
    expect(upload).toHaveBeenCalledWith(path, expect.any(Blob), expect.objectContaining({ upsert: false }));
    expect((upload.mock.calls[0]?.[1] as Blob).type).toBe("audio/webm");
    expect(fromTable).toHaveBeenCalledWith("meeting_audio_chunks");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: userId,
      meeting_id: meetingId,
      sequence: 7,
      remote_path: path,
      sha256: hash,
    }));
  });

  test("uploads to a deterministic owner path without overwrite and records metadata", async () => {
    const remote = port();
    const storage = new SupabaseRecordingStorage(remote);

    await expect(storage.uploadChunk(userId, chunk())).resolves.toEqual({ remotePath: path });

    expect(remote.uploadObject).toHaveBeenCalledWith(path, expect.any(Blob), {
      contentType: "audio/webm",
      upsert: false,
      metadata: { sha256: hash },
    });
    expect(remote.insertMetadata).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      meetingId,
      sequence: 7,
      remotePath: path,
      sha256: hash,
    }));
  });

  test("rejects a changed authenticated actor before reading or writing storage", async () => {
    const remote = port({ currentUserId: vi.fn().mockResolvedValue(otherUserId) });

    await expect(new SupabaseRecordingStorage(remote).uploadChunk(userId, chunk())).rejects.toMatchObject({
      name: "RecordingStorageAuthError",
      message: "AUTH_CONTEXT_CHANGED",
    });
    expect(remote.findMetadata).not.toHaveBeenCalled();
    expect(remote.uploadObject).not.toHaveBeenCalled();
  });

  test("acknowledges an existing object with the same hash without uploading again", async () => {
    const existing: RemoteAudioChunk = {
      userId,
      meetingId,
      sequence: 7,
      remotePath: path,
      sha256: hash,
      sizeBytes: 5,
      mimeType: "audio/webm;codecs=opus",
      capturedAt: "2026-08-24T00:01:10.000Z",
      expiresAt: "2026-08-26T00:01:10.000Z",
    };
    const remote = port({ findMetadata: vi.fn().mockResolvedValue(existing) });

    await expect(new SupabaseRecordingStorage(remote).uploadChunk(userId, chunk())).resolves.toEqual({ remotePath: path });
    expect(remote.uploadObject).not.toHaveBeenCalled();
    expect(remote.insertMetadata).not.toHaveBeenCalled();
  });

  test("never overwrites an existing sequence with a different hash", async () => {
    const remote = port({
      findObject: vi.fn().mockResolvedValue({ name: "7.webm", sha256: "b".repeat(64) }),
    });

    await expect(new SupabaseRecordingStorage(remote).uploadChunk(userId, chunk()))
      .rejects.toEqual(new RecordingUploadConflictError());
    expect(remote.uploadObject).not.toHaveBeenCalled();
  });

  test("coordinates a lost upload response when matching metadata appears", async () => {
    const existing: RemoteAudioChunk = {
      userId,
      meetingId,
      sequence: 7,
      remotePath: path,
      sha256: hash,
      sizeBytes: 5,
      mimeType: "audio/webm;codecs=opus",
      capturedAt: "2026-08-24T00:01:10.000Z",
      expiresAt: "2026-08-26T00:01:10.000Z",
    };
    const uploadFailure = new Error("response lost");
    const remote = port({
      findMetadata: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(existing),
      uploadObject: vi.fn().mockRejectedValue(uploadFailure),
    });

    await expect(new SupabaseRecordingStorage(remote).uploadChunk(userId, chunk()))
      .resolves.toEqual({ remotePath: path });
    expect(remote.findMetadata).toHaveBeenCalledTimes(2);
    expect(remote.insertMetadata).not.toHaveBeenCalled();
  });

  test("coordinates a duplicate upload when a matching object appears", async () => {
    const uploadFailure = new Error("duplicate object");
    const remote = port({
      findMetadata: vi.fn().mockResolvedValue(null),
      findObject: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ name: "7.webm", sha256: hash }),
      uploadObject: vi.fn().mockRejectedValue(uploadFailure),
    });

    await expect(new SupabaseRecordingStorage(remote).uploadChunk(userId, chunk()))
      .resolves.toEqual({ remotePath: path });
    expect(remote.findObject).toHaveBeenCalledTimes(2);
    expect(remote.insertMetadata).toHaveBeenCalledOnce();
  });

  test("propagates an upload failure when reconciliation still finds no remote chunk", async () => {
    const uploadFailure = new Error("offline");
    const remote = port({ uploadObject: vi.fn().mockRejectedValue(uploadFailure) });

    await expect(new SupabaseRecordingStorage(remote).uploadChunk(userId, chunk()))
      .rejects.toBe(uploadFailure);
    expect(remote.findMetadata).toHaveBeenCalledTimes(2);
    expect(remote.findObject).toHaveBeenCalledTimes(2);
    expect(remote.insertMetadata).not.toHaveBeenCalled();
  });

  test("reports a conflict when reconciliation finds an object with a different hash", async () => {
    const remote = port({
      findObject: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ name: "7.webm", sha256: "b".repeat(64) }),
      uploadObject: vi.fn().mockRejectedValue(new Error("duplicate object")),
    });

    await expect(new SupabaseRecordingStorage(remote).uploadChunk(userId, chunk()))
      .rejects.toEqual(new RecordingUploadConflictError());
    expect(remote.insertMetadata).not.toHaveBeenCalled();
  });
});

describe("RecordingUploadWorker", () => {
  test("deletes expired local audio before selecting chunks to upload", async () => {
    const repository = {
      deleteExpiredAudio: vi.fn().mockResolvedValue(1),
      pendingChunks: vi.fn().mockResolvedValue([]),
      markUploadAttempt: vi.fn().mockResolvedValue(undefined),
      markUploadFailed: vi.fn().mockResolvedValue(undefined),
      markUploaded: vi.fn().mockResolvedValue(undefined),
    };
    const storage = { uploadChunk: vi.fn() };

    await new RecordingUploadWorker(repository, storage, () => "2026-08-26T00:00:00.000Z").run(userId);

    expect(repository.deleteExpiredAudio).toHaveBeenCalledWith("2026-08-26T00:00:00.000Z");
    expect(repository.deleteExpiredAudio.mock.invocationCallOrder[0]).toBeLessThan(repository.pendingChunks.mock.invocationCallOrder[0]!);
    expect(storage.uploadChunk).not.toHaveBeenCalled();
  });

  test("serializes overlapping runs so a trailing run sees newly persisted chunks", async () => {
    const first = chunk({ id: "00000000-0000-4000-8000-000000000301", sequence: 7 });
    const second = chunk({ id: "00000000-0000-4000-8000-000000000302", sequence: 8 });
    const repository = {
      deleteExpiredAudio: vi.fn().mockResolvedValue(0),
      pendingChunks: vi.fn().mockResolvedValueOnce([first]).mockResolvedValueOnce([second]),
      markUploadAttempt: vi.fn().mockResolvedValue(undefined),
      markUploadFailed: vi.fn().mockResolvedValue(undefined),
      markUploaded: vi.fn().mockResolvedValue(undefined),
    };
    const firstUpload = Promise.withResolvers<{ remotePath: string }>();
    const storage = { uploadChunk: vi.fn()
      .mockReturnValueOnce(firstUpload.promise)
      .mockResolvedValueOnce({ remotePath: `${userId}/${meetingId}/8.webm` }) };
    const worker = new RecordingUploadWorker(repository, storage);

    const leading = worker.run(userId);
    const trailing = worker.run(userId);
    await vi.waitFor(() => expect(storage.uploadChunk).toHaveBeenCalled());
    expect(storage.uploadChunk).toHaveBeenCalledOnce();
    firstUpload.resolve({ remotePath: path });

    await expect(Promise.all([leading, trailing])).resolves.toEqual([
      { uploaded: 1, failed: 0 },
      { uploaded: 1, failed: 0 },
    ]);
    expect(storage.uploadChunk).toHaveBeenCalledTimes(2);
  });

  test("keeps the local blob pending after a network failure", async () => {
    const pending = chunk();
    const repository = {
      deleteExpiredAudio: vi.fn().mockResolvedValue(0),
      pendingChunks: vi.fn().mockResolvedValue([pending]),
      markUploadAttempt: vi.fn().mockResolvedValue(undefined),
      markUploadFailed: vi.fn().mockResolvedValue(undefined),
      markUploaded: vi.fn().mockResolvedValue(undefined),
    };
    const storage = { uploadChunk: vi.fn().mockRejectedValue(new TypeError("offline")) };

    await expect(new RecordingUploadWorker(repository, storage).run(userId)).resolves.toEqual({ uploaded: 0, failed: 1 });

    expect(repository.markUploadFailed).toHaveBeenCalledWith(pending.id, "UPLOAD_FAILED");
    expect(repository.markUploadAttempt).toHaveBeenCalledWith(pending.id);
    expect(repository.markUploaded).not.toHaveBeenCalled();
    expect(pending.blob.size).toBe(5);
  });

  test("marks a chunk uploaded only after durable remote acknowledgement", async () => {
    const pending = chunk();
    const repository = {
      deleteExpiredAudio: vi.fn().mockResolvedValue(0),
      pendingChunks: vi.fn().mockResolvedValue([pending]),
      markUploadAttempt: vi.fn().mockResolvedValue(undefined),
      markUploadFailed: vi.fn().mockResolvedValue(undefined),
      markUploaded: vi.fn().mockResolvedValue(undefined),
    };
    const acknowledgement = Promise.withResolvers<{ remotePath: string }>();
    const storage = { uploadChunk: vi.fn().mockReturnValue(acknowledgement.promise) };
    const running = new RecordingUploadWorker(repository, storage).run(userId);

    await vi.waitFor(() => expect(repository.markUploadAttempt).toHaveBeenCalledWith(pending.id));
    expect(repository.markUploaded).not.toHaveBeenCalled();
    acknowledgement.resolve({ remotePath: path });

    await expect(running).resolves.toEqual({ uploaded: 1, failed: 0 });
    expect(repository.markUploaded).toHaveBeenCalledWith(pending.id, path);
  });
});
