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
  assert.match(source, /security invoker/);
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
