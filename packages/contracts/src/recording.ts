import { z } from "zod";

const UuidSchema = z.uuid();
const IsoDateTimeSchema = z.iso.datetime();
const NonNegativeIntegerSchema = z.int().nonnegative();

export const RecordingStateSchema = z.enum(["recording", "recoverable", "stopped"]);
export const AudioChunkUploadStateSchema = z.enum(["pending", "uploaded", "failed"]);

export const RecordingSessionSchema = z.object({
  meetingId: UuidSchema,
  state: RecordingStateSchema,
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.nullable(),
  elapsedMs: NonNegativeIntegerSchema,
  nextSequence: NonNegativeIntegerSchema,
  expiresAt: IsoDateTimeSchema,
}).strict().superRefine((value, context) => {
  if (value.state === "stopped" && value.endedAt === null) {
    context.addIssue({ code: "custom", path: ["endedAt"], message: "Stopped recordings require an end time" });
  }
  if (value.state !== "stopped" && value.endedAt !== null) {
    context.addIssue({ code: "custom", path: ["endedAt"], message: "Active recordings cannot have an end time" });
  }
});

export const AudioChunkMetadataSchema = z.object({
  id: UuidSchema,
  meetingId: UuidSchema,
  sequence: NonNegativeIntegerSchema,
  startedOffsetMs: NonNegativeIntegerSchema,
  endedOffsetMs: NonNegativeIntegerSchema,
  capturedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  mimeType: z.string().trim().min(1).max(200),
  sizeBytes: z.int().positive().max(100 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  uploadState: AudioChunkUploadStateSchema,
  remotePath: z.string().trim().min(1).max(1024).nullable(),
  attempts: NonNegativeIntegerSchema,
  lastError: z.string().max(500).nullable(),
}).strict().superRefine((value, context) => {
  if (value.endedOffsetMs <= value.startedOffsetMs) {
    context.addIssue({ code: "custom", path: ["endedOffsetMs"], message: "Chunk end must follow chunk start" });
  }
  if (value.uploadState === "uploaded" && value.remotePath === null) {
    context.addIssue({ code: "custom", path: ["remotePath"], message: "Uploaded chunks require a remote path" });
  }
  if (value.uploadState !== "uploaded" && value.remotePath !== null) {
    context.addIssue({ code: "custom", path: ["remotePath"], message: "Pending chunks cannot have a remote path" });
  }
});

export type RecordingState = z.infer<typeof RecordingStateSchema>;
export type RecordingSession = z.infer<typeof RecordingSessionSchema>;
export type AudioChunkUploadState = z.infer<typeof AudioChunkUploadStateSchema>;
export type AudioChunkMetadata = z.infer<typeof AudioChunkMetadataSchema>;
