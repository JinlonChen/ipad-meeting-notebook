begin;
select plan(17);

select has_table('public', 'meeting_ink_strokes', 'meeting ink table exists');
select has_function('public', 'apply_meeting_ink_mutation', array['uuid', 'jsonb', 'uuid'], 'meeting ink mutation RPC exists');
select is(has_function_privilege('anon', 'public.apply_meeting_ink_mutation(uuid,jsonb,uuid)', 'EXECUTE'), false, 'anon cannot execute the ink RPC');
select is(has_function_privilege('authenticated', 'public.apply_meeting_ink_mutation(uuid,jsonb,uuid)', 'EXECUTE'), true, 'authenticated users can execute the ink RPC');

insert into auth.users (id, aud, role, email, encrypted_password)
values ('00000000-0000-4000-8000-000000000101', 'authenticated', 'authenticated', 'ink@example.test', 'x')
on conflict (id) do nothing;

insert into public.meetings (
  user_id, id, title, folder_id, status, started_at, ended_at,
  created_at, updated_at, trashed_at, status_before_trash, sync_version, note
) values (
  '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000201',
  'Ink test', null, 'draft', null, null, now(), now(), null, null, 0, ''
);

create function pg_temp.apply_ink(uuid, jsonb) returns jsonb
language sql
as $$
  select public.apply_meeting_ink_mutation($1, $2, '00000000-0000-4000-8000-000000000101')
$$;

set local role anon;
select throws_ok(
  $$select public.apply_meeting_ink_mutation(null::uuid, null::jsonb, null::uuid)$$,
  '42501',
  'permission denied for function apply_meeting_ink_mutation',
  'anonymous ink mutation is denied'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000101', true);

select is((pg_temp.apply_ink(
  '00000000-0000-4000-8000-000000000301',
  '{"id":"00000000-0000-4000-8000-000000000401","meetingId":"00000000-0000-4000-8000-000000000201","order":0,"tool":"pen","color":"#1d2529","width":4,"points":[{"x":0,"y":0,"pressure":0,"elapsedMs":0},{"x":2048,"y":200000,"pressure":1,"elapsedMs":86400000}],"deleted":false,"version":1}'::jsonb
)->>'id'), '00000000-0000-4000-8000-000000000401', 'valid boundary points are accepted');

select is((pg_temp.apply_ink('00000000-0000-4000-8000-000000000302', '{"id":"00000000-0000-4000-8000-000000000402","meetingId":"00000000-0000-4000-8000-000000000201","order":0,"tool":"pen","color":"#1d2529","width":4,"points":{},"deleted":false,"version":1}'::jsonb)->>'code'), 'INVALID_REQUEST', 'points must be an array');
select is((pg_temp.apply_ink('00000000-0000-4000-8000-000000000303', '{"id":"00000000-0000-4000-8000-000000000403","meetingId":"00000000-0000-4000-8000-000000000201","order":0,"tool":"pen","color":"#1d2529","width":4,"points":[[],[]],"deleted":false,"version":1}'::jsonb)->>'code'), 'INVALID_REQUEST', 'point entries must be objects');
select is((pg_temp.apply_ink('00000000-0000-4000-8000-000000000304', '{"id":"00000000-0000-4000-8000-000000000404","meetingId":"00000000-0000-4000-8000-000000000201","order":0,"tool":"pen","color":"#1d2529","width":4,"points":[{"x":0,"y":0,"pressure":0.5,"elapsedMs":0,"extra":1},{"x":1,"y":1,"pressure":0.5,"elapsedMs":1}],"deleted":false,"version":1}'::jsonb)->>'code'), 'INVALID_REQUEST', 'point entries reject extra keys');
select is((pg_temp.apply_ink('00000000-0000-4000-8000-000000000305', '{"id":"00000000-0000-4000-8000-000000000405","meetingId":"00000000-0000-4000-8000-000000000201","order":0,"tool":"pen","color":"#1d2529","width":4,"points":[{"x":0,"y":0,"pressure":0.5},{"x":1,"y":1,"pressure":0.5,"elapsedMs":1}],"deleted":false,"version":1}'::jsonb)->>'code'), 'INVALID_REQUEST', 'point entries require every key');
select is((pg_temp.apply_ink('00000000-0000-4000-8000-000000000306', '{"id":"00000000-0000-4000-8000-000000000406","meetingId":"00000000-0000-4000-8000-000000000201","order":0,"tool":"pen","color":"#1d2529","width":4,"points":[{"x":"NaN","y":0,"pressure":"Infinity","elapsedMs":0},{"x":1,"y":1,"pressure":0.5,"elapsedMs":1}],"deleted":false,"version":1}'::jsonb)->>'code'), 'INVALID_REQUEST', 'point numbers reject nonfinite string representations');
select is((pg_temp.apply_ink('00000000-0000-4000-8000-000000000307', '{"id":"00000000-0000-4000-8000-000000000407","meetingId":"00000000-0000-4000-8000-000000000201","order":0,"tool":"pen","color":"#1d2529","width":4,"points":[{"x":2049,"y":0,"pressure":0.5,"elapsedMs":0},{"x":1,"y":1,"pressure":0.5,"elapsedMs":1}],"deleted":false,"version":1}'::jsonb)->>'code'), 'INVALID_REQUEST', 'point x is bounded');
select is((pg_temp.apply_ink('00000000-0000-4000-8000-000000000308', '{"id":"00000000-0000-4000-8000-000000000408","meetingId":"00000000-0000-4000-8000-000000000201","order":0,"tool":"pen","color":"#1d2529","width":4,"points":[{"x":0,"y":200001,"pressure":0.5,"elapsedMs":0},{"x":1,"y":1,"pressure":0.5,"elapsedMs":1}],"deleted":false,"version":1}'::jsonb)->>'code'), 'INVALID_REQUEST', 'point y is bounded');
select is((pg_temp.apply_ink('00000000-0000-4000-8000-000000000309', '{"id":"00000000-0000-4000-8000-000000000409","meetingId":"00000000-0000-4000-8000-000000000201","order":0,"tool":"pen","color":"#1d2529","width":4,"points":[{"x":0,"y":0,"pressure":1.1,"elapsedMs":0},{"x":1,"y":1,"pressure":0.5,"elapsedMs":1}],"deleted":false,"version":1}'::jsonb)->>'code'), 'INVALID_REQUEST', 'point pressure is bounded');
select is((pg_temp.apply_ink('00000000-0000-4000-8000-000000000310', '{"id":"00000000-0000-4000-8000-000000000410","meetingId":"00000000-0000-4000-8000-000000000201","order":0,"tool":"pen","color":"#1d2529","width":4,"points":[{"x":0,"y":0,"pressure":0.5,"elapsedMs":1.5},{"x":1,"y":1,"pressure":0.5,"elapsedMs":1}],"deleted":false,"version":1}'::jsonb)->>'code'), 'INVALID_REQUEST', 'point elapsed time must be an integer');
select is((pg_temp.apply_ink('00000000-0000-4000-8000-000000000311', '{"id":"00000000-0000-4000-8000-000000000411","meetingId":"00000000-0000-4000-8000-000000000201","order":0,"tool":"pen","color":"#1d2529","width":4,"points":[{"x":0,"y":0,"pressure":0.5,"elapsedMs":86400001},{"x":1,"y":1,"pressure":0.5,"elapsedMs":1}],"deleted":false,"version":1}'::jsonb)->>'code'), 'INVALID_REQUEST', 'point elapsed time is bounded');
select is((pg_temp.apply_ink('00000000-0000-4000-8000-000000000312', '{"id":"00000000-0000-4000-8000-000000000412","meetingId":"00000000-0000-4000-8000-000000000201","order":0,"tool":"pen","color":"#1d2529","width":4,"points":[{"x":0,"y":0,"pressure":0.5,"elapsedMs":0}],"deleted":false,"version":1}'::jsonb)->>'code'), 'INVALID_REQUEST', 'stroke requires at least two points');

select * from finish();
rollback;
