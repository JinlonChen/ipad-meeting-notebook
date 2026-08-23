# Meeting Details and Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the meeting workspace placeholder with an iPad-ready detail page whose plain-text note saves offline and synchronizes safely through Supabase.

**Architecture:** Add `note` to the existing `Meeting` aggregate so the current IndexedDB catalog, conditional versions, conflict flow, and authoritative snapshot remain the only source of synchronization truth. Use a dedicated authenticated Supabase note RPC to keep the deployed migration small and security-focused, while the legacy Fastify adapter accepts the same conditional note patch. A focused React workspace and autosave hook own detail loading, 600 ms local persistence, immediate flush triggers, and save/sync status.

**Tech Stack:** TypeScript, Zod, React 19, React Router, Dexie, Supabase PostgreSQL/RPC, Vitest, Testing Library, pgTAP, Playwright, GitHub Pages PWA

---

## File Map

- Modify `packages/contracts/src/meeting.ts`: note text and conditional note payload contracts.
- Modify `packages/contracts/src/meeting.test.ts`: strict length/default/patch coverage.
- Modify `apps/web/src/meetings/local-db.ts`: Dexie version 3 note backfill and `meeting.note` outbox kind.
- Modify `apps/web/src/meetings/repository.ts`: local note mutation and safe tail-operation coalescing.
- Modify `apps/web/src/meetings/api.ts`: HTTP note patch and dedicated Supabase note RPC adapter.
- Modify `apps/web/src/meetings/sync.ts`: classify typed missing-meeting note failures as conflicts.
- Modify `apps/web/src/supabase/types.ts`: `note` column and note RPC types.
- Modify `apps/api/src/db/database.ts`: SQLite note column migration.
- Modify `apps/api/src/meetings/repository.ts`: map and update note.
- Modify `apps/api/src/meetings/routes.ts`: pass note through strict conditional PATCH.
- Create `supabase/migrations/202608230002_meeting_notes.sql`: note column, authenticated idempotent note RPC, grants.
- Modify `supabase/tests/meeting_catalog.sql`: note RLS, validation, replay, conflict, and snapshot tests.
- Create `apps/web/src/meetings/useMeetingNote.ts`: debounced local save controller.
- Create `apps/web/src/meetings/MeetingWorkspacePage.tsx`: real detail page and status UI.
- Modify `apps/web/src/app/App.tsx`: compose the detail route with repository and guarded sync.
- Modify `apps/web/src/app/styles.css`: stable iPad portrait/landscape workspace layout.
- Create `apps/web/test/meetings/MeetingWorkspacePage.test.tsx`: component and autosave tests.
- Modify existing API, repository, sync, integration, auth, and list fixtures to include normalized `note` values.
- Create `apps/web/e2e/meeting-notes.spec.ts`: online, offline, reload, and responsive acceptance.
- Modify `apps/web/e2e/supabase-fixture.ts`: mock note rows and note mutation RPC.
- Modify `docs/testing/ipad-foundation-checklist.md`: real iPad note acceptance steps.

## Task 1: Extend the Shared Meeting Contract

**Files:**
- Modify: `packages/contracts/src/meeting.ts`
- Test: `packages/contracts/src/meeting.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add tests proving that legacy rows default to an empty note, valid multiline notes remain unchanged, notes over 200,000 characters fail, and note mutation payloads are strict:

```ts
const later = "2026-08-21T00:01:00.000Z";

test("defaults legacy meetings to an empty note and preserves multiline notes", () => {
  expect(MeetingSchema.parse(validMeeting).note).toBe("");
  expect(MeetingSchema.parse({ ...validMeeting, note: "第一行\nSecond line" }).note)
    .toBe("第一行\nSecond line");
});

test("strictly validates conditional note updates", () => {
  expect(MeetingNoteBodySchema.parse({ note: "结论", expectedSyncVersion: 2 }))
    .toEqual({ note: "结论", expectedSyncVersion: 2 });
  expect(MeetingNoteOperationSchema.parse({ note: "结论", updatedAt: timestamp, expectedSyncVersion: 2 }))
    .toEqual({ note: "结论", updatedAt: timestamp, expectedSyncVersion: 2 });
  expect(() => MeetingNoteBodySchema.parse({ note: "x".repeat(200_001), expectedSyncVersion: 2 })).toThrow();
  expect(() => MeetingNoteBodySchema.parse({ note: "ok", expectedSyncVersion: 2, extra: true })).toThrow();
});
```

- [ ] **Step 2: Run the focused contract test and verify RED**

Run: `npm test -w @meeting/contracts -- --run src/meeting.test.ts`

Expected: FAIL because `MeetingNoteBodySchema` and `Meeting.note` do not exist.

- [ ] **Step 3: Implement the minimal schemas**

Add and export:

```ts
export const MeetingNoteSchema = z.string().max(200_000);
export const MeetingNoteBodySchema = z.object({
  note: MeetingNoteSchema,
  expectedSyncVersion: ExpectedSyncVersionSchema,
}).strict();
export const MeetingNoteOperationSchema = MeetingNoteBodySchema.extend({
  updatedAt: IsoDateTimeSchema,
}).strict();

export const MeetingSchema = z.object({
  id: MeetingIdSchema,
  title: MeetingTitleSchema,
  folderId: MeetingIdSchema.nullable(),
  status: MeetingStatusSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  endedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  trashedAt: IsoDateTimeSchema.nullable(),
  syncVersion: SyncVersionSchema,
  note: MeetingNoteSchema.default(""),
});

export type MeetingNoteBody = z.infer<typeof MeetingNoteBodySchema>;
export type MeetingNoteOperation = z.infer<typeof MeetingNoteOperationSchema>;
```

- [ ] **Step 4: Normalize typed fixtures, then run focused tests and typecheck**

Add `note: ""` to typed meeting fixtures reported by TypeScript in `apps/api/test`, `apps/web/test`, and `apps/web/e2e/supabase-fixture.ts`. Add `note` to SQLite/Supabase row fixtures only where those rows represent meetings; do not add it to folders. This is a mechanical contract update and must not change test behavior.

Run: `npm test -w @meeting/contracts -- --run src/meeting.test.ts`

Expected: contract tests PASS. Then run `npm run typecheck`; expected PASS with zero fixture or schema errors.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/contracts apps/api/test apps/web/test apps/web/e2e/supabase-fixture.ts
git commit -m "feat: define meeting note contracts"
```

## Task 2: Persist Notes Locally Without Losing In-Flight Edits

**Files:**
- Modify: `apps/web/src/meetings/local-db.ts`
- Modify: `apps/web/src/meetings/repository.ts`
- Test: `apps/web/test/meetings/repository.test.ts`

- [ ] **Step 1: Write failing repository tests**

Cover these exact cases:

```ts
test("saves a note locally and queues one conditional mutation", async () => {
  const catalog = repository();
  const meeting = await catalog.create("Planning", null, now);
  await catalog.saveNote(meeting.id, "结论\n待办", later);
  await expect(catalog.get(meeting.id)).resolves.toMatchObject({ note: "结论\n待办", syncVersion: 1 });
  await expect(catalog.pendingOperations()).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "meeting.note", payload: { note: "结论\n待办", updatedAt: later, expectedSyncVersion: 0 } }),
  ]));
});

test("replaces only a tail note operation and preserves its server base version", async () => {
  const catalog = repository();
  const meeting = await catalog.create("Planning", null, now);
  await catalog.saveNote(meeting.id, "first", "2026-08-21T00:01:00.000Z");
  const first = (await catalog.pendingOperations()).find((item) => item.kind === "meeting.note")!;
  await catalog.saveNote(meeting.id, "second", "2026-08-21T00:02:00.000Z");
  const notes = (await catalog.pendingOperations()).filter((item) => item.kind === "meeting.note");
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ payload: { note: "second", expectedSyncVersion: 0 } });
  expect(notes[0]!.id).not.toBe(first.id);
  await expect(catalog.get(meeting.id)).resolves.toMatchObject({ note: "second", syncVersion: 1 });
});

test("appends after a later rename instead of reordering dependent versions", async () => {
  const catalog = repository();
  const meeting = await catalog.create("Planning", null, now);
  await catalog.saveNote(meeting.id, "first", "2026-08-21T00:01:00.000Z");
  await catalog.rename(meeting.id, "Renamed", "2026-08-21T00:02:00.000Z");
  await catalog.saveNote(meeting.id, "second", "2026-08-21T00:03:00.000Z");
  const entity = (await catalog.pendingOperations()).filter((item) => item.entityId === meeting.id);
  expect(entity.map((item) => item.kind)).toEqual(["meeting.create", "meeting.note", "meeting.rename", "meeting.note"]);
  expect(entity.slice(1).map((item) => (item.payload as { expectedSyncVersion: number }).expectedSyncVersion)).toEqual([0, 1, 2]);
});

test("a stale in-flight note acknowledgement cannot overwrite a replacement note", async () => {
  const catalog = repository();
  const meeting = await catalog.create("Planning", null, now);
  const create = (await catalog.pendingOperations())[0]!;
  await catalog.syncApplySuccessfulOperation(create, { meeting });
  const first = await catalog.saveNote(meeting.id, "first", "2026-08-21T00:01:00.000Z");
  const inFlight = (await catalog.pendingOperations())[0]!;
  await catalog.saveNote(meeting.id, "second", "2026-08-21T00:02:00.000Z");
  await catalog.syncApplySuccessfulOperation(inFlight, { meeting: first });
  await expect(catalog.get(meeting.id)).resolves.toMatchObject({ note: "second", syncVersion: 1 });
  await expect(catalog.pendingOperations()).resolves.toEqual([
    expect.objectContaining({ kind: "meeting.note", payload: expect.objectContaining({ note: "second" }) }),
  ]);
});

test("rejects oversized notes without changing the meeting or outbox", async () => {
  const catalog = repository();
  const meeting = await catalog.create("Planning", null, now);
  const before = await catalog.pendingOperations();
  await expect(catalog.saveNote(meeting.id, "x".repeat(200_001), later)).rejects.toThrow();
  await expect(catalog.get(meeting.id)).resolves.toEqual(meeting);
  await expect(catalog.pendingOperations()).resolves.toEqual(before);
});
```

Also construct a version 2 Dexie database containing a meeting without `note`, open the repository, and assert version 3 backfills `note: ""`.

- [ ] **Step 2: Run repository tests and verify RED**

Run: `npm test -w @meeting/web -- --run test/meetings/repository.test.ts`

Expected: FAIL because version 3, `meeting.note`, and `saveNote` do not exist.

- [ ] **Step 3: Add the Dexie migration and outbox kind**

Append `"meeting.note"` to `OutboxKind`. Add version 3 with unchanged indexes and this upgrade:

```ts
this.version(3).stores({
  meetings: "id,updatedAt,status,folderId,title",
  folders: "id,name,updatedAt",
  outbox: "++sequence,id,entityId,kind,createdAt",
  settings: "key",
}).upgrade(async (transaction) => {
  await transaction.table<Meeting>("meetings").toCollection().modify((meeting) => {
    if (typeof meeting.note !== "string") meeting.note = "";
  });
});
```

- [ ] **Step 4: Implement safe note coalescing**

Add `saveNote(id, note, now)` in one `meetings + outbox` transaction. Parse the note first. Reject a pending conflict for the same meeting. If the latest entity operation is `meeting.note`, delete that row, keep its `expectedSyncVersion`, keep the meeting's already-incremented local `syncVersion`, and enqueue a replacement with a fresh UUID/sequence. Otherwise increment local `syncVersion` once and append a normal note operation using the prior version.

```ts
const entityOperations = (await db.outbox.where("entityId").equals(meetingId).sortBy("sequence"));
if (entityOperations.some((item) => item.lastError === "CONFLICT")) throw new MeetingConflictPendingError(meetingId);
const tail = entityOperations.at(-1);
const replacingTail = tail?.kind === "meeting.note" && tail.sequence !== undefined;
const expectedSyncVersion = replacingTail
  ? MeetingNoteOperationSchema.parse(tail.payload).expectedSyncVersion
  : current.syncVersion;
const next = MeetingSchema.parse({
  ...current,
  note: normalizedNote,
  updatedAt,
  syncVersion: replacingTail ? current.syncVersion : current.syncVersion + 1,
});
if (replacingTail) await db.outbox.delete(tail.sequence!);
await db.meetings.put(next);
await this.enqueueOutbox(db, operation("meeting.note", meetingId, { note: normalizedNote, updatedAt, expectedSyncVersion }, updatedAt));
```

Ensure newly created local meetings include `note: ""`.

- [ ] **Step 5: Run repository and sync regression tests**

Run: `npm test -w @meeting/web -- --run test/meetings/repository.test.ts test/meetings/sync.test.ts`

Expected: PASS, including the stale acknowledgement case.

- [ ] **Step 6: Commit local persistence**

```bash
git add apps/web/src/meetings/local-db.ts apps/web/src/meetings/repository.ts apps/web/test/meetings/repository.test.ts
git commit -m "feat: save meeting notes offline"
```

## Task 3: Add Conditional Note APIs and Supabase Migration

**Files:**
- Create: `supabase/migrations/202608230002_meeting_notes.sql`
- Modify: `supabase/tests/meeting_catalog.sql`
- Modify: `apps/web/src/supabase/types.ts`
- Modify: `apps/web/src/meetings/api.ts`
- Modify: `apps/web/src/meetings/sync.ts`
- Modify: `apps/api/src/db/database.ts`
- Modify: `apps/api/src/meetings/repository.ts`
- Modify: `apps/api/src/meetings/routes.ts`
- Test: `apps/web/test/meetings/api.test.ts`
- Test: `apps/web/test/meetings/supabase-integration.test.ts`
- Test: `apps/api/test/meetings/repository.test.ts`
- Test: `apps/api/test/meetings/routes.test.ts`
- Test: `apps/api/test/db/database.test.ts`

- [ ] **Step 1: Write failing adapter, API, migration-contract, and pgTAP tests**

Tests must prove:

- HTTP `meeting.note` sends `PATCH /api/meetings/:id` with `{ note, expectedSyncVersion }` and preserves typed `MEETING_NOT_FOUND`.
- Supabase `meeting.note` calls only `apply_meeting_note_mutation`, includes the expected user ID, and rejects malformed responses.
- `contractMeeting()` maps `note` and treats a missing legacy value as `""` only during migration compatibility.
- SQLite update increments one version and rejects stale expected versions.
- pgTAP verifies the column default/check, anonymous denial, actor mismatch denial, strict 200,000-character validation, idempotent replay, stale-version conflict, missing meeting, and snapshot inclusion.

Run RED commands:

```bash
npm test -w @meeting/web -- --run test/meetings/api.test.ts test/meetings/supabase-integration.test.ts
npm test -w @meeting/api -- --run test/db/database.test.ts test/meetings/repository.test.ts test/meetings/routes.test.ts
npm run test:contracts
```

- [ ] **Step 2: Create the additive Supabase migration**

The migration must:

```sql
alter table public.meetings
  add column note text not null default ''
  check (char_length(note) <= 200000);

create or replace function public.apply_meeting_note_mutation(
  p_operation_id uuid,
  p_entity_id uuid,
  p_note text,
  p_updated_at timestamptz,
  p_expected_sync_version bigint,
  p_expected_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public;
```

Use this complete function body and grants:

```sql
create or replace function public.apply_meeting_note_mutation(
  p_operation_id uuid,
  p_entity_id uuid,
  p_note text,
  p_updated_at timestamptz,
  p_expected_sync_version bigint,
  p_expected_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_fingerprint text := md5(jsonb_build_object(
    'entityId', p_entity_id,
    'note', p_note,
    'updatedAt', p_updated_at,
    'expectedSyncVersion', p_expected_sync_version
  )::text);
  v_replay public.catalog_mutation_replays%rowtype;
  v_response jsonb;
  v_row jsonb;
begin
  if v_user_id is null then
    return jsonb_build_object('status', 401, 'code', 'AUTH_REQUIRED');
  end if;
  if v_user_id is distinct from p_expected_user_id then
    return jsonb_build_object('status', 401, 'code', 'AUTH_CONTEXT_CHANGED');
  end if;
  if p_operation_id is null or p_entity_id is null or p_note is null or p_updated_at is null
    or p_expected_sync_version is null or p_expected_sync_version < 0
    or char_length(p_note) > 200000 then
    return jsonb_build_object('status', 400, 'code', 'INVALID_REQUEST');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || p_operation_id::text, 0));
  select * into v_replay
  from public.catalog_mutation_replays
  where user_id = v_user_id and operation_id = p_operation_id;
  if found then
    if v_replay.operation_kind = 'meeting.note' and v_replay.request_fingerprint = v_fingerprint then
      return v_replay.response;
    end if;
    return jsonb_build_object('status', 409, 'code', 'IDEMPOTENCY_KEY_REUSED');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':entity:' || p_entity_id::text, 0));
  if not exists (select 1 from public.meetings where user_id = v_user_id and id = p_entity_id) then
    v_response := jsonb_build_object('status', 404, 'code', 'MEETING_NOT_FOUND');
  else
    update public.meetings
    set note = p_note, updated_at = p_updated_at, sync_version = sync_version + 1
    where user_id = v_user_id and id = p_entity_id and sync_version = p_expected_sync_version
    returning to_jsonb(public.meetings.*) into v_row;
    if v_row is null then
      v_response := jsonb_build_object('status', 409, 'code', 'CONFLICT');
    else
      v_response := jsonb_build_object('status', 200, 'meeting', v_row);
    end if;
  end if;

  insert into public.catalog_mutation_replays
    (user_id, operation_id, operation_kind, request_fingerprint, response)
  values (v_user_id, p_operation_id, 'meeting.note', v_fingerprint, v_response);
  return v_response;
end;
$function$;

revoke all on function public.apply_meeting_note_mutation(uuid, uuid, text, timestamptz, bigint, uuid)
  from public, anon;
revoke execute on function public.apply_meeting_note_mutation(uuid, uuid, text, timestamptz, bigint, uuid)
  from public, anon;
grant execute on function public.apply_meeting_note_mutation(uuid, uuid, text, timestamptz, bigint, uuid)
  to authenticated;
```

- [ ] **Step 3: Wire typed Supabase and HTTP adapters**

Add `note` to `MeetingRow` and direct selects. Add the RPC signature to `Database.public.Functions`. In `MeetingCatalogSupabaseApi.send`, parse note payload with `MeetingNoteOperationSchema`, call the dedicated note RPC, validate `RpcResultSchema`, and normalize the returned meeting. In `MeetingCatalogHttpApi.send`, parse the operation payload with `MeetingNoteOperationSchema`, strip `updatedAt`, and map `meeting.note` to the existing conditional PATCH route.

Extend `isTypedNotFoundConflict`:

```ts
if (["meeting.rename", "meeting.note", "meeting.trash", "meeting.restore"].includes(operation.kind)) {
  return error.code === "MEETING_NOT_FOUND";
}
```

- [ ] **Step 4: Upgrade the legacy SQLite boundary**

Add `note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 200000)` to fresh schema and migration rebuilds. Map `row.note`. Allow `note` in `MeetingRepository.update`, `MeetingPatchBodySchema`, route changes, SQL update fields, and mutation replay fingerprints.

- [ ] **Step 5: Run all focused backend and adapter tests**

Run the three commands from Step 1. Expected: all PASS. If local Supabase CLI is available, also run `supabase test db`; expected pgTAP plan and test count PASS with zero failures.

- [ ] **Step 6: Commit cloud and API support**

```bash
git add packages/contracts apps/api apps/web/src/meetings/api.ts apps/web/src/meetings/sync.ts apps/web/src/supabase apps/web/test/meetings supabase
git commit -m "feat: synchronize meeting notes"
```

## Task 4: Build the Real Meeting Workspace

**Files:**
- Create: `apps/web/src/meetings/useMeetingNote.ts`
- Create: `apps/web/src/meetings/MeetingWorkspacePage.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/app/styles.css`
- Create: `apps/web/test/meetings/MeetingWorkspacePage.test.tsx`
- Modify: `apps/web/test/meetings/MeetingListPage.test.tsx`
- Modify: `apps/web/test/auth/App.test.tsx`

- [ ] **Step 1: Write failing workspace tests**

Use fake timers and a real test repository. Cover:

- loading, missing, trashed, and read-error states;
- title, folder, status, updated time, and existing note rendering;
- exactly one local save 600 ms after typing stops;
- blur, visibility change, and Back flush the latest unsaved text immediately;
- local save failure keeps editor text and exposes Retry;
- offline save says `已保存到本机，待同步` and does not call network sync;
- online save schedules synchronization and reaches `已同步`;
- 200,001 characters are rejected locally;
- route creation now lands on the real workspace instead of placeholder text.

Run: `npm test -w @meeting/web -- --run test/meetings/MeetingWorkspacePage.test.tsx test/meetings/MeetingListPage.test.tsx test/auth/App.test.tsx`

Expected: FAIL because the workspace and autosave controller do not exist.

- [ ] **Step 2: Implement the focused autosave controller**

`useMeetingNote` owns `draft`, `persisted`, a 600 ms timer, one serialized save promise, and a trailing save when text changes during an active write. Its public boundary is:

```ts
type NoteSaveState = "idle" | "saving" | "saved-local" | "pending-sync" | "synced" | "conflict" | "error";

type UseMeetingNoteResult = {
  draft: string;
  setDraft(value: string): void;
  state: NoteSaveState;
  error: string;
  flush(): Promise<boolean>;
  retry(): Promise<void>;
};
```

The hook calls `repository.saveNote`, then `scheduleRefresh` only when online. It never clears the current textarea value after a failed save. Synchronize writes through a promise chain so an older completion cannot mark a newer draft as saved.

- [ ] **Step 3: Implement `MeetingWorkspacePage`**

Use `useParams()` to load the meeting and folders. Render semantic controls:

```tsx
<main className="workspace-shell">
  <header className="workspace-topbar">
    <button
      className="icon-button"
      aria-label="返回会议"
      onClick={() => void flush().then((saved) => { if (saved) navigate("/meetings"); })}
    >
      <ChevronLeft size={18} />
    </button>
    <h1>{meeting.title}</h1>
    <span className="workspace-save-state" role="status" aria-live="polite">{statusText}</span>
  </header>
  <section className="workspace-meta" aria-label="会议信息">
    <span>{statusLabel(meeting.status)}</span>
    <span>{folderName ?? "未分类"}</span>
    <time dateTime={meeting.updatedAt}>更新于 {dateTime(meeting.updatedAt)}</time>
  </section>
  <label className="note-editor">
    <span>会议笔记</span>
    <textarea
      aria-label="会议笔记"
      value={draft}
      maxLength={200_000}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => void flush()}
    />
  </label>
  {error && <div role="alert">{error}<button onClick={() => void retry()}>重试</button></div>}
</main>
```

Back must await `flush()` and navigate only if local persistence succeeds. `visibilitychange` calls `flush()` when the document becomes hidden. Missing/trashed/error screens retain a visible Back command.

- [ ] **Step 4: Compose the route and responsive styles**

Pass `repository`, guarded `refresh`, guarded `scheduleRefresh`, `online`, and `now` from `SessionApp` into the workspace route. Remove `WorkspacePlaceholder`.

Use a full-height unframed layout, stable 56 px header, one metadata band, and a textarea with `min-height: clamp(360px, calc(100dvh - 180px), 900px)`. At 744x1133 and 1133x744, the title flexes with ellipsis only when truly necessary while the save state remains fully visible; at 320 px, the header may wrap to two rows without horizontal overflow.

- [ ] **Step 5: Run workspace, auth, list, and accessibility tests**

Run: `npm test -w @meeting/web -- --run test/meetings/MeetingWorkspacePage.test.tsx test/meetings/MeetingListPage.test.tsx test/auth/App.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the workspace UI**

```bash
git add apps/web/src/meetings/useMeetingNote.ts apps/web/src/meetings/MeetingWorkspacePage.tsx apps/web/src/app apps/web/test
git commit -m "feat: add offline meeting notes workspace"
```

## Task 5: Prove Online, Offline, Reload, and iPad Layout Behavior

**Files:**
- Modify: `apps/web/e2e/supabase-fixture.ts`
- Create: `apps/web/e2e/meeting-notes.spec.ts`
- Modify: `docs/testing/ipad-foundation-checklist.md`

- [ ] **Step 1: Write failing E2E acceptance**

Add route fixture support for `note` and `apply_meeting_note_mutation`. Test this sequence:

```ts
test("meeting notes survive offline navigation and synchronize after reconnect", async ({ context, page }) => {
  await page.setViewportSize({ width: 744, height: 1133 });
  await openCatalog(page, [offlineMeeting()]);
  await page.getByRole("button", { name: /\u79bb\u7ebf\u4f1a\u8bae/ }).click();
  const editor = page.getByRole("textbox", { name: "\u4f1a\u8bae\u7b14\u8bb0" });
  await context.setOffline(true);
  await editor.fill("\u79bb\u7ebf\u7ed3\u8bba\n\u4e0b\u4e00\u6b65");
  await editor.blur();
  await expect(page.getByRole("status")).toContainText("\u5f85\u540c\u6b65");
  await page.getByRole("button", { name: "\u8fd4\u56de\u4f1a\u8bae" }).click();
  await page.getByRole("button", { name: /\u79bb\u7ebf\u4f1a\u8bae/ }).click();
  await expect(editor).toHaveValue("\u79bb\u7ebf\u7ed3\u8bba\n\u4e0b\u4e00\u6b65");
  await context.setOffline(false);
  await expect(page.getByRole("status")).toContainText("\u5df2\u540c\u6b65");
});
```

Add layout assertions at 744x1133, 1133x744, and 320x700: no document overflow, no header/editor overlap, and status `scrollWidth <= clientWidth`.

- [ ] **Step 2: Run the E2E test and verify RED**

Run: `npm run test:e2e -w @meeting/web -- --grep "meeting notes"`

Expected: FAIL before fixture/RPC/workspace integration is complete.

- [ ] **Step 3: Complete the E2E fixture and checklist**

The mocked RPC must update the in-memory remote meeting, increment `sync_version`, return a complete owned row, and reject mismatched expected versions. The checklist must give one action at a time for: online edit, airplane-mode edit, reopen, reconnect, computer verification.

- [ ] **Step 4: Run full verification**

Run each command separately and require exit code 0:

```bash
npm test
npm run typecheck
npm run build
npm run scan:web-dist
npm run test:e2e
git diff --check
```

Expected evidence: contracts, API, web, SQL contract tests, production build, sensitive-data scan, and every Playwright project pass with zero failures.

- [ ] **Step 5: Request code review and fix all Critical/Important findings**

Review the complete diff against the design in `docs/superpowers/specs/2026-08-23-meeting-details-notes-design.md`. Re-run affected focused tests after every review fix, then re-run Step 4.

- [ ] **Step 6: Commit final acceptance coverage**

```bash
git add apps/web/e2e docs/testing
git commit -m "test: verify meeting notes on iPad"
```

## Task 6: Deploy and Perform Real Supabase/iPad Acceptance

**Files:**
- No source changes unless deployment verification exposes a defect.

- [ ] **Step 1: Apply the additive migration to project `nprrqgyejndptpytszha`**

Use the authenticated Supabase dashboard/CLI session. Verify the migration history records `202608230002`, the note column exists, direct authenticated update remains denied, and pgTAP passes. Never expose database passwords, service-role keys, user passwords, or OTPs in chat/log output.

- [ ] **Step 2: Push the reviewed branch and wait for both CI and Pages**

Push only after fresh local verification. Require both GitHub Actions workflows for the exact head SHA to conclude `success`.

- [ ] **Step 3: Verify the production artifact**

Open `https://jinlonchen.github.io/ipad-meeting-notebook/`, confirm the new workspace loads without console errors, the manifest and service worker return HTTP 200, and the production CSS/JS corresponds to the deployed head.

- [ ] **Step 4: Guide one-action-at-a-time iPad acceptance**

Have the user fully close/reopen the installed PWA while online, edit a meeting note, verify `已同步`, enable airplane mode, edit again, leave and reopen the meeting, restore networking, and verify `已同步`. Independently verify the final note from a freshly loaded computer session or authenticated Supabase query.

- [ ] **Step 5: Record outcome**

Mark the note rows in `docs/testing/ipad-foundation-checklist.md` with the date and evidence. Leave unrelated `.DS_Store` untouched.
