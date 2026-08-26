import type { InkStroke } from "@meeting/contracts";
import type { LocalInkMutation } from "../meetings/local-db.js";

type RepositoryPort = {
  pending(): Promise<LocalInkMutation[]>;
  acceptAcknowledged(stroke: InkStroke, mutationId: string): Promise<void>;
  acceptRemote(stroke: InkStroke): Promise<void>;
};

export type InkApiPort = {
  apply(mutation: LocalInkMutation, expectedUserId: string): Promise<InkStroke>;
  list(meetingId: string): Promise<InkStroke[]>;
};

export type InkSyncState = "idle" | "paused_auth" | "error";

export type InkSynchronizer = {
  flush(): Promise<InkSyncState>;
  refresh(meetingId: string): Promise<InkSyncState>;
  pauseForUserChange(): void;
  resumeAfterLogin(userId: string): void;
};

export class InkSync implements InkSynchronizer {
  private queue: Promise<void> = Promise.resolve();
  private authEpoch = 0;
  private activeUserId: string | null = null;

  constructor(private readonly repository: RepositoryPort, private readonly api: InkApiPort) {}

  private enqueue(work: () => Promise<InkSyncState>): Promise<InkSyncState> {
    const result = this.queue.then(work, work);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  pauseForUserChange(): void {
    this.authEpoch += 1;
    this.activeUserId = null;
  }

  resumeAfterLogin(userId: string): void {
    this.authEpoch += 1;
    this.activeUserId = userId;
  }

  private stale(epoch: number, userId: string): boolean {
    return epoch !== this.authEpoch || this.activeUserId !== userId;
  }

  flush(): Promise<InkSyncState> {
    const epoch = this.authEpoch;
    const userId = this.activeUserId;
    if (!userId) return Promise.resolve("paused_auth");
    return this.enqueue(async () => {
      try {
        if (this.stale(epoch, userId)) return "paused_auth";
        for (const mutation of await this.repository.pending()) {
          if (this.stale(epoch, userId)) return "paused_auth";
          const canonical = await this.api.apply(mutation, userId);
          if (this.stale(epoch, userId)) return "paused_auth";
          await this.repository.acceptAcknowledged(canonical, mutation.mutationId);
        }
        return "idle";
      } catch {
        return "error";
      }
    });
  }

  refresh(meetingId: string): Promise<InkSyncState> {
    const epoch = this.authEpoch;
    const userId = this.activeUserId;
    if (!userId) return Promise.resolve("paused_auth");
    return this.enqueue(async () => {
      try {
        if (this.stale(epoch, userId)) return "paused_auth";
        for (const mutation of await this.repository.pending()) {
          if (this.stale(epoch, userId)) return "paused_auth";
          const canonical = await this.api.apply(mutation, userId);
          if (this.stale(epoch, userId)) return "paused_auth";
          await this.repository.acceptAcknowledged(canonical, mutation.mutationId);
        }
        const remote = await this.api.list(meetingId);
        if (this.stale(epoch, userId)) return "paused_auth";
        for (const stroke of remote) {
          if (this.stale(epoch, userId)) return "paused_auth";
          await this.repository.acceptRemote(stroke);
        }
        return "idle";
      } catch {
        return "error";
      }
    });
  }
}
