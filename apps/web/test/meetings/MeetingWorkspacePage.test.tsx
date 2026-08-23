import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { Meeting } from "@meeting/contracts";
import { MeetingWorkspacePage } from "../../src/meetings/MeetingWorkspacePage.js";
import { MeetingCatalogRepository } from "../../src/meetings/repository.js";
import type { SyncResult } from "../../src/meetings/sync.js";
import "../../src/app/styles.css";

const now = "2026-08-21T00:00:00.000Z";
const later = "2026-08-21T00:01:00.000Z";
const missingMeetingId = "018f16d3-7e74-7ac4-a18a-53e674613f76";
const repositories: MeetingCatalogRepository[] = [];
let databaseNumber = 0;

function catalog(): MeetingCatalogRepository {
  const result = new MeetingCatalogRepository(`meeting-workspace-page-${databaseNumber++}`);
  repositories.push(result);
  return result;
}

function remoteMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: missingMeetingId,
    title: "云端会议",
    folderId: null,
    status: "ready",
    startedAt: null,
    endedAt: null,
    createdAt: now,
    updatedAt: later,
    trashedAt: null,
    syncVersion: 3,
    note: "云端笔记",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

type RenderOptions = {
  online?: boolean;
  refresh?: () => Promise<SyncResult>;
  scheduleRefresh?: () => Promise<SyncResult>;
};

function workspace(
  repository: MeetingCatalogRepository,
  id: string,
  online: boolean,
  refresh: () => Promise<SyncResult>,
  scheduleRefresh: () => Promise<SyncResult>,
) {
  return <MemoryRouter initialEntries={[`/meetings/${id}`]}>
    <Routes>
      <Route
        path="/meetings/:id"
        element={<MeetingWorkspacePage repository={repository} refresh={refresh} scheduleRefresh={scheduleRefresh} online={online} now={() => later} />}
      />
      <Route path="/meetings" element={<main><h1>会议列表</h1></main>} />
    </Routes>
  </MemoryRouter>;
}

function renderWorkspace(repository: MeetingCatalogRepository, id: string, options: RenderOptions = {}) {
  const refresh = options.refresh ?? vi.fn().mockResolvedValue({ state: "idle" as const });
  const scheduleRefresh = options.scheduleRefresh ?? vi.fn().mockResolvedValue({ state: "idle" as const });
  const rendered = render(workspace(repository, id, options.online ?? false, refresh, scheduleRefresh));
  return { ...rendered, refresh, scheduleRefresh };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(async () => {
  vi.useRealTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.all(repositories.splice(0).map((repository) => repository.deleteDatabase()));
});

describe("MeetingWorkspacePage", () => {
  test("keeps a return command visible while the meeting is loading", () => {
    const repository = catalog();
    vi.spyOn(repository, "get").mockReturnValue(deferred<Awaited<ReturnType<MeetingCatalogRepository["get"]>>>().promise);

    renderWorkspace(repository, missingMeetingId);

    expect(screen.getByRole("status")).toHaveTextContent("正在载入会议");
    expect(screen.getByRole("button", { name: "返回会议" })).toBeVisible();
  });

  test("shows a missing meeting state with a working return command", async () => {
    const repository = catalog();
    renderWorkspace(repository, missingMeetingId);

    expect(await screen.findByRole("heading", { name: "找不到会议" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "返回会议" }));
    expect(await screen.findByRole("heading", { name: "会议列表" })).toBeVisible();
  });

  test("shows a trashed meeting state with a working return command", async () => {
    const repository = catalog();
    const meeting = await repository.create("已删除会议", null, now);
    await repository.trash(meeting.id, later);
    renderWorkspace(repository, meeting.id);

    expect(await screen.findByRole("heading", { name: "会议已移至废纸篓" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "返回会议" }));
    expect(await screen.findByRole("heading", { name: "会议列表" })).toBeVisible();
  });

  test("shows a read error state with a working return command", async () => {
    const repository = catalog();
    vi.spyOn(repository, "get").mockRejectedValue(new Error("database unavailable"));
    renderWorkspace(repository, missingMeetingId);

    expect(await screen.findByRole("heading", { name: "无法载入会议" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "返回会议" }));
    expect(await screen.findByRole("heading", { name: "会议列表" })).toBeVisible();
  });

  test("refreshes an online deep link before reading and opens a meeting pulled into the local catalog", async () => {
    const repository = catalog();
    const pulled = remoteMeeting();
    const refresh = vi.fn(async () => {
      await repository.syncRefresh([], [pulled]);
      return { state: "idle" as const };
    });

    renderWorkspace(repository, pulled.id, { online: true, refresh });

    expect(screen.getByRole("status")).toHaveTextContent("正在载入会议");
    expect(await screen.findByRole("heading", { name: "云端会议" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "会议笔记" })).toHaveValue("云端笔记");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("refreshes an existing pending meeting before using its authoritative local note", async () => {
    const repository = catalog();
    const created = await repository.create("待重试会议", null, now);
    const createOperation = (await repository.pendingOperations())[0]!;
    const serverCreated = remoteMeeting({ id: created.id, title: created.title, status: "draft", syncVersion: 1, note: "" });
    await repository.syncApplySuccessfulOperation(createOperation, { meeting: serverCreated });
    await repository.saveNote(created.id, "本地待同步", later);
    const refresh = vi.fn(async () => {
      const noteOperation = (await repository.pendingOperations())[0]!;
      await repository.syncApplySuccessfulOperation(noteOperation, {
        meeting: remoteMeeting({ id: created.id, title: created.title, status: "draft", syncVersion: 2, note: "服务端确认的新笔记" }),
      });
      return { state: "idle" as const };
    });

    renderWorkspace(repository, created.id, { online: true, refresh });

    expect(await screen.findByRole("textbox", { name: "会议笔记" })).toHaveValue("服务端确认的新笔记");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("reads local content without refresh while offline", async () => {
    const repository = catalog();
    const meeting = await repository.create("离线直读", null, now);
    await repository.saveNote(meeting.id, "本地可编辑内容", later);
    const refresh = vi.fn().mockResolvedValue({ state: "idle" as const });

    renderWorkspace(repository, meeting.id, { online: false, refresh });

    expect(await screen.findByRole("textbox", { name: "会议笔记" })).toHaveValue("本地可编辑内容");
    expect(refresh).not.toHaveBeenCalled();
  });

  test("falls back to an existing local meeting when online refresh fails", async () => {
    const repository = catalog();
    const meeting = await repository.create("本地回退", null, now);
    await repository.saveNote(meeting.id, "网络失败也可编辑", later);
    const refresh = vi.fn().mockRejectedValue(new Error("network unavailable"));

    renderWorkspace(repository, meeting.id, { online: true, refresh });

    expect(await screen.findByRole("textbox", { name: "会议笔记" })).toHaveValue("网络失败也可编辑");
    expect(screen.queryByRole("heading", { name: "无法载入会议" })).not.toBeInTheDocument();
  });

  test("shows a load error when online refresh fails and no local meeting exists", async () => {
    const repository = catalog();
    const refresh = vi.fn().mockResolvedValue({ state: "error" as const });

    renderWorkspace(repository, missingMeetingId, { online: true, refresh });

    expect(await screen.findByRole("heading", { name: "无法载入会议" })).toBeVisible();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("does not refresh again when only the callback identity changes", async () => {
    const repository = catalog();
    const meeting = await repository.create("稳定加载", null, now);
    const firstRefresh = vi.fn().mockResolvedValue({ state: "idle" as const });
    const rendered = renderWorkspace(repository, meeting.id, { online: true, refresh: firstRefresh });
    await screen.findByRole("textbox", { name: "会议笔记" });
    const replacementRefresh = vi.fn().mockResolvedValue({ state: "idle" as const });

    rendered.rerender(workspace(repository, meeting.id, true, replacementRefresh, rendered.scheduleRefresh));
    await flushPromises();

    expect(firstRefresh).toHaveBeenCalledTimes(1);
    expect(replacementRefresh).not.toHaveBeenCalled();
  });

  test("renders meeting title, folder, status, updated time, and existing note", async () => {
    const repository = catalog();
    const folder = await repository.createFolder("产品组", now);
    const meeting = await repository.create("周会", folder.id, now);
    await repository.saveNote(meeting.id, "结论\n下一步", later);

    renderWorkspace(repository, meeting.id);

    expect(await screen.findByRole("heading", { name: "周会" })).toBeVisible();
    expect(screen.getByLabelText("会议信息")).toHaveTextContent("草稿");
    expect(screen.getByLabelText("会议信息")).toHaveTextContent("产品组");
    expect(screen.getByText(/更新于/)).toHaveAttribute("datetime", later);
    expect(screen.getByRole("textbox", { name: "会议笔记" })).toHaveValue("结论\n下一步");
  });

  test("saves locally once after 600ms of inactivity and not before", async () => {
    const repository = catalog();
    const meeting = await repository.create("自动保存", null, now);
    const saveNote = vi.spyOn(repository, "saveNote");
    renderWorkspace(repository, meeting.id);
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });
    vi.useFakeTimers();

    fireEvent.change(editor, { target: { value: "第一版" } });
    await act(async () => vi.advanceTimersByTimeAsync(599));
    expect(saveNote).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(1));
    await flushPromises();
    expect(saveNote).toHaveBeenCalledTimes(1);
    expect(saveNote).toHaveBeenCalledWith(meeting.id, "第一版", later);
  });

  test("flushes the latest unsaved note immediately on blur", async () => {
    const repository = catalog();
    const meeting = await repository.create("失焦保存", null, now);
    const saveNote = vi.spyOn(repository, "saveNote");
    renderWorkspace(repository, meeting.id);
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });

    fireEvent.change(editor, { target: { value: "最新文字" } });
    fireEvent.blur(editor);

    await waitFor(() => expect(saveNote).toHaveBeenCalledWith(meeting.id, "最新文字", later));
    await expect(repository.get(meeting.id)).resolves.toMatchObject({ note: "最新文字" });
  });

  test("flushes immediately when the document becomes hidden", async () => {
    const repository = catalog();
    const meeting = await repository.create("切后台保存", null, now);
    const saveNote = vi.spyOn(repository, "saveNote");
    renderWorkspace(repository, meeting.id);
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });

    fireEvent.change(editor, { target: { value: "切到后台前" } });
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(saveNote).toHaveBeenCalledWith(meeting.id, "切到后台前", later));
  });

  test("waits for a successful local flush before Back and stays with Retry after failure", async () => {
    const repository = catalog();
    const meeting = await repository.create("返回前保存", null, now);
    const originalSave = repository.saveNote.bind(repository);
    const saveNote = vi.spyOn(repository, "saveNote")
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementation(originalSave);
    renderWorkspace(repository, meeting.id);
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });

    fireEvent.change(editor, { target: { value: "不能丢失的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "返回会议" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
    expect(screen.getByRole("heading", { name: "返回前保存" })).toBeVisible();
    expect(editor).toHaveValue("不能丢失的草稿");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "返回会议" }));
    expect(await screen.findByRole("heading", { name: "会议列表" })).toBeVisible();
    await expect(repository.get(meeting.id)).resolves.toMatchObject({ note: "不能丢失的草稿" });
    expect(saveNote).toHaveBeenCalledTimes(2);
  });

  test("navigates Back after local persistence without waiting for pending online synchronization", async () => {
    const repository = catalog();
    const meeting = await repository.create("本地成功即可返回", null, now);
    const synchronization = deferred<SyncResult>();
    renderWorkspace(repository, meeting.id, { online: true, scheduleRefresh: vi.fn(() => synchronization.promise) });
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });

    fireEvent.change(editor, { target: { value: "已落盘，云端仍在等待" } });
    fireEvent.click(screen.getByRole("button", { name: "返回会议" }));

    expect(await screen.findByRole("heading", { name: "会议列表" })).toBeVisible();
    await expect(repository.get(meeting.id)).resolves.toMatchObject({ note: "已落盘，云端仍在等待" });
    synchronization.resolve({ state: "idle" });
  });

  test("keeps an offline save local and does not invoke network synchronization", async () => {
    const repository = catalog();
    const meeting = await repository.create("离线笔记", null, now);
    const refresh = vi.fn().mockResolvedValue({ state: "idle" as const });
    const scheduleRefresh = vi.fn().mockResolvedValue({ state: "idle" as const });
    renderWorkspace(repository, meeting.id, { online: false, refresh, scheduleRefresh });
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });

    fireEvent.change(editor, { target: { value: "离线内容" } });
    fireEvent.blur(editor);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已保存到本机，待同步"));
    expect(refresh).not.toHaveBeenCalled();
    expect(scheduleRefresh).not.toHaveBeenCalled();
  });

  test("automatically synchronizes one pending local revision after reconnect", async () => {
    const repository = catalog();
    const meeting = await repository.create("重连同步", null, now);
    const synchronization = deferred<SyncResult>();
    const scheduleRefresh = vi.fn(() => synchronization.promise);
    const rendered = renderWorkspace(repository, meeting.id, { online: false, scheduleRefresh });
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });

    fireEvent.change(editor, { target: { value: "离线时保存的内容" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已保存到本机，待同步"));
    expect(scheduleRefresh).not.toHaveBeenCalled();

    rendered.rerender(workspace(repository, meeting.id, true, rendered.refresh, scheduleRefresh));
    await waitFor(() => expect(scheduleRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("正在同步");
    rendered.rerender(workspace(repository, meeting.id, true, rendered.refresh, scheduleRefresh));
    await flushPromises();
    expect(scheduleRefresh).toHaveBeenCalledTimes(1);

    synchronization.resolve({ state: "idle" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已同步"));
  });

  test("waits for the active serialized local save and synchronizes only its latest draft after reconnect", async () => {
    const repository = catalog();
    const meeting = await repository.create("写入中重连", null, now);
    const firstWrite = deferred<void>();
    const originalSave = repository.saveNote.bind(repository);
    const savedValues: string[] = [];
    const saveNote = vi.spyOn(repository, "saveNote").mockImplementation(async (id, note, timestamp) => {
      savedValues.push(note);
      if (savedValues.length === 1) await firstWrite.promise;
      return originalSave(id, note, timestamp);
    });
    const scheduleRefresh = vi.fn().mockResolvedValue({ state: "idle" as const });
    const rendered = renderWorkspace(repository, meeting.id, { online: false, scheduleRefresh });
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });

    fireEvent.change(editor, { target: { value: "旧内容" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(1));
    fireEvent.change(editor, { target: { value: "重连时的最新内容" } });
    rendered.rerender(workspace(repository, meeting.id, true, rendered.refresh, scheduleRefresh));
    await flushPromises();
    expect(scheduleRefresh).not.toHaveBeenCalled();

    firstWrite.resolve();
    await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(scheduleRefresh).toHaveBeenCalledTimes(1));
    expect(savedValues).toEqual(["旧内容", "重连时的最新内容"]);
    await expect(repository.get(meeting.id)).resolves.toMatchObject({ note: "重连时的最新内容" });
    expect(editor).toHaveValue("重连时的最新内容");
  });

  test("keeps the draft pending after reconnect sync failure and retries only on a later reconnect", async () => {
    const repository = catalog();
    const meeting = await repository.create("重连失败", null, now);
    const scheduleRefresh = vi.fn()
      .mockResolvedValueOnce({ state: "error" as const })
      .mockResolvedValueOnce({ state: "idle" as const });
    const rendered = renderWorkspace(repository, meeting.id, { online: false, scheduleRefresh });
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });

    fireEvent.change(editor, { target: { value: "同步失败也不丢失" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已保存到本机，待同步"));

    rendered.rerender(workspace(repository, meeting.id, true, rendered.refresh, scheduleRefresh));
    await waitFor(() => expect(scheduleRefresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已保存到本机，待同步"));
    expect(editor).toHaveValue("同步失败也不丢失");

    rendered.rerender(workspace(repository, meeting.id, true, rendered.refresh, scheduleRefresh));
    await flushPromises();
    expect(scheduleRefresh).toHaveBeenCalledTimes(1);
    rendered.rerender(workspace(repository, meeting.id, false, rendered.refresh, scheduleRefresh));
    rendered.rerender(workspace(repository, meeting.id, true, rendered.refresh, scheduleRefresh));
    await waitFor(() => expect(scheduleRefresh).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已同步"));
    expect(editor).toHaveValue("同步失败也不丢失");
  });

  test("schedules online synchronization and shows synced after it completes", async () => {
    const repository = catalog();
    const meeting = await repository.create("在线笔记", null, now);
    const synchronization = deferred<SyncResult>();
    const scheduleRefresh = vi.fn(() => synchronization.promise);
    renderWorkspace(repository, meeting.id, { online: true, scheduleRefresh });
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });

    fireEvent.change(editor, { target: { value: "在线内容" } });
    fireEvent.blur(editor);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("正在同步"));
    expect(scheduleRefresh).toHaveBeenCalledTimes(1);
    synchronization.resolve({ state: "idle" });
    expect(await screen.findByRole("status")).toHaveTextContent("已同步");
  });

  test("keeps an online synchronization failure marked as saved locally and pending", async () => {
    const repository = catalog();
    const meeting = await repository.create("待重试同步", null, now);
    renderWorkspace(repository, meeting.id, {
      online: true,
      scheduleRefresh: vi.fn().mockResolvedValue({ state: "error" as const }),
    });
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });

    fireEvent.change(editor, { target: { value: "本地已安全保存" } });
    fireEvent.blur(editor);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已保存到本机，待同步"));
    await expect(repository.get(meeting.id)).resolves.toMatchObject({ note: "本地已安全保存" });
  });

  test("does not let an old A sync completion mark a newer A-B-A draft generation as synced", async () => {
    const repository = catalog();
    const meeting = await repository.create("ABA 同步", null, now);
    const first = deferred<SyncResult>();
    const second = deferred<SyncResult>();
    const latest = deferred<SyncResult>();
    const scheduleRefresh = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => latest.promise);
    renderWorkspace(repository, meeting.id, { online: true, scheduleRefresh });
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });

    fireEvent.change(editor, { target: { value: "A" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(scheduleRefresh).toHaveBeenCalledTimes(1));
    fireEvent.change(editor, { target: { value: "B" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(scheduleRefresh).toHaveBeenCalledTimes(2));
    fireEvent.change(editor, { target: { value: "A" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(scheduleRefresh).toHaveBeenCalledTimes(3));

    first.resolve({ state: "idle" });
    await flushPromises();
    expect(screen.getByRole("status")).toHaveTextContent("正在同步");

    latest.resolve({ state: "error" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已保存到本机，待同步"));
    second.resolve({ state: "idle" });
    await flushPromises();
    expect(screen.getByRole("status")).toHaveTextContent("已保存到本机，待同步");
  });

  test("rejects 200001 Unicode code points before repository write and accepts the emoji boundary", async () => {
    const repository = catalog();
    const meeting = await repository.create("字符边界", null, now);
    const saveNote = vi.spyOn(repository, "saveNote");
    renderWorkspace(repository, meeting.id);
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });

    fireEvent.change(editor, { target: { value: "字".repeat(200_001) } });
    fireEvent.blur(editor);
    expect(await screen.findByRole("alert")).toHaveTextContent("会议笔记不能超过 200,000 个字符");
    expect(saveNote).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: "😀".repeat(200_000) } });
    fireEvent.blur(editor);
    await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(1));
    await expect(repository.get(meeting.id)).resolves.toMatchObject({ note: "😀".repeat(200_000) });
  }, 15_000);

  test("serializes an active write and immediately trails it with the latest draft", async () => {
    const repository = catalog();
    const meeting = await repository.create("串行保存", null, now);
    const firstWrite = deferred<void>();
    const originalSave = repository.saveNote.bind(repository);
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const values: string[] = [];
    const saveNote = vi.spyOn(repository, "saveNote").mockImplementation(async (id, note, timestamp) => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      values.push(note);
      try {
        if (values.length === 1) await firstWrite.promise;
        return await originalSave(id, note, timestamp);
      } finally {
        activeWrites -= 1;
      }
    });
    renderWorkspace(repository, meeting.id);
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });
    vi.useFakeTimers();

    fireEvent.change(editor, { target: { value: "旧草稿" } });
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(saveNote).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("保存中");

    fireEvent.change(editor, { target: { value: "最新草稿" } });
    vi.useRealTimers();
    firstWrite.resolve();
    await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已保存到本机，待同步"));

    expect(values).toEqual(["旧草稿", "最新草稿"]);
    expect(maxActiveWrites).toBe(1);
    expect(editor).toHaveValue("最新草稿");
    await expect(repository.get(meeting.id)).resolves.toMatchObject({ note: "最新草稿" });
  });

  test("maps a repository note conflict to a clear conflict state", async () => {
    const repository = catalog();
    const meeting = await repository.create("冲突笔记", null, now);
    const pending = (await repository.pendingOperations())[0]!;
    await repository.syncRecordFailure(pending, "CONFLICT");
    renderWorkspace(repository, meeting.id);
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });

    fireEvent.change(editor, { target: { value: "本地冲突内容" } });
    fireEvent.blur(editor);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("冲突"));
    expect(screen.getByRole("alert")).toHaveTextContent("会议笔记存在同步冲突");
    expect(editor).toHaveValue("本地冲突内容");
  });

  test("persists the latest draft immediately when unmounted before the inactivity timer", async () => {
    const repository = catalog();
    const meeting = await repository.create("离开页面", null, now);
    const saveNote = vi.spyOn(repository, "saveNote");
    const scheduleRefresh = vi.fn().mockResolvedValue({ state: "idle" as const });
    const rendered = renderWorkspace(repository, meeting.id, { online: true, scheduleRefresh });
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });

    fireEvent.change(editor, { target: { value: "尚未到期" } });
    rendered.unmount();

    await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(1));
    await expect(repository.get(meeting.id)).resolves.toMatchObject({ note: "尚未到期" });
    expect(scheduleRefresh).not.toHaveBeenCalled();
  });

  test("drains the latest trailing draft locally after unmount without scheduling network work", async () => {
    const repository = catalog();
    const meeting = await repository.create("慢写离开", null, now);
    const firstWrite = deferred<void>();
    const originalSave = repository.saveNote.bind(repository);
    const savedValues: string[] = [];
    const saveNote = vi.spyOn(repository, "saveNote").mockImplementation(async (id, note, timestamp) => {
      savedValues.push(note);
      if (savedValues.length === 1) await firstWrite.promise;
      return originalSave(id, note, timestamp);
    });
    const scheduleRefresh = vi.fn().mockResolvedValue({ state: "idle" as const });
    const rendered = renderWorkspace(repository, meeting.id, { online: true, scheduleRefresh });
    const editor = await screen.findByRole("textbox", { name: "会议笔记" });

    fireEvent.change(editor, { target: { value: "写入中的旧稿" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(1));
    fireEvent.change(editor, { target: { value: "离开前的最新稿" } });
    rendered.unmount();
    firstWrite.resolve();

    await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2));
    expect(savedValues).toEqual(["写入中的旧稿", "离开前的最新稿"]);
    await expect(repository.get(meeting.id)).resolves.toMatchObject({ note: "离开前的最新稿" });
    expect(scheduleRefresh).not.toHaveBeenCalled();
  });
});
