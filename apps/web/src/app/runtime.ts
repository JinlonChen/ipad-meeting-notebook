import { supabaseAuthApi } from "../auth/api.js";
import { MeetingCatalogSupabaseApi } from "../meetings/api.js";
import { MeetingCatalogRepository } from "../meetings/repository.js";
import { CatalogSync } from "../meetings/sync.js";
import { createSupabaseRecordingStorage } from "../recording/storage.js";
import { createSupabaseMeetingIntelligenceApi } from "../intelligence/api.js";
import {
  createMeetingSupabaseClient,
  readSupabaseConfig,
  SupabaseConfigurationError,
  type SupabaseEnvironment,
} from "../supabase/client.js";

export type RuntimeDependencies = {
  readConfig: typeof readSupabaseConfig;
  createClient: typeof createMeetingSupabaseClient;
  createRepository: () => MeetingCatalogRepository;
  createAuth: typeof supabaseAuthApi;
  createCatalog: (client: ReturnType<typeof createMeetingSupabaseClient>) => MeetingCatalogSupabaseApi;
  createSynchronizer: (repository: MeetingCatalogRepository, catalog: MeetingCatalogSupabaseApi) => CatalogSync;
  createRecordingStorage: typeof createSupabaseRecordingStorage;
  createIntelligence: typeof createSupabaseMeetingIntelligenceApi;
};

const defaultDependencies: RuntimeDependencies = {
  readConfig: readSupabaseConfig,
  createClient: createMeetingSupabaseClient,
  createRepository: () => new MeetingCatalogRepository(),
  createAuth: supabaseAuthApi,
  createCatalog: (client) => new MeetingCatalogSupabaseApi(client),
  createSynchronizer: (repository, catalog) => new CatalogSync(repository, catalog),
  createRecordingStorage: createSupabaseRecordingStorage,
  createIntelligence: createSupabaseMeetingIntelligenceApi,
};

export function composeProductionApp(environment: SupabaseEnvironment, dependencies: RuntimeDependencies = defaultDependencies) {
  let config: ReturnType<typeof readSupabaseConfig>;
  try {
    config = dependencies.readConfig(environment);
  } catch (error) {
    return error instanceof SupabaseConfigurationError
      ? { configurationError: true as const }
      : { startupError: true as const };
  }

  try {
    const client = dependencies.createClient(config);
    const repository = dependencies.createRepository();
    const auth = dependencies.createAuth(client);
    const catalog = dependencies.createCatalog(client);
    const synchronizer = dependencies.createSynchronizer(repository, catalog);
    const recordingStorage = dependencies.createRecordingStorage(client);
    const intelligence = dependencies.createIntelligence(client, config.transcriptionRelayUrl);
    return { repository, auth, catalog, synchronizer, recordingStorage, intelligence };
  } catch {
    return { startupError: true as const };
  }
}
