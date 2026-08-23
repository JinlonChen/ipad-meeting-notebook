import { expect, test, type Page, type TestInfo } from "@playwright/test";

import {
  createSupabaseFixtureState,
  holdNextNoteMutation,
  installSupabaseRoutes,
  offlineMeeting,
  openCatalog,
  removeSupabaseRoutes,
  supabaseOrigin,
} from "./supabase-fixture.js";

const noteText = "离线结论\n下一步";
const userDatabaseName = "meeting-catalog--user--00000000-0000-4000-8000-000000000001";

async function openMeeting(page: Page, meeting: ReturnType<typeof offlineMeeting>): Promise<void> {
  await page.locator(".meeting-main", { hasText: meeting.title }).click();
  await expect(page.getByRole("textbox", { name: "会议笔记" })).toBeVisible();
}

async function userDatabaseRows(page: Page, storeName: "meetings" | "outbox"): Promise<Record<string, unknown>[]> {
  return page.evaluate(
    async ({ databaseName, storeName: requestedStore }) => new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const open = indexedDB.open(databaseName);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const transaction = open.result.transaction(requestedStore, "readonly");
        const request = transaction.objectStore(requestedStore).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => open.result.close();
      };
    }),
    { databaseName: userDatabaseName, storeName },
  );
}

async function outboxRows(page: Page): Promise<Record<string, unknown>[]> {
  return userDatabaseRows(page, "outbox");
}

async function expectWorkspaceLayout(page: Page, testInfo: TestInfo, width: number, height: number): Promise<void> {
  const topbar = page.locator(".workspace-topbar");
  const back = page.getByRole("button", { name: "返回会议" });
  const title = topbar.getByRole("heading");
  const status = page.locator(".workspace-save-state");
  const metadata = page.locator(".workspace-meta");
  const editor = page.locator(".note-editor");
  const textarea = page.getByRole("textbox", { name: "会议笔记" });

  await expect(textarea).toBeVisible();
  const layout = await page.evaluate(() => {
    const rect = (selector: string) => {
      const box = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
    };
    const saveState = document.querySelector<HTMLElement>(".workspace-save-state")!;
    const heading = document.querySelector<HTMLElement>(".workspace-topbar h1")!;
    return {
      documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      topbar: rect(".workspace-topbar"),
      back: rect(".workspace-topbar .icon-button"),
      title: rect(".workspace-topbar h1"),
      status: rect(".workspace-save-state"),
      metadata: rect(".workspace-meta"),
      editor: rect(".note-editor"),
      textarea: rect(".note-editor textarea"),
      saveStateFits: saveState.scrollWidth <= saveState.clientWidth,
      saveStateText: saveState.textContent ?? "",
      saveStateOverflow: getComputedStyle(saveState).textOverflow,
      titleFits: heading.scrollWidth <= heading.clientWidth,
    };
  });

  expect(layout.documentFits).toBe(true);
  expect(layout.saveStateFits).toBe(true);
  expect(layout.saveStateText).toBe("已保存到本机，待同步");
  expect(layout.saveStateText).not.toMatch(/\.{3,}|…/);
  expect(layout.saveStateOverflow).not.toBe("ellipsis");
  expect(layout.titleFits).toBe(true);
  expect(layout.back.width).toBe(34);
  expect(layout.back.height).toBe(34);
  expect(layout.textarea.height).toBeGreaterThanOrEqual(360);
  expect(layout.topbar.bottom).toBeLessThanOrEqual(layout.metadata.top);
  expect(layout.metadata.bottom).toBeLessThanOrEqual(layout.editor.top);
  expect(layout.editor.top).toBeLessThan(layout.textarea.top);

  const overlaps = (a: typeof layout.back, b: typeof layout.back) =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  expect(overlaps(layout.back, layout.title)).toBe(false);
  expect(overlaps(layout.title, layout.status)).toBe(false);
  expect(overlaps(layout.back, layout.status)).toBe(false);

  await expect(topbar).toBeVisible();
  await expect(back).toBeVisible();
  await expect(title).toBeVisible();
  await expect(status).toBeVisible();
  await expect(metadata).toBeVisible();
  await expect(editor).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`meeting-notes-layout-${width}x${height}.png`), fullPage: true });
}

test("meeting notes survive offline navigation and synchronize after reconnect", async ({ browser, context, page }, testInfo) => {
  await page.setViewportSize({ width: 744, height: 1133 });
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  const noteRpcRequests: string[] = [];
  let snapshotRequests = 0;
  let authUserRequests = 0;
  page.on("request", (request) => {
    if (request.url() === `${supabaseOrigin}/rest/v1/rpc/apply_meeting_note_mutation`) {
      noteRpcRequests.push(request.url());
    }
    if (request.url() === `${supabaseOrigin}/rest/v1/rpc/get_catalog_snapshot`) snapshotRequests += 1;
    if (request.url() === `${supabaseOrigin}/auth/v1/user`) authUserRequests += 1;
  });

  await openCatalog(page, fixture);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await openMeeting(page, meeting);
  const editor = page.getByRole("textbox", { name: "会议笔记" });

  await removeSupabaseRoutes(page);
  await context.setOffline(true);
  await editor.fill(noteText);
  await editor.blur();
  await expect(page.getByRole("status")).toContainText("待同步");
  expect(noteRpcRequests).toHaveLength(0);
  expect(meeting).toMatchObject({ note: "", sync_version: 1 });

  await page.getByRole("button", { name: "返回会议" }).click();
  await openMeeting(page, meeting);
  await expect(page.getByRole("textbox", { name: "会议笔记" })).toHaveValue(noteText);
  await expect(page.getByRole("status")).toHaveText("已保存到本机，待同步");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "会议笔记" })).toHaveValue(noteText);
  await expect(page.getByRole("status")).toHaveText("已保存到本机，待同步");
  expect(noteRpcRequests).toHaveLength(0);
  await expect.poll(() => outboxRows(page)).not.toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("meeting-notes-offline-744x1133.png"), fullPage: true });

  const snapshotsBeforeReconnect = snapshotRequests;
  const authRequestsBeforeReconnect = authUserRequests;
  await installSupabaseRoutes(page, fixture);
  await page.evaluate(() => {
    document.documentElement.dataset.onlineEvent = "pending";
    window.addEventListener("online", () => { document.documentElement.dataset.onlineEvent = "fired"; }, { once: true });
  });
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
  if (await page.evaluate(() => document.documentElement.dataset.onlineEvent) !== "fired") {
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
  }
  await expect.poll(() => authUserRequests).toBe(authRequestsBeforeReconnect + 1);
  await expect.poll(() => noteRpcRequests.length).toBe(1);
  await expect.poll(() => meeting.note).toBe(noteText);
  await expect.poll(() => outboxRows(page)).toEqual([]);
  await expect.poll(() => snapshotRequests).toBe(snapshotsBeforeReconnect + 1);
  await expect(page.getByRole("status")).toHaveText("已同步");
  expect(meeting.sync_version).toBe(2);
  expect(noteRpcRequests).toHaveLength(1);

  const freshContext = await browser.newContext();
  const freshPage = await freshContext.newPage();
  let freshSnapshotRequests = 0;
  freshPage.on("request", (request) => {
    if (request.url() === `${supabaseOrigin}/rest/v1/rpc/get_catalog_snapshot`) freshSnapshotRequests += 1;
  });
  try {
    expect(meeting).toMatchObject({ note: noteText, sync_version: 2 });
    await openCatalog(freshPage, fixture);
    await expect.poll(() => freshSnapshotRequests).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await userDatabaseRows(freshPage, "meetings"))[0]?.note).toBe(noteText);
    await openMeeting(freshPage, meeting);
    await expect(freshPage.getByRole("textbox", { name: "会议笔记" })).toHaveValue(noteText);
  } finally {
    await freshContext.close();
  }
});

test("meeting notes save online automatically and remain authoritative after reload", async ({ page }) => {
  const meeting = offlineMeeting();
  let noteRpcRequests = 0;
  page.on("request", (request) => {
    if (request.url() === `${supabaseOrigin}/rest/v1/rpc/apply_meeting_note_mutation`) noteRpcRequests += 1;
  });

  await openCatalog(page, [meeting]);
  await openMeeting(page, meeting);
  const editor = page.getByRole("textbox", { name: "会议笔记" });
  await editor.fill("在线结论");
  await editor.blur();

  await expect(page.getByRole("status")).toHaveText("已同步");
  await expect.poll(() => meeting.note).toBe("在线结论");
  expect(meeting.sync_version).toBe(2);
  expect(noteRpcRequests).toBe(1);

  await page.reload();
  await expect(page.getByRole("textbox", { name: "会议笔记" })).toHaveValue("在线结论");
});

test("meeting notes keep the latest rapid edit without a version conflict", async ({ page }) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  const firstMutationBarrier = holdNextNoteMutation(fixture);

  await openCatalog(page, fixture);
  await openMeeting(page, meeting);
  const editor = page.getByRole("textbox", { name: "会议笔记" });
  await editor.fill("第一稿");
  await editor.blur();
  await expect(firstMutationBarrier.received).resolves.toMatchObject({
    p_note: "第一稿",
    p_expected_sync_version: 1,
  });
  expect(meeting).toMatchObject({ note: "", sync_version: 1 });

  await editor.focus();
  await editor.fill("最终结论");
  await editor.blur();
  await expect.poll(async () => (await outboxRows(page)).map((row) => row.payload)).toContainEqual(expect.objectContaining({
    note: "最终结论",
    expectedSyncVersion: 1,
  }));
  expect(fixture.noteMutations).toHaveLength(1);

  firstMutationBarrier.release();
  await expect.poll(() => fixture.noteMutations).toHaveLength(2);

  await expect(page.getByRole("status")).toHaveText("已同步");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(fixture.noteMutations.map(({ p_note, p_expected_sync_version: version }) => ({ note: p_note, version }))).toEqual([
    { note: "第一稿", version: 1 },
    { note: "最终结论", version: 2 },
  ]);
  expect(new Set(fixture.noteMutations.map(({ p_operation_id }) => p_operation_id)).size).toBe(2);
  await expect.poll(() => meeting.note).toBe("最终结论");
  expect(meeting.sync_version).toBe(3);
  await expect.poll(() => outboxRows(page)).toEqual([]);
});

test("meeting notes fixture enforces actor version idempotency and authoritative reads", async ({ page }) => {
  const meeting = offlineMeeting();
  const updatedAt = "2026-08-24T08:00:00.000Z";
  const expectedUserId = "00000000-0000-4000-8000-000000000001";
  const mutation = (operationId: string) => ({
    p_operation_id: operationId,
    p_entity_id: meeting.id,
    p_note: "fixture 最新笔记",
    p_updated_at: updatedAt,
    p_expected_sync_version: 1,
    p_expected_user_id: expectedUserId,
  });
  const successMutation = mutation("00000000-0000-4000-8000-000000000020");
  const missingMutation = {
    ...mutation("00000000-0000-4000-8000-000000000021"),
    p_entity_id: "00000000-0000-4000-8000-000000000099",
  };
  const conflictMutation = {
    ...mutation("00000000-0000-4000-8000-000000000022"),
    p_expected_sync_version: 9,
  };
  const post = (path: string, body: unknown) => page.evaluate(async ({ url, body: requestBody }) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    return { httpStatus: response.status, body: await response.json() };
  }, { url: `${supabaseOrigin}${path}`, body });

  await installSupabaseRoutes(page, [meeting]);
  await page.goto("/");

  await expect(post("/rest/v1/rpc/apply_meeting_note_mutation", { ...successMutation, p_expected_user_id: "00000000-0000-4000-8000-000000000099" }))
    .resolves.toMatchObject({ body: { status: 401, code: "AUTH_CONTEXT_CHANGED" } });
  await expect(post("/rest/v1/rpc/apply_meeting_note_mutation", { p_note: "malformed" }))
    .resolves.toMatchObject({ body: { status: 400, code: "INVALID_REQUEST" } });
  const missing = await post("/rest/v1/rpc/apply_meeting_note_mutation", missingMutation);
  expect(missing).toMatchObject({ body: { status: 404, code: "MEETING_NOT_FOUND" } });
  await expect(post("/rest/v1/rpc/apply_meeting_note_mutation", missingMutation)).resolves.toEqual(missing);
  await expect(post("/rest/v1/rpc/apply_meeting_note_mutation", { ...missingMutation, p_note: "复用 missing operation" }))
    .resolves.toMatchObject({ body: { status: 409, code: "IDEMPOTENCY_KEY_REUSED" } });
  const conflict = await post("/rest/v1/rpc/apply_meeting_note_mutation", conflictMutation);
  expect(conflict).toMatchObject({ body: { status: 409, code: "CONFLICT" } });
  await expect(post("/rest/v1/rpc/apply_meeting_note_mutation", conflictMutation)).resolves.toEqual(conflict);
  await expect(post("/rest/v1/rpc/apply_meeting_note_mutation", { ...conflictMutation, p_note: "复用 conflict operation" }))
    .resolves.toMatchObject({ body: { status: 409, code: "IDEMPOTENCY_KEY_REUSED" } });
  expect(meeting).toMatchObject({ note: "", updated_at: "2026-08-22T02:00:00.000Z", sync_version: 1 });

  const success = await post("/rest/v1/rpc/apply_meeting_note_mutation", successMutation);
  const completeMeetingRowKeys = [
    "created_at", "ended_at", "folder_id", "id", "note", "started_at", "status", "status_before_trash",
    "sync_version", "title", "trashed_at", "updated_at", "user_id",
  ].sort();
  expect(success).toMatchObject({
    body: {
      status: 200,
      meeting: { user_id: expectedUserId, note: successMutation.p_note, updated_at: updatedAt, sync_version: 2 },
    },
  });
  expect(Object.keys(success.body.meeting).sort()).toEqual(completeMeetingRowKeys);
  await expect(post("/rest/v1/rpc/apply_meeting_note_mutation", successMutation)).resolves.toEqual(success);
  expect(meeting.sync_version).toBe(2);
  await expect(post("/rest/v1/rpc/apply_meeting_note_mutation", { ...successMutation, p_note: "复用不同内容" }))
    .resolves.toMatchObject({ body: { status: 409, code: "IDEMPOTENCY_KEY_REUSED" } });
  expect(meeting).toMatchObject({ note: successMutation.p_note, updated_at: updatedAt, sync_version: 2 });

  const snapshot = await post("/rest/v1/rpc/get_catalog_snapshot", { p_expected_user_id: expectedUserId });
  expect(snapshot).toMatchObject({ body: { status: 200, meetings: [{ note: successMutation.p_note, sync_version: 2, user_id: expectedUserId }] } });
  expect(Object.keys(snapshot.body.meetings[0]).sort()).toEqual(completeMeetingRowKeys);
  const selected = await page.evaluate(async (url) => (await fetch(url)).json(), `${supabaseOrigin}/rest/v1/meetings`);
  expect(selected).toMatchObject([{ note: successMutation.p_note, sync_version: 2, user_id: expectedUserId }]);
  expect(Object.keys(selected[0]).sort()).toEqual(completeMeetingRowKeys);
  await expect(post("/rest/v1/rpc/not_a_note_mutation", successMutation))
    .resolves.toMatchObject({ httpStatus: 404, body: { message: "E2E route not configured" } });
});

test("meeting notes fixture preserves successful replay state across route reinstall", async ({ page }) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  const mutation = {
    p_operation_id: "00000000-0000-4000-8000-000000000030",
    p_entity_id: meeting.id,
    p_note: "跨 route replay",
    p_updated_at: "2026-08-24T09:00:00.000Z",
    p_expected_sync_version: 1,
    p_expected_user_id: "00000000-0000-4000-8000-000000000001",
  };
  const post = (body: unknown) => page.evaluate(async ({ url, requestBody }) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    return { httpStatus: response.status, body: await response.json() };
  }, { url: `${supabaseOrigin}/rest/v1/rpc/apply_meeting_note_mutation`, requestBody: body });

  await installSupabaseRoutes(page, fixture);
  await page.goto("/");
  const success = await post(mutation);
  expect(success).toMatchObject({ body: { status: 200, meeting: { note: mutation.p_note, sync_version: 2 } } });

  await removeSupabaseRoutes(page);
  await installSupabaseRoutes(page, fixture);
  await expect(post({ ...mutation, p_expected_user_id: "00000000-0000-4000-8000-000000000099" }))
    .resolves.toMatchObject({ body: { status: 401, code: "AUTH_CONTEXT_CHANGED" } });
  await expect(post(mutation)).resolves.toEqual(success);
  expect(meeting.sync_version).toBe(2);
  await expect(post({ ...mutation, p_note: "跨 route 复用不同内容" }))
    .resolves.toMatchObject({ body: { status: 409, code: "IDEMPOTENCY_KEY_REUSED" } });
});

test("meeting notes fixture counts Unicode code points and replays typed invalid requests", async ({ page }) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  const baseMutation = {
    p_entity_id: "00000000-0000-4000-8000-000000000099",
    p_updated_at: "2026-08-24T09:00:00.000Z",
    p_expected_sync_version: 1,
    p_expected_user_id: "00000000-0000-4000-8000-000000000001",
  };
  const post = (body: unknown) => page.evaluate(async ({ url, requestBody }) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    return { httpStatus: response.status, body: await response.json() };
  }, { url: `${supabaseOrigin}/rest/v1/rpc/apply_meeting_note_mutation`, requestBody: body });

  await installSupabaseRoutes(page, fixture);
  await page.goto("/");
  await expect(post({
    ...baseMutation,
    p_operation_id: "00000000-0000-4000-8000-000000000031",
    p_note: "💡".repeat(200_000),
  })).resolves.toMatchObject({ body: { status: 404, code: "MEETING_NOT_FOUND" } });

  const tooLong = {
    ...baseMutation,
    p_operation_id: "00000000-0000-4000-8000-000000000032",
    p_note: "💡".repeat(200_001),
  };
  const tooLongFailure = await post(tooLong);
  expect(tooLongFailure).toMatchObject({ body: { status: 400, code: "INVALID_REQUEST" } });
  await expect(post(tooLong)).resolves.toEqual(tooLongFailure);
  await expect(post({ ...tooLong, p_note: `${tooLong.p_note}💡` }))
    .resolves.toMatchObject({ body: { status: 409, code: "IDEMPOTENCY_KEY_REUSED" } });

  const negativeVersion = {
    ...baseMutation,
    p_operation_id: "00000000-0000-4000-8000-000000000033",
    p_note: "negative version",
    p_expected_sync_version: -1,
  };
  const negativeFailure = await post(negativeVersion);
  expect(negativeFailure).toMatchObject({ body: { status: 400, code: "INVALID_REQUEST" } });
  await expect(post(negativeVersion)).resolves.toEqual(negativeFailure);
  await expect(post({ ...negativeVersion, p_note: "negative version reused" }))
    .resolves.toMatchObject({ body: { status: 409, code: "IDEMPOTENCY_KEY_REUSED" } });
});

test("meeting notes fixture rejects a nullable actor before replay state", async ({ page }) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  const mutation = {
    p_operation_id: "00000000-0000-4000-8000-000000000034",
    p_entity_id: meeting.id,
    p_note: "actor remains uncached",
    p_updated_at: "2026-08-24T10:00:00.000Z",
    p_expected_sync_version: 1,
    p_expected_user_id: null,
  };
  const post = (body: unknown) => page.evaluate(async ({ url, requestBody }) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    return { httpStatus: response.status, body: await response.json() };
  }, { url: `${supabaseOrigin}/rest/v1/rpc/apply_meeting_note_mutation`, requestBody: body });

  await installSupabaseRoutes(page, fixture);
  await page.goto("/");
  await expect(post(mutation)).resolves.toMatchObject({ body: { status: 401, code: "AUTH_CONTEXT_CHANGED" } });
  await expect(post({ ...mutation, p_expected_user_id: "00000000-0000-4000-8000-000000000001" }))
    .resolves.toMatchObject({ body: { status: 200, meeting: { note: mutation.p_note, sync_version: 2 } } });
});

test("meeting notes fixture rejects a null operation id without replay state", async ({ page }) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  await installSupabaseRoutes(page, fixture);
  await page.goto("/");

  const response = await page.evaluate(async ({ url, requestBody }) => {
    const result = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    return result.json();
  }, {
    url: `${supabaseOrigin}/rest/v1/rpc/apply_meeting_note_mutation`,
    requestBody: {
      p_operation_id: null,
      p_entity_id: meeting.id,
      p_note: "null operation",
      p_updated_at: "2026-08-24T10:00:00.000Z",
      p_expected_sync_version: 1,
      p_expected_user_id: "00000000-0000-4000-8000-000000000001",
    },
  });
  expect(response).toMatchObject({ status: 400, code: "INVALID_REQUEST" });
  expect(fixture.noteReplays).toHaveProperty("size", 0);
});

test("meeting notes fixture replays nullable typed mutation failures", async ({ page }) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  const mutation = {
    p_operation_id: "00000000-0000-4000-8000-000000000035",
    p_entity_id: meeting.id,
    p_note: null,
    p_updated_at: "2026-08-24T10:00:00.000Z",
    p_expected_sync_version: 1,
    p_expected_user_id: "00000000-0000-4000-8000-000000000001",
  };
  const post = (body: unknown) => page.evaluate(async ({ url, requestBody }) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    return { httpStatus: response.status, body: await response.json() };
  }, { url: `${supabaseOrigin}/rest/v1/rpc/apply_meeting_note_mutation`, requestBody: body });

  await installSupabaseRoutes(page, fixture);
  await page.goto("/");
  const failure = await post(mutation);
  expect(failure).toMatchObject({ body: { status: 400, code: "INVALID_REQUEST" } });
  await expect(post(mutation)).resolves.toEqual(failure);
  await expect(post({ ...mutation, p_note: "valid but reused" }))
    .resolves.toMatchObject({ body: { status: 409, code: "IDEMPOTENCY_KEY_REUSED" } });
  expect(meeting).toMatchObject({ note: "", sync_version: 1 });
});

for (const viewport of [
  { width: 744, height: 1133 },
  { width: 1133, height: 744 },
  { width: 320, height: 700 },
]) {
  test(`meeting notes fit the ${viewport.width}x${viewport.height} offline workspace`, async ({ context, page }, testInfo) => {
    await page.setViewportSize(viewport);
    const meeting = offlineMeeting();
    await openCatalog(page, [meeting]);
    await openMeeting(page, meeting);
    await removeSupabaseRoutes(page);
    await context.setOffline(true);
    const editor = page.getByRole("textbox", { name: "会议笔记" });
    await editor.fill("离线布局验收");
    await editor.blur();
    await expect(page.getByRole("status")).toHaveText("已保存到本机，待同步");
    await expectWorkspaceLayout(page, testInfo, viewport.width, viewport.height);
  });
}
