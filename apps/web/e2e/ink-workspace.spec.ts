import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";

import {
  createSupabaseFixtureState,
  installSupabaseRoutes,
  offlineMeeting,
  openCatalog,
  removeSupabaseRoutes,
  supabaseOrigin,
  type RemoteMeeting,
  type SupabaseFixtureState,
} from "./supabase-fixture.js";

const userDatabaseName = "meeting-catalog--user--00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000001";

type InkRow = {
  id: string;
  meeting_id: string;
  stroke_order: number;
  tool: "pen" | "highlighter";
  color: string;
  width: number;
  points: Array<{ x: number; y: number; pressure: number; elapsedMs: number }>;
  version: number;
  deleted_at: string | null;
};

async function openMeeting(page: Page, meeting: RemoteMeeting): Promise<void> {
  await page.locator(".meeting-main", { hasText: meeting.title }).click();
  await expect(page.getByRole("tab", { name: "手写" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("手写画布")).toBeVisible();
}

async function databaseRows(page: Page, storeName: "inkStrokes" | "inkOutbox"): Promise<Record<string, unknown>[]> {
  return page.evaluate(async ({ databaseName, requestedStore }) => new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const open = indexedDB.open(databaseName);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const transaction = open.result.transaction(requestedStore, "readonly");
      const request = transaction.objectStore(requestedStore).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => open.result.close();
    };
  }), { databaseName: userDatabaseName, requestedStore: storeName });
}

async function drawStroke(page: Page): Promise<{ x: number; y: number }> {
  const canvas = page.getByLabel("手写画布");
  await canvas.scrollIntoViewIfNeeded();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Ink canvas has no bounds");
  const start = { x: bounds.x + bounds.width * 0.28, y: bounds.y + 90 };
  const end = { x: bounds.x + bounds.width * 0.62, y: bounds.y + 160 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}

async function inkPixelCount(page: Page): Promise<number> {
  return page.getByLabel("手写画布").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index]! > 0) count += 1;
    }
    return count;
  });
}

async function dragSplitter(page: Page, targetRatio: number): Promise<void> {
  const workspace = await page.locator(".meeting-workspace-body").boundingBox();
  const separator = await page.getByRole("separator", { name: "调整转写区域高度" }).boundingBox();
  if (!workspace || !separator) throw new Error("Workspace splitter has no bounds");
  await page.mouse.move(separator.x + separator.width / 2, separator.y + separator.height / 2);
  await page.mouse.down();
  await page.mouse.move(separator.x + separator.width / 2, workspace.y + workspace.height * targetRatio / 100, { steps: 8 });
  await page.mouse.up();
}

async function expectSplitterRatio(page: Page, expected: number): Promise<void> {
  const separator = page.getByRole("separator", { name: "调整转写区域高度" });
  await expect(separator).toHaveAttribute("aria-valuenow", String(expected));
  await expect.poll(() => page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".meeting-workspace-body")!.getBoundingClientRect();
    const splitter = document.querySelector<HTMLElement>(".workspace-separator")!.getBoundingClientRect();
    return (splitter.top - workspace.top) / workspace.height * 100;
  })).toBeCloseTo(expected, 0);
}

async function reconnect(page: Page, context: BrowserContext): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.onlineEvent = "pending";
    window.addEventListener("online", () => { document.documentElement.dataset.onlineEvent = "fired"; }, { once: true });
  });
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
  if (await page.evaluate(() => document.documentElement.dataset.onlineEvent) !== "fired") {
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
  }
}

async function installFakeTranscription(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let socket: FakeWebSocket | null = null;
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = FakeWebSocket.OPEN;
      constructor(_url: string) {
        super();
        socket = this;
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(_data: unknown): void {}
      close(): void {
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
      emitFinal(): void {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "final", segment: { id: crypto.randomUUID() } }) }));
      }
      emitPartial(text: string): void {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "partial", text }) }));
      }
    }
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported(): boolean { return true; }
      readonly mimeType = "audio/webm;codecs=opus";
      state: RecordingState = "inactive";
      start(): void { this.state = "recording"; this.dispatchEvent(new Event("start")); }
      stop(): void { this.state = "inactive"; this.dispatchEvent(new Event("stop")); }
    }
    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() { return { onaudioprocess: null, connect() {}, disconnect() {} }; }
      async close(): Promise<void> {}
    }
    const track = { stop() {} };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
    });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: async () => Object.assign(new EventTarget(), { release: async () => undefined }) },
    });
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: FakeMediaRecorder });
    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, "WebSocket", { configurable: true, value: FakeWebSocket });
    Object.defineProperty(window, "__inkTranscriptE2E", {
      configurable: true,
      value: {
        ready: () => socket !== null,
        emitFinal: () => socket?.emitFinal(),
        emitPartial: (text: string) => socket?.emitPartial(text),
      },
    });
  });
}

async function writeAtFixedCanvasBottom(page: Page): Promise<void> {
  const canvas = page.getByLabel("手写画布");
  const surface = page.locator(".ink-surface");
  const before = await surface.evaluate((element) => ({
    canvasHeight: (element.querySelector("canvas") as HTMLCanvasElement).getBoundingClientRect().height,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  const point = await canvas.evaluate((element) => {
    element.setPointerCapture = () => undefined;
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left + bounds.width * 0.5, y: bounds.top + bounds.height - 32 };
  });
  await canvas.dispatchEvent("pointerdown", { pointerId: 41, pointerType: "mouse", clientX: point.x, clientY: point.y, pressure: 0.5 });
  await canvas.dispatchEvent("pointerup", { pointerId: 41, pointerType: "mouse", clientX: point.x + 16, clientY: point.y + 8, pressure: 0.5 });

  await expect.poll(() => canvas.evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(before.canvasHeight, 1);
  await expect.poll(() => surface.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
}

function inkRows(state: SupabaseFixtureState): InkRow[] {
  return state.inkStrokes;
}

async function expectWorkspaceFits(page: Page, testInfo: TestInfo, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  const canvas = page.getByLabel("手写画布");
  await expect(canvas).toBeVisible();
  await page.getByRole("tabpanel", { name: "手写" }).evaluate((element) => { element.scrollTop = 0; });
  await page.evaluate(() => window.scrollTo(0, 0));
  const layout = await page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
    };
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      topbar: box(".workspace-topbar"),
      metadata: box(".workspace-meta"),
      recording: box(".recording-controls"),
      workspace: box(".meeting-workspace-body"),
      transcript: box(".workspace-transcript"),
      separator: box(".workspace-separator"),
      notes: box(".workspace-notes"),
      tabs: box(".workspace-tabs"),
      toolbar: box(".ink-toolbar"),
      canvas: box(".ink-canvas"),
      titleFits: document.querySelector<HTMLElement>(".workspace-topbar h1")!.scrollWidth
        <= document.querySelector<HTMLElement>(".workspace-topbar h1")!.clientWidth,
      toolbarFits: document.querySelector<HTMLElement>(".ink-toolbar")!.scrollWidth
        <= document.querySelector<HTMLElement>(".ink-toolbar")!.clientWidth,
    };
  });
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.titleFits).toBe(true);
  expect(layout.toolbarFits).toBe(true);
  expect(layout.topbar.bottom).toBeLessThanOrEqual(layout.metadata.top);
  expect(layout.metadata.bottom).toBeLessThanOrEqual(layout.recording.top);
  expect(layout.recording.bottom).toBeLessThanOrEqual(layout.workspace.top);
  expect(layout.transcript.bottom).toBeLessThanOrEqual(layout.separator.top);
  expect(layout.separator.bottom).toBeLessThanOrEqual(layout.notes.top);
  expect(layout.tabs.bottom).toBeLessThanOrEqual(layout.toolbar.top);
  expect(layout.toolbar.bottom).toBeLessThanOrEqual(layout.canvas.top);
  for (const region of [layout.topbar, layout.metadata, layout.recording, layout.workspace, layout.transcript, layout.separator, layout.notes, layout.tabs, layout.toolbar]) {
    expect(region.left).toBeGreaterThanOrEqual(0);
    expect(region.right).toBeLessThanOrEqual(width);
    expect(region.top).toBeGreaterThanOrEqual(0);
    expect(region.bottom).toBeLessThanOrEqual(height + 1);
    expect(region.width).toBeGreaterThan(0);
    expect(region.height).toBeGreaterThan(0);
  }
  expect(layout.canvas.left).toBeGreaterThanOrEqual(0);
  expect(layout.canvas.right).toBeLessThanOrEqual(width);
  expect(layout.canvas.top).toBeLessThan(height);
  expect(layout.canvas.bottom).toBeGreaterThan(0);
  expect(await inkPixelCount(page)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath(`ink-workspace-${width}x${height}.png`), fullPage: true });
}

test("ink fixture replays mutations and exposes ordered Supabase rows", async ({ page }) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  const stroke = {
    id: "00000000-0000-4000-8000-000000000071",
    meetingId: meeting.id,
    order: 0,
    tool: "pen",
    color: "#1D2529",
    width: 4,
    points: [
      { x: 100, y: 100, pressure: 0.4, elapsedMs: 0 },
      { x: 200, y: 180, pressure: 0.8, elapsedMs: 20 },
    ],
    deleted: false,
    version: 1,
  };
  const mutationId = "00000000-0000-4000-8000-000000000072";
  const accessToken = await installSupabaseRoutes(page, fixture);
  await page.goto("/");
  const apply = (body: unknown, authorization?: string) => page.evaluate(async ({ url, body, authorization }) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authorization) headers.authorization = authorization;
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { url: `${supabaseOrigin}/rest/v1/rpc/apply_meeting_ink_mutation`, body, authorization });
  const mutation = { p_mutation_id: mutationId, p_stroke: stroke, p_expected_user_id: userId };

  await expect(apply(mutation)).resolves.toMatchObject({ status: 401 });
  expect(fixture.inkMutations).toHaveLength(0);
  await expect(apply(mutation, `Bearer ${accessToken}`))
    .resolves.toMatchObject({ status: 200, body: { ...stroke, color: "#1d2529" } });
  await expect(apply({ p_mutation_id: mutationId, p_stroke: { ...stroke, deleted: true, version: 2 }, p_expected_user_id: userId }, `Bearer ${accessToken}`))
    .resolves.toMatchObject({ status: 200, body: { deleted: false, version: 1 } });
  expect(fixture.inkMutations).toHaveLength(2);

  const listUrl = `${supabaseOrigin}/rest/v1/meeting_ink_strokes?select=id%2Cmeeting_id%2Cstroke_order%2Ctool%2Ccolor%2Cwidth%2Cpoints%2Cversion%2Cdeleted_at&meeting_id=eq.${meeting.id}&order=stroke_order.asc`;
  const list = (authorization?: string) => page.evaluate(async ({ url, authorization }) => {
    const response = authorization ? await fetch(url, { headers: { authorization } }) : await fetch(url);
    return { status: response.status, body: await response.json() };
  }, { url: listUrl, authorization });
  await expect(list()).resolves.toMatchObject({ status: 401 });
  await expect(list(`Bearer ${accessToken}`)).resolves.toEqual({
    status: 200,
    body: [expect.objectContaining({ id: stroke.id, meeting_id: meeting.id, stroke_order: 0, color: "#1d2529", deleted_at: null })],
  });
});

test("offline ink survives close and reload, syncs, restores in another browser, and keeps tombstones", async ({ browser, context, page }) => {
  await page.setViewportSize({ width: 744, height: 1133 });
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  await openCatalog(page, fixture);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await removeSupabaseRoutes(page);
  await context.setOffline(true);
  await openMeeting(page, meeting);
  await drawStroke(page);

  await expect(page.getByRole("status")).toContainText("待同步");
  await expect.poll(() => databaseRows(page, "inkStrokes")).toEqual([
    expect.objectContaining({ meetingId: meeting.id, deleted: false, version: 1 }),
  ]);
  await expect.poll(() => databaseRows(page, "inkOutbox")).toHaveLength(1);
  expect(await inkPixelCount(page)).toBeGreaterThan(0);

  await page.reload();
  await expect(page.getByLabel("手写画布")).toBeVisible();
  await expect.poll(() => inkPixelCount(page)).toBeGreaterThan(0);
  await page.close();

  const reopened = await context.newPage();
  await reopened.goto("/");
  await expect(reopened.getByRole("heading", { name: "会议本", exact: true })).toBeVisible();
  await openMeeting(reopened, meeting);
  await expect.poll(() => inkPixelCount(reopened)).toBeGreaterThan(0);
  await expect.poll(() => databaseRows(reopened, "inkOutbox")).toHaveLength(1);

  await installSupabaseRoutes(reopened, fixture);
  await reconnect(reopened, context);
  await expect.poll(() => databaseRows(reopened, "inkOutbox")).toEqual([]);
  await expect.poll(() => inkRows(fixture)).toEqual([
    expect.objectContaining({ meeting_id: meeting.id, version: 1, deleted_at: null }),
  ]);
  await expect(reopened.getByRole("status")).toHaveText("已同步");

  const secondContext = await browser.newContext({ viewport: { width: 744, height: 1133 } });
  const secondPage = await secondContext.newPage();
  try {
    await openCatalog(secondPage, fixture);
    await openMeeting(secondPage, meeting);
    await expect.poll(() => inkPixelCount(secondPage)).toBeGreaterThan(0);

    const row = inkRows(fixture)[0]!;
    const canvasBounds = await secondPage.getByLabel("手写画布").boundingBox();
    if (!canvasBounds) throw new Error("Ink canvas has no bounds");
    const scale = canvasBounds.width / 2_048;
    const point = row.points[Math.floor(row.points.length / 2)]!;
    await secondPage.getByRole("button", { name: "橡皮" }).click();
    await secondPage.mouse.click(canvasBounds.x + point.x * scale, canvasBounds.y + point.y * scale);
    await expect.poll(() => inkRows(fixture)[0]?.deleted_at).not.toBeNull();
    await expect.poll(() => inkPixelCount(secondPage)).toBe(0);

    await reopened.reload();
    await expect(reopened.getByLabel("手写画布")).toBeVisible();
    await expect.poll(() => inkPixelCount(reopened)).toBe(0);
    await expect.poll(() => databaseRows(reopened, "inkStrokes")).toEqual([
      expect.objectContaining({ deleted: true, version: 2 }),
    ]);
  } finally {
    await secondContext.close();
  }
});

test("tabs survive hidden rotation and pointer splitter bounds persist by orientation", async ({ page }, testInfo) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  await page.setViewportSize({ width: 744, height: 1133 });
  await openCatalog(page, fixture);
  await openMeeting(page, meeting);
  await page.evaluate(() => {
    localStorage.setItem("meeting-workspace-ratio-portrait", "36");
    localStorage.setItem("meeting-workspace-ratio-landscape", "64");
  });
  await page.reload();
  await expectSplitterRatio(page, 36);
  await page.setViewportSize({ width: 1133, height: 744 });
  await expectSplitterRatio(page, 64);
  await page.setViewportSize({ width: 744, height: 1133 });
  await expectSplitterRatio(page, 36);
  await drawStroke(page);
  await expect.poll(() => inkPixelCount(page)).toBeGreaterThan(0);

  await page.getByRole("tab", { name: "键盘" }).click();
  await page.getByRole("textbox", { name: "会议笔记" }).fill("键盘内容保持");
  await page.setViewportSize({ width: 1133, height: 744 });
  await page.getByRole("tab", { name: "手写" }).click();
  await expect.poll(() => page.getByLabel("手写画布").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return canvas.width > 1 && canvas.width === Math.round(canvas.getBoundingClientRect().width * window.devicePixelRatio);
  })).toBe(true);
  await expect.poll(() => inkPixelCount(page)).toBeGreaterThan(0);
  await page.getByRole("tab", { name: "键盘" }).click();
  await expect(page.getByRole("textbox", { name: "会议笔记" })).toHaveValue("键盘内容保持");
  await page.setViewportSize({ width: 744, height: 1133 });
  await page.getByRole("tab", { name: "AI 总结" }).click();
  await expect(page.getByRole("region", { name: "AI 总结" })).toBeVisible();
  await page.getByRole("tab", { name: "手写" }).click();
  await expect.poll(() => inkPixelCount(page)).toBeGreaterThan(0);
  await page.getByRole("tab", { name: "键盘" }).click();
  await expect(page.getByRole("textbox", { name: "会议笔记" })).toHaveValue("键盘内容保持");

  await dragSplitter(page, 10);
  await expectSplitterRatio(page, 30);
  await page.reload();
  await expectSplitterRatio(page, 30);
  await dragSplitter(page, 90);
  await expectSplitterRatio(page, 70);
  await page.reload();
  await expectSplitterRatio(page, 70);

  await page.setViewportSize({ width: 1133, height: 744 });
  await page.reload();
  await dragSplitter(page, 10);
  await expectSplitterRatio(page, 30);
  await page.reload();
  await expectSplitterRatio(page, 30);
  await dragSplitter(page, 90);
  await expectSplitterRatio(page, 70);
  await page.reload();
  await expectSplitterRatio(page, 70);
  await expectWorkspaceFits(page, testInfo, 1133, 744);

  await page.setViewportSize({ width: 744, height: 1133 });
  await page.reload();
  await expectSplitterRatio(page, 70);
  await expectWorkspaceFits(page, testInfo, 744, 1133);
});

test("ink canvas stays fixed as a scrollable long note in iPad portrait and landscape", async ({ page }) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  await page.setViewportSize({ width: 744, height: 1133 });
  await openCatalog(page, fixture);
  await openMeeting(page, meeting);

  await writeAtFixedCanvasBottom(page);
  await expect.poll(() => databaseRows(page, "inkStrokes")).toHaveLength(1);

  await page.setViewportSize({ width: 1133, height: 744 });
  await expect(page.getByLabel("手写画布")).toBeVisible();
  await writeAtFixedCanvasBottom(page);
  await expect.poll(() => databaseRows(page, "inkStrokes")).toHaveLength(2);
});

test("fixed ink canvas remains stable through orientation changes and saves at the visual bottom", async ({ page }) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  await page.setViewportSize({ width: 1133, height: 744 });
  await openCatalog(page, fixture);
  await openMeeting(page, meeting);

  const canvas = page.getByLabel("手写画布");
  await expect(canvas).toHaveCSS("height", "2400px");
  await page.setViewportSize({ width: 744, height: 1133 });
  await expect(canvas).toHaveCSS("height", "2400px");

  const point = await canvas.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left + bounds.width * 0.5, y: bounds.top + bounds.height - 32 };
  });
  await canvas.dispatchEvent("pointerdown", {
    pointerId: 42, pointerType: "mouse", clientX: point.x, clientY: point.y, pressure: 0.5,
  });
  await canvas.dispatchEvent("pointerup", {
    pointerId: 42, pointerType: "mouse", clientX: point.x + 8, clientY: point.y + 8, pressure: 0.5,
  });

  await expect.poll(() => databaseRows(page, "inkStrokes")).toHaveLength(1);
  const rows = await databaseRows(page, "inkStrokes") as unknown as Array<{ points: Array<{ y: number }> }>;
  expect(rows[0]!.points.every((savedPoint) => savedPoint.y <= 200_000)).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("live partial transcript growth follows until paused and the iPad workspace stays unclipped", async ({ page }, testInfo) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  await installFakeTranscription(page);
  await page.setViewportSize({ width: 744, height: 1133 });
  await openCatalog(page, fixture);
  await openMeeting(page, meeting);
  await drawStroke(page);
  await page.getByRole("button", { name: "开始录音" }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & {
    __inkTranscriptE2E: { ready(): boolean };
  }).__inkTranscriptE2E.ready())).toBe(true);

  const transcript = page.getByLabel("实时转写区域");
  for (const length of [1_200, 2_400, 4_800]) {
    await page.evaluate((text) => (window as typeof window & {
      __inkTranscriptE2E: { emitPartial(value: string): void };
    }).__inkTranscriptE2E.emitPartial(text), `实时部分转写${"内容".repeat(length)}`);
    await expect.poll(() => transcript.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
  }
  await transcript.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -800 }));
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page.getByRole("button", { name: "回到最新" })).toBeVisible();
  const pausedAt = await transcript.evaluate((element) => element.scrollTop);
  await page.evaluate((text) => (window as typeof window & {
    __inkTranscriptE2E: { emitPartial(value: string): void };
  }).__inkTranscriptE2E.emitPartial(text), `暂停期间${"新增内容".repeat(2_400)}`);
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(pausedAt);
  await page.getByRole("button", { name: "回到最新" }).click();
  await expect(page.getByRole("button", { name: "回到最新" })).toHaveCount(0);
  await page.evaluate((text) => (window as typeof window & {
    __inkTranscriptE2E: { emitPartial(value: string): void };
  }).__inkTranscriptE2E.emitPartial(text), `恢复跟随${"最终内容".repeat(3_200)}`);
  await expect.poll(() => transcript.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);

  await expectWorkspaceFits(page, testInfo, 744, 1133);
  await expectWorkspaceFits(page, testInfo, 1133, 744);
});
import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";

import {
  createSupabaseFixtureState,
  installSupabaseRoutes,
  offlineMeeting,
  openCatalog,
  removeSupabaseRoutes,
  supabaseOrigin,
  type RemoteMeeting,
  type SupabaseFixtureState,
} from "./supabase-fixture.js";

const userDatabaseName = "meeting-catalog--user--00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000001";

type InkRow = {
  id: string;
  meeting_id: string;
  stroke_order: number;
  tool: "pen" | "highlighter";
  color: string;
  width: number;
  points: Array<{ x: number; y: number; pressure: number; elapsedMs: number }>;
  version: number;
  deleted_at: string | null;
};

async function openMeeting(page: Page, meeting: RemoteMeeting): Promise<void> {
  await page.locator(".meeting-main", { hasText: meeting.title }).click();
  await expect(page.getByRole("tab", { name: "手写" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("手写画布")).toBeVisible();
}

async function databaseRows(page: Page, storeName: "inkStrokes" | "inkOutbox"): Promise<Record<string, unknown>[]> {
  return page.evaluate(async ({ databaseName, requestedStore }) => new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const open = indexedDB.open(databaseName);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const transaction = open.result.transaction(requestedStore, "readonly");
      const request = transaction.objectStore(requestedStore).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => open.result.close();
    };
  }), { databaseName: userDatabaseName, requestedStore: storeName });
}

async function drawStroke(page: Page): Promise<{ x: number; y: number }> {
  const canvas = page.getByLabel("手写画布");
  await canvas.scrollIntoViewIfNeeded();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Ink canvas has no bounds");
  const start = { x: bounds.x + bounds.width * 0.28, y: bounds.y + 90 };
  const end = { x: bounds.x + bounds.width * 0.62, y: bounds.y + 160 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}

async function inkPixelCount(page: Page): Promise<number> {
  return page.getByLabel("手写画布").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index]! > 0) count += 1;
    }
    return count;
  });
}

async function dragSplitter(page: Page, targetRatio: number): Promise<void> {
  const workspace = await page.locator(".meeting-workspace-body").boundingBox();
  const separator = await page.getByRole("separator", { name: "调整转写区域高度" }).boundingBox();
  if (!workspace || !separator) throw new Error("Workspace splitter has no bounds");
  await page.mouse.move(separator.x + separator.width / 2, separator.y + separator.height / 2);
  await page.mouse.down();
  await page.mouse.move(separator.x + separator.width / 2, workspace.y + workspace.height * targetRatio / 100, { steps: 8 });
  await page.mouse.up();
}

async function expectSplitterRatio(page: Page, expected: number): Promise<void> {
  const separator = page.getByRole("separator", { name: "调整转写区域高度" });
  await expect(separator).toHaveAttribute("aria-valuenow", String(expected));
  await expect.poll(() => page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".meeting-workspace-body")!.getBoundingClientRect();
    const splitter = document.querySelector<HTMLElement>(".workspace-separator")!.getBoundingClientRect();
    return (splitter.top - workspace.top) / workspace.height * 100;
  })).toBeCloseTo(expected, 0);
}

async function reconnect(page: Page, context: BrowserContext): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.onlineEvent = "pending";
    window.addEventListener("online", () => { document.documentElement.dataset.onlineEvent = "fired"; }, { once: true });
  });
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
  if (await page.evaluate(() => document.documentElement.dataset.onlineEvent) !== "fired") {
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
  }
}

async function installFakeTranscription(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let socket: FakeWebSocket | null = null;
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = FakeWebSocket.OPEN;
      constructor(_url: string) {
        super();
        socket = this;
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(_data: unknown): void {}
      close(): void {
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
      emitFinal(): void {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "final", segment: { id: crypto.randomUUID() } }) }));
      }
      emitPartial(text: string): void {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "partial", text }) }));
      }
    }
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported(): boolean { return true; }
      readonly mimeType = "audio/webm;codecs=opus";
      state: RecordingState = "inactive";
      start(): void { this.state = "recording"; this.dispatchEvent(new Event("start")); }
      stop(): void { this.state = "inactive"; this.dispatchEvent(new Event("stop")); }
    }
    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() { return { onaudioprocess: null, connect() {}, disconnect() {} }; }
      async close(): Promise<void> {}
    }
    const track = { stop() {} };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
    });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: async () => Object.assign(new EventTarget(), { release: async () => undefined }) },
    });
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: FakeMediaRecorder });
    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, "WebSocket", { configurable: true, value: FakeWebSocket });
    Object.defineProperty(window, "__inkTranscriptE2E", {
      configurable: true,
      value: {
        ready: () => socket !== null,
        emitFinal: () => socket?.emitFinal(),
        emitPartial: (text: string) => socket?.emitPartial(text),
      },
    });
  });
}

async function growInkCanvasAtBottom(page: Page): Promise<void> {
  const canvas = page.getByLabel("手写画布");
  const surface = page.locator(".ink-surface");
  const before = await surface.evaluate((element) => ({
    canvasHeight: (element.querySelector("canvas") as HTMLCanvasElement).getBoundingClientRect().height,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  const point = await canvas.evaluate((element) => {
    element.setPointerCapture = () => undefined;
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left + bounds.width * 0.5, y: bounds.top + bounds.height - 32 };
  });
  await canvas.dispatchEvent("pointerdown", { pointerId: 41, pointerType: "mouse", clientX: point.x, clientY: point.y, pressure: 0.5 });
  await canvas.dispatchEvent("pointerup", { pointerId: 41, pointerType: "mouse", clientX: point.x + 16, clientY: point.y + 8, pressure: 0.5 });

  await expect.poll(() => canvas.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(before.canvasHeight);
  await expect.poll(() => surface.evaluate((element) => element.scrollHeight)).toBeGreaterThan(before.scrollHeight);
  await expect.poll(() => surface.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
}

function inkRows(state: SupabaseFixtureState): InkRow[] {
  return state.inkStrokes;
}

async function expectWorkspaceFits(page: Page, testInfo: TestInfo, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  const canvas = page.getByLabel("手写画布");
  await expect(canvas).toBeVisible();
  await page.getByRole("tabpanel", { name: "手写" }).evaluate((element) => { element.scrollTop = 0; });
  await page.evaluate(() => window.scrollTo(0, 0));
  const layout = await page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
    };
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      topbar: box(".workspace-topbar"),
      metadata: box(".workspace-meta"),
      recording: box(".recording-controls"),
      workspace: box(".meeting-workspace-body"),
      transcript: box(".workspace-transcript"),
      separator: box(".workspace-separator"),
      notes: box(".workspace-notes"),
      tabs: box(".workspace-tabs"),
      toolbar: box(".ink-toolbar"),
      canvas: box(".ink-canvas"),
      titleFits: document.querySelector<HTMLElement>(".workspace-topbar h1")!.scrollWidth
        <= document.querySelector<HTMLElement>(".workspace-topbar h1")!.clientWidth,
      toolbarFits: document.querySelector<HTMLElement>(".ink-toolbar")!.scrollWidth
        <= document.querySelector<HTMLElement>(".ink-toolbar")!.clientWidth,
    };
  });
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.titleFits).toBe(true);
  expect(layout.toolbarFits).toBe(true);
  expect(layout.topbar.bottom).toBeLessThanOrEqual(layout.metadata.top);
  expect(layout.metadata.bottom).toBeLessThanOrEqual(layout.recording.top);
  expect(layout.recording.bottom).toBeLessThanOrEqual(layout.workspace.top);
  expect(layout.transcript.bottom).toBeLessThanOrEqual(layout.separator.top);
  expect(layout.separator.bottom).toBeLessThanOrEqual(layout.notes.top);
  expect(layout.tabs.bottom).toBeLessThanOrEqual(layout.toolbar.top);
  expect(layout.toolbar.bottom).toBeLessThanOrEqual(layout.canvas.top);
  for (const region of [layout.topbar, layout.metadata, layout.recording, layout.workspace, layout.transcript, layout.separator, layout.notes, layout.tabs, layout.toolbar]) {
    expect(region.left).toBeGreaterThanOrEqual(0);
    expect(region.right).toBeLessThanOrEqual(width);
    expect(region.top).toBeGreaterThanOrEqual(0);
    expect(region.bottom).toBeLessThanOrEqual(height + 1);
    expect(region.width).toBeGreaterThan(0);
    expect(region.height).toBeGreaterThan(0);
  }
  expect(layout.canvas.left).toBeGreaterThanOrEqual(0);
  expect(layout.canvas.right).toBeLessThanOrEqual(width);
  expect(layout.canvas.top).toBeLessThan(height);
  expect(layout.canvas.bottom).toBeGreaterThan(0);
  expect(await inkPixelCount(page)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath(`ink-workspace-${width}x${height}.png`), fullPage: true });
}

test("ink fixture replays mutations and exposes ordered Supabase rows", async ({ page }) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  const stroke = {
    id: "00000000-0000-4000-8000-000000000071",
    meetingId: meeting.id,
    order: 0,
    tool: "pen",
    color: "#1D2529",
    width: 4,
    points: [
      { x: 100, y: 100, pressure: 0.4, elapsedMs: 0 },
      { x: 200, y: 180, pressure: 0.8, elapsedMs: 20 },
    ],
    deleted: false,
    version: 1,
  };
  const mutationId = "00000000-0000-4000-8000-000000000072";
  const accessToken = await installSupabaseRoutes(page, fixture);
  await page.goto("/");
  const apply = (body: unknown, authorization?: string) => page.evaluate(async ({ url, body, authorization }) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authorization) headers.authorization = authorization;
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { url: `${supabaseOrigin}/rest/v1/rpc/apply_meeting_ink_mutation`, body, authorization });
  const mutation = { p_mutation_id: mutationId, p_stroke: stroke, p_expected_user_id: userId };

  await expect(apply(mutation)).resolves.toMatchObject({ status: 401 });
  expect(fixture.inkMutations).toHaveLength(0);
  await expect(apply(mutation, `Bearer ${accessToken}`))
    .resolves.toMatchObject({ status: 200, body: { ...stroke, color: "#1d2529" } });
  await expect(apply({ p_mutation_id: mutationId, p_stroke: { ...stroke, deleted: true, version: 2 }, p_expected_user_id: userId }, `Bearer ${accessToken}`))
    .resolves.toMatchObject({ status: 200, body: { deleted: false, version: 1 } });
  expect(fixture.inkMutations).toHaveLength(2);

  const listUrl = `${supabaseOrigin}/rest/v1/meeting_ink_strokes?select=id%2Cmeeting_id%2Cstroke_order%2Ctool%2Ccolor%2Cwidth%2Cpoints%2Cversion%2Cdeleted_at&meeting_id=eq.${meeting.id}&order=stroke_order.asc`;
  const list = (authorization?: string) => page.evaluate(async ({ url, authorization }) => {
    const response = authorization ? await fetch(url, { headers: { authorization } }) : await fetch(url);
    return { status: response.status, body: await response.json() };
  }, { url: listUrl, authorization });
  await expect(list()).resolves.toMatchObject({ status: 401 });
  await expect(list(`Bearer ${accessToken}`)).resolves.toEqual({
    status: 200,
    body: [expect.objectContaining({ id: stroke.id, meeting_id: meeting.id, stroke_order: 0, color: "#1d2529", deleted_at: null })],
  });
});

test("offline ink survives close and reload, syncs, restores in another browser, and keeps tombstones", async ({ browser, context, page }) => {
  await page.setViewportSize({ width: 744, height: 1133 });
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  await openCatalog(page, fixture);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await removeSupabaseRoutes(page);
  await context.setOffline(true);
  await openMeeting(page, meeting);
  await drawStroke(page);

  await expect(page.getByRole("status")).toContainText("待同步");
  await expect.poll(() => databaseRows(page, "inkStrokes")).toEqual([
    expect.objectContaining({ meetingId: meeting.id, deleted: false, version: 1 }),
  ]);
  await expect.poll(() => databaseRows(page, "inkOutbox")).toHaveLength(1);
  expect(await inkPixelCount(page)).toBeGreaterThan(0);

  await page.reload();
  await expect(page.getByLabel("手写画布")).toBeVisible();
  await expect.poll(() => inkPixelCount(page)).toBeGreaterThan(0);
  await page.close();

  const reopened = await context.newPage();
  await reopened.goto("/");
  await expect(reopened.getByRole("heading", { name: "会议本", exact: true })).toBeVisible();
  await openMeeting(reopened, meeting);
  await expect.poll(() => inkPixelCount(reopened)).toBeGreaterThan(0);
  await expect.poll(() => databaseRows(reopened, "inkOutbox")).toHaveLength(1);

  await installSupabaseRoutes(reopened, fixture);
  await reconnect(reopened, context);
  await expect.poll(() => databaseRows(reopened, "inkOutbox")).toEqual([]);
  await expect.poll(() => inkRows(fixture)).toEqual([
    expect.objectContaining({ meeting_id: meeting.id, version: 1, deleted_at: null }),
  ]);
  await expect(reopened.getByRole("status")).toHaveText("已同步");

  const secondContext = await browser.newContext({ viewport: { width: 744, height: 1133 } });
  const secondPage = await secondContext.newPage();
  try {
    await openCatalog(secondPage, fixture);
    await openMeeting(secondPage, meeting);
    await expect.poll(() => inkPixelCount(secondPage)).toBeGreaterThan(0);

    const row = inkRows(fixture)[0]!;
    const canvasBounds = await secondPage.getByLabel("手写画布").boundingBox();
    if (!canvasBounds) throw new Error("Ink canvas has no bounds");
    const scale = canvasBounds.width / 2_048;
    const point = row.points[Math.floor(row.points.length / 2)]!;
    await secondPage.getByRole("button", { name: "橡皮" }).click();
    await secondPage.mouse.click(canvasBounds.x + point.x * scale, canvasBounds.y + point.y * scale);
    await expect.poll(() => inkRows(fixture)[0]?.deleted_at).not.toBeNull();
    await expect.poll(() => inkPixelCount(secondPage)).toBe(0);

    await reopened.reload();
    await expect(reopened.getByLabel("手写画布")).toBeVisible();
    await expect.poll(() => inkPixelCount(reopened)).toBe(0);
    await expect.poll(() => databaseRows(reopened, "inkStrokes")).toEqual([
      expect.objectContaining({ deleted: true, version: 2 }),
    ]);
  } finally {
    await secondContext.close();
  }
});

test("tabs survive hidden rotation and pointer splitter bounds persist by orientation", async ({ page }, testInfo) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  await page.setViewportSize({ width: 744, height: 1133 });
  await openCatalog(page, fixture);
  await openMeeting(page, meeting);
  await page.evaluate(() => {
    localStorage.setItem("meeting-workspace-ratio-portrait", "36");
    localStorage.setItem("meeting-workspace-ratio-landscape", "64");
  });
  await page.reload();
  await expectSplitterRatio(page, 36);
  await page.setViewportSize({ width: 1133, height: 744 });
  await expectSplitterRatio(page, 64);
  await page.setViewportSize({ width: 744, height: 1133 });
  await expectSplitterRatio(page, 36);
  await drawStroke(page);
  await expect.poll(() => inkPixelCount(page)).toBeGreaterThan(0);

  await page.getByRole("tab", { name: "键盘" }).click();
  await page.getByRole("textbox", { name: "会议笔记" }).fill("键盘内容保持");
  await page.setViewportSize({ width: 1133, height: 744 });
  await page.getByRole("tab", { name: "手写" }).click();
  await expect.poll(() => page.getByLabel("手写画布").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return canvas.width > 1 && canvas.width === Math.round(canvas.getBoundingClientRect().width * window.devicePixelRatio);
  })).toBe(true);
  await expect.poll(() => inkPixelCount(page)).toBeGreaterThan(0);
  await page.getByRole("tab", { name: "键盘" }).click();
  await expect(page.getByRole("textbox", { name: "会议笔记" })).toHaveValue("键盘内容保持");
  await page.setViewportSize({ width: 744, height: 1133 });
  await page.getByRole("tab", { name: "AI 总结" }).click();
  await expect(page.getByRole("region", { name: "AI 总结" })).toBeVisible();
  await page.getByRole("tab", { name: "手写" }).click();
  await expect.poll(() => inkPixelCount(page)).toBeGreaterThan(0);
  await page.getByRole("tab", { name: "键盘" }).click();
  await expect(page.getByRole("textbox", { name: "会议笔记" })).toHaveValue("键盘内容保持");

  await dragSplitter(page, 10);
  await expectSplitterRatio(page, 30);
  await page.reload();
  await expectSplitterRatio(page, 30);
  await dragSplitter(page, 90);
  await expectSplitterRatio(page, 70);
  await page.reload();
  await expectSplitterRatio(page, 70);

  await page.setViewportSize({ width: 1133, height: 744 });
  await page.reload();
  await dragSplitter(page, 10);
  await expectSplitterRatio(page, 30);
  await page.reload();
  await expectSplitterRatio(page, 30);
  await dragSplitter(page, 90);
  await expectSplitterRatio(page, 70);
  await page.reload();
  await expectSplitterRatio(page, 70);
  await expectWorkspaceFits(page, testInfo, 1133, 744);

  await page.setViewportSize({ width: 744, height: 1133 });
  await page.reload();
  await expectSplitterRatio(page, 70);
  await expectWorkspaceFits(page, testInfo, 744, 1133);
});

test("ink canvas grows into a scrollable long note in iPad portrait and landscape", async ({ page }) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  await page.setViewportSize({ width: 744, height: 1133 });
  await openCatalog(page, fixture);
  await openMeeting(page, meeting);

  await growInkCanvasAtBottom(page);
  await expect.poll(() => databaseRows(page, "inkStrokes")).toHaveLength(1);

  await page.setViewportSize({ width: 1133, height: 744 });
  await expect(page.getByLabel("手写画布")).toBeVisible();
  await growInkCanvasAtBottom(page);
  await expect.poll(() => databaseRows(page, "inkStrokes")).toHaveLength(2);
});

test("deep landscape ink clamps in portrait and saves at the logical bottom", async ({ page }) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  await page.setViewportSize({ width: 1133, height: 744 });
  await openCatalog(page, fixture);
  await openMeeting(page, meeting);

  const canvas = page.getByLabel("手写画布");
  await canvas.evaluate((element) => {
    element.setPointerCapture = () => undefined;
    element.style.width = "500px";
    element.style.height = "40000px";
  });
  await page.setViewportSize({ width: 744, height: 1133 });
  await canvas.evaluate((element) => {
    element.style.width = "300px";
    window.dispatchEvent(new Event("resize"));
  });

  const portraitLogicalLimit = 200_000 * 300 / 2_048;
  await expect.poll(() => canvas.evaluate((element) => element.getBoundingClientRect().height))
    .toBeCloseTo(portraitLogicalLimit, 1);

  const point = await canvas.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left + bounds.width * 0.5, y: bounds.top + bounds.height - 32 };
  });
  await canvas.dispatchEvent("pointerdown", {
    pointerId: 42, pointerType: "mouse", clientX: point.x, clientY: point.y, pressure: 0.5,
  });
  await canvas.dispatchEvent("pointerup", {
    pointerId: 42, pointerType: "mouse", clientX: point.x + 8, clientY: point.y + 8, pressure: 0.5,
  });

  await expect.poll(() => databaseRows(page, "inkStrokes")).toHaveLength(1);
  const rows = await databaseRows(page, "inkStrokes") as unknown as Array<{ points: Array<{ y: number }> }>;
  expect(rows[0]!.points.every((savedPoint) => savedPoint.y <= 200_000)).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("live partial transcript growth follows until paused and the iPad workspace stays unclipped", async ({ page }, testInfo) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  await installFakeTranscription(page);
  await page.setViewportSize({ width: 744, height: 1133 });
  await openCatalog(page, fixture);
  await openMeeting(page, meeting);
  await drawStroke(page);
  await page.getByRole("button", { name: "开始录音" }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & {
    __inkTranscriptE2E: { ready(): boolean };
  }).__inkTranscriptE2E.ready())).toBe(true);

  const transcript = page.getByLabel("实时转写区域");
  for (const length of [1_200, 2_400, 4_800]) {
    await page.evaluate((text) => (window as typeof window & {
      __inkTranscriptE2E: { emitPartial(value: string): void };
    }).__inkTranscriptE2E.emitPartial(text), `实时部分转写${"内容".repeat(length)}`);
    await expect.poll(() => transcript.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
  }
  await transcript.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -800 }));
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page.getByRole("button", { name: "回到最新" })).toBeVisible();
  const pausedAt = await transcript.evaluate((element) => element.scrollTop);
  await page.evaluate((text) => (window as typeof window & {
    __inkTranscriptE2E: { emitPartial(value: string): void };
  }).__inkTranscriptE2E.emitPartial(text), `暂停期间${"新增内容".repeat(2_400)}`);
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(pausedAt);
  await page.getByRole("button", { name: "回到最新" }).click();
  await expect(page.getByRole("button", { name: "回到最新" })).toHaveCount(0);
  await page.evaluate((text) => (window as typeof window & {
    __inkTranscriptE2E: { emitPartial(value: string): void };
  }).__inkTranscriptE2E.emitPartial(text), `恢复跟随${"最终内容".repeat(3_200)}`);
  await expect.poll(() => transcript.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);

  await expectWorkspaceFits(page, testInfo, 744, 1133);
  await expectWorkspaceFits(page, testInfo, 1133, 744);
});
