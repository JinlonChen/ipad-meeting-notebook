import { expect, type Page } from "@playwright/test";

export const supabaseOrigin = "http://127.0.0.1:54321";
const userId = "00000000-0000-4000-8000-000000000001";

type RemoteMeetingStatus = "draft" | "recording" | "recoverable" | "uploading" | "processing" | "ready" | "failed" | "trashed";

export type RemoteMeeting = {
  id: string;
  title: string;
  folder_id: string | null;
  status: RemoteMeetingStatus;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  trashed_at: string | null;
  status_before_trash: Exclude<RemoteMeetingStatus, "trashed"> | null;
  sync_version: number;
  note: string;
};

export type MeetingNoteMutation = {
  p_operation_id: string | null;
  p_entity_id: string | null;
  p_note: string | null;
  p_updated_at: string | null;
  p_expected_sync_version: number | null;
  p_expected_user_id: string | null;
};

type NoteTerminalResponse =
  | { status: 200; meeting: RemoteMeeting & { user_id: string } }
  | { status: 400; code: "INVALID_REQUEST" }
  | { status: 404; code: "MEETING_NOT_FOUND" }
  | { status: 409; code: "CONFLICT" };

type NoteReplay = {
  fingerprint: string;
  response: NoteTerminalResponse;
};

type PendingNoteMutationBarrier = {
  received(mutation: MeetingNoteMutation): void;
  released: Promise<void>;
};

export type SupabaseFixtureState = {
  meetings: RemoteMeeting[];
  noteMutations: MeetingNoteMutation[];
  noteReplays: Map<string, NoteReplay>;
  noteMutationBarrier: PendingNoteMutationBarrier | null;
};

export type NoteMutationBarrier = {
  received: Promise<MeetingNoteMutation>;
  release(): void;
};

const defaultMeeting: RemoteMeeting = {
  id: "00000000-0000-4000-8000-000000000010",
  title: "离线会议",
  folder_id: null,
  status: "ready",
  started_at: "2026-08-22T01:00:00.000Z",
  ended_at: "2026-08-22T02:00:00.000Z",
  created_at: "2026-08-22T01:00:00.000Z",
  updated_at: "2026-08-22T02:00:00.000Z",
  trashed_at: null,
  status_before_trash: null,
  sync_version: 1,
  note: "",
};

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseNoteMutation(value: unknown): MeetingNoteMutation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = ["p_operation_id", "p_entity_id", "p_note", "p_updated_at", "p_expected_sync_version", "p_expected_user_id"];
  if (Object.keys(body).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(body, key))) return null;
  if (body.p_operation_id !== null && !isUuid(body.p_operation_id)) return null;
  if (body.p_entity_id !== null && !isUuid(body.p_entity_id)) return null;
  if (body.p_note !== null && typeof body.p_note !== "string") return null;
  if (body.p_updated_at !== null && (typeof body.p_updated_at !== "string" || !Number.isFinite(Date.parse(body.p_updated_at)))) return null;
  if (body.p_expected_sync_version !== null && !Number.isInteger(body.p_expected_sync_version)) return null;
  if (body.p_expected_user_id !== null && !isUuid(body.p_expected_user_id)) return null;
  return body as MeetingNoteMutation;
}

function exceedsCodePointLimit(value: string, limit: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > limit) return true;
  }
  return false;
}

function ownedMeeting(meeting: RemoteMeeting): RemoteMeeting & { user_id: string } {
  return { ...meeting, user_id: userId };
}

export function createSupabaseFixtureState(meetings: RemoteMeeting[] = []): SupabaseFixtureState {
  return { meetings, noteMutations: [], noteReplays: new Map(), noteMutationBarrier: null };
}

export function holdNextNoteMutation(state: SupabaseFixtureState): NoteMutationBarrier {
  if (state.noteMutationBarrier) throw new Error("A note mutation barrier is already active");
  let markReceived!: (mutation: MeetingNoteMutation) => void;
  let release!: () => void;
  const received = new Promise<MeetingNoteMutation>((resolve) => { markReceived = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  state.noteMutationBarrier = { received: markReceived, released };
  return { received, release };
}

function fixtureState(input: RemoteMeeting[] | SupabaseFixtureState): SupabaseFixtureState {
  return Array.isArray(input) ? createSupabaseFixtureState(input) : input;
}

export async function installSupabaseRoutes(page: Page, input: RemoteMeeting[] | SupabaseFixtureState = []): Promise<void> {
  const state = fixtureState(input);
  const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
  const user = { id: userId, aud: "authenticated", role: "authenticated", email: "owner@example.com" };
  const accessToken = `${base64Url({ alg: "none", typ: "JWT" })}.${base64Url({ sub: userId, role: "authenticated", exp: expiresAt })}.e2e`;

  await page.route(`${supabaseOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/auth/v1/token") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ access_token: accessToken, refresh_token: "e2e-refresh-token", token_type: "bearer", expires_in: 3_600, expires_at: expiresAt, user }),
      });
      return;
    }
    if (url.pathname === "/auth/v1/user") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(user) });
      return;
    }
    if (url.pathname === "/auth/v1/logout") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (url.pathname === "/rest/v1/rpc/get_catalog_snapshot") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: 200,
          folders: [],
          meetings: state.meetings.map(ownedMeeting),
        }),
      });
      return;
    }
    if (url.pathname === "/rest/v1/rpc/apply_meeting_note_mutation") {
      let rawBody: unknown;
      try {
        rawBody = request.postDataJSON();
      } catch {
        rawBody = null;
      }
      const mutation = parseNoteMutation(rawBody);
      if (!mutation) {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: 400, code: "INVALID_REQUEST" }) });
        return;
      }
      if (mutation.p_expected_user_id !== userId) {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: 401, code: "AUTH_CONTEXT_CHANGED" }) });
        return;
      }
      if (mutation.p_operation_id === null) {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: 400, code: "INVALID_REQUEST" }) });
        return;
      }

      state.noteMutations.push({ ...mutation });
      const barrier = state.noteMutationBarrier;
      if (barrier) {
        state.noteMutationBarrier = null;
        barrier.received({ ...mutation });
        await barrier.released;
      }

      const fingerprint = JSON.stringify({
        entityId: mutation.p_entity_id,
        note: mutation.p_note,
        updatedAt: mutation.p_updated_at === null ? null : new Date(mutation.p_updated_at).toISOString(),
        expectedSyncVersion: mutation.p_expected_sync_version,
      });
      const replayKey = `${userId}:${mutation.p_operation_id}`;
      const replay = state.noteReplays.get(replayKey);
      if (replay) {
        const response = replay.fingerprint === fingerprint
          ? replay.response
          : { status: 409 as const, code: "IDEMPOTENCY_KEY_REUSED" as const };
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) });
        return;
      }

      if (
        mutation.p_entity_id === null ||
        mutation.p_note === null ||
        mutation.p_updated_at === null ||
        mutation.p_expected_sync_version === null ||
        mutation.p_expected_sync_version < 0 ||
        exceedsCodePointLimit(mutation.p_note, 200_000)
      ) {
        const response = { status: 400 as const, code: "INVALID_REQUEST" as const };
        state.noteReplays.set(replayKey, { fingerprint, response });
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) });
        return;
      }

      const meeting = state.meetings.find((candidate) => candidate.id === mutation.p_entity_id);
      if (!meeting) {
        const response = { status: 404 as const, code: "MEETING_NOT_FOUND" as const };
        state.noteReplays.set(replayKey, { fingerprint, response });
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) });
        return;
      }
      if (meeting.sync_version !== mutation.p_expected_sync_version) {
        const response = { status: 409 as const, code: "CONFLICT" as const };
        state.noteReplays.set(replayKey, { fingerprint, response });
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) });
        return;
      }

      meeting.note = mutation.p_note;
      meeting.updated_at = new Date(mutation.p_updated_at).toISOString();
      meeting.sync_version += 1;
      const response = { status: 200 as const, meeting: ownedMeeting(meeting) };
      state.noteReplays.set(replayKey, { fingerprint, response });
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) });
      return;
    }
    if (url.pathname === "/rest/v1/folders") {
      await route.fulfill({ contentType: "application/json", body: "[]" });
      return;
    }
    if (url.pathname === "/rest/v1/meetings") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(state.meetings.map(ownedMeeting)) });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "E2E route not configured" }) });
  });
}

export async function removeSupabaseRoutes(page: Page): Promise<void> {
  await page.unroute(`${supabaseOrigin}/**`);
}

export async function openCatalog(page: Page, input: RemoteMeeting[] | SupabaseFixtureState = [], appPath = "/"): Promise<void> {
  await installSupabaseRoutes(page, input);
  await page.goto(appPath);
  await page.getByLabel("邮箱").fill("owner@example.com");
  await page.getByLabel("密码").fill("e2e-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "会议本", exact: true })).toBeVisible();
}

export function offlineMeeting(): RemoteMeeting {
  return { ...defaultMeeting };
}
