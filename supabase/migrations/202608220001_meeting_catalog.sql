create table public.folders (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  sync_version bigint not null check (sync_version >= 0),
  primary key (user_id, id)
);

create table public.meetings (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  folder_id uuid,
  status text not null check (status in ('draft', 'recording', 'recoverable', 'uploading', 'processing', 'ready', 'failed', 'trashed')),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  trashed_at timestamptz,
  sync_version bigint not null check (sync_version >= 0),
  primary key (user_id, id),
  foreign key (user_id, folder_id) references public.folders(user_id, id)
);

create table public.catalog_mutation_replays (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  operation_kind text not null,
  request_fingerprint text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, operation_id)
);

alter table public.folders enable row level security;
alter table public.meetings enable row level security;
alter table public.catalog_mutation_replays enable row level security;

revoke all on public.folders from anon;
revoke all on public.folders from public;
revoke insert on public.folders from authenticated;
revoke update on public.folders from authenticated;
revoke delete on public.folders from authenticated;
grant select on public.folders to authenticated;
create policy folders_owner_select on public.folders for select using (auth.uid() = user_id);

revoke all on public.meetings from anon;
revoke all on public.meetings from public;
revoke insert on public.meetings from authenticated;
revoke update on public.meetings from authenticated;
revoke delete on public.meetings from authenticated;
grant select on public.meetings to authenticated;
create policy meetings_owner_select on public.meetings for select using (auth.uid() = user_id);

revoke all on public.catalog_mutation_replays from anon;
revoke all on public.catalog_mutation_replays from public;

-- The public entry point remains invoker-security.  The private implementation
-- is definer-security so callers do not receive direct table mutation grants.
create or replace function public._apply_catalog_mutation_impl(
  p_operation_id uuid,
  p_kind text,
  p_entity_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_fingerprint text := md5(coalesce(p_kind, '') || ':' || coalesce(p_entity_id::text, '') || ':' || v_payload::text);
  v_replay public.catalog_mutation_replays%rowtype;
  v_response jsonb;
  v_now timestamptz := clock_timestamp();
  v_updated_at timestamptz;
  v_expected bigint;
  v_title text;
  v_name text;
  v_folder_id uuid;
  v_status text;
  v_client_created_at timestamptz;
  v_row jsonb;
begin
  if v_user_id is null then
    return jsonb_build_object('status', 401, 'code', 'AUTH_REQUIRED');
  end if;

  select * into v_replay
  from public.catalog_mutation_replays
  where user_id = v_user_id and operation_id = p_operation_id;
  if found then
    if v_replay.request_fingerprint = v_fingerprint then
      return v_replay.response;
    end if;
    return jsonb_build_object('status', 409, 'code', 'IDEMPOTENCY_KEY_REUSED');
  end if;

  v_updated_at := coalesce(nullif(v_payload->>'updatedAt', '')::timestamptz, v_now);
  if v_payload ? 'expectedSyncVersion' then
    v_expected := (v_payload->>'expectedSyncVersion')::bigint;
  end if;

  if p_kind = 'meeting.create' then
    v_title := btrim(v_payload->>'title');
    v_client_created_at := coalesce(nullif(v_payload->>'clientCreatedAt', '')::timestamptz, v_updated_at);
    if v_payload->>'id' is distinct from p_entity_id::text or v_title is null or char_length(v_title) not between 1 and 120 then
      v_response := jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
    else
      v_folder_id := nullif(v_payload->>'folderId', '')::uuid;
      if v_folder_id is not null and not exists (select 1 from public.folders where user_id = v_user_id and id = v_folder_id) then
        v_response := jsonb_build_object('status', 404, 'code', 'FOLDER_NOT_FOUND');
      elsif exists (select 1 from public.meetings where user_id = v_user_id and id = p_entity_id) then
        v_response := jsonb_build_object('status', 409, 'code', 'CONFLICT');
      else
        insert into public.meetings (user_id, id, title, folder_id, status, started_at, ended_at, created_at, updated_at, trashed_at, sync_version)
        values (v_user_id, p_entity_id, v_title, v_folder_id, 'draft', null, null, v_client_created_at, v_client_created_at, null, 0)
        returning to_jsonb(public.meetings.*) into v_row;
        v_response := jsonb_build_object('status', 200, 'meeting', v_row);
      end if;
    end if;
  elsif p_kind = 'meeting.rename' then
    v_title := btrim(v_payload->>'title');
    if v_title is null or char_length(v_title) not between 1 and 120 then
      v_response := jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
    elsif not exists (select 1 from public.meetings where user_id = v_user_id and id = p_entity_id) then
      v_response := jsonb_build_object('status', case when v_payload ? 'expectedSyncVersion' then 404 else 404 end, 'code', case when v_payload ? 'expectedSyncVersion' then 'MEETING_NOT_FOUND' else 'NOT_FOUND' end);
    else
      update public.meetings
      set title = v_title, updated_at = v_updated_at, sync_version = sync_version + 1
      where user_id = v_user_id and id = p_entity_id and (v_expected is null or sync_version = v_expected)
      returning to_jsonb(public.meetings.*) into v_row;
      if v_row is null then
        v_response := jsonb_build_object('status', 409, 'code', 'CONFLICT');
      else
        v_response := jsonb_build_object('status', 200, 'meeting', v_row);
      end if;
    end if;
  elsif p_kind = 'meeting.trash' then
    if not exists (select 1 from public.meetings where user_id = v_user_id and id = p_entity_id) then
      v_response := jsonb_build_object('status', 404, 'code', case when v_payload ? 'expectedSyncVersion' then 'MEETING_NOT_FOUND' else 'NOT_FOUND' end);
    else
      update public.meetings
      set status = 'trashed', trashed_at = v_updated_at, updated_at = v_updated_at, sync_version = sync_version + 1
      where user_id = v_user_id and id = p_entity_id and status <> 'trashed' and (v_expected is null or sync_version = v_expected)
      returning to_jsonb(public.meetings.*) into v_row;
      if v_row is null and v_expected is not null and exists (select 1 from public.meetings where user_id = v_user_id and id = p_entity_id and status = 'trashed' and sync_version = v_expected) then
        select to_jsonb(m.*) into v_row from public.meetings m where m.user_id = v_user_id and m.id = p_entity_id;
      end if;
      if v_row is null then v_response := jsonb_build_object('status', 409, 'code', 'CONFLICT');
      else v_response := jsonb_build_object('status', 200, 'meeting', v_row); end if;
    end if;
  elsif p_kind = 'meeting.restore' then
    if not exists (select 1 from public.meetings where user_id = v_user_id and id = p_entity_id) then
      v_response := jsonb_build_object('status', 404, 'code', case when v_payload ? 'expectedSyncVersion' then 'MEETING_NOT_FOUND' else 'NOT_FOUND' end);
    else
      update public.meetings
      set status = 'draft', trashed_at = null, updated_at = v_updated_at, sync_version = sync_version + 1
      where user_id = v_user_id and id = p_entity_id and status = 'trashed' and (v_expected is null or sync_version = v_expected)
      returning to_jsonb(public.meetings.*) into v_row;
      if v_row is null and v_expected is not null and exists (select 1 from public.meetings where user_id = v_user_id and id = p_entity_id and status <> 'trashed' and sync_version = v_expected) then
        select to_jsonb(m.*) into v_row from public.meetings m where m.user_id = v_user_id and m.id = p_entity_id;
      end if;
      if v_row is null then v_response := jsonb_build_object('status', 409, 'code', 'CONFLICT');
      else v_response := jsonb_build_object('status', 200, 'meeting', v_row); end if;
    end if;
  elsif p_kind = 'folder.create' then
    v_name := btrim(v_payload->>'name');
    v_client_created_at := coalesce(nullif(v_payload->>'clientCreatedAt', '')::timestamptz, v_updated_at);
    if v_payload->>'id' is distinct from p_entity_id::text or v_name is null or char_length(v_name) not between 1 and 80 then
      v_response := jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
    elsif exists (select 1 from public.folders where user_id = v_user_id and id = p_entity_id) then
      v_response := jsonb_build_object('status', 409, 'code', 'CONFLICT');
    else
      insert into public.folders (user_id, id, name, created_at, updated_at, sync_version)
      values (v_user_id, p_entity_id, v_name, v_client_created_at, v_client_created_at, 0)
      returning to_jsonb(public.folders.*) into v_row;
      v_response := jsonb_build_object('status', 200, 'folder', v_row);
    end if;
  elsif p_kind = 'folder.rename' then
    v_name := btrim(v_payload->>'name');
    if v_name is null or char_length(v_name) not between 1 and 80 then
      v_response := jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
    elsif not exists (select 1 from public.folders where user_id = v_user_id and id = p_entity_id) then
      v_response := jsonb_build_object('status', 404, 'code', case when v_payload ? 'expectedSyncVersion' then 'FOLDER_NOT_FOUND' else 'NOT_FOUND' end);
    else
      update public.folders
      set name = v_name, updated_at = v_updated_at, sync_version = sync_version + 1
      where user_id = v_user_id and id = p_entity_id and (v_expected is null or sync_version = v_expected)
      returning to_jsonb(public.folders.*) into v_row;
      if v_row is null then v_response := jsonb_build_object('status', 409, 'code', 'CONFLICT');
      else v_response := jsonb_build_object('status', 200, 'folder', v_row); end if;
    end if;
  elsif p_kind = 'folder.remove' then
    if not exists (select 1 from public.folders where user_id = v_user_id and id = p_entity_id) then
      v_response := jsonb_build_object('status', 200);
    else
      if v_expected is not null and exists (select 1 from public.folders where user_id = v_user_id and id = p_entity_id and sync_version <> v_expected) then
        v_response := jsonb_build_object('status', 409, 'code', 'CONFLICT');
      else
        update public.meetings set folder_id = null, updated_at = v_updated_at, sync_version = sync_version + 1
        where user_id = v_user_id and folder_id = p_entity_id;
        delete from public.folders where user_id = v_user_id and id = p_entity_id;
        v_response := jsonb_build_object('status', 200);
      end if;
    end if;
  else
    v_response := jsonb_build_object('status', 400, 'code', 'INVALID_OPERATION');
  end if;

  insert into public.catalog_mutation_replays (user_id, operation_id, operation_kind, request_fingerprint, response)
  values (v_user_id, p_operation_id, p_kind, v_fingerprint, v_response);
  return v_response;
end;
$function$;

create or replace function public.apply_catalog_mutation(
  p_operation_id uuid,
  p_kind text,
  p_entity_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if auth.uid() is null then
    return jsonb_build_object('status', 401, 'code', 'AUTH_REQUIRED');
  end if;
  return public._apply_catalog_mutation_impl(p_operation_id, p_kind, p_entity_id, p_payload);
end;
$function$;

revoke all on function public._apply_catalog_mutation_impl(uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.apply_catalog_mutation(uuid, text, uuid, jsonb) from public, anon;
revoke execute on function public.apply_catalog_mutation(uuid, text, uuid, jsonb) from anon;
revoke execute on function public.apply_catalog_mutation(uuid, text, uuid, jsonb) from public;
grant execute on function public.apply_catalog_mutation(uuid, text, uuid, jsonb) to authenticated;
