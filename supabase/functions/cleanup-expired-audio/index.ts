import { createClient } from "@supabase/supabase-js";
import { cleanupCandidates, determineMoreCandidates } from "./cleanup-core.mjs";

const BATCH_LIMIT = 100;
const MEETING_AUDIO_BUCKET = "meeting-audio";
const POSTGRES_BIGINT_MAX = "9223372036854775807";
const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

type CleanupCandidate = {
  bucket_id: string;
  remote_path: string;
  user_id: string | null;
  meeting_id: string | null;
  sequence: string | null;
  storage_object_id: string | null;
  metadata_exists: boolean;
};

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), { headers: JSON_HEADERS, status });
}

function isCleanupCandidate(value: unknown): value is CleanupCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CleanupCandidate>;

  return candidate.bucket_id === MEETING_AUDIO_BUCKET
    && typeof candidate.remote_path === "string"
    && candidate.remote_path.length > 0
    && !candidate.remote_path.startsWith("/")
    && (candidate.user_id === null || typeof candidate.user_id === "string")
    && (candidate.meeting_id === null || typeof candidate.meeting_id === "string")
    && (candidate.sequence === null || (
      typeof candidate.sequence === "string"
      && /^(0|[1-9][0-9]*)$/.test(candidate.sequence)
      && (
        candidate.sequence.length < POSTGRES_BIGINT_MAX.length
        || (candidate.sequence.length === POSTGRES_BIGINT_MAX.length
          && candidate.sequence <= POSTGRES_BIGINT_MAX)
      )
    ))
    && (candidate.storage_object_id === null || (
      typeof candidate.storage_object_id === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(candidate.storage_object_id)
    ))
    && typeof candidate.metadata_exists === "boolean";
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error(JSON.stringify({ event: "cleanup_configuration_missing" }));
    return jsonResponse({ error: "cleanup_failed" }, 500);
  }

  const authorization = request.headers.get("Authorization");
  if (authorization !== `Bearer ${serviceRoleKey}`) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error: candidateError } = await supabase
      .rpc("get_expired_meeting_audio_cleanup_candidates", { p_limit: BATCH_LIMIT });

    if (candidateError || !Array.isArray(data) || !data.every(isCleanupCandidate)) {
      console.error(JSON.stringify({ event: "cleanup_candidate_query_failed" }));
      return jsonResponse({ error: "cleanup_failed" }, 500);
    }

    const candidates: CleanupCandidate[] = data;
    const result = await cleanupCandidates(candidates, {
      removeObject: async (remotePath: string) => {
        const candidate = { remote_path: remotePath };
        const { error: storageError } = await supabase.storage
          .from(MEETING_AUDIO_BUCKET)
          .remove([candidate.remote_path]);
        if (storageError) throw new Error("storage_delete_failed");
      },
      removeMetadata: async (_bucket: string, remotePath: string) => {
        const candidate = { remote_path: remotePath };
        const { error: metadataError } = await supabase
          .from("meeting_audio_chunks")
          .delete()
          .eq("bucket_id", MEETING_AUDIO_BUCKET)
          .eq("remote_path", candidate.remote_path);
        if (metadataError) throw new Error("metadata_delete_failed");
      },
      log: ({ event, candidate }: { event: string; candidate: CleanupCandidate }) => {
        console.warn(JSON.stringify({
          event,
          userId: candidate.user_id,
          meetingId: candidate.meeting_id,
          sequence: candidate.sequence,
          objectId: candidate.storage_object_id,
        }));
      },
    });

    if (result.failed > 0) {
      console.error(JSON.stringify({
        event: "cleanup_batch_failed",
        scanned: candidates.length,
        deleted: result.deleted,
        metadataDeleted: result.metadataDeleted,
        failed: result.failed,
      }));
      return jsonResponse({ error: "cleanup_failed" }, 500);
    }

    let more: boolean;
    try {
      more = await determineMoreCandidates(candidates.length, BATCH_LIMIT, async () => {
        const { data: probeData, error: probeError } = await supabase
          .rpc("get_expired_meeting_audio_cleanup_candidates", { p_limit: 1 });
        if (probeError || !Array.isArray(probeData) || !probeData.every(isCleanupCandidate)) {
          throw new Error("cleanup_more_probe_failed");
        }
        return probeData.length > 0;
      });
    } catch {
      console.error(JSON.stringify({
        event: "cleanup_more_probe_failed",
        scanned: candidates.length,
        deleted: result.deleted,
        metadataDeleted: result.metadataDeleted,
      }));
      return jsonResponse({ error: "cleanup_failed" }, 500);
    }

    const response = {
      scanned: candidates.length,
      deleted: result.deleted,
      metadataDeleted: result.metadataDeleted,
      more,
    };
    console.info(JSON.stringify({ event: "cleanup_batch_completed", ...response }));
    return jsonResponse(response, 200);
  } catch {
    console.error(JSON.stringify({ event: "cleanup_unexpected_failure" }));
    return jsonResponse({ error: "cleanup_failed" }, 500);
  }
});
