import { describe, expect, test } from "vitest";

import { parseProviderEvent } from "../../src/transcription/protocol.js";

describe("parseProviderEvent", () => {
  test("recognizes session readiness", () => {
    expect(parseProviderEvent(JSON.stringify({ type: "session.created" }))).toEqual({ kind: "ready" });
    expect(parseProviderEvent(JSON.stringify({ type: "session.updated" }))).toEqual({ kind: "ready" });
  });

  test("combines realtime text and stash into one partial transcript", () => {
    expect(parseProviderEvent(JSON.stringify({
      type: "conversation.item.input_audio_transcription.text",
      text: "今天讨论",
      stash: "发布计划",
    }))).toEqual({ kind: "partial", text: "今天讨论发布计划" });
  });

  test("returns trimmed final transcript with a stable provider id", () => {
    expect(parseProviderEvent(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-7",
      transcript: "  下周发布。  ",
    }))).toEqual({ kind: "final", sourceId: "item-7", text: "下周发布。" });
  });

  test("recognizes finish and safe provider errors", () => {
    expect(parseProviderEvent(JSON.stringify({ type: "session.finished" }))).toEqual({ kind: "finished" });
    expect(parseProviderEvent(JSON.stringify({ type: "error", error: { message: "invalid audio" } }))).toEqual({ kind: "error", message: "invalid audio" });
  });

  test("ignores malformed, unknown, and blank transcript events", () => {
    expect(parseProviderEvent("not-json")).toBeNull();
    expect(parseProviderEvent(JSON.stringify({ type: "unknown" }))).toBeNull();
    expect(parseProviderEvent(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: " " }))).toBeNull();
  });
});
