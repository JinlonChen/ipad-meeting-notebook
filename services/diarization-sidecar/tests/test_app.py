from fastapi.testclient import TestClient

from app import create_app, normalize_intervals


def test_normalizes_camplus_ranges_without_exposing_model_output():
    assert normalize_intervals([
        [0.0, 1.25, 7],
        [1.25, 2.5, 3],
        [2.5, 2.5, 9],
        [3.0, 2.0, 4],
    ], duration_ms=3_000) == [
        {"started_offset_ms": 0, "ended_offset_ms": 1_250, "speaker_id": "7"},
        {"started_offset_ms": 1_250, "ended_offset_ms": 2_500, "speaker_id": "3"},
    ]


def test_diarize_endpoint_validates_pcm_and_returns_sanitized_ranges():
    seen = []

    def diarize(pcm):
        seen.append(pcm)
        return [[0.0, 1.0, 2]]

    client = TestClient(create_app(diarize))
    response = client.post("/v1/diarize", content=b"\x00\x00" * 16_000)

    assert response.status_code == 200
    assert seen == [b"\x00\x00" * 16_000]
    assert response.json() == {
        "duration_ms": 1_000,
        "intervals": [{"started_offset_ms": 0, "ended_offset_ms": 1_000, "speaker_id": "2"}],
    }
    assert client.post("/v1/diarize", content=b"x").status_code == 422
