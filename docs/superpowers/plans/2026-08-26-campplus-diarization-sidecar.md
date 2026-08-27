# CAM++ Diarization Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local CAM++ speaker diarization to the Mac relay without changing the existing Qwen realtime transcription API, credentials, or recording behavior.

**Architecture:** A separate localhost-only FastAPI service keeps ModelScope's CAM++ pipeline in memory. The existing relay batches 30 seconds of already-received PCM and posts it to the sidecar; returned `[start, end, speaker]` intervals label overlapping persisted transcript rows and are sent back to the connected iPad as updates. The Qwen path continues to create the text in real time, and a sidecar error only skips labels for that batch.

**Tech Stack:** Python 3.9, FastAPI, ModelScope CAM++ speaker-diarization, PyTorch CPU, DashScope Qwen realtime ASR, Supabase REST, pytest.

---

## File Map

- Create `services/diarization-sidecar/app.py`: localhost API that accepts PCM16 mono 16kHz batches, runs the preloaded CAM++ pipeline, and returns sanitized time ranges.
- Create `services/diarization-sidecar/requirements.txt`: pinned sidecar dependencies used by its isolated virtual environment.
- Create `services/diarization-sidecar/tests/test_app.py`: test PCM validation and normalized output without loading models.
- Create `services/transcription-relay/relay/diarization.py`: relay client, PCM batch buffer, timestamp overlap selection, and compact speaker-update messages.
- Modify `services/transcription-relay/relay/app.py`: retain Qwen default provider, buffer audio independently, apply completed sidecar batches, and notify the browser.
- Modify `services/transcription-relay/relay/supabase.py`: update only `speaker` on already-owned transcript rows.
- Modify relay tests for batch boundaries, sidecar failure isolation, and speaker update persistence.
- Modify `apps/web/src/transcription/browser-session.ts` and tests: apply a `speaker-update` by segment ID without duplicating text.

### Task 1: Sidecar contract

- [ ] Write tests that a valid PCM batch produces interval objects with nonnegative ordered timestamps and integer local speaker IDs, and malformed bytes return a 422 response.
- [ ] Run the sidecar tests and confirm they fail because no service exists.
- [ ] Implement a localhost-only `/v1/diarize` endpoint. Convert the body to a temporary WAV, run the preloaded CAM++ pipeline in one worker thread, delete the WAV in `finally`, and return only time ranges and IDs.
- [ ] Run the test suite and the cached 30-second CAM++ sample test; record elapsed time and segment count without printing audio or transcript content.

### Task 2: Relay batch mapping

- [ ] Write failing relay tests for a 30-second buffer, mapping a diarization range to the maximum-overlap transcript segment, and an unavailable sidecar that does not close the recording WebSocket.
- [ ] Implement the buffer and asynchronous client. Preserve a per-session first-seen mapping from CAM++ IDs to `发言人 N`; update only matching existing segments through Supabase and emit `speaker-update` to the browser.
- [ ] Run all relay tests and confirm original realtime Qwen tests still pass.

### Task 3: Browser update and deployment

- [ ] Write a failing browser-session test showing `speaker-update` changes an existing segment in place.
- [ ] Implement the message handler and re-run focused frontend tests, type checking, and build.
- [ ] Install and launch the sidecar through a dedicated LaunchAgent, restart the relay, confirm both health endpoints, and run a two-person iPad recording through one complete 30-second batch.
