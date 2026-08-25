import { createClient } from "@supabase/supabase-js";

const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};
const JSON_HEADERS = { ...CORS_HEADERS, "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };
const REALTIME_BASE_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const REALTIME_MODEL = "qwen3-asr-flash-realtime";

function response(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), { headers: JSON_HEADERS, status });
}

function requiredText(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= limit ? value.trim() : null;
}

function validBaseUrl(value: unknown): string | null {
  const text = requiredText(value, 1_000);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authorization = request.headers.get("Authorization");
  if (!supabaseUrl || !serviceRoleKey || !anonKey) return response({ error: "configuration_failed" }, 500);
  if (!authorization?.startsWith("Bearer ")) return response({ error: "auth_required" }, 401);

  const auth = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error: authError } = await auth.auth.getUser(authorization.slice("Bearer ".length));
  if (authError || !data.user) return response({ error: "auth_required" }, 401);

  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return response({ error: "invalid_request" }, 400);
  const input = body as Record<string, unknown>;
  const transcriptionApiKey = requiredText(input.transcriptionApiKey, 4_096);
  const summaryBaseUrl = validBaseUrl(input.summaryBaseUrl);
  const summaryModel = requiredText(input.summaryModel, 200);
  const summaryApiKey = requiredText(input.summaryApiKey, 4_096);
  if (!transcriptionApiKey || !summaryBaseUrl || !summaryModel || !summaryApiKey) return response({ error: "invalid_request" }, 400);

  const service = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await service.from("ai_provider_credentials").upsert({
    user_id: data.user.id,
    transcription_base_url: REALTIME_BASE_URL,
    transcription_model: REALTIME_MODEL,
    transcription_api_key: transcriptionApiKey,
    summary_base_url: summaryBaseUrl,
    summary_model: summaryModel,
    summary_api_key: summaryApiKey,
    updated_at: new Date().toISOString(),
  });
  if (error) return response({ error: "configuration_failed" }, 500);
  return response({ configured: true }, 200);
});
