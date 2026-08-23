begin;
select plan(67);

select has_table('public', 'folders', 'folders table exists');
select has_table('public', 'meetings', 'meetings table exists');
select has_table('public', 'catalog_mutation_replays', 'replay table exists');
select policies_are('public', 'folders', array['folders_owner_select']);
select policies_are('public', 'meetings', array['meetings_owner_select']);
select has_function('public', 'apply_catalog_mutation', array['uuid', 'text', 'uuid', 'jsonb', 'uuid'], 'catalog mutation rpc exists');
select has_column('public', 'meetings', 'note', 'meetings expose notes');
select col_not_null('public', 'meetings', 'note', 'meeting notes are non-null');
select is((select column_default from information_schema.columns where table_schema = 'public' and table_name = 'meetings' and column_name = 'note'), $default$''::text$default$, 'meeting notes default to empty text');
select has_function('public', 'apply_meeting_note_mutation', array['uuid', 'uuid', 'text', 'timestamp with time zone', 'bigint', 'uuid'], 'meeting note mutation rpc exists');
select is((select relrowsecurity from pg_class where oid = 'public.folders'::regclass), true, 'folders RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.meetings'::regclass), true, 'meetings RLS enabled');

create function pg_temp.apply_catalog_mutation(uuid, text, uuid, jsonb) returns jsonb
language sql
as $$ select public.apply_catalog_mutation($1, $2, $3, $4, auth.uid()) $$;

-- Supabase's auth.uid() reads this claim when the test runs as authenticated.
insert into auth.users (id, aud, role, email, encrypted_password)
values
  ('00000000-0000-4000-8000-000000000101', 'authenticated', 'authenticated', 'catalog-one@example.test', 'x'),
  ('00000000-0000-4000-8000-000000000102', 'authenticated', 'authenticated', 'catalog-two@example.test', 'x')
on conflict (id) do nothing;

set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select is((public.apply_meeting_note_mutation('00000000-0000-4000-8000-000000000219', '00000000-0000-4000-8000-000000000302', 'anonymous', '2026-08-22T00:02:30Z', 1, '00000000-0000-4000-8000-000000000101')->>'code'), 'AUTH_REQUIRED', 'note RPC rejects a missing auth actor');
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000101', true);
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000201', 'folder.create', '00000000-0000-4000-8000-000000000301', '{"id":"00000000-0000-4000-8000-000000000301","name":"Work","clientCreatedAt":"2026-08-22T00:00:00Z"}'::jsonb)->>'status')::int, 200, 'owner can create folder through RPC');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000201', 'folder.create', '00000000-0000-4000-8000-000000000301', '{"id":"00000000-0000-4000-8000-000000000301","name":"Work","clientCreatedAt":"2026-08-22T00:00:00Z"}'::jsonb)->>'status')::int, 200, 'successful mutation is persisted and replayed');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000202', 'meeting.create', '00000000-0000-4000-8000-000000000302', '{"id":"00000000-0000-4000-8000-000000000302","title":"Planning","folderId":"00000000-0000-4000-8000-000000000301","clientCreatedAt":"2026-08-22T00:01:00Z"}'::jsonb)->>'status')::int, 200, 'owner can create meeting through RPC');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000202', 'meeting.create', '00000000-0000-4000-8000-000000000302', '{"id":"00000000-0000-4000-8000-000000000302","title":"Planning","folderId":"00000000-0000-4000-8000-000000000301","clientCreatedAt":"2026-08-22T00:01:00Z"}'::jsonb)->>'status')::int, 200, 'matching operation replays idempotently');
select is((public.apply_meeting_note_mutation('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000302', 'cross kind', '2026-08-22T00:01:30Z', 0, '00000000-0000-4000-8000-000000000101')->>'code'), 'IDEMPOTENCY_KEY_REUSED', 'note RPC rejects an operation id already stored by another mutation kind');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000202', 'meeting.rename', '00000000-0000-4000-8000-000000000302', '{"title":"Reused","expectedSyncVersion":0}'::jsonb)->>'code'), 'IDEMPOTENCY_KEY_REUSED', 'reused operation with different fingerprint is rejected');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000203', 'meeting.rename', '00000000-0000-4000-8000-000000000302', '{"title":"Renamed","updatedAt":"2026-08-22T00:02:00Z","expectedSyncVersion":0}'::jsonb)->>'status')::int, 200, 'conditional rename increments version');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000204', 'meeting.rename', '00000000-0000-4000-8000-000000000302', '{"title":"Stale","expectedSyncVersion":0}'::jsonb)->>'code'), 'CONFLICT', 'stale version is rejected');
select is((select sync_version from public.meetings where id = '00000000-0000-4000-8000-000000000302'), 1::bigint, 'two operation ids sharing expected version increment only once');
select is((public.apply_meeting_note_mutation('00000000-0000-4000-8000-000000000219', '00000000-0000-4000-8000-000000000302', '结论', '2026-08-22T00:02:30Z', 1, '00000000-0000-4000-8000-000000000101')->>'status')::int, 200, 'conditional note update succeeds');
select is((public.apply_meeting_note_mutation('00000000-0000-4000-8000-000000000219', '00000000-0000-4000-8000-000000000302', '结论', '2026-08-22T00:02:30Z', 1, '00000000-0000-4000-8000-000000000101')->'meeting'->>'note'), '结论', 'note response contains authoritative text');
select is((select sync_version from public.meetings where id = '00000000-0000-4000-8000-000000000302'), 2::bigint, 'note update increments sync version once');
select is((public.apply_meeting_note_mutation('00000000-0000-4000-8000-000000000219', '00000000-0000-4000-8000-000000000302', '结论', '2026-08-22T00:02:30Z', 1, '00000000-0000-4000-8000-000000000101')->>'status')::int, 200, 'matching note operation replays idempotently');
select is((select sync_version from public.meetings where id = '00000000-0000-4000-8000-000000000302'), 2::bigint, 'note replay does not increment sync version');
select is((public.apply_meeting_note_mutation('00000000-0000-4000-8000-000000000219', '00000000-0000-4000-8000-000000000302', 'different', '2026-08-22T00:02:30Z', 1, '00000000-0000-4000-8000-000000000101')->>'code'), 'IDEMPOTENCY_KEY_REUSED', 'note operation id cannot be reused with another fingerprint');
select is((public.apply_meeting_note_mutation('00000000-0000-4000-8000-000000000220', '00000000-0000-4000-8000-000000000302', 'stale', '2026-08-22T00:02:31Z', 1, '00000000-0000-4000-8000-000000000101')->>'code'), 'CONFLICT', 'stale note version is rejected');
select is((public.apply_meeting_note_mutation('00000000-0000-4000-8000-000000000221', '00000000-0000-4000-8000-000000000302', repeat('😀', 200000), '2026-08-22T00:02:32Z', 2, '00000000-0000-4000-8000-000000000101')->>'status')::int, 200, '200000 Unicode code points are accepted');
select is((select char_length(note) from public.meetings where id = '00000000-0000-4000-8000-000000000302'), 200000, 'Postgres counts emoji notes by Unicode code points');
select is((public.apply_meeting_note_mutation('00000000-0000-4000-8000-000000000222', '00000000-0000-4000-8000-000000000302', repeat('😀', 200001), '2026-08-22T00:02:33Z', 3, '00000000-0000-4000-8000-000000000101')->>'code'), 'INVALID_REQUEST', '200001 Unicode code points are rejected');
select is((public.apply_meeting_note_mutation('00000000-0000-4000-8000-000000000223', '00000000-0000-4000-8000-000000000399', 'missing', '2026-08-22T00:02:34Z', 0, '00000000-0000-4000-8000-000000000101')->>'code'), 'MEETING_NOT_FOUND', 'missing meeting note mutation is typed');
select is((public.apply_meeting_note_mutation('00000000-0000-4000-8000-000000000224', '00000000-0000-4000-8000-000000000302', null, '2026-08-22T00:02:35Z', 3, '00000000-0000-4000-8000-000000000101')->>'code'), 'INVALID_REQUEST', 'null note is rejected');
select is((public.apply_meeting_note_mutation('00000000-0000-4000-8000-000000000225', '00000000-0000-4000-8000-000000000302', 'negative', '2026-08-22T00:02:36Z', -1, '00000000-0000-4000-8000-000000000101')->>'code'), 'INVALID_REQUEST', 'negative expected version is rejected');
select is((public.get_catalog_snapshot('00000000-0000-4000-8000-000000000101')->'meetings'->0->>'note'), repeat('😀', 200000), 'authoritative snapshot includes the stored note');
select throws_ok($$update public.meetings set note = 'direct' where id = '00000000-0000-4000-8000-000000000302'$$, '42501', 'permission denied for table meetings', 'direct authenticated meeting update remains denied');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000102', true);
select is((select count(*) from public.folders), 0::bigint, 'second user cannot read first user folders');
select is((select count(*) from public.meetings), 0::bigint, 'second user cannot read first user meetings');
select throws_ok($$insert into public.folders (user_id, id, name, created_at, updated_at, sync_version) values ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000303', 'Nope', now(), now(), 0)$$, '42501', 'permission denied for table folders', 'second user cannot directly insert folders');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000205', 'meeting.rename', '00000000-0000-4000-8000-000000000302', '{"title":"Cross user","expectedSyncVersion":1}'::jsonb)->>'code'), 'MEETING_NOT_FOUND', 'cross-user mutation cannot find meeting');
select is((public.get_catalog_snapshot('00000000-0000-4000-8000-000000000101')->>'code'), 'AUTH_CONTEXT_CHANGED', 'empty snapshot still rejects a changed actor');
select is(jsonb_array_length(public.get_catalog_snapshot('00000000-0000-4000-8000-000000000102')->'folders'), 0, 'matching actor authenticates an empty snapshot');
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000216', 'folder.create', '00000000-0000-4000-8000-000000000305', '{"id":"00000000-0000-4000-8000-000000000305","name":"Actor guard","clientCreatedAt":"2026-08-22T00:07:00Z"}'::jsonb, '00000000-0000-4000-8000-000000000101')->>'code'), 'AUTH_CONTEXT_CHANGED', 'changed JWT actor is rejected');
select is((public.apply_meeting_note_mutation('00000000-0000-4000-8000-000000000226', '00000000-0000-4000-8000-000000000302', 'actor mismatch', '2026-08-22T00:02:37Z', 3, '00000000-0000-4000-8000-000000000101')->>'code'), 'AUTH_CONTEXT_CHANGED', 'note RPC rejects a changed actor');
select is((select count(*) from public.folders where id = '00000000-0000-4000-8000-000000000305'), 0::bigint, 'changed actor writes no entity');
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000216', 'folder.create', '00000000-0000-4000-8000-000000000305', '{"id":"00000000-0000-4000-8000-000000000305","name":"Actor guard","clientCreatedAt":"2026-08-22T00:07:00Z"}'::jsonb, '00000000-0000-4000-8000-000000000102')->>'status')::int, 200, 'changed actor writes no replay before a valid retry');
select is((select count(*) from public.folders where id = '00000000-0000-4000-8000-000000000305'), 1::bigint, 'valid retry creates exactly one actor-owned entity');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000101', true);
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000206', 'folder.remove', '00000000-0000-4000-8000-000000000301', '{"updatedAt":"2026-08-22T00:03:00Z","expectedSyncVersion":1}'::jsonb)->>'code'), 'CONFLICT', 'stale folder removal is rejected');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000208', 'folder.remove', '00000000-0000-4000-8000-000000000301', '{"updatedAt":"2026-08-22T00:03:00Z","expectedSyncVersion":0}'::jsonb)->>'status')::int, 200, 'folder removal succeeds');
select is((select folder_id from public.meetings where user_id = '00000000-0000-4000-8000-000000000101' and id = '00000000-0000-4000-8000-000000000302'), null, 'folder removal nulls owned meeting references');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000207', 'folder.remove', '00000000-0000-4000-8000-000000000301', '{"expectedSyncVersion":0}'::jsonb)->>'status')::int, 200, 'missing folder removal is idempotent');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000207', 'folder.remove', '00000000-0000-4000-8000-000000000301', '{"expectedSyncVersion":0}'::jsonb)->>'status')::int, 200, 'missing folder removal is persisted and replayed');

select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000209', 'meeting.create', '00000000-0000-4000-8000-000000000304', '{"id":"00000000-0000-4000-8000-000000000304","title":"Recording","folderId":null,"clientCreatedAt":"2026-08-22T00:04:00Z"}'::jsonb)->>'status')::int, 200, 'second meeting is created');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000210', 'meeting.trash', '00000000-0000-4000-8000-000000000304', '{"updatedAt":"2026-08-22T00:05:00Z","expectedSyncVersion":0}'::jsonb)->>'status')::int, 200, 'trash succeeds');
select is((select status_before_trash from public.meetings where user_id = '00000000-0000-4000-8000-000000000101' and id = '00000000-0000-4000-8000-000000000304'), 'draft', 'trash retains prior status');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000213', 'meeting.trash', '00000000-0000-4000-8000-000000000304', '{"expectedSyncVersion":0}'::jsonb)->>'code'), 'CONFLICT', 'trash in target state rejects a stale expected version');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000214', 'meeting.trash', '00000000-0000-4000-8000-000000000304', '{"expectedSyncVersion":1}'::jsonb)->>'status')::int, 200, 'trash in target state accepts the exact current version');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000211', 'meeting.restore', '00000000-0000-4000-8000-000000000304', '{"updatedAt":"2026-08-22T00:06:00Z","expectedSyncVersion":1}'::jsonb)->>'status')::int, 200, 'restore succeeds');
select is((select status from public.meetings where user_id = '00000000-0000-4000-8000-000000000101' and id = '00000000-0000-4000-8000-000000000304'), 'draft', 'restore uses retained status');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000215', 'meeting.restore', '00000000-0000-4000-8000-000000000304', '{}'::jsonb)->>'status')::int, 200, 'restore without expected version is idempotent in target state');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000212', 'meeting.rename', '00000000-0000-4000-8000-000000000304', '{"title":"Bad","expectedSyncVersion":"oops"}'::jsonb)->>'code'), 'INVALID_REQUEST', 'invalid version returns typed failure');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000217', 'meeting.rename', '00000000-0000-4000-8000-000000000304', '{"title":"Null bypass","expectedSyncVersion":null}'::jsonb)->>'code'), 'INVALID_REQUEST', 'null expected version cannot become unconditional');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000217', 'meeting.rename', '00000000-0000-4000-8000-000000000304', '{"title":"Null bypass","expectedSyncVersion":null}'::jsonb)->>'code'), 'INVALID_REQUEST', 'invalid null version response is replayed');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000218', 'meeting.trash', '00000000-0000-4000-8000-000000000304', '["unexpected"]'::jsonb)->>'code'), 'INVALID_REQUEST', 'array payload is rejected');
select is((select status from public.meetings where id = '00000000-0000-4000-8000-000000000304'), 'draft', 'array payload does not mutate its entity');
select is((pg_temp.apply_catalog_mutation('00000000-0000-4000-8000-000000000218', 'meeting.trash', '00000000-0000-4000-8000-000000000304', '["unexpected"]'::jsonb)->>'code'), 'INVALID_REQUEST', 'array payload failure is replayed');

select * from finish();
rollback;
