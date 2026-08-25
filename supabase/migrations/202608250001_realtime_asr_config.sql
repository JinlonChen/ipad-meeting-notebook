alter table public.ai_provider_credentials
  drop constraint if exists ai_provider_credentials_transcription_base_url_check;

update public.ai_provider_credentials
set transcription_base_url = 'wss://llm-gctiyfgr4e625ujt.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
    transcription_model = 'qwen3-asr-flash-realtime';

alter table public.ai_provider_credentials
  add constraint ai_provider_credentials_transcription_base_url_check
  check (transcription_base_url ~ '^wss://[^[:space:]]+$');
