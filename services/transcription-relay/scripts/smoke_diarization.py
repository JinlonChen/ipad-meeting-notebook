#!/usr/bin/env python3
import argparse
import os
import sys
import time
import wave
from pathlib import Path
from typing import Any, Dict, List, Optional

import dashscope
from dashscope.audio.asr.recognition import Recognition, RecognitionCallback


DEFAULT_MODEL = "fun-asr-realtime"


def _is_provider_final(sentence: Dict[str, Any]) -> bool:
    text = str(sentence.get("text") or "").strip()
    started = sentence.get("begin_time")
    ended = sentence.get("end_time")
    return bool(text) and isinstance(started, int) and isinstance(ended, int) and ended > started


def _missing_identifier(value: Any) -> bool:
    return value is None or not str(value).strip()


def normalized_sentence(sentence: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    text = str(sentence.get("text") or "").strip()
    started = sentence.get("begin_time")
    ended = sentence.get("end_time")
    speaker = sentence.get("speaker_id")
    sentence_id = sentence.get("sentence_id")
    if not _is_provider_final(sentence):
        return None
    if _missing_identifier(speaker) or _missing_identifier(sentence_id):
        return None
    return {
        "type": "final",
        "item_id": f"sentence-{sentence_id}",
        "text": text,
        "started_offset_ms": started,
        "ended_offset_ms": ended,
        "speaker_id": str(speaker),
    }


def smoke_passed(events: List[Dict[str, Any]]) -> bool:
    speakers = {
        str(event.get("speaker_id")).strip()
        for event in events
        if event.get("text") and not _missing_identifier(event.get("speaker_id"))
    }
    return len(events) >= 2 and len(speakers) >= 2


class _Collector(RecognitionCallback):
    def __init__(self) -> None:
        self.events: List[Dict[str, Any]] = []
        self.provider_final_sentences = 0
        self.missing_speaker_id = 0
        self.missing_sentence_id = 0
        self.error_code = ""

    def on_event(self, result) -> None:
        sentence = result.get_sentence()
        if isinstance(sentence, dict):
            if not _is_provider_final(sentence):
                return
            self.provider_final_sentences += 1
            if _missing_identifier(sentence.get("speaker_id")):
                self.missing_speaker_id += 1
            if _missing_identifier(sentence.get("sentence_id")):
                self.missing_sentence_id += 1
            event = normalized_sentence(sentence)
            if event:
                self.events.append(event)

    def on_error(self, result) -> None:
        self.error_code = str(getattr(result, "code", None) or "provider_error")


def run(
    audio_path: Path,
    model: str,
    speaker_count: Optional[int],
    recognition_factory=Recognition,
    sleep=time.sleep,
) -> int:
    api_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not api_key:
        print("missing_api_key", file=sys.stderr)
        return 2
    dashscope.api_key = api_key

    with wave.open(str(audio_path), "rb") as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 16_000):
            print("audio_must_be_pcm16_mono_16khz", file=sys.stderr)
            return 2
        callback = _Collector()
        recognition = recognition_factory(
            model=model,
            callback=callback,
            format="pcm",
            sample_rate=16_000,
            diarization_enabled=True,
            speaker_count=speaker_count,
        )
        recognition.start()
        while True:
            frame = audio.readframes(1_600)
            if not frame:
                break
            recognition.send_audio_frame(frame)
            sleep(0.1)
        recognition.stop()

    speakers = sorted({event["speaker_id"] for event in callback.events})
    print(
        f"model={model} provider_final_sentences={callback.provider_final_sentences} "
        f"normalized_events={len(callback.events)} missing_speaker_id={callback.missing_speaker_id} "
        f"missing_sentence_id={callback.missing_sentence_id} distinct_speaker_ids={len(speakers)}"
    )
    if callback.error_code:
        print(f"provider_error={callback.error_code}", file=sys.stderr)
        return 1
    return 0 if smoke_passed(callback.events) else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify realtime ASR speaker diarization without printing content.")
    parser.add_argument("audio", type=Path)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--speaker-count", type=int, choices=range(1, 6))
    arguments = parser.parse_args()
    return run(arguments.audio, arguments.model, arguments.speaker_count)


if __name__ == "__main__":
    raise SystemExit(main())
