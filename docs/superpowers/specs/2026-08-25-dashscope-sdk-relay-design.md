# DashScope SDK Realtime Relay Design

## Goal

Restore reliable live meeting transcription on the existing iPad web app by moving the Alibaba realtime ASR client out of Supabase Edge Runtime and into a small Python service that runs the official DashScope SDK. Keep recording local-first, keep transcript and minutes data in Supabase, and require no Xcode installation or API-key re-entry.

## Confirmed Constraint

Alibaba's `qwen3-asr-flash-realtime` WebSocket handshake requires an `Authorization` request header. The deployed Supabase Edge Runtime cannot satisfy that requirement:

- Its native `WebSocket` treats the header options object as a subprotocol and raises `Invalid protocol value`.
- The Node `ws` package reaches an unimplemented `ClientRequest.options.createConnection` path.
- `WebSocketStream`, which supports custom headers in current Deno releases, is not defined in the deployed runtime.

Alibaba's browser-compatible WebRTC protocol does not support the realtime ASR models according to the current official support matrix. The AOQ iOS SDK supports ASR but would require a native app and recurring free-account code signing. A server-side official SDK relay is therefore the selected approach.

## Architecture

Add `services/transcription-relay`, a Python 3.12 FastAPI service deployed as a Render web service. It owns only realtime transport and transcript persistence. It never stores audio.

The browser connects to:

```text
wss://<relay-host>/v1/realtime-transcription?meetingId=<meeting-id>
```

The access token is not placed in the URL. Immediately after the WebSocket opens, the browser sends one JSON authentication message:

```json
{ "type": "authenticate", "accessToken": "<supabase-jwt>" }
```

The relay then:

1. Validates the JWT with Supabase Auth.
2. Confirms that the authenticated user owns the requested meeting.
3. Reads that user's saved `transcription_api_key` with the Supabase service role.
4. Reads the latest transcript position for reconnect continuity.
5. Starts `dashscope.audio.qwen_omni.OmniRealtimeConversation` with model `qwen3-asr-flash-realtime`, the user's API key, and the verified public endpoint `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`.
6. Sends a Chinese PCM16, 16 kHz, server-VAD session configuration.
7. Replies `{ "type": "ready" }` only after Alibaba reports `session.updated`.

After `ready`, browser binary messages contain PCM16 audio. The relay base64-encodes each bounded chunk and calls the SDK's `append_audio()`. SDK callbacks are marshalled from its worker thread onto the FastAPI event loop.

## Transcript Flow

Alibaba partial events are forwarded immediately:

```json
{ "type": "partial", "text": "..." }
```

For each completed event, the relay derives the existing stable UUID from user ID, meeting ID, and Alibaba item ID. It serializes writes per connection, inserts the final segment with the next position, then sends the persisted segment to the browser:

```json
{ "type": "final", "segment": { "id": "...", "meetingId": "...", "position": 0, "text": "..." } }
```

Duplicate provider events return the already-persisted segment rather than creating a second row. Once at least one final segment exists, the existing AI-summary panel becomes actionable without any summary-flow changes.

## Browser Changes

Add public build configuration `VITE_TRANSCRIPTION_RELAY_URL`. Production uses its `wss://` value; local tests may inject a fake socket as they do now. The browser sends the authentication message on socket open and continues using the current PCM downsampling, status updates, partial text, bounded reconnect, and recorder lifecycle.

The relay URL is public configuration. Supabase keys with elevated privileges and the Alibaba API key remain server-side.

## Security And Limits

- Accept WebSocket origins only from the configured GitHub Pages origin and configured local-development origins.
- Reject unauthenticated, expired, malformed, or wrong-owner sessions before starting DashScope.
- Keep `SUPABASE_SERVICE_ROLE_KEY` only in Render environment secrets.
- Read the Alibaba key from the existing write-only Supabase credential row; do not duplicate it in frontend configuration.
- Never log access tokens, API keys, audio bytes, or provider request headers.
- Reject text messages after authentication and binary chunks larger than 64 KiB.
- Allow one active relay per user and meeting process, with a 90-minute maximum session and a 30-second no-audio idle timeout.

## Failure And Recovery

The relay returns the existing sanitized client error codes for authentication, configuration, provider connection, provider response, and transcript persistence failures. Provider and storage errors close the WebSocket with an appropriate code after sending the error event.

The browser retains its existing five-attempt exponential reconnect. Each reconnect revalidates ownership and reloads the latest persisted transcript position. Audio recorded during a network gap remains in the local recording but is not backfilled into live transcription in this change.

Stopping recording calls the SDK's `end_session()` with a bounded timeout and then closes both connections. Process shutdown closes active provider sessions without delaying deployment indefinitely.

## Deployment

The relay includes a Dockerfile, pinned Python dependencies, a `/health` endpoint, and Render configuration. Required Render secrets are:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ALLOWED_ORIGINS`

GitHub Pages receives only `VITE_TRANSCRIPTION_RELAY_URL`. The Supabase realtime transcription function is retired from the browser path after the relay is verified.

For the expected three one-hour meetings per week, a single small instance is sufficient because audio is streamed and discarded rather than buffered. A free instance is acceptable for initial personal use; a cold start is handled by the browser reconnect path. If access from mainland China proves unreliable, the same container can move unchanged to an Alibaba Cloud lightweight server.

## Verification

Automated coverage will include:

- JWT and meeting-ownership rejection.
- Authentication-before-audio ordering.
- SDK session configuration and PCM chunk forwarding.
- Alibaba ready, partial, final, error, and finished events.
- Stable duplicate handling and ordered Supabase writes.
- Secret-safe logging and origin enforcement.
- Browser relay URL composition, initial authentication message, audio gating, reconnect, and cleanup.
- Existing recording, transcript, minutes, offline, typecheck, and production-build suites.

Production acceptance requires a real saved-key test: the UI reaches `实时转写中`, spoken Chinese appears during recording, a final row is present in `meeting_transcript_segments`, and `生成 AI 总结` becomes enabled and produces minutes.
