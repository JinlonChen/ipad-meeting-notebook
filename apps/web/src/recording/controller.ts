type WakeLockHandle = {
  release(): Promise<void>;
  addEventListener?(type: "release", listener: () => void, options?: AddEventListenerOptions): void;
};

type VisibilityPort = {
  isVisible(): boolean;
  subscribe(listener: () => void): () => void;
};

export type RecordingControllerStatus = "idle" | "recording" | "interrupted";

export type RecordingControllerDependencies = {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createRecorder(stream: MediaStream): MediaRecorder;
  requestWakeLock(type: "screen"): Promise<WakeLockHandle | null>;
  persistChunk(blob: Blob, startedOffsetMs: number, endedOffsetMs: number): Promise<void>;
  nowMilliseconds(): number;
  visibility?: VisibilityPort;
  onInterrupted?: () => Promise<void>;
  transcription?: {
    start(stream: MediaStream): Promise<void>;
    stop(): Promise<void>;
  };
};

export class RecordingController {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private wakeLock: WakeLockHandle | null = null;
  private startedAt = 0;
  private lastChunkEnd = 0;
  private writes: Promise<void> = Promise.resolve();
  private currentStatus: RecordingControllerStatus = "idle";
  private unsubscribeVisibility: (() => void) | null = null;

  constructor(private readonly dependencies: RecordingControllerDependencies) {}

  status(): RecordingControllerStatus {
    return this.currentStatus;
  }

  private async acquireWakeLock(): Promise<void> {
    if (this.dependencies.visibility && !this.dependencies.visibility.isVisible()) return;
    const lock = await this.dependencies.requestWakeLock("screen");
    this.wakeLock = lock;
    lock?.addEventListener?.("release", () => {
      if (this.wakeLock !== lock) return;
      this.wakeLock = null;
      if (this.currentStatus === "recording" && (!this.dependencies.visibility || this.dependencies.visibility.isVisible())) {
        void this.acquireWakeLock();
      }
    }, { once: true });
  }

  async start(): Promise<void> {
    if (this.recorder) throw new Error("RECORDING_ALREADY_ACTIVE");
    const stream = await this.dependencies.getUserMedia({ audio: true });
    try {
      const recorder = this.dependencies.createRecorder(stream);
      this.stream = stream;
      this.recorder = recorder;
      this.startedAt = this.dependencies.nowMilliseconds();
      this.lastChunkEnd = 0;
      recorder.addEventListener("dataavailable", (event) => {
        const blob = (event as BlobEvent).data;
        if (!blob || blob.size === 0) return;
        const endedOffset = Math.max(this.lastChunkEnd, this.dependencies.nowMilliseconds() - this.startedAt);
        const startedOffset = this.lastChunkEnd;
        this.lastChunkEnd = endedOffset;
        this.writes = this.writes.then(() => this.dependencies.persistChunk(blob, startedOffset, endedOffset));
      });
      recorder.addEventListener("error", () => { void this.interrupt(); }, { once: true });
      this.unsubscribeVisibility = this.dependencies.visibility?.subscribe(() => {
        if (!this.dependencies.visibility?.isVisible()) void this.interrupt();
      }) ?? null;
      await this.acquireWakeLock();
      recorder.start(10_000);
      this.currentStatus = "recording";
      await this.dependencies.transcription?.start(stream).catch(() => undefined);
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      this.stream = null;
      this.recorder = null;
      throw error;
    }
  }

  flush(): Promise<void> {
    return this.writes;
  }

  async stop(): Promise<void> {
    await this.halt("idle");
  }

  private async interrupt(): Promise<void> {
    if (this.currentStatus !== "recording") return;
    await this.halt("interrupted");
    await this.dependencies.onInterrupted?.();
  }

  private async halt(finalStatus: RecordingControllerStatus): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) return;
    this.currentStatus = finalStatus;
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
    const stopped = recorder.state === "inactive" ? Promise.resolve() : new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
    });
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    await this.flush();
    await this.dependencies.transcription?.stop().catch(() => undefined);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    const wakeLock = this.wakeLock;
    this.wakeLock = null;
    await wakeLock?.release();
    this.recorder = null;
    this.stream = null;
  }
}
