from typing import Any, Dict, List, Optional, Tuple


class PcmBatcher:
    def __init__(self, batch_bytes: int):
        self.batch_bytes = batch_bytes
        self.buffer = b""
        self.started_offset_ms: Optional[int] = None

    def append(self, chunk: bytes, started_offset_ms: int) -> Optional[Tuple[int, bytes]]:
        if self.started_offset_ms is None:
            self.started_offset_ms = started_offset_ms
        self.buffer += chunk
        if len(self.buffer) < self.batch_bytes:
            return None
        batch = self.buffer[:self.batch_bytes]
        batch_start = self.started_offset_ms
        self.buffer = self.buffer[self.batch_bytes:]
        self.started_offset_ms = batch_start + round(self.batch_bytes / 32)
        return batch_start, batch


def speaker_updates(
    segments: List[Dict[str, Any]],
    intervals: List[Dict[str, Any]],
    batch_started_offset_ms: int,
) -> List[Dict[str, str]]:
    updates = []
    for segment in segments:
        best = None
        best_overlap = 0
        for interval in intervals:
            started = batch_started_offset_ms + int(interval["started_offset_ms"])
            ended = batch_started_offset_ms + int(interval["ended_offset_ms"])
            overlap = max(0, min(int(segment["ended_offset_ms"]), ended) - max(int(segment["started_offset_ms"]), started))
            if overlap > best_overlap:
                best = interval
                best_overlap = overlap
        if best and segment.get("id"):
            updates.append({"id": str(segment["id"]), "speaker_id": str(best["speaker_id"])})
    return updates
