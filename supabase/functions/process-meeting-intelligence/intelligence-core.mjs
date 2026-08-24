function failure(code) {
  return new Error(code);
}

function text(value, code) {
  if (typeof value !== "string" || value.trim().length === 0) throw failure(code);
  return value.trim();
}

function evidencePositions(value, segmentIds) {
  if (!Array.isArray(value) || !value.every((position) => Number.isSafeInteger(position) && position >= 0)) {
    throw failure("INVALID_EVIDENCE_POSITION");
  }
  return value.map((position) => {
    const id = segmentIds[position];
    if (!id) throw failure("INVALID_EVIDENCE_POSITION");
    return id;
  });
}

function normalizeEvidenceItems(value, segmentIds) {
  if (!Array.isArray(value)) throw failure("INVALID_MINUTES_RESPONSE");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw failure("INVALID_MINUTES_RESPONSE");
    return {
      text: text(item.text, "INVALID_MINUTES_RESPONSE"),
      evidenceSegmentIds: evidencePositions(item.evidencePositions, segmentIds),
    };
  });
}

function normalizeActions(value, segmentIds) {
  if (!Array.isArray(value)) throw failure("INVALID_MINUTES_RESPONSE");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw failure("INVALID_MINUTES_RESPONSE");
    const owner = item.owner === null ? null : text(item.owner, "INVALID_MINUTES_RESPONSE");
    const dueDate = item.dueDate === null ? null : item.dueDate;
    if (dueDate !== null && (typeof dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))) {
      throw failure("INVALID_MINUTES_RESPONSE");
    }
    return {
      text: text(item.text, "INVALID_MINUTES_RESPONSE"),
      owner,
      dueDate,
      evidenceSegmentIds: evidencePositions(item.evidencePositions, segmentIds),
    };
  });
}

function normalizeTranscript(response, meetingId, durationMs) {
  if (!response || typeof response !== "object") throw failure("INVALID_TRANSCRIPTION_RESPONSE");
  const responseText = text(response.text, "EMPTY_TRANSCRIPTION");
  const rawSegments = Array.isArray(response.segments) && response.segments.length > 0
    ? response.segments
    : [{ text: responseText, start: 0, end: durationMs / 1_000 }];
  return rawSegments.map((raw, position) => {
    if (!raw || typeof raw !== "object") throw failure("INVALID_TRANSCRIPTION_RESPONSE");
    const startedOffsetMs = Math.max(0, Math.round(Number(raw.start) * 1_000));
    const proposedEnd = Math.round(Number(raw.end) * 1_000);
    const endedOffsetMs = Number.isFinite(proposedEnd) && proposedEnd > startedOffsetMs
      ? proposedEnd
      : Math.max(startedOffsetMs + 1, Math.round(durationMs));
    return {
      id: crypto.randomUUID(),
      meetingId,
      position,
      text: text(raw.text, "INVALID_TRANSCRIPTION_RESPONSE"),
      startedOffsetMs,
      endedOffsetMs,
      speaker: null,
      source: "asr",
      confidence: typeof raw.avg_logprob === "number" ? null : null,
    };
  });
}

/**
 * @param {{ meetingId: string, transcriptionModel: string, summaryModel: string, mimeType: string, audio: Blob, durationMs: number }} input
 * @param {{ transcribe: (input: { model: string, mimeType: string, audio: Blob }) => Promise<{ text: string, segments?: Array<{ text: string, start: number, end: number, avg_logprob?: number }> }>, summarize: (input: { model: string, transcript: string }) => Promise<{ summary: string, topics: Array<{ text: string, evidencePositions: number[] }>, decisions: Array<{ text: string, evidencePositions: number[] }>, risks: Array<{ text: string, evidencePositions: number[] }>, actions: Array<{ text: string, owner: string | null, dueDate: string | null, evidencePositions: number[] }> }> }} provider
 */
export async function processMeetingIntelligence(input, provider) {
  if (!input || typeof input !== "object" || !Number.isSafeInteger(input.durationMs) || input.durationMs <= 0) {
    throw failure("INVALID_PROCESSING_INPUT");
  }
  const transcription = await provider.transcribe({
    model: text(input.transcriptionModel, "INVALID_PROCESSING_INPUT"),
    mimeType: text(input.mimeType, "INVALID_PROCESSING_INPUT"),
    audio: input.audio,
  });
  const transcript = normalizeTranscript(transcription, input.meetingId, input.durationMs);
  const summary = await provider.summarize({
    model: text(input.summaryModel, "INVALID_PROCESSING_INPUT"),
    transcript: transcript.map((segment) => `[${segment.position}] ${segment.text}`).join("\n"),
  });
  if (!summary || typeof summary !== "object") throw failure("INVALID_MINUTES_RESPONSE");
  const segmentIds = transcript.map((segment) => segment.id);
  return {
    transcript,
    minutes: {
      summary: text(summary.summary, "INVALID_MINUTES_RESPONSE"),
      topics: normalizeEvidenceItems(summary.topics, segmentIds),
      decisions: normalizeEvidenceItems(summary.decisions, segmentIds),
      risks: normalizeEvidenceItems(summary.risks, segmentIds),
      actions: normalizeActions(summary.actions, segmentIds),
    },
  };
}
