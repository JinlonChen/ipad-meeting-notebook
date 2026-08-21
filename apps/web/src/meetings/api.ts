import { CreateFolderInputSchema, CreateMeetingInputSchema, FolderSchema, MeetingSchema, type Folder, type Meeting } from "@meeting/contracts";
import { z } from "zod";

import { CatalogApiError, type MeetingCatalogApi } from "./sync.js";
import type { OutboxOperation } from "./local-db.js";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function failure(response: Response): CatalogApiError {
  if (response.status === 401) return new CatalogApiError(401, "AUTH_REQUIRED");
  if (response.status === 409) return new CatalogApiError(409, "CONFLICT");
  return new CatalogApiError(response.status, "REQUEST_FAILED");
}

async function parsed<T>(request: Promise<Response>, schema: z.ZodType<T>): Promise<T> {
  const response = await request;
  if (!response.ok) throw failure(response);
  return schema.parse(await response.json());
}

export class MeetingCatalogHttpApi implements MeetingCatalogApi {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async send(operation: OutboxOperation): Promise<{ meeting?: Meeting; folder?: Folder }> {
    const init = (method: string, body?: unknown): RequestInit => ({
      method,
      credentials: "include",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    switch (operation.kind) {
      case "meeting.create":
        return { meeting: await parsed(this.fetcher("/api/meetings", init("POST", CreateMeetingInputSchema.parse(operation.payload))), MeetingSchema) };
      case "meeting.rename":
        return { meeting: await parsed(this.fetcher(`/api/meetings/${operation.entityId}`, init("PATCH", { title: z.object({ title: z.string() }).parse(operation.payload).title })), MeetingSchema) };
      case "meeting.trash":
        return { meeting: await parsed(this.fetcher(`/api/meetings/${operation.entityId}`, init("DELETE")), MeetingSchema) };
      case "meeting.restore":
        return { meeting: await parsed(this.fetcher(`/api/meetings/${operation.entityId}/restore`, init("POST")), MeetingSchema) };
      case "folder.create":
        return { folder: await parsed(this.fetcher("/api/folders", init("POST", CreateFolderInputSchema.parse(operation.payload))), FolderSchema) };
      case "folder.rename":
        return { folder: await parsed(this.fetcher(`/api/folders/${operation.entityId}`, init("PATCH", { name: z.object({ name: z.string() }).parse(operation.payload).name })), FolderSchema) };
      case "folder.remove": {
        const response = await this.fetcher(`/api/folders/${operation.entityId}`, init("DELETE"));
        if (!response.ok) throw failure(response);
        return {};
      }
    }
  }

  listMeetings(): Promise<Meeting[]> {
    return parsed(this.fetcher("/api/meetings?includeTrashed=true", { credentials: "include" }), z.array(MeetingSchema));
  }

  listFolders(): Promise<Folder[]> {
    return parsed(this.fetcher("/api/folders", { credentials: "include" }), z.array(FolderSchema));
  }
}
