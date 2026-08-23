import type { Folder, Meeting } from "@meeting/contracts";

import type { OutboxOperation } from "./local-db.js";
import { MeetingCatalogRepository } from "./repository.js";

export interface MeetingCatalogApi {
  send(operation: OutboxOperation, expectedUserId: string): Promise<{ meeting?: Meeting; folder?: Folder }>;
  pull?(expectedUserId: string): Promise<{ folders: Folder[]; meetings: Meeting[] }>;
  listMeetings(expectedUserId?: string): Promise<Meeting[]>;
  listFolders(expectedUserId?: string): Promise<Folder[]>;
}

export type SyncResult = { state: "idle" | "paused_auth" | "conflict" | "error" };
type SyncRequestKind = "flush" | "refresh";
type SyncTask = { kind: SyncRequestKind; epoch: number; started: boolean; promise: Promise<SyncResult> };

export class CatalogApiError extends Error {
  constructor(public readonly status: number, public readonly code?: string) {
    super(code ?? `Catalog API request failed with status ${status}`);
    this.name = "CatalogApiError";
  }
}

function statusOf(error: unknown): number | undefined {
  return error instanceof CatalogApiError ? error.status : undefined;
}

function hasExpectedSyncVersion(operation: OutboxOperation): boolean {
  return typeof operation.payload === "object" && operation.payload !== null && Object.prototype.hasOwnProperty.call(operation.payload, "expectedSyncVersion");
}

function isTypedNotFoundConflict(operation: OutboxOperation, error: unknown): boolean {
  if (!(error instanceof CatalogApiError) || error.status !== 404) return false;
  if (operation.kind === "meeting.create") {
    const folderId = typeof operation.payload === "object" && operation.payload !== null && "folderId" in operation.payload
      ? operation.payload.folderId
      : null;
    return typeof folderId === "string" && error.code === "FOLDER_NOT_FOUND";
  }
  if (!hasExpectedSyncVersion(operation)) return false;
  if (operation.kind === "folder.rename") return error.code === "FOLDER_NOT_FOUND";
  if (operation.kind === "meeting.rename" || operation.kind === "meeting.trash" || operation.kind === "meeting.restore") {
    return error.code === "MEETING_NOT_FOUND";
  }
  return false;
}

export class CatalogSync {
  private queue: Promise<void> = Promise.resolve();
  private currentTask: SyncTask | undefined;
  private authPaused = false;
  private authEpoch = 0;

  constructor(private readonly repository: MeetingCatalogRepository, private readonly api: MeetingCatalogApi) {}

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const queued = this.queue.then(work, work);
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private request(kind: SyncRequestKind): Promise<SyncResult> {
    const epoch = this.authEpoch;
    const current = this.currentTask;
    if (current?.epoch === epoch) {
      if (current.kind === kind) return current.promise;
      return this.startTask(kind, epoch, current).promise;
    }
    if (this.authPaused) return Promise.resolve({ state: "paused_auth" });
    return this.startTask(kind, epoch).promise;
  }

  private startTask(kind: SyncRequestKind, epoch: number, predecessor?: SyncTask): SyncTask {
    let task!: SyncTask;
    const promise = this.enqueue<SyncResult>(async () => {
      task.started = true;
      if (predecessor) {
        const result = await predecessor.promise;
        if (result.state !== "idle") return result;
      }
      const expectedUserId = this.repository.currentUserId();
      if (!expectedUserId) return { state: "paused_auth" };
      return kind === "flush" ? this.flushInternal(epoch, expectedUserId) : this.refreshInternal(epoch, expectedUserId);
    });
    task = { kind, epoch, started: false, promise };
    this.currentTask = task;
    const clear = () => {
      if (this.currentTask === task) this.currentTask = undefined;
    };
    void promise.then(clear, clear);
    return task;
  }

  flush(): Promise<SyncResult> {
    return this.request("flush");
  }

  resumeAfterLogin(): void {
    this.authEpoch += 1;
    this.authPaused = false;
  }

  pauseForUserChange(): void {
    this.authEpoch += 1;
    this.authPaused = true;
  }

  private isStale(epoch: number): boolean {
    return epoch !== this.authEpoch || this.authPaused;
  }

  private async flushInternal(epoch: number, expectedUserId: string): Promise<SyncResult> {
    if (this.isStale(epoch)) return { state: "paused_auth" };
    const operations = await this.repository.pendingOperations();
    if (this.isStale(epoch)) return { state: "paused_auth" };
    for (const operation of operations) {
      if (this.isStale(epoch)) return { state: "paused_auth" };
      try {
        const response = await this.api.send(operation, expectedUserId);
        await this.repository.syncApplySuccessfulOperation(operation, response);
        if (this.isStale(epoch)) return { state: "paused_auth" };
      } catch (error) {
        if (this.isStale(epoch)) return { state: "paused_auth" };
        const status = statusOf(error);
        if (status === 401) {
          if (epoch === this.authEpoch) this.authPaused = true;
          await this.repository.syncRecordFailure(operation, "AUTH_REQUIRED");
          return { state: "paused_auth" };
        }
        if (status === 409) {
          await this.repository.syncRecordFailure(operation, "CONFLICT");
          return { state: "conflict" };
        }
        if (operation.kind === "folder.remove" && status === 404 && error instanceof CatalogApiError && error.code === "FOLDER_NOT_FOUND") {
          await this.repository.syncApplySuccessfulOperation(operation, {});
          if (this.isStale(epoch)) return { state: "paused_auth" };
          continue;
        }
        if (isTypedNotFoundConflict(operation, error)) {
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

  scheduleRefresh(): Promise<SyncResult> {
    const epoch = this.authEpoch;
    const current = this.currentTask;
    if (current?.epoch === epoch && current.kind === "refresh") {
      if (!current.started) return current.promise;
      return this.startTask("refresh", epoch, current).promise;
    }
    return this.request("refresh");
  }

  private async refreshInternal(epoch: number, expectedUserId: string): Promise<SyncResult> {
    const flushed = await this.flushInternal(epoch, expectedUserId);
    if (flushed.state !== "idle") return flushed;
    if (this.isStale(epoch)) return { state: "paused_auth" };
    try {
      const { folders, meetings } = this.api.pull
        ? await this.api.pull(expectedUserId)
        : await Promise.all([this.api.listFolders(expectedUserId), this.api.listMeetings(expectedUserId)])
          .then(([folders, meetings]) => ({ folders, meetings }));
      if (this.isStale(epoch)) return { state: "paused_auth" };
      await this.repository.syncRefresh(folders, meetings);
      if (this.isStale(epoch)) return { state: "paused_auth" };
      return { state: "idle" };
    } catch (error) {
      if (this.isStale(epoch)) return { state: "paused_auth" };
      if (statusOf(error) === 401) {
        if (epoch === this.authEpoch) this.authPaused = true;
        return { state: "paused_auth" };
      }
      return { state: "error" };
    }
  }
}
