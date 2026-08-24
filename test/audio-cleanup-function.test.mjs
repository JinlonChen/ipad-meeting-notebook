import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(resolve(root, relativePath), "utf8");
}

function normalizedSql(source) {
  return source.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
}

async function loadCleanupCore() {
  return import("../supabase/functions/cleanup-expired-audio/cleanup-core.mjs");
}

const expiredMetadata = {
  bucket_id: "meeting-audio",
  remote_path: "user/meeting/0.webm",
  user_id: "user",
  meeting_id: "meeting",
  sequence: "0",
  metadata_exists: true,
};

test("cleanup orchestration removes each object before its metadata", async () => {
  const { cleanupCandidates } = await loadCleanupCore();
  const calls = [];

  const result = await cleanupCandidates(
    [expiredMetadata, { ...expiredMetadata, remote_path: "user/meeting/orphan.bin", metadata_exists: false }],
    {
      removeObject: async (path) => calls.push(["object", path]),
      removeMetadata: async (_bucket, path) => calls.push(["metadata", path]),
      log: () => {},
    },
  );

  assert.deepEqual(calls, [
    ["object", "user/meeting/0.webm"],
    ["metadata", "user/meeting/0.webm"],
    ["object", "user/meeting/orphan.bin"],
  ]);
  assert.deepEqual(result, { deleted: 2, metadataDeleted: 1, failed: 0 });
});

test("cleanup orchestration skips metadata after storage failure and safely retries metadata failure", async () => {
  const { cleanupCandidates } = await loadCleanupCore();
  const metadataCalls = [];
  let storageAttempt = 0;
  let metadataAttempt = 0;
  const ports = {
    removeObject: async () => {
      storageAttempt += 1;
      if (storageAttempt === 1) throw new Error("storage unavailable");
      // A missing object on retry is represented by a successful idempotent remove.
    },
    removeMetadata: async (_bucket, path) => {
      metadataCalls.push(path);
      metadataAttempt += 1;
      if (metadataAttempt === 1) throw new Error("metadata unavailable");
    },
    log: () => {},
  };

  assert.deepEqual(await cleanupCandidates([expiredMetadata], ports), {
    deleted: 0,
    metadataDeleted: 0,
    failed: 1,
  });
  assert.deepEqual(metadataCalls, []);

  assert.deepEqual(await cleanupCandidates([expiredMetadata], ports), {
    deleted: 1,
    metadataDeleted: 0,
    failed: 1,
  });
  assert.deepEqual(await cleanupCandidates([expiredMetadata], ports), {
    deleted: 1,
    metadataDeleted: 1,
    failed: 0,
  });
});

test("cleanup probes for more work only after a full batch", async () => {
  const { determineMoreCandidates } = await loadCleanupCore();
  let probes = 0;
  const probe = async () => {
    probes += 1;
    return true;
  };

  assert.equal(await determineMoreCandidates(99, 100, probe), false);
  assert.equal(probes, 0);
  assert.equal(await determineMoreCandidates(100, 100, probe), true);
  assert.equal(probes, 1);
  assert.equal(await determineMoreCandidates(100, 100, async () => false), false);
  await assert.rejects(
    determineMoreCandidates(100, 100, async () => {
      throw new Error("probe failed");
    }),
    /probe failed/,
  );
});

test("cleanup function is a JWT-verified POST-only service-role endpoint", async () => {
  const [source, config] = await Promise.all([
    read("supabase/functions/cleanup-expired-audio/index.ts"),
    read("supabase/config.toml"),
  ]);

  assert.match(config, /\[functions\.cleanup-expired-audio\]\s+verify_jwt\s*=\s*true/);
  assert.match(source, /Deno\.env\.get\("SUPABASE_URL"\)/);
  assert.match(source, /Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)/);
  assert.match(source, /request\.method\s*!==\s*"POST"/);
  assert.match(source, /request\.headers\.get\("Authorization"\)/);
  assert.match(source, /authorization\s*!==\s*`Bearer \$\{serviceRoleKey\}`/);
  assert.doesNotMatch(source, /VITE_/);
});

test("cleanup uses a hard bounded RPC candidate batch with orphan coverage", async () => {
  const [source, migration] = await Promise.all([
    read("supabase/functions/cleanup-expired-audio/index.ts"),
    read("supabase/migrations/202608240002_audio_cleanup.sql"),
  ]);
  const sql = normalizedSql(migration);

  assert.match(source, /const BATCH_LIMIT = 100/);
  assert.match(source, /\.rpc\("get_expired_meeting_audio_cleanup_candidates",\s*\{\s*p_limit:\s*BATCH_LIMIT\s*\}\)/s);
  assert.match(sql, /create or replace function public\.get_expired_meeting_audio_cleanup_candidates\( p_limit integer default 100, p_now timestamp with time zone default now\(\) \)/);
  assert.match(sql, /least\(greatest\(p_limit, 1\), 100\)/);
  assert.match(sql, /from public\.meeting_audio_chunks/);
  assert.match(sql, /expires_at <= p_now/);
  assert.match(sql, /from storage\.objects/);
  assert.match(sql, /left join public\.meeting_audio_chunks/);
  assert.match(sql, /created_at <= p_now - interval '48 hours'/);
  assert.match(sql, /objects\.created_at \+ interval '48 hours' as eligible_at/);
  assert.match(sql, /bucket_id = 'meeting-audio'/);
  assert.match(sql, /order by eligible_at, remote_path/);
});

test("cleanup exposes a storage object identifier without logging its path", async () => {
  const [source, core, migration] = await Promise.all([
    read("supabase/functions/cleanup-expired-audio/index.ts"),
    read("supabase/functions/cleanup-expired-audio/cleanup-core.mjs"),
    read("supabase/migrations/202608240002_audio_cleanup.sql"),
  ]);
  const sql = normalizedSql(migration);

  assert.match(sql, /storage_object_id text,/);
  assert.match(sql, /objects\.id::text as storage_object_id/);
  assert.match(source, /storage_object_id: string \| null/);
  assert.match(source, /typeof candidate\.storage_object_id === "string"/);
  assert.match(source, /objectId: candidate\.storage_object_id/);
  assert.doesNotMatch(source, /pathId:/);
  assert.match(core, /@property \{string \| null\} storage_object_id/);
});

test("cleanup preserves the full PostgreSQL bigint sequence as decimal text", async () => {
  const [source, core, migration] = await Promise.all([
    read("supabase/functions/cleanup-expired-audio/index.ts"),
    read("supabase/functions/cleanup-expired-audio/cleanup-core.mjs"),
    read("supabase/migrations/202608240002_audio_cleanup.sql"),
  ]);
  const sql = normalizedSql(migration);

  assert.match(sql, /sequence text,/);
  assert.match(sql, /chunks\.sequence::text as sequence/);
  assert.match(sql, /null::text as sequence/);
  assert.match(source, /sequence: string \| null/);
  assert.match(source, /typeof candidate\.sequence === "string"/);
  assert.match(source, /\^\(0\|\[1-9\]\[0-9\]\*\)\$/);
  assert.doesNotMatch(source, /Number\.isSafeInteger/);
  assert.match(core, /@property \{string \| null\} sequence/);
});

test("cleanup removes storage before metadata and remains retry-safe", async () => {
  const source = await read("supabase/functions/cleanup-expired-audio/index.ts");
  const removeObject = source.indexOf(".remove([candidate.remote_path])");
  const deleteMetadata = source.indexOf('.from("meeting_audio_chunks")', removeObject);

  assert.ok(removeObject >= 0, "official Storage remove API must delete each object");
  assert.ok(deleteMetadata > removeObject, "Storage and metadata adapters must retain the cleanup order");
  assert.match(source.slice(deleteMetadata), /\.delete\(\)[\s\S]+\.eq\("bucket_id", MEETING_AUDIO_BUCKET\)[\s\S]+\.eq\("remote_path", candidate\.remote_path\)/);
});

test("cleanup reports an accurate more flag with a bounded one-row probe", async () => {
  const [source, core] = await Promise.all([
    read("supabase/functions/cleanup-expired-audio/index.ts"),
    read("supabase/functions/cleanup-expired-audio/cleanup-core.mjs"),
  ]);

  assert.match(core, /if \(scanned < batchLimit\) return false/);
  assert.match(source, /\.rpc\("get_expired_meeting_audio_cleanup_candidates",\s*\{\s*p_limit:\s*1\s*\}\)/s);
  assert.match(source, /cleanup_more_probe_failed/);
  assert.match(source, /return jsonResponse\(\{ error: "cleanup_failed" \}, 500\)/);
  assert.doesNotMatch(source, /p_limit:\s*101/);
});

test("cleanup migration is service-role-only and never SQL-deletes Storage or durable content", async () => {
  const migration = normalizedSql(await read("supabase/migrations/202608240002_audio_cleanup.sql"));

  assert.match(migration, /security definer set search_path = ''/);
  assert.match(migration, /revoke all on function public\.get_expired_meeting_audio_cleanup_candidates\(integer, timestamp with time zone\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.get_expired_meeting_audio_cleanup_candidates\(integer, timestamp with time zone\) to service_role/);
  assert.doesNotMatch(migration, /delete from storage\.objects/);
  assert.doesNotMatch(migration, /(?:delete from|update) public\.(?:meetings|notes|transcripts|summaries)/);
});

test("cleanup responses and structured logs expose counts and identifiers, not secrets or content", async () => {
  const source = await read("supabase/functions/cleanup-expired-audio/index.ts");

  assert.match(source, /scanned/);
  assert.match(source, /deleted/);
  assert.match(source, /more/);
  assert.match(source, /JSON\.stringify\(\{[\s\S]+event:[\s\S]+userId:[\s\S]+meetingId:[\s\S]+sequence:/);
  assert.doesNotMatch(source, /pathId:/);
  assert.doesNotMatch(
    source,
    /console\.(?:log|info|warn|error)\(JSON\.stringify\(\{(?:(?!\}\)\);)[\s\S])*candidate\.remote_path/,
  );
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)\([^\n]*(?:serviceRoleKey|authorization|sha256|note|audioData|content)/i);
  assert.doesNotMatch(source, /error\.message/);
  assert.doesNotMatch(source, /JSON\.stringify\(error\)/);
});

test("cleanup function dependencies are pinned for repeatable Edge deployment", async () => {
  const denoConfig = JSON.parse(await read("supabase/functions/cleanup-expired-audio/deno.json"));

  assert.match(denoConfig.imports["@supabase/supabase-js"], /^npm:@supabase\/supabase-js@\d+\.\d+\.\d+$/);
});
