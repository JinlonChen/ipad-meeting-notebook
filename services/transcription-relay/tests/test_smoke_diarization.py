import wave

from scripts.smoke_diarization import normalized_sentence, run, smoke_passed


def test_normalizes_final_sentence_with_speaker_and_timestamps():
    assert normalized_sentence({
        "sentence_id": 7,
        "text": "确认方案。",
        "begin_time": 1_200,
        "end_time": 3_100,
        "speaker_id": 1,
    }) == {
        "type": "final",
        "item_id": "sentence-7",
        "text": "确认方案。",
        "started_offset_ms": 1_200,
        "ended_offset_ms": 3_100,
        "speaker_id": "1",
    }


def test_ignores_partial_or_incomplete_sentences():
    assert normalized_sentence({
        "sentence_id": 8,
        "text": "还在说",
        "begin_time": 3_200,
        "end_time": None,
        "speaker_id": 1,
    }) is None
    assert normalized_sentence({
        "sentence_id": 9,
        "text": "没有说话人",
        "begin_time": 3_200,
        "end_time": 4_000,
    }) is None


def test_smoke_gate_requires_text_timestamps_and_two_speakers():
    valid = [
        normalized_sentence({"sentence_id": 1, "text": "第一位发言。", "begin_time": 0, "end_time": 900, "speaker_id": 0}),
        normalized_sentence({"sentence_id": 2, "text": "第二位发言。", "begin_time": 1_000, "end_time": 2_000, "speaker_id": 1}),
    ]
    assert smoke_passed([event for event in valid if event]) is True
    assert smoke_passed([valid[0]]) is False


def test_smoke_gate_does_not_count_blank_speaker_ids():
    assert smoke_passed([
        {"text": "first", "speaker_id": "speaker-a"},
        {"text": "second", "speaker_id": "  "},
    ]) is False


def _audio_file(tmp_path):
    audio_path = tmp_path / "sample.wav"
    with wave.open(str(audio_path), "wb") as audio:
        audio.setparams((1, 2, 16_000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\0\0" * 1_600)
    return audio_path


def test_run_treats_void_sdk_start_as_success_without_exposing_content_or_ids(tmp_path, monkeypatch, capsys):
    audio_path = _audio_file(tmp_path)

    class Result:
        def __init__(self, sentence):
            self.sentence = sentence

        def get_sentence(self):
            return self.sentence

    class FakeRecognition:
        def __init__(self, **kwargs):
            self.callback = kwargs["callback"]

        def start(self):
            return None

        def send_audio_frame(self, _frame):
            self.callback.on_event(Result({"sentence_id": 1, "text": "甲。", "begin_time": 0, "end_time": 40, "speaker_id": 0}))
            self.callback.on_event(Result({"sentence_id": 2, "text": "乙。", "begin_time": 50, "end_time": 90, "speaker_id": 1}))

        def stop(self):
            return None

    api_key = "private-success-api-key"
    monkeypatch.setenv("DASHSCOPE_API_KEY", api_key)
    assert run(audio_path, "test-model", 2, recognition_factory=FakeRecognition, sleep=lambda _seconds: None) == 0

    captured = capsys.readouterr()
    assert captured.out.strip() == (
        "model=test-model provider_final_sentences=2 normalized_events=2 "
        "missing_speaker_id=0 missing_sentence_id=0 distinct_speaker_ids=2"
    )
    assert captured.err == ""
    for secret in ("甲。", "乙。", api_key, "speaker_ids=0,1"):
        assert secret not in captured.out
        assert secret not in captured.err


def test_run_reports_provider_finals_missing_ids_without_exposing_content_or_key(tmp_path, monkeypatch, capsys):
    audio_path = _audio_file(tmp_path)
    secret_texts = ("private transcript alpha", "private transcript beta")

    class Result:
        def __init__(self, sentence):
            self.sentence = sentence

        def get_sentence(self):
            return self.sentence

    class FakeRecognition:
        def __init__(self, **kwargs):
            self.callback = kwargs["callback"]

        def start(self):
            return None

        def send_audio_frame(self, _frame):
            self.callback.on_event(Result({
                "sentence_id": 1,
                "text": secret_texts[0],
                "begin_time": 0,
                "end_time": 40,
                "speaker_id": None,
            }))
            self.callback.on_event(Result({
                "sentence_id": None,
                "text": secret_texts[1],
                "begin_time": 50,
                "end_time": 90,
                "speaker_id": "speaker-a",
            }))

        def stop(self):
            return None

    api_key = "private-test-api-key"
    monkeypatch.setenv("DASHSCOPE_API_KEY", api_key)

    assert run(audio_path, "test-model", 2, recognition_factory=FakeRecognition, sleep=lambda _seconds: None) == 1

    captured = capsys.readouterr()
    assert captured.out.strip() == (
        "model=test-model provider_final_sentences=2 normalized_events=0 "
        "missing_speaker_id=1 missing_sentence_id=1 distinct_speaker_ids=0"
    )
    assert captured.err == ""
    for secret in (*secret_texts, api_key):
        assert secret not in captured.out
        assert secret not in captured.err
