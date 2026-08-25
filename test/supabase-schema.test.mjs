import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = resolve(root, "supabase/migrations/202608220001_meeting_catalog.sql");
const noteMigrationPath = resolve(root, "supabase/migrations/202608230002_meeting_notes.sql");
const audioMigrationPath = resolve(root, "supabase/migrations/202608240001_meeting_audio.sql");
const intelligenceMigrationPath = resolve(root, "supabase/migrations/202608240003_meeting_intelligence.sql");
const splitIntelligenceMigrationPath = resolve(root, "supabase/migrations/202608240004_split_ai_provider_credentials.sql");
const realtimeAsrMigrationPath = resolve(root, "supabase/migrations/202608250001_realtime_asr_config.sql");
const catalogTestPath = resolve(root, "supabase/tests/meeting_catalog.sql");
const audioTestPath = resolve(root, "supabase/tests/meeting_audio.sql");

let sql;
let noteSql;
let audioSql;
let intelligenceSql;
let splitIntelligenceSql;
let realtimeAsrSql;
let catalogTestSql;
let audioTestSql;
test.before(async () => {
  sql = await readFile(migrationPath, "utf8");
  noteSql = await readFile(noteMigrationPath, "utf8");
  audioSql = await readFile(audioMigrationPath, "utf8");
  intelligenceSql = await readFile(intelligenceMigrationPath, "utf8");
  splitIntelligenceSql = await readFile(splitIntelligenceMigrationPath, "utf8");
  realtimeAsrSql = await readFile(realtimeAsrMigrationPath, "utf8");
  catalogTestSql = await readFile(catalogTestPath, "utf8");
  audioTestSql = await readFile(audioTestPath, "utf8");
});

function normalizedSql() {
  return sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
}

function normalizedNoteSql() {
  return noteSql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
}

function normalizedCatalogTestSql() {
  return catalogTestSql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
}

function normalizedAudioSql() {
  return audioSql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
}

function normalizedAudioTestSql() {
  return audioTestSql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
}

function normalizedIntelligenceSql() {
  return intelligenceSql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
}

test("catalog tables enable row level security", () => {
  const source = normalizedSql();
  for (const table of ["folders", "meetings", "catalog_mutation_replays"]) {
    assert.match(source, new RegExp(`alter table public\\.${table} enable row level security`));
  }
});

test("catalog rows are owned by auth.uid and direct authenticated mutations are denied", () => {
  const source = normalizedSql();
  for (const table of ["folders", "meetings"]) {
    assert.match(source, new RegExp(`create policy [^;]+ on public\\.${table} for select using \\(auth\\.uid\\(\\) = user_id\\)`));
    assert.match(source, new RegExp(`revoke (all|insert|update|delete) on public\\.${table} from authenticated`));
    assert.match(source, new RegExp(`revoke (all|insert|update|delete) on public\\.${table} from anon`));
  }
});

test("mutation rpc is locked to authenticated users and fixes search_path", () => {
  const source = normalizedSql();
  assert.match(source, /create or replace function public\.apply_catalog_mutation\(/);
  assert.match(source, /p_expected_user_id uuid/);
  assert.match(source, /if v_user_id is distinct from p_expected_user_id then return jsonb_build_object\('status', 401, 'code', 'auth_context_changed'\)/);
  assert.match(source, /security definer/);
  assert.match(source, /set search_path = pg_catalog, public/);
  assert.match(source, /revoke all on function public\.apply_catalog_mutation\(/);
  assert.match(source, /grant execute on function public\.apply_catalog_mutation\([^;]+\) to authenticated/);
  assert.match(source, /revoke execute on function public\.apply_catalog_mutation\([^;]+\) from (?:anon|public, anon)/);
  assert.match(source, /revoke execute on function public\.apply_catalog_mutation\([^;]+\) from (?:public|public, anon)/);
});

test("migration defines composite ownership keys and all catalog operation kinds", () => {
  const source = normalizedSql();
  assert.match(source, /primary key \(user_id, id\)/);
  assert.match(source, /foreign key \(user_id, folder_id\) references public\.folders\(user_id, id\)/);
  for (const kind of ["meeting.create", "meeting.rename", "meeting.trash", "meeting.restore", "folder.create", "folder.rename", "folder.remove"]) {
    assert.match(source, new RegExp(`'${kind.replace(".", "\\.")}'`));
  }
});

test("meetings retain the pre-trash status and wrapper can call a private implementation", () => {
  const source = normalizedSql();
  assert.match(source, /status_before_trash text/);
  assert.match(source, /create or replace function public\._apply_catalog_mutation_impl\(/);
  assert.match(source, /create or replace function public\.apply_catalog_mutation\([\s\S]+security definer/);
  assert.match(source, /revoke all on function public\._apply_catalog_mutation_impl\([^;]+\) from public, anon, authenticated/);
});

test("conditional mutations compare sync_version in their atomic DML", () => {
  const source = normalizedSql();
  assert.match(source, /update public\.meetings set title[^;]+where user_id = v_user_id and id = p_entity_id and \(v_expected is null or sync_version = v_expected\)/);
  assert.match(source, /update public\.meetings set status = 'trashed'[^;]+where user_id = v_user_id and id = p_entity_id and status <> 'trashed' and \(v_expected is null or sync_version = v_expected\)/);
  assert.match(source, /update public\.meetings set status = coalesce\(status_before_trash, 'draft'\)[^;]+where user_id = v_user_id and id = p_entity_id and status = 'trashed' and \(v_expected is null or sync_version = v_expected\)/);
  assert.match(source, /delete from public\.folders where user_id = v_user_id and id = p_entity_id and \(v_expected is null or sync_version = v_expected\)/);
  assert.match(source, /when unique_violation/);
  assert.match(source, /when foreign_key_violation/);
});

test("snapshot and conditional payloads authenticate their exact shape", () => {
  const source = normalizedSql();
  assert.match(source, /create or replace function public\.get_catalog_snapshot\(p_expected_user_id uuid\)/);
  assert.match(source, /returns jsonb language sql stable security definer/);
  assert.match(source, /select case when auth\.uid\(\) is null then jsonb_build_object[^;]+else jsonb_build_object\( 'status', 200, 'folders', \( select[^;]+'meetings', \( select[^;]+end/);
  assert.match(source, /if v_user_id is distinct from p_expected_user_id then return jsonb_build_object\('status', 401, 'code', 'auth_context_changed'\)/);
  assert.match(source, /grant execute on function public\.get_catalog_snapshot\(uuid\) to authenticated/);
  assert.match(source, /jsonb_typeof\(v_payload->'expectedsyncversion'\) <> 'number'/);
  assert.match(source, /v_payload->>'expectedsyncversion' !~ '\^\[0-9\]\+\$'/);
  assert.match(source, /if p_payload is null or jsonb_typeof\(p_payload\) <> 'object' then v_response := jsonb_build_object\('status', 400, 'code', 'invalid_request'\)/);
});

test("meeting note migration adds a bounded column and dedicated conditional RPC", () => {
  const source = normalizedNoteSql();
  assert.match(source, /alter table public\.meetings add column note text not null default '' check \(char_length\(note\) <= 200000\)/);
  assert.match(source, /create or replace function public\.apply_meeting_note_mutation\( p_operation_id uuid, p_entity_id uuid, p_note text, p_updated_at timestamptz, p_expected_sync_version bigint, p_expected_user_id uuid \) returns jsonb language plpgsql security definer set search_path = pg_catalog, public/);
  assert.match(source, /if v_user_id is null then return jsonb_build_object\('status', 401, 'code', 'auth_required'\)/);
  assert.match(source, /if v_user_id is distinct from p_expected_user_id then return jsonb_build_object\('status', 401, 'code', 'auth_context_changed'\)/);
  assert.match(source, /char_length\(p_note\) > 200000/);
  assert.match(source, /pg_advisory_xact_lock\(hashtextextended\(v_user_id::text \|\| ':' \|\| p_operation_id::text, 0\)\)/);
  assert.match(source, /pg_advisory_xact_lock\(hashtextextended\(v_user_id::text \|\| ':entity:' \|\| p_entity_id::text, 0\)\)/);
  assert.match(source, /operation_kind = 'meeting\.note'/);
  assert.match(source, /set note = p_note, updated_at = p_updated_at, sync_version = sync_version \+ 1/);
  assert.match(source, /where user_id = v_user_id and id = p_entity_id and sync_version = p_expected_sync_version/);
  assert.match(source, /revoke all on function public\.apply_meeting_note_mutation\([^;]+\) from public, anon/);
  assert.match(source, /grant execute on function public\.apply_meeting_note_mutation\([^;]+\) to authenticated/);
});

test("database note contracts exercise anon permissions and the column check directly", () => {
  const source = normalizedCatalogTestSql();
  assert.match(source, /set local role anon[^;]*; select is\(has_function_privilege\('anon', 'public\.apply_meeting_note_mutation\([^']+\)', 'execute'\), false/);
  const anonRole = source.indexOf("set local role anon");
  const deniedCall = source.indexOf("select throws_ok( $$select public.apply_meeting_note_mutation", anonRole);
  const resetRole = source.indexOf("reset role", anonRole);
  assert.ok(anonRole >= 0 && deniedCall > anonRole && resetRole > deniedCall, "anon RPC denial must run before resetting the role");
  assert.match(source.slice(deniedCall, resetRole), /42501[^;]+permission denied for function apply_meeting_note_mutation/);
  assert.match(source, /reset role[^;]*; select lives_ok\([^;]+update public\.meetings set note = repeat\('[^']+', 200000\)/);
  assert.match(source, /select throws_ok\([^;]+update public\.meetings set note = repeat\('[^']+', 200001\)[^;]+23514/);
  assert.match(source, /set local role authenticated/);
});

test("meeting audio uses a private bounded bucket and user-owned metadata", () => {
  const source = normalizedAudioSql();
  assert.match(source, /insert into storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)[^;]+values \( 'meeting-audio', 'meeting-audio', false, 104857600/);
  assert.match(source, /create table public\.meeting_audio_chunks/);
  assert.match(source, /primary key \(user_id, meeting_id, sequence\)/);
  assert.match(source, /foreign key \(user_id, meeting_id\) references public\.meetings\(user_id, id\) on delete cascade/);
  assert.match(source, /unique \(bucket_id, remote_path\)/);
  assert.match(source, /alter table public\.meeting_audio_chunks enable row level security/);
  assert.match(source, /revoke all on public\.meeting_audio_chunks from (?:anon|public, anon)/);
});

test("meeting audio retention is bounded by server time and insert grants exclude server columns", () => {
  const source = normalizedAudioSql();
  assert.match(source, /constraint meeting_audio_chunks_expires_within_retention check \(expires_at <= created_at \+ interval '48 hours'\)/);
  assert.match(source, /revoke insert, update, delete on public\.meeting_audio_chunks from authenticated/);
  assert.match(source, /grant insert \( user_id, meeting_id, sequence, remote_path, sha256, size_bytes, mime_type, captured_at, expires_at \) on public\.meeting_audio_chunks to authenticated/);
  assert.doesNotMatch(source, /grant select, insert on public\.meeting_audio_chunks to authenticated/);
});

test("meeting audio policies isolate metadata and storage object paths", () => {
  const source = normalizedAudioSql();
  assert.match(source, /create policy meeting_audio_chunks_owner_select on public\.meeting_audio_chunks for select to authenticated using \(auth\.uid\(\) = user_id\)/);
  assert.match(source, /create policy meeting_audio_chunks_owner_insert on public\.meeting_audio_chunks for insert to authenticated with check \( auth\.uid\(\) = user_id/);
  assert.match(source, /create policy meeting_audio_objects_owner_select on storage\.objects for select to authenticated using \( bucket_id = 'meeting-audio'/);
  assert.match(source, /create policy meeting_audio_objects_owner_insert on storage\.objects for insert to authenticated with check \( bucket_id = 'meeting-audio'/);
  assert.match(source, /\(storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/);
  assert.doesNotMatch(source, /create policy [^;]+ on storage\.objects for update/);
});

test("meeting audio pgTAP covers privacy, ownership, uniqueness, and anon denial", () => {
  const source = normalizedAudioTestSql();
  assert.match(source, /select is\(\(select public from storage\.buckets where id = 'meeting-audio'\), false/);
  assert.match(source, /set local role anon/);
  assert.match(source, /has_table_privilege\('anon', 'public\.meeting_audio_chunks', 'select'\), false/);
  assert.match(source, /set local role authenticated/);
  assert.match(source, /second user cannot read first user audio metadata/);
  assert.match(source, /duplicate meeting sequence is rejected/);
  assert.match(source, /now\(\) \+ interval '49 hours'[^;]+23514[^;]+owner cannot extend audio metadata expiry beyond 48 hours/);
  assert.match(source, /expires_at, created_at[^;]+now\(\) \+ interval '10 years'[^;]+42501[^;]+owner cannot forge metadata creation time/);
});

test("meeting intelligence stores generated results by meeting owner", () => {
  const source = normalizedIntelligenceSql();
  for (const table of ["meeting_transcript_segments", "meeting_minutes", "meeting_intelligence_jobs"]) {
    assert.match(source, new RegExp(`create table public\\.${table}`));
    assert.match(source, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(source, new RegExp(`create policy ${table}_owner_select on public\\.${table} for select to authenticated using \\(auth\\.uid\\(\\) = user_id\\)`));
    assert.match(source, new RegExp(`revoke all on public\\.${table} from public, anon`));
    assert.match(source, new RegExp(`revoke (all|insert, update, delete) on public\\.${table} from authenticated`));
  }
  assert.match(source, /unique \(user_id, meeting_id, position\)/);
  assert.match(source, /check \(ended_offset_ms > started_offset_ms\)/);
});

test("AI provider keys are write-only to the client and configured state is a boolean RPC", () => {
  const source = `${normalizedIntelligenceSql()} ${splitIntelligenceSql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase()}`;
  assert.match(source, /create table public\.ai_provider_credentials/);
  for (const column of ["transcription_base_url", "transcription_model", "transcription_api_key", "summary_base_url", "summary_model", "summary_api_key"]) {
    assert.match(source, new RegExp(`\\b${column}\\b`));
  }
  assert.match(source, /alter table public\.ai_provider_credentials enable row level security/);
  assert.match(source, /revoke all on public\.ai_provider_credentials from public, anon, authenticated/);
  assert.doesNotMatch(source, /create policy [^;]+ on public\.ai_provider_credentials for select to authenticated/);
  assert.match(source, /create or replace function public\.ai_provider_configured\(\) returns boolean language sql stable security definer set search_path = pg_catalog, public/);
  assert.match(source, /revoke all on function public\.ai_provider_configured\(\) from public, anon/);
  assert.match(source, /grant execute on function public\.ai_provider_configured\(\) to authenticated/);
});

test("realtime ASR migration preserves saved keys while fixing the endpoint and model", () => {
  const source = realtimeAsrSql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
  assert.match(source, /update public\.ai_provider_credentials set transcription_base_url = 'wss:\/\/llm-gctiyfgr4e625ujt\.cn-beijing\.maas\.aliyuncs\.com\/api-ws\/v1\/realtime', transcription_model = 'qwen3-asr-flash-realtime'/);
  assert.doesNotMatch(source, /transcription_api_key\s*=/);
  assert.match(source, /check \(transcription_base_url ~ '\^wss:\/\/\[\^\[:space:\]\]\+\$'\)/);
});

test("AI edge functions answer browser CORS preflight requests", async () => {
  for (const file of [
    "supabase/functions/configure-meeting-ai/index.ts",
    "supabase/functions/process-meeting-intelligence/index.ts",
  ]) {
    const source = await readFile(resolve(root, file), "utf8");
    assert.match(source, /request\.method === ["']OPTIONS["']/);
    assert.match(source, /Access-Control-Allow-Origin/);
    assert.match(source, /Access-Control-Allow-Headers/);
  }
});
