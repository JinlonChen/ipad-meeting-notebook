create table public.ai_provider_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  base_url text not null check (base_url ~ '^https://[^[:space:]]+$'),
  asr_model text not null check (char_length(asr_model) between 1 and 200),
  chat_model text not null check (char_length(chat_model) between 1 and 200),
  api_key text not null check (octet_length(api_key) between 1 and 4096),
  updated_at timestamptz not null default now()
);

create table public.meeting_intelligence_jobs (
  user_id uuid not null,
  meeting_id uuid not null,
  status text not null check (status in ('queued', 'processing', 'ready', 'failed')),
  error_code text check (error_code is null or char_length(error_code) between 1 and 120),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (user_id, meeting_id),
  foreign key (user_id, meeting_id) references public.meetings(user_id, id) on delete cascade,
  check ((status in ('queued', 'processing')) = (completed_at is null)),
  check ((status = 'failed') = (error_code is not null))
);

create table public.meeting_transcript_segments (
  user_id uuid not null,
  id uuid not null,
  meeting_id uuid not null,
  position integer not null check (position >= 0),
  text text not null check (char_length(btrim(text)) between 1 and 20000),
  started_offset_ms bigint not null check (started_offset_ms >= 0),
  ended_offset_ms bigint not null check (ended_offset_ms > started_offset_ms),
  speaker text check (speaker is null or char_length(btrim(speaker)) between 1 and 120),
  source text not null check (source in ('asr', 'edited')),
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, meeting_id, position),
  foreign key (user_id, meeting_id) references public.meetings(user_id, id) on delete cascade
);

create table public.meeting_minutes (
  user_id uuid not null,
  meeting_id uuid not null,
  summary text not null check (char_length(btrim(summary)) between 1 and 20000),
  topics jsonb not null default '[]'::jsonb check (jsonb_typeof(topics) = 'array'),
  decisions jsonb not null default '[]'::jsonb check (jsonb_typeof(decisions) = 'array'),
  risks jsonb not null default '[]'::jsonb check (jsonb_typeof(risks) = 'array'),
  actions jsonb not null default '[]'::jsonb check (jsonb_typeof(actions) = 'array'),
  provider text not null check (char_length(provider) between 1 and 200),
  model text not null check (char_length(model) between 1 and 200),
  generated_at timestamptz not null default now(),
  primary key (user_id, meeting_id),
  foreign key (user_id, meeting_id) references public.meetings(user_id, id) on delete cascade
);

alter table public.ai_provider_credentials enable row level security;
alter table public.meeting_intelligence_jobs enable row level security;
alter table public.meeting_transcript_segments enable row level security;
alter table public.meeting_minutes enable row level security;

revoke all on public.ai_provider_credentials from public, anon, authenticated;
revoke all on public.meeting_intelligence_jobs from public, anon;
revoke all on public.meeting_transcript_segments from public, anon;
revoke all on public.meeting_minutes from public, anon;
revoke insert, update, delete on public.meeting_intelligence_jobs from authenticated;
revoke insert, update, delete on public.meeting_transcript_segments from authenticated;
revoke insert, update, delete on public.meeting_minutes from authenticated;
grant select on public.meeting_intelligence_jobs to authenticated;
grant select on public.meeting_transcript_segments to authenticated;
grant select on public.meeting_minutes to authenticated;

create policy meeting_intelligence_jobs_owner_select
on public.meeting_intelligence_jobs
for select to authenticated
using (auth.uid() = user_id);

create policy meeting_transcript_segments_owner_select
on public.meeting_transcript_segments
for select to authenticated
using (auth.uid() = user_id);

create policy meeting_minutes_owner_select
on public.meeting_minutes
for select to authenticated
using (auth.uid() = user_id);

create or replace function public.ai_provider_configured()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select auth.uid() is not null
    and exists (
      select 1
      from public.ai_provider_credentials
      where user_id = auth.uid()
    );
$function$;

revoke all on function public.ai_provider_configured() from public, anon;
grant execute on function public.ai_provider_configured() to authenticated;
