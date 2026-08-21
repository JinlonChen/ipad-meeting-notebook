import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function renderPage(repository = catalog(), initialEntries = ["/meetings"]) {
  const refresh = async () => ({ state: "idle" as const });
  render(<MemoryRouter initialEntries={initialEntries}><Routes>
    <Route path="/meetings" element={<MeetingListPage repository={repository} refresh={refresh} now={() => now} online />} />
    <Route path="/meetings/:id" element={<WorkspacePlaceholder />} />
  </Routes></MemoryRouter>);
  return repository;
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.deleteDatabase()));
});

describe("MeetingListPage", () => {
  test("uses portrait drawer mode at 744x1133 and landscape rail mode at 1133x744", async () => {
    Object.defineProperties(window, { innerWidth: { configurable: true, value: 744 }, innerHeight: { configurable: true, value: 1133 } });
    const portrait = render(<MemoryRouter><MeetingListPage repository={catalog()} refresh={async () => ({ state: "idle" })} now={() => now} online={false} /></MemoryRouter>);
    const shell = await screen.findByRole("main");
    expect(shell).toHaveAttribute("data-layout", "portrait");
    expect(shell).toHaveAttribute("data-drawer", "closed");
    expect(screen.getByText("离线，等待同步")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "打开分类" }));
    expect(shell).toHaveAttribute("data-drawer", "open");
    portrait.unmount();

    Object.defineProperties(window, { innerWidth: { configurable: true, value: 1133 }, innerHeight: { configurable: true, value: 744 } });
    window.dispatchEvent(new Event("resize"));
    render(<MemoryRouter><MeetingListPage repository={catalog()} refresh={async () => ({ state: "idle" })} now={() => now} online /></MemoryRouter>);
    expect(await screen.findByRole("main")).toHaveAttribute("data-layout", "landscape");
    await screen.findByText("还没有会议");
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
    await user.click(screen.getByRole("button", { name: "重命名" }));
    const meetingName = screen.getByLabelText("会议名称");
    await user.clear(meetingName); await user.type(meetingName, "已整理");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("已整理");
    await user.click(screen.getByRole("button", { name: "会议操作 已整理" }));
    await user.click(screen.getByRole("button", { name: "移至废纸篓" }));
    await user.click(screen.getByRole("button", { name: "废纸篓" }));
    await screen.findByText("已整理");
    await user.click(screen.getByRole("button", { name: "会议操作 已整理" }));
    await user.click(screen.getByRole("button", { name: "恢复" }));
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
