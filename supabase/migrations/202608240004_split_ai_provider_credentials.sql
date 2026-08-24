alter table public.ai_provider_credentials
  add column transcription_base_url text,
  add column transcription_model text,
  add column transcription_api_key text,
  add column summary_base_url text,
  add column summary_model text,
  add column summary_api_key text;

update public.ai_provider_credentials
set transcription_base_url = base_url,
    transcription_model = asr_model,
    transcription_api_key = api_key,
    summary_base_url = base_url,
    summary_model = chat_model,
    summary_api_key = api_key;

alter table public.ai_provider_credentials
  alter column base_url drop not null,
  alter column asr_model drop not null,
  alter column chat_model drop not null,
  alter column api_key drop not null,
  alter column transcription_base_url set not null,
  alter column transcription_model set not null,
  alter column transcription_api_key set not null,
  alter column summary_base_url set not null,
  alter column summary_model set not null,
  alter column summary_api_key set not null;

alter table public.ai_provider_credentials
  drop constraint IF EXISTS ai_provider_credentials_base_url_check,
  drop constraint IF EXISTS ai_provider_credentials_asr_model_check,
  drop constraint IF EXISTS ai_provider_credentials_chat_model_check,
  drop constraint IF EXISTS ai_provider_credentials_api_key_check,
  add constraint ai_provider_credentials_transcription_base_url_check check (transcription_base_url ~ '^https://[^[:space:]]+$'),
  add constraint ai_provider_credentials_transcription_model_check check (char_length(transcription_model) between 1 and 200),
  add constraint ai_provider_credentials_transcription_api_key_check check (octet_length(transcription_api_key) between 1 and 4096),
  add constraint ai_provider_credentials_summary_base_url_check check (summary_base_url ~ '^https://[^[:space:]]+$'),
  add constraint ai_provider_credentials_summary_model_check check (char_length(summary_model) between 1 and 200),
  add constraint ai_provider_credentials_summary_api_key_check check (octet_length(summary_api_key) between 1 and 4096);

update public.ai_provider_credentials
set base_url = null,
    asr_model = null,
    chat_model = null,
    api_key = null;
