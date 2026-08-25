import { describe, expect, test, vi } from "vitest";

import { composeProductionApp, type RuntimeDependencies } from "../../src/app/runtime.js";
import { SupabaseConfigurationError } from "../../src/supabase/client.js";

function dependencies(overrides: Partial<RuntimeDependencies> = {}): RuntimeDependencies {
  const client = {} as ReturnType<RuntimeDependencies["createClient"]>;
  const repository = {} as ReturnType<RuntimeDependencies["createRepository"]>;
  const auth = {} as ReturnType<RuntimeDependencies["createAuth"]>;
  const catalog = {} as ReturnType<RuntimeDependencies["createCatalog"]>;
  const synchronizer = {} as ReturnType<RuntimeDependencies["createSynchronizer"]>;
  const recordingStorage = {} as ReturnType<RuntimeDependencies["createRecordingStorage"]>;
  const intelligence = {} as ReturnType<RuntimeDependencies["createIntelligence"]>;
  return {
    readConfig: vi.fn().mockReturnValue({ url: "https://project.supabase.co", anonKey: "public-value" }),
    createClient: vi.fn().mockReturnValue(client),
    createRepository: vi.fn().mockReturnValue(repository),
    createAuth: vi.fn().mockReturnValue(auth),
    createCatalog: vi.fn().mockReturnValue(catalog),
    createSynchronizer: vi.fn().mockReturnValue(synchronizer),
    createRecordingStorage: vi.fn().mockReturnValue(recordingStorage),
    createIntelligence: vi.fn().mockReturnValue(intelligence),
    ...overrides,
  };
}

describe("composeProductionApp", () => {
  test("uses one Supabase client for auth and catalog", () => {
    const deps = dependencies();
    const result = composeProductionApp({ VITE_SUPABASE_URL: "https://project.supabase.co", VITE_SUPABASE_ANON_KEY: "public-value" }, deps);
    const client = vi.mocked(deps.createClient).mock.results[0]!.value;

    expect(deps.createAuth).toHaveBeenCalledWith(client);
    expect(deps.createCatalog).toHaveBeenCalledWith(client);
    expect(deps.createRecordingStorage).toHaveBeenCalledWith(client);
    expect(deps.createIntelligence).toHaveBeenCalledWith(client, "https://project.supabase.co");
    expect(result).toMatchObject({
      repository: vi.mocked(deps.createRepository).mock.results[0]!.value,
      auth: vi.mocked(deps.createAuth).mock.results[0]!.value,
      catalog: vi.mocked(deps.createCatalog).mock.results[0]!.value,
      synchronizer: vi.mocked(deps.createSynchronizer).mock.results[0]!.value,
      recordingStorage: vi.mocked(deps.createRecordingStorage).mock.results[0]!.value,
      intelligence: vi.mocked(deps.createIntelligence).mock.results[0]!.value,
    });
  });

  test("classifies only safe configuration errors as missing configuration", () => {
    const configFailure = dependencies({ readConfig: vi.fn(() => { throw new SupabaseConfigurationError(); }) });
    const startupFailure = dependencies({ createRepository: vi.fn(() => { throw new Error("private-value"); }) });

    expect(composeProductionApp({}, configFailure)).toEqual({ configurationError: true });
    const startupResult = composeProductionApp({}, startupFailure);
    expect(startupResult).toEqual({ startupError: true });
    expect(JSON.stringify(startupResult)).not.toContain("private-value");
  });
});
