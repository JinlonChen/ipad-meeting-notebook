import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, expectTypeOf, test } from "vitest";

import {
  createMeetingSupabaseClient,
  readSupabaseConfig,
  SupabaseConfigurationError,
} from "../../src/supabase/client.js";
import type { Database } from "../../src/supabase/types.js";

const anonKey = "public-anon-value-that-must-not-leak";

describe("readSupabaseConfig", () => {
  test("trims the public URL and anonymous key", () => {
    expect(readSupabaseConfig({
      VITE_SUPABASE_URL: "  https://project.supabase.co  ",
      VITE_SUPABASE_ANON_KEY: `  ${anonKey}  `,
    })).toEqual({
      url: "https://project.supabase.co",
      anonKey,
    });
  });

  test.each([
    ["missing URL", { VITE_SUPABASE_ANON_KEY: anonKey }],
    ["blank URL", { VITE_SUPABASE_URL: "  ", VITE_SUPABASE_ANON_KEY: anonKey }],
    ["missing anonymous key", { VITE_SUPABASE_URL: "https://project.supabase.co" }],
    ["blank anonymous key", { VITE_SUPABASE_URL: "https://project.supabase.co", VITE_SUPABASE_ANON_KEY: "  " }],
    ["malformed URL", { VITE_SUPABASE_URL: "not a URL", VITE_SUPABASE_ANON_KEY: anonKey }],
    ["unsupported URL protocol", { VITE_SUPABASE_URL: "ftp://localhost", VITE_SUPABASE_ANON_KEY: anonKey }],
    ["production HTTP URL", { VITE_SUPABASE_URL: "http://project.supabase.co", VITE_SUPABASE_ANON_KEY: anonKey }],
    ["localhost lookalike", { VITE_SUPABASE_URL: "http://localhost.example.com", VITE_SUPABASE_ANON_KEY: anonKey }],
  ])("rejects a %s with a fixed safe error", (_name, environment) => {
    let thrown: unknown;

    try {
      readSupabaseConfig(environment);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(new SupabaseConfigurationError());
    expect(thrown).toMatchObject({
      name: "SupabaseConfigurationError",
      message: "SUPABASE_CONFIGURATION_REQUIRED",
    });
    expect(String(thrown)).not.toContain(anonKey);
  });

  test.each([
    "http://localhost:54321",
    "http://127.0.0.1:54321",
    "http://[::1]:54321",
  ])("allows local Supabase HTTP URL %s", (url) => {
    expect(readSupabaseConfig({
      VITE_SUPABASE_URL: url,
      VITE_SUPABASE_ANON_KEY: anonKey,
    })).toEqual({ url, anonKey });
  });
});

describe("createMeetingSupabaseClient", () => {
  test("creates the typed client with persistent browser session handling", () => {
    const client = createMeetingSupabaseClient({
      url: "https://project.supabase.co",
      anonKey,
    });
    const auth = client.auth as unknown as {
      persistSession: boolean;
      autoRefreshToken: boolean;
      detectSessionInUrl: boolean;
    };

    expectTypeOf(client).toEqualTypeOf<SupabaseClient<Database>>();
    expect(auth.persistSession).toBe(true);
    expect(auth.autoRefreshToken).toBe(true);
    expect(auth.detectSessionInUrl).toBe(true);
  });
});
