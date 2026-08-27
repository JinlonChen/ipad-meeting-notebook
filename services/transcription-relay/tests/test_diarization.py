from relay.diarization import PcmBatcher, speaker_updates


def test_pcm_batcher_preserves_absolute_offsets_across_chunks():
    batcher = PcmBatcher(batch_bytes=8)

    assert batcher.append(b"abc", 10_000) is None
    assert batcher.append(b"defgh", 10_003) == (10_000, b"abcdefgh")
    assert batcher.append(b"ij", 10_008) is None
    assert batcher.append(b"klmnop", 10_010) == (10_000, b"ijklmnop")


def test_speaker_updates_use_the_largest_overlapping_camplus_interval():
    segments = [
        {"id": "segment-1", "started_offset_ms": 1_000, "ended_offset_ms": 4_000},
        {"id": "segment-2", "started_offset_ms": 4_000, "ended_offset_ms": 7_000},
        {"id": "segment-3", "started_offset_ms": 7_000, "ended_offset_ms": 9_000},
    ]
    intervals = [
        {"started_offset_ms": 0, "ended_offset_ms": 3_500, "speaker_id": "9"},
        {"started_offset_ms": 3_500, "ended_offset_ms": 10_000, "speaker_id": "4"},
    ]

    assert speaker_updates(segments, intervals, batch_started_offset_ms=1_000) == [
        {"id": "segment-1", "speaker_id": "9"},
        {"id": "segment-2", "speaker_id": "4"},
        {"id": "segment-3", "speaker_id": "4"},
    ]
