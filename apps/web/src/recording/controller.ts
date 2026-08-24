type WakeLockHandle = { release(): Promise<void> };

export type RecordingControllerDependencies = {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createRecorder(stream: MediaStream): MediaRecorder;
  requestWakeLock(type: "screen"): Promise<WakeLockHandle | null>;
  persistChunk(blob: Blob, startedOffsetMs: number, endedOffsetMs: number): Promise<void>;
  nowMilliseconds(): number;
};

export class RecordingController {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private wakeLock: WakeLockHandle | null = null;
  private startedAt = 0;
  private lastChunkEnd = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: RecordingControllerDependencies) {}

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
      this.wakeLock = await this.dependencies.requestWakeLock("screen");
      recorder.start(10_000);
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
    const recorder = this.recorder;
    if (!recorder) return;
    const stopped = recorder.state === "inactive" ? Promise.resolve() : new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
    });
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    await this.flush();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    await this.wakeLock?.release();
    this.recorder = null;
    this.stream = null;
    this.wakeLock = null;
  }
}
