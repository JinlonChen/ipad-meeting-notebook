import type { Folder, Meeting } from "@meeting/contracts";
import { ChevronLeft, Folder as FolderIcon, FolderPlus, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { SyncResult } from "./sync.js";
import { MeetingCatalogRepository } from "./repository.js";

type Props = {
  repository: MeetingCatalogRepository;
  refresh: () => Promise<SyncResult>;
  now?: () => string;
  online: boolean;
  onLogout?: () => void;
};
type Filter = "all" | "unfiled" | "trashed" | string;
type Dialog = { kind: "meeting" | "folder" | "renameMeeting" | "renameFolder"; id?: string; initial?: string } | null;

function dateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
function duration(meeting: Meeting): string | null {
  if (!meeting.startedAt || !meeting.endedAt) return null;
  const minutes = Math.max(0, Math.floor((new Date(meeting.endedAt).getTime() - new Date(meeting.startedAt).getTime()) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}小时${minutes % 60}分` : `${minutes}分钟`;
}
function statusLabel(status: Meeting["status"]): string {
  return ({ draft: "草稿", recording: "录音中", recoverable: "待恢复", uploading: "上传中", processing: "处理中", ready: "已完成", failed: "失败", trashed: "已移至废纸篓" })[status];
}

export function MeetingListPage({ repository, refresh, now = () => new Date().toISOString(), online, onLogout }: Props) {
  const navigate = useNavigate();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [formError, setFormError] = useState("");
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncResult["state"] | "syncing">(online ? "idle" : "paused_auth");
  const [railOpen, setRailOpen] = useState(false);
  const [actionMeeting, setActionMeeting] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const [nextMeetings, nextFolders] = await Promise.all([repository.list({ includeTrashed: true }), repository.listFolders()]);
    setMeetings(nextMeetings);
    setFolders(nextFolders);
    setLoading(false);
  }, [repository]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!online) { setSyncState("paused_auth"); return; }
    let active = true;
    void refresh().then((result) => { if (active) setSyncState(result.state); }).then(reload);
    return () => { active = false; };
  }, [online, refresh, reload]);

  const shown = meetings.filter((meeting) => {
    if (filter === "trashed" ? meeting.status !== "trashed" : meeting.status === "trashed") return false;
    if (filter === "unfiled" && meeting.folderId !== null) return false;
    if (filter !== "all" && filter !== "unfiled" && filter !== "trashed" && meeting.folderId !== filter) return false;
    return meeting.title.toLowerCase().includes(search.trim().toLowerCase());
  });
  const activeFolder = folders.find((folder) => folder.id === filter);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog) return;
    const form = new FormData(event.currentTarget);
    const value = String(form.get("name") ?? "").trim();
    const maximum = dialog.kind === "folder" || dialog.kind === "renameFolder" ? 80 : 120;
    if (!value) { setFormError(dialog.kind === "folder" || dialog.kind === "renameFolder" ? "请输入分类名称" : "请输入会议名称"); return; }
    if (value.length > maximum) { setFormError(`名称不能超过 ${maximum} 个字符`); return; }
    if (dialog.kind === "meeting") {
      const meeting = await repository.create(value, activeFolder?.id ?? null, now());
      setDialog(null); setFormError(""); await reload(); navigate(`/meetings/${meeting.id}`); return;
    }
    if (dialog.kind === "folder") await repository.createFolder(value, now());
    if (dialog.kind === "renameMeeting" && dialog.id) await repository.rename(dialog.id, value, now());
    if (dialog.kind === "renameFolder" && dialog.id) await repository.renameFolder(dialog.id, value, now());
    setDialog(null); setFormError(""); await reload();
  }
  async function removeFolder() {
    if (!confirmation) return;
    await repository.removeFolder(confirmation, now());
    if (filter === confirmation) setFilter("unfiled");
    setConfirmation(null); await reload();
  }
  async function syncNow() {
    if (!online) return;
    setSyncState("syncing");
    const result = await refresh(); setSyncState(result.state); await reload();
  }
  function stateText() {
    if (!online) return "离线，等待同步";
    if (syncState === "syncing") return "正在同步";
    if (syncState === "error") return "同步出错";
    if (syncState === "paused_auth") return "同步已暂停";
    if (syncState === "conflict") return "同步冲突";
    return "已同步";
  }
  const emptyText = search ? "没有匹配的会议" : filter === "trashed" ? "废纸篓为空" : filter !== "all" ? "此分类暂无会议" : "还没有会议";

  return <main className="catalog-shell" data-layout={railOpen ? "drawer-open" : "desktop"}>
    <header className="catalog-topbar">
      <button className="icon-button rail-toggle" aria-label="打开分类" title="打开分类" onClick={() => setRailOpen(true)}><FolderIcon size={18} /></button>
      <h1>会议本</h1>
      <div className="topbar-actions">
        <span className={`sync-state ${online ? "" : "offline"}`} aria-live="polite">{stateText()}</span>
        <button className="icon-button" aria-label="同步会议" title="同步会议" disabled={!online} onClick={() => void syncNow()}><RefreshCw size={18} /></button>
        {onLogout && <button className="text-button" onClick={onLogout}>退出</button>}
      </div>
    </header>
    <aside className={`folder-rail ${railOpen ? "open" : ""}`} aria-label="会议分类">
      <div className="rail-heading"><strong>分类</strong><button className="icon-button rail-close" aria-label="关闭分类" title="关闭分类" onClick={() => setRailOpen(false)}><X size={18} /></button><button className="icon-button" aria-label="新建分类" title="新建分类" onClick={() => setDialog({ kind: "folder" })}><FolderPlus size={18} /></button></div>
      <nav>
        <button className={filter === "all" ? "selected" : ""} onClick={() => { setFilter("all"); setRailOpen(false); }}>全部会议</button>
        <button className={filter === "unfiled" ? "selected" : ""} onClick={() => { setFilter("unfiled"); setRailOpen(false); }}>未分类</button>
        {folders.map((folder) => <div className="folder-item" key={folder.id}><button className={filter === folder.id ? "selected" : ""} onClick={() => { setFilter(folder.id); setRailOpen(false); }}>{folder.name}</button><button className="icon-button" aria-label={`编辑分类 ${folder.name}`} title={`编辑分类 ${folder.name}`} onClick={() => { setFormError(""); setDialog({ kind: "renameFolder", id: folder.id, initial: folder.name }); }}><Pencil size={15} /></button><button className="icon-button" aria-label={`删除分类 ${folder.name}`} title={`删除分类 ${folder.name}`} onClick={() => setConfirmation(folder.id)}><Trash2 size={15} /></button></div>)}
        <button className={filter === "trashed" ? "selected" : ""} onClick={() => { setFilter("trashed"); setRailOpen(false); }}>废纸篓</button>
      </nav>
    </aside>
    {railOpen && <button className="drawer-scrim" aria-label="关闭分类抽屉" onClick={() => setRailOpen(false)} />}
    <section className="meeting-panel">
      <div className="meeting-toolbar"><label className="search-field"><Search size={17} /><input type="search" aria-label="搜索会议" placeholder="搜索会议" value={search} onChange={(event) => setSearch(event.target.value)} /></label><button className="primary-button" onClick={() => { setFormError(""); setDialog({ kind: "meeting" }); }}><Plus size={17} />新建会议</button></div>
      <div className="list-heading"><h2>{filter === "all" ? "全部会议" : filter === "unfiled" ? "未分类" : filter === "trashed" ? "废纸篓" : activeFolder?.name ?? "分类"}</h2><span>{shown.length} 项</span></div>
      {loading ? <p className="list-message" role="status">正在载入会议...</p> : shown.length === 0 ? <p className="list-message">{emptyText}</p> : <ul className="meeting-list">{shown.map((meeting) => <li key={meeting.id} className="meeting-row"><button className="meeting-main" onClick={() => navigate(`/meetings/${meeting.id}`)}><span className="meeting-title">{meeting.title}</span><span className="meeting-meta">更新于 {dateTime(meeting.updatedAt)}{duration(meeting) ? ` · ${duration(meeting)}` : ""}</span></button><span className={`status-label status-${meeting.status}`}>{statusLabel(meeting.status)}</span><button className="icon-button" aria-label={`会议操作 ${meeting.title}`} title={`会议操作 ${meeting.title}`} onClick={() => setActionMeeting(actionMeeting === meeting.id ? null : meeting.id)}><MoreHorizontal size={18} /></button>{actionMeeting === meeting.id && <div className="row-menu"><button onClick={() => { setActionMeeting(null); setDialog({ kind: "renameMeeting", id: meeting.id, initial: meeting.title }); }}>重命名</button>{meeting.status === "trashed" ? <button onClick={() => void repository.restore(meeting.id, now()).then(reload)}>恢复</button> : <button onClick={() => void repository.trash(meeting.id, now()).then(reload)}>移至废纸篓</button>}</div>}</li>)}</ul>}
    </section>
    {dialog && <div className="dialog-backdrop"><form className="dialog" aria-label={dialog.kind === "meeting" ? "新建会议" : "编辑名称"} onSubmit={(event) => void submit(event)}><h2>{dialog.kind === "meeting" ? "新建会议" : dialog.kind === "folder" ? "新建分类" : "重命名"}</h2><label>{dialog.kind.includes("Folder") || dialog.kind === "folder" ? "分类名称" : "会议名称"}<input name="name" autoFocus defaultValue={dialog.initial} maxLength={dialog.kind.includes("Folder") || dialog.kind === "folder" ? 80 : 120} aria-invalid={Boolean(formError)} aria-describedby="name-help" /></label><p id="name-help" className="field-error" aria-live="polite">{formError}</p><div className="dialog-actions"><button type="button" onClick={() => setDialog(null)}>取消</button><button className="primary-button" type="submit">{dialog.kind === "meeting" || dialog.kind === "folder" ? "创建" : "保存"}</button></div></form></div>}
    {confirmation && <div className="dialog-backdrop"><section className="dialog" role="alertdialog" aria-label="删除分类"><h2>删除分类？</h2><p>分类内的会议将保留为未分类。</p><div className="dialog-actions"><button onClick={() => setConfirmation(null)}>取消</button><button className="danger-button" onClick={() => void removeFolder()}>删除</button></div></section></div>}
  </main>;
}

export function WorkspacePlaceholder() {
  const navigate = useNavigate();
  return <main className="workspace-placeholder"><button className="text-button" onClick={() => navigate("/meetings")}><ChevronLeft size={17} />返回会议</button><p>会议工作区将在录音阶段启用</p></main>;
}
