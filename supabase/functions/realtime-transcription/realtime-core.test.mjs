import test from "node:test";
import assert from "node:assert/strict";

import {
  audioAppendEvent,
  finishEvent,
  parseAlibabaEvent,
  sessionUpdateEvent,
  stableSegmentId,
} from "./realtime-core.mjs";

test("configures Qwen realtime ASR for Chinese PCM16 with server VAD", () => {
  const event = sessionUpdateEvent("event-1");
  assert.deepEqual(event, {
    event_id: "event-1",
    type: "session.update",
    session: {
      modalities: ["text"],
      input_audio_format: "pcm",
      sample_rate: 16000,
      input_audio_transcription: { language: "zh" },
      turn_detection: { type: "server_vad", threshold: 0.2, silence_duration_ms: 400 },
    },
  });
});

test("encodes browser PCM bytes into an Alibaba audio append event", () => {
  assert.deepEqual(audioAppendEvent(new Uint8Array([255, 127, 0, 128]), "event-2"), {
    event_id: "event-2",
    type: "input_audio_buffer.append",
    audio: "/38AgA==",
  });
  assert.deepEqual(finishEvent("event-3"), { event_id: "event-3", type: "session.finish" });
});

test("parses ready, partial, final, finished and error provider events", () => {
  assert.deepEqual(parseAlibabaEvent(JSON.stringify({ type: "session.created" })), { kind: "created" });
  assert.deepEqual(parseAlibabaEvent(JSON.stringify({ type: "session.updated" })), { kind: "ready" });
  assert.deepEqual(parseAlibabaEvent(JSON.stringify({
    type: "conversation.item.input_audio_transcription.text",
    text: "讨论",
    stash: "上线时间",
  })), { kind: "partial", text: "讨论上线时间" });
  assert.deepEqual(parseAlibabaEvent(JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item-9",
    transcript: "  下周上线。 ",
  })), { kind: "final", sourceId: "item-9", text: "下周上线。" });
  assert.deepEqual(parseAlibabaEvent(JSON.stringify({ type: "session.finished" })), { kind: "finished" });
  assert.deepEqual(parseAlibabaEvent(JSON.stringify({ type: "error", error: { message: "bad audio" } })), { kind: "error", message: "bad audio" });
  assert.equal(parseAlibabaEvent("bad-json"), null);
});

test("derives a stable UUID from owner, meeting and provider item", async () => {
  const first = await stableSegmentId("user-1", "meeting-1", "item-9");
  const repeated = await stableSegmentId("user-1", "meeting-1", "item-9");
  const other = await stableSegmentId("user-1", "meeting-1", "item-10");
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first, repeated);
  assert.notEqual(first, other);
});
