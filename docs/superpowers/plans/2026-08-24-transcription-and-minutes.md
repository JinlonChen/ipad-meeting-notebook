# Transcription And Minutes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a saved meeting recording into an editable transcript and an evidence-linked AI meeting summary without exposing provider keys to the PWA.

**Architecture:** The browser retains its existing local-first recording behavior and asks a Supabase Edge Function to process an uploaded recording after a meeting ends. A write-only per-user provider credential is stored behind RLS; the processing function alone reads it, calls OpenAI-compatible transcription and chat-completions endpoints, then writes durable transcript and minutes records. The workspace reads those records through authenticated RPC/read policies and exposes explicit retry states.

**Tech Stack:** React 18, TypeScript, Zod, Vitest, Supabase Postgres/RLS/Storage, Supabase Edge Functions (Deno), OpenAI-compatible ASR and Chat Completions APIs.

---

### Task 1: Define durable transcript and minutes contracts

**Files:**
- Create: `packages/contracts/src/intelligence.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/intelligence.test.ts`

- [ ] **Step 1: Write the failing contract test**

```ts
expect(TranscriptSegmentSchema.parse({
  id: crypto.randomUUID(), meetingId: crypto.randomUUID(), position: 0,
  text: "确认下周发布", startedOffsetMs: 0, endedOffsetMs: 3_000,
  speaker: null, source: "asr", confidence: null,
})).toMatchObject({ source: "asr" });
expect(() => MinutesSchema.parse({ summary: "", topics: [], decisions: [], risks: [], actions: [] })).toThrow();
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `npm test -w @meeting/contracts -- intelligence.test.ts`

Expected: FAIL because the intelligence module does not exist.

- [ ] **Step 3: Implement the minimal schemas**

Create schemas for ordered transcript segments and minutes containing summary, topics, decisions, risks, and action items. Require each generated item to cite zero or more transcript segment IDs and represent unknown owners/dates as `null`, never guessed values.

- [ ] **Step 4: Re-run the contract test**

Run: `npm test -w @meeting/contracts -- intelligence.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/intelligence.ts packages/contracts/src/intelligence.test.ts packages/contracts/src/index.ts
git commit -m "feat: define meeting intelligence contracts"
```

### Task 2: Add private server-side AI configuration and durable records

**Files:**
- Create: `supabase/migrations/202608240003_meeting_intelligence.sql`
- Create: `supabase/tests/meeting_intelligence.sql`
- Test: `test/supabase-schema.test.mjs`

- [ ] **Step 1: Write SQL assertions before the migration**

Assert that `meeting_transcript_segments` and `meeting_minutes` use the meeting owner as their authorization boundary; authenticated users can read their own records but cannot mutate generated results directly. Assert that `ai_provider_credentials` has no `SELECT` grant or policy for authenticated users and the `ai_provider_configured()` RPC only returns a boolean.

- [ ] **Step 2: Run the SQL contract test and verify it fails**

Run: `node --test test/supabase-schema.test.mjs`

Expected: FAIL because the intelligence migration is absent.

- [ ] **Step 3: Implement the migration**

Create a single row per user for an OpenAI-compatible base URL, ASR model, chat model, and write-only API key. Create transcript/minutes tables with RLS owner reads, processing status, source metadata, timestamps, and a security-definer boolean configuration RPC. Revoke direct writes to transcript/minutes from `authenticated`; only the service role Edge Function writes generated output.

- [ ] **Step 4: Re-run schema contracts**

Run: `node --test test/supabase-schema.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/202608240003_meeting_intelligence.sql supabase/tests/meeting_intelligence.sql test/supabase-schema.test.mjs
git commit -m "feat: store private AI settings and meeting intelligence"
```

### Task 3: Process uploaded recording server-side

**Files:**
- Create: `supabase/functions/process-meeting-intelligence/index.ts`
- Create: `supabase/functions/process-meeting-intelligence/intelligence-core.ts`
- Create: `supabase/functions/process-meeting-intelligence/deno.json`
- Test: `supabase/functions/process-meeting-intelligence/intelligence-core.test.mjs`

- [ ] **Step 1: Write a failing core test**

```js
const result = await processMeeting({ meetingId, userId, audioUrl, credentials }, provider);
assert.equal(result.transcript[0].text, "确认下周发布");
assert.equal(result.minutes.actions[0].owner, null);
```

- [ ] **Step 2: Run the core test and verify it fails**

Run: `node --test supabase/functions/process-meeting-intelligence/intelligence-core.test.mjs`

Expected: FAIL because the core processor does not exist.

- [ ] **Step 3: Implement provider calls and validation**

Require the caller JWT and meeting ownership, load the write-only credential with the service role, obtain the private recording object through storage, send it to `<baseUrl>/audio/transcriptions`, normalize the returned text into ordered segments, then request a strict JSON minutes object from `<baseUrl>/chat/completions`. Validate all provider responses before replacing the meeting's prior generated records. Mark the meeting `ready` only after both writes succeed; store a sanitized failure code otherwise.

- [ ] **Step 4: Re-run Edge Function tests**

Run: `node --test supabase/functions/process-meeting-intelligence/intelligence-core.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/process-meeting-intelligence
git commit -m "feat: process recordings into transcript and minutes"
```

### Task 4: Add settings, processing command, transcript, and minutes UI

**Files:**
- Create: `apps/web/src/intelligence/api.ts`
- Create: `apps/web/src/intelligence/MeetingIntelligencePanel.tsx`
- Create: `apps/web/src/intelligence/AiSettingsPage.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/meetings/MeetingWorkspacePage.tsx`
- Modify: `apps/web/src/app/styles.css`
- Test: `apps/web/test/intelligence/api.test.ts`
- Test: `apps/web/test/intelligence/MeetingIntelligencePanel.test.tsx`
- Test: `apps/web/test/intelligence/AiSettingsPage.test.tsx`

- [ ] **Step 1: Write failing UI/API tests**

```tsx
render(<MeetingIntelligencePanel api={api} meetingId={meetingId} online />);
await user.click(screen.getByRole("button", { name: "生成转写与纪要" }));
expect(api.process).toHaveBeenCalledWith(meetingId);
```

```tsx
render(<AiSettingsPage api={api} />);
await user.type(screen.getByLabelText("API 密钥"), "sk-private");
await user.click(screen.getByRole("button", { name: "保存 AI 配置" }));
expect(api.saveCredentials).toHaveBeenCalledWith(expect.not.objectContaining({ apiKey: undefined }));
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm test -w @meeting/web -- intelligence`

Expected: FAIL because the intelligence UI/API modules do not exist.

- [ ] **Step 3: Implement the browser boundary and workspace UI**

Add a settings route reachable from the meeting list. The key input is cleared after successful submit and never read back. In the workspace, show processing status, a single explicit "生成转写与纪要" command while online, editable transcript text, and a compact minutes view for summary, conclusions, risks, and action items. Do not block note editing or recording controls during processing.

- [ ] **Step 4: Re-run focused tests**

Run: `npm test -w @meeting/web -- intelligence`

Expected: PASS.

- [ ] **Step 5: Run full verification and commit**

Run: `npm run typecheck && npm test && npm run build && npm run test:e2e`

Expected: all checks pass.

```bash
git add apps/web/src apps/web/test
git commit -m "feat: add transcript and AI minutes workspace"
```

### Task 5: Deploy and verify on the hosted PWA

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the exact credential and function deployment steps**

Document that the user enters an OpenAI-compatible base URL, ASR model, chat model, and API key from the private settings route. Document the one-time Edge Function deployment, and state that neither the configuration table nor browser UI returns the key.

- [ ] **Step 2: Run release checks**

Run: `npm run typecheck && npm test && npm run build && npm run scan:web-dist && npm run test:e2e`

Expected: all checks pass.

- [ ] **Step 3: Commit and publish**

```bash
git add README.md
git commit -m "docs: configure meeting transcription and minutes"
git push origin codex/audio-recording-foundation
```

- [ ] **Step 4: Confirm hosted verification**

Verify GitHub CI and Pages succeed, open the PWA, save AI credentials through the settings page, and process a short newly recorded meeting. Confirm that transcript and minutes are visible after refresh without exposing the API key.
