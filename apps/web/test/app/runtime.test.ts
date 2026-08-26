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
  const inkApi = {} as ReturnType<RuntimeDependencies["createInkApi"]>;
  const inkRepository = {} as ReturnType<RuntimeDependencies["createInkRepository"]>;
  const inkSynchronizer = {} as ReturnType<RuntimeDependencies["createInkSynchronizer"]>;
  return {
    readConfig: vi.fn().mockReturnValue({
      url: "https://project.supabase.co",
      anonKey: "public-value",
      transcriptionRelayUrl: "https://relay.example.com",
    }),
    createClient: vi.fn().mockReturnValue(client),
    createRepository: vi.fn().mockReturnValue(repository),
    createAuth: vi.fn().mockReturnValue(auth),
    createCatalog: vi.fn().mockReturnValue(catalog),
    createSynchronizer: vi.fn().mockReturnValue(synchronizer),
    createRecordingStorage: vi.fn().mockReturnValue(recordingStorage),
    createIntelligence: vi.fn().mockReturnValue(intelligence),
    createInkApi: vi.fn().mockReturnValue(inkApi),
    createInkRepository: vi.fn().mockReturnValue(inkRepository),
    createInkSynchronizer: vi.fn().mockReturnValue(inkSynchronizer),
    ...overrides,
  };
}

describe("composeProductionApp", () => {
  test("uses one Supabase client for auth and catalog", () => {
    const deps = dependencies();
    const result = composeProductionApp({
      VITE_SUPABASE_URL: "https://project.supabase.co",
      VITE_SUPABASE_ANON_KEY: "public-value",
      VITE_TRANSCRIPTION_RELAY_URL: "https://relay.example.com",
    }, deps);
    const client = vi.mocked(deps.createClient).mock.results[0]!.value;

    expect(deps.createAuth).toHaveBeenCalledWith(client);
    expect(deps.createCatalog).toHaveBeenCalledWith(client);
    expect(deps.createRecordingStorage).toHaveBeenCalledWith(client);
    expect(deps.createIntelligence).toHaveBeenCalledWith(client, "https://relay.example.com");
    expect(deps.createInkApi).toHaveBeenCalledWith(client);
    expect(deps.createInkRepository).toHaveBeenCalledWith(vi.mocked(deps.createRepository).mock.results[0]!.value);
    expect(deps.createInkSynchronizer).toHaveBeenCalledWith(
      vi.mocked(deps.createInkRepository).mock.results[0]!.value,
      vi.mocked(deps.createInkApi).mock.results[0]!.value,
    );
    expect(result).toMatchObject({
      repository: vi.mocked(deps.createRepository).mock.results[0]!.value,
      auth: vi.mocked(deps.createAuth).mock.results[0]!.value,
      catalog: vi.mocked(deps.createCatalog).mock.results[0]!.value,
      synchronizer: vi.mocked(deps.createSynchronizer).mock.results[0]!.value,
      recordingStorage: vi.mocked(deps.createRecordingStorage).mock.results[0]!.value,
      intelligence: vi.mocked(deps.createIntelligence).mock.results[0]!.value,
      inkRepository: vi.mocked(deps.createInkRepository).mock.results[0]!.value,
      inkSynchronizer: vi.mocked(deps.createInkSynchronizer).mock.results[0]!.value,
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
