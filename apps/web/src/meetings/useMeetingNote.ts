import { MeetingNoteSchema } from "@meeting/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { MeetingConflictPendingError, MeetingCatalogRepository } from "./repository.js";
import type { SyncResult } from "./sync.js";

export type NoteSaveState = "idle" | "saving" | "saved-local" | "pending-sync" | "synced" | "conflict" | "error";

export type UseMeetingNoteResult = {
  draft: string;
  setDraft(value: string): void;
  state: NoteSaveState;
  error: string;
  flush(): Promise<boolean>;
  retry(): Promise<void>;
};

type Options = {
  meetingId: string;
  initialNote: string;
  repository: MeetingCatalogRepository;
  online: boolean;
  scheduleRefresh: () => Promise<SyncResult>;
  now: () => string;
};

const SAVE_DELAY_MS = 600;

export function useMeetingNote({ meetingId, initialNote, repository, online, scheduleRefresh, now }: Options): UseMeetingNoteResult {
  const [draft, setDraftState] = useState(initialNote);
  const [state, setState] = useState<NoteSaveState>("idle");
  const [error, setError] = useState("");
  const draftRef = useRef(initialNote);
  const draftRevisionRef = useRef(0);
  const persistedRef = useRef(initialNote);
  const persistedRevisionRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const activeSaveRef = useRef<Promise<boolean> | null>(null);
  const mountedRef = useRef(true);
  const onlineRef = useRef(online);
  const scheduleRefreshRef = useRef(scheduleRefresh);
  const nowRef = useRef(now);
  const flushRef = useRef<() => Promise<boolean>>(async () => true);

  onlineRef.current = online;
  scheduleRefreshRef.current = scheduleRefresh;
  nowRef.current = now;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  const updateFailure = useCallback((nextState: "conflict" | "error", message: string) => {
    if (!mountedRef.current) return;
    setState(nextState);
    setError(message);
  }, []);

  const synchronize = useCallback(async (savedRevision: number): Promise<void> => {
    if (!onlineRef.current || !mountedRef.current) {
      if (mountedRef.current) setState("saved-local");
      return;
    }
    setState("pending-sync");
    try {
      const result = await scheduleRefreshRef.current();
      if (!mountedRef.current || draftRevisionRef.current !== savedRevision) return;
      if (result.state === "idle") {
        setState("synced");
        setError("");
      } else if (result.state === "conflict") {
        setState("conflict");
        setError("会议笔记同步冲突，请在会议列表中处理。");
      } else {
        setState("saved-local");
      }
    } catch {
      if (mountedRef.current && draftRevisionRef.current === savedRevision) setState("saved-local");
    }
  }, []);

  const runSaveQueue = useCallback(async (): Promise<boolean> => {
    while (mountedRef.current) {
      const value = draftRef.current;
      const revision = draftRevisionRef.current;
      if (value === persistedRef.current && revision === persistedRevisionRef.current) return true;
      const parsed = MeetingNoteSchema.safeParse(value);
      if (!parsed.success) {
        updateFailure("error", "会议笔记不能超过 200,000 个字符。");
        return false;
      }

      setState("saving");
      setError("");
      try {
        await repository.saveNote(meetingId, parsed.data, nowRef.current());
      } catch (saveError) {
        if (saveError instanceof MeetingConflictPendingError) {
          updateFailure("conflict", "会议笔记存在同步冲突，请在会议列表中处理。");
        } else {
          updateFailure("error", "保存失败，请重试。");
        }
        return false;
      }

      persistedRef.current = value;
      persistedRevisionRef.current = revision;
      if (!mountedRef.current) return true;
      if (draftRevisionRef.current !== revision) continue;
      setState("saved-local");
      void synchronize(revision);
      return true;
    }
    return false;
  }, [meetingId, repository, synchronize, updateFailure]);

  const flush = useCallback((): Promise<boolean> => {
    clearTimer();
    if (activeSaveRef.current) return activeSaveRef.current;
    if (draftRef.current === persistedRef.current && draftRevisionRef.current === persistedRevisionRef.current) return Promise.resolve(true);
    const active = runSaveQueue();
    activeSaveRef.current = active;
    void active.finally(() => {
      if (activeSaveRef.current === active) activeSaveRef.current = null;
    });
    return active;
  }, [clearTimer, runSaveQueue]);
  flushRef.current = flush;

  const setDraft = useCallback((value: string) => {
    draftRevisionRef.current += 1;
    draftRef.current = value;
    setDraftState(value);
    setError("");
    setState("idle");
    clearTimer();
    if (activeSaveRef.current || (value === persistedRef.current && draftRevisionRef.current === persistedRevisionRef.current)) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      void flushRef.current();
    }, SAVE_DELAY_MS);
  }, [clearTimer]);

  const retry = useCallback(async () => {
    if (draftRef.current !== persistedRef.current || draftRevisionRef.current !== persistedRevisionRef.current) {
      await flush();
      return;
    }
    if (!onlineRef.current) {
      if (mountedRef.current) {
        setState("saved-local");
        setError("");
      }
      return;
    }
    setError("");
    await synchronize(persistedRevisionRef.current);
  }, [flush, synchronize]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  return { draft, setDraft, state, error, flush, retry };
}
