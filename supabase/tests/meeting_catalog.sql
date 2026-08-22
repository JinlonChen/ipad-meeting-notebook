begin;
select plan(30);

select has_table('public', 'folders', 'folders table exists');
select has_table('public', 'meetings', 'meetings table exists');
select has_table('public', 'catalog_mutation_replays', 'replay table exists');
select policies_are('public', 'folders', array['folders_owner_select']);
select policies_are('public', 'meetings', array['meetings_owner_select']);
select has_function('public', 'apply_catalog_mutation', array['uuid', 'text', 'uuid', 'jsonb'], 'catalog mutation rpc exists');
select is((select relrowsecurity from pg_class where oid = 'public.folders'::regclass), true, 'folders RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.meetings'::regclass), true, 'meetings RLS enabled');

-- Supabase's auth.uid() reads this claim when the test runs as authenticated.
insert into auth.users (id, aud, role, email, encrypted_password)
values
  ('00000000-0000-4000-8000-000000000101', 'authenticated', 'authenticated', 'catalog-one@example.test', 'x'),
  ('00000000-0000-4000-8000-000000000102', 'authenticated', 'authenticated', 'catalog-two@example.test', 'x')
on conflict (id) do nothing;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000101', true);
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000201', 'folder.create', '00000000-0000-4000-8000-000000000301', '{"id":"00000000-0000-4000-8000-000000000301","name":"Work","clientCreatedAt":"2026-08-22T00:00:00Z"}'::jsonb)->>'status')::int, 200, 'owner can create folder through RPC');
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000201', 'folder.create', '00000000-0000-4000-8000-000000000301', '{"id":"00000000-0000-4000-8000-000000000301","name":"Work","clientCreatedAt":"2026-08-22T00:00:00Z"}'::jsonb)->>'status')::int, 200, 'successful mutation is persisted and replayed');
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000202', 'meeting.create', '00000000-0000-4000-8000-000000000302', '{"id":"00000000-0000-4000-8000-000000000302","title":"Planning","folderId":"00000000-0000-4000-8000-000000000301","clientCreatedAt":"2026-08-22T00:01:00Z"}'::jsonb)->>'status')::int, 200, 'owner can create meeting through RPC');
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000202', 'meeting.create', '00000000-0000-4000-8000-000000000302', '{"id":"00000000-0000-4000-8000-000000000302","title":"Planning","folderId":"00000000-0000-4000-8000-000000000301","clientCreatedAt":"2026-08-22T00:01:00Z"}'::jsonb)->>'status')::int, 200, 'matching operation replays idempotently');
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000202', 'meeting.rename', '00000000-0000-4000-8000-000000000302', '{"title":"Reused","expectedSyncVersion":0}'::jsonb)->>'code'), 'IDEMPOTENCY_KEY_REUSED', 'reused operation with different fingerprint is rejected');
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000203', 'meeting.rename', '00000000-0000-4000-8000-000000000302', '{"title":"Renamed","updatedAt":"2026-08-22T00:02:00Z","expectedSyncVersion":0}'::jsonb)->>'status')::int, 200, 'conditional rename increments version');
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000204', 'meeting.rename', '00000000-0000-4000-8000-000000000302', '{"title":"Stale","expectedSyncVersion":0}'::jsonb)->>'code'), 'CONFLICT', 'stale version is rejected');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000102', true);
select is((select count(*) from public.folders), 0::bigint, 'second user cannot read first user folders');
select is((select count(*) from public.meetings), 0::bigint, 'second user cannot read first user meetings');
select throws_ok($$insert into public.folders (user_id, id, name, created_at, updated_at, sync_version) values ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000303', 'Nope', now(), now(), 0)$$, '42501', 'second user cannot directly insert folders');
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000205', 'meeting.rename', '00000000-0000-4000-8000-000000000302', '{"title":"Cross user","expectedSyncVersion":1}'::jsonb)->>'code'), 'MEETING_NOT_FOUND', 'cross-user mutation cannot find meeting');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000101', true);
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000206', 'folder.remove', '00000000-0000-4000-8000-000000000301', '{"updatedAt":"2026-08-22T00:03:00Z","expectedSyncVersion":1}'::jsonb)->>'code'), 'CONFLICT', 'stale folder removal is rejected');
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000208', 'folder.remove', '00000000-0000-4000-8000-000000000301', '{"updatedAt":"2026-08-22T00:03:00Z","expectedSyncVersion":0}'::jsonb)->>'status')::int, 200, 'folder removal succeeds');
select is((select folder_id from public.meetings where user_id = '00000000-0000-4000-8000-000000000101' and id = '00000000-0000-4000-8000-000000000302'), null, 'folder removal nulls owned meeting references');
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000207', 'folder.remove', '00000000-0000-4000-8000-000000000301', '{"expectedSyncVersion":0}'::jsonb)->>'status')::int, 200, 'missing folder removal is idempotent');
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000207', 'folder.remove', '00000000-0000-4000-8000-000000000301', '{"expectedSyncVersion":0}'::jsonb)->>'status')::int, 200, 'missing folder removal is persisted and replayed');

select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000209', 'meeting.create', '00000000-0000-4000-8000-000000000304', '{"id":"00000000-0000-4000-8000-000000000304","title":"Recording","folderId":null,"clientCreatedAt":"2026-08-22T00:04:00Z"}'::jsonb)->>'status')::int, 200, 'second meeting is created');
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000210', 'meeting.trash', '00000000-0000-4000-8000-000000000304', '{"updatedAt":"2026-08-22T00:05:00Z","expectedSyncVersion":0}'::jsonb)->>'status')::int, 200, 'trash succeeds');
select is((select status_before_trash from public.meetings where user_id = '00000000-0000-4000-8000-000000000101' and id = '00000000-0000-4000-8000-000000000304'), 'draft', 'trash retains prior status');
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000211', 'meeting.restore', '00000000-0000-4000-8000-000000000304', '{"updatedAt":"2026-08-22T00:06:00Z","expectedSyncVersion":1}'::jsonb)->>'status')::int, 200, 'restore succeeds');
select is((select status from public.meetings where user_id = '00000000-0000-4000-8000-000000000101' and id = '00000000-0000-4000-8000-000000000304'), 'draft', 'restore uses retained status');
select is((public.apply_catalog_mutation('00000000-0000-4000-8000-000000000212', 'meeting.rename', '00000000-0000-4000-8000-000000000304', '{"title":"Bad","expectedSyncVersion":"oops"}'::jsonb)->>'code'), 'INVALID_REQUEST', 'invalid version returns typed failure');

select * from finish();
rollback;
