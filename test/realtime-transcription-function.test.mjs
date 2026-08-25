import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("realtime relay explicitly authenticates WebSocket users and keeps Alibaba credentials server-side", async () => {
  const source = await readFile(new URL("supabase/functions/realtime-transcription/index.ts", root), "utf8");
  assert.match(source, /auth\.getUser\(accessToken\)/);
  assert.match(source, /transcription_api_key/);
  assert.match(source, /Authorization.*Bearer/);
  assert.match(source, /OpenAI-Beta.*realtime=v1/);
  assert.match(source, /qwen3-asr-flash-realtime/);
  assert.doesNotMatch(source, /console\.(?:log|error).*api_key/i);
});

test("realtime relay bypasses gateway JWT parsing only to verify its WebSocket token internally", async () => {
  const config = await readFile(new URL("supabase/config.toml", root), "utf8");
  assert.match(config, /\[functions\.realtime-transcription\]\s+verify_jwt = false/);
});
