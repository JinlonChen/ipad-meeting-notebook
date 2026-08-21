import { afterEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { MeetingCatalogRepository } from "../../src/meetings/repository.js";
import { MeetingListPage, WorkspacePlaceholder } from "../../src/meetings/MeetingListPage.js";

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
});
