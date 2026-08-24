# Audio Recording Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add loss-resistant foreground meeting recording to the installed iPad PWA, with durable 10-second local chunks, reconnect upload, interrupted-session recovery, and 48-hour raw-audio retention.

**Architecture:** Keep recording capture independent from catalog synchronization. `RecordingController` owns browser media and wake-lock APIs, while `MeetingRecordingRepository` owns IndexedDB sessions/chunks and exposes durable state to React. An authenticated Supabase Storage adapter uploads deterministic object paths; recording metadata remains user-scoped and raw audio is deleted after 48 hours without deleting notes.

**Tech Stack:** TypeScript, React 19, Dexie/IndexedDB, MediaRecorder, Screen Wake Lock, Web Crypto, Supabase Storage/PostgreSQL, Vitest, Testing Library, Playwright.

---

### Task 1: Define recording contracts and durable IndexedDB tables

**Files:**
- Create: `packages/contracts/src/recording.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/web/src/meetings/local-db.ts`
- Test: `packages/contracts/src/recording.test.ts`
- Test: `apps/web/test/meetings/local-db.test.ts`

- [x] **Step 1: Write failing contract tests** for session states, sequential non-negative chunk numbers, MIME/size/hash validation, timestamps, upload states, and 48-hour expiry.
- [x] **Step 2: Run** `npm test -w @meeting/contracts -- recording.test.ts` and confirm failure because `recording.ts` is missing.
- [x] **Step 3: Implement** `RecordingSessionSchema`, `AudioChunkMetadataSchema`, `RecordingStateSchema`, and exported inferred types. Store blobs only in the web-local type, never in shared JSON contracts.
- [x] **Step 4: Run the contract test** and confirm it passes.
- [x] **Step 5: Write a failing Dexie migration test** that opens a v3 catalog, upgrades it, and proves `recordingSessions` and `audioChunks` exist without changing meetings or outbox rows.
- [x] **Step 6: Add database version 4** with `recordingSessions: "meetingId,state,startedAt,expiresAt"` and `audioChunks: "id,[meetingId+sequence],meetingId,uploadState,expiresAt"`.
- [x] **Step 7: Run** `npm test -w @meeting/web -- local-db.test.ts` and commit after green.

### Task 2: Persist recording lifecycle and enforce retention

**Files:**
- Create: `apps/web/src/recording/repository.ts`
- Test: `apps/web/test/recording/repository.test.ts`

- [x] **Step 1: Write failing tests** proving `start()` is idempotent per meeting, only one active recording exists, `appendChunk()` atomically advances the sequence, and blobs survive repository re-open.
- [x] **Step 2: Run** `npm test -w @meeting/web -- recording/repository.test.ts` and confirm missing-module failure.
- [x] **Step 3: Implement** `MeetingRecordingRepository` using the active user database tables and transactions; reject empty chunks and non-monotonic session clocks.
- [x] **Step 4: Write failing stop/recovery tests** proving a clean stop records `endedAt`, an unclosed recording becomes `recoverable` on launch, and recovery never fabricates missing time.
- [x] **Step 5: Implement** `stop()`, `markInterrupted()`, `recoverableSessions()`, and `completeRecovery()`.
- [x] **Step 6: Write failing retention tests** at 47:59:59 and 48:00:00, then implement `deleteExpiredAudio(now)` so only raw blobs/session audio metadata are removed and meeting notes remain untouched.
- [x] **Step 7: Run focused and full web tests, then commit.**

### Task 3: Capture 10-second MediaRecorder chunks safely

**Files:**
- Create: `apps/web/src/recording/media.ts`
- Create: `apps/web/src/recording/controller.ts`
- Test: `apps/web/test/recording/media.test.ts`
- Test: `apps/web/test/recording/controller.test.ts`

- [ ] **Step 1: Write failing MIME-selection tests** preferring `audio/webm;codecs=opus`, then `audio/mp4`, then supported browser fallback; reject when MediaRecorder is unavailable.
- [ ] **Step 2: Implement** pure `selectRecordingMimeType()` and verify green.
- [ ] **Step 3: Write failing controller tests** with fake media/wake-lock ports proving `getUserMedia({audio:true})`, `MediaRecorder.start(10_000)`, immediate durable chunk callback, timer updates, and track cleanup.
- [ ] **Step 4: Implement** `RecordingController` with injected ports, serialized chunk writes, and a stop that awaits the final `dataavailable` write.
- [ ] **Step 5: Write failing interruption tests** for `visibilitychange`, recorder errors, and wake-lock release; implement explicit interrupted state and reacquire wake lock only while visible.
- [ ] **Step 6: Run focused tests and commit.**

### Task 4: Build the iPad recording workspace controls

**Files:**
- Modify: `apps/web/src/meetings/MeetingWorkspacePage.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/app/runtime.ts`
- Modify: `apps/web/src/app/styles.css`
- Test: `apps/web/test/meetings/MeetingWorkspacePage.test.tsx`

- [ ] **Step 1: Write failing UI tests** for a microphone start button, permission denial, recording timer, stop confirmation, local-save status, offline state, and recoverable-session banner.
- [ ] **Step 2: Run the focused test** and confirm the controls are absent.
- [ ] **Step 3: Add compact icon-led controls** with stable dimensions, visible recording indicator, timer, storage/upload text, and the fixed warning that recording requires the app to stay foreground and awake.
- [ ] **Step 4: Wire controller/repository dependencies** through production composition; do not put browser API calls directly in React.
- [ ] **Step 5: Add portrait/landscape/320px tests** and ensure controls and note editor do not overlap.
- [ ] **Step 6: Run focused tests, typecheck, and commit.**

### Task 5: Upload authenticated chunks to private Supabase Storage

**Files:**
- Create: `apps/web/src/recording/storage.ts`
- Modify: `apps/web/src/supabase/types.ts`
- Create: `supabase/migrations/202608240001_meeting_audio.sql`
- Test: `apps/web/test/recording/storage.test.ts`
- Test: `supabase/tests/meeting_audio.sql`
- Modify: `test/supabase-schema.test.mjs`

- [ ] **Step 1: Write failing adapter tests** proving deterministic paths `<user>/<meeting>/<sequence>.<ext>`, authenticated actor matching, no overwrite with different hashes, retry-safe same-hash acknowledgement, and network-error preservation of local chunks.
- [ ] **Step 2: Implement** `SupabaseRecordingStorage` with upload/list/remove boundaries and no service-role key in the browser.
- [ ] **Step 3: Write failing SQL contract tests** for a private `meeting-audio` bucket, owner-path policies, user-scoped chunk metadata, uniqueness on meeting/sequence, and no anon access.
- [ ] **Step 4: Implement migration and generated TypeScript row types.**
- [ ] **Step 5: Add an upload worker** that retries pending chunks when online, records attempts/errors, and deletes no local blob before durable remote acknowledgement.
- [ ] **Step 6: Run storage, schema, scan, and full web tests; commit.**

### Task 6: Recovery, cloud cleanup, E2E, deployment, and real iPad acceptance

**Files:**
- Create: `supabase/functions/cleanup-expired-audio/index.ts`
- Create: `supabase/functions/cleanup-expired-audio/deno.json`
- Modify: `supabase/config.toml`
- Create: `apps/web/e2e/recording-recovery.spec.ts`
- Modify: `docs/testing/ipad-foundation-checklist.md`
- Modify: `README.md`

- [ ] **Step 1: Write cleanup function tests/contracts** proving only expired audio objects and chunk metadata are removed; meetings, notes, transcripts, and summaries are never cascaded.
- [ ] **Step 2: Implement the service-role Edge Function** with bounded batches, idempotent deletion, and structured logs containing IDs but no audio or note content.
- [ ] **Step 3: Add E2E tests** for permission acceptance, chunk persistence, offline recording, reload recovery, reconnect upload, duplicate prevention, foreground interruption warning, and expiry cleanup using fake browser media.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run build`, `npm run scan:web-dist`, and `npm run test:e2e`.
- [ ] **Step 5: Deploy migration/function/storage policy**, merge through CI, wait for Pages, and verify production assets and console.
- [ ] **Step 6: Perform real iPad mini 6 checks** for microphone permission, 15-minute offline recovery, one-hour foreground recording, force-close recovery, playback integrity, and 48-hour deletion. Do not mark hardware-only checks passed before the user runs them.

## Scope Review

- Recording loss prevention, 10-second durable chunks, offline continuation, interrupted-session recovery, wake lock, and foreground limits are covered by Tasks 1–4.
- Private cloud upload, idempotency, authentication, and reconnect behavior are covered by Task 5.
- Unified 48-hour local/cloud retention and real-device acceptance are covered by Tasks 2 and 6.
- Transcription, diarization, handwriting, unified timeline, AI minutes, and exports remain subsequent independently testable phases; they are not silently stubbed in this recording phase.
