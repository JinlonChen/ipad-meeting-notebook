from dataclasses import dataclass
from typing import Any, Dict, Optional
from uuid import NAMESPACE_URL, uuid5


PROVIDER_PARTIAL = "conversation.item.input_audio_transcription.text"
PROVIDER_FINAL = "conversation.item.input_audio_transcription.completed"


def parse_provider_event(message: Dict[str, Any]) -> Optional[Dict[str, str]]:
    event_type = message.get("type")
    if event_type == "session.updated":
        return {"type": "ready"}
    if event_type == PROVIDER_PARTIAL:
        text = f"{message.get('text') or ''}{message.get('stash') or ''}".strip()
        return {"type": "partial", "text": text} if text else None
    if event_type == PROVIDER_FINAL:
        text = str(message.get("transcript") or message.get("text") or "").strip()
        if not text:
            return None
        item_id = str(message.get("item_id") or message.get("item", {}).get("id") or "").strip()
        return {"type": "final", "item_id": item_id, "text": text}
    if event_type == "error":
        error = message.get("error") if isinstance(message.get("error"), dict) else {}
        code = str(error.get("code") or "provider_error")
        return {"type": "error", "code": code}
    if event_type == "session.finished":
        return {"type": "finished"}
    return None


def pcm_duration_ms(byte_count: int) -> int:
    return max(0, round(byte_count / (16_000 * 2) * 1_000))


def segment_id(user_id: str, meeting_id: str, item_id: str) -> str:
    identity = f"https://meeting-notebook.local/transcript/{user_id}/{meeting_id}/{item_id}"
    return str(uuid5(NAMESPACE_URL, identity))


@dataclass
class ConnectionState:
    next_position: int = 0
    audio_offset_ms: int = 0
    segment_start_ms: int = 0

    def record_audio(self, byte_count: int) -> None:
        self.audio_offset_ms += pcm_duration_ms(byte_count)

    def segment_candidate(
        self,
        user_id: str,
        meeting_id: str,
        item_id: str,
        text: str,
    ) -> Dict[str, Any]:
        ended_at = max(self.audio_offset_ms, self.segment_start_ms + 1)
        segment = {
            "user_id": user_id,
            "id": segment_id(user_id, meeting_id, item_id),
            "meeting_id": meeting_id,
            "position": self.next_position,
            "text": text,
            "started_offset_ms": self.segment_start_ms,
            "ended_offset_ms": ended_at,
            "speaker": None,
            "source": "asr",
            "confidence": None,
        }
        return segment

    def accept(self, segment: Dict[str, Any]) -> None:
        if segment["position"] != self.next_position:
            raise ValueError("segment_position_mismatch")
        self.next_position += 1
        self.segment_start_ms = int(segment["ended_offset_ms"])
