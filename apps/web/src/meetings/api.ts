import { CreateFolderInputSchema, CreateMeetingInputSchema, FolderMutationBodySchema, FolderRenameBodySchema, FolderSchema, LegacyFolderRenameBodySchema, LegacyMeetingPatchBodySchema, MeetingMutationBodySchema, MeetingPatchBodySchema, MeetingSchema, type Folder, type Meeting } from "@meeting/contracts";
import { z } from "zod";

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

  async send(operation: OutboxOperation): Promise<{ meeting?: Meeting; folder?: Folder }> {
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

  async listMeetings(): Promise<Meeting[]> {
    try {
      return await parsed(this.fetcher("/api/meetings?includeTrashed=true", { credentials: "include" }), z.array(MeetingSchema));
    } catch (error) {
      throw normalizedFailure(error);
    }
  }

  async listFolders(): Promise<Folder[]> {
    try {
      return await parsed(this.fetcher("/api/folders", { credentials: "include" }), z.array(FolderSchema));
    } catch (error) {
      throw normalizedFailure(error);
    }
  }
}
