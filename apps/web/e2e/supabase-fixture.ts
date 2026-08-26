import { createHash } from "node:crypto";

import { InkStrokeSchema, type InkStroke } from "@meeting/contracts";
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

export type MeetingInkMutation = {
  p_mutation_id: string;
  p_stroke: InkStroke;
  p_expected_user_id: string;
};

export type RemoteInkStroke = {
  user_id: string;
  id: InkStroke["id"];
  meeting_id: InkStroke["meetingId"];
  stroke_order: InkStroke["order"];
  tool: InkStroke["tool"];
  color: InkStroke["color"];
  width: InkStroke["width"];
  points: InkStroke["points"];
  version: InkStroke["version"];
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
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
  inkStrokes: RemoteInkStroke[];
  inkMutations: MeetingInkMutation[];
  inkReplays: Map<string, InkStroke>;
  audioChunks: RemoteAudioChunk[];
  audioObjects: Map<string, RemoteAudioObject>;
  audioObjectUploads: string[];
};

export type RemoteAudioChunk = {
  user_id: string;
  meeting_id: string;
  sequence: number;
  bucket_id: "meeting-audio";
  remote_path: string;
  sha256: string;
  size_bytes: number;
  mime_type: string;
  captured_at: string;
  expires_at: string;
  created_at: string;
};

export type RemoteAudioObject = {
  path: string;
  sha256: string | null;
  size: number;
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

function hasValidBearer(value: string | undefined, accessToken: string): boolean {
  return /^Bearer\s+(\S+)$/i.exec(value ?? "")?.[1] === accessToken;
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

function parseInkMutation(value: unknown): MeetingInkMutation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = ["p_mutation_id", "p_stroke", "p_expected_user_id"];
  if (Object.keys(body).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(body, key))) return null;
  if (!isUuid(body.p_mutation_id) || !isUuid(body.p_expected_user_id)) return null;
  const stroke = InkStrokeSchema.safeParse(body.p_stroke);
  return stroke.success ? { p_mutation_id: body.p_mutation_id, p_stroke: stroke.data, p_expected_user_id: body.p_expected_user_id } : null;
}

function canonicalInkStroke(row: RemoteInkStroke): InkStroke {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    order: row.stroke_order,
    tool: row.tool,
    color: row.color,
    width: row.width,
    points: row.points,
    deleted: row.deleted_at !== null,
    version: row.version,
  };
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

function multipartParts(contentType: string | undefined, body: Buffer): Map<string, Buffer> {
  const boundary = contentType?.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean)?.trim();
  if (!boundary || boundary.includes("\r") || boundary.includes("\n")) return new Map();
  const source = body.toString("latin1");
  const delimiter = `--${boundary}`;
  const parts = new Map<string, Buffer>();
  if (!source.startsWith(`${delimiter}\r\n`)) return parts;
  let cursor = delimiter.length + 2;
  let closed = false;
  while (!closed) {
    const headersEnd = source.indexOf("\r\n\r\n", cursor);
    if (headersEnd < cursor) return new Map();
    const fieldName = source.slice(cursor, headersEnd).match(/name="([^"]*)"/i)?.[1];
    if (fieldName === undefined || parts.has(fieldName)) return new Map();
    const dataStart = headersEnd + 4;
    let searchFrom = dataStart;
    let dataEnd = -1;
    let nextCursor = -1;
    while (true) {
      const candidate = source.indexOf(`\r\n${delimiter}`, searchFrom);
      if (candidate < 0) return new Map();
      const suffix = candidate + 2 + delimiter.length;
      if (source.startsWith("\r\n", suffix)) {
        dataEnd = candidate;
        nextCursor = suffix + 2;
        break;
      }
      if (source.startsWith("--", suffix)) {
        const closingEnd = suffix + 2;
        if (closingEnd === source.length || (source.startsWith("\r\n", closingEnd) && closingEnd + 2 === source.length)) {
          dataEnd = candidate;
          closed = true;
          break;
        }
      }
      searchFrom = candidate + 2;
    }
    parts.set(fieldName, body.subarray(dataStart, dataEnd));
    if (!closed) cursor = nextCursor;
  }
  return parts;
}

function storageUpload(request: { headers(): Record<string, string>; postDataBuffer(): Buffer | null }): {
  sha256: string;
  size: number;
} | null {
  const headers = request.headers();
  const body = request.postDataBuffer();
  if (!body) return null;
  const parts = multipartParts(headers["content-type"], body);
  const metadataPart = parts.get("metadata");
  const filePart = parts.get("");
  if (!metadataPart || !filePart) return null;
  try {
    const metadata = JSON.parse(metadataPart.toString("utf8")) as { sha256?: unknown };
    if (typeof metadata.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(metadata.sha256)) return null;
    if (createHash("sha256").update(filePart).digest("hex") !== metadata.sha256) return null;
    return { sha256: metadata.sha256, size: filePart.byteLength };
  } catch {
    return null;
  }
}

function parseAudioChunkInsert(value: unknown, state: SupabaseFixtureState): Omit<RemoteAudioChunk, "bucket_id" | "created_at"> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = [
    "user_id", "meeting_id", "sequence", "remote_path", "sha256", "size_bytes", "mime_type", "captured_at", "expires_at",
  ];
  if (Object.keys(body).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(body, key))) return null;
  if (!isUuid(body.user_id) || !isUuid(body.meeting_id)) return null;
  if (!Number.isInteger(body.sequence) || (body.sequence as number) < 0) return null;
  if (typeof body.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.sha256)) return null;
  if (!Number.isInteger(body.size_bytes) || (body.size_bytes as number) <= 0) return null;
  if (typeof body.mime_type !== "string" || body.mime_type.length === 0 || body.mime_type.length > 255) return null;
  if (typeof body.captured_at !== "string" || typeof body.expires_at !== "string") return null;
  const capturedAt = Date.parse(body.captured_at);
  const expiresAt = Date.parse(body.expires_at);
  if (!Number.isFinite(capturedAt) || !Number.isFinite(expiresAt) || expiresAt <= capturedAt) return null;
  if (!state.meetings.some((meeting) => meeting.id === body.meeting_id)) return null;
  const normalizedMime = body.mime_type.toLowerCase().split(";", 1)[0]?.trim();
  const extension = normalizedMime === "audio/webm" ? "webm" : normalizedMime === "audio/mp4" ? "m4a" : "bin";
  const expectedPath = `${body.user_id}/${body.meeting_id}/${body.sequence}.${extension}`;
  if (body.remote_path !== expectedPath) return null;
  const object = state.audioObjects.get(expectedPath);
  if (!object || object.sha256 !== body.sha256 || object.size !== body.size_bytes) return null;
  return body as Omit<RemoteAudioChunk, "bucket_id" | "created_at">;
}

export function createSupabaseFixtureState(meetings: RemoteMeeting[] = []): SupabaseFixtureState {
  return {
    meetings,
    noteMutations: [],
    noteReplays: new Map(),
    noteMutationBarrier: null,
    inkStrokes: [],
    inkMutations: [],
    inkReplays: new Map(),
    audioChunks: [],
    audioObjects: new Map(),
    audioObjectUploads: [],
  };
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

export async function installSupabaseRoutes(page: Page, input: RemoteMeeting[] | SupabaseFixtureState = []): Promise<string> {
  const state = fixtureState(input);
  const expiresAt = 4_102_444_800;
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
    if (url.pathname === "/rest/v1/rpc/apply_meeting_ink_mutation") {
      if (!hasValidBearer(request.headers().authorization, accessToken)) {
        await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "42501", message: "Unauthorized" }) });
        return;
      }
      let rawBody: unknown;
      try {
        rawBody = request.postDataJSON();
      } catch {
        rawBody = null;
      }
      const unparsed = typeof rawBody === "object" && rawBody !== null && !Array.isArray(rawBody)
        ? rawBody as Record<string, unknown>
        : null;
      if (unparsed?.p_expected_user_id !== userId) {
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "P0001", message: "AUTH_REQUIRED" }) });
        return;
      }
      const mutation = parseInkMutation(rawBody);
      if (mutation) state.inkMutations.push(structuredClone(mutation));
      const replayKey = typeof unparsed?.p_mutation_id === "string" ? `${userId}:${unparsed.p_mutation_id}` : "";
      const replay = replayKey ? state.inkReplays.get(replayKey) : undefined;
      if (replay) {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(replay) });
        return;
      }
      const meeting = mutation && state.meetings.find((candidate) => candidate.id === mutation.p_stroke.meetingId && candidate.status !== "trashed");
      if (!mutation || !meeting) {
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "P0001", message: "INVALID_INK_STROKE" }) });
        return;
      }
      const stroke = mutation.p_stroke;
      let row = state.inkStrokes.find((candidate) => candidate.user_id === userId && candidate.id === stroke.id);
      if (!row || stroke.version >= row.version) {
        const timestamp = new Date().toISOString();
        const next: RemoteInkStroke = {
          user_id: userId,
          id: stroke.id,
          meeting_id: stroke.meetingId,
          stroke_order: stroke.order,
          tool: stroke.tool,
          color: stroke.color.toLowerCase(),
          width: stroke.width,
          points: structuredClone(stroke.points),
          version: stroke.version,
          deleted_at: stroke.deleted ? timestamp : null,
          created_at: row?.created_at ?? timestamp,
          updated_at: timestamp,
        };
        if (row) state.inkStrokes[state.inkStrokes.indexOf(row)] = next;
        else state.inkStrokes.push(next);
        row = next;
      }
      const response = canonicalInkStroke(row);
      state.inkReplays.set(replayKey, response);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) });
      return;
    }
    if (url.pathname === "/rest/v1/folders") {
      await route.fulfill({ contentType: "application/json", body: "[]" });
      return;
    }
    if (url.pathname === "/rest/v1/meeting_ink_strokes" && request.method() === "GET") {
      if (!hasValidBearer(request.headers().authorization, accessToken)) {
        await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "42501", message: "Unauthorized" }) });
        return;
      }
      const meetingId = url.searchParams.get("meeting_id")?.replace(/^eq\./, "") ?? null;
      const rows = state.inkStrokes
        .filter((row) => row.user_id === userId && row.meeting_id === meetingId)
        .sort((left, right) => left.stroke_order - right.stroke_order)
        .map((row) => ({
          id: row.id,
          meeting_id: row.meeting_id,
          stroke_order: row.stroke_order,
          tool: row.tool,
          color: row.color,
          width: row.width,
          points: row.points,
          version: row.version,
          deleted_at: row.deleted_at,
        }));
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(rows) });
      return;
    }
    if (url.pathname === "/rest/v1/meeting_audio_chunks" && request.method() === "GET") {
      const filter = (name: string) => url.searchParams.get(name)?.replace(/^eq\./, "") ?? null;
      const sequence = Number(filter("sequence"));
      const row = state.audioChunks.find((candidate) => candidate.user_id === filter("user_id")
        && candidate.meeting_id === filter("meeting_id") && candidate.sequence === sequence);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(row ? [row] : []),
      });
      return;
    }
    if (url.pathname === "/rest/v1/meeting_audio_chunks" && request.method() === "POST") {
      let rawBody: unknown;
      try {
        rawBody = request.postDataJSON();
      } catch {
        rawBody = null;
      }
      const claimedUserId = typeof rawBody === "object" && rawBody !== null && !Array.isArray(rawBody)
        ? (rawBody as Record<string, unknown>).user_id
        : null;
      if (!/^Bearer\s+\S+$/i.test(request.headers().authorization ?? "") || claimedUserId !== userId) {
        await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "42501", message: "Unauthorized" }) });
        return;
      }
      const body = parseAudioChunkInsert(rawBody, state);
      if (!body) {
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "22023", message: "Invalid audio metadata" }) });
        return;
      }
      const conflict = state.audioChunks.some((candidate) => candidate.user_id === body.user_id
        && candidate.meeting_id === body.meeting_id && candidate.sequence === body.sequence);
      if (conflict) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ code: "23505", message: "duplicate key value violates unique constraint" }),
        });
        return;
      }
      const row: RemoteAudioChunk = {
        ...body,
        bucket_id: "meeting-audio",
        created_at: new Date().toISOString(),
      };
      state.audioChunks.push(row);
      await route.fulfill({ status: 201, body: "" });
      return;
    }
    if (url.pathname === "/storage/v1/object/list/meeting-audio" && request.method() === "POST") {
      const body = request.postDataJSON() as { prefix?: string; search?: string };
      const prefix = body.prefix ? `${body.prefix.replace(/\/$/, "")}/` : "";
      const objects = Array.from(state.audioObjects.values())
        .filter((object) => object.path.startsWith(prefix))
        .filter((object) => !body.search || object.path.slice(prefix.length) === body.search)
        .map((object) => ({
          id: object.path,
          name: object.path.slice(prefix.length),
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
          last_accessed_at: new Date(0).toISOString(),
          metadata: { sha256: object.sha256, size: object.size },
        }));
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(objects) });
      return;
    }
    const objectPrefix = "/storage/v1/object/meeting-audio/";
    if (url.pathname.startsWith(objectPrefix) && request.method() === "POST") {
      const path = decodeURIComponent(url.pathname.slice(objectPrefix.length));
      if (state.audioObjects.has(path)) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }),
        });
        return;
      }
      const upload = storageUpload(request);
      if (!upload) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ statusCode: "400", error: "Invalid multipart upload", message: "Missing audio metadata or file" }),
        });
        return;
      }
      state.audioObjects.set(path, { path, sha256: upload.sha256, size: upload.size });
      state.audioObjectUploads.push(path);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ Id: path, Key: `meeting-audio/${path}` }),
      });
      return;
    }
    if (url.pathname === "/rest/v1/meetings") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(state.meetings.map(ownedMeeting)) });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "E2E route not configured" }) });
  });
  return accessToken;
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
