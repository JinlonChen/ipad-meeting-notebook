# Realtime Meeting Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream iPad microphone audio to Alibaba Qwen realtime ASR during recording, persist final transcript segments, and generate AI minutes only on demand.

**Architecture:** Keep the existing `MediaRecorder` storage path and attach a separate PCM streamer to the same `MediaStream`. The browser sends authenticated audio frames to a Supabase Edge Function relay, which connects to Alibaba with the server-side key and persists final transcript events. The existing intelligence action becomes summary-only and reads stored transcript rows.

**Tech Stack:** React 19, TypeScript, Web Audio API, browser WebSocket, Supabase Edge Functions/Deno, Alibaba `qwen3-asr-flash-realtime`, Vitest, Node test runner.

---

### Task 1: Realtime audio and event primitives

**Files:**
- Create: `apps/web/src/transcription/pcm.ts`
- Create: `apps/web/src/transcription/protocol.ts`
- Test: `apps/web/test/transcription/pcm.test.ts`
- Test: `apps/web/test/transcription/protocol.test.ts`

- [ ] **Step 1: Write failing PCM tests**

Test that `downsampleToPcm16(input, 48000, 16000)` selects the correct samples, clamps values to `[-1, 1]`, and returns little-endian signed 16-bit bytes.

- [ ] **Step 2: Run PCM tests and verify missing-module failure**

Run: `npm test -w @meeting/web -- pcm.test.ts`
Expected: FAIL because `src/transcription/pcm.ts` does not exist.

- [ ] **Step 3: Implement deterministic PCM conversion**

Export `downsampleToPcm16(samples: Float32Array, inputRate: number, outputRate?: number): Uint8Array`. Average each input-rate window, clamp it, and write signed samples with `DataView.setInt16(offset, value, true)`.

- [ ] **Step 4: Write and pass Alibaba event parser tests**

Cover `session.created`, `session.updated`, `conversation.item.input_audio_transcription.text`, `conversation.item.input_audio_transcription.completed`, `session.finished`, and `error`. Return a discriminated local event; reject malformed JSON and blank transcript events.

- [ ] **Step 5: Run focused tests**

Run: `npm test -w @meeting/web -- pcm.test.ts protocol.test.ts`
Expected: both test files PASS.

### Task 2: Browser realtime session and recorder integration

**Files:**
- Create: `apps/web/src/transcription/browser-session.ts`
- Modify: `apps/web/src/recording/controller.ts`
- Modify: `apps/web/src/recording/browser-recorder.ts`
- Modify: `apps/web/src/recording/workspace-recorder.ts`
- Modify: `apps/web/src/recording/MeetingRecordingControls.tsx`
- Test: `apps/web/test/transcription/browser-session.test.ts`
- Test: `apps/web/test/recording/controller.test.ts`
- Test: `apps/web/test/recording/workspace-recorder.test.ts`
- Test: `apps/web/test/recording/MeetingRecordingControls.test.tsx`

- [ ] **Step 1: Specify the realtime session port in tests**

Use `start(stream)`, `send(pcm)`, and `stop()` behavior. Assert `RecordingController.start()` gives the acquired microphone stream to the realtime session and `stop()` closes realtime before stopping tracks. A realtime start failure must not fail durable recording.

- [ ] **Step 2: Implement browser audio capture**

Create an `AudioContext`, `MediaStreamAudioSourceNode`, and 4096-frame processor. Convert each input buffer through `downsampleToPcm16` and send binary PCM only while the socket is open. Close processor/source/context idempotently.

- [ ] **Step 3: Implement authenticated relay connection**

Read the current Supabase access token, convert the configured Supabase HTTPS origin to WSS, and connect to `/functions/v1/realtime-transcription?meetingId=<uuid>&access_token=<jwt>`. Parse relay messages into status, partial, final, and error events; use bounded reconnect for online socket loss.

- [ ] **Step 4: Publish transcription state from `WorkspaceRecorder`**

Expose a subscription returning `idle | connecting | streaming | paused | failed`, current partial text, and final transcript notifications. Keep recording state independent so ASR errors never call the existing recording interruption path.

- [ ] **Step 5: Render status beside recording controls**

Show `正在连接实时转写`, `实时转写中`, `实时转写已暂停`, or `实时转写连接失败`. The status must fit iPad mini width and must not replace the recording timer.

- [ ] **Step 6: Run recording and transcription tests**

Run: `npm test -w @meeting/web -- browser-session.test.ts controller.test.ts workspace-recorder.test.ts MeetingRecordingControls.test.tsx`
Expected: all focused tests PASS.

### Task 3: Supabase WebSocket relay

**Files:**
- Create: `supabase/functions/realtime-transcription/realtime-core.mjs`
- Create: `supabase/functions/realtime-transcription/realtime-core.test.mjs`
- Create: `supabase/functions/realtime-transcription/deno.json`
- Create: `supabase/functions/realtime-transcription/index.ts`
- Modify: `supabase/config.toml`

- [ ] **Step 1: Write relay core tests**

Test construction of Alibaba `session.update`, `input_audio_buffer.append`, and `session.finish`; parse partial text from `text + stash`; parse final text from `transcript`; ignore blank final events.

- [ ] **Step 2: Implement and test pure protocol helpers**

Run: `node --test supabase/functions/realtime-transcription/realtime-core.test.mjs`
Expected: PASS with no network access.

- [ ] **Step 3: Implement the WebSocket relay**

Validate the browser JWT with `auth.getUser`, verify `(user_id, meeting_id)`, and load the user's already-saved transcription key. Use the fixed personal Beijing workspace endpoint and `qwen3-asr-flash-realtime`, so the previously saved non-realtime model value does not require user re-entry. Upgrade the incoming request, create the Alibaba socket with `Authorization: Bearer <key>` and `OpenAI-Beta: realtime=v1`, then send server-VAD configuration (`threshold: 0.2`, `silence_duration_ms: 400`).

- [ ] **Step 4: Persist final transcript segments**

On each completed event, calculate the next `position`, use event/item identity to derive a stable row id, and upsert `source='asr'` with monotonic offsets. Send `{ type: 'final', segment }` to the browser only after database persistence succeeds.

- [ ] **Step 5: Handle closure and errors**

Forward browser PCM as base64 `input_audio_buffer.append`; on normal browser close send `session.finish`; close both sockets on authentication, provider, or persistence failure. Keep the Edge Function alive until the client socket closes. Configure `verify_jwt = false` because the function performs explicit WebSocket token verification.

- [ ] **Step 6: Run relay tests and Deno type check**

Run: `node --test supabase/functions/realtime-transcription/realtime-core.test.mjs`
Run: `npx supabase functions serve realtime-transcription --env-file supabase/.env.local`
Expected: pure tests PASS; local function starts when local environment values exist.

### Task 4: Live transcript UI and manual-only AI summary

**Files:**
- Modify: `apps/web/src/intelligence/MeetingIntelligencePanel.tsx`
- Modify: `apps/web/src/intelligence/api.ts`
- Modify: `apps/web/src/meetings/MeetingWorkspacePage.tsx`
- Modify: `supabase/functions/process-meeting-intelligence/index.ts`
- Modify: `supabase/functions/process-meeting-intelligence/intelligence-core.mjs`
- Modify: `apps/web/test/intelligence/MeetingIntelligencePanel.test.tsx`
- Modify: `supabase/functions/process-meeting-intelligence/intelligence-core.test.mjs`

- [ ] **Step 1: Write failing summary-only UI tests**

Assert the action is `生成 AI 总结` or `重新生成 AI 总结`, calls `summarize(meetingId)`, keeps transcript visible without minutes, and never says that it is generating transcription.

- [ ] **Step 2: Update the panel for live and persisted transcript**

Merge persisted final segments with the recorder's current partial text. Poll/read after final notifications so saved rows replace temporary display. Keep transcript visible during recording and render minutes above it after manual generation.

- [ ] **Step 3: Convert the process API to summary-only**

Rename the client method to `summarize`. Server-side, remove audio download and transcription calls; read ordered `meeting_transcript_segments`, reject an empty transcript, call only the configured summary endpoint, and upsert `meeting_minutes`.

- [ ] **Step 4: Run intelligence tests**

Run: `npm test -w @meeting/web -- MeetingIntelligencePanel.test.tsx`
Run: `node --test supabase/functions/process-meeting-intelligence/intelligence-core.test.mjs`
Expected: all focused tests PASS.

### Task 5: Realtime ASR settings and runtime wiring

**Files:**
- Modify: `apps/web/src/intelligence/AiSettingsPage.tsx`
- Modify: `apps/web/src/intelligence/api.ts`
- Modify: `apps/web/src/app/runtime.ts`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `supabase/functions/configure-meeting-ai/index.ts`
- Modify: `apps/web/test/intelligence/AiSettingsPage.test.tsx`
- Modify: `apps/web/test/app/runtime.test.ts`

- [ ] **Step 1: Update settings tests**

Assert the ASR section displays the fixed Beijing WSS endpoint and model `qwen3-asr-flash-realtime`, while only the ASR key remains editable and summary retains its independent URL/model/key fields. Preserve the successful-save status regression test.

- [ ] **Step 2: Validate realtime configuration on the server**

Ignore submitted ASR endpoint/model values and store the fixed WSS endpoint plus `qwen3-asr-flash-realtime`; keep `https://` validation for summary. The relay continues using the already-saved transcription key, so this deployment itself requires no user re-entry.

- [ ] **Step 3: Wire the realtime client into the recorder**

Create it from the existing Supabase client in `composeProductionApp`, pass it through `App`, and inject it into `createBrowserWorkspaceRecorder`. Keep test/default recorder behavior functional without a realtime client.

- [ ] **Step 4: Run full verification**

Run: `npm test`
Run: `npm run typecheck`
Run: `npm run build`
Expected: all tests, type checks, and builds PASS.

### Task 6: Deploy and smoke test

**Files:**
- Modify only if deployment metadata requires it: `.github/workflows/deploy-pages.yml`

- [ ] **Step 1: Reconcile with remote main without losing local fixes**

Fetch `origin/main`, inspect divergence, and integrate only the realtime changes plus the existing AI settings success fix. Do not overwrite remote changes made through GitHub.

- [ ] **Step 2: Deploy Edge Functions**

Deploy the realtime relay with JWT gateway verification disabled and deploy the updated configuration and summary functions. Confirm each deployment targets project `nprrqgyejndptpytszha`.

- [ ] **Step 3: Push the verified web build**

Push the reconciled branch/main according to the repository's existing Pages workflow and wait for verification and Pages deployment to pass.

- [ ] **Step 4: Browser smoke test**

Log in, open a meeting, start recording, speak Mandarin, confirm partial text appears within a few seconds, stop recording, and click `生成 AI 总结`. Confirm no API key is present in browser storage or network responses.

- [ ] **Step 5: iPad verification handoff**

Ask the user only for the physical-device checks that cannot be performed locally: live text while speaking and record-while-offline behavior.
