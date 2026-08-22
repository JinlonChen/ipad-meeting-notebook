import type { Folder, Meeting } from "@meeting/contracts";
import { ChevronLeft, Folder as FolderIcon, FolderPlus, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { SyncResult } from "./sync.js";
import { MeetingCatalogRepository, type PendingStatus } from "./repository.js";

type Props = {
  repository: MeetingCatalogRepository;
  refresh: () => Promise<SyncResult>;
  scheduleRefresh?: () => Promise<SyncResult>;
  now?: () => string;
  online: boolean;
  onLogout?: () => void;
};
type Filter = "all" | "unfiled" | "trashed" | string;
type Dialog = { kind: "meeting" | "folder" | "renameMeeting" | "renameFolder"; id?: string; initial?: string } | null;

function layoutMode(): "portrait" | "landscape" {
  return window.innerHeight > window.innerWidth ? "portrait" : "landscape";
}

function useLayoutMode(): "portrait" | "landscape" {
  const [layout, setLayout] = useState(layoutMode);
  useEffect(() => {
    const update = () => setLayout(layoutMode());
    const media = window.matchMedia?.("(orientation: portrait)");
    window.addEventListener("resize", update);
    media?.addEventListener?.("change", update);
    return () => { window.removeEventListener("resize", update); media?.removeEventListener?.("change", update); };
  }, []);
  return layout;
}

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
function conflictActionLabel(kind: NonNullable<PendingStatus["conflict"]>["kind"]): string {
  return ({
    "meeting.create": "新建会议",
    "meeting.rename": "重命名会议",
    "meeting.trash": "将会议移至废纸篓",
    "meeting.restore": "恢复会议",
    "folder.create": "新建分类",
    "folder.rename": "重命名分类",
    "folder.remove": "删除分类",
  })[kind];
}

export function MeetingListPage({ repository, refresh, scheduleRefresh = refresh, now = () => new Date().toISOString(), online, onLogout }: Props) {
  const navigate = useNavigate();
  const layout = useLayoutMode();
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
  const [pendingOperation, setPendingOperation] = useState<string | null>(null);
  const [operationError, setOperationError] = useState("");
  const [autoSyncError, setAutoSyncError] = useState("");
  const [confirmationError, setConfirmationError] = useState("");
  const [pendingStatus, setPendingStatus] = useState<PendingStatus | null>(null);
  const [pendingStatusKnown, setPendingStatusKnown] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflictError, setConflictError] = useState("");
  const [resolvedConflictSequence, setResolvedConflictSequence] = useState<number | null>(null);
  const mounted = useRef(true);
  const reloadGeneration = useRef(0);
  const catalogLoaded = useRef(false);
  const menu = useRef<HTMLDivElement>(null);
  const actionTrigger = useRef<HTMLButtonElement>(null);
  const menuItems = useRef<Array<HTMLButtonElement | null>>([]);
  const modal = useRef<HTMLElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const newFolderTrigger = useRef<HTMLButtonElement>(null);
  const syncTrigger = useRef<HTMLButtonElement>(null);
  const setModal = useCallback((element: HTMLElement | null) => { modal.current = element; }, []);
  const modalOpen = dialog !== null || confirmation !== null || conflictOpen;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reloadGeneration.current += 1;
    };
  }, []);

  const reload = useCallback(async (): Promise<PendingStatus | undefined> => {
    if (!mounted.current) return undefined;
    const currentGeneration = ++reloadGeneration.current;
    if (!catalogLoaded.current) setLoading(true);
    try {
      const [nextMeetings, nextFolders, nextPendingResult] = await Promise.all([
        repository.list({ includeTrashed: true }),
        repository.listFolders(),
        repository.pendingStatus().then(
          (value) => ({ ok: true as const, value }),
          () => ({ ok: false as const }),
        ),
      ]);
      if (!mounted.current || reloadGeneration.current !== currentGeneration) return undefined;
      setMeetings(nextMeetings);
      setFolders(nextFolders);
      if (nextPendingResult.ok) {
        setPendingStatus(nextPendingResult.value);
        setPendingStatusKnown(true);
      } else {
        setPendingStatusKnown(false);
      }
      catalogLoaded.current = true;
      setLoading(false);
      return nextPendingResult.ok ? nextPendingResult.value : undefined;
    } catch (error) {
      if (mounted.current && reloadGeneration.current === currentGeneration) setLoading(false);
      throw error;
    }
  }, [repository]);

  useEffect(() => {
    void reload().catch(() => undefined);
    return () => { reloadGeneration.current += 1; };
  }, [reload]);
  useEffect(() => {
    if (!online) { setSyncState("paused_auth"); return; }
    let active = true;
    setSyncState("syncing");
    void refresh()
      .then(async (result) => {
        if (!active || !mounted.current) return;
        setSyncState(result.state);
        try { await reload(); }
        catch { if (active && mounted.current) setSyncState("error"); }
      })
      .catch(() => { if (active && mounted.current) setSyncState("error"); });
    return () => { active = false; };
  }, [online, refresh, reload]);

  const runOperation = useCallback(async (key: string, work: () => Promise<void>, onError: () => void): Promise<boolean> => {
    if (pendingOperation) return false;
    setPendingOperation(key);
    try {
      await work();
      return true;
    } catch {
      if (mounted.current) onError();
      return false;
    } finally {
      if (mounted.current) setPendingOperation(null);
    }
  }, [pendingOperation]);

  const closeMenu = useCallback(() => {
    setActionMeeting(null);
    actionTrigger.current?.focus();
  }, []);
  const dismissMenu = useCallback(() => setActionMeeting(null), []);

  const closeModal = useCallback(() => {
    setDialog(null);
    setConfirmation(null);
    setConflictOpen(false);
    setConflictError("");
    queueMicrotask(() => lastFocus.current?.focus());
  }, []);

  const openDialog = useCallback((nextDialog: NonNullable<Dialog>, trigger: HTMLElement) => {
    lastFocus.current = trigger;
    setFormError("");
    setDialog(nextDialog);
  }, []);

  const openConfirmation = useCallback((folderId: string, trigger: HTMLElement) => {
    lastFocus.current = trigger;
    setConfirmationError("");
    setConfirmation(folderId);
  }, []);

  const openConflict = useCallback((trigger: HTMLElement) => {
    lastFocus.current = trigger;
    setConflictError("");
    setConflictOpen(true);
  }, []);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (modalOpen) { event.preventDefault(); closeModal(); return; }
      if (actionMeeting) { event.preventDefault(); closeMenu(); }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [actionMeeting, closeMenu, closeModal, modalOpen]);

  useEffect(() => {
    if (!actionMeeting) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node) && event.target !== actionTrigger.current) closeMenu();
    };
    window.addEventListener("mousedown", closeOnOutsideClick);
    return () => window.removeEventListener("mousedown", closeOnOutsideClick);
  }, [actionMeeting, closeMenu]);

  useEffect(() => {
    if (!actionMeeting) return;
    queueMicrotask(() => menuItems.current[0]?.focus());
  }, [actionMeeting]);

  useEffect(() => {
    if (!actionMeeting) return;
    const moveMenuFocus = (event: KeyboardEvent) => {
      const items = menuItems.current.filter((item): item is HTMLButtonElement => item !== null && !item.disabled);
      const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") { event.preventDefault(); closeMenu(); return; }
      if (event.key === "Tab") { dismissMenu(); return; }
      if (event.key === "Home") { event.preventDefault(); items[0]?.focus(); return; }
      if (event.key === "End") { event.preventDefault(); items.at(-1)?.focus(); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const offset = event.key === "ArrowDown" ? 1 : -1;
        items[(currentIndex + offset + items.length) % items.length]?.focus();
      }
    };
    window.addEventListener("keydown", moveMenuFocus);
    return () => window.removeEventListener("keydown", moveMenuFocus);
  }, [actionMeeting, closeMenu, dismissMenu]);

  useEffect(() => {
    if (!modalOpen) return;
    queueMicrotask(() => {
      modal.current?.querySelector<HTMLElement>("input, button:not([disabled])")?.focus();
    });
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !modal.current) return;
      const items = Array.from(modal.current.querySelectorAll<HTMLElement>("input:not([disabled]), button:not([disabled])"));
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && currentIndex <= 0) { event.preventDefault(); items.at(-1)?.focus(); }
      if (!event.shiftKey && currentIndex === items.length - 1) { event.preventDefault(); items[0]?.focus(); }
    };
    window.addEventListener("keydown", trapFocus);
    return () => window.removeEventListener("keydown", trapFocus);
  }, [modalOpen]);

  const synchronizeAfterMutation = useCallback(() => {
    if (!online || !mounted.current) return;
    setSyncState("syncing");
    setAutoSyncError("");
    void scheduleRefresh()
      .then(async (result) => {
        if (mounted.current) setSyncState(result.state);
        try { await reload(); }
        catch { if (mounted.current) { setSyncState("error"); setOperationError("读取目录失败，请重试。"); } }
      })
      .catch(() => {
        if (mounted.current) {
          setSyncState("error");
          setAutoSyncError("修改已保存在本机，自动同步失败，将稍后重试。");
          void reload().catch(() => undefined);
        }
      });
  }, [online, reload, scheduleRefresh]);

  const finishLocalMutation = useCallback(() => {
    if (!mounted.current) return;
    setPendingStatusKnown(false);
    void reload().catch(() => { if (mounted.current) setOperationError("读取目录失败，请重试。"); });
    synchronizeAfterMutation();
  }, [reload, synchronizeAfterMutation]);

  const shown = meetings.filter((meeting) => {
    if (filter === "trashed" ? meeting.status !== "trashed" : meeting.status === "trashed") return false;
    if (filter === "unfiled" && meeting.folderId !== null) return false;
    if (filter !== "all" && filter !== "unfiled" && filter !== "trashed" && meeting.folderId !== filter) return false;
    return meeting.title.toLowerCase().includes(search.trim().toLowerCase());
  });
  const activeFolder = folders.find((folder) => folder.id === filter);
  const dialogTitle = dialog?.kind === "meeting" ? "新建会议" : dialog?.kind === "folder" ? "新建分类" : "重命名";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog) return;
    const form = new FormData(event.currentTarget);
    const value = String(form.get("name") ?? "").trim();
    const maximum = dialog.kind === "folder" || dialog.kind === "renameFolder" ? 80 : 120;
    if (!value) { setFormError(dialog.kind === "folder" || dialog.kind === "renameFolder" ? "请输入分类名称" : "请输入会议名称"); return; }
    if (value.length > maximum) { setFormError(`名称不能超过 ${maximum} 个字符`); return; }
    let createdMeeting: Meeting | undefined;
    const completed = await runOperation("form", async () => {
      if (dialog.kind === "meeting") createdMeeting = await repository.create(value, activeFolder?.id ?? null, now());
      if (dialog.kind === "folder") await repository.createFolder(value, now());
      if (dialog.kind === "renameMeeting" && dialog.id) await repository.rename(dialog.id, value, now());
      if (dialog.kind === "renameFolder" && dialog.id) await repository.renameFolder(dialog.id, value, now());
    }, () => setFormError("操作未完成，请重试。"));
    if (!completed) return;
    if (!mounted.current) return;
    setFormError(""); closeModal();
    finishLocalMutation();
    if (createdMeeting) { navigate(`/meetings/${createdMeeting.id}`); return; }
  }
  async function removeFolder() {
    if (!confirmation) return;
    const folderId = confirmation;
    const completed = await runOperation("removeFolder", async () => {
      await repository.removeFolder(folderId, now());
    }, () => setConfirmationError("操作未完成，请重试。"));
    if (!completed) return;
    if (!mounted.current) return;
    if (filter === folderId) setFilter("unfiled");
    lastFocus.current = newFolderTrigger.current;
    closeModal();
    finishLocalMutation();
  }
  async function syncNow() {
    if (!online || pendingOperation) return;
    setSyncState("syncing");
    setPendingOperation("sync"); setOperationError("");
    try {
      const result = await refresh();
      if (!mounted.current) return;
      setSyncState(result.state);
      if (result.state === "idle") setAutoSyncError("");
      await reload();
    } catch {
      if (mounted.current) { setSyncState("error"); setOperationError("操作未完成，请重试。"); }
    } finally {
      if (mounted.current) setPendingOperation(null);
    }
  }
  async function changeMeetingStatus(meeting: Meeting) {
    const operationKey = `meeting:${meeting.id}`;
    const completed = await runOperation(operationKey, async () => {
      if (meeting.status === "trashed") await repository.restore(meeting.id, now());
      else await repository.trash(meeting.id, now());
    }, () => setOperationError("操作未完成，请重试。"));
    if (!completed || !mounted.current) return;
    setActionMeeting(null);
    finishLocalMutation();
  }
  async function resolveCurrentConflict() {
    const conflict = pendingStatus?.conflict;
    if (!conflict || !online || pendingOperation) return;
    setPendingOperation("resolveConflict");
    setConflictError("");
    try {
      if (resolvedConflictSequence !== conflict.sequence) {
        await repository.resolveConflict(conflict.sequence);
        if (mounted.current) setResolvedConflictSequence(conflict.sequence);
      }
      const result = await refresh();
      if (!mounted.current) return;
      setSyncState(result.state);
      if (result.state === "conflict") {
        const latestPendingStatus = await reload();
        if (mounted.current && latestPendingStatus !== undefined) setResolvedConflictSequence(null);
        return;
      }
      if (result.state !== "idle") throw new Error("Synchronization did not complete");
      await reload();
      if (mounted.current) {
        setResolvedConflictSequence(null);
        lastFocus.current = syncTrigger.current;
        closeModal();
      }
    } catch {
      if (mounted.current) setConflictError("冲突处理失败，请重试。");
    } finally {
      if (mounted.current) setPendingOperation(null);
    }
  }
  function stateText() {
    const count = pendingStatus?.count;
    if (!online) return !pendingStatusKnown || count === undefined ? "离线，同步状态未知" : `离线，${count} 项待同步`;
    if (syncState === "syncing") return "正在同步";
    if (pendingStatus?.conflict || syncState === "conflict") return "同步冲突";
    if (syncState === "error") return !pendingStatusKnown || count === undefined || count === 0 ? "同步出错" : `同步出错，${count} 项待同步`;
    if (syncState === "paused_auth") return "同步已暂停";
    if (!pendingStatusKnown || count === undefined) return "同步状态未知";
    if (count > 0) return `${count} 项待同步`;
    return "已同步";
  }
  const emptyText = search ? "没有匹配的会议" : filter === "trashed" ? "废纸篓为空" : filter !== "all" ? "此分类暂无会议" : "还没有会议";
  const visibleOperationError = operationError || autoSyncError;

  return <><main className="catalog-shell" data-layout={layout} data-drawer={railOpen ? "open" : "closed"} inert={modalOpen}>
    <header className="catalog-topbar">
      <button className="icon-button rail-toggle" aria-label="打开分类" title="打开分类" onClick={() => setRailOpen(true)}><FolderIcon size={18} /></button>
      <h1>会议本</h1>
      <div className="topbar-actions">
        <span className={`sync-state ${online ? "" : "offline"}`} aria-live="polite">{stateText()}</span>
        {pendingStatus?.conflict && <button className="conflict-button" onClick={(event) => openConflict(event.currentTarget)}>处理冲突</button>}
        <button ref={syncTrigger} className="icon-button" aria-label="同步会议" title="同步会议" disabled={!online || pendingOperation === "sync"} onClick={() => void syncNow()}><RefreshCw size={18} /></button>
        {onLogout && <button className="text-button" onClick={onLogout}>退出</button>}
      </div>
    </header>
    <aside className={`folder-rail ${railOpen ? "open" : ""}`} aria-label="会议分类">
      <div className="rail-heading"><strong>分类</strong><button className="icon-button rail-close" aria-label="关闭分类" title="关闭分类" onClick={() => setRailOpen(false)}><X size={18} /></button><button ref={newFolderTrigger} className="icon-button" aria-label="新建分类" title="新建分类" onClick={(event) => openDialog({ kind: "folder" }, event.currentTarget)}><FolderPlus size={18} /></button></div>
      <nav>
        <button className={filter === "all" ? "selected" : ""} onClick={() => { setFilter("all"); setRailOpen(false); }}>全部会议</button>
        <button className={filter === "unfiled" ? "selected" : ""} onClick={() => { setFilter("unfiled"); setRailOpen(false); }}>未分类</button>
        {folders.map((folder) => <div className="folder-item" key={folder.id}><button className={filter === folder.id ? "selected" : ""} onClick={() => { setFilter(folder.id); setRailOpen(false); }}>{folder.name}</button><button className="icon-button" aria-label={`编辑分类 ${folder.name}`} title={`编辑分类 ${folder.name}`} onClick={(event) => openDialog({ kind: "renameFolder", id: folder.id, initial: folder.name }, event.currentTarget)}><Pencil size={15} /></button><button className="icon-button" aria-label={`删除分类 ${folder.name}`} title={`删除分类 ${folder.name}`} onClick={(event) => openConfirmation(folder.id, event.currentTarget)}><Trash2 size={15} /></button></div>)}
        <button className={filter === "trashed" ? "selected" : ""} onClick={() => { setFilter("trashed"); setRailOpen(false); }}>废纸篓</button>
      </nav>
    </aside>
    {railOpen && <button className="drawer-scrim" aria-label="关闭分类抽屉" onClick={() => setRailOpen(false)} />}
    <section className="meeting-panel">
      <div className="meeting-toolbar"><label className="search-field"><Search size={17} /><input type="search" aria-label="搜索会议" placeholder="搜索会议" value={search} onChange={(event) => setSearch(event.target.value)} /></label><button className="primary-button" onClick={(event) => openDialog({ kind: "meeting" }, event.currentTarget)}><Plus size={17} />新建会议</button></div>
      <p className="operation-error" role={visibleOperationError ? "alert" : undefined} aria-live="polite">{visibleOperationError}</p>
      <div className="list-heading"><h2>{filter === "all" ? "全部会议" : filter === "unfiled" ? "未分类" : filter === "trashed" ? "废纸篓" : activeFolder?.name ?? "分类"}</h2><span>{shown.length} 项</span></div>
      {loading ? <p className="list-message" role="status">正在载入会议...</p> : shown.length === 0 ? <p className="list-message">{emptyText}</p> : <ul className="meeting-list">{shown.map((meeting) => <li key={meeting.id} className="meeting-row"><button className="meeting-main" onClick={() => navigate(`/meetings/${meeting.id}`)}><span className="meeting-title">{meeting.title}</span><span className="meeting-meta">更新于 {dateTime(meeting.updatedAt)}{duration(meeting) ? ` · ${duration(meeting)}` : ""}</span></button><span className={`status-label status-${meeting.status}`}>{statusLabel(meeting.status)}</span><button ref={actionMeeting === meeting.id ? actionTrigger : undefined} className="icon-button" aria-label={`会议操作 ${meeting.title}`} title={`会议操作 ${meeting.title}`} aria-haspopup="menu" aria-expanded={actionMeeting === meeting.id} aria-controls={`meeting-menu-${meeting.id}`} onClick={(event) => { actionTrigger.current = event.currentTarget; if (actionMeeting === meeting.id) closeMenu(); else setActionMeeting(meeting.id); }}><MoreHorizontal size={18} /></button>{actionMeeting === meeting.id && <div ref={menu} id={`meeting-menu-${meeting.id}`} className="row-menu" role="menu"><button ref={(node) => { menuItems.current[0] = node; }} role="menuitem" disabled={pendingOperation === `meeting:${meeting.id}`} onClick={() => { openDialog({ kind: "renameMeeting", id: meeting.id, initial: meeting.title }, actionTrigger.current!); setActionMeeting(null); }}>重命名</button><button ref={(node) => { menuItems.current[1] = node; }} role="menuitem" disabled={pendingOperation === `meeting:${meeting.id}`} onClick={() => void changeMeetingStatus(meeting)}>{meeting.status === "trashed" ? "恢复" : "移至废纸篓"}</button></div>}</li>)}</ul>}
    </section>
  </main>
    {dialog && <div className="dialog-backdrop"><form ref={setModal} className="dialog" role="dialog" aria-modal="true" aria-labelledby="catalog-dialog-title" onSubmit={(event) => void submit(event)}><h2 id="catalog-dialog-title">{dialogTitle}</h2><label>{dialog.kind.includes("Folder") || dialog.kind === "folder" ? "分类名称" : "会议名称"}<input name="name" autoFocus defaultValue={dialog.initial} maxLength={dialog.kind.includes("Folder") || dialog.kind === "folder" ? 80 : 120} aria-invalid={Boolean(formError)} aria-describedby="name-help" /></label><p id="name-help" className="field-error" role={formError ? "alert" : undefined} aria-live="polite">{formError}</p><div className="dialog-actions"><button type="button" disabled={pendingOperation === "form"} onClick={closeModal}>取消</button><button className="primary-button" type="submit" disabled={pendingOperation === "form"}>{dialog.kind === "meeting" || dialog.kind === "folder" ? "创建" : "保存"}</button></div></form></div>}
    {confirmation && <div className="dialog-backdrop"><section ref={setModal} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="remove-folder-title"><h2 id="remove-folder-title">删除分类？</h2><p>分类内的会议将保留为未分类。</p><p className="field-error" role={confirmationError ? "alert" : undefined} aria-live="polite">{confirmationError}</p><div className="dialog-actions"><button disabled={pendingOperation === "removeFolder"} onClick={closeModal}>取消</button><button className="danger-button" disabled={pendingOperation === "removeFolder"} onClick={() => void removeFolder()}>删除</button></div></section></div>}
    {conflictOpen && pendingStatus?.conflict && <div className="dialog-backdrop"><section ref={setModal} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="resolve-conflict-title"><h2 id="resolve-conflict-title">处理同步冲突</h2><p className="conflict-detail"><strong>{pendingStatus.conflict.entityName}</strong><span>{conflictActionLabel(pendingStatus.conflict.kind)}与服务端内容冲突。</span></p><p>放弃本地修改后，将恢复服务端内容并继续同步其他项目。</p><p className="field-error" role={conflictError ? "alert" : undefined} aria-live="polite">{conflictError}</p><div className="dialog-actions"><button disabled={pendingOperation === "resolveConflict"} onClick={closeModal}>取消</button><button className="danger-button" disabled={!online || pendingOperation === "resolveConflict"} onClick={() => void resolveCurrentConflict()}>{resolvedConflictSequence === pendingStatus.conflict.sequence ? "重试同步" : "放弃本地修改"}</button></div></section></div>}
  </>;
}

export function WorkspacePlaceholder() {
  const navigate = useNavigate();
  return <main className="workspace-placeholder"><button className="text-button" onClick={() => navigate("/meetings")}><ChevronLeft size={17} />返回会议</button><p>会议工作区将在录音阶段启用</p></main>;
}
