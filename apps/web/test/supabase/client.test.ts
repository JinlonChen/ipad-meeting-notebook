import type { QueryData, SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import {
  createMeetingSupabaseClient,
  readSupabaseConfig,
  SupabaseConfigurationError,
} from "../../src/supabase/client.js";
import type { ApplyCatalogMutationResult, Database, FolderRow } from "../../src/supabase/types.js";

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({ createClient: createClientMock }));

const anonKey = "public-anon-value-that-must-not-leak";

function expectSafeConfigurationError(environment: Parameters<typeof readSupabaseConfig>[0]): void {
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
  for (const value of Object.values(environment)) {
    if (value?.trim()) expect(String(thrown)).not.toContain(value.trim());
  }
}

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
    ["https://project.supabase.co/", "https://project.supabase.co"],
    ["http://localhost:54321/", "http://localhost:54321"],
    ["http://127.0.0.1:54321/", "http://127.0.0.1:54321"],
    ["http://[::1]:54321/", "http://[::1]:54321"],
  ])("returns canonical origin %s as %s", (url, canonicalUrl) => {
    expect(readSupabaseConfig({
      VITE_SUPABASE_URL: `  ${url}  `,
      VITE_SUPABASE_ANON_KEY: anonKey,
    })).toEqual({ url: canonicalUrl, anonKey });
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
    ["HTTPS user info", { VITE_SUPABASE_URL: "https://user:pass@project.supabase.co", VITE_SUPABASE_ANON_KEY: anonKey }],
    ["local HTTP user info", { VITE_SUPABASE_URL: "http://user@localhost:54321", VITE_SUPABASE_ANON_KEY: anonKey }],
    ["non-root path", { VITE_SUPABASE_URL: "https://project.supabase.co/path", VITE_SUPABASE_ANON_KEY: anonKey }],
    ["nested path", { VITE_SUPABASE_URL: "https://project.supabase.co/path/nested/", VITE_SUPABASE_ANON_KEY: anonKey }],
    ["query", { VITE_SUPABASE_URL: "https://project.supabase.co?project=other", VITE_SUPABASE_ANON_KEY: anonKey }],
    ["hash", { VITE_SUPABASE_URL: "https://project.supabase.co#credentials", VITE_SUPABASE_ANON_KEY: anonKey }],
  ])("rejects a %s with a fixed safe error", (_name, environment) => {
    expectSafeConfigurationError(environment);
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
  beforeEach(() => {
    createClientMock.mockReset();
  });

  test("passes the URL, anonymous key, and persistent session options to Supabase", () => {
    const expectedClient = {} as SupabaseClient<Database>;
    createClientMock.mockReturnValue(expectedClient);

    const client = createMeetingSupabaseClient({
      url: "https://project.supabase.co",
      anonKey,
    });

    expect(client).toBe(expectedClient);
    expect(createClientMock).toHaveBeenCalledOnce();
    expect(createClientMock).toHaveBeenCalledWith(
      "https://project.supabase.co",
      anonKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      },
    );
  });

  test("infers folder rows and catalog mutation RPC results from Database", () => {
    const assertDatabaseInference = (client: ReturnType<typeof createMeetingSupabaseClient>) => {
      const foldersQuery = client.from("folders").select("*");
      const mutationQuery = client.rpc("apply_catalog_mutation", {
        p_operation_id: "00000000-0000-4000-8000-000000000001",
        p_kind: "meeting.rename",
        p_entity_id: "00000000-0000-4000-8000-000000000002",
        p_payload: { title: "Planning", expectedSyncVersion: 0 },
      });

      expectTypeOf<QueryData<typeof foldersQuery>>().toEqualTypeOf<FolderRow[]>();
      expectTypeOf<QueryData<typeof mutationQuery>>().toEqualTypeOf<ApplyCatalogMutationResult>();
    };

    expectTypeOf(assertDatabaseInference).toBeFunction();
  });
});
