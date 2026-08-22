import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { MeetingCatalogRepository } from "../../src/meetings/repository.js";
import { MeetingListPage, WorkspacePlaceholder } from "../../src/meetings/MeetingListPage.js";
import "../../src/app/styles.css";

const now = "2026-08-21T00:00:00.000Z";
const repositories: MeetingCatalogRepository[] = [];
let databaseNumber = 0;

function catalog(): MeetingCatalogRepository {
  const result = new MeetingCatalogRepository(`meeting-list-page-${databaseNumber++}`);
  repositories.push(result);
  return result;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

function renderPage(repository = catalog(), initialEntries = ["/meetings"]) {
  const refresh = async () => ({ state: "idle" as const });
  render(<MemoryRouter initialEntries={initialEntries}><Routes>
    <Route path="/meetings" element={<MeetingListPage repository={repository} refresh={refresh} now={() => now} online />} />
    <Route path="/meetings/:id" element={<WorkspacePlaceholder />} />
  </Routes></MemoryRouter>);
  return repository;
}

async function acknowledgePending(repository: MeetingCatalogRepository): Promise<void> {
  const remoteFolders = new Map((await repository.listFolders()).map((folder) => [folder.id, folder]));
  for (const operation of await repository.pendingOperations()) {
    if (operation.kind === "folder.remove") {
      await repository.syncApplySuccessfulOperation(operation, {});
    } else if (operation.kind.startsWith("folder.")) {
      const payload = operation.payload as { id?: string; name?: string; clientCreatedAt?: string; updatedAt?: string; expectedSyncVersion?: number };
      const previous = remoteFolders.get(operation.entityId);
      const folder = operation.kind === "folder.create"
        ? { id: operation.entityId, name: payload.name!, createdAt: payload.clientCreatedAt!, updatedAt: payload.clientCreatedAt!, syncVersion: 0 }
        : { ...previous!, name: payload.name!, updatedAt: payload.updatedAt!, syncVersion: (payload.expectedSyncVersion ?? 0) + 1 };
      remoteFolders.set(folder.id, folder);
      await repository.syncApplySuccessfulOperation(operation, { folder });
    } else {
      const meeting = await repository.get(operation.entityId);
      if (meeting) await repository.syncApplySuccessfulOperation(operation, { meeting });
    }
  }
}

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.all(repositories.splice(0).map((repository) => repository.deleteDatabase()));
});

describe("MeetingListPage", () => {
  test("uses portrait drawer mode at 744x1133 and landscape rail mode at 1133x744", async () => {
    Object.defineProperties(window, { innerWidth: { configurable: true, value: 744 }, innerHeight: { configurable: true, value: 1133 } });
    const portrait = render(<MemoryRouter><MeetingListPage repository={catalog()} refresh={async () => ({ state: "idle" })} now={() => now} online={false} /></MemoryRouter>);
    const shell = await screen.findByRole("main");
    expect(shell).toHaveAttribute("data-layout", "portrait");
    expect(shell).toHaveAttribute("data-drawer", "closed");
    expect(await screen.findByText("离线，0 项待同步")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "打开分类" }));
    expect(shell).toHaveAttribute("data-drawer", "open");
    portrait.unmount();

    Object.defineProperties(window, { innerWidth: { configurable: true, value: 1133 }, innerHeight: { configurable: true, value: 744 } });
    window.dispatchEvent(new Event("resize"));
    render(<MemoryRouter><MeetingListPage repository={catalog()} refresh={async () => ({ state: "idle" })} now={() => now} online /></MemoryRouter>);
    expect(await screen.findByRole("main")).toHaveAttribute("data-layout", "landscape");
    await screen.findByText("还没有会议");
  });

  test("removes a closed portrait drawer from navigation and restores focus after every close path", async () => {
    Object.defineProperties(window, { innerWidth: { configurable: true, value: 744 }, innerHeight: { configurable: true, value: 1133 } });
    const user = userEvent.setup();
    render(<MemoryRouter><MeetingListPage repository={catalog()} refresh={async () => ({ state: "idle" })} now={() => now} online={false} /></MemoryRouter>);
    const shell = await screen.findByRole("main");
    const rail = document.querySelector<HTMLElement>(".folder-rail")!;
    const trigger = screen.getByRole("button", { name: "打开分类" });
    expect(shell).toHaveAttribute("data-layout", "portrait");
    expect(trigger).toHaveAttribute("aria-controls", "meeting-folder-rail");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(rail).toHaveAttribute("id", "meeting-folder-rail");
    expect(rail).toHaveAttribute("inert");
    expect(rail).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("complementary", { name: "会议分类" })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { hidden: true })).toBe(rail);

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(rail).not.toHaveAttribute("inert");
    expect(rail).not.toHaveAttribute("aria-hidden");
    await waitFor(() => expect(screen.getByRole("button", { name: "关闭分类" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "关闭分类" }));
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.tab();
    expect(screen.getByRole("button", { name: "新建分类" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(rail).toHaveAttribute("inert");

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "关闭分类抽屉" }));
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "未分类" }));
    expect(trigger).toHaveFocus();
    expect(shell).toHaveAttribute("data-drawer", "closed");
  });

  test("keeps the landscape category rail semantic and focusable while drawer state is closed", async () => {
    Object.defineProperties(window, { innerWidth: { configurable: true, value: 1133 }, innerHeight: { configurable: true, value: 744 } });
    render(<MemoryRouter><MeetingListPage repository={catalog()} refresh={async () => ({ state: "idle" })} now={() => now} online={false} /></MemoryRouter>);
    const shell = await screen.findByRole("main");
    expect(shell).toHaveAttribute("data-layout", "landscape");
    const rail = screen.getByRole("complementary", { name: "会议分类" });
    expect(rail).not.toHaveAttribute("inert");
    expect(rail).not.toHaveAttribute("aria-hidden");
    const createFolder = screen.getByRole("button", { name: "新建分类" });
    createFolder.focus();
    expect(createFolder).toHaveFocus();

    Object.defineProperties(window, { innerWidth: { configurable: true, value: 744 }, innerHeight: { configurable: true, value: 1133 } });
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(shell).toHaveAttribute("data-layout", "portrait"));
    expect(rail).toHaveAttribute("inert");
    expect(rail).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "打开分类" })).toHaveFocus();

    await userEvent.setup().click(screen.getByRole("button", { name: "打开分类" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "关闭分类" })).toHaveFocus());

    Object.defineProperties(window, { innerWidth: { configurable: true, value: 1133 }, innerHeight: { configurable: true, value: 744 } });
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(shell).toHaveAttribute("data-layout", "landscape"));
    expect(rail).not.toHaveAttribute("inert");
    expect(rail).not.toHaveAttribute("aria-hidden");
    expect(createFolder).toHaveFocus();
  });

  test("uses the portrait drawer at tablet portrait widths and keeps the rail in landscape", async () => {
    for (const [width, height] of [[820, 1180], [834, 1194], [1024, 1366]]) {
      Object.defineProperties(window, { innerWidth: { configurable: true, value: width }, innerHeight: { configurable: true, value: height } });
      const rendered = render(<MemoryRouter><MeetingListPage repository={catalog()} refresh={async () => ({ state: "idle" })} now={() => now} online={false} /></MemoryRouter>);
      expect(await screen.findByRole("main")).toHaveAttribute("data-layout", "portrait");
      rendered.unmount();
    }
    Object.defineProperties(window, { innerWidth: { configurable: true, value: 1024 }, innerHeight: { configurable: true, value: 744 } });
    render(<MemoryRouter><MeetingListPage repository={catalog()} refresh={async () => ({ state: "idle" })} now={() => now} online={false} /></MemoryRouter>);
    expect(await screen.findByRole("main")).toHaveAttribute("data-layout", "landscape");
  });

  test("creates locally, validates dialog input, searches, and opens the workspace placeholder", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "会议本" });

    await user.click(screen.getByRole("button", { name: "新建会议" }));
    await user.click(screen.getByRole("button", { name: "创建" }));
    expect(screen.getByText("请输入会议名称")).toBeVisible();
    await user.type(screen.getByLabelText("会议名称"), "Sprint planning");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await screen.findByText("会议工作区将在录音阶段启用");
    await user.click(screen.getByRole("button", { name: "返回会议" }));
    await screen.findByRole("heading", { name: "会议本" });
    expect(screen.getByText("Sprint planning")).toBeVisible();
    await user.type(screen.getByRole("searchbox", { name: "搜索会议" }), "nomatch");
    await waitFor(() => expect(screen.getByText("没有匹配的会议")).toBeVisible());
  });

  test("creates, renames and removes folders while retaining meetings, then renames, trashes and restores a meeting", async () => {
    const user = userEvent.setup();
    const repository = renderPage();
    await screen.findByRole("heading", { name: "会议本" });
    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "工作");
    await user.click(screen.getByRole("button", { name: "创建" }));
    const folder = (await repository.listFolders())[0]!;
    await repository.create("待整理", folder.id, now);
    await user.click(screen.getByRole("button", { name: "同步会议" }));
    await screen.findByText("待整理");
    await user.click(screen.getByRole("button", { name: "编辑分类 工作" }));
    const folderName = screen.getByLabelText("分类名称");
    await user.clear(folderName); await user.type(folderName, "项目");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("button", { name: "项目" });
    await user.click(screen.getByRole("button", { name: "删除分类 项目" }));
    await user.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(async () => expect((await repository.get((await repository.list())[0]!.id))?.folderId).toBeNull());
    expect((await repository.pendingOperations()).filter((operation) => operation.kind.startsWith("folder."))).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "会议操作 待整理" }));
    await user.click(screen.getByRole("menuitem", { name: "重命名" }));
    const meetingName = screen.getByLabelText("会议名称");
    await user.clear(meetingName); await user.type(meetingName, "已整理");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("已整理");
    await user.click(screen.getByRole("button", { name: "会议操作 已整理" }));
    await user.click(screen.getByRole("menuitem", { name: "移至废纸篓" }));
    await user.click(screen.getByRole("button", { name: "废纸篓" }));
    await screen.findByText("已整理");
    await user.click(screen.getByRole("button", { name: "会议操作 已整理" }));
    await user.click(screen.getByRole("menuitem", { name: "恢复" }));
    await user.click(screen.getByRole("button", { name: "全部会议" }));
    await screen.findByText("已整理");
  });

  test("shows syncing, sync error and populated states without changing the toolbar", async () => {
    const repository = catalog();
    await repository.create("有时长的会议", null, now);
    let resolve: ((value: { state: "idle" }) => void) | undefined;
    const pending = new Promise<{ state: "idle" }>((done) => { resolve = done; });
    const rendered = render(<MemoryRouter><MeetingListPage repository={repository} refresh={() => pending} now={() => now} online /></MemoryRouter>);
    expect(await screen.findByText("正在同步")).toBeVisible();
    expect(screen.getByRole("button", { name: "新建会议" })).toBeVisible();
    resolve?.({ state: "idle" });
    await screen.findByText("有时长的会议");
    rendered.unmount();

    render(<MemoryRouter><MeetingListPage repository={repository} refresh={async () => { throw new Error("offline"); }} now={() => now} online /></MemoryRouter>);
    await screen.findByText("同步出错");
    expect(screen.getByRole("button", { name: "新建会议" })).toBeVisible();
  });

  test("starts automatic synchronization after a meeting create before navigation unmounts the page", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    const automatic = deferred<{ state: "idle" }>();
    const refresh = vi.fn().mockResolvedValue({ state: "idle" as const });
    const scheduleRefresh = vi.fn(() => automatic.promise);
    render(<MemoryRouter initialEntries={["/meetings"]}><Routes>
      <Route path="/meetings" element={<MeetingListPage repository={repository} refresh={refresh} scheduleRefresh={scheduleRefresh} now={() => now} online />} />
      <Route path="/meetings/:id" element={<WorkspacePlaceholder />} />
    </Routes></MemoryRouter>);
    await screen.findByText("还没有会议");
    const delayedList = deferred<Awaited<ReturnType<MeetingCatalogRepository["list"]>>>();
    vi.spyOn(repository, "list").mockImplementationOnce(() => delayedList.promise);

    await user.click(screen.getByRole("button", { name: "新建会议" }));
    await user.type(screen.getByLabelText("会议名称"), "导航前同步");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await screen.findByText("会议工作区将在录音阶段启用");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(scheduleRefresh).toHaveBeenCalledTimes(1);
    delayedList.resolve([]);
    automatic.resolve({ state: "idle" });
  });

  test("keeps populated rows interactive while a background reload is pending", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    await repository.create("保持可见", null, now);
    const refresh = vi.fn().mockResolvedValue({ state: "idle" as const });
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} now={() => now} online /></MemoryRouter>);
    await screen.findByText("保持可见");
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const delayedList = deferred<Awaited<ReturnType<MeetingCatalogRepository["list"]>>>();
    vi.spyOn(repository, "list").mockImplementationOnce(() => delayedList.promise);

    await user.click(screen.getByRole("button", { name: "同步会议" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));

    expect(screen.getByText("保持可见")).toBeVisible();
    expect(screen.queryByText("正在载入会议...")).not.toBeInTheDocument();
    delayedList.resolve(await repository.list({ includeTrashed: true }));
  });

  test("automatically syncs a successful local mutation and only reports synced after pending is empty", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    const refresh = vi.fn(async () => {
      await acknowledgePending(repository);
      return { state: "idle" as const };
    });
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} now={() => now} online /></MemoryRouter>);
    await screen.findByText("已同步");

    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "自动同步");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    await waitFor(async () => expect(await repository.pendingOperations()).toEqual([]));
    await screen.findByText("已同步");
  });

  test("reports a rejected automatic sync as locally saved and clears it after automatic recovery", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    const refresh = vi.fn().mockResolvedValue({ state: "idle" as const });
    const scheduleRefresh = vi.fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockImplementationOnce(async () => {
        await acknowledgePending(repository);
        return { state: "idle" as const };
      });
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} scheduleRefresh={scheduleRefresh} now={() => now} online /></MemoryRouter>);
    await screen.findByText("已同步");

    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "已保存未同步");
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("修改已保存在本机，自动同步失败，将稍后重试。");
    expect(screen.queryByText("操作未完成，请重试。")).not.toBeInTheDocument();
    await expect(repository.pendingOperations()).resolves.toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "触发自动恢复");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(scheduleRefresh).toHaveBeenCalledTimes(2));
    await screen.findByText("已同步");
    expect(screen.queryByText("修改已保存在本机，自动同步失败，将稍后重试。")).not.toBeInTheDocument();
    await expect(repository.pendingOperations()).resolves.toEqual([]);
  });

  test.each(["error", "conflict", "reject"] as const)("keeps the saved-locally warning when the next automatic sync ends with %s", async (outcome) => {
    const user = userEvent.setup();
    const repository = catalog();
    const refresh = vi.fn().mockResolvedValue({ state: "idle" as const });
    const scheduleRefresh = vi.fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockImplementationOnce(() => outcome === "reject"
        ? Promise.reject(new Error("still offline"))
        : Promise.resolve({ state: outcome }));
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} scheduleRefresh={scheduleRefresh} now={() => now} online /></MemoryRouter>);
    await screen.findByText("已同步");
    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "首次未同步");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await screen.findByText("修改已保存在本机，自动同步失败，将稍后重试。");

    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), `后续 ${outcome}`);
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(scheduleRefresh).toHaveBeenCalledTimes(2));
    expect(screen.getByText("修改已保存在本机，自动同步失败，将稍后重试。")).toBeVisible();
  });

  test("clears the saved-locally warning when reconnect synchronization completes", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    const refresh = vi.fn()
      .mockResolvedValueOnce({ state: "idle" as const })
      .mockImplementationOnce(async () => {
        await acknowledgePending(repository);
        return { state: "idle" as const };
      });
    const scheduleRefresh = vi.fn().mockRejectedValueOnce(new Error("network unavailable"));
    const page = (online: boolean) => <MemoryRouter><MeetingListPage repository={repository} refresh={refresh} scheduleRefresh={scheduleRefresh} now={() => now} online={online} /></MemoryRouter>;
    const rendered = render(page(true));
    await screen.findByText("已同步");
    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "等待重新联网");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await screen.findByText("修改已保存在本机，自动同步失败，将稍后重试。");

    rendered.rerender(page(false));
    await screen.findByText("离线，1 项待同步");
    rendered.rerender(page(true));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    await screen.findByText("已同步");
    expect(screen.queryByText("修改已保存在本机，自动同步失败，将稍后重试。")).not.toBeInTheDocument();
    await expect(repository.pendingOperations()).resolves.toEqual([]);
  });

  test.each(["error", "conflict", "reject"] as const)("keeps the saved-locally warning when reconnect synchronization ends with %s", async (outcome) => {
    const user = userEvent.setup();
    const repository = catalog();
    const refresh = vi.fn().mockResolvedValueOnce({ state: "idle" as const });
    if (outcome === "reject") refresh.mockRejectedValueOnce(new Error("still offline"));
    else refresh.mockResolvedValueOnce({ state: outcome });
    const scheduleRefresh = vi.fn().mockRejectedValueOnce(new Error("network unavailable"));
    const page = (online: boolean) => <MemoryRouter><MeetingListPage repository={repository} refresh={refresh} scheduleRefresh={scheduleRefresh} now={() => now} online={online} /></MemoryRouter>;
    const rendered = render(page(true));
    await screen.findByText("已同步");
    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), `重新联网 ${outcome}`);
    await user.click(screen.getByRole("button", { name: "创建" }));
    await screen.findByText("修改已保存在本机，自动同步失败，将稍后重试。");

    rendered.rerender(page(false));
    rendered.rerender(page(true));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(screen.getByText("修改已保存在本机，自动同步失败，将稍后重试。")).toBeVisible();
  });

  test("reconnect recovery preserves an unrelated local operation error", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    const meeting = await repository.create("保留联网操作错误", null, now);
    await acknowledgePending(repository);
    const refresh = vi.fn()
      .mockResolvedValueOnce({ state: "idle" as const })
      .mockImplementationOnce(async () => {
        await acknowledgePending(repository);
        return { state: "idle" as const };
      });
    const scheduleRefresh = vi.fn().mockRejectedValueOnce(new Error("network unavailable"));
    vi.spyOn(repository, "trash").mockRejectedValueOnce(new Error("local transaction failed"));
    const page = (online: boolean) => <MemoryRouter><MeetingListPage repository={repository} refresh={refresh} scheduleRefresh={scheduleRefresh} now={() => now} online={online} /></MemoryRouter>;
    const rendered = render(page(true));
    await screen.findByText(meeting.title);
    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "联网恢复操作错误");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await screen.findByText("修改已保存在本机，自动同步失败，将稍后重试。");
    await user.click(screen.getByRole("button", { name: `会议操作 ${meeting.title}` }));
    await user.click(screen.getByRole("menuitem", { name: "移至废纸篓" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成，请重试。");

    rendered.rerender(page(false));
    rendered.rerender(page(true));

    await screen.findByText("已同步");
    expect(screen.getByRole("alert")).toHaveTextContent("操作未完成，请重试。");
  });

  test("reconnect recovery preserves an unrelated manual sync error", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    const refresh = vi.fn()
      .mockResolvedValueOnce({ state: "idle" as const })
      .mockRejectedValueOnce(new Error("manual sync failed"))
      .mockImplementationOnce(async () => {
        await acknowledgePending(repository);
        return { state: "idle" as const };
      });
    const scheduleRefresh = vi.fn().mockRejectedValueOnce(new Error("network unavailable"));
    const page = (online: boolean) => <MemoryRouter><MeetingListPage repository={repository} refresh={refresh} scheduleRefresh={scheduleRefresh} now={() => now} online={online} /></MemoryRouter>;
    const rendered = render(page(true));
    await screen.findByText("已同步");
    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "联网恢复手动错误");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await screen.findByText("修改已保存在本机，自动同步失败，将稍后重试。");
    await user.click(screen.getByRole("button", { name: "同步会议" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成，请重试。");

    rendered.rerender(page(false));
    rendered.rerender(page(true));

    await screen.findByText("已同步");
    expect(screen.getByRole("alert")).toHaveTextContent("操作未完成，请重试。");
  });

  test("clears a rejected automatic sync error after a successful manual retry", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    const refresh = vi.fn()
      .mockResolvedValueOnce({ state: "idle" as const })
      .mockImplementationOnce(async () => {
        await acknowledgePending(repository);
        return { state: "idle" as const };
      });
    const scheduleRefresh = vi.fn().mockRejectedValueOnce(new Error("network unavailable"));
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} scheduleRefresh={scheduleRefresh} now={() => now} online /></MemoryRouter>);
    await screen.findByText("已同步");
    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "等待手动同步");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await screen.findByText("修改已保存在本机，自动同步失败，将稍后重试。");

    await user.click(screen.getByRole("button", { name: "同步会议" }));

    await screen.findByText("已同步");
    expect(screen.queryByText("修改已保存在本机，自动同步失败，将稍后重试。")).not.toBeInTheDocument();
    await expect(repository.pendingOperations()).resolves.toEqual([]);
  });

  test.each(["error", "conflict", "reject"] as const)("keeps the saved-locally warning when manual sync ends with %s", async (outcome) => {
    const user = userEvent.setup();
    const repository = catalog();
    const refresh = vi.fn().mockResolvedValueOnce({ state: "idle" as const });
    if (outcome === "reject") {
      refresh.mockRejectedValueOnce(new Error("still offline"));
      refresh.mockResolvedValueOnce({ state: "error" as const });
    } else {
      refresh.mockResolvedValueOnce({ state: outcome });
    }
    const scheduleRefresh = vi.fn().mockRejectedValueOnce(new Error("network unavailable"));
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} scheduleRefresh={scheduleRefresh} now={() => now} online /></MemoryRouter>);
    await screen.findByText("已同步");
    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), `手动 ${outcome}`);
    await user.click(screen.getByRole("button", { name: "创建" }));
    await screen.findByText("修改已保存在本机，自动同步失败，将稍后重试。");

    await user.click(screen.getByRole("button", { name: "同步会议" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    if (outcome === "reject") {
      expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成，请重试。");
      await waitFor(() => expect(screen.getByRole("button", { name: "同步会议" })).toBeEnabled());
      await user.click(screen.getByRole("button", { name: "同步会议" }));
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));
    }

    expect(screen.getByText("修改已保存在本机，自动同步失败，将稍后重试。")).toBeVisible();
  });

  test("manual sync recovery preserves an unrelated local operation error", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    const meeting = await repository.create("保留操作错误", null, now);
    const refresh = vi.fn()
      .mockResolvedValueOnce({ state: "idle" as const })
      .mockImplementationOnce(async () => {
        await acknowledgePending(repository);
        return { state: "idle" as const };
      });
    const scheduleRefresh = vi.fn().mockRejectedValueOnce(new Error("network unavailable"));
    vi.spyOn(repository, "trash").mockRejectedValueOnce(new Error("local transaction failed"));
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} scheduleRefresh={scheduleRefresh} now={() => now} online /></MemoryRouter>);
    await screen.findByText(meeting.title);
    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "制造自动同步错误");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await screen.findByText("修改已保存在本机，自动同步失败，将稍后重试。");
    await user.click(screen.getByRole("button", { name: `会议操作 ${meeting.title}` }));
    await user.click(screen.getByRole("menuitem", { name: "移至废纸篓" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成，请重试。");

    await user.click(screen.getByRole("button", { name: "同步会议" }));

    await screen.findByText("已同步");
    expect(screen.getByRole("alert")).toHaveTextContent("操作未完成，请重试。");
    await expect(repository.pendingOperations()).resolves.toEqual([]);
  });

  test("keeps the real pending count after automatic sync errors and allows manual retry", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    const refresh = vi.fn()
      .mockResolvedValueOnce({ state: "idle" as const })
      .mockResolvedValueOnce({ state: "error" as const })
      .mockImplementationOnce(async () => {
        await acknowledgePending(repository);
        return { state: "idle" as const };
      });
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} now={() => now} online /></MemoryRouter>);
    await screen.findByText("已同步");
    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "稍后同步");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await screen.findByText("同步出错，1 项待同步");
    await user.click(screen.getByRole("button", { name: "同步会议" }));
    await screen.findByText("已同步");
    await expect(repository.pendingOperations()).resolves.toEqual([]);
  });

  test("uses repository pending data offline and never reports pending work as synced", async () => {
    const repository = catalog();
    await repository.create("离线会议", null, now);
    const refresh = vi.fn().mockResolvedValue({ state: "idle" as const });
    const rendered = render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} now={() => now} online={false} /></MemoryRouter>);
    await screen.findByText("离线，1 项待同步");
    expect(refresh).not.toHaveBeenCalled();
    rendered.unmount();

    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} now={() => now} online /></MemoryRouter>);
    await screen.findByText("1 项待同步");
    expect(screen.queryByText("已同步")).not.toBeInTheDocument();
  });

  test("shows an understandable conflict dialog, resolves it, and continues synchronization", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    const meeting = await repository.create("季度复盘", null, now);
    const operation = (await repository.pendingOperations())[0]!;
    await repository.syncRecordFailure(operation, "CONFLICT");
    const resolveConflict = vi.spyOn(repository, "resolveConflict");
    const refresh = vi.fn()
      .mockResolvedValueOnce({ state: "conflict" as const })
      .mockResolvedValue({ state: "idle" as const });
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} now={() => now} online /></MemoryRouter>);
    const trigger = await screen.findByRole("button", { name: "处理冲突" });

    await user.click(trigger);
    const dialog = screen.getByRole("alertdialog", { name: "处理同步冲突" });
    expect(dialog).toHaveTextContent("季度复盘");
    expect(dialog).toHaveTextContent("新建会议");
    expect(dialog).not.toHaveTextContent(operation.id);
    expect(document.querySelector("main")).toHaveAttribute("inert");
    await user.click(screen.getByRole("button", { name: "放弃本地修改" }));

    await waitFor(() => expect(resolveConflict).toHaveBeenCalledWith(operation.sequence));
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "处理同步冲突" })).not.toBeInTheDocument());
    expect(refresh).toHaveBeenCalledTimes(2);
    await expect(repository.get(meeting.id)).resolves.toBeNull();
    expect(screen.getByRole("button", { name: "同步会议" })).toHaveFocus();
  });

  test("keeps a failed conflict resolution open with an alert and preserves escape focus", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    const meeting = await repository.create("失败冲突", null, now);
    const operation = (await repository.pendingOperations())[0]!;
    await repository.syncRecordFailure(operation, "CONFLICT");
    vi.spyOn(repository, "resolveConflict").mockRejectedValueOnce(new Error("transaction failed"));
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={async () => ({ state: "conflict" })} now={() => now} online /></MemoryRouter>);
    const trigger = await screen.findByRole("button", { name: "处理冲突" });
    await user.click(trigger);
    const abandon = screen.getByRole("button", { name: "放弃本地修改" });
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(abandon).toHaveFocus();
    await user.click(abandon);

    expect(await screen.findByRole("alert")).toHaveTextContent("冲突处理失败，请重试。");
    expect(screen.getByRole("alertdialog", { name: "处理同步冲突" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog", { name: "处理同步冲突" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test("keeps automatic and conflict-resolution errors independent", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    await repository.create("独立冲突", null, now);
    const operation = (await repository.pendingOperations())[0]!;
    await repository.syncRecordFailure(operation, "CONFLICT");
    const refresh = vi.fn().mockResolvedValue({ state: "conflict" as const });
    const scheduleRefresh = vi.fn().mockRejectedValueOnce(new Error("network unavailable"));
    vi.spyOn(repository, "resolveConflict").mockRejectedValueOnce(new Error("transaction failed"));
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} scheduleRefresh={scheduleRefresh} now={() => now} online /></MemoryRouter>);
    const conflictTrigger = await screen.findByRole("button", { name: "处理冲突" });
    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "本地待同步");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await screen.findByText("修改已保存在本机，自动同步失败，将稍后重试。");

    await user.click(conflictTrigger);
    const dialog = screen.getByRole("alertdialog", { name: "处理同步冲突" });
    await user.click(screen.getByRole("button", { name: "放弃本地修改" }));

    await waitFor(() => expect(dialog).toHaveTextContent("冲突处理失败，请重试。"));
    expect(screen.getByText("修改已保存在本机，自动同步失败，将稍后重试。")).toBeInTheDocument();
  });

  test("clears the saved-locally warning when conflict recovery completes synchronization", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    await repository.create("冲突恢复自动错误", null, now);
    const operation = (await repository.pendingOperations())[0]!;
    await repository.syncRecordFailure(operation, "CONFLICT");
    const refresh = vi.fn()
      .mockResolvedValueOnce({ state: "conflict" as const })
      .mockImplementationOnce(async () => {
        await acknowledgePending(repository);
        return { state: "idle" as const };
      });
    const scheduleRefresh = vi.fn().mockRejectedValueOnce(new Error("network unavailable"));
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} scheduleRefresh={scheduleRefresh} now={() => now} online /></MemoryRouter>);
    const conflictTrigger = await screen.findByRole("button", { name: "处理冲突" });
    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "冲突恢复待同步");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await screen.findByText("修改已保存在本机，自动同步失败，将稍后重试。");

    await user.click(conflictTrigger);
    await user.click(screen.getByRole("button", { name: "放弃本地修改" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "处理同步冲突" })).not.toBeInTheDocument());
    expect(screen.queryByText("修改已保存在本机，自动同步失败，将稍后重试。")).not.toBeInTheDocument();
    await expect(repository.pendingOperations()).resolves.toEqual([]);
  });

  test("reconnect recovery preserves a conflict-resolution error", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    await repository.create("保留联网冲突错误", null, now);
    const operation = (await repository.pendingOperations())[0]!;
    await repository.syncRecordFailure(operation, "CONFLICT");
    const refresh = vi.fn()
      .mockResolvedValueOnce({ state: "conflict" as const })
      .mockResolvedValueOnce({ state: "idle" as const });
    const scheduleRefresh = vi.fn().mockRejectedValueOnce(new Error("network unavailable"));
    vi.spyOn(repository, "resolveConflict").mockRejectedValueOnce(new Error("transaction failed"));
    const page = (online: boolean) => <MemoryRouter><MeetingListPage repository={repository} refresh={refresh} scheduleRefresh={scheduleRefresh} now={() => now} online={online} /></MemoryRouter>;
    const rendered = render(page(true));
    const conflictTrigger = await screen.findByRole("button", { name: "处理冲突" });
    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "联网恢复冲突错误");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await screen.findByText("修改已保存在本机，自动同步失败，将稍后重试。");
    await user.click(conflictTrigger);
    const dialog = screen.getByRole("alertdialog", { name: "处理同步冲突" });
    await user.click(screen.getByRole("button", { name: "放弃本地修改" }));
    await waitFor(() => expect(dialog).toHaveTextContent("冲突处理失败，请重试。"));

    rendered.rerender(page(false));
    rendered.rerender(page(true));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(dialog).toHaveTextContent("冲突处理失败，请重试。");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText("修改已保存在本机，自动同步失败，将稍后重试。")).not.toBeInTheDocument();
  });

  test("keeps a resolved conflict in sync-retry mode when reloading the pending summary fails", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    await repository.create("仍需处理", null, now);
    const operation = (await repository.pendingOperations())[0]!;
    await repository.syncRecordFailure(operation, "CONFLICT");
    const refresh = vi.fn().mockResolvedValue({ state: "conflict" as const });
    const resolveConflict = vi.spyOn(repository, "resolveConflict");
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} now={() => now} online /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: "处理冲突" }));
    vi.spyOn(repository, "pendingStatus").mockRejectedValueOnce(new Error("indexeddb read failed"));

    await user.click(screen.getByRole("button", { name: "放弃本地修改" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alertdialog", { name: "处理同步冲突" })).toBeVisible();
    expect(screen.getByText("同步冲突")).toBeVisible();
    expect(document.querySelector("main")).toHaveAttribute("inert");
    await user.click(screen.getByRole("button", { name: "重试同步" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));
    expect(resolveConflict).toHaveBeenCalledTimes(1);
  });

  test("reopens a resolved conflict as a sync retry without resolving the deleted operation twice", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    await repository.create("重试同步", null, now);
    const operation = (await repository.pendingOperations())[0]!;
    await repository.syncRecordFailure(operation, "CONFLICT");
    const resolveConflict = vi.spyOn(repository, "resolveConflict");
    const refresh = vi.fn()
      .mockResolvedValueOnce({ state: "conflict" as const })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ state: "idle" as const });
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} now={() => now} online /></MemoryRouter>);
    const trigger = await screen.findByRole("button", { name: "处理冲突" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "放弃本地修改" }));
    await screen.findByRole("alert");
    await user.keyboard("{Escape}");
    await user.click(trigger);

    await user.click(screen.getByRole("button", { name: "重试同步" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "处理同步冲突" })).not.toBeInTheDocument());
    expect(resolveConflict).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  test("shows conflict details offline without attempting destructive resolution or refresh", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    await repository.create("离线冲突", null, now);
    const operation = (await repository.pendingOperations())[0]!;
    await repository.syncRecordFailure(operation, "CONFLICT");
    const resolveConflict = vi.spyOn(repository, "resolveConflict");
    const refresh = vi.fn().mockResolvedValue({ state: "idle" as const });
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} now={() => now} online={false} /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: "处理冲突" }));

    expect(screen.getByRole("button", { name: "放弃本地修改" })).toBeDisabled();
    expect(resolveConflict).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  test("keeps the toolbar available while deferred local catalog loading resolves to empty", async () => {
    const repository = catalog();
    let resolveMeetings: ((value: never[]) => void) | undefined;
    let resolveFolders: ((value: never[]) => void) | undefined;
    const meetings = new Promise<never[]>((resolve) => { resolveMeetings = resolve; });
    const folders = new Promise<never[]>((resolve) => { resolveFolders = resolve; });
    const list = vi.spyOn(repository, "list").mockImplementation(() => meetings);
    const listFolders = vi.spyOn(repository, "listFolders").mockImplementation(() => folders);
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={async () => ({ state: "idle" })} now={() => now} online /></MemoryRouter>);

    expect(await screen.findByText("正在载入会议...")).toBeVisible();
    expect(screen.getByRole("button", { name: "新建会议" })).toBeVisible();
    resolveMeetings?.([]); resolveFolders?.([]);
    await screen.findByText("还没有会议");
    list.mockRestore(); listFolders.mockRestore();
  });

  test("only commits the newest reload when an older reload resolves last", async () => {
    const repository = catalog();
    const fresh = await repository.create("新的结果", null, now);
    const firstMeetings = deferred<typeof fresh[]>();
    const firstFolders = deferred<never[]>();
    let listCalls = 0;
    let folderCalls = 0;
    vi.spyOn(repository, "list").mockImplementation(() => ++listCalls === 1 ? firstMeetings.promise : Promise.resolve([fresh]));
    vi.spyOn(repository, "listFolders").mockImplementation(() => ++folderCalls === 1 ? firstFolders.promise : Promise.resolve([]));
    const refresh = vi.fn().mockResolvedValue({ state: "idle" as const });
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} now={() => now} online /></MemoryRouter>);

    await screen.findByText("新的结果");
    firstMeetings.resolve([]); firstFolders.resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() => expect(screen.getByText("新的结果")).toBeVisible());
  });

  test("prevents duplicate folder creation and keeps a failed form open for retry", async () => {
    const user = userEvent.setup();
    const repository = renderPage();
    const pending = deferred<Awaited<ReturnType<MeetingCatalogRepository["createFolder"]>>>();
    const createFolder = vi.spyOn(repository, "createFolder").mockImplementationOnce(() => pending.promise);
    await screen.findByRole("heading", { name: "会议本" });
    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "工作");
    const create = screen.getByRole("button", { name: "创建" });
    fireEvent.click(create);
    fireEvent.click(create);
    expect(createFolder).toHaveBeenCalledTimes(1);
    pending.reject(new Error("write failed"));
    await screen.findByRole("alert");
    expect(screen.getByRole("dialog", { name: "新建分类" })).toBeVisible();
    expect(screen.getByRole("button", { name: "创建" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "创建" }));
    await screen.findByRole("button", { name: "工作" });
  });

  test("does not commit deferred catalog loading after unmount", async () => {
    const repository = catalog();
    const meetings = deferred<never[]>();
    const folders = deferred<never[]>();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(repository, "list").mockImplementation(() => meetings.promise);
    vi.spyOn(repository, "listFolders").mockImplementation(() => folders.promise);
    const rendered = render(<MemoryRouter><MeetingListPage repository={repository} refresh={async () => ({ state: "idle" })} now={() => now} online={false} /></MemoryRouter>);

    await screen.findByText("正在载入会议...");
    rendered.unmount();
    meetings.resolve([]); folders.resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  test("does not start a reload after a mutation resolves following unmount", async () => {
    const user = userEvent.setup();
    const repository = renderPage();
    const pending = deferred<Awaited<ReturnType<MeetingCatalogRepository["createFolder"]>>>();
    vi.spyOn(repository, "createFolder").mockImplementation(() => pending.promise);
    const list = vi.spyOn(repository, "list");
    await screen.findByRole("heading", { name: "会议本" });
    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "工作");
    await user.click(screen.getByRole("button", { name: "创建" }));
    const callsBeforeUnmount = list.mock.calls.length;
    cleanup();
    pending.resolve({ id: crypto.randomUUID(), name: "工作", createdAt: now, updatedAt: now, syncVersion: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(list).toHaveBeenCalledTimes(callsBeforeUnmount);
  });

  test("does not repeat a successful create when the following reload fails", async () => {
    const user = userEvent.setup();
    const repository = renderPage();
    const createFolder = vi.spyOn(repository, "createFolder");
    await screen.findByRole("heading", { name: "会议本" });
    await screen.findByText("还没有会议");
    const list = vi.spyOn(repository, "list").mockRejectedValueOnce(new Error("read failed"));
    await user.click(screen.getByRole("button", { name: "新建分类" }));
    await user.type(screen.getByLabelText("分类名称"), "工作");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(createFolder).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "新建分类" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeVisible();
    list.mockRestore();
  });

  test("shows recoverable errors for folder removal, restore, and manual synchronization", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    const folder = await repository.createFolder("工作", now);
    const meeting = await repository.create("待恢复", null, now);
    await repository.trash(meeting.id, "2026-08-21T00:01:00.000Z");
    const refresh = vi.fn().mockResolvedValue({ state: "idle" as const });
    const removeFolder = vi.spyOn(repository, "removeFolder").mockRejectedValueOnce(new Error("delete failed"));
    const restore = vi.spyOn(repository, "restore").mockRejectedValueOnce(new Error("restore failed"));
    render(<MemoryRouter><MeetingListPage repository={repository} refresh={refresh} now={() => now} online /></MemoryRouter>);
    await screen.findByRole("button", { name: "删除分类 工作" });

    await user.click(screen.getByRole("button", { name: "删除分类 工作" }));
    await user.click(screen.getByRole("button", { name: "删除" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alertdialog", { name: "删除分类？" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(removeFolder).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "废纸篓" }));
    await user.click(screen.getByRole("button", { name: "会议操作 待恢复" }));
    await user.click(screen.getByRole("menuitem", { name: "恢复" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("menuitem", { name: "恢复" })).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: "恢复" }));
    await user.click(screen.getByRole("button", { name: "全部会议" }));
    await screen.findByText("待恢复");

    refresh.mockRejectedValueOnce(new Error("sync failed"));
    await user.click(screen.getByRole("button", { name: "同步会议" }));
    await screen.findByText(/同步出错/);
    refresh.mockImplementationOnce(async () => {
      await acknowledgePending(repository);
      return { state: "idle" as const };
    });
    await user.click(screen.getByRole("button", { name: "同步会议" }));
    await screen.findByText("已同步");
  });

  test("provides menu and dialog keyboard relationships", async () => {
    const user = userEvent.setup();
    const repository = renderPage();
    const meeting = await repository.create("可操作", null, now);
    await screen.findByRole("heading", { name: "会议本" });
    await user.click(screen.getByRole("button", { name: "同步会议" }));
    const trigger = await screen.findByRole("button", { name: "会议操作 可操作" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", `meeting-menu-${meeting.id}`);
    expect(screen.getByRole("menu")).toHaveAttribute("id", `meeting-menu-${meeting.id}`);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "新建分类" }));
    expect(screen.getByRole("dialog", { name: "新建分类" })).toHaveAttribute("aria-modal", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "新建分类" })).not.toBeInTheDocument();
  });

  test("moves focus through menu items and traps dialog focus", async () => {
    const user = userEvent.setup();
    const repository = renderPage();
    await repository.create("键盘会议", null, now);
    await screen.findByRole("heading", { name: "会议本" });
    await user.click(screen.getByRole("button", { name: "同步会议" }));
    const trigger = await screen.findByRole("button", { name: "会议操作 键盘会议" });
    await user.click(trigger);
    const rename = screen.getByRole("menuitem", { name: "重命名" });
    const trash = screen.getByRole("menuitem", { name: "移至废纸篓" });
    expect(rename).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(trash).toHaveFocus();
    await user.keyboard("{Home}");
    expect(rename).toHaveFocus();
    await user.keyboard("{End}");
    expect(trash).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();

    const categoryTrigger = screen.getByRole("button", { name: "新建分类" });
    await user.click(categoryTrigger);
    const dialog = screen.getByRole("dialog", { name: "新建分类" });
    expect(document.querySelector("main")).toHaveAttribute("inert");
    const input = screen.getByLabelText("分类名称");
    expect(input).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(screen.getByRole("button", { name: "创建" })).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(input).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(categoryTrigger).toHaveFocus();
    expect(dialog).not.toBeInTheDocument();
  });

  test("returns focus to the dialog trigger after successful creation", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("还没有会议");
    const trigger = screen.getByRole("button", { name: "新建分类" });
    await user.click(trigger);
    await user.type(screen.getByLabelText("分类名称"), "完成后返回");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  test("moves focus to a stable category control after deleting its trigger", async () => {
    const user = userEvent.setup();
    const repository = catalog();
    const folder = await repository.createFolder("待删除", now);
    renderPage(repository);
    await screen.findByRole("button", { name: "删除分类 待删除" });
    const fallback = screen.getByRole("button", { name: "新建分类" });
    await user.click(screen.getByRole("button", { name: "删除分类 待删除" }));
    await user.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "删除分类 待删除" })).not.toBeInTheDocument());
    expect(fallback).toHaveFocus();
    expect(await repository.listFolders()).not.toContainEqual(expect.objectContaining({ id: folder.id }));
  });

  test("closes an open menu when Tab or Shift+Tab leaves it", async () => {
    const user = userEvent.setup();
    const repository = renderPage();
    await repository.create("菜单会议", null, now);
    await screen.findByRole("heading", { name: "会议本" });
    await user.click(screen.getByRole("button", { name: "同步会议" }));
    const trigger = await screen.findByRole("button", { name: "会议操作 菜单会议" });
    await user.click(trigger);
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(trigger);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  test("filters folders and unfiled meetings, and renders one status with a duration", async () => {
    const repository = catalog();
    const first = { id: crypto.randomUUID(), name: "甲", createdAt: now, updatedAt: now, syncVersion: 0 };
    const second = { id: crypto.randomUUID(), name: "乙", createdAt: now, updatedAt: now, syncVersion: 0 };
    const meeting = (id: string, title: string, folderId: string | null) => ({ id, title, folderId, status: "draft" as const, startedAt: null, endedAt: null, createdAt: now, updatedAt: now, trashedAt: null, syncVersion: 0 });
    const timed = { ...meeting(crypto.randomUUID(), "有时长", first.id), startedAt: now, endedAt: "2026-08-21T00:30:00.000Z", status: "ready" as const };
    await repository.syncRefresh([first, second], [timed, meeting(crypto.randomUUID(), "乙会议", second.id), meeting(crypto.randomUUID(), "未分类会议", null)]);
    renderPage(repository);
    await screen.findByText("有时长");
    await userEvent.setup().click(screen.getByRole("button", { name: "甲" }));
    expect(screen.getByText("有时长")).toBeVisible();
    expect(screen.queryByText("乙会议")).not.toBeInTheDocument();
    const row = screen.getByText("有时长").closest("li")!;
    expect(row).toHaveTextContent("30分钟");
    expect(row.querySelectorAll(".status-label")).toHaveLength(1);
    await userEvent.setup().click(screen.getByRole("button", { name: "未分类" }));
    expect(screen.getByText("未分类会议")).toBeVisible();
    expect(screen.queryByText("有时长")).not.toBeInTheDocument();
  });

  test("removes resize and orientation listeners when unmounted", async () => {
    const matchMedia = vi.fn(() => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const previous = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      const rendered = render(<MemoryRouter><MeetingListPage repository={catalog()} refresh={async () => ({ state: "idle" })} now={() => now} online /></MemoryRouter>);
      await screen.findByText("还没有会议");
      rendered.unmount();
      expect(add).toHaveBeenCalledWith("resize", expect.any(Function));
      expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
      expect(matchMedia.mock.results[0]!.value.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: previous });
    }
  });
});
