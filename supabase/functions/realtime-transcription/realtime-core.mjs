export function sessionUpdateEvent(eventId) {
  return {
    event_id: eventId,
    type: "session.update",
    session: {
      modalities: ["text"],
      input_audio_format: "pcm",
      sample_rate: 16000,
      input_audio_transcription: { language: "zh" },
      turn_detection: {
        type: "server_vad",
        threshold: 0.2,
        silence_duration_ms: 400,
      },
    },
  };
}

function base64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function audioAppendEvent(bytes, eventId) {
  return {
    event_id: eventId,
    type: "input_audio_buffer.append",
    audio: base64(bytes),
  };
}

export function finishEvent(eventId) {
  return { event_id: eventId, type: "session.finish" };
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function string(value) {
  return typeof value === "string" ? value : "";
}

export function parseAlibabaEvent(message) {
  let value;
  try {
    value = object(JSON.parse(message));
  } catch {
    return null;
  }
  if (!value) return null;
  if (value.type === "session.created") return { kind: "created" };
  if (value.type === "session.updated") return { kind: "ready" };
  if (value.type === "session.finished") return { kind: "finished" };
  if (value.type === "conversation.item.input_audio_transcription.text") {
    const text = `${string(value.text)}${string(value.stash)}`.trim();
    return text ? { kind: "partial", text } : null;
  }
  if (value.type === "conversation.item.input_audio_transcription.completed") {
    const text = string(value.transcript).trim();
    if (!text) return null;
    return { kind: "final", sourceId: string(value.item_id) || string(value.event_id), text };
  }
  if (value.type === "error") return { kind: "error", message: string(object(value.error)?.message) || "ASR_ERROR" };
  return null;
}

export async function stableSegmentId(userId, meetingId, sourceId) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${userId}:${meetingId}:${sourceId}`)));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
