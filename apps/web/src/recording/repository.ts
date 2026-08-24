import {
  AudioChunkMetadataSchema,
  RecordingSessionSchema,
  type RecordingSession,
} from "@meeting/contracts";
import { z } from "zod";

import { type LocalAudioChunk, MeetingCatalogDatabase } from "../meetings/local-db.js";

const MeetingIdSchema = z.uuid();
const IsoDateTimeSchema = z.iso.datetime();
const OffsetSchema = z.int().nonnegative();
const RETENTION_MS = 48 * 60 * 60 * 1_000;

export class ActiveRecordingExistsError extends Error {
  constructor(meetingId: string) {
    super(`Another meeting is already recording: ${meetingId}`);
    this.name = "ActiveRecordingExistsError";
  }
}

function canonicalTimestamp(input: string): string {
  return new Date(IsoDateTimeSchema.parse(input)).toISOString();
}

function expiresFrom(input: string): string {
  return new Date(new Date(input).getTime() + RETENTION_MS).toISOString();
}

function blobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("AUDIO_CHUNK_READ_FAILED"));
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await blobArrayBuffer(blob));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class MeetingRecordingRepository {
  constructor(private readonly database: MeetingCatalogDatabase) {}

  async start(meetingIdInput: string, nowInput: string): Promise<RecordingSession> {
    const meetingId = MeetingIdSchema.parse(meetingIdInput);
    const startedAt = canonicalTimestamp(nowInput);
    return this.database.transaction("rw", this.database.recordingSessions, async () => {
      const existing = await this.database.recordingSessions.get(meetingId);
      if (existing?.state === "recording") return RecordingSessionSchema.parse(existing);
      if (existing) throw new Error(existing.state === "recoverable" ? "RECORDING_REQUIRES_RECOVERY" : "RECORDING_ALREADY_STOPPED");
      const active = (await this.database.recordingSessions.toArray()).find((session) =>
        session.state === "recording" || session.state === "recoverable");
      if (active) throw new ActiveRecordingExistsError(active.meetingId);
      const session = RecordingSessionSchema.parse({
        meetingId,
        state: "recording",
        startedAt,
        endedAt: null,
        elapsedMs: 0,
        nextSequence: 0,
        expiresAt: expiresFrom(startedAt),
      });
      await this.database.recordingSessions.add(session);
      return session;
    });
  }

  async session(meetingIdInput: string): Promise<RecordingSession | null> {
    const value = await this.database.recordingSessions.get(MeetingIdSchema.parse(meetingIdInput));
    return value ? RecordingSessionSchema.parse(value) : null;
  }

  async appendChunk(
    meetingIdInput: string,
    blob: Blob,
    startedOffsetInput: number,
    endedOffsetInput: number,
    capturedAtInput: string,
  ): Promise<LocalAudioChunk> {
    if (blob.size === 0) throw new Error("EMPTY_AUDIO_CHUNK");
    const meetingId = MeetingIdSchema.parse(meetingIdInput);
    const startedOffsetMs = OffsetSchema.parse(startedOffsetInput);
    const endedOffsetMs = OffsetSchema.parse(endedOffsetInput);
    const capturedAt = canonicalTimestamp(capturedAtInput);
    const hash = await sha256(blob);
    return this.database.transaction("rw", this.database.recordingSessions, this.database.audioChunks, async () => {
      const session = await this.database.recordingSessions.get(meetingId);
      if (!session || session.state !== "recording") throw new Error("RECORDING_NOT_ACTIVE");
      const metadata = AudioChunkMetadataSchema.parse({
        id: globalThis.crypto.randomUUID(),
        meetingId,
        sequence: session.nextSequence,
        startedOffsetMs,
        endedOffsetMs,
        capturedAt,
        expiresAt: expiresFrom(capturedAt),
        mimeType: blob.type || "application/octet-stream",
        sizeBytes: blob.size,
        sha256: hash,
        uploadState: "pending",
        remotePath: null,
        attempts: 0,
        lastError: null,
      });
      const chunk: LocalAudioChunk = { ...metadata, blob };
      await this.database.audioChunks.add(chunk);
      await this.database.recordingSessions.put(RecordingSessionSchema.parse({
        ...session,
        nextSequence: session.nextSequence + 1,
        elapsedMs: Math.max(session.elapsedMs, endedOffsetMs),
      }));
      return chunk;
    });
  }

  async listChunks(meetingIdInput: string): Promise<LocalAudioChunk[]> {
    const meetingId = MeetingIdSchema.parse(meetingIdInput);
    const chunks = await this.database.audioChunks.where("meetingId").equals(meetingId).toArray();
    return chunks.sort((left, right) => left.sequence - right.sequence);
  }

  async recoverInterruptedSessions(): Promise<number> {
    return this.database.transaction("rw", this.database.recordingSessions, async () => {
      const active = await this.database.recordingSessions.where("state").equals("recording").toArray();
      await Promise.all(active.map((session) => this.database.recordingSessions.put(RecordingSessionSchema.parse({
        ...session,
        state: "recoverable",
      }))));
      return active.length;
    });
  }

  async recoverableSessions(): Promise<RecordingSession[]> {
    const sessions = await this.database.recordingSessions.where("state").equals("recoverable").toArray();
    return sessions.map((session) => RecordingSessionSchema.parse(session));
  }

  private async finish(meetingIdInput: string, endedAtInput: string, expectedState: "recording" | "recoverable"): Promise<RecordingSession> {
    const meetingId = MeetingIdSchema.parse(meetingIdInput);
    const endedAt = canonicalTimestamp(endedAtInput);
    return this.database.transaction("rw", this.database.recordingSessions, async () => {
      const session = await this.database.recordingSessions.get(meetingId);
      if (!session || session.state !== expectedState) throw new Error("RECORDING_STATE_CHANGED");
      if (new Date(endedAt).getTime() < new Date(session.startedAt).getTime()) throw new Error("RECORDING_END_BEFORE_START");
      const stopped = RecordingSessionSchema.parse({
        ...session,
        state: "stopped",
        endedAt,
        expiresAt: expiresFrom(endedAt),
      });
      await this.database.recordingSessions.put(stopped);
      return stopped;
    });
  }

  stop(meetingId: string, endedAt: string): Promise<RecordingSession> {
    return this.finish(meetingId, endedAt, "recording");
  }

  completeRecovery(meetingId: string, endedAt: string): Promise<RecordingSession> {
    return this.finish(meetingId, endedAt, "recoverable");
  }

  async deleteExpiredAudio(nowInput: string): Promise<number> {
    const now = canonicalTimestamp(nowInput);
    return this.database.transaction("rw", this.database.recordingSessions, this.database.audioChunks, async () => {
      const expiredChunks = await this.database.audioChunks.where("expiresAt").belowOrEqual(now).toArray();
      await this.database.audioChunks.bulkDelete(expiredChunks.map((chunk) => chunk.id));
      const expiredSessions = await this.database.recordingSessions.where("expiresAt").belowOrEqual(now).toArray();
      for (const session of expiredSessions) {
        if (await this.database.audioChunks.where("meetingId").equals(session.meetingId).count() === 0) {
          await this.database.recordingSessions.delete(session.meetingId);
        }
      }
      return expiredChunks.length;
    });
  }
}
