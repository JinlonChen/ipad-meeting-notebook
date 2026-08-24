import { createClient } from "@supabase/supabase-js";

const JSON_HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };

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
  const baseUrl = validBaseUrl(input.baseUrl);
  const asrModel = requiredText(input.asrModel, 200);
  const chatModel = requiredText(input.chatModel, 200);
  const apiKey = requiredText(input.apiKey, 4_096);
  if (!baseUrl || !asrModel || !chatModel || !apiKey) return response({ error: "invalid_request" }, 400);

  const service = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await service.from("ai_provider_credentials").upsert({
    user_id: data.user.id,
    base_url: baseUrl,
    asr_model: asrModel,
    chat_model: chatModel,
    api_key: apiKey,
    updated_at: new Date().toISOString(),
  });
  if (error) return response({ error: "configuration_failed" }, 500);
  return response({ configured: true }, 200);
});
