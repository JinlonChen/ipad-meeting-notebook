# Ink and Split Meeting Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the adjustable transcript/notes workspace and permanent offline-first vector handwriting for Apple Pencil, then include keyboard notes in on-demand AI summaries.

**Architecture:** The page becomes a small composition shell: a bounded transcript viewport above a persisted splitter and tab workspace below. A dedicated ink module owns vector strokes, rendering and IndexedDB; an independent sync service sends idempotent stroke mutations to an owner-scoped Supabase RPC. Existing keyboard-note and summary services remain separate and are composed through ports.

**Tech Stack:** React 19, TypeScript, Canvas 2D, Pointer Events, IndexedDB, Supabase Postgres/RPC, Vitest, Testing Library, Playwright.

---

## File Map

- Create `packages/contracts/src/ink.ts`: strict stroke and mutation schemas.
- Create `apps/web/src/ink/model.ts`: points, pressure width, hit testing and undo actions.
- Create `apps/web/src/ink/repository.ts`: user-scoped IndexedDB strokes and coalesced outbox.
- Create `apps/web/src/ink/sync.ts`: serialized pull/flush logic.
- Create `apps/web/src/ink/InkCanvas.tsx` and `InkToolbar.tsx`: focused input/render UI.
- Create `apps/web/src/meetings/MeetingWorkspaceLayout.tsx`: splitter, tabs and autoscroll.
- Create `supabase/migrations/202608250004_meeting_ink.sql`: owner table, tombstones and idempotent RPC.
- Modify `MeetingWorkspacePage.tsx`, `MeetingIntelligencePanel.tsx`, runtime wiring and styles only for composition.
- Modify `process-meeting-intelligence` to accept keyboard notes as a second source without fake evidence IDs.

### Task 1: Ink Contracts and Database Boundary

**Files:**
- Create: `packages/contracts/src/ink.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/ink.test.ts`
- Create: `supabase/migrations/202608250004_meeting_ink.sql`
- Modify: `test/database-contracts.test.mjs`

- [ ] **Step 1: Write failing tests** for `{id, meetingId, order, tool, color, width, points, deleted, version}`. Each point is `{x,y,pressure,elapsedMs}`; cap points at 2048, coordinates at the logical canvas bounds, width at `1..40`, and accept only hex colors. Test RPC ownership, strict keys, tombstones, duplicate `mutationId`, and authenticated select RLS.
- [ ] **Step 2: Run** `npm test -w @meeting/contracts -- ink && node --test test/database-contracts.test.mjs`; expect failures.
- [ ] **Step 3: Implement** Zod contracts plus `meeting_ink_strokes` and `meeting_ink_mutations`. `apply_meeting_ink_mutation` derives `user_id=auth.uid()`, checks meeting ownership, serializes same-stroke updates, records `mutationId`, upserts/tombstones, and returns the canonical stroke.
- [ ] **Step 4: Rerun focused tests** and expect pass.
- [ ] **Step 5: Commit** with `git commit -m "feat: define durable meeting ink"`.

### Task 2: Offline Ink Repository and Sync

**Files:**
- Create: `apps/web/src/ink/repository.ts`
- Create: `apps/web/src/ink/sync.ts`
- Create: `apps/web/test/ink/repository.test.ts`
- Create: `apps/web/test/ink/sync.test.ts`
- Modify: `apps/web/src/supabase/types.ts`

- [ ] **Step 1: Add failing fake-indexeddb tests** for user/meeting isolation, local-first save, outbox coalescing by stroke, tombstone recovery after restart, duplicate mutation acknowledgement, pull merge, and auth pause.
- [ ] **Step 2: Run** `npm test -w @meeting/web -- ink/repository ink/sync`; expect missing module failures.
- [ ] **Step 3: Implement** an IndexedDB database with `strokes` and `outbox` stores. Save stroke and outbox entry in one transaction; retain one latest entry per stroke. Implement a serialized sync queue using the same auth epoch pattern as catalog sync.
- [ ] **Step 4: Rerun focused tests** and expect pass.
- [ ] **Step 5: Commit** with `git commit -m "feat: sync meeting ink offline first"`.

### Task 3: Vector Model, Eraser, Undo and Redo

**Files:**
- Create: `apps/web/src/ink/model.ts`
- Create: `apps/web/test/ink/model.test.ts`

- [ ] **Step 1: Add failing pure tests** for pressure-to-width clamping, fixed logical coordinates, distance-based whole-stroke hit testing, 2048-point continuation split, add/delete undo, redo, and redo-stack clearing after a new action.
- [ ] **Step 2: Run** `npm test -w @meeting/web -- ink/model`; expect missing module failure.
- [ ] **Step 3: Implement** immutable functions `appendPoint`, `splitLongStroke`, `hitStroke`, `applyInkAction`, `undoInkAction`, and `redoInkAction`. Keep no Canvas or database code in this file.
- [ ] **Step 4: Rerun focused tests** and expect pass.
- [ ] **Step 5: Commit** with `git commit -m "feat: add vector ink editing model"`.

### Task 4: Apple Pencil Canvas and Toolbar

**Files:**
- Create: `apps/web/src/ink/InkCanvas.tsx`
- Create: `apps/web/src/ink/InkToolbar.tsx`
- Create: `apps/web/test/ink/InkCanvas.test.tsx`
- Modify: `apps/web/src/app/styles.css`

- [ ] **Step 1: Add failing component tests** for pen/highlighter/color/width selection, Pencil pressure, pointer capture, whole-stroke erasing, undo/redo disabled states, commit on pointer-up/cancel/visibility loss, resize redraw from vectors, and save-error input lock.
- [ ] **Step 2: Run** `npm test -w @meeting/web -- InkCanvas`; expect missing component failure.
- [ ] **Step 3: Implement** DPR-aware Canvas rendering from logical vectors. Use Pointer Events, `touch-action` constraints, Lucide icons, swatches, a numeric width control, and tooltips. Finger scrolls the ink surface while Pencil or test mouse draws.
- [ ] **Step 4: Rerun tests** and verify nonblank canvas pixels at 744x1133 and 1133x744 with Playwright.
- [ ] **Step 5: Commit** with `git commit -m "feat: add Apple Pencil ink canvas"`.

### Task 5: Adjustable Splitter, Transcript Autoscroll and Tabs

**Files:**
- Create: `apps/web/src/meetings/MeetingWorkspaceLayout.tsx`
- Create: `apps/web/test/meetings/MeetingWorkspaceLayout.test.tsx`
- Modify: `apps/web/src/meetings/MeetingWorkspacePage.tsx`
- Modify: `apps/web/src/intelligence/MeetingIntelligencePanel.tsx`
- Modify: `apps/web/src/app/styles.css`

- [ ] **Step 1: Add failing tests** for 45% default, 30–70% clamping, separate portrait/landscape persistence, keyboard-accessible separator, default Handwriting tab, tab-state survival, user-scroll pause and `回到最新` restoration.
- [ ] **Step 2: Run** `npm test -w @meeting/web -- MeetingWorkspaceLayout MeetingWorkspacePage MeetingIntelligencePanel`; expect failures.
- [ ] **Step 3: Implement** a bounded CSS grid with an ARIA separator and pointer drag. Move transcript content into the top scroller; place `手写 / 键盘 / AI 总结` in a stable tablist below. Keep page orchestration in `MeetingWorkspacePage` and stateful behavior in focused children.
- [ ] **Step 4: Rerun focused tests** and inspect portrait/landscape screenshots for overlap, clipping and readable sync states.
- [ ] **Step 5: Commit** with `git commit -m "feat: build split meeting workspace"`.

### Task 6: Runtime Ink Wiring and Unified Status

**Files:**
- Modify: `apps/web/src/app/runtime.ts`
- Modify: `apps/web/src/auth/App.tsx`
- Modify: `apps/web/src/meetings/MeetingWorkspacePage.tsx`
- Modify: focused runtime/auth/workspace tests

- [ ] **Step 1: Add failing tests** that login selects the ink user scope, logout clears visible state but not another user's records, offline edits show `已保存到本机，待同步`, reconnect flushes, and navigation/visibility flushes an active stroke plus keyboard note.
- [ ] **Step 2: Run** `npm test -w @meeting/web -- app/runtime auth/App MeetingWorkspacePage`; expect failures.
- [ ] **Step 3: Wire** one long-lived ink repository/sync instance beside catalog sync. Combine note and ink statuses by priority: error, conflict, saving, pending sync, synced/local. Do not expose ink details to recording controllers.
- [ ] **Step 4: Rerun focused tests** and expect pass.
- [ ] **Step 5: Commit** with `git commit -m "feat: wire permanent meeting handwriting"`.

### Task 7: Keyboard Notes in AI Summary

**Files:**
- Modify: `supabase/functions/process-meeting-intelligence/intelligence-core.mjs`
- Modify: `supabase/functions/process-meeting-intelligence/intelligence-core.test.mjs`
- Modify: `supabase/functions/process-meeting-intelligence/index.ts`
- Modify: `apps/web/src/intelligence/MeetingIntelligencePanel.tsx`

- [ ] **Step 1: Add failing tests** for transcript-only, note-only, combined labeled input, empty-both rejection, and evidence IDs that may reference transcript positions only.
- [ ] **Step 2: Run** `node --test supabase/functions/process-meeting-intelligence/intelligence-core.test.mjs`; expect note-input failures.
- [ ] **Step 3: Implement note-aware summary input.** Read `meetings.note` with owner scope and pass `{transcript,note}` to the core. Format `[转写 n] 发言人: text` and `[键盘笔记] note`; allow note-only summaries but keep evidence arrays empty for note-only facts. Keep ink completely absent from the function.
- [ ] **Step 4: Rerun focused tests** and deploy the versioned function.
- [ ] **Step 5: Commit** with `git commit -m "feat: include meeting notes in AI summary"`.

### Task 8: Full Verification, Deployment and iPad Acceptance

**Files:**
- Create: `apps/web/e2e/ink-workspace.spec.ts`
- Modify: `docs/testing/ipad-foundation-checklist.md`

- [ ] **Step 1: Add Playwright coverage** for offline drawing, reload recovery, reconnect sync, tab state, splitter persistence, transcript scroll pause and no overlap at iPad mini portrait/landscape viewports.
- [ ] **Step 2: Run** `npm test && npm run typecheck && npm run build && npm run scan:web-dist && npm run test:e2e -w @meeting/web -- ink-workspace`.
- [ ] **Step 3: Deploy backend and web.** Deploy the migration and summary function, push/merge through the existing GitHub Pages workflow, and wait for success.
- [ ] **Step 4: Verify cross-device data.** From a second authenticated browser, confirm permanent vectors render, tombstones stay deleted, and no handwritten content appears in AI provider requests.
- [ ] **Step 5: Run iPad acceptance.** Guide the user in this exact order: offline handwrite, close/reopen, reconnect/sync, second-device restore, pressure/tools/eraser/undo/redo, portrait/landscape splitter, keyboard note, AI summary.
