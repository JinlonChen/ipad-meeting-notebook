# FunASR Realtime Diarization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the relay's Qwen realtime provider with Alibaba DashScope `fun-asr-realtime` and persist its anonymous speaker labels in the existing transcript rows.

**Architecture:** The browser continues sending PCM audio to the same authenticated relay WebSocket. A small provider adapter converts DashScope Recognition SDK callbacks into the existing `ready` / `partial` / `final` events, including the provider `speaker_id`; the relay turns the first-seen IDs into `发言人 1`, `发言人 2`, and so on before storing them. No credential, browser endpoint, or database migration changes are required because `meeting_transcript_segments.speaker` already exists.

**Tech Stack:** Python 3.9, DashScope SDK 1.27.1, FastAPI WebSockets, pytest, Supabase REST.

---

## File Map

- Create `services/transcription-relay/relay/recognition_provider.py`: bridge the synchronous DashScope Recognition callbacks into the relay's async provider contract.
- Modify `services/transcription-relay/relay/core.py`: preserve provider speaker IDs, map them to anonymous Chinese display labels, and add the label to persisted segment candidates.
- Modify `services/transcription-relay/relay/app.py`: pass a final event's speaker label into the persisted segment.
- Modify `services/transcription-relay/relay/provider.py`: retain the existing Qwen provider as unused compatibility code until the new provider is proven in production.
- Modify `services/transcription-relay/tests/test_recognition_provider.py`: unit-test SDK configuration and event normalization without network requests.
- Modify `services/transcription-relay/tests/test_core.py`: unit-test speaker ordering and segment persistence values.
- Modify `services/transcription-relay/tests/test_app.py`: test that a labelled final event is persisted and returned to the browser.

### Task 1: Add a provider contract test

- [ ] Write tests that construct the Recognition provider with a fake SDK class, assert `model="fun-asr-realtime"`, `format="pcm"`, `sample_rate=16000`, and `diarization_enabled=True`, and verify callbacks emit a `ready` event plus final text, timestamps, item ID, and `speaker_id`.
- [ ] Run `PYTHONPATH=services/transcription-relay pytest -q services/transcription-relay/tests/test_recognition_provider.py` and confirm it fails because the adapter does not exist.
- [ ] Implement `DashScopeRecognitionProvider` and its callback adapter. Start the SDK thread with `Recognition.start()`, feed PCM bytes using `send_audio_frame`, and convert error details to an error code only.
- [ ] Re-run the focused provider tests and confirm they pass.

### Task 2: Persist anonymous speaker labels

- [ ] Write failing tests showing provider ID `9` becomes `发言人 1`, a later distinct ID becomes `发言人 2`, and a final event with no ID preserves its text with `speaker=None`.
- [ ] Run `PYTHONPATH=services/transcription-relay pytest -q services/transcription-relay/tests/test_core.py services/transcription-relay/tests/test_app.py` and confirm the new expectations fail.
- [ ] Add first-seen speaker mapping to the connection state, pass the mapped label through `segment_candidate`, and make the WebSocket handler use it when persisting and returning a final segment.
- [ ] Re-run the focused tests and confirm they pass.

### Task 3: Switch the production relay and verify it

- [ ] Wire the default provider factory in `relay/app.py` to `DashScopeRecognitionProvider`; leave authentication, origin checks, Supabase storage, and the browser protocol unchanged.
- [ ] Run `PYTHONPATH=services/transcription-relay pytest -q services/transcription-relay/tests` and confirm the whole relay suite passes.
- [ ] Run the existing 30-second two-speaker DashScope smoke test with the runtime-held key, ensuring it returns at least two anonymized speaker IDs without printing transcript text or keys.
- [ ] Install the changed relay files into `/Users/jinlongchen/Library/Application Support/iPad Meeting Relay/service`, restart the relay LaunchAgent, confirm `/health`, and verify from iPad with two people alternating speech.
