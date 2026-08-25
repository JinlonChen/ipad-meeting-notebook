import asyncio
import base64
from typing import Any, Callable, Dict, Optional

from dashscope.audio.qwen_omni import (
    MultiModality,
    OmniRealtimeCallback,
    OmniRealtimeConversation,
)
from dashscope.audio.qwen_omni.omni_realtime import TranscriptionParams

from .core import parse_provider_event


MODEL = "qwen3-asr-flash-realtime"
ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"


class _Callback(OmniRealtimeCallback):
    def __init__(self, loop: asyncio.AbstractEventLoop, events: asyncio.Queue):
        self.loop = loop
        self.events = events

    def on_open(self) -> None:
        return None

    def on_close(self, close_status_code, close_msg) -> None:
        self.loop.call_soon_threadsafe(
            self.events.put_nowait,
            {"type": "closed", "code": str(close_status_code or "")},
        )

    def on_event(self, message: Dict[str, Any]) -> None:
        parsed = parse_provider_event(message)
        if parsed:
            self.loop.call_soon_threadsafe(self.events.put_nowait, parsed)


class DashScopeRealtimeProvider:
    def __init__(
        self,
        api_key: str,
        conversation_factory: Optional[Callable[..., Any]] = None,
    ):
        self.api_key = api_key
        self.conversation_factory = conversation_factory or OmniRealtimeConversation
        self.events: asyncio.Queue = asyncio.Queue()
        self.conversation = None
        self.stopped = False

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        callback = _Callback(loop, self.events)
        self.conversation = self.conversation_factory(
            model=MODEL,
            callback=callback,
            url=ENDPOINT,
            api_key=self.api_key,
        )
        await asyncio.to_thread(self.conversation.connect)
        await asyncio.to_thread(
            self.conversation.update_session,
            output_modalities=[MultiModality.TEXT],
            transcription_params=TranscriptionParams(
                language="zh",
                sample_rate=16_000,
                input_audio_format="pcm",
            ),
            enable_turn_detection=True,
            turn_detection_threshold=0.2,
            turn_detection_silence_duration_ms=400,
        )

    async def next_event(self) -> Dict[str, str]:
        return await self.events.get()

    async def send_audio(self, chunk: bytes) -> None:
        if self.stopped or self.conversation is None:
            raise RuntimeError("provider_not_started")
        encoded = base64.b64encode(chunk).decode("ascii")
        await asyncio.to_thread(self.conversation.append_audio, encoded)

    async def stop(self) -> None:
        if self.stopped:
            return
        self.stopped = True
        conversation = self.conversation
        self.conversation = None
        if conversation is None:
            return
        try:
            await asyncio.to_thread(conversation.end_session, 5)
        except Exception:
            pass
        finally:
            try:
                await asyncio.to_thread(conversation.close)
            except Exception:
                pass
