import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = resolve(root, "supabase/migrations/202608220001_meeting_catalog.sql");

let sql;
test.before(async () => {
  sql = await readFile(migrationPath, "utf8");
});

function normalizedSql() {
  return sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
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
