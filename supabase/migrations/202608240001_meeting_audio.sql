insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'meeting-audio',
  'meeting-audio',
  false,
  104857600,
  array['audio/webm', 'audio/mp4', 'application/octet-stream']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table public.meeting_audio_chunks (
  user_id uuid not null references auth.users(id) on delete cascade,
  meeting_id uuid not null,
  sequence bigint not null check (sequence >= 0),
  bucket_id text not null default 'meeting-audio' check (bucket_id = 'meeting-audio'),
  remote_path text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 104857600),
  mime_type text not null check (char_length(mime_type) between 1 and 200),
  captured_at timestamptz not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
    check (expires_at > captured_at)
    constraint meeting_audio_chunks_expires_within_retention
      check (expires_at <= created_at + interval '48 hours'),
  primary key (user_id, meeting_id, sequence),
  foreign key (user_id, meeting_id) references public.meetings(user_id, id) on delete cascade,
  unique (bucket_id, remote_path),
  check (
    remote_path = user_id::text || '/' || meeting_id::text || '/' || sequence::text || '.webm'
    or remote_path = user_id::text || '/' || meeting_id::text || '/' || sequence::text || '.m4a'
    or remote_path = user_id::text || '/' || meeting_id::text || '/' || sequence::text || '.bin'
  )
);

create index meeting_audio_chunks_expiry_idx
on public.meeting_audio_chunks (expires_at, user_id, meeting_id, sequence);

alter table public.meeting_audio_chunks enable row level security;

revoke all on public.meeting_audio_chunks from public, anon;
revoke insert, update, delete on public.meeting_audio_chunks from authenticated;
grant select on public.meeting_audio_chunks to authenticated;
grant insert (
  user_id, meeting_id, sequence, remote_path, sha256,
  size_bytes, mime_type, captured_at, expires_at
) on public.meeting_audio_chunks to authenticated;

create policy meeting_audio_chunks_owner_select
on public.meeting_audio_chunks
for select
to authenticated
using (auth.uid() = user_id);

create policy meeting_audio_chunks_owner_insert
on public.meeting_audio_chunks
for insert
to authenticated
with check (
  auth.uid() = user_id
  and remote_path like auth.uid()::text || '/' || meeting_id::text || '/%'
);

create policy meeting_audio_objects_owner_select
on storage.objects
for select
to authenticated
using (
  bucket_id = 'meeting-audio'
  and cardinality(storage.foldername(name)) = 2
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1
    from public.meetings
    where user_id = auth.uid()
      and id::text = (storage.foldername(name))[2]
  )
);

create policy meeting_audio_objects_owner_insert
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'meeting-audio'
  and cardinality(storage.foldername(name)) = 2
  and (storage.foldername(name))[1] = auth.uid()::text
  and name ~ ('^' || auth.uid()::text || '/[0-9a-f-]{36}/[0-9]+\.(webm|m4a|bin)$')
  and exists (
    select 1
    from public.meetings
    where user_id = auth.uid()
      and id::text = (storage.foldername(name))[2]
  )
);
