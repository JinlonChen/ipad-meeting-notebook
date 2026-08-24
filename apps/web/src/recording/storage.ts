import { AudioChunkMetadataSchema } from "@meeting/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { LocalAudioChunk } from "../meetings/local-db.js";
import type { Database, MeetingAudioChunkRow } from "../supabase/types.js";

const UserIdSchema = z.uuid();
const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export type RemoteAudioChunk = {
  userId: string;
  meetingId: string;
  sequence: number;
  remotePath: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  capturedAt: string;
  expiresAt: string;
};

export type RemoteAudioObject = { name: string; sha256: string | null };

export type SupabaseRecordingStoragePort = {
  currentUserId(): Promise<string | null>;
  findMetadata(userId: string, meetingId: string, sequence: number): Promise<RemoteAudioChunk | null>;
  findObject(prefix: string, name: string): Promise<RemoteAudioObject | null>;
  uploadObject(path: string, blob: Blob, options: {
    contentType: string;
    upsert: false;
    metadata: { sha256: string };
  }): Promise<void>;
  insertMetadata(chunk: RemoteAudioChunk): Promise<"inserted" | "conflict">;
};

export class RecordingStorageAuthError extends Error {
  constructor(code: "AUTH_REQUIRED" | "AUTH_CONTEXT_CHANGED") {
    super(code);
    this.name = "RecordingStorageAuthError";
  }
}

export class RecordingUploadConflictError extends Error {
  constructor() {
    super("AUDIO_CHUNK_CONFLICT");
    this.name = "RecordingUploadConflictError";
  }
}

function extension(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";", 1)[0]?.trim();
  if (normalized === "audio/webm") return "webm";
  if (normalized === "audio/mp4") return "m4a";
  return "bin";
}

function uploadContentType(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";", 1)[0]?.trim();
  return normalized === "audio/webm" || normalized === "audio/mp4" ? normalized : "application/octet-stream";
}

function sameChunk(remote: RemoteAudioChunk, expectedUserId: string, chunk: LocalAudioChunk, path: string): boolean {
  return remote.userId === expectedUserId
    && remote.meetingId === chunk.meetingId
    && remote.sequence === chunk.sequence
    && remote.remotePath === path
    && remote.sha256 === chunk.sha256
    && remote.sizeBytes === chunk.sizeBytes;
}

export class SupabaseRecordingStorage {
  constructor(private readonly port: SupabaseRecordingStoragePort) {}

  async uploadChunk(expectedUserIdInput: string, chunk: LocalAudioChunk): Promise<{ remotePath: string }> {
    const expectedUserId = UserIdSchema.parse(expectedUserIdInput);
    const { blob: _blob, ...metadataInput } = chunk;
    const metadata = AudioChunkMetadataSchema.parse(metadataInput);
    if (chunk.blob.size !== metadata.sizeBytes) throw new Error("AUDIO_CHUNK_SIZE_CHANGED");
    const actor = await this.port.currentUserId();
    if (!actor) throw new RecordingStorageAuthError("AUTH_REQUIRED");
    if (actor !== expectedUserId) throw new RecordingStorageAuthError("AUTH_CONTEXT_CHANGED");

    const filename = `${metadata.sequence}.${extension(metadata.mimeType)}`;
    const prefix = `${expectedUserId}/${metadata.meetingId}`;
    const remotePath = `${prefix}/${filename}`;
    const existingMetadata = await this.port.findMetadata(expectedUserId, metadata.meetingId, metadata.sequence);
    if (existingMetadata) {
      if (!sameChunk(existingMetadata, expectedUserId, chunk, remotePath)) throw new RecordingUploadConflictError();
      return { remotePath };
    }

    const existingObject = await this.port.findObject(prefix, filename);
    if (existingObject) {
      if (existingObject.name !== filename || existingObject.sha256 !== metadata.sha256) {
        throw new RecordingUploadConflictError();
      }
    } else {
      try {
        await this.port.uploadObject(remotePath, chunk.blob, {
          contentType: uploadContentType(metadata.mimeType),
          upsert: false,
          metadata: { sha256: HashSchema.parse(metadata.sha256) },
        });
      } catch (uploadError) {
        const winner = await this.port.findMetadata(expectedUserId, metadata.meetingId, metadata.sequence);
        if (winner) {
          if (!sameChunk(winner, expectedUserId, chunk, remotePath)) throw new RecordingUploadConflictError();
          return { remotePath };
        }
        const uploadedObject = await this.port.findObject(prefix, filename);
        if (!uploadedObject) throw uploadError;
        if (uploadedObject.name !== filename || uploadedObject.sha256 !== metadata.sha256) {
          throw new RecordingUploadConflictError();
        }
      }
    }

    const remoteChunk: RemoteAudioChunk = {
      userId: expectedUserId,
      meetingId: metadata.meetingId,
      sequence: metadata.sequence,
      remotePath,
      sha256: metadata.sha256,
      sizeBytes: metadata.sizeBytes,
      mimeType: metadata.mimeType,
      capturedAt: metadata.capturedAt,
      expiresAt: metadata.expiresAt,
    };
    const inserted = await this.port.insertMetadata(remoteChunk);
    if (inserted === "conflict") {
      const winner = await this.port.findMetadata(expectedUserId, metadata.meetingId, metadata.sequence);
      if (!winner || !sameChunk(winner, expectedUserId, chunk, remotePath)) throw new RecordingUploadConflictError();
    }
    return { remotePath };
  }
}

function remoteChunk(row: MeetingAudioChunkRow): RemoteAudioChunk {
  return {
    userId: row.user_id,
    meetingId: row.meeting_id,
    sequence: row.sequence,
    remotePath: row.remote_path,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    capturedAt: row.captured_at,
    expiresAt: row.expires_at,
  };
}

function storageFailure(code: string): Error {
  return new Error(code);
}

export function createSupabaseRecordingStorage(client: SupabaseClient<Database>): SupabaseRecordingStorage {
  const bucket = client.storage.from("meeting-audio");
  const port: SupabaseRecordingStoragePort = {
    currentUserId: async () => {
      const { data, error } = await client.auth.getUser();
      if (error) throw storageFailure("AUTH_LOOKUP_FAILED");
      return data.user?.id ?? null;
    },
    findMetadata: async (userId, meetingId, sequence) => {
      const { data, error } = await client
        .from("meeting_audio_chunks")
        .select("user_id,meeting_id,sequence,bucket_id,remote_path,sha256,size_bytes,mime_type,captured_at,expires_at,created_at")
        .eq("user_id", userId)
        .eq("meeting_id", meetingId)
        .eq("sequence", sequence)
        .maybeSingle();
      if (error) throw storageFailure("AUDIO_METADATA_READ_FAILED");
      return data ? remoteChunk(data) : null;
    },
    findObject: async (prefix, name) => {
      const { data, error } = await bucket.list(prefix, { limit: 100, search: name });
      if (error) throw storageFailure("AUDIO_OBJECT_READ_FAILED");
      const object = data.find((candidate) => candidate.name === name);
      if (!object) return null;
      const parsedHash = HashSchema.safeParse(object.metadata?.sha256);
      return { name: object.name, sha256: parsedHash.success ? parsedHash.data : null };
    },
    uploadObject: async (path, blob, options) => {
      const uploadBlob = blob.slice(0, blob.size, options.contentType);
      const { error } = await bucket.upload(path, uploadBlob, options);
      if (error) throw storageFailure("AUDIO_OBJECT_UPLOAD_FAILED");
    },
    insertMetadata: async (chunk) => {
      const { error } = await client.from("meeting_audio_chunks").insert({
        user_id: chunk.userId,
        meeting_id: chunk.meetingId,
        sequence: chunk.sequence,
        remote_path: chunk.remotePath,
        sha256: chunk.sha256,
        size_bytes: chunk.sizeBytes,
        mime_type: chunk.mimeType,
        captured_at: chunk.capturedAt,
        expires_at: chunk.expiresAt,
      });
      if (!error) return "inserted";
      if (error.code === "23505") return "conflict";
      throw storageFailure("AUDIO_METADATA_WRITE_FAILED");
    },
  };
  return new SupabaseRecordingStorage(port);
}

type UploadRepositoryPort = {
  deleteExpiredAudio(now: string): Promise<unknown>;
  pendingChunks(): Promise<LocalAudioChunk[]>;
  markUploadAttempt(id: string): Promise<unknown>;
  markUploadFailed(id: string, error: string): Promise<unknown>;
  markUploaded(id: string, remotePath: string): Promise<unknown>;
};

export type RecordingStoragePort = {
  uploadChunk(expectedUserId: string, chunk: LocalAudioChunk): Promise<{ remotePath: string }>;
};

export class RecordingUploadWorker {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: UploadRepositoryPort,
    private readonly storage: RecordingStoragePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  run(expectedUserId: string): Promise<{ uploaded: number; failed: number }> {
    const result = this.queue.then(() => this.runOnce(expectedUserId));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async runOnce(expectedUserId: string): Promise<{ uploaded: number; failed: number }> {
    let uploaded = 0;
    let failed = 0;
    await this.repository.deleteExpiredAudio(this.now());
    for (const chunk of await this.repository.pendingChunks()) {
      try {
        await this.repository.markUploadAttempt(chunk.id);
        const acknowledgement = await this.storage.uploadChunk(expectedUserId, chunk);
        await this.repository.markUploaded(chunk.id, acknowledgement.remotePath);
        uploaded += 1;
      } catch {
        await this.repository.markUploadFailed(chunk.id, "UPLOAD_FAILED");
        failed += 1;
      }
    }
    return { uploaded, failed };
  }
}
