import { describe, expect, test } from "vitest";

import { AudioChunkMetadataSchema, RecordingSessionSchema } from "./recording.js";

const meetingId = "00000000-0000-4000-8000-000000000001";
const startedAt = "2026-08-24T00:00:00.000Z";
const expiresAt = "2026-08-26T00:00:00.000Z";

describe("RecordingSessionSchema", () => {
  test.each(["recording", "recoverable", "stopped"] as const)("accepts the %s lifecycle state", (state) => {
    expect(RecordingSessionSchema.parse({
      meetingId,
      state,
      startedAt,
      endedAt: state === "stopped" ? "2026-08-24T01:00:00.000Z" : null,
      elapsedMs: 3_600_000,
      nextSequence: 6,
      expiresAt,
    }).state).toBe(state);
  });

  test("rejects negative elapsed time and chunk sequence", () => {
    expect(() => RecordingSessionSchema.parse({
      meetingId,
      state: "recording",
      startedAt,
      endedAt: null,
      elapsedMs: -1,
      nextSequence: -1,
      expiresAt,
    })).toThrow();
  });
});

describe("AudioChunkMetadataSchema", () => {
  const valid = {
    id: "00000000-0000-4000-8000-000000000002",
    meetingId,
    sequence: 0,
    startedOffsetMs: 0,
    endedOffsetMs: 10_000,
    capturedAt: startedAt,
    expiresAt,
    mimeType: "audio/webm;codecs=opus",
    sizeBytes: 12_345,
    sha256: "a".repeat(64),
    uploadState: "pending",
    remotePath: null,
    attempts: 0,
    lastError: null,
  };

  test("accepts durable pending audio metadata", () => {
    expect(AudioChunkMetadataSchema.parse(valid)).toEqual(valid);
  });

  test.each([
    ["negative sequence", { sequence: -1 }],
    ["empty MIME", { mimeType: "" }],
    ["empty chunk", { sizeBytes: 0 }],
    ["invalid hash", { sha256: "not-a-sha256" }],
    ["reversed offsets", { startedOffsetMs: 20, endedOffsetMs: 10 }],
  ])("rejects %s", (_case, patch) => {
    expect(() => AudioChunkMetadataSchema.parse({ ...valid, ...patch })).toThrow();
  });

  test("requires a remote path only after upload acknowledgement", () => {
    expect(() => AudioChunkMetadataSchema.parse({ ...valid, uploadState: "uploaded" })).toThrow();
    expect(AudioChunkMetadataSchema.parse({
      ...valid,
      uploadState: "uploaded",
      remotePath: `${meetingId}/0.webm`,
    }).uploadState).toBe("uploaded");
  });
});
