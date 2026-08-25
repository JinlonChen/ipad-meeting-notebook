from typing import Any, Dict, Optional

import httpx


class SupabaseBackend:
    def __init__(self, url: str, anon_key: str, service_role_key: str, client=None):
        self.url = url.rstrip("/")
        self.anon_key = anon_key
        self.service_role_key = service_role_key
        self.client = client or httpx.AsyncClient(timeout=10)

    async def authenticate(self, token: str) -> Optional[str]:
        response = await self.client.get(
            f"{self.url}/auth/v1/user",
            headers={"apikey": self.anon_key, "Authorization": f"Bearer {token}"},
        )
        if response.status_code != 200:
            return None
        user_id = response.json().get("id")
        return user_id if isinstance(user_id, str) and user_id else None

    def _service_headers(self) -> Dict[str, str]:
        return {
            "apikey": self.service_role_key,
            "Authorization": f"Bearer {self.service_role_key}",
        }

    async def owns_meeting(self, user_id: str, meeting_id: str) -> bool:
        response = await self.client.get(
            f"{self.url}/rest/v1/meetings",
            headers=self._service_headers(),
            params={"select": "id", "user_id": f"eq.{user_id}", "id": f"eq.{meeting_id}", "limit": "1"},
        )
        response.raise_for_status()
        return len(response.json()) == 1

    async def transcription_key(self, user_id: str) -> Optional[str]:
        response = await self.client.get(
            f"{self.url}/rest/v1/ai_provider_credentials",
            headers=self._service_headers(),
            params={"select": "transcription_api_key", "user_id": f"eq.{user_id}", "limit": "1"},
        )
        response.raise_for_status()
        rows = response.json()
        if len(rows) != 1:
            return None
        key = rows[0].get("transcription_api_key")
        return key if isinstance(key, str) and key else None

    async def continuation(self, user_id: str, meeting_id: str):
        response = await self.client.get(
            f"{self.url}/rest/v1/meeting_transcript_segments",
            headers=self._service_headers(),
            params={
                "select": "position,ended_offset_ms",
                "user_id": f"eq.{user_id}",
                "meeting_id": f"eq.{meeting_id}",
                "order": "position.desc",
                "limit": "1",
            },
        )
        response.raise_for_status()
        rows = response.json()
        if not rows:
            return 0, 0
        return int(rows[0]["position"]) + 1, int(rows[0]["ended_offset_ms"])

    async def persist_segment(self, segment: Dict[str, Any]) -> Dict[str, Any]:
        headers = {
            **self._service_headers(),
            "Content-Type": "application/json",
            "Prefer": "resolution=ignore-duplicates,return=representation",
        }
        response = await self.client.post(
            f"{self.url}/rest/v1/meeting_transcript_segments",
            headers=headers,
            params={"on_conflict": "user_id,id"},
            json=segment,
        )
        response.raise_for_status()
        rows = response.json()
        if rows:
            return rows[0]
        existing = await self.client.get(
            f"{self.url}/rest/v1/meeting_transcript_segments",
            headers=self._service_headers(),
            params={
                "select": "user_id,id,meeting_id,position,text,started_offset_ms,ended_offset_ms,speaker,source,confidence",
                "user_id": f"eq.{segment['user_id']}",
                "id": f"eq.{segment['id']}",
                "limit": "1",
            },
        )
        existing.raise_for_status()
        existing_rows = existing.json()
        if len(existing_rows) != 1:
            raise RuntimeError("segment_persistence_conflict")
        return existing_rows[0]

    async def close(self) -> None:
        await self.client.aclose()
