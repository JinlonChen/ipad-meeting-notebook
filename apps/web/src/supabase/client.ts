import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "./types.js";

export type SupabaseEnvironment = {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  VITE_TRANSCRIPTION_RELAY_URL?: string;
};

type SupabaseConfig = {
  url: string;
  anonKey: string;
  transcriptionRelayUrl: string;
};

export class SupabaseConfigurationError extends Error {
  constructor() {
    super("SUPABASE_CONFIGURATION_REQUIRED");
    this.name = "SupabaseConfigurationError";
  }
}

const localHttpHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function readSupabaseConfig(environment: SupabaseEnvironment): SupabaseConfig {
  const url = environment.VITE_SUPABASE_URL?.trim();
  const anonKey = environment.VITE_SUPABASE_ANON_KEY?.trim();
  const transcriptionRelayUrl = environment.VITE_TRANSCRIPTION_RELAY_URL?.trim();
  if (!url || !anonKey || !transcriptionRelayUrl) throw new SupabaseConfigurationError();

  let parsedUrl: URL;
  let parsedRelayUrl: URL;
  try {
    parsedUrl = new URL(url);
    parsedRelayUrl = new URL(transcriptionRelayUrl);
  } catch {
    throw new SupabaseConfigurationError();
  }

  const isHttps = parsedUrl.protocol === "https:";
  const isLocalHttp = parsedUrl.protocol === "http:" && localHttpHosts.has(parsedUrl.hostname);
  const hasUserInfo = Boolean(parsedUrl.username || parsedUrl.password);
  const hasNonRootPath = parsedUrl.pathname !== "/";
  const hasSearchOrHash = Boolean(parsedUrl.search || parsedUrl.hash);
  if ((!isHttps && !isLocalHttp) || hasUserInfo || hasNonRootPath || hasSearchOrHash) {
    throw new SupabaseConfigurationError();
  }

  const relayIsSecure = parsedRelayUrl.protocol === "https:" || parsedRelayUrl.protocol === "wss:";
  const relayIsLocal = (parsedRelayUrl.protocol === "http:" || parsedRelayUrl.protocol === "ws:")
    && localHttpHosts.has(parsedRelayUrl.hostname);
  if (
    (!relayIsSecure && !relayIsLocal)
    || parsedRelayUrl.username
    || parsedRelayUrl.password
    || parsedRelayUrl.pathname !== "/"
    || parsedRelayUrl.search
    || parsedRelayUrl.hash
  ) throw new SupabaseConfigurationError();

  return { url: parsedUrl.origin, anonKey, transcriptionRelayUrl: parsedRelayUrl.origin };
}

export function createMeetingSupabaseClient(config: SupabaseConfig): SupabaseClient<Database> {
  return createClient<Database>(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}
