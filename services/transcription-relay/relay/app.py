import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple

from fastapi import FastAPI, Query, WebSocket
from starlette.websockets import WebSocketDisconnect

from .core import ConnectionState
from .diarization import DiarizationClient, PcmBatcher, speaker_updates
from .provider import DashScopeRealtimeProvider
from .supabase import SupabaseBackend


logger = logging.getLogger(__name__)

MAX_AUDIO_BYTES = 64 * 1024
AUTH_TIMEOUT_SECONDS = 10
IDLE_TIMEOUT_SECONDS = 30
SESSION_TIMEOUT_SECONDS = 90 * 60
DIARIZATION_BATCH_BYTES = 30 * 16_000 * 2


@dataclass(frozen=True)
class Settings:
    supabase_url: str
    supabase_anon_key: str
    supabase_service_role_key: str
    allowed_origins: Tuple[str, ...]

    @classmethod
    def from_environment(cls) -> "Settings":
        values = {
            "supabase_url": os.environ.get("SUPABASE_URL", "").strip(),
            "supabase_anon_key": os.environ.get("SUPABASE_ANON_KEY", "").strip(),
            "supabase_service_role_key": os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip(),
        }
        origins = tuple(
            value.strip().rstrip("/")
            for value in os.environ.get("ALLOWED_ORIGINS", "").split(",")
            if value.strip()
        )
        if not all(values.values()) or not origins:
            raise RuntimeError("relay_configuration_missing")
        return cls(allowed_origins=origins, **values)


async def _error(socket: WebSocket, message: str, code: int = 1008) -> None:
    logger.warning("realtime transcription session ended: %s (close code %s)", message, code)
    try:
        await socket.send_json({"type": "error", "message": message})
    finally:
        await socket.close(code=code)


def _authentication(message: Dict[str, Any]) -> Optional[str]:
    if message.get("type") != "websocket.receive" or not isinstance(message.get("text"), str):
        return None
    try:
        body = json.loads(message["text"])
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(body, dict) or body.get("type") != "authenticate":
        return None
    token = body.get("accessToken")
    return token if isinstance(token, str) and token else None


def create_app(
    settings: Settings,
    backend: Optional[Any] = None,
    provider_factory: Optional[Callable[[str], Any]] = None,
    diarization_client_factory: Optional[Callable[[], Any]] = None,
    diarization_batch_bytes: int = DIARIZATION_BATCH_BYTES,
) -> FastAPI:
    app = FastAPI()
    resolved_backend = backend or SupabaseBackend(
        settings.supabase_url,
        settings.supabase_anon_key,
        settings.supabase_service_role_key,
    )
    resolved_provider_factory = provider_factory or (lambda key: DashScopeRealtimeProvider(key))
    resolved_diarization_factory = diarization_client_factory or (
        lambda: DiarizationClient(os.environ.get("DIARIZATION_URL", "http://127.0.0.1:8001"))
    )
    active_sessions = set()

    @app.get("/health")
    async def health() -> Dict[str, str]:
        return {"status": "ok"}

    @app.websocket("/v1/realtime-transcription")
    async def realtime_transcription(
        socket: WebSocket,
        meeting_id: str = Query(alias="meetingId", min_length=36, max_length=36),
    ) -> None:
        origin = (socket.headers.get("origin") or "").rstrip("/")
        if origin not in settings.allowed_origins:
            await socket.close(code=1008)
            return
        await socket.accept()

        provider = None
        diarizer = None
        diarization_tasks = set()
        session_key = None
        try:
            try:
                first = await asyncio.wait_for(socket.receive(), AUTH_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                await _error(socket, "auth_required")
                return
            token = _authentication(first)
            if not token:
                await _error(socket, "auth_required")
                return
            user_id = await resolved_backend.authenticate(token)
            if not user_id:
                await _error(socket, "auth_required")
                return
            if not await resolved_backend.owns_meeting(user_id, meeting_id):
                await _error(socket, "meeting_not_found")
                return
            api_key = await resolved_backend.transcription_key(user_id)
            if not api_key:
                await _error(socket, "ai_configuration_required")
                return

            session_key = (user_id, meeting_id)
            if session_key in active_sessions:
                await _error(socket, "session_already_active")
                return
            active_sessions.add(session_key)

            next_position, previous_end_ms = await resolved_backend.continuation(user_id, meeting_id)
            state = ConnectionState(
                next_position=next_position,
                audio_offset_ms=previous_end_ms,
                segment_start_ms=previous_end_ms,
            )
            diarizer = resolved_diarization_factory()
            diarization_batcher = PcmBatcher(diarization_batch_bytes)
            diarization_events = asyncio.Queue()
            session_segments = []
            pending_diarization = []

            async def apply_diarization(batch_started_offset_ms: int, payload: Dict[str, Any]) -> None:
                intervals = payload.get("intervals", []) if isinstance(payload, dict) else []
                for update in speaker_updates(session_segments, intervals, batch_started_offset_ms):
                    label = state.speaker_label(update["speaker_id"])
                    current_index = next((index for index, item in enumerate(session_segments) if item.get("id") == update["id"]), None)
                    if current_index is None or not label or session_segments[current_index].get("speaker") == label:
                        continue
                    current = session_segments[current_index]
                    try:
                        persisted = await resolved_backend.update_segment_speaker(user_id, current["id"], label)
                    except Exception:
                        logger.exception("realtime transcription speaker update failed")
                        continue
                    session_segments[current_index] = {**current, **persisted, "speaker": label}
                    await diarization_events.put({"type": "final", "segment": session_segments[current_index]})

            async def run_diarization(batch_started_offset_ms: int, pcm: bytes) -> None:
                try:
                    payload = await diarizer.diarize(batch_started_offset_ms, pcm)
                    pending_diarization.append((batch_started_offset_ms, payload))
                    if session_segments:
                        batch = pending_diarization.pop(0)
                        await apply_diarization(*batch)
                except Exception:
                    logger.exception("realtime transcription diarization batch failed")

            provider = resolved_provider_factory(api_key)
            try:
                await provider.start()
                ready = await asyncio.wait_for(provider.next_event(), 10)
            except Exception:
                logger.exception("realtime transcription provider startup failed")
                await _error(socket, "provider_connection_failed", code=1011)
                return
            if ready.get("type") != "ready":
                await _error(socket, "provider_connection_failed", code=1011)
                return
            await socket.send_json({"type": "ready"})

            started_at = time.monotonic()
            last_audio_at = started_at
            while True:
                now = time.monotonic()
                remaining = min(
                    SESSION_TIMEOUT_SECONDS - (now - started_at),
                    IDLE_TIMEOUT_SECONDS - (now - last_audio_at),
                )
                if remaining <= 0:
                    await _error(socket, "session_timeout")
                    return
                browser_task = asyncio.create_task(socket.receive())
                provider_task = asyncio.create_task(provider.next_event())
                diarization_task = asyncio.create_task(diarization_events.get())
                done, pending = await asyncio.wait(
                    {browser_task, provider_task, diarization_task},
                    timeout=remaining,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                if not done:
                    await _error(socket, "session_timeout")
                    return

                if provider_task in done:
                    event = provider_task.result()
                    event_type = event.get("type")
                    if event_type == "partial":
                        await socket.send_json({"type": "partial", "text": event["text"]})
                    elif event_type == "final":
                        item_id = event.get("item_id") or f"position-{state.next_position}"
                        segment = state.segment_candidate(
                            user_id,
                            meeting_id,
                            item_id,
                            event["text"],
                        )
                        try:
                            persisted = await resolved_backend.persist_segment(segment)
                        except Exception:
                            await _error(socket, "transcript_persistence_failed", code=1011)
                            return
                        if (
                            persisted.get("id") == segment["id"]
                            and persisted.get("position") == segment["position"]
                        ):
                            state.accept(segment)
                        existing_index = next((index for index, item in enumerate(session_segments) if item.get("id") == persisted.get("id")), None)
                        if existing_index is None:
                            session_segments.append(persisted)
                        else:
                            session_segments[existing_index] = persisted
                        if pending_diarization:
                            for batch in pending_diarization[:]:
                                pending_diarization.remove(batch)
                                await apply_diarization(*batch)
                        await socket.send_json({"type": "final", "segment": persisted})
                    elif event_type in ("error", "closed"):
                        await _error(socket, "provider_response_failed", code=1011)
                        return
                    elif event_type == "finished":
                        return

                if diarization_task in done:
                    await socket.send_json(diarization_task.result())

                if browser_task in done:
                    message = browser_task.result()
                    if message.get("type") == "websocket.disconnect":
                        return
                    chunk = message.get("bytes")
                    if not isinstance(chunk, bytes):
                        await _error(socket, "invalid_message")
                        return
                    if len(chunk) > MAX_AUDIO_BYTES:
                        await _error(socket, "audio_chunk_too_large")
                        return
                    if not chunk:
                        continue
                    batch_started_offset_ms = state.audio_offset_ms
                    state.record_audio(len(chunk))
                    last_audio_at = time.monotonic()
                    await provider.send_audio(chunk)
                    batch = diarization_batcher.append(chunk, batch_started_offset_ms)
                    if batch is not None and diarizer is not None:
                        batch_started, batch_pcm = batch
                        task = asyncio.create_task(run_diarization(batch_started, batch_pcm))
                        diarization_tasks.add(task)
                        task.add_done_callback(diarization_tasks.discard)
        except WebSocketDisconnect:
            return
        except Exception:
            logger.exception("realtime transcription relay failed")
            try:
                await _error(socket, "relay_failed", code=1011)
            except Exception:
                pass
        finally:
            if provider is not None:
                await provider.stop()
            for task in diarization_tasks:
                task.cancel()
            if diarizer is not None and hasattr(diarizer, "close"):
                await diarizer.close()
            if session_key is not None:
                active_sessions.discard(session_key)

    return app


def create_production_app() -> FastAPI:
    return create_app(Settings.from_environment())
