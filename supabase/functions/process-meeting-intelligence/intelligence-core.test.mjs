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
    note: "",
  }, {
    summarize: async ({ model, transcript }) => {
      assert.equal(model, "gpt-4.1-mini");
      assert.match(transcript, /\[转写 0\] 发言人未标记: 确认下周发布。/);
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
    note: "",
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

test("generates note-only minutes without inventing transcript evidence", async () => {
  const result = await generateMeetingMinutes({
    summaryModel: "qwen-plus",
    transcript: [],
    note: "客户希望周五前收到报价。",
  }, {
    summarize: async ({ transcript }) => {
      assert.equal(transcript, "[键盘笔记] 客户希望周五前收到报价。");
      return {
        summary: "客户希望周五前收到报价。",
        topics: [],
        decisions: [],
        risks: [],
        actions: [{ text: "发送报价", owner: null, dueDate: null, evidencePositions: [] }],
      };
    },
  });
  assert.deepEqual(result.actions[0].evidenceSegmentIds, []);
});

test("labels transcript speakers and keyboard notes in one provider input", async () => {
  await generateMeetingMinutes({
    summaryModel: "qwen-plus",
    transcript: [{ id: "00000000-0000-4000-8000-000000000010", position: 0, speaker: "发言人 1", text: "预算不超过十万。" }],
    note: "补充：法务需要复核合同。",
  }, {
    summarize: async ({ transcript }) => {
      assert.match(transcript, /^\[转写 0\] 发言人 1: 预算不超过十万。\n\[键盘笔记\] 补充：法务需要复核合同。$/);
      return { summary: "预算与法务事项已记录。", topics: [], decisions: [], risks: [], actions: [] };
    },
  });
});

test("rejects note-only evidence positions because they are not transcript evidence", async () => {
  await assert.rejects(() => generateMeetingMinutes({ summaryModel: "qwen-plus", transcript: [], note: "记得回访客户。" }, {
    summarize: async () => ({
      summary: "需要回访客户。",
      topics: [], decisions: [], risks: [],
      actions: [{ text: "回访客户", owner: null, dueDate: null, evidencePositions: [0] }],
    }),
  }), /INVALID_EVIDENCE_POSITION/);
});

test("rejects summary generation when transcript and keyboard notes are both empty", async () => {
  await assert.rejects(() => generateMeetingMinutes({ summaryModel: "gpt-4.1-mini", transcript: [], note: "  " }, {
    summarize: async () => assert.fail("summary provider must not run"),
  }), /EMPTY_MEETING_CONTENT/);
});
