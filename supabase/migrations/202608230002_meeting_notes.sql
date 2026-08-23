alter table public.meetings
  add column note text not null default ''
  check (char_length(note) <= 200000);

create or replace function public.apply_meeting_note_mutation(
  p_operation_id uuid,
  p_entity_id uuid,
  p_note text,
  p_updated_at timestamptz,
  p_expected_sync_version bigint,
  p_expected_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_fingerprint text := md5(jsonb_build_object(
    'entityId', p_entity_id,
    'note', p_note,
    'updatedAt', p_updated_at,
    'expectedSyncVersion', p_expected_sync_version
  )::text);
  v_replay public.catalog_mutation_replays%rowtype;
  v_response jsonb;
  v_row jsonb;
begin
  if v_user_id is null then
    return jsonb_build_object('status', 401, 'code', 'AUTH_REQUIRED');
  end if;
  if v_user_id is distinct from p_expected_user_id then
    return jsonb_build_object('status', 401, 'code', 'AUTH_CONTEXT_CHANGED');
  end if;

  if p_operation_id is null
    or p_entity_id is null
    or p_note is null
    or p_updated_at is null
    or p_expected_sync_version is null
    or p_expected_user_id is null
    or p_expected_sync_version < 0
    or char_length(p_note) > 200000 then
    if p_operation_id is null then
      return jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || p_operation_id::text, 0));
  select * into v_replay
  from public.catalog_mutation_replays
  where user_id = v_user_id and operation_id = p_operation_id;
  if found then
    if v_replay.operation_kind = 'meeting.note' and v_replay.request_fingerprint = v_fingerprint then
      return v_replay.response;
    end if;
    return jsonb_build_object('status', 409, 'code', 'IDEMPOTENCY_KEY_REUSED');
  end if;

  if p_entity_id is null
    or p_note is null
    or p_updated_at is null
    or p_expected_sync_version is null
    or p_expected_user_id is null
    or p_expected_sync_version < 0
    or char_length(p_note) > 200000 then
    v_response := jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
  else
    perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':entity:' || p_entity_id::text, 0));

    if not exists (
      select 1 from public.meetings
      where user_id = v_user_id and id = p_entity_id
    ) then
      v_response := jsonb_build_object('status', 404, 'code', 'MEETING_NOT_FOUND');
    else
      update public.meetings
      set note = p_note, updated_at = p_updated_at, sync_version = sync_version + 1
      where user_id = v_user_id and id = p_entity_id and sync_version = p_expected_sync_version
      returning to_jsonb(public.meetings.*) into v_row;

      if v_row is null then
        v_response := jsonb_build_object('status', 409, 'code', 'CONFLICT');
      else
        v_response := jsonb_build_object('status', 200, 'meeting', v_row);
      end if;
    end if;
  end if;

  insert into public.catalog_mutation_replays (
    user_id,
    operation_id,
    operation_kind,
    request_fingerprint,
    response
  ) values (
    v_user_id,
    p_operation_id,
    'meeting.note',
    v_fingerprint,
    v_response
  );
  return v_response;
end;
$function$;

revoke all on function public.apply_meeting_note_mutation(uuid, uuid, text, timestamptz, bigint, uuid) from public, anon;
revoke execute on function public.apply_meeting_note_mutation(uuid, uuid, text, timestamptz, bigint, uuid) from anon;
revoke execute on function public.apply_meeting_note_mutation(uuid, uuid, text, timestamptz, bigint, uuid) from public;
grant execute on function public.apply_meeting_note_mutation(uuid, uuid, text, timestamptz, bigint, uuid) to authenticated;
