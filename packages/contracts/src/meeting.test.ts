import { describe, expect, test } from "vitest";

import {
  CreateFolderInputSchema,
  CreateMeetingInputSchema,
  FolderRenameWireBodySchema,
  FolderSchema,
  FolderMutationBodySchema,
  FolderRenameBodySchema,
  IdempotencyKeySchema,
  LegacyFolderRenameBodySchema,
  LegacyMeetingPatchBodySchema,
  MeetingNoteBodySchema,
  MeetingNoteOperationSchema,
  MeetingNoteSchema,
  MeetingMutationBodySchema,
  MeetingPatchBodySchema,
  MeetingPatchWireBodySchema,
  MeetingListQuerySchema,
  MeetingSchema,
} from "./meeting";

const meetingId = "018f16d3-7e74-7ac4-a18a-53e674613f76";
const folderId = "018f16d3-7e74-7ac4-a18a-53e674613f77";
const timestamp = "2025-01-01T10:00:00.000Z";

describe("meeting contracts", () => {
  test("accepts a client-generated UUID and trims a meeting title", () => {
    const input = CreateMeetingInputSchema.parse({
      id: meetingId,
      title: "  Sprint planning  ",
      folderId,
      clientCreatedAt: timestamp,
    });

    expect(input).toMatchObject({ id: meetingId, title: "Sprint planning", folderId });
  });

  test("rejects invalid, empty, and too-long meeting titles and non-UUID ids", () => {
    const validInput = {
      id: meetingId,
      title: "Valid title",
      folderId: null,
      clientCreatedAt: timestamp,
    };

    expect(() => CreateMeetingInputSchema.parse({ ...validInput, id: "not-a-uuid" })).toThrow();
    expect(() => CreateMeetingInputSchema.parse({ ...validInput, title: "   " })).toThrow();
    expect(() => CreateMeetingInputSchema.parse({ ...validInput, title: "a".repeat(121) })).toThrow();
  });

  test("rejects a complete ready meeting without updatedAt", () => {
    expect(() =>
      MeetingSchema.parse({
        id: meetingId,
        title: "Ready meeting",
        folderId: null,
        status: "ready",
        startedAt: timestamp,
        endedAt: timestamp,
        createdAt: timestamp,
        trashedAt: null,
        syncVersion: 0,
      }),
    ).toThrow();
  });

  test("accepts a fully valid meeting", () => {
    expect(MeetingSchema.parse({
      id: meetingId,
      title: "Ready meeting",
      folderId,
      status: "ready",
      startedAt: timestamp,
      endedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      trashedAt: null,
      syncVersion: 1,
    })).toMatchObject({ id: meetingId, status: "ready", syncVersion: 1 });
  });

  test("defaults a legacy meeting row note to an empty string", () => {
    const meeting = MeetingSchema.parse({
      id: meetingId,
      title: "Ready meeting",
      folderId: null,
      status: "ready",
      startedAt: timestamp,
      endedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      trashedAt: null,
      syncVersion: 1,
    });

    expect(meeting.note).toBe("");
  });

  test("preserves multiline Chinese and English meeting notes", () => {
    const note = "\u4f1a\u8bae\u7ed3\u8bba\uff1a\n- \u8d1f\u8d23\u4eba\uff1a\u674e\u96f7\n\nNext steps:\n- Share the draft";

    expect(MeetingNoteSchema.parse(note)).toBe(note);
  });

  test("accepts exactly 200,000 ASCII code points and rejects 200,001", () => {
    expect(MeetingNoteSchema.parse("a".repeat(200_000))).toHaveLength(200_000);
    expect(() => MeetingNoteSchema.parse("a".repeat(200_001))).toThrow();
  });

  test("accepts exactly 200,000 supplementary code points and rejects 200,001", () => {
    const emoji = "\u{1F600}";

    expect(MeetingNoteSchema.parse(emoji.repeat(200_000))).toBe(emoji.repeat(200_000));
    expect(() => MeetingNoteSchema.parse(emoji.repeat(200_001))).toThrow();
  });

  test.each([
    ["NUL", "before\u0000after"],
    ["a lone high surrogate", "before\uD800after"],
    ["a lone low surrogate", "before\uDC00after"],
    ["an incorrectly paired high surrogate", "before\uD800xafter"],
  ])("rejects %s because PostgreSQL cannot represent it", (_case, note) => {
    expect(() => MeetingNoteSchema.parse(note)).toThrow();
  });

  test("preserves a valid supplementary Unicode scalar pair", () => {
    const note = "before\uD83D\uDE00after";

    expect(MeetingNoteSchema.parse(note)).toBe(note);
  });

  test("strictly parses meeting note mutation bodies", () => {
    const note = "\u7b2c\u4e00\u884c\nSecond line";

    expect(MeetingNoteBodySchema.parse({ note, expectedSyncVersion: 2 })).toEqual({ note, expectedSyncVersion: 2 });
    expect(MeetingNoteOperationSchema.parse({ note, updatedAt: timestamp, expectedSyncVersion: 3 })).toEqual({ note, updatedAt: timestamp, expectedSyncVersion: 3 });
    expect(() => MeetingNoteBodySchema.parse({ note, expectedSyncVersion: 2, extra: true })).toThrow();
    expect(() => MeetingNoteOperationSchema.parse({ note, updatedAt: timestamp, expectedSyncVersion: 3, extra: true })).toThrow();
    expect(() => MeetingNoteOperationSchema.parse({ note, updatedAt: "not-a-date", expectedSyncVersion: 3 })).toThrow();
  });

  test("rejects invalid meeting timestamps, statuses, and sync versions", () => {
    const validMeeting = {
      id: meetingId,
      title: "Ready meeting",
      folderId: null,
      status: "ready",
      startedAt: null,
      endedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      trashedAt: null,
      syncVersion: 0,
    };

    expect(() => MeetingSchema.parse({ ...validMeeting, createdAt: "not-a-date" })).toThrow();
    expect(() => MeetingSchema.parse({ ...validMeeting, createdAt: "2025-01-01T18:00:00+08:00" })).toThrow();
    expect(() => MeetingSchema.parse({ ...validMeeting, status: "complete" })).toThrow();
    expect(() => MeetingSchema.parse({ ...validMeeting, syncVersion: -1 })).toThrow();
    expect(() => MeetingSchema.parse({ ...validMeeting, syncVersion: 0.5 })).toThrow();
  });

  test("defaults and strictly parses meeting list query booleans", () => {
    expect(MeetingListQuerySchema.parse({})).toEqual({ search: "", includeTrashed: false });
    expect(MeetingListQuerySchema.parse({ includeTrashed: false }).includeTrashed).toBe(false);
    expect(MeetingListQuerySchema.parse({ includeTrashed: true }).includeTrashed).toBe(true);
    expect(MeetingListQuerySchema.parse({ includeTrashed: "false" }).includeTrashed).toBe(false);
    expect(MeetingListQuerySchema.parse({ includeTrashed: "true" }).includeTrashed).toBe(true);
    expect(() => MeetingListQuerySchema.parse({ includeTrashed: "yes" })).toThrow();
  });

  test("trims folder names without encoding duplicate semantics", () => {
    const input = CreateFolderInputSchema.parse({
      id: folderId,
      name: "  Work  ",
      clientCreatedAt: timestamp,
    });

    expect(input.name).toBe("Work");
    expect(FolderSchema.parse({
      id: folderId,
      name: "Work",
      createdAt: timestamp,
      updatedAt: timestamp,
      syncVersion: 0,
    }).name).toBe("Work");
  });

  test("rejects invalid folder names and ids", () => {
    const validInput = { id: folderId, name: "Work", clientCreatedAt: timestamp };

    expect(() => CreateFolderInputSchema.parse({ ...validInput, id: "folder" })).toThrow();
    expect(() => CreateFolderInputSchema.parse({ ...validInput, name: "" })).toThrow();
    expect(() => CreateFolderInputSchema.parse({ ...validInput, name: "a".repeat(81) })).toThrow();
  });

  test("shares strict conditional mutation wire schemas", () => {
    expect(IdempotencyKeySchema.parse(meetingId)).toBe(meetingId);
    expect(MeetingPatchBodySchema.parse({ title: " Rename ", expectedSyncVersion: 3 })).toEqual({ title: "Rename", expectedSyncVersion: 3 });
    expect(FolderRenameBodySchema.parse({ name: " Work ", expectedSyncVersion: 2 })).toEqual({ name: "Work", expectedSyncVersion: 2 });
    expect(MeetingMutationBodySchema.parse({ expectedSyncVersion: 1 })).toEqual({ expectedSyncVersion: 1 });
    expect(FolderMutationBodySchema.parse({ expectedSyncVersion: 0 })).toEqual({ expectedSyncVersion: 0 });
    expect(() => MeetingMutationBodySchema.parse({})).toThrow();
    expect(() => FolderMutationBodySchema.parse({ expectedSyncVersion: 1, extra: true })).toThrow();
  });

  test("shares strict legacy and combined rename wire schemas", () => {
    expect(LegacyMeetingPatchBodySchema.parse({ title: " Legacy " })).toEqual({ title: "Legacy" });
    expect(LegacyFolderRenameBodySchema.parse({ name: " Work " })).toEqual({ name: "Work" });
    expect(MeetingPatchWireBodySchema.parse({ title: "Conditional", expectedSyncVersion: 3 })).toEqual({ title: "Conditional", expectedSyncVersion: 3 });
    expect(FolderRenameWireBodySchema.parse({ name: "Legacy" })).toEqual({ name: "Legacy" });

    expect(() => MeetingPatchWireBodySchema.parse({ title: "Invalid", expectedSyncVersion: undefined })).toThrow();
    expect(() => MeetingPatchWireBodySchema.parse({ title: "Invalid", extra: true })).toThrow();
    expect(() => FolderRenameWireBodySchema.parse({ name: "Invalid", expectedSyncVersion: undefined })).toThrow();
    expect(() => FolderRenameWireBodySchema.parse({ name: "Invalid", extra: true })).toThrow();
  });
});
