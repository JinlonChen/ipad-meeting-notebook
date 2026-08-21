import type { Folder, Meeting } from "@meeting/contracts";

import type { OutboxOperation } from "./local-db.js";
import { MeetingCatalogRepository } from "./repository.js";

export interface MeetingCatalogApi {
  send(operation: OutboxOperation): Promise<{ meeting?: Meeting; folder?: Folder }>;
  listMeetings(): Promise<Meeting[]>;
  listFolders(): Promise<Folder[]>;
}

export type SyncResult = { state: "idle" | "paused_auth" | "conflict" | "error" };
type SyncRequestKind = "flush" | "refresh";
type SyncTask = { kind: SyncRequestKind; promise: Promise<SyncResult> };

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
  private currentTask: SyncTask | undefined;
  private authPaused = false;

  constructor(private readonly repository: MeetingCatalogRepository, private readonly api: MeetingCatalogApi) {}

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const queued = this.queue.then(work, work);
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private request(kind: SyncRequestKind): Promise<SyncResult> {
    const current = this.currentTask;
    if (current) {
      if (current.kind === kind) return current.promise;
      return this.startTask(kind, current);
    }
    if (this.authPaused) return Promise.resolve({ state: "paused_auth" });
    return this.startTask(kind);
  }

  private startTask(kind: SyncRequestKind, predecessor?: SyncTask): Promise<SyncResult> {
    const promise = this.enqueue(async () => {
      if (predecessor) {
        const result = await predecessor.promise;
        if (result.state !== "idle") return result;
      }
      return kind === "flush" ? this.flushInternal() : this.refreshInternal();
    });
    const task: SyncTask = { kind, promise };
    this.currentTask = task;
    const clear = () => {
      if (this.currentTask === task) this.currentTask = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }

  flush(): Promise<SyncResult> {
    return this.request("flush");
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
    return this.request("refresh");
  }

  private async refreshInternal(): Promise<SyncResult> {
    const flushed = await this.flushInternal();
    if (flushed.state !== "idle") return flushed;
    try {
      const [folders, meetings] = await Promise.all([this.api.listFolders(), this.api.listMeetings()]);
      await this.repository.syncRefresh(folders, meetings);
      return { state: "idle" };
    } catch (error) {
      if (statusOf(error) === 401) {
        this.authPaused = true;
        return { state: "paused_auth" };
      }
      return { state: "error" };
    }
  }
}
