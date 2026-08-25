export type ProviderEvent =
  | { kind: "ready" }
  | { kind: "partial"; text: string }
  | { kind: "final"; sourceId: string; text: string }
  | { kind: "finished" }
  | { kind: "error"; message: string };

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseProviderEvent(message: string): ProviderEvent | null {
  let value: UnknownRecord | null;
  try {
    value = record(JSON.parse(message));
  } catch {
    return null;
  }
  if (!value) return null;

  const type = text(value.type);
  if (type === "session.created" || type === "session.updated") return { kind: "ready" };
  if (type === "session.finished") return { kind: "finished" };
  if (type === "conversation.item.input_audio_transcription.text") {
    const partial = `${text(value.text)}${text(value.stash)}`.trim();
    return partial ? { kind: "partial", text: partial } : null;
  }
  if (type === "conversation.item.input_audio_transcription.completed") {
    const transcript = text(value.transcript).trim();
    if (!transcript) return null;
    return {
      kind: "final",
      sourceId: text(value.item_id) || text(value.event_id),
      text: transcript,
    };
  }
  if (type === "error") {
    const error = record(value.error);
    return { kind: "error", message: text(error?.message) || "ASR_ERROR" };
  }
  return null;
}
