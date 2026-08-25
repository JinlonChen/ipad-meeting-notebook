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
  if (!url || !anonKey) throw new SupabaseConfigurationError();

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
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

  let parsedRelayUrl: URL | undefined;
  try {
    parsedRelayUrl = transcriptionRelayUrl ? new URL(transcriptionRelayUrl) : undefined;
  } catch {
    parsedRelayUrl = undefined;
  }
  const relayIsSecure = parsedRelayUrl
    ? parsedRelayUrl.protocol === "https:" || parsedRelayUrl.protocol === "wss:"
    : false;
  const relayIsLocal = parsedRelayUrl
    ? (parsedRelayUrl.protocol === "http:" || parsedRelayUrl.protocol === "ws:")
      && localHttpHosts.has(parsedRelayUrl.hostname)
    : false;
  const resolvedRelayUrl = parsedRelayUrl
    && (relayIsSecure || relayIsLocal)
    && !parsedRelayUrl.username
    && !parsedRelayUrl.password
    && parsedRelayUrl.pathname === "/"
    && !parsedRelayUrl.search
    && !parsedRelayUrl.hash
    ? parsedRelayUrl.origin
    : parsedUrl.origin;

  return {
    url: parsedUrl.origin,
    anonKey,
    transcriptionRelayUrl: resolvedRelayUrl,
  };
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
