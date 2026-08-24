begin;
select plan(20);

select has_table('public', 'meeting_audio_chunks', 'meeting audio metadata table exists');
select is((select public from storage.buckets where id = 'meeting-audio'), false, 'meeting audio bucket is private');
select is((select file_size_limit from storage.buckets where id = 'meeting-audio'), 104857600::bigint, 'meeting audio objects are bounded');
select policies_are('public', 'meeting_audio_chunks', array['meeting_audio_chunks_owner_insert', 'meeting_audio_chunks_owner_select']);
select ok(
  exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'meeting_audio_objects_owner_select'
  ),
  'owner storage select policy exists'
);
select ok(
  exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'meeting_audio_objects_owner_insert'
  ),
  'owner storage insert policy exists'
);
select is(has_table_privilege('anon', 'public.meeting_audio_chunks', 'SELECT'), false, 'anon cannot select audio metadata');
select is(has_table_privilege('anon', 'public.meeting_audio_chunks', 'INSERT'), false, 'anon cannot insert audio metadata');
select is(has_table_privilege('authenticated', 'public.meeting_audio_chunks', 'UPDATE'), false, 'browser cannot overwrite audio metadata');
select is(has_table_privilege('authenticated', 'public.meeting_audio_chunks', 'DELETE'), false, 'browser cannot delete audio metadata');

insert into auth.users (id, aud, role, email, encrypted_password)
values
  ('00000000-0000-4000-8000-000000000101', 'authenticated', 'authenticated', 'audio-one@example.test', 'x'),
  ('00000000-0000-4000-8000-000000000102', 'authenticated', 'authenticated', 'audio-two@example.test', 'x')
on conflict (id) do nothing;

insert into public.meetings (
  user_id, id, title, folder_id, status, started_at, ended_at,
  created_at, updated_at, trashed_at, status_before_trash, sync_version, note
)
values (
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000201',
  'Audio test', null, 'draft', null, null, now(), now(), null, null, 0, ''
);

set local role anon;
select throws_ok(
  $$select * from public.meeting_audio_chunks$$,
  '42501',
  'permission denied for table meeting_audio_chunks',
  'anon query is denied'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000101', true);
select lives_ok(
  $$insert into public.meeting_audio_chunks (
      user_id, meeting_id, sequence, remote_path, sha256, size_bytes, mime_type, captured_at, expires_at
    ) values (
      '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000201',
      0,
      '00000000-0000-4000-8000-000000000101/00000000-0000-4000-8000-000000000201/0.webm',
      repeat('a', 64), 5, 'audio/webm', now(), now() + interval '48 hours'
    )$$,
  'owner can insert matching audio metadata'
);
select is((select count(*) from public.meeting_audio_chunks), 1::bigint, 'owner can read own audio metadata');
select throws_ok(
  $$insert into public.meeting_audio_chunks (
      user_id, meeting_id, sequence, remote_path, sha256, size_bytes, mime_type, captured_at, expires_at
    ) values (
      '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000201',
      1,
      '00000000-0000-4000-8000-000000000101/00000000-0000-4000-8000-000000000201/1.webm',
      repeat('a', 64), 5, 'audio/webm', now(), now() + interval '49 hours'
    )$$,
  '23514',
  'new row for relation "meeting_audio_chunks" violates check constraint "meeting_audio_chunks_expires_within_retention"',
  'owner cannot extend audio metadata expiry beyond 48 hours'
);
select throws_ok(
  $$insert into public.meeting_audio_chunks (
      user_id, meeting_id, sequence, remote_path, sha256, size_bytes, mime_type, captured_at, expires_at, created_at
    ) values (
      '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000201',
      2,
      '00000000-0000-4000-8000-000000000101/00000000-0000-4000-8000-000000000201/2.webm',
      repeat('a', 64), 5, 'audio/webm', now(), now() + interval '48 hours', now() + interval '10 years'
    )$$,
  '42501',
  'permission denied for table meeting_audio_chunks',
  'owner cannot forge metadata creation time'
);
select throws_ok(
  $$insert into public.meeting_audio_chunks (
      user_id, meeting_id, sequence, remote_path, sha256, size_bytes, mime_type, captured_at, expires_at
    ) values (
      '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000201',
      0,
      '00000000-0000-4000-8000-000000000101/00000000-0000-4000-8000-000000000201/0.webm',
      repeat('a', 64), 5, 'audio/webm', now(), now() + interval '48 hours'
    )$$,
  '23505',
  'duplicate key value violates unique constraint "meeting_audio_chunks_pkey"',
  'duplicate meeting sequence is rejected'
);
select throws_ok(
  $$insert into public.meeting_audio_chunks (
      user_id, meeting_id, sequence, remote_path, sha256, size_bytes, mime_type, captured_at, expires_at
    ) values (
      '00000000-0000-4000-8000-000000000102',
      '00000000-0000-4000-8000-000000000201',
      1,
      '00000000-0000-4000-8000-000000000102/00000000-0000-4000-8000-000000000201/1.webm',
      repeat('b', 64), 5, 'audio/webm', now(), now() + interval '48 hours'
    )$$,
  '42501',
  'new row violates row-level security policy for table "meeting_audio_chunks"',
  'owner cannot insert another user metadata'
);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000102', true);
select is((select count(*) from public.meeting_audio_chunks), 0::bigint, 'second user cannot read first user audio metadata');
select is((select count(*) from public.meetings), 0::bigint, 'second user cannot read first user meeting');

reset role;
select is((select count(*) from public.meetings where id = '00000000-0000-4000-8000-000000000201'), 1::bigint, 'audio metadata operations preserve meetings');

select * from finish();
rollback;
