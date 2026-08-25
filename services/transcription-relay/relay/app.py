import asyncio
import json
import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple

from fastapi import FastAPI, Query, WebSocket
from starlette.websockets import WebSocketDisconnect

from .core import ConnectionState
from .provider import DashScopeRealtimeProvider
from .supabase import SupabaseBackend


MAX_AUDIO_BYTES = 64 * 1024
AUTH_TIMEOUT_SECONDS = 10
IDLE_TIMEOUT_SECONDS = 30
SESSION_TIMEOUT_SECONDS = 90 * 60


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
) -> FastAPI:
    app = FastAPI()
    resolved_backend = backend or SupabaseBackend(
        settings.supabase_url,
        settings.supabase_anon_key,
        settings.supabase_service_role_key,
    )
    resolved_provider_factory = provider_factory or (lambda key: DashScopeRealtimeProvider(key))
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
            provider = resolved_provider_factory(api_key)
            try:
                await provider.start()
                ready = await asyncio.wait_for(provider.next_event(), 10)
            except Exception:
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
                done, pending = await asyncio.wait(
                    {browser_task, provider_task},
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
                        await socket.send_json({"type": "final", "segment": persisted})
                    elif event_type in ("error", "closed"):
                        await _error(socket, "provider_response_failed", code=1011)
                        return
                    elif event_type == "finished":
                        return

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
                    state.record_audio(len(chunk))
                    last_audio_at = time.monotonic()
                    await provider.send_audio(chunk)
        except WebSocketDisconnect:
            return
        except Exception:
            try:
                await _error(socket, "relay_failed", code=1011)
            except Exception:
                pass
        finally:
            if provider is not None:
                await provider.stop()
            if session_key is not None:
                active_sessions.discard(session_key)

    return app


def create_production_app() -> FastAPI:
    return create_app(Settings.from_environment())
