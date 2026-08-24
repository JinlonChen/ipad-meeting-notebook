begin;
select plan(16);

select has_function(
  'public',
  'get_expired_meeting_audio_cleanup_candidates',
  array['integer', 'timestamp with time zone'],
  'bounded audio cleanup candidate RPC exists'
);
select is(
  has_function_privilege('anon', 'public.get_expired_meeting_audio_cleanup_candidates(integer,timestamp with time zone)', 'EXECUTE'),
  false,
  'anon cannot enumerate cleanup candidates'
);
select is(
  has_function_privilege('authenticated', 'public.get_expired_meeting_audio_cleanup_candidates(integer,timestamp with time zone)', 'EXECUTE'),
  false,
  'authenticated users cannot enumerate cleanup candidates'
);
select is(
  has_function_privilege('service_role', 'public.get_expired_meeting_audio_cleanup_candidates(integer,timestamp with time zone)', 'EXECUTE'),
  true,
  'service role can enumerate cleanup candidates'
);

insert into auth.users (id, aud, role, email, encrypted_password)
values ('00000000-0000-4000-8000-000000000501', 'authenticated', 'authenticated', 'cleanup@example.test', 'x')
on conflict (id) do nothing;

insert into public.meetings (
  user_id, id, title, folder_id, status, started_at, ended_at,
  created_at, updated_at, trashed_at, status_before_trash, sync_version, note
)
values (
  '00000000-0000-4000-8000-000000000501',
  '00000000-0000-4000-8000-000000000601',
  'Cleanup safety', null, 'draft', null, null,
  '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', null, null, 0, 'permanent note'
);

insert into public.meeting_audio_chunks (
  user_id, meeting_id, sequence, remote_path, sha256, size_bytes,
  mime_type, captured_at, created_at, expires_at
)
select
  '00000000-0000-4000-8000-000000000501',
  '00000000-0000-4000-8000-000000000601',
  sequence,
  '00000000-0000-4000-8000-000000000501/00000000-0000-4000-8000-000000000601/' || sequence || '.webm',
  repeat('a', 64), 5, 'audio/webm',
  case when sequence = 101
    then '2026-08-23T00:00:01Z'::timestamptz
    else '2026-08-20T00:00:00Z'::timestamptz + sequence * interval '1 second'
  end,
  case when sequence = 101
    then '2026-08-23T00:00:01Z'::timestamptz
    else '2026-08-20T00:00:00Z'::timestamptz + sequence * interval '1 second'
  end,
  case when sequence = 101
    then '2026-08-25T00:00:01Z'::timestamptz
    else '2026-08-22T00:00:00Z'::timestamptz + sequence * interval '1 second'
  end
from generate_series(0, 101) as sequence;

insert into public.meeting_audio_chunks (
  user_id, meeting_id, sequence, remote_path, sha256, size_bytes,
  mime_type, captured_at, created_at, expires_at
)
values (
  '00000000-0000-4000-8000-000000000501',
  '00000000-0000-4000-8000-000000000601',
  9223372036854775807,
  '00000000-0000-4000-8000-000000000501/00000000-0000-4000-8000-000000000601/9223372036854775807.webm',
  repeat('b', 64), 5, 'audio/webm',
  '2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z', '2026-08-21T00:00:00Z'
);

insert into public.meeting_audio_chunks (
  user_id, meeting_id, sequence, remote_path, sha256, size_bytes,
  mime_type, captured_at, created_at, expires_at
)
values (
  '00000000-0000-4000-8000-000000000501',
  '00000000-0000-4000-8000-000000000601',
  900,
  '00000000-0000-4000-8000-000000000501/00000000-0000-4000-8000-000000000601/900.webm',
  repeat('c', 64), 5, 'audio/webm',
  '2026-08-16T00:30:00Z', '2026-08-16T00:30:00Z', '2026-08-18T00:30:00Z'
);

insert into storage.objects (id, bucket_id, name, owner, created_at, updated_at, last_accessed_at, metadata)
values
  (
    '00000000-0000-4000-8000-000000000701',
    'meeting-audio',
    '00000000-0000-4000-8000-000000000501/00000000-0000-4000-8000-000000000601/expired-orphan.bin',
    '00000000-0000-4000-8000-000000000501',
    '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', '{}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000702',
    'meeting-audio',
    '00000000-0000-4000-8000-000000000501/00000000-0000-4000-8000-000000000601/young-orphan.bin',
    '00000000-0000-4000-8000-000000000501',
    '2026-08-23T00:00:01Z', '2026-08-23T00:00:01Z', '2026-08-23T00:00:01Z', '{}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000703',
    'meeting-audio',
    '00000000-0000-4000-8000-000000000501/00000000-0000-4000-8000-000000000601/order-orphan.bin',
    '00000000-0000-4000-8000-000000000501',
    '2026-08-16T01:00:00Z', '2026-08-16T01:00:00Z', '2026-08-16T01:00:00Z', '{}'::jsonb
  );

set local role anon;
select throws_ok(
  $$select * from public.get_expired_meeting_audio_cleanup_candidates(100, '2026-08-25T00:00:00Z')$$,
  '42501',
  'permission denied for function get_expired_meeting_audio_cleanup_candidates',
  'anon cleanup invocation is denied'
);
reset role;

set local role service_role;
select is(
  (select count(*) from public.get_expired_meeting_audio_cleanup_candidates(1000, '2026-08-25T00:00:00Z')),
  100::bigint,
  'candidate RPC clamps oversized batches to 100'
);
select is(
  (select count(*) from public.get_expired_meeting_audio_cleanup_candidates(0, '2026-08-25T00:00:00Z')),
  1::bigint,
  'candidate RPC clamps undersized batches to one'
);
select is(
  (
    select sequence
    from public.get_expired_meeting_audio_cleanup_candidates(100, '2026-08-25T00:00:00Z')
    where remote_path like '%/9223372036854775807.webm'
  ),
  '9223372036854775807',
  'candidate RPC returns maximum bigint sequence without JSON precision loss'
);
select is(
  (
    select remote_path
    from public.get_expired_meeting_audio_cleanup_candidates(1, '2026-08-18T02:00:00Z')
  ),
  '00000000-0000-4000-8000-000000000501/00000000-0000-4000-8000-000000000601/900.webm',
  'metadata expiring first is ordered before a later-eligible orphan'
);
select ok(
  exists (
    select 1 from public.get_expired_meeting_audio_cleanup_candidates(100, '2026-08-25T00:00:00Z')
    where remote_path like '%/expired-orphan.bin' and metadata_exists = false
  ),
  'expired object without metadata is selected'
);
select is(
  (
    select storage_object_id
    from public.get_expired_meeting_audio_cleanup_candidates(100, '2026-08-25T00:00:00Z')
    where remote_path like '%/expired-orphan.bin'
  ),
  '00000000-0000-4000-8000-000000000701',
  'orphan cleanup candidate exposes its storage object identifier'
);
select ok(
  not exists (
    select 1 from public.get_expired_meeting_audio_cleanup_candidates(100, '2026-08-25T00:00:00Z')
    where remote_path like '%/young-orphan.bin'
  ),
  'orphan object younger than 48 hours is retained'
);
select ok(
  exists (
    select 1 from public.get_expired_meeting_audio_cleanup_candidates(100, '2026-08-25T00:00:00Z')
    where remote_path like '%/0.webm' and metadata_exists = true
  ),
  'expired metadata is selected even when its object is absent'
);
select ok(
  not exists (
    select 1 from public.get_expired_meeting_audio_cleanup_candidates(100, '2026-08-25T00:00:00Z')
    where remote_path like '%/101.webm'
  ),
  'unexpired metadata is retained'
);
reset role;

select is(
  (select note from public.meetings where id = '00000000-0000-4000-8000-000000000601'),
  'permanent note',
  'cleanup selection preserves meeting notes'
);
select is(
  (select count(*) from public.meetings where id = '00000000-0000-4000-8000-000000000601'),
  1::bigint,
  'cleanup selection preserves meetings'
);

select * from finish();
rollback;
