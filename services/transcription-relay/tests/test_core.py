from uuid import UUID

from relay.core import ConnectionState, parse_provider_event, pcm_duration_ms, segment_id


def test_parses_ready_partial_and_final_provider_events():
    assert parse_provider_event({"type": "session.updated"}) == {"type": "ready"}
    assert parse_provider_event({
        "type": "conversation.item.input_audio_transcription.text",
        "text": "正在讨论",
        "stash": "预算",
    }) == {"type": "partial", "text": "正在讨论预算"}
    assert parse_provider_event({
        "type": "conversation.item.input_audio_transcription.completed",
        "item_id": "item-1",
        "transcript": "形成结论",
    }) == {"type": "final", "item_id": "item-1", "text": "形成结论"}
    assert parse_provider_event({
        "type": "conversation.item.input_audio_transcription.completed",
        "item_id": "item-2",
        "transcript": "  ",
    }) is None


def test_pcm_duration_uses_16khz_mono_signed_16_bit_audio():
    assert pcm_duration_ms(32_000) == 1_000
    assert pcm_duration_ms(3_200) == 100


def test_segment_identity_is_stable_and_scoped():
    first = segment_id("user-1", "meeting-1", "item-1")
    assert UUID(first).version == 5
    assert segment_id("user-1", "meeting-1", "item-1") == first
    assert segment_id("user-1", "meeting-1", "item-2") != first


def test_connection_state_advances_audio_time_and_positions():
    state = ConnectionState(next_position=4)
    state.record_audio(32_000)
    first = state.segment_candidate("user-1", "meeting-1", "item-1", "第一段")
    state.accept(first)
    state.record_audio(16_000)
    second = state.segment_candidate("user-1", "meeting-1", "item-2", "第二段")
    state.accept(second)

    assert first["position"] == 4
    assert first["started_offset_ms"] == 0
    assert first["ended_offset_ms"] == 1_000
    assert second["position"] == 5
    assert second["started_offset_ms"] == 1_000
    assert second["ended_offset_ms"] == 1_500
    assert second["source"] == "asr"


def test_connection_state_does_not_advance_for_a_duplicate_segment():
    state = ConnectionState(next_position=3, audio_offset_ms=120_000, segment_start_ms=120_000)
    state.record_audio(3_200)
    duplicate = state.segment_candidate("user-1", "meeting-1", "old-item", "重复")

    assert duplicate["position"] == 3
    assert duplicate["started_offset_ms"] == 120_000
    assert duplicate["ended_offset_ms"] == 120_100
    assert state.next_position == 3
    assert state.segment_start_ms == 120_000
