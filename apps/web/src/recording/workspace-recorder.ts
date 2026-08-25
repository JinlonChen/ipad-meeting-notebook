import type { MeetingRecorderPort } from "./MeetingRecordingControls.js";
import type { RealtimeTranscriptionSnapshot, RealtimeTranscriptionUpdate } from "../transcription/browser-session.js";

type RecordingRepositoryPort = {
  deleteExpiredAudio(now: string): Promise<number>;
  recoverInterruptedSessions(): Promise<number>;
  session(meetingId: string): Promise<{ state: string } | null>;
  start(meetingId: string, now: string): Promise<unknown>;
  stop(meetingId: string, now: string): Promise<unknown>;
  completeRecovery(meetingId: string, now: string): Promise<unknown>;
  abortFailedStart(meetingId: string): Promise<unknown>;
  appendChunk(meetingId: string, blob: Blob, startedOffsetMs: number, endedOffsetMs: number, capturedAt: string): Promise<unknown>;
};

type ControllerPort = { start(): Promise<void>; stop(): Promise<void> };
type ControllerFactory = (options: {
  meetingId: string;
  persistChunk(blob: Blob, startedOffsetMs: number, endedOffsetMs: number): Promise<void>;
  onInterrupted(): Promise<void>;
  onTranscription(update: RealtimeTranscriptionUpdate): void;
}) => ControllerPort;

const EMPTY_TRANSCRIPTION: RealtimeTranscriptionSnapshot = { status: "idle", partial: "", revision: 0 };

export class WorkspaceRecorder implements MeetingRecorderPort {
  private active: { meetingId: string; controller: ControllerPort } | null = null;
  private readonly listeners = new Set<(meetingId: string, state: "idle" | "recoverable") => void>();
  private readonly transcriptionListeners = new Set<(meetingId: string, snapshot: RealtimeTranscriptionSnapshot) => void>();
  private readonly transcriptionSnapshots = new Map<string, RealtimeTranscriptionSnapshot>();
  private initialization: Promise<void> | null = null;

  constructor(
    private readonly repository: RecordingRepositoryPort,
    private readonly createController: ControllerFactory,
    private readonly now: () => string,
    private readonly onChunkPersisted: () => void = () => undefined,
  ) {}

  subscribe(listener: (meetingId: string, state: "idle" | "recoverable") => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeTranscription(listener: (meetingId: string, snapshot: RealtimeTranscriptionSnapshot) => void): () => void {
    this.transcriptionListeners.add(listener);
    return () => this.transcriptionListeners.delete(listener);
  }

  transcriptionState(meetingId: string): RealtimeTranscriptionSnapshot {
    return this.transcriptionSnapshots.get(meetingId) ?? EMPTY_TRANSCRIPTION;
  }

  private updateTranscription(meetingId: string, update: RealtimeTranscriptionUpdate): void {
    const current = this.transcriptionState(meetingId);
    const next: RealtimeTranscriptionSnapshot = update.type === "status"
      ? { ...current, status: update.status }
      : update.type === "partial"
        ? { ...current, partial: update.text }
        : update.type === "final"
          ? { ...current, partial: "", revision: current.revision + 1 }
          : { ...current, status: "failed" };
    this.transcriptionSnapshots.set(meetingId, next);
    for (const listener of this.transcriptionListeners) listener(meetingId, next);
  }

  private publish(meetingId: string, state: "idle" | "recoverable"): void {
    for (const listener of this.listeners) listener(meetingId, state);
  }

  hasActiveRecording(): boolean {
    return this.active !== null;
  }

  async prepare(meetingId: string): Promise<"idle" | "recording" | "recoverable"> {
    if (!this.initialization) {
      this.initialization = (async () => {
        await this.repository.deleteExpiredAudio(this.now());
        await this.repository.recoverInterruptedSessions();
      })().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    await this.initialization;
    if (this.active?.meetingId === meetingId) return "recording";
    return (await this.repository.session(meetingId))?.state === "recoverable" ? "recoverable" : "idle";
  }

  async start(meetingId: string): Promise<void> {
    await this.repository.start(meetingId, this.now());
    let controller: ControllerPort;
    controller = this.createController({
      meetingId,
      persistChunk: async (blob, startedOffsetMs, endedOffsetMs) => {
        await this.repository.appendChunk(meetingId, blob, startedOffsetMs, endedOffsetMs, this.now());
        this.onChunkPersisted();
      },
      onInterrupted: async () => {
        try {
          await this.repository.recoverInterruptedSessions();
        } catch {
          // The retry path also finishes a session that is still marked as recording.
        } finally {
          if (this.active?.controller === controller) this.active = null;
          this.publish(meetingId, "recoverable");
        }
      },
      onTranscription: (update) => this.updateTranscription(meetingId, update),
    });
    this.active = { meetingId, controller };
    try {
      await controller.start();
    } catch (error) {
      this.active = null;
      await this.repository.abortFailedStart(meetingId);
      throw error;
    }
  }

  async stop(meetingId: string): Promise<void> {
    if (this.active?.meetingId === meetingId) {
      const controller = this.active.controller;
      try {
        await controller.stop();
        await this.repository.stop(meetingId, this.now());
      } finally {
        if (this.active?.controller === controller) this.active = null;
      }
      this.publish(meetingId, "idle");
      return;
    }
    const session = await this.repository.session(meetingId);
    if (session?.state === "recording") {
      await this.repository.stop(meetingId, this.now());
      this.publish(meetingId, "idle");
      return;
    }
    if (session?.state === "recoverable") {
      await this.repository.completeRecovery(meetingId, this.now());
      this.publish(meetingId, "idle");
    }
  }
}
