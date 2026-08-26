import type { InkStroke } from "@meeting/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import type { InkRepository } from "./repository.js";
import type { InkSynchronizer } from "./sync.js";

export type InkSaveState = "idle" | "saving" | "saved-local" | "pending-sync" | "synced" | "error";

type Options = {
  meetingId: string;
  repository: InkRepository;
  synchronizer?: Pick<InkSynchronizer, "flush" | "refresh">;
  online: boolean;
};

function sameStrokes(left: InkStroke[], right: InkStroke[]): boolean {
  return left.length === right.length && left.every((stroke, index) => JSON.stringify(stroke) === JSON.stringify(right[index]));
}

export function useMeetingInk({ meetingId, repository, synchronizer, online }: Options) {
  const [strokes, setStrokes] = useState<InkStroke[]>([]);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<InkSaveState>("idle");
  const [error, setError] = useState("");
  const generationRef = useRef(0);
  const onlineRef = useRef(online);
  onlineRef.current = online;

  const reload = useCallback(async () => {
    const values = await repository.list(meetingId, true);
    setStrokes((current) => sameStrokes(current, values) ? current : values);
  }, [meetingId, repository]);

  useEffect(() => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        await reload();
        const pending = (await repository.pending()).some((mutation) => mutation.stroke.meetingId === meetingId);
        if (online && synchronizer) {
          setState("pending-sync");
          const result = await synchronizer.refresh(meetingId);
          if (generationRef.current !== generation) return;
          await reload();
          setState(result === "idle" ? "synced" : pending ? "saved-local" : "idle");
        } else {
          setState(pending ? "saved-local" : "idle");
        }
      } catch {
        if (generationRef.current !== generation) return;
        setError("无法读取本机手写笔记");
        setState("error");
      } finally {
        if (generationRef.current === generation) setLoading(false);
      }
    })();
    return () => { generationRef.current += 1; };
  }, [meetingId, online, reload, repository, synchronizer]);

  const saveMany = useCallback(async (values: InkStroke[]) => {
    if (values.length === 0) return;
    setState("saving");
    setError("");
    try {
      await repository.saveMany(values);
      const ids = new Set(values.map((stroke) => stroke.id));
      setStrokes((current) => [...current.filter((item) => !ids.has(item.id)), ...values].sort((left, right) => left.order - right.order));
    } catch (saveError) {
      setState("error");
      setError("手写未保存，请重试");
      throw saveError;
    }
    if (!onlineRef.current || !synchronizer) {
      setState("saved-local");
      return;
    }
    setState("pending-sync");
    const result = await synchronizer.flush();
    if (result === "idle") {
      await reload();
      setState("synced");
    } else {
      setState("saved-local");
    }
  }, [reload, repository, synchronizer]);

  const save = useCallback((stroke: InkStroke) => saveMany([stroke]), [saveMany]);

  return { strokes, loading, state, error, save, saveMany };
}
