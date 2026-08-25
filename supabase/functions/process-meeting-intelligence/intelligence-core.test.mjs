import assert from "node:assert/strict";
import test from "node:test";

import { generateMeetingMinutes } from "./intelligence-core.mjs";

const meetingId = "00000000-0000-4000-8000-000000000001";

test("turns an existing realtime transcript into durable meeting minutes", async () => {
  const transcript = [
    { id: "00000000-0000-4000-8000-000000000010", position: 0, text: "确认下周发布。" },
    { id: "00000000-0000-4000-8000-000000000011", position: 1, text: "李明负责公告。" },
  ];
  const result = await generateMeetingMinutes({
    summaryModel: "gpt-4.1-mini",
    transcript,
  }, {
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

  assert.deepEqual(result.actions[0].evidenceSegmentIds, [transcript[1].id]);
  assert.equal(result.actions[0].dueDate, null);
});

test("rejects a provider summary that cites transcript positions that do not exist", async () => {
  await assert.rejects(() => generateMeetingMinutes({
    summaryModel: "gpt-4.1-mini",
    transcript: [{ id: "00000000-0000-4000-8000-000000000010", position: 0, text: "确认下周发布。" }],
  }, {
    summarize: async () => ({
      summary: "团队确认下周发布。",
      topics: [],
      decisions: [{ text: "下周发布", evidencePositions: [4] }],
      risks: [],
      actions: [],
    }),
  }), /INVALID_EVIDENCE_POSITION/);
});

test("rejects summary generation when the realtime transcript is empty", async () => {
  await assert.rejects(() => generateMeetingMinutes({ summaryModel: "gpt-4.1-mini", transcript: [] }, {
    summarize: async () => assert.fail("summary provider must not run"),
  }), /EMPTY_TRANSCRIPTION/);
});
