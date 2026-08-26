# Speaker-Aware Realtime Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current fragment-only realtime transcript with a tested DashScope Recognition path that labels and merges consecutive speakers while preserving Qwen realtime transcription as fallback.

**Architecture:** A new Recognition provider normalizes DashScope sentence events into a provider-neutral event contract. The relay owns speaker numbering, adjacent-segment merging, persistence, and stop-time reconciliation; the browser owns speaker-count preference and incremental rendering. Durable recording remains independent of every ASR failure.

**Tech Stack:** Python 3.9/3.12, DashScope SDK 1.27.1, FastAPI WebSockets, Supabase Postgres/RPC, React 19, TypeScript, Vitest, pytest.

---

## File Map

- Create `services/transcription-relay/scripts/smoke_diarization.py`: secret-free CLI for the real 30-second provider gate.
- Create `services/transcription-relay/relay/recognition_provider.py`: DashScope Recognition callback adapter.
- Modify `services/transcription-relay/relay/provider.py`: retain the current Qwen provider under an explicit fallback name.
- Modify `services/transcription-relay/relay/core.py`: provider-event normalization, speaker numbering, punctuation-aware joining, idempotent adjacent merging.
- Modify `services/transcription-relay/relay/supabase.py`: merge-upsert and atomic reconciliation RPC calls.
- Modify `services/transcription-relay/relay/app.py`: authentication options, primary/fallback startup, finish handshake, event persistence.
- Create `supabase/migrations/202608250003_speaker_transcript_reconciliation.sql`: service-role-only atomic session replacement.
- Modify `apps/web/src/transcription/browser-session.ts`: speaker-count authentication, upsert/reconciled protocol, graceful finish.
- Modify `apps/web/src/recording/*`: carry per-meeting speaker-count preference without coupling recording success to ASR.
- Modify `apps/web/src/intelligence/MeetingIntelligencePanel.tsx`: show speaker labels and incremental rows.
- Modify focused tests beside each module before implementation.

### Task 1: Real DashScope Diarization Gate

**Files:**
- Create: `services/transcription-relay/scripts/smoke_diarization.py`
- Create: `services/transcription-relay/tests/test_smoke_diarization.py`

- [ ] **Step 1: Write failing parser tests** for a final sentence such as:

```python
sentence = {"sentence_id": 7, "text": "确认方案。", "begin_time": 1200, "end_time": 3100, "speaker_id": 1}
assert normalized_sentence(sentence) == {
    "type": "final", "item_id": "sentence-7", "text": "确认方案。",
    "started_offset_ms": 1200, "ended_offset_ms": 3100, "speaker_id": "1",
}
```

- [ ] **Step 2: Verify red** with `PYTHONPATH=services/transcription-relay pytest -q services/transcription-relay/tests/test_smoke_diarization.py`; expect import failure.
- [ ] **Step 3: Implement the CLI** with `Recognition(model="fun-asr-realtime", format="pcm", sample_rate=16000, diarization_enabled=True, speaker_count=...)`. Read `DASHSCOPE_API_KEY` only from the process environment, stream a PCM/WAV file in realtime-sized frames, print counts and speaker IDs but never transcript text or the key, and exit nonzero unless final text, timestamps, and two speaker IDs are present.
- [ ] **Step 4: Verify green**, then generate a 25–35 second two-voice Chinese WAV outside the repository and run the CLI with the already stored key loaded from the relay runtime environment. Expected: `final_sentences>=2`, `speaker_ids>=2`, exit 0.
- [ ] **Step 5: Commit** with `git commit -m "test: add DashScope diarization smoke gate"`.

### Task 2: Speaker Segment State Machine

**Files:**
- Modify: `services/transcription-relay/relay/core.py`
- Modify: `services/transcription-relay/tests/test_core.py`

- [ ] **Step 1: Add failing tests** proving first-seen IDs map to `发言人 1`, `发言人 2`; adjacent same-speaker finals return an update with the same UUID/position; a speaker change creates the next position; duplicate `item_id` is ignored; Chinese punctuation and English words join correctly; missing speaker produces `speaker=None` without dropping text.
- [ ] **Step 2: Run** `PYTHONPATH=services/transcription-relay pytest -q services/transcription-relay/tests/test_core.py`; expect failures for the new state API.
- [ ] **Step 3: Implement** `SpeakerLabels`, `join_transcript_text`, and `ConnectionState.consume_final(...) -> SegmentMutation | None`. Keep `starting_position`, the accepted session segments, seen provider IDs, and one active segment. Use the first provider item UUID as the stable merged segment UUID.
- [ ] **Step 4: Rerun the focused tests** and expect all pass.
- [ ] **Step 5: Commit** with `git commit -m "feat: merge realtime transcript by speaker"`.

### Task 3: Recognition Provider and Qwen Fallback

**Files:**
- Create: `services/transcription-relay/relay/recognition_provider.py`
- Modify: `services/transcription-relay/relay/provider.py`
- Create: `services/transcription-relay/tests/test_recognition_provider.py`
- Modify: `services/transcription-relay/tests/test_provider.py`

- [ ] **Step 1: Add failing callback tests** for ready, partial, final, complete and sanitized error events. Assert constructor options include `diarization_enabled=True`, optional `speaker_count`, `format="pcm"`, `sample_rate=16000`, and the verified model from Task 1.
- [ ] **Step 2: Run** `PYTHONPATH=services/transcription-relay pytest -q services/transcription-relay/tests/test_recognition_provider.py services/transcription-relay/tests/test_provider.py`; expect missing adapter failures.
- [ ] **Step 3: Implement** `DashScopeRecognitionProvider.start(speaker_count)`, `send_audio`, `finish`, and `stop`; bridge SDK callbacks into the asyncio loop with `call_soon_threadsafe`. Rename the old class to `QwenRealtimeProvider` while exporting `DashScopeRealtimeProvider = QwenRealtimeProvider` temporarily for compatibility.
- [ ] **Step 4: Verify focused tests pass** and that callback errors expose codes only.
- [ ] **Step 5: Commit** with `git commit -m "feat: add speaker-aware DashScope provider"`.

### Task 4: Atomic Transcript Upsert and Reconciliation

**Files:**
- Create: `supabase/migrations/202608250003_speaker_transcript_reconciliation.sql`
- Modify: `services/transcription-relay/relay/supabase.py`
- Modify: `services/transcription-relay/tests/test_supabase.py`
- Modify: `test/database-contracts.test.mjs`

- [ ] **Step 1: Add failing tests** asserting merge-upsert updates text/end/speaker for the same segment ID and `reconcile_session(user_id, meeting_id, from_position, segments)` invokes one RPC. Add a repository contract test requiring service-role-only execution, ownership checks, strict JSON shape, contiguous positions, and transactionally deleting/replacing only positions at or after `from_position`.
- [ ] **Step 2: Run** the Python tests and `node --test test/database-contracts.test.mjs`; expect missing method/migration failures.
- [ ] **Step 3: Implement** PostgREST `resolution=merge-duplicates` upsert and `reconcile_meeting_transcript_session`. The SQL function rejects browser roles, verifies every segment, rewrites user ownership server-side, and returns canonical rows ordered by position.
- [ ] **Step 4: Rerun focused tests** and expect pass.
- [ ] **Step 5: Commit** with `git commit -m "feat: reconcile speaker transcript atomically"`.

### Task 5: Relay WebSocket Protocol and Fallback

**Files:**
- Modify: `services/transcription-relay/relay/app.py`
- Modify: `services/transcription-relay/tests/test_app.py`

- [ ] **Step 1: Add failing integration tests** for `{type:"authenticate", accessToken, speakerCount}` validation, Recognition-first startup, Qwen fallback, `segment-upsert`, same-ID updates, `{type:"finish"}`, final reconciliation, and continued socket error reporting when both providers fail. Assert no ASR exception changes recording state because the relay has no recording API.
- [ ] **Step 2: Run** `PYTHONPATH=services/transcription-relay pytest -q services/transcription-relay/tests/test_app.py`; expect protocol failures.
- [ ] **Step 3: Implement** a provider factory pair, validate speaker count as `1..5 | null`, persist each mutation before sending it, call `finish()` with a five-second bound, reconcile accepted session rows, and send `{type:"transcript-reconciled", segments}`. If the primary cannot become ready, close it and start Qwen on the same socket.
- [ ] **Step 4: Run all relay tests** with `PYTHONPATH=services/transcription-relay pytest -q services/transcription-relay/tests`; expect pass.
- [ ] **Step 5: Commit** with `git commit -m "feat: stream and reconcile speaker transcript"`.

### Task 6: Browser Protocol and Speaker Count

**Files:**
- Modify: `apps/web/src/transcription/browser-session.ts`
- Modify: `apps/web/test/transcription/browser-session.test.ts`
- Modify: `apps/web/src/recording/MeetingRecordingControls.tsx`
- Modify: `apps/web/src/recording/workspace-recorder.ts`
- Modify: `apps/web/src/recording/browser-recorder.ts`
- Modify: focused recording tests

- [ ] **Step 1: Add failing tests** that the browser sends selected `speakerCount`, maps `segment-upsert` and `transcript-reconciled` to revisions, sends `finish` before closing, waits at most five seconds, and still stops MediaRecorder if reconciliation fails. Add UI tests for `自动, 1..5, 6+`, per-meeting persistence, and disabling during recording.
- [ ] **Step 2: Run** `npm test -w @meeting/web -- browser-session MeetingRecordingControls workspace-recorder`; expect failures.
- [ ] **Step 3: Implement** `SpeakerCountPreference = "auto" | 1 | 2 | 3 | 4 | 5 | "6+"`, a localStorage-backed per-meeting preference, and session creation that reads it at `start()`. Only numeric `1..5` is sent. Graceful `stop()` sends JSON finish and resolves on reconciled/closed/timeout without throwing into recording stop.
- [ ] **Step 4: Rerun focused tests** and expect pass.
- [ ] **Step 5: Commit** with `git commit -m "feat: configure meeting speaker count"`.

### Task 7: Speaker Transcript Presentation

**Files:**
- Modify: `apps/web/src/intelligence/MeetingIntelligencePanel.tsx`
- Modify: `apps/web/test/intelligence/MeetingIntelligencePanel.test.tsx`
- Modify: `apps/web/src/app/styles.css`

- [ ] **Step 1: Add failing component tests** asserting speaker labels render, a same-ID upsert refreshes in place, partial text appears once, and missing speaker displays `未区分发言人`.
- [ ] **Step 2: Run** `npm test -w @meeting/web -- MeetingIntelligencePanel`; expect failures.
- [ ] **Step 3: Implement** keyed transcript rows with time, speaker and text. Keep the display unframed, compact and readable at 744px portrait width.
- [ ] **Step 4: Rerun focused tests** and capture desktop/iPad screenshots through Playwright.
- [ ] **Step 5: Commit** with `git commit -m "feat: display speaker-aware transcript"`.

### Task 8: Speaker Feature Verification and Deployment

**Files:**
- Modify: `README.md` only if operator commands changed.

- [ ] **Step 1: Run** `PYTHONPATH=services/transcription-relay pytest -q services/transcription-relay/tests`.
- [ ] **Step 2: Run** `npm test && npm run typecheck && npm run build && npm run scan:web-dist`.
- [ ] **Step 3: Deploy the migration and relay.** Update the Mac relay runtime from this exact commit, restart only the relay LaunchAgent, and verify `/health`. Keep the current tunnel process and URL unless it has already changed.
- [ ] **Step 4: Deploy the web app.** Push the branch, merge through the existing GitHub workflow, and wait for GitHub Pages success.
- [ ] **Step 5: Run iPad acceptance.** Verify labels 1/2/3, adjacent same-person merging, ordinary transcription fallback, recording independence, and stop-time reconciliation.
