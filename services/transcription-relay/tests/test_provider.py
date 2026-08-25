import asyncio
import base64

import pytest

from relay.provider import DashScopeRealtimeProvider


class FakeConversation:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.callback = kwargs["callback"]
        self.audio = []
        self.ended = False
        self.closed = False
        self.session = None

    def connect(self):
        self.callback.on_open()

    def update_session(self, **kwargs):
        self.session = kwargs
        self.callback.on_event({"type": "session.updated"})

    def append_audio(self, value):
        self.audio.append(value)

    def end_session(self, timeout=20):
        self.ended = True

    def close(self):
        self.closed = True


@pytest.mark.asyncio
async def test_provider_uses_verified_public_endpoint_and_pcm_session():
    created = []

    def factory(**kwargs):
        conversation = FakeConversation(**kwargs)
        created.append(conversation)
        return conversation

    provider = DashScopeRealtimeProvider("saved-key", conversation_factory=factory)
    await provider.start()
    event = await asyncio.wait_for(provider.next_event(), 1)

    assert event == {"type": "ready"}
    assert created[0].kwargs["model"] == "qwen3-asr-flash-realtime"
    assert created[0].kwargs["url"] == "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
    assert created[0].kwargs["api_key"] == "saved-key"
    assert created[0].session["enable_turn_detection"] is True
    transcription = created[0].session["transcription_params"]
    assert transcription.language == "zh"
    assert transcription.sample_rate == 16_000
    assert transcription.input_audio_format == "pcm"

    await provider.send_audio(b"\x01\x02")
    assert base64.b64decode(created[0].audio[0]) == b"\x01\x02"
    await provider.stop()
    assert created[0].ended is True
    assert created[0].closed is True


@pytest.mark.asyncio
async def test_provider_forwards_sanitized_events_from_sdk_callback():
    created = []
    provider = DashScopeRealtimeProvider(
        "saved-key",
        conversation_factory=lambda **kwargs: created.append(FakeConversation(**kwargs)) or created[-1],
    )
    await provider.start()
    await provider.next_event()
    created[0].callback.on_event({
        "type": "conversation.item.input_audio_transcription.text",
        "text": "实时",
        "stash": "转写",
    })
    assert await asyncio.wait_for(provider.next_event(), 1) == {"type": "partial", "text": "实时转写"}
