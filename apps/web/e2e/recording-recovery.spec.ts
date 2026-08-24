import { createHash } from "node:crypto";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  createSupabaseFixtureState,
  installSupabaseRoutes,
  offlineMeeting,
  openCatalog,
  removeSupabaseRoutes,
  supabaseOrigin,
} from "./supabase-fixture.js";

const userDatabaseName = "meeting-catalog--user--00000000-0000-4000-8000-000000000001";

type RecordingRow = Record<string, unknown> & { blobSize?: number; blobType?: string };

async function installFakeBrowserMedia(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls = {
      getUserMedia: [] as MediaStreamConstraints[],
      timeslices: [] as number[],
      trackStops: 0,
      wakeLockRequests: 0,
      wakeLockReleases: 0,
    };
    let visibilityState: DocumentVisibilityState = "visible";
    let activeRecorder: FakeMediaRecorder | null = null;

    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported(mimeType: string): boolean {
        return mimeType === "audio/webm;codecs=opus";
      }

      readonly mimeType: string;
      state: RecordingState = "inactive";

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        super();
        this.mimeType = options?.mimeType ?? "";
        activeRecorder = this;
      }

      start(timeslice?: number): void {
        this.state = "recording";
        if (timeslice !== undefined) calls.timeslices.push(timeslice);
        this.dispatchEvent(new Event("start"));
      }

      stop(): void {
        this.state = "inactive";
        this.dispatchEvent(new Event("stop"));
      }

      emitChunk(contents: string): void {
        const event = new Event("dataavailable") as Event & { data: Blob };
        Object.defineProperty(event, "data", {
          value: new Blob([contents], { type: this.mimeType }),
        });
        this.dispatchEvent(event);
      }
    }

    const track = { stop: () => { calls.trackStops += 1; } };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          calls.getUserMedia.push(constraints);
          return stream;
        },
      },
    });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async () => {
          calls.wakeLockRequests += 1;
          return Object.assign(new EventTarget(), {
            release: async () => { calls.wakeLockReleases += 1; },
          });
        },
      },
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: FakeMediaRecorder });
    Object.defineProperty(window, "__recordingE2E", {
      configurable: true,
      value: {
        calls,
        emitChunk: (contents: string) => activeRecorder?.emitChunk(contents),
        setVisibility: (next: DocumentVisibilityState) => {
          visibilityState = next;
          document.dispatchEvent(new Event("visibilitychange"));
        },
      },
    });
  });
}

async function openMeeting(page: Page, meeting: ReturnType<typeof offlineMeeting>): Promise<void> {
  await page.locator(".meeting-main", { hasText: meeting.title }).click();
  await expect(page.getByRole("textbox", { name: "会议笔记" })).toBeVisible();
}

async function recordingRows(page: Page, storeName: "recordingSessions" | "audioChunks"): Promise<RecordingRow[]> {
  return page.evaluate(async ({ databaseName, storeName: requestedStore }) => new Promise<RecordingRow[]>((resolve, reject) => {
    const open = indexedDB.open(databaseName);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const transaction = open.result.transaction(requestedStore, "readonly");
      const request = transaction.objectStore(requestedStore).getAll();
      request.onsuccess = () => resolve(request.result.map((row: Record<string, unknown> & { blob?: Blob }) => {
        const { blob, ...metadata } = row;
        return blob ? { ...metadata, blobSize: blob.size, blobType: blob.type } : metadata;
      }));
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => open.result.close();
    };
  }), { databaseName: userDatabaseName, storeName });
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

async function markFirstChunkFailed(page: Page): Promise<void> {
  await page.evaluate(async (databaseName) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open(databaseName);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const transaction = open.result.transaction("audioChunks", "readwrite");
      const store = transaction.objectStore("audioChunks");
      const get = store.getAll();
      get.onsuccess = () => {
        const chunk = get.result[0];
        store.put({ ...chunk, uploadState: "failed", remotePath: null, lastError: "UPLOAD_FAILED" });
      };
      transaction.oncomplete = () => { open.result.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  }), userDatabaseName);
}

async function seedExpiredRecording(page: Page, meetingId: string): Promise<void> {
  await page.evaluate(async ({ databaseName, meetingId: id }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open(databaseName);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const transaction = open.result.transaction(["recordingSessions", "audioChunks"], "readwrite");
      transaction.objectStore("recordingSessions").put({
        meetingId: id,
        state: "stopped",
        startedAt: "2026-08-20T00:00:00.000Z",
        endedAt: "2026-08-20T00:01:00.000Z",
        elapsedMs: 60_000,
        nextSequence: 1,
        expiresAt: "2026-08-22T00:01:00.000Z",
      });
      transaction.objectStore("audioChunks").put({
        id: "00000000-0000-4000-8000-000000000050",
        meetingId: id,
        sequence: 0,
        startedOffsetMs: 0,
        endedOffsetMs: 10_000,
        capturedAt: "2026-08-20T00:00:10.000Z",
        expiresAt: "2026-08-22T00:00:10.000Z",
        mimeType: "audio/webm",
        sizeBytes: 7,
        sha256: "0".repeat(64),
        uploadState: "pending",
        remotePath: null,
        attempts: 0,
        lastError: null,
        blob: new Blob(["expired"], { type: "audio/webm" }),
      });
      transaction.oncomplete = () => { open.result.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  }), { databaseName: userDatabaseName, meetingId });
}

async function localMeeting(page: Page, meetingId: string): Promise<RecordingRow | undefined> {
  return page.evaluate(async ({ databaseName, meetingId: id }) => new Promise<RecordingRow | undefined>((resolve, reject) => {
    const open = indexedDB.open(databaseName);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const transaction = open.result.transaction("meetings", "readonly");
      const request = transaction.objectStore("meetings").get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => open.result.close();
    };
  }), { databaseName: userDatabaseName, meetingId });
}

test("starts recording with microphone permission and a ten-second chunk interval", async ({ page }) => {
  const meeting = offlineMeeting();
  await installFakeBrowserMedia(page);
  await openCatalog(page, [meeting]);
  await openMeeting(page, meeting);

  await page.getByRole("button", { name: "开始录音" }).click();

  await expect(page.getByRole("button", { name: "停止录音" })).toBeVisible();
  const calls = await page.evaluate(() => (window as typeof window & {
    __recordingE2E: { calls: Record<string, unknown> };
  }).__recordingE2E.calls);
  expect(calls).toMatchObject({
    getUserMedia: [{ audio: true }],
    timeslices: [10_000],
    trackStops: 0,
    wakeLockRequests: 1,
    wakeLockReleases: 0,
  });
});

test("keeps offline chunks through reload and uploads each remote object once after reconnect", async ({ context, page }) => {
  const meeting = { ...offlineMeeting(), note: "永久保留的会议笔记" };
  const fixture = createSupabaseFixtureState([meeting]);
  const audioRequests: string[] = [];
  const objectHashesAtMetadataInsert: Array<string | null | undefined> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === supabaseOrigin && (url.pathname.includes("meeting_audio_chunks") || url.pathname.includes("meeting-audio"))) {
      audioRequests.push(`${request.method()} ${url.pathname}`);
    }
    if (url.pathname === "/rest/v1/meeting_audio_chunks" && request.method() === "POST") {
      objectHashesAtMetadataInsert.push(Array.from(fixture.audioObjects.values())[0]?.sha256);
    }
  });

  await installFakeBrowserMedia(page);
  await openCatalog(page, fixture);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await openMeeting(page, meeting);

  await removeSupabaseRoutes(page);
  await context.setOffline(true);
  await page.getByRole("button", { name: "开始录音" }).click();
  await expect(page.getByText("录音分片将保存到本机，联网后上传", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as typeof window & {
    __recordingE2E: { emitChunk(contents: string): void };
  }).__recordingE2E.emitChunk("offline-audio-chunk"));

  await expect.poll(() => recordingRows(page, "audioChunks")).toEqual([
    expect.objectContaining({
      meetingId: meeting.id,
      sequence: 0,
      uploadState: "pending",
      remotePath: null,
      blobSize: 19,
      blobType: "audio/webm;codecs=opus",
    }),
  ]);
  expect(audioRequests).toEqual([]);

  await page.reload();
  await expect(page.getByRole("alert")).toHaveText("上次录音已中断，已保存的分片仍在本机");
  await expect(page.getByRole("button", { name: "结束并保存录音" })).toBeVisible();
  await expect.poll(() => recordingRows(page, "recordingSessions")).toEqual([
    expect.objectContaining({ meetingId: meeting.id, state: "recoverable", nextSequence: 1 }),
  ]);
  await page.getByRole("button", { name: "结束并保存录音" }).click();
  await expect(page.getByRole("button", { name: "开始录音" })).toBeVisible();
  await expect.poll(() => recordingRows(page, "recordingSessions")).toEqual([
    expect.objectContaining({ meetingId: meeting.id, state: "stopped", nextSequence: 1 }),
  ]);
  await expect.poll(() => recordingRows(page, "audioChunks")).toEqual([
    expect.objectContaining({ meetingId: meeting.id, sequence: 0, uploadState: "pending", blobSize: 19 }),
  ]);

  await installSupabaseRoutes(page, fixture);
  await reconnect(page, context);
  await expect.poll(() => recordingRows(page, "audioChunks")).toEqual([
    expect.objectContaining({
      meetingId: meeting.id,
      sequence: 0,
      uploadState: "uploaded",
      remotePath: `00000000-0000-4000-8000-000000000001/${meeting.id}/0.webm`,
      attempts: 1,
    }),
  ]);
  expect(fixture.audioChunks).toEqual([
    expect.objectContaining({ meeting_id: meeting.id, sequence: 0, sha256: "00a31f0c6a80fa7856dfb14e1145e5b16364ea969a3ff987a4950d122514c436" }),
  ]);
  expect(fixture.audioObjectUploads).toEqual([
    `00000000-0000-4000-8000-000000000001/${meeting.id}/0.webm`,
  ]);
  expect(fixture.audioObjects.get(fixture.audioObjectUploads[0]!)).toMatchObject({
    sha256: "00a31f0c6a80fa7856dfb14e1145e5b16364ea969a3ff987a4950d122514c436",
    size: 19,
  });
  expect(objectHashesAtMetadataInsert).toEqual([
    "00a31f0c6a80fa7856dfb14e1145e5b16364ea969a3ff987a4950d122514c436",
  ]);

  fixture.audioChunks.splice(0);
  await markFirstChunkFailed(page);
  await page.reload();
  await expect.poll(() => recordingRows(page, "audioChunks")).toEqual([
    expect.objectContaining({
      uploadState: "uploaded",
      remotePath: `00000000-0000-4000-8000-000000000001/${meeting.id}/0.webm`,
      attempts: 2,
    }),
  ]);
  expect(fixture.audioChunks).toHaveLength(1);
  expect(fixture.audioObjects.get(fixture.audioObjectUploads[0]!)).toMatchObject({
    sha256: "00a31f0c6a80fa7856dfb14e1145e5b16364ea969a3ff987a4950d122514c436",
  });
  expect(fixture.audioObjectUploads).toHaveLength(1);
});

test("interrupts recording when the meeting notebook leaves the foreground", async ({ page }) => {
  const meeting = offlineMeeting();
  await installFakeBrowserMedia(page);
  await openCatalog(page, [meeting]);
  await openMeeting(page, meeting);

  const foregroundWarning = page.getByText("请保持会议本在前台；锁屏或切换应用会中断录音", { exact: true });
  await expect(foregroundWarning).toBeVisible();
  await page.getByRole("button", { name: "开始录音" }).click();
  await expect(page.getByRole("button", { name: "停止录音" })).toBeVisible();
  await page.evaluate(() => (window as typeof window & {
    __recordingE2E: { emitChunk(contents: string): void };
  }).__recordingE2E.emitChunk("foreground-audio"));
  await expect.poll(() => recordingRows(page, "audioChunks")).toEqual([
    expect.objectContaining({ meetingId: meeting.id, sequence: 0, blobSize: 16 }),
  ]);
  await page.evaluate(() => (window as typeof window & {
    __recordingE2E: { setVisibility(state: DocumentVisibilityState): void };
  }).__recordingE2E.setVisibility("hidden"));

  await expect(page.getByRole("alert")).toHaveText("上次录音已中断，已保存的分片仍在本机");
  await expect(foregroundWarning).toBeVisible();
  await expect(page.getByRole("button", { name: "结束并保存录音" })).toBeVisible();
  await expect.poll(() => recordingRows(page, "recordingSessions")).toEqual([
    expect.objectContaining({ meetingId: meeting.id, state: "recoverable" }),
  ]);
  await expect.poll(() => recordingRows(page, "audioChunks")).toEqual([
    expect.objectContaining({ meetingId: meeting.id, sequence: 0, blobSize: 16 }),
  ]);
  await expect.poll(() => page.evaluate(() => (window as typeof window & {
    __recordingE2E: { calls: { trackStops: number; wakeLockReleases: number } };
  }).__recordingE2E.calls)).toMatchObject({ trackStops: 1, wakeLockReleases: 1 });
});

test("recording fixture validates multipart content hashes and boundary-like audio bytes", async ({ page }) => {
  const fixture = createSupabaseFixtureState([offlineMeeting()]);
  await installSupabaseRoutes(page, fixture);
  await page.goto("/");
  const upload = (path: string, contents: string, metadataHash: string) => page.evaluate(async ({ url, boundary, contents, metadataHash }) => {
    const body = [
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify({ sha256: metadataHash })}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name=""; filename="blob"\r\nContent-Type: audio/webm\r\n\r\n${contents}\r\n`,
      `--${boundary}--\r\n`,
    ].join("");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer e2e",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: new TextEncoder().encode(body),
    });
    return response.status;
  }, {
    url: `${supabaseOrigin}/storage/v1/object/meeting-audio/${path}`,
    boundary: "recording-boundary",
    contents,
    metadataHash,
  });
  const contents = "audio-prefix\r\n--recording-boundary-not-a-delimiter\u0000audio-suffix";
  const actualHash = createHash("sha256").update(contents).digest("hex");

  await expect(upload("invalid/hash.webm", contents, "0".repeat(64))).resolves.toBe(400);
  expect(fixture.audioObjects.has("invalid/hash.webm")).toBe(false);

  await expect(upload("valid/hash.webm", contents, actualHash)).resolves.toBe(200);
  expect(fixture.audioObjects.get("valid/hash.webm")).toEqual({
    path: "valid/hash.webm",
    sha256: actualHash,
    size: Buffer.byteLength(contents),
  });
});

test("recording fixture rejects invalid audio metadata ownership and mapping", async ({ page }) => {
  const meeting = offlineMeeting();
  const fixture = createSupabaseFixtureState([meeting]);
  await installSupabaseRoutes(page, fixture);
  await page.goto("/");
  const insert = (body: Record<string, unknown>) => page.evaluate(async ({ url, body }) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer e2e", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.status;
  }, { url: `${supabaseOrigin}/rest/v1/meeting_audio_chunks`, body });
  const base = {
    user_id: "00000000-0000-4000-8000-000000000001",
    meeting_id: meeting.id,
    sequence: 0,
    remote_path: `00000000-0000-4000-8000-000000000001/${meeting.id}/0.webm`,
    sha256: "0".repeat(64),
    size_bytes: 19,
    mime_type: "audio/webm;codecs=opus",
    captured_at: "2026-08-24T00:00:00.000Z",
    expires_at: "2026-08-26T00:00:00.000Z",
  };

  await expect(insert({ ...base, sequence: -1, remote_path: "wrong", sha256: "bad", size_bytes: 0, mime_type: "" })).resolves.toBe(400);
  await expect(insert({ ...base, user_id: "00000000-0000-4000-8000-000000000099" })).resolves.toBe(401);
  expect(fixture.audioChunks).toEqual([]);
});

test("removes expired local audio while preserving the meeting and its note", async ({ page }) => {
  const meeting = { ...offlineMeeting(), note: "需要永久保留" };
  await installFakeBrowserMedia(page);
  await openCatalog(page, [meeting]);
  await openMeeting(page, meeting);
  await seedExpiredRecording(page, meeting.id);
  expect(await recordingRows(page, "recordingSessions")).toHaveLength(1);
  expect(await recordingRows(page, "audioChunks")).toHaveLength(1);

  await page.reload();

  await expect(page.getByRole("textbox", { name: "会议笔记" })).toHaveValue(meeting.note);
  await expect.poll(() => recordingRows(page, "audioChunks")).toEqual([]);
  await expect.poll(() => recordingRows(page, "recordingSessions")).toEqual([]);
  await expect.poll(() => localMeeting(page, meeting.id)).toMatchObject({ id: meeting.id, note: meeting.note });
});
