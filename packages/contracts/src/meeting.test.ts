import { describe, expect, test } from "vitest";

import {
  CreateFolderInputSchema,
  CreateMeetingInputSchema,
  FolderSchema,
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
});
