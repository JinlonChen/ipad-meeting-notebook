import type { Folder, Meeting } from "@meeting/contracts";
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { MeetingCatalogRepository } from "./repository.js";
import type { SyncResult } from "./sync.js";
import { type NoteSaveState, useMeetingNote } from "./useMeetingNote.js";

type Props = {
  repository: MeetingCatalogRepository;
  refresh: () => Promise<SyncResult>;
  scheduleRefresh?: () => Promise<SyncResult>;
  online: boolean;
  now?: () => string;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "trashed" }
  | { kind: "error" }
  | { kind: "ready"; meeting: Meeting; folders: Folder[] };

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

export function MeetingWorkspacePage({ repository, refresh, scheduleRefresh = refresh, online, now = () => new Date().toISOString() }: Props) {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const refreshRef = useRef(refresh);
  const onlineRef = useRef(online);
  refreshRef.current = refresh;
  onlineRef.current = online;

  useEffect(() => {
    let active = true;
    setLoadState({ kind: "loading" });
    void (async () => {
      let refreshFailed = false;
      if (onlineRef.current) {
        try {
          const result = await refreshRef.current();
          refreshFailed = result.state !== "idle";
        } catch {
          refreshFailed = true;
        }
      }
      if (!active) return;
      try {
        const [meeting, folders] = await Promise.all([repository.get(id), repository.listFolders()]);
        if (!active) return;
        if (!meeting) setLoadState({ kind: refreshFailed ? "error" : "missing" });
        else if (meeting.status === "trashed") setLoadState({ kind: "trashed" });
        else setLoadState({ kind: "ready", meeting, folders });
      } catch {
        if (active) setLoadState({ kind: "error" });
      }
    })();
    return () => { active = false; };
  }, [id, repository]);

  const returnImmediately = useCallback(() => navigate("/meetings"), [navigate]);
  if (loadState.kind === "loading") return <WorkspaceMessage title="会议笔记" status="正在载入会议..." onBack={returnImmediately} />;
  if (loadState.kind === "missing") return <WorkspaceMessage title="找不到会议" onBack={returnImmediately} />;
  if (loadState.kind === "trashed") return <WorkspaceMessage title="会议已移至废纸篓" onBack={returnImmediately} />;
  if (loadState.kind === "error") return <WorkspaceMessage title="无法载入会议" onBack={returnImmediately} />;
  return <MeetingEditor meeting={loadState.meeting} folders={loadState.folders} repository={repository} scheduleRefresh={scheduleRefresh} online={online} now={now} />;
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
  repository: MeetingCatalogRepository;
  scheduleRefresh: () => Promise<SyncResult>;
  online: boolean;
  now: () => string;
};

function MeetingEditor({ meeting, folders, repository, scheduleRefresh, online, now }: EditorProps) {
  const navigate = useNavigate();
  const [returning, setReturning] = useState(false);
  const note = useMeetingNote({ meetingId: meeting.id, initialNote: meeting.note, repository, scheduleRefresh, online, now });
  const folderName = folders.find((folder) => folder.id === meeting.folderId)?.name ?? "未分类";

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
      <span className="workspace-save-state" role="status" aria-live="polite">{saveStateText(note.state)}</span>
    </header>
    <section className="workspace-meta" aria-label="会议信息">
      <span>{statusLabel(meeting.status)}</span>
      <span>{folderName}</span>
      <time dateTime={meeting.updatedAt}>更新于 {updatedTime(meeting.updatedAt)}</time>
    </section>
    <label className="note-editor">
      <span>会议笔记</span>
      <textarea aria-label="会议笔记" value={note.draft} onChange={(event) => note.setDraft(event.target.value)} onBlur={() => void note.flush()} />
    </label>
    {note.error && <div className="workspace-error" role="alert"><span>{note.error}</span><button className="text-button" onClick={() => void note.retry()}>重试</button></div>}
  </main>;
}
