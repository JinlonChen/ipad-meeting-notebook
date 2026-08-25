import { MinutesSchema, TranscriptSegmentSchema } from "@meeting/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../supabase/types.js";
import type { MeetingIntelligencePort, MeetingIntelligenceSnapshot } from "./MeetingIntelligencePanel.js";
import { BrowserRealtimeTranscriptionSession, type RealtimeTranscriptionUpdate } from "../transcription/browser-session.js";

export const ALIBABA_REALTIME_BASE_URL = "wss://llm-gctiyfgr4e625ujt.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime";
export const ALIBABA_REALTIME_MODEL = "qwen3-asr-flash-realtime";

export type AiProviderConfiguration = {
  transcriptionBaseUrl: string;
  transcriptionModel: string;
  transcriptionApiKey: string;
  summaryBaseUrl: string;
  summaryModel: string;
  summaryApiKey: string;
};

function failed(): Error { return new Error("INTELLIGENCE_REQUEST_FAILED"); }

export class SupabaseMeetingIntelligenceApi implements MeetingIntelligencePort {
  constructor(private readonly client: SupabaseClient<Database>, private readonly supabaseUrl: string) {}

  async configured(): Promise<boolean> {
    const { data, error } = await this.client.rpc("ai_provider_configured", {});
    if (error || typeof data !== "boolean") throw failed();
    return data;
  }

  async configure(input: AiProviderConfiguration): Promise<void> {
    const { error } = await this.client.functions.invoke("configure-meeting-ai-v3", { body: input });
    if (error) throw failed();
  }

  async summarize(meetingId: string): Promise<void> {
    const { error } = await this.client.functions.invoke("process-meeting-intelligence-v3", { body: { meetingId } });
    if (error) throw failed();
  }

  createRealtimeSession(meetingId: string, onUpdate: (update: RealtimeTranscriptionUpdate) => void): BrowserRealtimeTranscriptionSession {
    return new BrowserRealtimeTranscriptionSession({
      supabaseUrl: this.supabaseUrl,
      meetingId,
      accessToken: async () => {
        const { data, error } = await this.client.auth.getSession();
        return error ? null : data.session?.access_token ?? null;
      },
      onUpdate,
    });
  }

  async read(meetingId: string): Promise<MeetingIntelligenceSnapshot> {
    const [jobResult, segmentsResult, minutesResult] = await Promise.all([
      this.client.from("meeting_intelligence_jobs").select("status,error_code").eq("meeting_id", meetingId).maybeSingle(),
      this.client.from("meeting_transcript_segments").select("id,meeting_id,position,text,started_offset_ms,ended_offset_ms,speaker,source,confidence").eq("meeting_id", meetingId).order("position"),
      this.client.from("meeting_minutes").select("summary,topics,decisions,risks,actions").eq("meeting_id", meetingId).maybeSingle(),
    ]);
    if (jobResult.error || segmentsResult.error || minutesResult.error) throw failed();
    return {
      job: jobResult.data ? { status: jobResult.data.status, errorCode: jobResult.data.error_code } : null,
      transcript: (segmentsResult.data ?? []).map((row) => TranscriptSegmentSchema.parse({
        id: row.id, meetingId: row.meeting_id, position: row.position, text: row.text,
        startedOffsetMs: row.started_offset_ms, endedOffsetMs: row.ended_offset_ms,
        speaker: row.speaker, source: row.source, confidence: row.confidence,
      })),
      minutes: minutesResult.data ? MinutesSchema.parse(minutesResult.data) : null,
    };
  }
}

export function createSupabaseMeetingIntelligenceApi(client: SupabaseClient<Database>, supabaseUrl: string): SupabaseMeetingIntelligenceApi {
  return new SupabaseMeetingIntelligenceApi(client, supabaseUrl);
}
