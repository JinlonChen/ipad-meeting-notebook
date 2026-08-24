import { describe, expect, test } from "vitest";

import { MinutesSchema, TranscriptSegmentSchema } from "./intelligence.js";

const meetingId = "00000000-0000-4000-8000-000000000001";
const segmentId = "00000000-0000-4000-8000-000000000002";

describe("TranscriptSegmentSchema", () => {
  test("accepts an ordered ASR segment with timing", () => {
    expect(TranscriptSegmentSchema.parse({
      id: segmentId,
      meetingId,
      position: 0,
      text: "确认下周发布",
      startedOffsetMs: 0,
      endedOffsetMs: 3_000,
      speaker: null,
      source: "asr",
      confidence: null,
    })).toMatchObject({ source: "asr", speaker: null });
  });

  test("rejects an empty segment or reversed timing", () => {
    const segment = {
      id: segmentId,
      meetingId,
      position: 0,
      text: "确认下周发布",
      startedOffsetMs: 0,
      endedOffsetMs: 3_000,
      speaker: null,
      source: "asr",
      confidence: null,
    };
    expect(() => TranscriptSegmentSchema.parse({ ...segment, text: "" })).toThrow();
    expect(() => TranscriptSegmentSchema.parse({ ...segment, endedOffsetMs: 0 })).toThrow();
  });
});

describe("MinutesSchema", () => {
  test("requires a non-empty summary and keeps uncertain action fields null", () => {
    const minutes = MinutesSchema.parse({
      summary: "团队确认下周发布。",
      topics: [{ text: "发布时间", evidenceSegmentIds: [segmentId] }],
      decisions: [{ text: "下周发布", evidenceSegmentIds: [segmentId] }],
      risks: [],
      actions: [{ text: "准备发布公告", owner: null, dueDate: null, evidenceSegmentIds: [segmentId] }],
    });
    expect(minutes.actions[0]).toMatchObject({ owner: null, dueDate: null });
    expect(() => MinutesSchema.parse({ ...minutes, summary: "" })).toThrow();
  });
});
