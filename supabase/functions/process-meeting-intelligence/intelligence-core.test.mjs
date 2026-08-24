import assert from "node:assert/strict";
import test from "node:test";

import { processMeetingIntelligence } from "./intelligence-core.mjs";

const meetingId = "00000000-0000-4000-8000-000000000001";

test("turns provider transcription and position evidence into durable meeting intelligence", async () => {
  const result = await processMeetingIntelligence({
    meetingId,
    asrModel: "whisper-1",
    chatModel: "gpt-4.1-mini",
    mimeType: "audio/webm",
    audio: new Blob(["meeting audio"], { type: "audio/webm" }),
    durationMs: 12_000,
  }, {
    transcribe: async ({ model, audio }) => {
      assert.equal(model, "whisper-1");
      assert.equal(audio.type, "audio/webm");
      return {
        text: "确认下周发布。李明负责公告。",
        segments: [{ text: "确认下周发布。", start: 0, end: 4 }, { text: "李明负责公告。", start: 4, end: 8 }],
      };
    },
    summarize: async ({ model, transcript }) => {
      assert.equal(model, "gpt-4.1-mini");
      assert.match(transcript, /\[0\] 确认下周发布。/);
      return {
        summary: "团队确认下周发布，并安排公告。",
        topics: [{ text: "发布时间", evidencePositions: [0] }],
        decisions: [{ text: "下周发布", evidencePositions: [0] }],
        risks: [],
        actions: [{ text: "准备公告", owner: "李明", dueDate: null, evidencePositions: [1] }],
      };
    },
  });

  assert.equal(result.transcript.length, 2);
  assert.equal(result.transcript[0].startedOffsetMs, 0);
  assert.equal(result.transcript[1].endedOffsetMs, 8_000);
  assert.deepEqual(result.minutes.actions[0].evidenceSegmentIds, [result.transcript[1].id]);
  assert.equal(result.minutes.actions[0].dueDate, null);
});

test("rejects a provider summary that cites transcript positions that do not exist", async () => {
  await assert.rejects(() => processMeetingIntelligence({
    meetingId,
    asrModel: "whisper-1",
    chatModel: "gpt-4.1-mini",
    mimeType: "audio/webm",
    audio: new Blob(["meeting audio"], { type: "audio/webm" }),
    durationMs: 12_000,
  }, {
    transcribe: async () => ({ text: "确认下周发布。" }),
    summarize: async () => ({
      summary: "团队确认下周发布。",
      topics: [],
      decisions: [{ text: "下周发布", evidencePositions: [4] }],
      risks: [],
      actions: [],
    }),
  }), /INVALID_EVIDENCE_POSITION/);
});
