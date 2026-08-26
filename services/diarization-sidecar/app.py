import asyncio
import os
import tempfile
import wave
from typing import Any, Callable, Dict, List

from fastapi import FastAPI, HTTPException, Request


SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2


def duration_ms(pcm: bytes) -> int:
    return round(len(pcm) / (SAMPLE_RATE * BYTES_PER_SAMPLE) * 1_000)


def normalize_intervals(raw: Any, duration_ms: int) -> List[Dict[str, Any]]:
    intervals = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, (list, tuple)) or len(item) != 3:
            continue
        try:
            started = round(float(item[0]) * 1_000)
            ended = round(float(item[1]) * 1_000)
            speaker_id = str(int(item[2]))
        except (TypeError, ValueError, OverflowError):
            continue
        started = max(0, min(started, duration_ms))
        ended = max(0, min(ended, duration_ms))
        if ended <= started:
            continue
        intervals.append({
            "started_offset_ms": started,
            "ended_offset_ms": ended,
            "speaker_id": speaker_id,
        })
    return intervals


class CamplusDiarizer:
    def __init__(self, model_cache: str):
        os.environ.setdefault("MODELSCOPE_CACHE", model_cache)
        from modelscope.pipelines import pipeline

        self.pipeline = pipeline(
            task="speaker-diarization",
            model="iic/speech_campplus_speaker-diarization_common",
            model_revision="master",
        )

    def __call__(self, pcm: bytes) -> Any:
        fd, path = tempfile.mkstemp(prefix="meeting-diarization-", suffix=".wav")
        os.close(fd)
        try:
            with wave.open(path, "wb") as audio:
                audio.setparams((1, BYTES_PER_SAMPLE, SAMPLE_RATE, 0, "NONE", "not compressed"))
                audio.writeframes(pcm)
            result = self.pipeline(path)
            return result.get("text", []) if isinstance(result, dict) else []
        finally:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass


def create_app(diarize: Callable[[bytes], Any]) -> FastAPI:
    app = FastAPI()

    @app.get("/health")
    async def health() -> Dict[str, str]:
        return {"status": "ok"}

    @app.post("/v1/diarize")
    async def diarize_pcm(request: Request) -> Dict[str, Any]:
        pcm = await request.body()
        if not pcm or len(pcm) % BYTES_PER_SAMPLE:
            raise HTTPException(status_code=422, detail="invalid_pcm16")
        pcm_duration_ms = duration_ms(pcm)
        raw_intervals = await asyncio.to_thread(diarize, pcm)
        return {
            "duration_ms": pcm_duration_ms,
            "intervals": normalize_intervals(raw_intervals, pcm_duration_ms),
        }

    return app


def create_production_app() -> FastAPI:
    cache = os.environ.get(
        "MODELSCOPE_CACHE",
        "/Users/jinlongchen/Library/Application Support/iPad Meeting Relay/diarization-models",
    )
    return create_app(CamplusDiarizer(cache))
