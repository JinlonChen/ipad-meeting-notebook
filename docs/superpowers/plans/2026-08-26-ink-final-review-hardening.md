# Ink Final Review Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the final live-follow, long-canvas, atomic continuation, and deployed-schema upgrade gaps without changing recording, transcription, speaker, or AI behavior.

**Architecture:** Observe the transcript content box while preserving the existing user-controlled follow flag. Keep ink points in the fixed 2048-wide logical coordinate system while a pure height model grows the rendered canvas and restores sufficient height from vectors. Persist split gestures through one repository transaction and one hook state transition, then install the already-reviewed strict RPC body through a new additive migration.

**Tech Stack:** React 19, TypeScript, Canvas 2D, ResizeObserver, Dexie/IndexedDB, PostgreSQL/Supabase migrations, Vitest, Testing Library, Playwright.

---

### Task 1: Follow Live Partial Transcript Growth

**Files:**
- Modify: `apps/web/test/meetings/MeetingWorkspaceLayout.test.tsx`
- Modify: `apps/web/src/meetings/MeetingWorkspaceLayout.tsx`
- Modify: `apps/web/e2e/ink-workspace.spec.ts`

- [ ] **Step 1: Write the failing component test.** Stub `ResizeObserver`, capture its callback and observed element, then assert content growth scrolls to `scrollHeight` only while follow mode is active; user scroll-up pauses it, `回到最新` restores it, and unmount disconnects the observer.
- [ ] **Step 2: Run RED.** Run `npm test -w @meeting/web -- MeetingWorkspaceLayout`; expect the observer assertion to fail because no transcript content element is observed.
- [ ] **Step 3: Implement minimal follow behavior.** Add a `.workspace-transcript-content` wrapper and observe it in an effect whose callback calls `latest()` only when `followingRef.current` is true.
- [ ] **Step 4: Run GREEN.** Rerun `npm test -w @meeting/web -- MeetingWorkspaceLayout`; expect all focused tests to pass.
- [ ] **Step 5: Extend iPad E2E.** Add `emitPartial(text)` to the fake transcription socket and assert repeated long partials follow, a partial while paused does not scroll, and a partial after `回到最新` follows again.

### Task 2: Grow the Logical Ink Canvas

**Files:**
- Modify: `apps/web/test/ink/model.test.ts`
- Modify: `apps/web/src/ink/model.ts`
- Modify: `apps/web/test/ink/InkCanvas.test.tsx`
- Modify: `apps/web/src/ink/InkCanvas.tsx`
- Modify: `apps/web/src/app/styles.css`
- Modify: `apps/web/e2e/ink-workspace.spec.ts`

- [ ] **Step 1: Write failing pure model tests.** Define the desired `nextInkCanvasHeight(currentHeight, pointY, scale)` and `inkCanvasHeightForStrokes(strokes, scale)` behavior: 720px minimum, fixed growth step near the bottom, enough padding for restored vectors, and a cap at `INK_LOGICAL_HEIGHT * scale`.
- [ ] **Step 2: Run model RED.** Run `npm test -w @meeting/web -- ink/model`; expect missing-export failures.
- [ ] **Step 3: Implement the pure height functions.** Keep height calculations independent of React and preserve the existing fixed logical width mapping.
- [ ] **Step 4: Write component RED.** Draw near the current bottom and assert inline canvas height grows, the sampled logical point remains based on the unchanged width scale, restored deep strokes expand height, and vector redraw survives resize.
- [ ] **Step 5: Implement component growth.** Track CSS canvas height, grow it before redraw when points approach the bottom, recompute required restored height from incoming strokes, and remove the fixed CSS height declaration.
- [ ] **Step 6: Run component GREEN and add iPad E2E.** Run `npm test -w @meeting/web -- ink/model InkCanvas`, then assert in Playwright that drawing near the bottom increases canvas and ink-surface scroll height in portrait and landscape.

### Task 3: Persist Continuation Strokes Atomically

**Files:**
- Modify: `apps/web/test/ink/repository.test.ts`
- Modify: `apps/web/src/ink/repository.ts`
- Modify: `apps/web/test/ink/useMeetingInk.test.tsx`
- Modify: `apps/web/src/ink/useMeetingInk.ts`
- Modify: `apps/web/test/ink/InkCanvas.test.tsx`
- Modify: `apps/web/src/ink/InkCanvas.tsx`
- Modify: `apps/web/src/meetings/MeetingWorkspacePage.tsx`

- [ ] **Step 1: Write repository RED.** Call `saveMany([first, continuation])`, assert both stroke/outbox rows are written, then force the outbox bulk write to reject and assert neither stroke nor outbox retains partial data.
- [ ] **Step 2: Run repository RED.** Run `npm test -w @meeting/web -- ink/repository`; expect `saveMany` to be missing.
- [ ] **Step 3: Implement atomic repository batching.** Parse every stroke before opening one `rw` transaction, create one mutation per stroke, and `bulkPut` all strokes and mutations inside that transaction. Keep `save(value)` as a one-item compatibility wrapper only where existing callers still require it.
- [ ] **Step 4: Write hook/component Harness RED.** Render `useMeetingInk` and the real `InkCanvas`, draw an oversized gesture, stagger the former per-stroke saves, and assert both continuations arrive in one prop echo while the undo/redo controls remain usable during a deferred sync.
- [ ] **Step 5: Implement one state/sync path.** Expose `saveMany`, call `repository.saveMany` once, merge all strokes in one `setStrokes`, and call `synchronizer.flush` once. Change `InkCanvas` persistence to submit the complete continuation array once; single-stroke erase/undo/redo submit one-item arrays.
- [ ] **Step 6: Run GREEN.** Run `npm test -w @meeting/web -- ink/repository useMeetingInk InkCanvas`; expect the atomicity and real Harness regressions to pass.

### Task 4: Upgrade Already-Applied Ink Schemas

**Files:**
- Modify: `test/supabase-schema.test.mjs`
- Create: `supabase/migrations/202608260001_harden_meeting_ink_validation.sql`

- [ ] **Step 1: Write migration RED.** Read the new migration and assert it is an incremental `create or replace function` migration with strict top-level/point typing, key, numeric-bound, structured `INVALID_REQUEST`, privilege revoke, and authenticated grant checks, without recreating ink tables.
- [ ] **Step 2: Run RED.** Run `node --test test/supabase-schema.test.mjs`; expect the missing migration read to fail.
- [ ] **Step 3: Implement the additive migration.** Copy the reviewed strict RPC definition and grants into `202608260001_harden_meeting_ink_validation.sql`, leaving `202608250004_meeting_ink.sql` unchanged.
- [ ] **Step 4: Run GREEN.** Rerun `node --test test/supabase-schema.test.mjs`; expect the original-schema plus incremental-hardening contract to pass.

### Task 5: Acceptance, Review, and Commit

**Files:**
- Verify only the files listed in Tasks 1-4; exclude `.venv/` and unrelated relay/provider edits.

- [ ] **Step 1: Run focused verification.** Run the four focused Vitest groups, `node --test test/supabase-schema.test.mjs`, and the focused `ink-workspace` Playwright spec.
- [ ] **Step 2: Run full verification.** Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run test:e2e` and record exact pass/fail counts.
- [ ] **Step 3: Self-review.** Inspect `git diff --check`, the complete scoped diff, all four requirements, cleanup paths, and the migration ordering; fix any issue through a new RED→GREEN cycle.
- [ ] **Step 4: Request independent review.** Provide the base/head or scoped working diff and address every Critical/Important finding before proceeding.
- [ ] **Step 5: Commit exact files.** Stage only the scoped workspace, ink, migration, contract-test, E2E, CSS, and plan files, then commit with `git commit -m "fix: close final ink workspace review gaps"`.
