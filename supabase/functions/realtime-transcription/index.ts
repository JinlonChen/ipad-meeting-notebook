import { createClient } from "@supabase/supabase-js";
import {
  audioAppendEvent,
  finishEvent,
  parseAlibabaEvent,
  sessionUpdateEvent,
  stableSegmentId,
} from "./realtime-core.mjs";

const ALIBABA_ENDPOINT = "wss://llm-gctiyfgr4e625ujt.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime";
const JSON_HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), { headers: JSON_HEADERS, status });
}

function send(socket: WebSocket, body: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
}

async function bytes(value: unknown): Promise<Uint8Array | null> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return null;
}

Deno.serve(async (request) => {
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "websocket_required" }, 426);
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRoleKey || !anonKey) return json({ error: "configuration_failed" }, 500);

  const url = new URL(request.url);
  const meetingId = url.searchParams.get("meetingId")?.trim() ?? "";
  const accessToken = url.searchParams.get("access_token")?.trim() ?? "";
  if (!meetingId || !accessToken) return json({ error: "auth_required" }, 401);

  const auth = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: authData, error: authError } = await auth.auth.getUser(accessToken);
  if (authError || !authData.user) return json({ error: "auth_required" }, 401);
  const userId = authData.user.id;
  const service = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const [{ data: meeting, error: meetingError }, { data: credentials, error: credentialError }, { data: latest, error: latestError }] = await Promise.all([
    service.from("meetings").select("id").eq("user_id", userId).eq("id", meetingId).maybeSingle(),
    service.from("ai_provider_credentials").select("transcription_api_key").eq("user_id", userId).maybeSingle(),
    service.from("meeting_transcript_segments").select("position,ended_offset_ms").eq("user_id", userId).eq("meeting_id", meetingId).order("position", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (meetingError || !meeting) return json({ error: "meeting_not_found" }, 404);
  if (credentialError || !credentials?.transcription_api_key) return json({ error: "ai_configuration_required" }, 422);
  if (latestError) return json({ error: "transcript_unavailable" }, 500);

  const { socket: browser, response } = Deno.upgradeWebSocket(request);
  let provider: WebSocket | null = null;
  let closing = false;
  let position = (latest?.position ?? -1) + 1;
  let lastEndedOffset = Number(latest?.ended_offset_ms ?? 0);
  const connectedAt = Date.now() - lastEndedOffset;
  let finalWrites: Promise<void> = Promise.resolve();

  const closeProvider = () => {
    if (!provider || provider.readyState >= WebSocket.CLOSING) return;
    if (provider.readyState === WebSocket.OPEN) provider.send(JSON.stringify(finishEvent(crypto.randomUUID())));
    setTimeout(() => {
      if (provider && provider.readyState < WebSocket.CLOSING) provider.close(1000, "relay-closed");
    }, 2_000);
  };

  browser.onopen = () => {
    provider = new WebSocket(ALIBABA_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${credentials.transcription_api_key}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });
    provider.onopen = () => provider?.send(JSON.stringify(sessionUpdateEvent(crypto.randomUUID())));
    provider.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const parsed = parseAlibabaEvent(event.data);
      if (!parsed) return;
      if (parsed.kind === "ready") {
        send(browser, { type: "ready" });
      } else if (parsed.kind === "partial") {
        send(browser, { type: "partial", text: parsed.text });
      } else if (parsed.kind === "final") {
        finalWrites = finalWrites.then(async () => {
          const sourceId = parsed.sourceId || crypto.randomUUID();
          const id = await stableSegmentId(userId, meetingId, sourceId);
          const { data: existing } = await service.from("meeting_transcript_segments")
            .select("id,position,text,started_offset_ms,ended_offset_ms,speaker,source,confidence")
            .eq("user_id", userId).eq("id", id).maybeSingle();
          if (existing) {
            send(browser, { type: "final", segment: {
              id: existing.id, meetingId, position: existing.position, text: existing.text,
              startedOffsetMs: Number(existing.started_offset_ms), endedOffsetMs: Number(existing.ended_offset_ms),
              speaker: existing.speaker, source: existing.source, confidence: existing.confidence,
            } });
            return;
          }
          const endedOffsetMs = Math.max(lastEndedOffset + 1, Date.now() - connectedAt);
          const row = {
            user_id: userId,
            id,
            meeting_id: meetingId,
            position,
            text: parsed.text,
            started_offset_ms: lastEndedOffset,
            ended_offset_ms: endedOffsetMs,
            speaker: null,
            source: "asr",
            confidence: null,
          };
          const { error } = await service.from("meeting_transcript_segments").insert(row);
          if (error) {
            send(browser, { type: "error", message: "TRANSCRIPT_SAVE_FAILED" });
            return;
          }
          position += 1;
          lastEndedOffset = endedOffsetMs;
          send(browser, { type: "final", segment: {
            id, meetingId, position: row.position, text: row.text,
            startedOffsetMs: row.started_offset_ms, endedOffsetMs: row.ended_offset_ms,
            speaker: null, source: "asr", confidence: null,
          } });
        }).catch(() => send(browser, { type: "error", message: "TRANSCRIPT_SAVE_FAILED" }));
      } else if (parsed.kind === "error") {
        send(browser, { type: "error", message: "PROVIDER_ERROR" });
      } else if (parsed.kind === "finished") {
        provider?.close(1000, "asr-finished");
      }
    };
    provider.onerror = () => send(browser, { type: "error", message: "PROVIDER_CONNECTION_FAILED" });
    provider.onclose = () => {
      if (!closing && browser.readyState < WebSocket.CLOSING) browser.close(1011, "transcription-ended");
    };
  };

  browser.onmessage = (event) => {
    void (async () => {
      const audio = await bytes(event.data);
      if (!audio?.byteLength || !provider || provider.readyState !== WebSocket.OPEN) return;
      provider.send(JSON.stringify(audioAppendEvent(audio, crypto.randomUUID())));
    })();
  };
  browser.onerror = () => closeProvider();
  browser.onclose = () => {
    closing = true;
    closeProvider();
  };
  return response;
});
