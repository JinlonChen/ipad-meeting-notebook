# DashScope SDK Realtime Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing iPad meeting recorder display live Mandarin transcription through Alibaba's verified public realtime ASR endpoint while preserving local recording and manual AI summary behavior.

**Architecture:** Add a small FastAPI WebSocket service that authenticates a Supabase session, verifies meeting ownership, loads the user's write-only ASR key, and drives `OmniRealtimeConversation` from the official DashScope Python SDK. The browser sends its JWT as the first WebSocket message and streams its existing PCM16 chunks only after the relay reports ready. Final segments are persisted by the relay through Supabase REST and then sent back to the browser.

**Tech Stack:** Python 3.12, FastAPI, httpx, DashScope Python SDK 1.27.1, pytest, React 19, TypeScript, Vitest, Render, GitHub Pages.

---

### Task 1: Relay protocol and transcript persistence core

**Files:**
- Create: `services/transcription-relay/relay/core.py`
- Create: `services/transcription-relay/relay/__init__.py`
- Create: `services/transcription-relay/tests/test_core.py`

- [ ] **Step 1: Write failing tests**

Test that the core accepts `session.updated`, maps partial and completed provider events, rejects blank text, derives a stable UUID from user/meeting/item identity, and calculates monotonic positions and PCM duration.

- [ ] **Step 2: Verify RED**

Run: `pytest -q services/transcription-relay/tests/test_core.py`
Expected: FAIL because `relay.core` does not exist.

- [ ] **Step 3: Implement the minimal pure helpers**

Implement typed event parsing, `pcm_duration_ms(byte_count)`, UUID5 segment identity, and a bounded `ConnectionState` that advances position and audio time without storing audio.

- [ ] **Step 4: Verify GREEN**

Run: `pytest -q services/transcription-relay/tests/test_core.py`
Expected: PASS.

### Task 2: FastAPI WebSocket relay using the official SDK

**Files:**
- Create: `services/transcription-relay/relay/app.py`
- Create: `services/transcription-relay/relay/provider.py`
- Create: `services/transcription-relay/relay/supabase.py`
- Create: `services/transcription-relay/tests/test_app.py`
- Create: `services/transcription-relay/tests/test_provider.py`
- Create: `services/transcription-relay/requirements.txt`
- Create: `services/transcription-relay/requirements-dev.txt`

- [ ] **Step 1: Write failing boundary tests**

Use injected fake auth, storage, and provider ports. Assert `/health` returns `ok`; wrong origins are rejected; audio before `{\"type\":\"authenticate\"}` is rejected; invalid users and wrong-owner meetings never start DashScope; authenticated PCM is forwarded only after ready; partial/final/error events are returned; chunks above 64 KiB are rejected; provider sessions always close.

- [ ] **Step 2: Verify RED**

Run: `pytest -q services/transcription-relay/tests/test_app.py services/transcription-relay/tests/test_provider.py`
Expected: FAIL because the application modules do not exist.

- [ ] **Step 3: Implement Supabase boundaries**

Use `httpx.AsyncClient` against `/auth/v1/user` with the anon key and `/rest/v1` with the service-role key. Fetch only meeting ownership, `transcription_api_key`, and latest position. Upsert a final segment with `Prefer: resolution=merge-duplicates,return=representation`; never log tokens, keys, or audio.

- [ ] **Step 4: Implement DashScope adapter**

Import `TranscriptionParams` from `dashscope.audio.qwen_omni.omni_realtime` because SDK 1.27.1 does not re-export it. Connect to `wss://dashscope.aliyuncs.com/api-ws/v1/realtime` with model `qwen3-asr-flash-realtime`; send Chinese PCM16/16 kHz server-VAD configuration; marshal callback events onto the FastAPI event loop.

- [ ] **Step 5: Implement the WebSocket endpoint**

Accept only configured origins, require the authentication message within 10 seconds, validate ownership before provider startup, allow at most one active process-local user/meeting session, cap audio chunks at 64 KiB, enforce idle/session timeouts, forward partials, persist finals before returning them, and close both sides deterministically.

- [ ] **Step 6: Verify GREEN**

Run: `pytest -q services/transcription-relay/tests`
Expected: PASS.

### Task 3: Browser relay configuration and first-message authentication

**Files:**
- Modify: `apps/web/src/transcription/browser-session.ts`
- Modify: `apps/web/src/intelligence/api.ts`
- Modify: `apps/web/src/app/runtime.ts`
- Modify: `apps/web/test/transcription/browser-session.test.ts`
- Modify: `apps/web/test/app/runtime.test.ts`
- Modify: `.env.example`
- Modify: `.github/workflows/deploy-pages.yml`

- [ ] **Step 1: Write failing browser tests**

Assert the socket URL is `VITE_TRANSCRIPTION_RELAY_URL?meetingId=<uuid>` without a token; on open it sends `{\"type\":\"authenticate\",\"accessToken\":\"...\"}`; no PCM is sent before `ready`; runtime rejects a missing or non-HTTPS/WSS relay URL; Pages exposes only the public relay URL in addition to existing public Supabase variables.

- [ ] **Step 2: Verify RED**

Run: `npm test -w @meeting/web -- browser-session.test.ts runtime.test.ts`
Expected: FAIL because the browser still targets the Edge Function and puts the JWT in the query.

- [ ] **Step 3: Implement minimal browser changes**

Pass the configured relay URL through runtime to `SupabaseMeetingIntelligenceApi`; authenticate on socket open; keep current PCM conversion, reconnect, recorder lifecycle, live transcript state, and manual summary behavior unchanged.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -w @meeting/web -- browser-session.test.ts runtime.test.ts`
Expected: PASS.

### Task 4: Correct saved endpoint metadata and package deployment

**Files:**
- Modify: `apps/web/src/intelligence/api.ts`
- Modify: `supabase/functions/configure-meeting-ai/index.ts`
- Create: `supabase/migrations/202608250002_public_realtime_asr_endpoint.sql`
- Modify: `test/supabase-schema.test.mjs`
- Modify: `apps/web/test/intelligence/AiSettingsPage.test.tsx`
- Create: `services/transcription-relay/Dockerfile`
- Create: `render.yaml`
- Modify: `docs/superpowers/specs/2026-08-25-dashscope-sdk-relay-design.md`

- [ ] **Step 1: Write failing endpoint and deployment tests**

Assert all saved/displayed ASR metadata uses `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`, the migration preserves API keys, and Render runs the pinned Python service with `/health`.

- [ ] **Step 2: Verify RED**

Run: `node --test test/supabase-schema.test.mjs test/deployment-files.test.mjs`
Run: `npm test -w @meeting/web -- AiSettingsPage.test.tsx`
Expected: FAIL on the old private endpoint and absent relay deployment.

- [ ] **Step 3: Implement deployment files and endpoint migration**

Pin the runtime dependencies, add a non-root Docker image and Render blueprint, update fixed endpoint constants, and add a migration that changes only `transcription_base_url` and `transcription_model`.

- [ ] **Step 4: Run full verification**

Run: `pytest -q services/transcription-relay/tests`
Run: `npm test`
Run: `npm run typecheck`
Run: `npm run build`
Run: `npm run scan:web-dist`
Expected: all commands PASS and no private credential marker appears in the web bundle.

### Task 5: Deploy and live acceptance

**Files:**
- Deployment configuration only; no new application behavior.

- [ ] **Step 1: Commit and push the verified branch**

Commit only the SDK relay, browser configuration, endpoint migration, and related tests. Exclude the failed Supabase WebSocket probe edits.

- [ ] **Step 2: Deploy the Supabase metadata migration and configure function**

Apply `202608250002_public_realtime_asr_endpoint.sql` and deploy `configure-meeting-ai-v3` without requiring the user to re-enter the saved key.

- [ ] **Step 3: Deploy the Render relay**

Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `ALLOWED_ORIGINS` as Render secrets; confirm `/health` returns `200`.

- [ ] **Step 4: Configure and deploy Pages**

Set `VITE_TRANSCRIPTION_RELAY_URL` to the Render `https://` URL, push the Pages build, and wait for the workflow to pass.

- [ ] **Step 5: Verify the real workflow**

Start a meeting recording, confirm `实时转写中`, speak Mandarin, confirm live text and a persisted transcript row, stop recording, then confirm `生成 AI 总结` is enabled.
