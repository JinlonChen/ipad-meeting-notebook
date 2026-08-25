import json

import httpx
import pytest

from relay.supabase import SupabaseBackend


@pytest.mark.asyncio
async def test_duplicate_segment_returns_existing_row_without_moving_its_position():
    existing = {
        "user_id": "user-1",
        "id": "segment-1",
        "meeting_id": "meeting-1",
        "position": 2,
        "text": "已有分段",
    }
    requests = []

    def handler(request):
        requests.append(request)
        if request.method == "POST":
            assert request.headers["prefer"] == "resolution=ignore-duplicates,return=representation"
            assert json.loads(request.content)["position"] == 7
            return httpx.Response(201, json=[])
        assert request.url.params["id"] == "eq.segment-1"
        return httpx.Response(200, json=[existing])

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    backend = SupabaseBackend(
        "https://project.supabase.co",
        "public-anon",
        "private-service-role",
        client=client,
    )
    duplicate = {**existing, "position": 7, "text": "重复回放"}

    assert await backend.persist_segment(duplicate) == existing
    assert [request.method for request in requests] == ["POST", "GET"]
    await backend.close()


@pytest.mark.asyncio
async def test_continuation_restores_latest_position_and_end_offset():
    def handler(request):
        assert request.url.params["select"] == "position,ended_offset_ms"
        assert request.url.params["order"] == "position.desc"
        return httpx.Response(200, json=[{"position": 6, "ended_offset_ms": 125_400}])

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    backend = SupabaseBackend(
        "https://project.supabase.co",
        "public-anon",
        "private-service-role",
        client=client,
    )
    assert await backend.continuation("user-1", "meeting-1") == (7, 125_400)
    await backend.close()
