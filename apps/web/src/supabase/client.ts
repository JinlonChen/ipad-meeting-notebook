import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "./types.js";

export type SupabaseEnvironment = {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
};

type SupabaseConfig = {
  url: string;
  anonKey: string;
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
  if (!url || !anonKey) throw new SupabaseConfigurationError();

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new SupabaseConfigurationError();
  }

  const isHttps = parsedUrl.protocol === "https:";
  const isLocalHttp = parsedUrl.protocol === "http:" && localHttpHosts.has(parsedUrl.hostname);
  if (!isHttps && !isLocalHttp) throw new SupabaseConfigurationError();

  return { url, anonKey };
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
