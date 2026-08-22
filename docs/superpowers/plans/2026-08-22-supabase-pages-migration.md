# Supabase and GitHub Pages Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the production Fastify/SQLite dependency with an independent Supabase project while preserving the existing offline catalog, idempotent mutations, conflict resolution, and installable iPad PWA, then publish it free through GitHub Pages.

**Architecture:** Keep `MeetingCatalogRepository`, Dexie, `CatalogSync`, and the existing UI as the local-first core. Add a Supabase auth adapter and a `MeetingCatalogApi` adapter backed by user-scoped Postgres tables plus one transactional mutation RPC. Build the PWA for a configurable GitHub Pages base path; the legacy Fastify workspace remains buildable and tested but is no longer used by the production web entry point.

**Tech Stack:** TypeScript, React 19, Dexie, Zod, Supabase JS, PostgreSQL/PLpgSQL/RLS, Vite, vite-plugin-pwa, Vitest, Playwright, GitHub Actions/Pages.

---

## File Map

- `apps/web/src/supabase/client.ts`: runtime configuration and injectable Supabase client creation.
- `apps/web/src/supabase/types.ts`: minimal generated-style database/RPC row types used by the web adapter.
- `apps/web/src/auth/api.ts`: Supabase-backed auth boundary with safe errors.
- `apps/web/src/auth/LoginPage.tsx`: email and password login form.
- `apps/web/src/meetings/api.ts`: Supabase catalog adapter and row/contract mapping.
- `apps/web/src/app/App.tsx`: default Supabase composition while preserving dependency injection and offline device access.
- `apps/web/src/main.tsx`: production dependency construction and router base-path input.
- `apps/web/src/vite-env.d.ts`: typed Vite variables.
- `supabase/migrations/202608220001_meeting_catalog.sql`: tables, RLS, grants, indexes, mutation RPC, and deterministic replay.
- `supabase/tests/meeting_catalog.sql`: pgTAP ownership, replay, conflict, and not-found tests.
- `apps/web/vite.config.ts`: configurable Pages base path and base-aware PWA manifest.
- `apps/web/playwright.config.ts`: root and Pages-subpath test configuration.
- `apps/web/e2e/install-and-offline.spec.ts`: base-aware install, offline, and cache assertions.
- `.github/workflows/ci.yml`: tests, typecheck, build, secret scan, and SQL validation.
- `.github/workflows/deploy-pages.yml`: Pages build and deploy with Supabase public configuration.
- `.env.example`: only public Supabase web configuration for local development.
- `README.md`: local Supabase setup, deployment, iPad install, and explicit 48-hour future audio rule.

### Task 1: Supabase client boundary and runtime configuration

**Files:**
- Modify: `apps/web/package.json`
- Modify: `package-lock.json`
- Create: `apps/web/src/supabase/client.ts`
- Create: `apps/web/src/supabase/types.ts`
- Create: `apps/web/src/vite-env.d.ts`
- Create: `apps/web/test/supabase/client.test.ts`

- [ ] **Step 1: Add a failing runtime-config test**

Test exact behavior: trimmed `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` produce a client config; a missing, malformed, or non-HTTPS production URL throws `SupabaseConfigurationError` without including the key in its message. Local Supabase URLs may use HTTP only for `localhost`, `127.0.0.1`, or `[::1]`.

```ts
expect(readSupabaseConfig({
  VITE_SUPABASE_URL: "https://project.supabase.co",
  VITE_SUPABASE_ANON_KEY: "public-anon-value",
})).toEqual({ url: "https://project.supabase.co", anonKey: "public-anon-value" });
expect(() => readSupabaseConfig({ VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "secret" }))
  .toThrowError(new SupabaseConfigurationError());
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -w @meeting/web -- --run test/supabase/client.test.ts`

Expected: FAIL because `src/supabase/client.ts` does not exist.

- [ ] **Step 3: Install Supabase JS and implement the boundary**

Run: `npm install @supabase/supabase-js -w @meeting/web`

Implement these public types and functions:

```ts
export type SupabaseEnvironment = {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
};
export class SupabaseConfigurationError extends Error {
  constructor() { super("SUPABASE_CONFIGURATION_REQUIRED"); this.name = "SupabaseConfigurationError"; }
}
export function readSupabaseConfig(environment: SupabaseEnvironment): { url: string; anonKey: string };
export function createMeetingSupabaseClient(config: { url: string; anonKey: string }): SupabaseClient<Database>;
```

Use `createClient` with `persistSession: true`, `autoRefreshToken: true`, and `detectSessionInUrl: true`. `types.ts` must define `folders`, `meetings`, and `catalog_mutation_replays` rows plus `apply_catalog_mutation` arguments/result; do not use `any` in the application adapter.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -w @meeting/web -- --run test/supabase/client.test.ts`

Expected: PASS.

Run: `npm run typecheck -w @meeting/web`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json package-lock.json apps/web/src/supabase apps/web/src/vite-env.d.ts apps/web/test/supabase/client.test.ts
git commit -m "feat: add Supabase web client boundary"
```

### Task 2: Email/password Supabase authentication

**Files:**
- Modify: `apps/web/src/auth/api.ts`
- Modify: `apps/web/src/auth/LoginPage.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/test/auth/api.test.ts`
- Modify: `apps/web/test/auth/App.test.tsx`
- Create: `apps/web/test/auth/LoginPage.test.tsx`

- [ ] **Step 1: Write failing auth-adapter and form tests**

Cover: `getUser()` produces `{ id, sessionExpiresAt }`; `signInWithPassword({email,password})`; `signOut()`; network failures become `AuthNetworkError`; 401/invalid credentials become safe `AuthApiError`; the form submits both fields, uses `autocomplete="email"` and `current-password`, and clears only the password after failure or completion.

```ts
export type AuthApi = {
  me(): Promise<{ id: string; sessionExpiresAt: string }>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
};
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -w @meeting/web -- --run test/auth/api.test.ts test/auth/LoginPage.test.tsx test/auth/App.test.tsx`

Expected: FAIL because the current API accepts only a password and uses `/api/auth/*`.

- [ ] **Step 3: Implement Supabase auth without retaining credentials**

`authApi(client)` must call `client.auth.getUser()`, read the active session expiry through `getSession()`, and validate UUID/user/expiry before authorizing the device marker. `login` calls `signInWithPassword`; `logout` calls `signOut`. Error messages and stored Dexie state must never contain email, password, JWT, refresh token, or raw Supabase error text.

`LoginPage` becomes:

```tsx
type Props = { onLogin: (email: string, password: string) => Promise<void>; offline?: boolean };
// labels: 邮箱, 密码; button: 登录; no registration link
```

Update App login generations and stale-session tests to pass both fields while retaining offline device authorization, explicit logout, 401 pause, and unmount protection.

- [ ] **Step 4: Run focused tests and typecheck**

Run the Step 2 command; expected PASS.

Run: `npm run typecheck -w @meeting/web`; expected exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/auth apps/web/src/app/App.tsx apps/web/test/auth
git commit -m "feat: authenticate meeting notebook with Supabase"
```

### Task 3: User-scoped catalog schema, RLS, and mutation RPC

**Files:**
- Create: `supabase/config.toml`
- Create: `supabase/migrations/202608220001_meeting_catalog.sql`
- Create: `supabase/tests/meeting_catalog.sql`
- Create: `test/supabase-schema.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write RED schema contract and pgTAP tests**

The lightweight Node contract test must read the migration and assert that all three tables enable RLS, direct mutation grants are revoked, authenticated select policies are user-scoped, the RPC is authenticated-only, and `search_path` is fixed. pgTAP must create two auth users and prove cross-user reads and mutations are impossible.

Run: `node --test test/supabase-schema.test.mjs`

Expected: FAIL because the migration does not exist.

- [ ] **Step 2: Create exact tables and constraints**

Create:

```sql
public.folders(
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  sync_version bigint not null check (sync_version >= 0),
  primary key (user_id, id)
);
public.meetings(
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  folder_id uuid,
  status text not null check (status in ('draft','recording','recoverable','uploading','processing','ready','failed','trashed')),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  trashed_at timestamptz,
  sync_version bigint not null check (sync_version >= 0),
  primary key (user_id, id),
  foreign key (user_id, folder_id) references public.folders(user_id, id)
);
public.catalog_mutation_replays(
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  operation_kind text not null,
  request_fingerprint text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, operation_id)
);
```

Enable RLS on every table. Grant authenticated users only `select` on folders/meetings; revoke direct insert/update/delete from `anon` and `authenticated`. Policies must use `auth.uid() = user_id`.

- [ ] **Step 3: Implement one transactional RPC**

Create `public.apply_catalog_mutation(p_operation_id uuid, p_kind text, p_entity_id uuid, p_payload jsonb) returns jsonb`, `language plpgsql`, `security invoker`, `set search_path = pg_catalog, public`. It must:

1. Reject missing `auth.uid()` with `{status:401, code:'AUTH_REQUIRED'}`.
2. Compute a canonical fingerprint from kind/entity/payload.
3. Return the saved replay for a matching operation ID and fingerprint; return `{status:409, code:'IDEMPOTENCY_KEY_REUSED'}` for a mismatch.
4. Handle all seven current outbox kinds: meeting create/rename/trash/restore and folder create/rename/remove.
5. Enforce `expectedSyncVersion` when present, increment version exactly once, and return `{status:409, code:'CONFLICT'}` on stale writes.
6. Return typed `MEETING_NOT_FOUND`/`FOLDER_NOT_FOUND` only for the same operation combinations already recognized by `CatalogSync`.
7. Treat `folder.remove + FOLDER_NOT_FOUND` as deterministic success.
8. On folder removal, set owned meetings' `folder_id` to null before deleting the folder.
9. Persist the final success or typed failure response in the replay table before returning it.

Grant execute only to `authenticated`; revoke from `public` and `anon`.

- [ ] **Step 4: Run SQL contract tests and, when Docker is available, pgTAP**

Run: `node --test test/supabase-schema.test.mjs`

Expected: PASS.

Run: `npx supabase test db`

Expected: pgTAP PASS when a local Supabase stack is available. If Docker is unavailable, record this as a deployment-gate test and run it against the provisioned project before publishing.

- [ ] **Step 5: Commit**

```bash
git add supabase test/supabase-schema.test.mjs package.json
git commit -m "feat: add Supabase catalog schema and mutation RPC"
```

### Task 4: Supabase catalog adapter

**Files:**
- Modify: `apps/web/src/meetings/api.ts`
- Modify: `apps/web/test/meetings/api.test.ts`
- Create: `apps/web/test/meetings/supabase-integration.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Use an injectable minimal Supabase client fake and test exact RPC parameters for every outbox kind, snake_case-to-contract mapping, deterministic replay responses, pull ordering, auth errors, generic errors, 409 conflicts, typed 404 conflicts, malformed rows, and no raw error persistence.

```ts
const api = new MeetingCatalogSupabaseApi(client);
await api.send(operation);
expect(client.rpc).toHaveBeenCalledWith("apply_catalog_mutation", {
  p_operation_id: operation.id,
  p_kind: operation.kind,
  p_entity_id: operation.entityId,
  p_payload: operation.payload,
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -w @meeting/web -- --run test/meetings/api.test.ts test/meetings/supabase-integration.test.ts test/meetings/sync.test.ts`

Expected: FAIL because only `MeetingCatalogHttpApi` exists.

- [ ] **Step 3: Implement the adapter**

Export `MeetingCatalogSupabaseApi implements MeetingCatalogApi`. Parse every row through `FolderSchema`/`MeetingSchema` after explicit key conversion. Treat Supabase auth failures as `CatalogApiError(401, 'AUTH_REQUIRED')`; map RPC `{status,code}` to the existing `CatalogApiError`; reject missing/malformed results as `REQUEST_FAILED`. Each list method validates its complete response before returning; the existing `CatalogSync.refresh()` continues to fetch both lists concurrently and applies them to Dexie in one repository transaction only after both succeed.

Keep `MeetingCatalogHttpApi` only if legacy API tests still require it; production composition must use the Supabase adapter.

- [ ] **Step 4: Run focused and full web tests**

Run the Step 2 command; expected PASS.

Run: `npm test -w @meeting/web`; expected all web tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/meetings/api.ts apps/web/test/meetings
git commit -m "feat: sync meeting catalog through Supabase"
```

### Task 5: Production composition and offline session behavior

**Files:**
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/test/auth/App.test.tsx`
- Modify: `apps/web/e2e/install-and-offline.spec.ts`

- [ ] **Step 1: Write failing composition tests**

Prove the default production graph uses one Supabase client for auth and catalog, while injected test dependencies still bypass runtime environment reads. Preserve the offline-lock rule: a previously authorized device may open the local catalog offline until the Supabase session expiry, but a fresh/expired device must log in online.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -w @meeting/web -- --run test/auth/App.test.tsx`

Expected: FAIL because the default graph still creates `authApi()` and `MeetingCatalogHttpApi()`.

- [ ] **Step 3: Move runtime construction to `main.tsx`**

Construct the Supabase client once, then create `authApi(client)`, `MeetingCatalogSupabaseApi(client)`, `MeetingCatalogRepository`, and `CatalogSync`. Pass all four to `App`. `App` remains renderable with injected dependencies and must display a non-secret configuration panel if runtime config is absent; never render the URL key or underlying error object.

Use the Supabase user's actual JWT expiry for `authorizeDevice`. Explicit logout clears the device marker but retains local meetings and outbox, matching existing behavior.

- [ ] **Step 4: Run auth, sync, offline E2E, and typecheck**

Run: `npm test -w @meeting/web -- --run test/auth/App.test.tsx test/meetings/sync.test.ts`

Run: `npm run test:e2e -w @meeting/web -- --grep "installs the meeting notebook shell"`

Run: `npm run typecheck -w @meeting/web`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/App.tsx apps/web/src/main.tsx apps/web/test/auth/App.test.tsx apps/web/e2e/install-and-offline.spec.ts
git commit -m "feat: compose the PWA with Supabase services"
```

### Task 6: GitHub Pages base path and PWA

**Files:**
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/playwright.config.ts`
- Modify: `apps/web/e2e/install-and-offline.spec.ts`
- Create: `apps/web/e2e/pages-base-path.spec.ts`

- [ ] **Step 1: Add a failing Pages-subpath E2E**

Build with `VITE_BASE_PATH=/ipad-meeting-notebook/`, serve the repository root, and verify `/ipad-meeting-notebook/` loads, manifest `start_url`/`scope` and all icons stay under that prefix, the service worker controls the page, reload works, and no Supabase request is added to Cache Storage.

- [ ] **Step 2: Run the focused E2E and verify RED**

Run: `npm run test:e2e -w @meeting/web -- --grep "GitHub Pages base path"`

Expected: FAIL because manifest and router paths are rooted at `/`.

- [ ] **Step 3: Implement one normalized base path**

Normalize `VITE_BASE_PATH` to one leading and trailing slash. Feed it to Vite `base`, PWA `start_url`, `scope`, icon URLs, and `BrowserRouter basename`. Local default remains `/`. The Service Worker continues to precache only built assets and must not add cross-origin Supabase runtime caching.

- [ ] **Step 4: Run both root and subpath E2E suites**

Run: `npm run test:e2e -w @meeting/web`

Expected: all existing accessibility/offline tests and the Pages-subpath test PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/vite.config.ts apps/web/src/app/App.tsx apps/web/playwright.config.ts apps/web/e2e
git commit -m "feat: support installable GitHub Pages builds"
```

### Task 7: CI, Pages deployment, and operator documentation

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/deploy-pages.yml`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Add failing workflow/document contract tests**

Create `test/deployment-files.test.mjs` that verifies Node 22, `npm ci`, typecheck, full tests, build, E2E, SQL contract test, Pages permissions, artifact path `apps/web/dist`, `VITE_BASE_PATH`, and only public Supabase web variables in the Pages workflow. Assert no `SERVICE_ROLE`, password, AI key, or real project URL appears.

Run: `node --test test/deployment-files.test.mjs`

Expected: FAIL because workflows do not exist.

- [ ] **Step 2: Implement CI and Pages workflows**

CI runs on pull requests and `main`; Pages deploy runs on `main` and manual dispatch. Build environment:

```yaml
env:
  VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
  VITE_SUPABASE_ANON_KEY: ${{ secrets.VITE_SUPABASE_ANON_KEY }}
  VITE_BASE_PATH: /${{ github.event.repository.name }}/
```

Use `actions/configure-pages`, `actions/upload-pages-artifact` with `apps/web/dist`, and `actions/deploy-pages`. No service-role secret is used by the static build.

- [ ] **Step 3: Update local and deployment instructions**

`.env.example` contains only empty/placeholder public values. README gives exact local commands, Supabase migration order, user creation, GitHub secret names, Pages enablement, iPad install, offline verification, and the rule that recording is not implemented in this phase. Document future 48-hour deletion for cloud and local audio, including next-launch cleanup when the PWA was closed.

- [ ] **Step 4: Run deployment contracts and full verification**

Run: `node --test test/deployment-files.test.mjs test/supabase-schema.test.mjs`

Run: `npm run typecheck`

Run: `npm test`

Run: `npm run build`

Run: `npm run test:e2e`

Run: `rg -n "SERVICE_ROLE|ADMIN_PASSWORD|correct horse battery staple|API_KEY|API_SECRET" apps/web/dist`

Expected: all commands exit 0 except `rg`, which exits 1 with no matches.

- [ ] **Step 5: Commit**

```bash
git add .github .env.example README.md package.json test
git commit -m "ci: deploy the meeting notebook to GitHub Pages"
```

### Task 8: Provision and verify the real free deployment

**Files:**
- No committed secrets.
- Update only `README.md` if real deployment reveals a missing non-secret instruction.

- [ ] **Step 1: Create external resources with user-authorized sessions**

Create a new public GitHub repository under `JinlonChen` and a separate Supabase Free project. If either site requests login, CAPTCHA, 2FA, project password, or billing confirmation, pause and ask the user to complete only that screen; do not request credentials in chat.

- [ ] **Step 2: Apply schema and create the owner account**

Apply `supabase/migrations/202608220001_meeting_catalog.sql`. Run pgTAP or equivalent real-project SQL smoke tests. Create and confirm the user's email account through Supabase Auth without exposing the password to terminal output or repository files. Disable public sign-ups after the owner account exists.

- [ ] **Step 3: Configure GitHub and publish**

Set repository secrets `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, enable Pages from GitHub Actions, push the reviewed branch to `main`, and wait for CI/Pages completion. Never add Supabase database password or service-role key to GitHub.

- [ ] **Step 4: Desktop production smoke test**

Verify the final HTTPS URL: login, create folder and meeting, rename, trash/restore, offline mutation, reconnect synchronization, logout/login persistence, PWA manifest, Service Worker, no horizontal overflow, and no secrets in bundle/network errors.

- [ ] **Step 5: Guide one-action-at-a-time iPad verification**

Ask the user sequentially to: open the URL in Safari; log in; add to Home Screen; launch standalone; create a test meeting; turn Wi-Fi off and rename it; turn Wi-Fi on; confirm the synced title on desktop. Record true iPad-only results separately from automated Chromium evidence.

- [ ] **Step 6: Final commit only if deployment docs changed**

```bash
git add README.md
git commit -m "docs: record production deployment steps"
```

Do not create an empty documentation commit.
