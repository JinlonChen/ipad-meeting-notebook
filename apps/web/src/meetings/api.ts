import { CreateFolderInputSchema, CreateMeetingInputSchema, FolderMutationBodySchema, FolderRenameBodySchema, FolderSchema, LegacyFolderRenameBodySchema, LegacyMeetingPatchBodySchema, MeetingMutationBodySchema, MeetingPatchBodySchema, MeetingSchema, type Folder, type Meeting } from "@meeting/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "../supabase/types.js";
import { CatalogApiError, type MeetingCatalogApi } from "./sync.js";
import type { OutboxOperation } from "./local-db.js";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function hasExpectedSyncVersion(payload: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(payload, "expectedSyncVersion");
}

async function failure(response: Response, preservedCodes: readonly string[] = []): Promise<CatalogApiError> {
  if (response.status === 401) return new CatalogApiError(401, "AUTH_REQUIRED");
  if (response.status === 409) return new CatalogApiError(409, "CONFLICT");
  if (response.status === 404 && preservedCodes.length > 0) {
    try {
      const parsed = z.object({ code: z.string() }).safeParse(await response.clone().json());
      if (parsed.success && preservedCodes.includes(parsed.data.code)) return new CatalogApiError(404, parsed.data.code);
    } catch { /* preserve the generic failure for malformed responses */ }
  }
  return new CatalogApiError(response.status, "REQUEST_FAILED");
}

function normalizedFailure(error: unknown, status = 0): CatalogApiError {
  return error instanceof CatalogApiError ? error : new CatalogApiError(status, "REQUEST_FAILED");
}

async function parsed<T>(request: Promise<Response>, schema: z.ZodType<T>, preservedCodes: readonly string[] = []): Promise<T> {
  let response: Response;
  try {
    response = await request;
  } catch (error) {
    throw normalizedFailure(error);
  }
  if (!response.ok) throw await failure(response, preservedCodes);
  try {
    return schema.parse(await response.json());
  } catch (error) {
    throw normalizedFailure(error, response.status);
  }
}

export class MeetingCatalogHttpApi implements MeetingCatalogApi {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async send(operation: OutboxOperation, _expectedUserId?: string): Promise<{ meeting?: Meeting; folder?: Folder }> {
    const init = (method: string, body?: unknown): RequestInit => ({
      method,
      credentials: "include",
      headers: {
        "idempotency-key": operation.id,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try {
      switch (operation.kind) {
      case "meeting.create": {
        const payload = CreateMeetingInputSchema.parse(operation.payload);
        return { meeting: await parsed(this.fetcher("/api/meetings", init("POST", payload)), MeetingSchema, payload.folderId ? ["FOLDER_NOT_FOUND"] : []) };
      }
      case "meeting.rename": {
        const payload = z.object({ title: z.unknown() }).passthrough().parse(operation.payload);
        const body = hasExpectedSyncVersion(payload)
          ? MeetingPatchBodySchema.parse({ title: payload.title, expectedSyncVersion: payload.expectedSyncVersion })
          : LegacyMeetingPatchBodySchema.parse({ title: payload.title });
        return { meeting: await parsed(this.fetcher(`/api/meetings/${operation.entityId}`, init("PATCH", body)), MeetingSchema, hasExpectedSyncVersion(payload) ? ["MEETING_NOT_FOUND"] : []) };
      }
      case "meeting.trash": {
        const payload = z.object({}).passthrough().parse(operation.payload);
        const body = hasExpectedSyncVersion(payload)
          ? MeetingMutationBodySchema.parse({ expectedSyncVersion: payload.expectedSyncVersion })
          : undefined;
        return { meeting: await parsed(this.fetcher(`/api/meetings/${operation.entityId}`, init("DELETE", body)), MeetingSchema, hasExpectedSyncVersion(payload) ? ["MEETING_NOT_FOUND"] : []) };
      }
      case "meeting.restore": {
        const payload = z.object({}).passthrough().parse(operation.payload);
        const body = hasExpectedSyncVersion(payload)
          ? MeetingMutationBodySchema.parse({ expectedSyncVersion: payload.expectedSyncVersion })
          : undefined;
        return { meeting: await parsed(this.fetcher(`/api/meetings/${operation.entityId}/restore`, init("POST", body)), MeetingSchema, hasExpectedSyncVersion(payload) ? ["MEETING_NOT_FOUND"] : []) };
      }
      case "folder.create":
        return { folder: await parsed(this.fetcher("/api/folders", init("POST", CreateFolderInputSchema.parse(operation.payload))), FolderSchema) };
      case "folder.rename": {
        const payload = z.object({ name: z.unknown() }).passthrough().parse(operation.payload);
        const body = hasExpectedSyncVersion(payload)
          ? FolderRenameBodySchema.parse({ name: payload.name, expectedSyncVersion: payload.expectedSyncVersion })
          : LegacyFolderRenameBodySchema.parse({ name: payload.name });
        return { folder: await parsed(this.fetcher(`/api/folders/${operation.entityId}`, init("PATCH", body)), FolderSchema, hasExpectedSyncVersion(payload) ? ["FOLDER_NOT_FOUND"] : []) };
      }
      case "folder.remove": {
        const payload = z.object({}).passthrough().parse(operation.payload);
        const body = hasExpectedSyncVersion(payload)
          ? FolderMutationBodySchema.parse({ expectedSyncVersion: payload.expectedSyncVersion })
          : undefined;
        const response = await this.fetcher(`/api/folders/${operation.entityId}`, init("DELETE", body));
        if (response.status === 404) {
          try {
            const body = await response.clone().json() as { code?: unknown };
            if (body.code === "FOLDER_NOT_FOUND") return {};
          } catch { /* preserve non-JSON errors */ }
        }
        if (!response.ok) throw await failure(response);
        return {};
      }
      }
    } catch (error) {
      throw normalizedFailure(error);
    }
  }

  async listMeetings(_expectedUserId?: string): Promise<Meeting[]> {
    try {
      return await parsed(this.fetcher("/api/meetings?includeTrashed=true", { credentials: "include" }), z.array(MeetingSchema));
    } catch (error) {
      throw normalizedFailure(error);
    }
  }

  async listFolders(_expectedUserId?: string): Promise<Folder[]> {
    try {
      return await parsed(this.fetcher("/api/folders", { credentials: "include" }), z.array(FolderSchema));
    } catch (error) {
      throw normalizedFailure(error);
    }
  }

  async pull(expectedUserId: string): Promise<{ folders: Folder[]; meetings: Meeting[] }> {
    const [folders, meetings] = await Promise.all([this.listFolders(expectedUserId), this.listMeetings(expectedUserId)]);
    return { folders, meetings };
  }
}

type SupabaseCatalogClient = Pick<SupabaseClient<Database>, "from" | "rpc">;

const RpcResultSchema = z.object({
  status: z.number().int().min(100).max(599),
  code: z.string().optional(),
  meeting: z.unknown().optional(),
  folder: z.unknown().optional(),
}).strict();
const SnapshotResultSchema = z.object({
  status: z.number().int().min(100).max(599),
  code: z.string().optional(),
  folders: z.array(z.unknown()).optional(),
  meetings: z.array(z.unknown()).optional(),
}).strict();
const OffsetIsoDateTimeSchema = z.iso.datetime({ offset: true });
const JsonSchema = z.json();

function record(input: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(input);
}

function canonicalTimestamp(input: unknown): string {
  return new Date(OffsetIsoDateTimeSchema.parse(input)).toISOString();
}

function nullableCanonicalTimestamp(input: unknown): string | null {
  return input === null ? null : canonicalTimestamp(input);
}

function contractFolder(row: unknown): Folder {
  const value = record(row);
  return FolderSchema.parse({
    id: value.id,
    name: value.name,
    createdAt: canonicalTimestamp(value.created_at),
    updatedAt: canonicalTimestamp(value.updated_at),
    syncVersion: value.sync_version,
  });
}

function contractMeeting(row: unknown): Meeting {
  const value = record(row);
  return MeetingSchema.parse({
    id: value.id,
    title: value.title,
    folderId: value.folder_id,
    status: value.status,
    startedAt: nullableCanonicalTimestamp(value.started_at),
    endedAt: nullableCanonicalTimestamp(value.ended_at),
    createdAt: canonicalTimestamp(value.created_at),
    updatedAt: canonicalTimestamp(value.updated_at),
    trashedAt: nullableCanonicalTimestamp(value.trashed_at),
    syncVersion: value.sync_version,
  });
}

function supabaseFailure(error: unknown, responseStatus?: unknown): CatalogApiError {
  const parsedResponseStatus = z.number().int().nonnegative().safeParse(responseStatus);
  const parsedError = z.object({ status: z.number().int().nonnegative() }).passthrough().safeParse(error);
  const status = parsedResponseStatus.success ? parsedResponseStatus.data : parsedError.success ? parsedError.data.status : 0;
  return status === 401
    ? new CatalogApiError(401, "AUTH_REQUIRED")
    : new CatalogApiError(status, "REQUEST_FAILED");
}

function rpcFailure(status: number, code: string | undefined): CatalogApiError {
  if (status === 401) return new CatalogApiError(401, "AUTH_REQUIRED");
  if (status === 409 && (code === "CONFLICT" || code === "IDEMPOTENCY_KEY_REUSED")) {
    return new CatalogApiError(409, code);
  }
  if (status === 404 && (code === "FOLDER_NOT_FOUND" || code === "MEETING_NOT_FOUND")) {
    return new CatalogApiError(404, code);
  }
  return new CatalogApiError(status, "REQUEST_FAILED");
}

function assertRowsOwnedBy(rows: unknown[], expectedUserId: string | undefined): void {
  if (expectedUserId === undefined) return;
  const actor = z.uuid().parse(expectedUserId);
  for (const row of rows) {
    if (record(row).user_id !== actor) throw new CatalogApiError(401, "AUTH_REQUIRED");
  }
}

export class MeetingCatalogSupabaseApi implements MeetingCatalogApi {
  constructor(private readonly client: SupabaseCatalogClient) {}

  async send(operation: OutboxOperation, expectedUserId: string): Promise<{ meeting?: Meeting; folder?: Folder }> {
    try {
      const payload = JsonSchema.parse(operation.payload);
      if (typeof payload === "object" && payload !== null && !Array.isArray(payload) && Object.prototype.hasOwnProperty.call(payload, "expectedSyncVersion")) {
        z.number().int().nonnegative().parse(payload.expectedSyncVersion);
      }
      const { data, error, status } = await this.client.rpc("apply_catalog_mutation", {
        p_operation_id: operation.id,
        p_kind: operation.kind,
        p_entity_id: operation.entityId,
        p_payload: payload,
        p_expected_user_id: z.uuid().parse(expectedUserId),
      });
      if (error) throw supabaseFailure(error, status);

      const result = RpcResultSchema.parse(data);
      if (result.status < 200 || result.status >= 300) throw rpcFailure(result.status, result.code);

      if (operation.kind === "folder.remove") {
        if (result.meeting !== undefined || result.folder !== undefined) throw new CatalogApiError(500, "REQUEST_FAILED");
        return {};
      }
      if (operation.kind.startsWith("folder.")) {
        if (result.folder === undefined || result.meeting !== undefined) throw new CatalogApiError(500, "REQUEST_FAILED");
        return { folder: contractFolder(result.folder) };
      }
      if (result.meeting === undefined || result.folder !== undefined) throw new CatalogApiError(500, "REQUEST_FAILED");
      return { meeting: contractMeeting(result.meeting) };
    } catch (error) {
      if (error instanceof CatalogApiError) throw error;
      throw new CatalogApiError(error instanceof z.ZodError ? 500 : 0, "REQUEST_FAILED");
    }
  }

  async pull(expectedUserId: string): Promise<{ folders: Folder[]; meetings: Meeting[] }> {
    try {
      const actor = z.uuid().parse(expectedUserId);
      const { data, error, status } = await this.client.rpc("get_catalog_snapshot", { p_expected_user_id: actor });
      if (error) throw supabaseFailure(error, status);
      const result = SnapshotResultSchema.parse(data);
      if (result.status < 200 || result.status >= 300) throw rpcFailure(result.status, result.code);
      if (result.folders === undefined || result.meetings === undefined) throw new CatalogApiError(500, "REQUEST_FAILED");
      assertRowsOwnedBy(result.folders, actor);
      assertRowsOwnedBy(result.meetings, actor);
      const folders = z.array(FolderSchema).parse(result.folders.map(contractFolder));
      const meetings = z.array(MeetingSchema).parse(result.meetings.map(contractMeeting));
      return { folders, meetings };
    } catch (error) {
      if (error instanceof CatalogApiError) throw error;
      throw new CatalogApiError(error instanceof z.ZodError ? 500 : 0, "REQUEST_FAILED");
    }
  }

  async listMeetings(expectedUserId?: string): Promise<Meeting[]> {
    try {
      const { data, error, status } = await this.client
        .from("meetings")
        .select("user_id,id,title,folder_id,status,started_at,ended_at,created_at,updated_at,trashed_at,sync_version")
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true });
      if (error) throw supabaseFailure(error, status);
      if (!Array.isArray(data)) throw new CatalogApiError(500, "REQUEST_FAILED");
      assertRowsOwnedBy(data, expectedUserId);
      return z.array(MeetingSchema).parse(data.map(contractMeeting));
    } catch (error) {
      if (error instanceof CatalogApiError) throw error;
      throw new CatalogApiError(error instanceof z.ZodError ? 500 : 0, "REQUEST_FAILED");
    }
  }

  async listFolders(expectedUserId?: string): Promise<Folder[]> {
    try {
      const { data, error, status } = await this.client
        .from("folders")
        .select("user_id,id,name,created_at,updated_at,sync_version")
        .order("name", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw supabaseFailure(error, status);
      if (!Array.isArray(data)) throw new CatalogApiError(500, "REQUEST_FAILED");
      assertRowsOwnedBy(data, expectedUserId);
      return z.array(FolderSchema).parse(data.map(contractFolder));
    } catch (error) {
      if (error instanceof CatalogApiError) throw error;
      throw new CatalogApiError(error instanceof z.ZodError ? 500 : 0, "REQUEST_FAILED");
    }
  }
}
