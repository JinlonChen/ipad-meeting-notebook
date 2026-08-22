import { CreateFolderInputSchema, CreateMeetingInputSchema, FolderMutationBodySchema, FolderRenameBodySchema, FolderSchema, MeetingMutationBodySchema, MeetingPatchBodySchema, MeetingSchema, type Folder, type Meeting } from "@meeting/contracts";
import { z } from "zod";

import { CatalogApiError, type MeetingCatalogApi } from "./sync.js";
import type { OutboxOperation } from "./local-db.js";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function failure(response: Response): CatalogApiError {
  if (response.status === 401) return new CatalogApiError(401, "AUTH_REQUIRED");
  if (response.status === 409) return new CatalogApiError(409, "CONFLICT");
  return new CatalogApiError(response.status, "REQUEST_FAILED");
}

function normalizedFailure(error: unknown, status = 0): CatalogApiError {
  return error instanceof CatalogApiError ? error : new CatalogApiError(status, "REQUEST_FAILED");
}

async function parsed<T>(request: Promise<Response>, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await request;
  } catch (error) {
    throw normalizedFailure(error);
  }
  if (!response.ok) throw failure(response);
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
      case "meeting.create":
        return { meeting: await parsed(this.fetcher("/api/meetings", init("POST", CreateMeetingInputSchema.parse(operation.payload))), MeetingSchema) };
      case "meeting.rename":
        { const payload = z.object({ title: z.unknown(), expectedSyncVersion: z.unknown() }).passthrough().parse(operation.payload); return { meeting: await parsed(this.fetcher(`/api/meetings/${operation.entityId}`, init("PATCH", MeetingPatchBodySchema.parse({ title: payload.title, expectedSyncVersion: payload.expectedSyncVersion }))), MeetingSchema) }; }
      case "meeting.trash":
        { const payload = z.object({ expectedSyncVersion: z.unknown() }).passthrough().parse(operation.payload); return { meeting: await parsed(this.fetcher(`/api/meetings/${operation.entityId}`, init("DELETE", MeetingMutationBodySchema.parse({ expectedSyncVersion: payload.expectedSyncVersion }))), MeetingSchema) }; }
      case "meeting.restore":
        { const payload = z.object({ expectedSyncVersion: z.unknown() }).passthrough().parse(operation.payload); return { meeting: await parsed(this.fetcher(`/api/meetings/${operation.entityId}/restore`, init("POST", MeetingMutationBodySchema.parse({ expectedSyncVersion: payload.expectedSyncVersion }))), MeetingSchema) }; }
      case "folder.create":
        return { folder: await parsed(this.fetcher("/api/folders", init("POST", CreateFolderInputSchema.parse(operation.payload))), FolderSchema) };
      case "folder.rename":
        { const payload = z.object({ name: z.unknown(), expectedSyncVersion: z.unknown() }).passthrough().parse(operation.payload); return { folder: await parsed(this.fetcher(`/api/folders/${operation.entityId}`, init("PATCH", FolderRenameBodySchema.parse({ name: payload.name, expectedSyncVersion: payload.expectedSyncVersion }))), FolderSchema) }; }
      case "folder.remove": {
        const value = z.object({ expectedSyncVersion: z.unknown() }).passthrough().parse(operation.payload);
        const payload = FolderMutationBodySchema.parse({ expectedSyncVersion: value.expectedSyncVersion });
        const response = await this.fetcher(`/api/folders/${operation.entityId}`, init("DELETE", payload));
        if (response.status === 404) {
          try {
            const body = await response.clone().json() as { code?: unknown };
            if (body.code === "FOLDER_NOT_FOUND") return {};
          } catch { /* preserve non-JSON errors */ }
        }
        if (!response.ok) throw failure(response);
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
