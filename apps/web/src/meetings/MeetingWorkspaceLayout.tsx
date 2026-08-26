import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

type Tab = "ink" | "keyboard" | "summary";
type WorkspaceOrientation = "portrait" | "landscape";

const clamp = (value: number) => Math.min(70, Math.max(30, Math.round(value)));
const currentOrientation = (): WorkspaceOrientation => window.innerHeight > window.innerWidth ? "portrait" : "landscape";
const storageKey = (orientation: WorkspaceOrientation) => `meeting-workspace-ratio-${orientation}`;

function storedRatio(orientation: WorkspaceOrientation): number {
  const stored = Number(localStorage.getItem(storageKey(orientation)));
  return Number.isFinite(stored) && stored >= 30 && stored <= 70 ? stored : 45;
}

export function MeetingWorkspaceLayout({ transcript, transcriptRevision, handwriting, keyboard, summary }: {
  transcript: ReactNode;
  transcriptRevision: number;
  handwriting: ReactNode;
  keyboard: ReactNode;
  summary: ReactNode;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptContentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const userScrollingRef = useRef(false);
  const draggingRef = useRef(false);
  const orientationRef = useRef(currentOrientation());
  const [ratio, setRatio] = useState(() => storedRatio(orientationRef.current));
  const [tab, setTab] = useState<Tab>("ink");
  const [following, setFollowing] = useState(true);

  const saveRatio = (value: number) => {
    const next = clamp(value);
    setRatio(next);
    localStorage.setItem(storageKey(orientationRef.current), String(next));
  };

  const latest = () => {
    const element = transcriptRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    followingRef.current = true;
    userScrollingRef.current = false;
    setFollowing(true);
  };

  useLayoutEffect(() => {
    if (followingRef.current) latest();
  }, [transcriptRevision]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || !transcriptContentRef.current) return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) latest();
    });
    observer.observe(transcriptContentRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const restoreOrientationRatio = () => {
      const nextOrientation = currentOrientation();
      if (nextOrientation === orientationRef.current) return;
      orientationRef.current = nextOrientation;
      setRatio(storedRatio(nextOrientation));
    };
    window.addEventListener("resize", restoreOrientationRatio);
    window.addEventListener("orientationchange", restoreOrientationRatio);
    return () => {
      window.removeEventListener("resize", restoreOrientationRatio);
      window.removeEventListener("orientationchange", restoreOrientationRatio);
    };
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!draggingRef.current || !shellRef.current) return;
      const bounds = shellRef.current.getBoundingClientRect();
      saveRatio((event.clientY - bounds.top) / Math.max(1, bounds.height) * 100);
    };
    const stop = () => { draggingRef.current = false; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  const onTranscriptScroll = () => {
    const element = transcriptRef.current;
    if (!element) return;
    const atLatest = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    if (atLatest) {
      followingRef.current = true;
      userScrollingRef.current = false;
      setFollowing(true);
    } else if (userScrollingRef.current) {
      followingRef.current = false;
      userScrollingRef.current = false;
      setFollowing(false);
    }
  };

  return <section ref={shellRef} className="meeting-workspace-body" style={{ "--transcript-ratio": `${ratio}%` } as React.CSSProperties}>
    <div
      ref={transcriptRef}
      className="workspace-transcript"
      aria-label="实时转写区域"
      onScroll={onTranscriptScroll}
      onWheel={() => {
        userScrollingRef.current = true;
        requestAnimationFrame(() => { userScrollingRef.current = false; });
      }}
      onPointerDown={() => { userScrollingRef.current = true; }}
      onPointerUp={() => { userScrollingRef.current = false; }}
      onPointerCancel={() => { userScrollingRef.current = false; }}
    >
      <div ref={transcriptContentRef} className="workspace-transcript-content">
        {transcript}
        {!following && <button className="back-to-latest" onClick={latest}>回到最新</button>}
      </div>
    </div>
    <div
      className="workspace-separator"
      role="separator"
      aria-label="调整转写区域高度"
      aria-orientation="horizontal"
      aria-valuemin={30}
      aria-valuemax={70}
      aria-valuenow={ratio}
      tabIndex={0}
      onPointerDown={() => { draggingRef.current = true; }}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") { event.preventDefault(); saveRatio(ratio - 5); }
        if (event.key === "ArrowDown") { event.preventDefault(); saveRatio(ratio + 5); }
      }}
    ><span /></div>
    <div className="workspace-notes">
      <div className="workspace-tabs" role="tablist" aria-label="会议内容">
        <TabButton id="ink" selected={tab === "ink"} onSelect={setTab}>手写</TabButton>
        <TabButton id="keyboard" selected={tab === "keyboard"} onSelect={setTab}>键盘</TabButton>
        <TabButton id="summary" selected={tab === "summary"} onSelect={setTab}>AI 总结</TabButton>
      </div>
      <div className="workspace-tab-panels">
        <div role="tabpanel" aria-label="手写" hidden={tab !== "ink"}>{handwriting}</div>
        <div role="tabpanel" aria-label="键盘" hidden={tab !== "keyboard"}>{keyboard}</div>
        <div role="tabpanel" aria-label="AI 总结" hidden={tab !== "summary"}>{summary}</div>
      </div>
    </div>
  </section>;
}

function TabButton({ id, selected, onSelect, children }: { id: Tab; selected: boolean; onSelect(tab: Tab): void; children: ReactNode }) {
  return <button role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1} onClick={() => onSelect(id)}>{children}</button>;
}
