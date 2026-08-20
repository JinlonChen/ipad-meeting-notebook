# iPad Meeting Notebook Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the installable PWA foundation, single-user authentication, offline-first meeting catalog, and tested API that later capture and AI phases extend.

**Architecture:** Use an npm-workspace TypeScript monorepo with a React PWA, a Fastify API, and shared Zod contracts. The PWA treats IndexedDB as the immediate source of truth and synchronizes an idempotent outbox to a SQLite-backed private API; the API keeps provider secrets and future media processing off the iPad.

**Tech Stack:** Node.js 22, npm workspaces, TypeScript, React 19, Vite, Fastify, Zod, better-sqlite3, Dexie, TanStack Query, React Router, vite-plugin-pwa, Vitest, Testing Library, Playwright, argon2

---

## Delivery Sequence

The approved design is intentionally split into four independently testable plans:

1. **Foundation (this plan):** workspace, contracts, authentication, meeting API, offline catalog, installable PWA.
2. **Capture and handwriting:** microphone capture, 10-second chunks, recovery queue, Apple Pencil canvas, tools, adaptive transcript drawer shell, shared clock.
3. **Transcription and meeting intelligence:** realtime ASR adapter, batch ASR, diarization, review editor, evidence-linked AI minutes, search, Markdown/PDF/text/audio export.
4. **Operations and iPad acceptance:** passkey enrollment, secret settings, object storage, backup/integrity jobs, deployment, two-hour recording tests, network-loss tests, security checks.

Do not start plan 2 until every acceptance command in this plan passes and the foundation is deployed locally.

## File Map

```text
.
├── package.json                         # workspace scripts only
├── tsconfig.base.json                   # shared strict TypeScript settings
├── .env.example                         # documented non-secret local configuration
├── .gitignore                           # secrets, databases, builds, and test artifacts
├── apps/
│   ├── api/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── app.ts                   # Fastify composition root
│   │   │   ├── config.ts                # validated environment configuration
│   │   │   ├── server.ts                # process startup and shutdown
│   │   │   ├── db/database.ts            # SQLite connection and migrations
│   │   │   ├── auth/service.ts           # password verification and opaque sessions
│   │   │   ├── auth/routes.ts            # login, logout, current-user endpoints
│   │   │   ├── meetings/repository.ts    # meeting persistence boundary
│   │   │   ├── folders/repository.ts     # folder persistence boundary
│   │   │   ├── folders/routes.ts         # folder HTTP endpoints
│   │   │   └── meetings/routes.ts        # meeting HTTP endpoints
│   │   └── test/                         # API unit and integration tests
│   └── web/
│       ├── package.json
│       ├── vite.config.ts                # React, API proxy, PWA manifest
│       ├── src/
│       │   ├── main.tsx                  # browser entry
│       │   ├── app/App.tsx               # routes and session gate
│       │   ├── auth/LoginPage.tsx
│       │   ├── meetings/local-db.ts       # Dexie schema
│       │   ├── meetings/repository.ts     # local meeting operations
│       │   ├── meetings/sync.ts           # durable outbox synchronization
│       │   └── meetings/MeetingListPage.tsx
│       └── test/                          # component and offline tests
└── packages/
    └── contracts/
        ├── package.json
        └── src/
            ├── auth.ts
            ├── meeting.ts             # meeting and folder contracts
            └── index.ts
```

Keep later recording, ink, transcript, AI, and export files out of this phase. Their public boundaries are already defined in the approved design and will be added by the next plans.

### Task 1: Create the TypeScript workspace and test harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.env.example`
- Modify: `.gitignore`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`

- [ ] **Step 1: Create the root workspace manifest**

```json
{
  "name": "ipad-meeting-notebook",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "concurrently -n api,web -c blue,green \"npm run dev -w @meeting/api\" \"npm run dev -w @meeting/web\"",
    "build": "npm run build --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "test:e2e": "npm run test:e2e -w @meeting/web"
  },
  "engines": { "node": ">=22" },
  "devDependencies": {
    "concurrently": "^9.2.0",
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 2: Create strict shared TypeScript settings**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 3: Create package manifests with explicit scripts**

`packages/contracts/package.json`:

```json
{
  "name": "@meeting/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": { "zod": "^4.0.0" },
  "devDependencies": { "vitest": "^3.2.0" }
}
```

`apps/api/package.json`:

```json
{
  "name": "@meeting/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsup src/server.ts --format esm --sourcemap --out-dir dist",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@fastify/cookie": "^11.0.0",
    "@meeting/contracts": "*",
    "argon2": "^0.44.0",
    "better-sqlite3": "^12.0.0",
    "fastify": "^5.5.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.17.0",
    "tsup": "^8.5.0",
    "tsx": "^4.20.0",
    "vitest": "^3.2.0"
  }
}
```

`apps/web/package.json`:

```json
{
  "name": "@meeting/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "typecheck": "tsc -b --pretty false",
    "test": "vitest run --passWithNoTests",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@meeting/contracts": "*",
    "@tanstack/react-query": "^5.85.0",
    "dexie": "^4.2.0",
    "lucide-react": "^0.540.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "react-router-dom": "^7.8.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.55.0",
    "@testing-library/jest-dom": "^6.8.0",
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.0",
    "@types/node": "^22.17.0",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^5.0.0",
    "fake-indexeddb": "^6.2.0",
    "jsdom": "^26.1.0",
    "vite": "^7.1.0",
    "vite-plugin-pwa": "^1.0.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 4: Create package compiler configs and the initial Vite config**

`packages/contracts/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"]
}
```

`apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["test", "dist"]
}
```

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "noEmit": true,
    "types": ["vite/client", "vite-plugin-pwa/client", "node"]
  },
  "include": ["src", "test", "e2e", "vite.config.ts", "playwright.config.ts"]
}
```

`apps/web/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8787" }
  }
});
```

Initialize `packages/contracts/src/index.ts` with `export {};` so the package is a valid module before Task 2.

- [ ] **Step 5: Document required local configuration and ignored runtime data**

```dotenv
API_PORT=8787
API_HOST=127.0.0.1
DATABASE_PATH=./data/meeting-notebook.sqlite
ADMIN_PASSWORD=replace-with-a-long-local-password
COOKIE_SECURE=false
WEB_ORIGIN=http://localhost:5173
```

Append these entries to `.gitignore` while retaining `.superpowers/`:

```gitignore
.env
data/
dist/
coverage/
test-results/
playwright-report/
```

- [ ] **Step 6: Install dependencies and capture the lock file**

Run: `npm install`

Expected: exit 0 and a new `package-lock.json` containing all three workspaces.

- [ ] **Step 7: Run the empty workspace checks**

Run: `npm run typecheck && npm test`

Expected: exit 0; Vitest reports no test files and exits successfully because the workspace scripts explicitly use `--passWithNoTests`.

- [ ] **Step 8: Commit the workspace**

```bash
git add .gitignore package.json package-lock.json tsconfig.base.json .env.example apps packages
git commit -m "chore: scaffold meeting notebook workspace"
```

### Task 2: Define shared meeting and authentication contracts

**Files:**
- Create: `packages/contracts/src/meeting.test.ts`
- Create: `packages/contracts/src/meeting.ts`
- Create: `packages/contracts/src/auth.test.ts`
- Create: `packages/contracts/src/auth.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Write failing meeting contract tests**

```ts
import { describe, expect, it } from "vitest";
import { CreateMeetingInputSchema, MeetingSchema } from "./meeting";

describe("meeting contracts", () => {
  it("accepts a client-generated id for idempotent offline creation", () => {
    const input = CreateMeetingInputSchema.parse({
      id: "018fd487-0b62-7e15-b94d-2d7b07f635b0",
      title: "产品周会",
      folderId: null,
      clientCreatedAt: "2026-08-20T10:00:00.000Z"
    });
    expect(input.title).toBe("产品周会");
  });

  it("rejects a ready meeting without an update timestamp", () => {
    const result = MeetingSchema.safeParse({
      id: "018fd487-0b62-7e15-b94d-2d7b07f635b0",
      title: "产品周会",
      folderId: null,
      status: "ready",
      startedAt: null,
      endedAt: null,
      createdAt: "2026-08-20T10:00:00.000Z",
      trashedAt: null,
      syncVersion: 1
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `npm test -w @meeting/contracts -- meeting.test.ts`

Expected: FAIL because `./meeting` does not exist.

- [ ] **Step 3: Implement the complete meeting contract**

```ts
import { z } from "zod";

export const MeetingStatusSchema = z.enum([
  "draft",
  "recording",
  "recoverable",
  "uploading",
  "processing",
  "ready",
  "failed",
  "trashed"
]);

export const CreateMeetingInputSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1).max(120),
  folderId: z.uuid().nullable(),
  clientCreatedAt: z.iso.datetime()
});

export const CreateFolderInputSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  clientCreatedAt: z.iso.datetime()
});

export const FolderSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(80),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  syncVersion: z.int().nonnegative()
});

export const MeetingSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(120),
  folderId: z.uuid().nullable(),
  status: MeetingStatusSchema,
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  trashedAt: z.iso.datetime().nullable(),
  syncVersion: z.int().nonnegative()
});

export const MeetingListQuerySchema = z.object({
  search: z.string().trim().max(120).default(""),
  includeTrashed: z.coerce.boolean().default(false)
});

export type MeetingStatus = z.infer<typeof MeetingStatusSchema>;
export type CreateMeetingInput = z.infer<typeof CreateMeetingInputSchema>;
export type Meeting = z.infer<typeof MeetingSchema>;
export type CreateFolderInput = z.infer<typeof CreateFolderInputSchema>;
export type Folder = z.infer<typeof FolderSchema>;
```

- [ ] **Step 4: Add authentication contracts and tests**

```ts
// auth.ts
import { z } from "zod";

export const LoginInputSchema = z.object({
  password: z.string().min(12).max(256)
});
export const SessionUserSchema = z.object({
  id: z.literal("owner"),
  sessionExpiresAt: z.iso.datetime()
});
export type LoginInput = z.infer<typeof LoginInputSchema>;
export type SessionUser = z.infer<typeof SessionUserSchema>;
```

```ts
// auth.test.ts
import { expect, it } from "vitest";
import { LoginInputSchema } from "./auth";

it("rejects short recovery passwords", () => {
  expect(() => LoginInputSchema.parse({ password: "short" })).toThrow();
});
```

- [ ] **Step 5: Export only the public contracts**

```ts
export * from "./auth";
export * from "./meeting";
```

- [ ] **Step 6: Run contract tests and type checking**

Run: `npm test -w @meeting/contracts && npm run typecheck -w @meeting/contracts`

Expected: all contract tests PASS and TypeScript exits 0.

- [ ] **Step 7: Commit the contracts**

```bash
git add packages/contracts
git commit -m "feat: define meeting and auth contracts"
```

### Task 3: Add SQLite migrations and the meeting repository

**Files:**
- Create: `apps/api/src/db/database.ts`
- Create: `apps/api/src/meetings/repository.ts`
- Create: `apps/api/src/folders/repository.ts`
- Create: `apps/api/test/meetings/repository.test.ts`
- Create: `apps/api/test/folders/repository.test.ts`

- [ ] **Step 1: Write failing repository behavior tests**

```ts
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/database";
import { SqliteFolderRepository } from "../../src/folders/repository";
import { SqliteMeetingRepository } from "../../src/meetings/repository";

describe("SqliteMeetingRepository", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); migrate(db); });
  afterEach(() => db.close());

  it("creates idempotently and finds by Chinese title", () => {
    const repo = new SqliteMeetingRepository(db);
    const input = {
      id: "018fd487-0b62-7e15-b94d-2d7b07f635b0",
      title: "产品周会",
      folderId: null,
      clientCreatedAt: "2026-08-20T10:00:00.000Z"
    };
    expect(repo.create(input)).toEqual(repo.create(input));
    expect(repo.list({ search: "产品", includeTrashed: false })).toHaveLength(1);
  });

  it("soft deletes and restores a meeting", () => {
    const repo = new SqliteMeetingRepository(db);
    const id = "018fd487-0b62-7e15-b94d-2d7b07f635b0";
    repo.create({ id, title: "周会", folderId: null, clientCreatedAt: "2026-08-20T10:00:00.000Z" });
    repo.trash(id, "2026-08-20T11:00:00.000Z");
    expect(repo.list({ search: "", includeTrashed: false })).toHaveLength(0);
    repo.restore(id, "2026-08-20T12:00:00.000Z");
    expect(repo.list({ search: "", includeTrashed: false })).toHaveLength(1);
  });
});

it("removes a folder without deleting its meetings", () => {
  const db = new Database(":memory:");
  migrate(db);
  const folders = new SqliteFolderRepository(db);
  const meetings = new SqliteMeetingRepository(db);
  const folder = folders.create({
    id: "018fd487-0b62-7e15-b94d-2d7b07f635b1",
    name: "项目会议",
    clientCreatedAt: "2026-08-20T09:00:00.000Z"
  });
  const meeting = meetings.create({
    id: "018fd487-0b62-7e15-b94d-2d7b07f635b0",
    title: "产品周会",
    folderId: folder.id,
    clientCreatedAt: "2026-08-20T10:00:00.000Z"
  });
  folders.remove(folder.id, "2026-08-20T11:00:00.000Z");
  expect(meetings.get(meeting.id)?.folderId).toBeNull();
  db.close();
});
```

- [ ] **Step 2: Run the repository test and verify it fails**

Run: `npm test -w @meeting/api -- repository.test.ts`

Expected: FAIL because the database and repository modules do not exist.

- [ ] **Step 3: Implement the migration with WAL and foreign keys**

```ts
import Database from "better-sqlite3";

export function migrate(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sync_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS folders_name_idx ON folders(name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK(status IN (
        'draft','recording','recoverable','uploading','processing','ready','failed','trashed'
      )),
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      trashed_at TEXT,
      sync_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS meetings_updated_at_idx ON meetings(updated_at DESC);
    CREATE INDEX IF NOT EXISTS meetings_trashed_at_idx ON meetings(trashed_at);
  `);
}

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  migrate(db);
  return db;
}
```

- [ ] **Step 4: Implement the typed repository boundary**

The repository must expose exactly these operations and map snake-case SQLite rows to `MeetingSchema` before returning them:

```ts
export interface MeetingRepository {
  create(input: CreateMeetingInput): Meeting;
  get(id: string): Meeting | null;
  list(query: { search: string; includeTrashed: boolean }): Meeting[];
  rename(id: string, title: string, now: string): Meeting;
  trash(id: string, now: string): Meeting;
  restore(id: string, now: string): Meeting;
  purgeTrashedBefore(cutoff: string): number;
}

export interface FolderRepository {
  create(input: CreateFolderInput): Folder;
  list(): Folder[];
  rename(id: string, name: string, now: string): Folder;
  remove(id: string, now: string): void;
}
```

Use `INSERT ... ON CONFLICT(id) DO NOTHING` for both create operations, `title LIKE ? ESCAPE '\\'` for meeting search, and increment `sync_version` for every mutation. Folder names are unique case-insensitively. Removing a folder and setting its meetings' `folder_id` to null happen in one transaction. Throw a typed not-found error when a mutation targets an absent meeting or folder.

- [ ] **Step 5: Run repository tests**

Run: `npm test -w @meeting/api -- repository.test.ts`

Expected: both repository tests PASS.

- [ ] **Step 6: Commit the persistence layer**

```bash
git add apps/api/src/db apps/api/src/meetings apps/api/src/folders apps/api/test/meetings apps/api/test/folders
git commit -m "feat: persist meeting catalog in sqlite"
```

### Task 4: Implement password login and opaque server sessions

**Files:**
- Create: `apps/api/src/config.ts`
- Modify: `apps/api/src/db/database.ts`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/auth/service.ts`
- Create: `apps/api/src/auth/routes.ts`
- Create: `apps/api/test/auth/routes.test.ts`

- [ ] **Step 1: Write failing login, session, and logout tests**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";

describe("authentication", () => {
  it("sets an httpOnly session and rejects the wrong password", async () => {
    const app = await buildApp({ databasePath: ":memory:", adminPassword: "correct horse battery staple", cookieSecure: false });
    const rejected = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "wrong password value" } });
    expect(rejected.statusCode).toBe(401);

    const accepted = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse battery staple" } });
    expect(accepted.statusCode).toBe(204);
    expect(accepted.cookies[0]?.name).toBe("meeting_session");
    expect(accepted.cookies[0]?.httpOnly).toBe(true);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the auth test and verify it fails**

Run: `npm test -w @meeting/api -- routes.test.ts`

Expected: FAIL because `buildApp` and auth routes do not exist.

- [ ] **Step 3: Add session storage to the migration**

```sql
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL CHECK(user_id = 'owner'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
```

- [ ] **Step 4: Implement opaque sessions**

`AuthService.login(password)` must:

1. Compare the supplied password with the configured password using `argon2.verify`; hash `ADMIN_PASSWORD` once during application startup when a pre-hashed value is not configured.
2. Generate 32 random bytes with `randomBytes(32).toString("base64url")`.
3. Store only `sha256(token)` in SQLite with a 30-day expiry.
4. Return the raw token only to the route so it can set `meeting_session` with `httpOnly`, `sameSite: "strict"`, `path: "/"`, and the configured `secure` flag.

`AuthService.authenticate(token)` hashes the token, rejects expired rows, and returns `{ id: "owner", sessionExpiresAt }`. `logout(token)` deletes the hashed token. Never log either the password or raw session token.

- [ ] **Step 5: Implement exact auth routes**

```text
POST /api/auth/login   body LoginInput        -> 204 + session cookie
POST /api/auth/logout  no body                 -> 204 + cleared cookie
GET  /api/auth/me      authenticated           -> 200 { id: "owner", sessionExpiresAt }
```

Invalid credentials return `401 { code: "INVALID_CREDENTIALS" }`. Missing or expired sessions return `401 { code: "AUTH_REQUIRED" }`. Zod validation failures return 400 without echoing the supplied password.

In `app.ts`, implement `buildApp(options)` to open SQLite, register `@fastify/cookie`, construct `AuthService`, register the three auth routes, and close SQLite from an `onClose` hook. Task 5 extends this same composition root with meeting routes.

- [ ] **Step 6: Run auth tests and API type checking**

Run: `npm test -w @meeting/api -- routes.test.ts && npm run typecheck -w @meeting/api`

Expected: all auth tests PASS and TypeScript exits 0.

- [ ] **Step 7: Commit authentication**

```bash
git add apps/api/src/app.ts apps/api/src/auth apps/api/src/config.ts apps/api/src/db apps/api/test/auth
git commit -m "feat: add private single-user sessions"
```

### Task 5: Expose authenticated meeting endpoints

**Files:**
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/meetings/routes.ts`
- Create: `apps/api/src/folders/routes.ts`
- Create: `apps/api/test/helpers.ts`
- Create: `apps/api/test/meetings/routes.test.ts`
- Create: `apps/api/test/folders/routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Create shared test helpers with fixed test credentials and client-generated ids:

```ts
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";

export const TEST_PASSWORD = "correct horse battery staple";

export function buildTestApp() {
  return buildApp({ databasePath: ":memory:", adminPassword: TEST_PASSWORD, cookieSecure: false });
}

export async function login(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password: TEST_PASSWORD }
  });
  return String(response.headers["set-cookie"]).split(";", 1)[0]!;
}

export async function createFolder(app: FastifyInstance, cookie: string, name: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/folders",
    headers: { cookie },
    payload: { id: randomUUID(), name, clientCreatedAt: new Date().toISOString() }
  });
  return response.json();
}

export async function createMeeting(
  app: FastifyInstance,
  cookie: string,
  input: { title: string; folderId: string | null }
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/meetings",
    headers: { cookie },
    payload: { id: randomUUID(), ...input, clientCreatedAt: new Date().toISOString() }
  });
  return response.json();
}
```

```ts
import { buildTestApp, createFolder, createMeeting, login } from "../helpers";

it("requires auth and creates a meeting idempotently", async () => {
  const app = await buildTestApp();
  const payload = {
    id: "018fd487-0b62-7e15-b94d-2d7b07f635b0",
    title: "产品周会",
    folderId: null,
    clientCreatedAt: "2026-08-20T10:00:00.000Z"
  };
  expect((await app.inject({ method: "POST", url: "/api/meetings", payload })).statusCode).toBe(401);
  const cookie = await login(app);
  const first = await app.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload });
  const second = await app.inject({ method: "POST", url: "/api/meetings", headers: { cookie }, payload });
  expect(first.statusCode).toBe(201);
  expect(second.statusCode).toBe(200);
  expect(first.json()).toEqual(second.json());
});

it("deletes a folder but keeps its meeting unfiled", async () => {
  const app = await buildTestApp();
  const cookie = await login(app);
  const folder = await createFolder(app, cookie, "项目会议");
  const meeting = await createMeeting(app, cookie, { title: "产品周会", folderId: folder.id });
  const removed = await app.inject({
    method: "DELETE",
    url: `/api/folders/${folder.id}`,
    headers: { cookie }
  });
  expect(removed.statusCode).toBe(204);
  const listed = await app.inject({ method: "GET", url: "/api/meetings", headers: { cookie } });
  expect(listed.json()).toContainEqual(expect.objectContaining({ id: meeting.id, folderId: null }));
});
```

- [ ] **Step 2: Run route tests and verify they fail**

Run: `npm test -w @meeting/api -- meetings/routes.test.ts`

Expected: FAIL because meeting routes are not registered.

- [ ] **Step 3: Implement the API surface**

```text
GET    /api/meetings?search=&includeTrashed=false -> Meeting[]
POST   /api/meetings                              -> Meeting
PATCH  /api/meetings/:id                          -> Meeting
DELETE /api/meetings/:id                          -> Meeting with status=trashed
POST   /api/meetings/:id/restore                  -> Meeting
GET    /api/folders                               -> Folder[]
POST   /api/folders                               -> Folder
PATCH  /api/folders/:id                           -> Folder
DELETE /api/folders/:id                           -> 204; meetings become unfiled
```

Parse request bodies and responses with shared Zod schemas. Reject meeting creation or reassignment to an unknown folder with `404 { code: "FOLDER_NOT_FOUND" }`. Return `404 { code: "MEETING_NOT_FOUND" }` for unknown meeting ids, `409 { code: "MEETING_CONFLICT" }` if an existing client id is reused with different creation data, `409 { code: "FOLDER_NAME_CONFLICT" }` for duplicate folder names, and `400 { code: "INVALID_REQUEST" }` for validation failures. All endpoints require `meeting_session`.

- [ ] **Step 4: Compose and start Fastify**

`buildApp(options)` opens the database, registers `@fastify/cookie`, auth routes, the authentication guard, and meeting routes. `server.ts` reads validated configuration, listens on `127.0.0.1` in development or configured host in deployment, and closes SQLite after Fastify stops.

- [ ] **Step 5: Run all API tests**

Run: `npm test -w @meeting/api && npm run typecheck -w @meeting/api`

Expected: repository, auth, and meeting route suites all PASS; TypeScript exits 0.

- [ ] **Step 6: Commit the API**

```bash
git add apps/api/src apps/api/test
git commit -m "feat: expose authenticated meeting api"
```

### Task 6: Build the offline-first browser repository

**Files:**
- Create: `apps/web/src/meetings/local-db.ts`
- Create: `apps/web/src/meetings/repository.ts`
- Create: `apps/web/src/meetings/sync.ts`
- Create: `apps/web/test/meetings/repository.test.ts`
- Create: `apps/web/test/setup.ts`
- Modify: `apps/web/vite.config.ts`

- [ ] **Step 1: Configure browser tests with fake IndexedDB**

```ts
// test/setup.ts
import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
```

Extend `vite.config.ts` with this test block while retaining the React plugin and API proxy:

```ts
test: {
  environment: "jsdom",
  setupFiles: ["./test/setup.ts"],
  restoreMocks: true
}
```

Clear the named Dexie database in each repository test's `afterEach` hook.

- [ ] **Step 2: Write failing offline creation and sync tests**

```ts
it("lists a meeting immediately and keeps one durable create operation", async () => {
  const repo = createLocalMeetingRepository("test-db");
  const meeting = await repo.create("产品周会", null, new Date("2026-08-20T10:00:00Z"));
  expect(await repo.list("")).toEqual([expect.objectContaining({ id: meeting.id, title: "产品周会" })]);
  expect(await repo.pendingOperations()).toEqual([
    expect.objectContaining({ entityId: meeting.id, kind: "meeting.create", attempts: 0 })
  ]);
});

it("marks an operation complete only after the API accepts it", async () => {
  const repo = createLocalMeetingRepository("sync-test-db");
  await repo.create("产品周会", null, new Date("2026-08-20T10:00:00Z"));
  const api = {
    send: vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce({ ok: true }),
    listMeetings: vi.fn().mockResolvedValue([]),
    listFolders: vi.fn().mockResolvedValue([])
  };
  const sync = createMeetingSync(repo, api);
  await sync.flush();
  expect(await repo.pendingOperations()).toHaveLength(1);
  await sync.flush();
  expect(await repo.pendingOperations()).toHaveLength(0);
});

it("restores the catalog from the server on a clean device", async () => {
  const repo = createLocalMeetingRepository("pull-test-db");
  const serverMeeting: Meeting = {
    id: "018fd487-0b62-7e15-b94d-2d7b07f635b0",
    title: "已备份会议",
    folderId: null,
    status: "ready",
    startedAt: null,
    endedAt: null,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
    trashedAt: null,
    syncVersion: 3
  };
  const api = {
    send: vi.fn(),
    listMeetings: vi.fn().mockResolvedValue([serverMeeting]),
    listFolders: vi.fn().mockResolvedValue([])
  };
  await createMeetingSync(repo, api).refresh();
  expect(await repo.get(serverMeeting.id)).toEqual(serverMeeting);
});

it("keeps meetings when their local folder is removed", async () => {
  const repo = createLocalMeetingRepository("folder-test-db");
  const folder = await repo.createFolder("项目会议", new Date("2026-08-20T09:00:00Z"));
  const meeting = await repo.create("产品周会", folder.id, new Date("2026-08-20T10:00:00Z"));
  await repo.removeFolder(folder.id, new Date("2026-08-20T11:00:00Z"));
  expect((await repo.get(meeting.id))?.folderId).toBeNull();
});
```

- [ ] **Step 3: Run the browser repository test and verify it fails**

Run: `npm test -w @meeting/web -- repository.test.ts`

Expected: FAIL because local database and repository modules do not exist.

- [ ] **Step 4: Implement the Dexie schema**

```ts
export interface OutboxOperation {
  sequence?: number;
  id: string;
  entityId: string;
  kind:
    | "folder.create"
    | "folder.rename"
    | "folder.remove"
    | "meeting.create"
    | "meeting.rename"
    | "meeting.trash"
    | "meeting.restore";
  payload: unknown;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

export class MeetingNotebookDb extends Dexie {
  meetings!: EntityTable<Meeting, "id">;
  folders!: EntityTable<Folder, "id">;
  outbox!: EntityTable<OutboxOperation, "sequence">;
  settings!: EntityTable<{ key: string; value: unknown }, "key">;

  constructor(name = "meeting-notebook") {
    super(name);
    this.version(1).stores({
      meetings: "id, updatedAt, status, folderId, title",
      folders: "id, name, updatedAt",
      outbox: "++sequence,id,entityId,kind,createdAt",
      settings: "key"
    });
  }
}
```

- [ ] **Step 5: Implement transactional local mutations**

Each folder create/rename/remove and meeting create/rename/trash/restore operation must update its entity table and insert its outbox operation in one Dexie `rw` transaction. Removing a folder also sets its local meetings' `folderId` to null in that transaction. Use `crypto.randomUUID()` for entity and operation ids. Search with normalized lowercase `title.includes(query)` because the catalog is personal and initially small; do not introduce a search engine in this phase.

- [ ] **Step 6: Implement ordered idempotent synchronization**

`flush()` reads outbox rows ordered by the IndexedDB auto-incremented `sequence`, sends one operation at a time, applies the server-returned `Meeting` or `Folder` locally, then deletes that outbox row in one transaction. This guarantees a locally created folder reaches the API before a later meeting that references it. Network errors increment `attempts`, store a sanitized message, stop the current flush, and retry on the next online event or explicit refresh. HTTP 401 pauses synchronization until login; HTTP 409 leaves the operation visible as a conflict.

Define the API dependency as:

```ts
export interface MeetingCatalogApi {
  send(operation: OutboxOperation): Promise<{ meeting?: Meeting; folder?: Folder }>;
  listMeetings(): Promise<Meeting[]>;
  listFolders(): Promise<Folder[]>;
}
```

`refresh()` first calls `flush()`, then downloads folders and meetings. It replaces local server-backed rows only when that entity has no pending operation; otherwise the local pending mutation wins until it is accepted or shown as a conflict. A clean Dexie database is repopulated completely from the server, which is the catalog recovery path after reinstalling the PWA.

Store `{ key: "deviceAccess", value: { authorizedAt, expiresAt } }` only after `/api/auth/me` or login succeeds. It authorizes display of this device's local catalog while offline until the matching 30-day session expiry; it is not sent as an API credential. Logout removes `deviceAccess` but retains meetings, folders, and pending operations, matching the approved local-data policy.

- [ ] **Step 7: Run offline repository tests**

Run: `npm test -w @meeting/web -- repository.test.ts && npm run typecheck -w @meeting/web`

Expected: offline creation and retry tests PASS; TypeScript exits 0.

- [ ] **Step 8: Commit the offline data layer**

```bash
git add apps/web/src/meetings apps/web/test
git commit -m "feat: add offline meeting catalog storage"
```

### Task 7: Build the login and meeting-list interface

**Files:**
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/app/App.tsx`
- Create: `apps/web/src/app/styles.css`
- Create: `apps/web/src/auth/api.ts`
- Create: `apps/web/src/auth/LoginPage.tsx`
- Create: `apps/web/src/meetings/api.ts`
- Create: `apps/web/src/meetings/MeetingListPage.tsx`
- Create: `apps/web/test/meetings/MeetingListPage.test.tsx`

- [ ] **Step 1: Write the failing page workflow test**

```tsx
it("creates and finds a meeting while offline", async () => {
  const user = userEvent.setup();
  const repo = createLocalMeetingRepository("ui-test-db");
  render(<MeetingListPage repository={repo} />);

  await user.click(screen.getByRole("button", { name: "新建会议" }));
  await user.type(screen.getByLabelText("会议名称"), "产品周会");
  await user.click(screen.getByRole("button", { name: "创建" }));
  expect(await screen.findByText("产品周会")).toBeVisible();

  await user.type(screen.getByRole("searchbox", { name: "搜索会议" }), "产品");
  expect(screen.getByText("产品周会")).toBeVisible();
});
```

- [ ] **Step 2: Run the page test and verify it fails**

Run: `npm test -w @meeting/web -- MeetingListPage.test.tsx`

Expected: FAIL because the page does not exist.

- [ ] **Step 3: Implement the quiet work-focused shell**

The first screen after authentication is the meeting list. Use a restrained neutral background, a compact top bar, a folder rail that supports create, rename, delete, and “未分类” filtering and collapses on portrait screens, a search field, and an icon-plus-text “新建会议” command. Meeting rows show title, updated time, duration when available, and exactly one processing-state label. Do not add a hero, marketing copy, nested cards, decorative gradients, or a dashboard of unrelated metrics.

- [ ] **Step 4: Implement complete interaction states**

The page must render loading, empty, filtered-empty, offline, synchronization-error, and populated states without changing the toolbar height. New meeting creation validates a nonblank 120-character title, writes locally first, closes the dialog, and navigates to `/meetings/:id`; until plan 2 adds the workspace, this route renders a clear “会议工作区将在录音阶段启用” status with a back button, not a broken page.

- [ ] **Step 5: Implement the session gate**

`App` calls `GET /api/auth/me`. A 401 renders `LoginPage`; successful password login invalidates the session query, writes the 30-day `deviceAccess` marker, and enters the meeting list. If the request fails because the device is offline, an unexpired marker permits access to local meetings and folders with synchronization paused; no marker or an expired marker renders an offline-unlock explanation instead of exposing the catalog. Never store the password in React state after submission, `localStorage`, IndexedDB, logs, or error messages.

- [ ] **Step 6: Run component tests at both iPad orientations**

Run: `npm test -w @meeting/web -- MeetingListPage.test.tsx`

Expected: workflow, empty-state, offline-state, and 744x1133/1133x744 layout tests PASS with no text overflow assertions.

- [ ] **Step 7: Commit the application shell**

```bash
git add apps/web/index.html apps/web/src apps/web/test
git commit -m "feat: add private meeting catalog interface"
```

### Task 8: Make the web client installable and verify offline startup

**Files:**
- Create: `apps/web/public/icons/icon-192.png`
- Create: `apps/web/public/icons/icon-512.png`
- Create: `apps/web/public/icons/icon-maskable-512.png`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/src/main.tsx`
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/install-and-offline.spec.ts`

- [ ] **Step 1: Write the failing PWA browser test**

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://127.0.0.1:4173" },
  webServer: {
    command: "npm run build && npm exec vite -- preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false
  }
});
```

```ts
import { expect, test } from "@playwright/test";

test("ships an installable manifest and opens its cached shell offline", async ({ page, context }) => {
  const sessionRoute = "**/api/auth/me";
  await page.route(sessionRoute, route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ id: "owner", sessionExpiresAt: "2026-09-19T10:00:00.000Z" })
  }));
  await page.goto("/");
  const manifest = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifest).toBeTruthy();
  await expect(page.getByRole("heading", { name: "会议" })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.unroute(sessionRoute);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "会议" })).toBeVisible();
});
```

- [ ] **Step 2: Run the browser test and verify it fails**

Run: `npm run build -w @meeting/web && npm run test:e2e -w @meeting/web -- install-and-offline.spec.ts`

Expected: FAIL because there is no manifest or service worker.

- [ ] **Step 3: Configure the PWA manifest and cache boundary**

Use `VitePWA({ registerType: "autoUpdate", strategies: "generateSW" })` with:

```ts
manifest: {
  name: "会议本",
  short_name: "会议本",
  description: "个人会议录音、手写与 AI 纪要",
  display: "standalone",
  start_url: "/",
  scope: "/",
  orientation: "any",
  theme_color: "#f7f7f5",
  background_color: "#f7f7f5",
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
  ]
}
```

Precache only hashed application assets and icons. Do not cache `/api/auth/*` or API mutations. Meeting data remains in Dexie; future audio chunks also remain outside Cache Storage.

Register the generated worker from `main.tsx` after rendering the React root:

```ts
import { registerSW } from "virtual:pwa-register";

registerSW({ immediate: true });
```

- [ ] **Step 4: Generate bitmap icons from one simple source design**

Create three PNG files with opaque backgrounds and safe maskable padding. Verify with `file apps/web/public/icons/*.png` that dimensions and PNG format match the manifest. Do not use an SVG icon in the iOS manifest.

- [ ] **Step 5: Run production PWA tests**

Run: `npm run build -w @meeting/web && npm run test:e2e -w @meeting/web -- install-and-offline.spec.ts`

Expected: manifest assertion PASS; the cached shell reloads while Playwright is offline.

- [ ] **Step 6: Commit installability**

```bash
git add apps/web/public apps/web/vite.config.ts apps/web/playwright.config.ts apps/web/e2e
git commit -m "feat: make meeting notebook installable offline"
```

### Task 9: Verify the complete foundation and document local use

**Files:**
- Create: `README.md`
- Create: `docs/testing/ipad-foundation-checklist.md`

- [ ] **Step 1: Document exact local startup**

`README.md` must contain:

```bash
npm install
cp .env.example .env
npm run dev
```

It must state that the web client is at `http://localhost:5173`, the API is at `http://localhost:8787`, Safari microphone testing requires HTTPS except on localhost, secrets belong only in `.env`, and this phase does not yet record audio or render ink.

- [ ] **Step 2: Create the iPad foundation checklist**

Include these manual checks with pass/fail columns:

1. Open the HTTPS deployment in iPad Safari.
2. Add it to the Home Screen and launch in standalone mode.
3. Log in with the owner recovery password.
4. Create a Chinese-titled meeting while online.
5. Enable airplane mode, reopen the installed PWA, and confirm the meeting remains visible.
6. Create and rename a meeting offline, reconnect, and confirm one server copy exists.
7. Rotate between 744x1133 portrait and 1133x744 landscape without overlapping controls.
8. Trash and restore a meeting.
9. Confirm browser storage and frontend network responses contain no password or server secret.

- [ ] **Step 3: Run the full automated verification from a clean build**

Run: `npm run typecheck && npm test && npm run build && npm run test:e2e`

Expected: every command exits 0; Vitest reports no failing suites; Playwright reports the install/offline test passed.

- [ ] **Step 4: Inspect the production bundle for secrets**

Run: `rg -n "ADMIN_PASSWORD|correct horse battery staple|API_KEY|API_SECRET" apps/web/dist`

Expected: no matches and `rg` exits 1.

- [ ] **Step 5: Review the diff against this phase's file map**

Run: `git status --short && git diff --stat HEAD`

Expected: only `README.md` and `docs/testing/ipad-foundation-checklist.md` remain before the documentation commit; no `.env`, SQLite database, `data/`, or browser test artifact is tracked.

- [ ] **Step 6: Commit the verified foundation documentation**

```bash
git add README.md docs/testing/ipad-foundation-checklist.md
git commit -m "docs: add foundation setup and iPad checks"
```

## Phase Acceptance Gate

The foundation is ready for the capture-and-handwriting plan only when all of the following are true:

- `npm run typecheck && npm test && npm run build && npm run test:e2e` exits 0.
- The PWA launches from the iPad Home Screen and reloads its shell offline.
- Meeting creation, search, rename, trash, restore, and outbox retry work.
- The API rejects anonymous meeting requests.
- No password, cookie value, or future provider secret appears in the frontend bundle or browser persistence.
- The worktree is clean and every task has its own focused commit.
