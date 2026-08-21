import type { Folder, Meeting } from "@meeting/contracts";

import type { OutboxOperation } from "./local-db.js";
import { MeetingCatalogRepository } from "./repository.js";

export interface MeetingCatalogApi {
  send(operation: OutboxOperation): Promise<{ meeting?: Meeting; folder?: Folder }>;
  listMeetings(): Promise<Meeting[]>;
  listFolders(): Promise<Folder[]>;
}

export type SyncResult = { state: "idle" | "paused_auth" | "conflict" | "error" };

export class CatalogApiError extends Error {
  constructor(public readonly status: number, public readonly code?: string) {
    super(code ?? `Catalog API request failed with status ${status}`);
    this.name = "CatalogApiError";
  }
}

function statusOf(error: unknown): number | undefined {
  return error instanceof CatalogApiError ? error.status : undefined;
}

export class CatalogSync {
  private queue: Promise<void> = Promise.resolve();
  private flushPromise: Promise<SyncResult> | undefined;
  private refreshPromise: Promise<SyncResult> | undefined;
  private authPaused = false;

  constructor(private readonly repository: MeetingCatalogRepository, private readonly api: MeetingCatalogApi) {}

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const queued = this.queue.then(work, work);
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  flush(): Promise<SyncResult> {
    if (this.authPaused) return Promise.resolve({ state: "paused_auth" });
    if (!this.flushPromise) {
      this.flushPromise = this.enqueue(() => this.flushInternal()).finally(() => { this.flushPromise = undefined; });
    }
    return this.flushPromise;
  }

  resumeAfterLogin(): void {
    this.authPaused = false;
  }

  private async flushInternal(): Promise<SyncResult> {
    if (this.authPaused) return { state: "paused_auth" };
    const operations = await this.repository.pendingOperations();
    for (const operation of operations) {
      try {
        const response = await this.api.send(operation);
        await this.repository.syncApplySuccessfulOperation(operation, response);
      } catch (error) {
        const status = statusOf(error);
        if (status === 401) {
          this.authPaused = true;
          await this.repository.syncRecordFailure(operation, "AUTH_REQUIRED");
          return { state: "paused_auth" };
        }
        if (status === 409) {
          await this.repository.syncRecordFailure(operation, "CONFLICT");
          return { state: "conflict" };
        }
        await this.repository.syncRecordFailure(operation, "SYNC_FAILED");
        return { state: "error" };
      }
    }
    return { state: "idle" };
  }

  refresh(): Promise<SyncResult> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.enqueue(() => this.refreshInternal()).finally(() => { this.refreshPromise = undefined; });
    }
    return this.refreshPromise;
  }

  private async refreshInternal(): Promise<SyncResult> {
    const flushed = await this.flushInternal();
    if (flushed.state !== "idle") return flushed;
    try {
      const [folders, meetings] = await Promise.all([this.api.listFolders(), this.api.listMeetings()]);
      await this.repository.syncRefresh(folders, meetings);
      return { state: "idle" };
    } catch {
      return { state: "error" };
    }
  }
}
