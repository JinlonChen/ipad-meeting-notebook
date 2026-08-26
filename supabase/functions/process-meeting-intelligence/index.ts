import { createClient } from "@supabase/supabase-js";
import { generateMeetingMinutes } from "./intelligence-core.mjs";

const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};
const JSON_HEADERS = { ...CORS_HEADERS, "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };
const ALLOWED_FAILURE_CODES = new Set([
  "AI_CONFIGURATION_REQUIRED",
  "EMPTY_MEETING_CONTENT",
  "MINUTES_FAILED",
  "INVALID_MINUTES_RESPONSE",
  "INVALID_EVIDENCE_POSITION",
  "INVALID_PROCESSING_INPUT",
]);

type Credentials = {
  summary_base_url: string;
  summary_model: string;
  summary_api_key: string;
};

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
  return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 500;
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
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") throw requestError("MINUTES_FAILED", 422);
  const message = (choices[0] as Record<string, unknown>).message;
  if (!message || typeof message !== "object") throw requestError("MINUTES_FAILED", 422);
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string") throw requestError("MINUTES_FAILED", 422);
  return content.replace(/^```json\s*|\s*```$/g, "").trim();
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
    "You are a meeting assistant. Use only the supplied transcript and keyboard notes.",
    "Return JSON only with summary, topics, decisions, risks, actions.",
    "Every topic/decision/risk/action has text and evidencePositions (integer array).",
    "evidencePositions may cite only numbered transcript lines. Facts supported only by keyboard notes must use an empty evidencePositions array.",
    "Every action has text, owner, dueDate, evidencePositions. Use null for unknown owner or dueDate; never guess.",
    "dueDate is YYYY-MM-DD or null. Do not add facts absent from the supplied content.",
  ].join(" ");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
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
    const [{ data: meeting, error: meetingError }, { data: credentials, error: credentialError }, { data: transcript, error: transcriptError }] = await Promise.all([
      service.from("meetings").select("id,note").eq("user_id", userId).eq("id", meetingId).maybeSingle(),
      service.from("ai_provider_credentials").select("summary_base_url,summary_model,summary_api_key").eq("user_id", userId).maybeSingle(),
      service.from("meeting_transcript_segments").select("id,position,speaker,text").eq("user_id", userId).eq("meeting_id", meetingId).order("position"),
    ]);
    if (meetingError || !meeting) throw requestError("MEETING_NOT_FOUND", 404);
    if (credentialError || !credentials) throw requestError("AI_CONFIGURATION_REQUIRED", 422);
    if (transcriptError) throw requestError("PROCESSING_FAILED", 500);

    const requestedAt = new Date().toISOString();
    await service.from("meeting_intelligence_jobs").upsert({ user_id: userId, meeting_id: meetingId, status: "processing", error_code: null, requested_at: requestedAt, completed_at: null });
    await service.from("meetings").update({ status: "processing" }).eq("user_id", userId).eq("id", meetingId);
    const config = credentials as Credentials;
    const minutes = await generateMeetingMinutes({ summaryModel: config.summary_model, transcript: transcript ?? [], note: meeting.note }, {
      summarize: async ({ model, transcript: transcriptText }) => {
        const response = await providerJson(await fetch(endpoint(config.summary_base_url, "chat/completions"), {
          method: "POST",
          headers: { Authorization: `Bearer ${config.summary_api_key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            temperature: 0.1,
            response_format: { type: "json_object" },
            messages: [{ role: "system", content: minutesPrompt() }, { role: "user", content: transcriptText }],
          }),
        }), "MINUTES_FAILED");
        try {
          return JSON.parse(chatContent(response));
        } catch {
          throw requestError("MINUTES_FAILED", 422);
        }
      },
    });

    const completedAt = new Date().toISOString();
    const { error: minutesError } = await service.from("meeting_minutes").upsert({
      user_id: userId,
      meeting_id: meetingId,
      ...minutes,
      provider: new URL(config.summary_base_url).host,
      model: config.summary_model,
      generated_at: completedAt,
    });
    if (minutesError) throw requestError("PROCESSING_FAILED", 500);
    await service.from("meeting_intelligence_jobs").upsert({ user_id: userId, meeting_id: meetingId, status: "ready", error_code: null, requested_at: requestedAt, completed_at: completedAt });
    await service.from("meetings").update({ status: "ready" }).eq("user_id", userId).eq("id", meetingId);
    return jsonResponse({ status: "ready" }, 200);
  } catch (error) {
    const failureCode = safeFailureCode(error);
    if (userId && meetingId) {
      const completedAt = new Date().toISOString();
      await service.from("meeting_intelligence_jobs").upsert({ user_id: userId, meeting_id: meetingId, status: "failed", error_code: failureCode, requested_at: completedAt, completed_at: completedAt });
      await service.from("meetings").update({ status: "failed" }).eq("user_id", userId).eq("id", meetingId);
    }
    return jsonResponse({ error: statusOf(error) === 500 ? "processing_failed" : failureCode.toLowerCase() }, statusOf(error));
  }
});
