interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_TRANSCRIPTION_RELAY_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
