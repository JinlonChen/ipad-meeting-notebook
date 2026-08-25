from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from relay.app import Settings, create_app


MEETING_ID = "00000000-0000-4000-8000-000000000001"


class FakeBackend:
    def __init__(self):
        self.persisted = []
        self.allow_user = True
        self.allow_meeting = True

    async def authenticate(self, token):
        return "user-1" if self.allow_user and token == "valid-token" else None

    async def owns_meeting(self, user_id, meeting_id):
        return self.allow_meeting and user_id == "user-1" and meeting_id == MEETING_ID

    async def transcription_key(self, user_id):
        return "saved-key" if user_id == "user-1" else None

    async def continuation(self, user_id, meeting_id):
        return 3, 120_000

    async def persist_segment(self, segment):
        self.persisted.append(segment)
        return segment

    async def close(self):
        return None


class FakeProvider:
    def __init__(self):
        import asyncio
        self.events = asyncio.Queue()
        self.audio = []
        self.stopped = False

    async def start(self):
        await self.events.put({"type": "ready"})

    async def next_event(self):
        return await self.events.get()

    async def send_audio(self, chunk):
        self.audio.append(chunk)
        await self.events.put({"type": "partial", "text": "正在讨论"})
        await self.events.put({"type": "final", "item_id": "item-1", "text": "形成结论"})
        await self.events.put({"type": "final", "item_id": "item-2", "text": "新增结论"})

    async def stop(self):
        self.stopped = True


def harness(backend=None):
    backend = backend or FakeBackend()
    providers = []

    def provider_factory(_key):
        provider = FakeProvider()
        providers.append(provider)
        return provider

    settings = Settings(
        supabase_url="https://project.supabase.co",
        supabase_anon_key="public-anon",
        supabase_service_role_key="private-service-role",
        allowed_origins=("https://jinlonchen.github.io",),
    )
    app = create_app(settings, backend=backend, provider_factory=provider_factory)
    return TestClient(app), backend, providers


def test_health_and_origin_enforcement():
    client, _, providers = harness()
    assert client.get("/health").json() == {"status": "ok"}

    try:
        with client.websocket_connect(
            f"/v1/realtime-transcription?meetingId={MEETING_ID}",
            headers={"origin": "https://untrusted.example"},
        ):
            raise AssertionError("untrusted origin connected")
    except WebSocketDisconnect as error:
        assert error.code == 1008
    assert providers == []


def test_requires_authentication_before_audio():
    client, _, providers = harness()
    with client.websocket_connect(
        f"/v1/realtime-transcription?meetingId={MEETING_ID}",
        headers={"origin": "https://jinlonchen.github.io"},
    ) as socket:
        socket.send_bytes(b"\x00\x00")
        assert socket.receive_json() == {"type": "error", "message": "auth_required"}
    assert providers == []


def test_rejects_invalid_user_and_wrong_owner_before_provider_start():
    backend = FakeBackend()
    backend.allow_user = False
    client, _, providers = harness(backend)
    with client.websocket_connect(
        f"/v1/realtime-transcription?meetingId={MEETING_ID}",
        headers={"origin": "https://jinlonchen.github.io"},
    ) as socket:
        socket.send_json({"type": "authenticate", "accessToken": "invalid"})
        assert socket.receive_json() == {"type": "error", "message": "auth_required"}
    assert providers == []


def test_streams_pcm_and_persists_final_before_returning_it():
    client, backend, providers = harness()
    with client.websocket_connect(
        f"/v1/realtime-transcription?meetingId={MEETING_ID}",
        headers={"origin": "https://jinlonchen.github.io"},
    ) as socket:
        socket.send_json({"type": "authenticate", "accessToken": "valid-token"})
        assert socket.receive_json() == {"type": "ready"}
        socket.send_bytes(b"\x01\x02" * 1_600)
        assert socket.receive_json() == {"type": "partial", "text": "正在讨论"}
        final = socket.receive_json()
        assert final["type"] == "final"
        assert final["segment"]["position"] == 3
        assert final["segment"]["text"] == "形成结论"
        assert final["segment"]["started_offset_ms"] == 120_000
        assert final["segment"]["ended_offset_ms"] == 120_100
        assert backend.persisted == [final["segment"]]
    assert providers[0].audio == [b"\x01\x02" * 1_600]
    assert providers[0].stopped is True


def test_rejects_audio_chunks_above_64_kib():
    client, _, providers = harness()
    with client.websocket_connect(
        f"/v1/realtime-transcription?meetingId={MEETING_ID}",
        headers={"origin": "https://jinlonchen.github.io"},
    ) as socket:
        socket.send_json({"type": "authenticate", "accessToken": "valid-token"})
        assert socket.receive_json() == {"type": "ready"}
        socket.send_bytes(b"x" * (64 * 1024 + 1))
        assert socket.receive_json() == {"type": "error", "message": "audio_chunk_too_large"}
    assert providers[0].audio == []
    assert providers[0].stopped is True


def test_duplicate_provider_final_does_not_consume_the_next_position():
    class DuplicateBackend(FakeBackend):
        async def persist_segment(self, segment):
            self.persisted.append(segment)
            if len(self.persisted) == 1:
                return {**segment, "position": 2, "text": "已有分段"}
            return segment

    client, backend, _ = harness(DuplicateBackend())
    with client.websocket_connect(
        f"/v1/realtime-transcription?meetingId={MEETING_ID}",
        headers={"origin": "https://jinlonchen.github.io"},
    ) as socket:
        socket.send_json({"type": "authenticate", "accessToken": "valid-token"})
        assert socket.receive_json() == {"type": "ready"}
        socket.send_bytes(b"\x01\x02" * 1_600)
        assert socket.receive_json()["type"] == "partial"
        duplicate = socket.receive_json()
        new_segment = socket.receive_json()

    assert duplicate["segment"]["position"] == 2
    assert new_segment["segment"]["position"] == 3
    assert new_segment["segment"]["text"] == "新增结论"
    assert [segment["position"] for segment in backend.persisted] == [3, 3]
