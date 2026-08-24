create or replace function public.get_expired_meeting_audio_cleanup_candidates(
  p_limit integer default 100,
  p_now timestamp with time zone default now()
)
returns table (
  bucket_id text,
  remote_path text,
  user_id uuid,
  meeting_id uuid,
  sequence text,
  storage_object_id text,
  metadata_exists boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with requested_settings as (
    select
      least(greatest(p_limit, 1), 100) as requested_limit
  ),
  cleanup_settings as (
    select coalesce(requested_limit, 100) as batch_limit
    from requested_settings
  ),
  metadata_candidates as (
    select
      chunks.bucket_id,
      chunks.remote_path,
      chunks.user_id,
      chunks.meeting_id,
      chunks.sequence::text as sequence,
      null::text as storage_object_id,
      true as metadata_exists,
      chunks.expires_at as eligible_at
    from public.meeting_audio_chunks as chunks
    cross join cleanup_settings
    where chunks.bucket_id = 'meeting-audio'
      and chunks.expires_at <= p_now
  ),
  orphan_candidates as (
    select
      objects.bucket_id,
      objects.name as remote_path,
      null::uuid as user_id,
      null::uuid as meeting_id,
      null::text as sequence,
      objects.id::text as storage_object_id,
      false as metadata_exists,
      objects.created_at + interval '48 hours' as eligible_at
    from storage.objects as objects
    cross join cleanup_settings
    left join public.meeting_audio_chunks as chunks
      on chunks.bucket_id = objects.bucket_id
     and chunks.remote_path = objects.name
    where objects.bucket_id = 'meeting-audio'
      and objects.created_at <= p_now - interval '48 hours'
      and chunks.remote_path is null
  ),
  cleanup_candidates as (
    select * from metadata_candidates
    union all
    select * from orphan_candidates
  )
  select
    bucket_id,
    remote_path,
    user_id,
    meeting_id,
    sequence,
    storage_object_id,
    metadata_exists
  from cleanup_candidates
  order by eligible_at, remote_path
  limit (select batch_limit from cleanup_settings);
$$;

revoke all on function public.get_expired_meeting_audio_cleanup_candidates(integer, timestamp with time zone)
from public, anon, authenticated;
grant execute on function public.get_expired_meeting_audio_cleanup_candidates(integer, timestamp with time zone)
to service_role;
