create table public.meeting_ink_strokes (
  user_id uuid not null,
  id uuid not null,
  meeting_id uuid not null,
  stroke_order bigint not null check (stroke_order >= 0),
  tool text not null check (tool in ('pen', 'highlighter')),
  color text not null check (color ~ '^#[0-9A-Fa-f]{6}$'),
  width numeric not null check (width between 1 and 40),
  points jsonb not null check (
    jsonb_typeof(points) = 'array'
    and jsonb_array_length(points) between 2 and 2048
    and octet_length(points::text) <= 524288
  ),
  version integer not null check (version > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, meeting_id) references public.meetings(user_id, id) on delete cascade
);

create index meeting_ink_strokes_meeting_order_idx
  on public.meeting_ink_strokes(user_id, meeting_id, stroke_order);

create table public.meeting_ink_mutations (
  user_id uuid not null references auth.users(id) on delete cascade,
  mutation_id uuid not null,
  stroke_id uuid not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, mutation_id)
);

alter table public.meeting_ink_strokes enable row level security;
alter table public.meeting_ink_mutations enable row level security;

revoke all on public.meeting_ink_strokes from public, anon;
revoke insert, update, delete on public.meeting_ink_strokes from authenticated;
grant select on public.meeting_ink_strokes to authenticated;
revoke all on public.meeting_ink_mutations from public, anon, authenticated;

create policy meeting_ink_strokes_owner_select
on public.meeting_ink_strokes
for select to authenticated
using (auth.uid() = user_id);

create or replace function public.apply_meeting_ink_mutation(
  p_mutation_id uuid,
  p_stroke jsonb,
  p_expected_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_allowed_keys text[] := array['id','meetingId','order','tool','color','width','points','deleted','version'];
  v_allowed_point_keys text[] := array['x','y','pressure','elapsedMs'];
  v_unknown_keys text[];
  v_existing jsonb;
  v_result jsonb;
  v_id uuid;
  v_meeting_id uuid;
  v_order bigint;
  v_tool text;
  v_color text;
  v_width numeric;
  v_points jsonb;
  v_deleted boolean;
  v_version integer;
begin
  if v_user_id is null or v_user_id <> p_expected_user_id then
    raise exception 'AUTH_REQUIRED' using errcode = 'P0001';
  end if;

  select response into v_existing
  from public.meeting_ink_mutations
  where user_id = v_user_id and mutation_id = p_mutation_id;
  if found then return v_existing; end if;

  if jsonb_typeof(p_stroke) is distinct from 'object' then
    return jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
  end if;
  select coalesce(array_agg(key), array[]::text[]) into v_unknown_keys
  from jsonb_object_keys(p_stroke) key
  where not (key = any(v_allowed_keys));
  if cardinality(v_unknown_keys) > 0 or not (p_stroke ?& v_allowed_keys) then
    return jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
  end if;

  if jsonb_typeof(p_stroke->'id') is distinct from 'string'
    or jsonb_typeof(p_stroke->'meetingId') is distinct from 'string'
    or jsonb_typeof(p_stroke->'order') is distinct from 'number'
    or jsonb_typeof(p_stroke->'tool') is distinct from 'string'
    or jsonb_typeof(p_stroke->'color') is distinct from 'string'
    or jsonb_typeof(p_stroke->'width') is distinct from 'number'
    or jsonb_typeof(p_stroke->'points') is distinct from 'array'
    or jsonb_typeof(p_stroke->'deleted') is distinct from 'boolean'
    or jsonb_typeof(p_stroke->'version') is distinct from 'number' then
    return jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
  end if;

  begin
    v_id := (p_stroke->>'id')::uuid;
    v_meeting_id := (p_stroke->>'meetingId')::uuid;
    v_order := (p_stroke->>'order')::bigint;
    v_tool := p_stroke->>'tool';
    v_color := p_stroke->>'color';
    v_width := (p_stroke->>'width')::numeric;
    v_points := p_stroke->'points';
    v_deleted := (p_stroke->>'deleted')::boolean;
    v_version := (p_stroke->>'version')::integer;
  exception when others then
    return jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
  end;

  if jsonb_array_length(v_points) not between 2 and 2048
    or octet_length(v_points::text) > 524288 then
    return jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_points) point
    where jsonb_typeof(point) is distinct from 'object'
  ) then
    return jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_points) point
    where not (point ?& v_allowed_point_keys)
      or exists (
        select 1 from jsonb_object_keys(point) key
        where not (key = any(v_allowed_point_keys))
      )
  ) then
    return jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_points) point
    where jsonb_typeof(point->'x') is distinct from 'number'
      or jsonb_typeof(point->'y') is distinct from 'number'
      or jsonb_typeof(point->'pressure') is distinct from 'number'
      or jsonb_typeof(point->'elapsedMs') is distinct from 'number'
  ) then
    return jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
  end if;

  begin
    if exists (
      select 1 from jsonb_array_elements(v_points) point
      where (point->>'x')::numeric not between 0 and 2048
        or (point->>'y')::numeric not between 0 and 200000
        or (point->>'pressure')::numeric not between 0 and 1
        or (point->>'elapsedMs')::numeric not between 0 and 86400000
        or (point->>'elapsedMs')::numeric <> trunc((point->>'elapsedMs')::numeric)
    ) then
      return jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
    end if;
  exception when others then
    return jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
  end;

  if v_order < 0 or v_tool not in ('pen', 'highlighter')
    or v_color !~ '^#[0-9A-Fa-f]{6}$' or v_width not between 1 and 40 or v_version < 1
    or not exists (
      select 1 from public.meetings
      where user_id = v_user_id and id = v_meeting_id and status <> 'trashed'
    ) then
    return jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
  end if;

  insert into public.meeting_ink_strokes (
    user_id, id, meeting_id, stroke_order, tool, color, width, points, version, deleted_at, updated_at
  ) values (
    v_user_id, v_id, v_meeting_id, v_order, v_tool, lower(v_color), v_width, v_points, v_version,
    case when v_deleted then now() else null end, now()
  )
  on conflict (user_id, id) do update set
    stroke_order = excluded.stroke_order,
    tool = excluded.tool,
    color = excluded.color,
    width = excluded.width,
    points = excluded.points,
    version = excluded.version,
    deleted_at = excluded.deleted_at,
    updated_at = now()
  where excluded.version >= meeting_ink_strokes.version;

  select jsonb_build_object(
    'id', id, 'meetingId', meeting_id, 'order', stroke_order, 'tool', tool,
    'color', color, 'width', width, 'points', points,
    'deleted', deleted_at is not null, 'version', version
  ) into v_result
  from public.meeting_ink_strokes
  where user_id = v_user_id and id = v_id;

  insert into public.meeting_ink_mutations(user_id, mutation_id, stroke_id, response)
  values (v_user_id, p_mutation_id, v_id, v_result)
  on conflict (user_id, mutation_id) do nothing;
  return v_result;
end;
$function$;

revoke all on function public.apply_meeting_ink_mutation(uuid, jsonb, uuid) from public, anon;
grant execute on function public.apply_meeting_ink_mutation(uuid, jsonb, uuid) to authenticated;
