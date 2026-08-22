import { supabaseAuthApi } from "../auth/api.js";
import { MeetingCatalogSupabaseApi } from "../meetings/api.js";
import { MeetingCatalogRepository } from "../meetings/repository.js";
import { CatalogSync } from "../meetings/sync.js";
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
};

const defaultDependencies: RuntimeDependencies = {
  readConfig: readSupabaseConfig,
  createClient: createMeetingSupabaseClient,
  createRepository: () => new MeetingCatalogRepository(),
  createAuth: supabaseAuthApi,
  createCatalog: (client) => new MeetingCatalogSupabaseApi(client),
  createSynchronizer: (repository, catalog) => new CatalogSync(repository, catalog),
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
    return { repository, auth, catalog, synchronizer };
  } catch {
    return { startupError: true as const };
  }
}
