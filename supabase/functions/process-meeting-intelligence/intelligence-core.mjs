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

/**
 * @param {{ summaryModel: string, transcript: Array<{ id: string, position: number, speaker?: string | null, text: string }>, note?: string }} input
 * @param {{ summarize: (input: { model: string, transcript: string }) => Promise<{ summary: string, topics: Array<{ text: string, evidencePositions: number[] }>, decisions: Array<{ text: string, evidencePositions: number[] }>, risks: Array<{ text: string, evidencePositions: number[] }>, actions: Array<{ text: string, owner: string | null, dueDate: string | null, evidencePositions: number[] }> }> }} provider
 */
export async function generateMeetingMinutes(input, provider) {
  if (!input || typeof input !== "object" || !Array.isArray(input.transcript)) throw failure("INVALID_PROCESSING_INPUT");
  if (input.note !== undefined && typeof input.note !== "string") throw failure("INVALID_PROCESSING_INPUT");
  const note = input.note?.trim() ?? "";
  if (input.transcript.length === 0 && !note) throw failure("EMPTY_MEETING_CONTENT");
  const transcript = input.transcript.map((segment, expectedPosition) => {
    if (!segment || typeof segment !== "object" || segment.position !== expectedPosition) throw failure("INVALID_PROCESSING_INPUT");
    if (segment.speaker !== undefined && segment.speaker !== null && typeof segment.speaker !== "string") throw failure("INVALID_PROCESSING_INPUT");
    return {
      id: text(segment.id, "INVALID_PROCESSING_INPUT"),
      position: segment.position,
      speaker: segment.speaker?.trim() || "发言人未标记",
      text: text(segment.text, "EMPTY_MEETING_CONTENT"),
    };
  });
  const content = [
    ...transcript.map((segment) => `[转写 ${segment.position}] ${segment.speaker}: ${segment.text}`),
    ...(note ? [`[键盘笔记] ${note}`] : []),
  ].join("\n");
  const summary = await provider.summarize({
    model: text(input.summaryModel, "INVALID_PROCESSING_INPUT"),
    transcript: content,
  });
  if (!summary || typeof summary !== "object") throw failure("INVALID_MINUTES_RESPONSE");
  const segmentIds = transcript.map((segment) => segment.id);
  return {
    summary: text(summary.summary, "INVALID_MINUTES_RESPONSE"),
    topics: normalizeEvidenceItems(summary.topics, segmentIds),
    decisions: normalizeEvidenceItems(summary.decisions, segmentIds),
    risks: normalizeEvidenceItems(summary.risks, segmentIds),
    actions: normalizeActions(summary.actions, segmentIds),
  };
}
