import type { Folder, Meeting } from "@meeting/contracts";
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { MeetingCatalogRepository } from "./repository.js";
import { MeetingRecordingControls, type MeetingRecorderPort } from "../recording/MeetingRecordingControls.js";
import { MeetingIntelligencePanel, type MeetingIntelligencePort } from "../intelligence/MeetingIntelligencePanel.js";
import type { SyncResult } from "./sync.js";
import { type NoteSaveState, useMeetingNote } from "./useMeetingNote.js";
import { MeetingWorkspaceLayout } from "./MeetingWorkspaceLayout.js";
import { InkCanvas } from "../ink/InkCanvas.js";
import { useMeetingInk } from "../ink/useMeetingInk.js";
import { InkRepository } from "../ink/repository.js";
import type { InkSynchronizer } from "../ink/sync.js";

type Props = {
  repository: MeetingCatalogRepository;
  refresh: () => Promise<SyncResult>;
  scheduleRefresh?: () => Promise<SyncResult>;
  online: boolean;
  recorder: MeetingRecorderPort;
  now?: () => string;
  intelligence?: MeetingIntelligencePort;
  inkRepository?: InkRepository;
  inkSynchronizer?: InkSynchronizer;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "trashed" }
  | { kind: "error" }
  | { kind: "ready"; meeting: Meeting; folders: Folder[]; noteSyncState: Awaited<ReturnType<MeetingCatalogRepository["meetingNoteSyncState"]>> };

function statusLabel(status: Meeting["status"]): string {
  return ({
    draft: "草稿",
    recording: "录音中",
    recoverable: "待恢复",
    uploading: "上传中",
    processing: "处理中",
    ready: "已完成",
    failed: "失败",
    trashed: "已移至废纸篓",
  })[status];
}

function updatedTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function saveStateText(state: NoteSaveState): string {
  if (state === "saving") return "保存中";
  if (state === "pending-sync") return "正在同步";
  if (state === "synced") return "已同步";
  if (state === "conflict") return "冲突";
  if (state === "error") return "保存失败";
  if (state === "saved-local") return "已保存到本机，待同步";
  return "已保存到本机";
}

export function MeetingWorkspacePage({ repository, refresh, scheduleRefresh = refresh, online, recorder, now = () => new Date().toISOString(), intelligence, inkRepository, inkSynchronizer }: Props) {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const refreshRef = useRef(refresh);
  const onlineRef = useRef(online);
  const previousOnlineRef = useRef(online);
  const loadGenerationRef = useRef(0);
  refreshRef.current = refresh;
  onlineRef.current = online;

  const loadCatalog = useCallback(async (refreshOnline: boolean) => {
    const generation = ++loadGenerationRef.current;
    setLoadState({ kind: "loading" });
    let refreshFailed = false;
    if (refreshOnline) {
      try {
        const result = await refreshRef.current();
        refreshFailed = result.state !== "idle";
      } catch {
        refreshFailed = true;
      }
    }
    if (loadGenerationRef.current !== generation) return;
    try {
      const [meeting, folders] = await Promise.all([repository.get(id), repository.listFolders()]);
      if (loadGenerationRef.current !== generation) return;
      if (!meeting) setLoadState({ kind: refreshFailed ? "error" : "missing" });
      else if (meeting.status === "trashed") setLoadState({ kind: "trashed" });
      else setLoadState({ kind: "ready", meeting, folders, noteSyncState: await repository.meetingNoteSyncState(meeting.id) });
    } catch {
      if (loadGenerationRef.current === generation) setLoadState({ kind: "error" });
    }
  }, [id, repository]);

  useEffect(() => {
    void loadCatalog(onlineRef.current);
    return () => { loadGenerationRef.current += 1; };
  }, [loadCatalog]);

  useEffect(() => {
    const wasOnline = previousOnlineRef.current;
    previousOnlineRef.current = online;
    if (wasOnline || !online || loadState.kind === "ready") return;
    void loadCatalog(true);
  }, [loadCatalog, loadState.kind, online]);

  const returnImmediately = useCallback(() => navigate("/meetings"), [navigate]);
  if (loadState.kind === "loading") return <WorkspaceMessage title="会议笔记" status="正在载入会议..." onBack={returnImmediately} />;
  if (loadState.kind === "missing") return <WorkspaceMessage title="找不到会议" onBack={returnImmediately} />;
  if (loadState.kind === "trashed") return <WorkspaceMessage title="会议已移至废纸篓" onBack={returnImmediately} />;
  if (loadState.kind === "error") return <WorkspaceMessage title="无法载入会议" onBack={returnImmediately} />;
  return <MeetingEditor meeting={loadState.meeting} folders={loadState.folders} noteSyncState={loadState.noteSyncState} repository={repository} recorder={recorder} scheduleRefresh={scheduleRefresh} online={online} now={now} {...(intelligence ? { intelligence } : {})} {...(inkRepository ? { inkRepository } : {})} {...(inkSynchronizer ? { inkSynchronizer } : {})} />;
}

function WorkspaceMessage({ title, status, onBack }: { title: string; status?: string; onBack: () => void }) {
  return <main className="workspace-shell workspace-message">
    <header className="workspace-topbar">
      <button className="icon-button" aria-label="返回会议" title="返回会议" onClick={onBack}><ChevronLeft size={18} /></button>
      <h1>{title}</h1>
      {status && <span className="workspace-save-state" role="status" aria-live="polite">{status}</span>}
    </header>
  </main>;
}

type EditorProps = {
  meeting: Meeting;
  folders: Folder[];
  noteSyncState: Awaited<ReturnType<MeetingCatalogRepository["meetingNoteSyncState"]>>;
  repository: MeetingCatalogRepository;
  recorder: MeetingRecorderPort;
  scheduleRefresh: () => Promise<SyncResult>;
  online: boolean;
  now: () => string;
  intelligence?: MeetingIntelligencePort;
  inkRepository?: InkRepository;
  inkSynchronizer?: InkSynchronizer;
};

function combinedSaveState(note: NoteSaveState, ink: import("../ink/useMeetingInk.js").InkSaveState): NoteSaveState {
  const priority: NoteSaveState[] = ["error", "conflict", "saving", "pending-sync", "saved-local", "synced", "idle"];
  return priority.find((state) => state === note || state === ink) ?? "idle";
}

function MeetingEditor({ meeting, folders, noteSyncState, repository, recorder, scheduleRefresh, online, now, intelligence, inkRepository, inkSynchronizer }: EditorProps) {
  const navigate = useNavigate();
  const [returning, setReturning] = useState(false);
  const note = useMeetingNote({ meetingId: meeting.id, initialNote: meeting.note, initialSyncState: noteSyncState, repository, scheduleRefresh, online, now });
  const localInkRepository = useMemo(() => inkRepository ?? new InkRepository(() => repository.recordingDatabase()), [inkRepository, repository]);
  const ink = useMeetingInk({ meetingId: meeting.id, repository: localInkRepository, online, ...(inkSynchronizer ? { synchronizer: inkSynchronizer } : {}) });
  const [transcriptRevision, setTranscriptRevision] = useState(0);
  const folderName = folders.find((folder) => folder.id === meeting.folderId)?.name ?? "未分类";
  const flushNoteBeforeSummary = useCallback(async () => {
    if (!(await note.flush()) || !online) return false;
    try {
      return (await scheduleRefresh()).state === "idle";
    } catch {
      return false;
    }
  }, [note.flush, online, scheduleRefresh]);

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.hidden) void note.flush();
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => document.removeEventListener("visibilitychange", flushWhenHidden);
  }, [note.flush]);

  const back = useCallback(async () => {
    if (returning) return;
    setReturning(true);
    const saved = await note.flush();
    if (saved) navigate("/meetings");
    else setReturning(false);
  }, [navigate, note.flush, returning]);

  return <main className="workspace-shell">
    <header className="workspace-topbar">
      <button className="icon-button" aria-label="返回会议" title="返回会议" disabled={returning} onClick={() => void back()}><ChevronLeft size={18} /></button>
      <h1>{meeting.title}</h1>
      <span className="workspace-save-state" role="status" aria-live="polite">{saveStateText(combinedSaveState(note.state, ink.state))}</span>
    </header>
    <section className="workspace-meta" aria-label="会议信息">
      <span>{statusLabel(meeting.status)}</span>
      <span>{folderName}</span>
      <time dateTime={meeting.updatedAt}>更新于 {updatedTime(meeting.updatedAt)}</time>
    </section>
    <MeetingRecordingControls meetingId={meeting.id} recorder={recorder} online={online} />
    <MeetingWorkspaceLayout
      transcript={intelligence
        ? <MeetingIntelligencePanel api={intelligence} meetingId={meeting.id} online={online} recorder={recorder} view="transcript" onTranscriptRevision={setTranscriptRevision} />
        : <p className="intelligence-hint">实时转写未配置。</p>}
      transcriptRevision={transcriptRevision}
      handwriting={ink.loading
        ? <p className="workspace-panel-message">正在载入手写笔记...</p>
        : <InkCanvas meetingId={meeting.id} initialStrokes={ink.strokes} onSave={ink.saveMany} />}
      keyboard={<label className="note-editor"><span>会议笔记</span><textarea aria-label="会议笔记" value={note.draft} onChange={(event) => note.setDraft(event.target.value)} onBlur={() => void note.flush()} /></label>}
      summary={intelligence
        ? <MeetingIntelligencePanel api={intelligence} meetingId={meeting.id} online={online} view="summary" hasKeyboardNote={note.draft.trim().length > 0} beforeSummarize={flushNoteBeforeSummary} />
        : <p className="workspace-panel-message">AI 总结未配置。</p>}
    />
    {note.error && <div className="workspace-error" role="alert"><span>{note.error}</span><button className="text-button" onClick={() => void note.retry()}>重试</button></div>}
  </main>;
}
