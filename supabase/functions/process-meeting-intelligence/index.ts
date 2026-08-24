import { createClient } from "@supabase/supabase-js";
import { processMeetingIntelligence } from "./intelligence-core.mjs";

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};
const AUDIO_BUCKET = "meeting-audio";
const ALLOWED_FAILURE_CODES = new Set([
  "AI_CONFIGURATION_REQUIRED",
  "AUDIO_NOT_READY",
  "AUDIO_FORMAT_MIXED",
  "TRANSCRIPTION_FAILED",
  "MINUTES_FAILED",
  "INVALID_TRANSCRIPTION_RESPONSE",
  "INVALID_MINUTES_RESPONSE",
  "INVALID_EVIDENCE_POSITION",
  "EMPTY_TRANSCRIPTION",
]);

type Credentials = { base_url: string; asr_model: string; chat_model: string; api_key: string };
type AudioChunk = { remote_path: string; sequence: number; mime_type: string };

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), { headers: JSON_HEADERS, status });
}

function requestError(code: string, status = 400): Error {
  const error = new Error(code);
  error.name = "ProcessingRequestError";
  Object.assign(error, { status });
  return error;
}

function statusOf(error: unknown): number {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : 500;
}

function safeFailureCode(error: unknown): string {
  return error instanceof Error && ALLOWED_FAILURE_CODES.has(error.message) ? error.message : "PROCESSING_FAILED";
}

function endpoint(baseUrl: string, path: string): string {
  const origin = new URL(baseUrl);
  if (origin.protocol !== "https:") throw requestError("AI_CONFIGURATION_REQUIRED", 422);
  return new URL(path, origin.pathname.endsWith("/") ? origin : new URL(`${origin.pathname}/`, origin)).toString();
}

async function providerJson(response: Response, code: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw requestError(code, 422);
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw requestError(code, 422);
  return value as Record<string, unknown>;
}

function chatContent(value: Record<string, unknown>): string {
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !choices[0] || typeof choices[0] !== "object") {
    throw requestError("MINUTES_FAILED", 422);
  }
  const message = (choices[0] as Record<string, unknown>).message;
  if (!message || typeof message !== "object") throw requestError("MINUTES_FAILED", 422);
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string") throw requestError("MINUTES_FAILED", 422);
  try {
    return content.replace(/^```json\s*|\s*```$/g, "").trim();
  } catch {
    throw requestError("MINUTES_FAILED", 422);
  }
}

function fileName(mimeType: string): string {
  if (mimeType.startsWith("audio/mp4")) return "meeting.m4a";
  if (mimeType.startsWith("audio/webm")) return "meeting.webm";
  return "meeting.bin";
}

async function callerId(supabaseUrl: string, anonKey: string, authorization: string | null): Promise<string> {
  if (!authorization?.startsWith("Bearer ")) throw requestError("AUTH_REQUIRED", 401);
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await client.auth.getUser(authorization.slice("Bearer ".length));
  if (error || !data.user) throw requestError("AUTH_REQUIRED", 401);
  return data.user.id;
}

function minutesPrompt(): string {
  return [
    "You are a meeting assistant. Use only the supplied transcript.",
    "Return JSON only with summary, topics, decisions, risks, actions.",
    "Every topic/decision/risk/action has text and evidencePositions (integer array).",
    "Every action has text, owner, dueDate, evidencePositions. Use null for unknown owner or dueDate; never guess.",
    "dueDate is YYYY-MM-DD or null. Do not add facts absent from the transcript.",
  ].join(" ");
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRoleKey || !anonKey) return jsonResponse({ error: "processing_failed" }, 500);

  let userId = "";
  let meetingId = "";
  const service = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    userId = await callerId(supabaseUrl, anonKey, request.headers.get("Authorization"));
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { meetingId?: unknown }).meetingId !== "string") {
      throw requestError("INVALID_REQUEST", 400);
    }
    meetingId = (body as { meetingId: string }).meetingId;

    const [{ data: meeting, error: meetingError }, { data: credentials, error: credentialError }, { data: chunks, error: chunksError }] = await Promise.all([
      service.from("meetings").select("id").eq("user_id", userId).eq("id", meetingId).maybeSingle(),
      service.from("ai_provider_credentials").select("base_url,asr_model,chat_model,api_key").eq("user_id", userId).maybeSingle(),
      service.from("meeting_audio_chunks").select("remote_path,sequence,mime_type").eq("user_id", userId).eq("meeting_id", meetingId).order("sequence"),
    ]);
    if (meetingError || !meeting) throw requestError("MEETING_NOT_FOUND", 404);
    if (credentialError || !credentials) throw requestError("AI_CONFIGURATION_REQUIRED", 422);
    if (chunksError || !chunks || chunks.length === 0) throw requestError("AUDIO_NOT_READY", 422);

    const audioChunks = chunks as AudioChunk[];
    const mimeType = audioChunks[0]!.mime_type;
    if (!audioChunks.every((chunk) => chunk.mime_type === mimeType)) throw requestError("AUDIO_FORMAT_MIXED", 422);
    await service.from("meeting_intelligence_jobs").upsert({ user_id: userId, meeting_id: meetingId, status: "processing", error_code: null, requested_at: new Date().toISOString(), completed_at: null });
    await service.from("meetings").update({ status: "processing" }).eq("user_id", userId).eq("id", meetingId);

    const files = await Promise.all(audioChunks.map(async (chunk) => {
      const { data, error } = await service.storage.from(AUDIO_BUCKET).download(chunk.remote_path);
      if (error || !data) throw requestError("AUDIO_NOT_READY", 422);
      return data;
    }));
    const audio = new Blob(files, { type: mimeType });
    const config = credentials as Credentials;
    const result = await processMeetingIntelligence({
      meetingId,
      asrModel: config.asr_model,
      chatModel: config.chat_model,
      mimeType,
      audio,
      durationMs: audioChunks.length * 10_000,
    }, {
      transcribe: async ({ model, audio: inputAudio }) => {
        const form = new FormData();
        form.set("model", model);
        form.set("response_format", "verbose_json");
        form.set("file", inputAudio, fileName(mimeType));
        return providerJson(await fetch(endpoint(config.base_url, "audio/transcriptions"), {
          method: "POST",
          headers: { Authorization: `Bearer ${config.api_key}` },
          body: form,
        }), "TRANSCRIPTION_FAILED");
      },
      summarize: async ({ model, transcript }) => {
        const response = await providerJson(await fetch(endpoint(config.base_url, "chat/completions"), {
          method: "POST",
          headers: { Authorization: `Bearer ${config.api_key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            temperature: 0.1,
            response_format: { type: "json_object" },
            messages: [{ role: "system", content: minutesPrompt() }, { role: "user", content: transcript }],
          }),
        }), "MINUTES_FAILED");
        try {
          return JSON.parse(chatContent(response));
        } catch {
          throw requestError("MINUTES_FAILED", 422);
        }
      },
    });

    const { error: deleteError } = await service.from("meeting_transcript_segments").delete().eq("user_id", userId).eq("meeting_id", meetingId);
    if (deleteError) throw requestError("PROCESSING_FAILED", 500);
    const { error: segmentError } = await service.from("meeting_transcript_segments").insert(result.transcript.map((segment) => ({
      user_id: userId,
      id: segment.id,
      meeting_id: meetingId,
      position: segment.position,
      text: segment.text,
      started_offset_ms: segment.startedOffsetMs,
      ended_offset_ms: segment.endedOffsetMs,
      speaker: segment.speaker,
      source: segment.source,
      confidence: segment.confidence,
    })));
    if (segmentError) throw requestError("PROCESSING_FAILED", 500);
    const provider = new URL(config.base_url).host;
    const { error: minutesError } = await service.from("meeting_minutes").upsert({
      user_id: userId,
      meeting_id: meetingId,
      summary: result.minutes.summary,
      topics: result.minutes.topics,
      decisions: result.minutes.decisions,
      risks: result.minutes.risks,
      actions: result.minutes.actions,
      provider,
      model: config.chat_model,
      generated_at: new Date().toISOString(),
    });
    if (minutesError) throw requestError("PROCESSING_FAILED", 500);
    await service.from("meeting_intelligence_jobs").upsert({ user_id: userId, meeting_id: meetingId, status: "ready", error_code: null, requested_at: new Date().toISOString(), completed_at: new Date().toISOString() });
    await service.from("meetings").update({ status: "ready" }).eq("user_id", userId).eq("id", meetingId);
    return jsonResponse({ status: "ready" }, 200);
  } catch (error) {
    const failureCode = safeFailureCode(error);
    if (userId && meetingId) {
      await service.from("meeting_intelligence_jobs").upsert({ user_id: userId, meeting_id: meetingId, status: "failed", error_code: failureCode, requested_at: new Date().toISOString(), completed_at: new Date().toISOString() });
      await service.from("meetings").update({ status: "failed" }).eq("user_id", userId).eq("id", meetingId);
    }
    return jsonResponse({ error: statusOf(error) === 500 ? "processing_failed" : failureCode.toLowerCase() }, statusOf(error));
  }
});
