import { describe, expect, test, vi } from "vitest";

import { RecordingController } from "../../src/recording/controller.js";

class FakeRecorder extends EventTarget {
  state: RecordingState = "inactive";
  readonly start = vi.fn((timeslice?: number) => { void timeslice; this.state = "recording"; });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  });
  emit(blob: Blob) {
    const event = new Event("dataavailable") as BlobEvent;
    Object.defineProperty(event, "data", { value: blob });
    this.dispatchEvent(event);
  }
}

describe("RecordingController", () => {
  test("captures audio in 10-second slices, persists chunks, and releases resources", async () => {
    const recorder = new FakeRecorder();
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const releaseWakeLock = vi.fn().mockResolvedValue(undefined);
    const requestWakeLock = vi.fn().mockResolvedValue({ release: releaseWakeLock });
    const persistChunk = vi.fn().mockResolvedValue(undefined);
    let milliseconds = 0;
    const controller = new RecordingController({
      getUserMedia,
      createRecorder: () => recorder as unknown as MediaRecorder,
      requestWakeLock,
      persistChunk,
      nowMilliseconds: () => milliseconds,
    });

    await controller.start();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(recorder.start).toHaveBeenCalledWith(10_000);
    expect(requestWakeLock).toHaveBeenCalledWith("screen");

    milliseconds = 10_000;
    recorder.emit(new Blob(["audio"], { type: "audio/webm" }));
    await controller.flush();
    expect(persistChunk).toHaveBeenCalledWith(expect.any(Blob), 0, 10_000);

    await controller.stop();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(releaseWakeLock).toHaveBeenCalledOnce();
  });

  test("waits for the final dataavailable write before stop resolves", async () => {
    const recorder = new FakeRecorder();
    const persistChunk = vi.fn().mockResolvedValue(undefined);
    const controller = new RecordingController({
      getUserMedia: async () => ({ getTracks: () => [] } as unknown as MediaStream),
      createRecorder: () => recorder as unknown as MediaRecorder,
      requestWakeLock: async () => null,
      persistChunk,
      nowMilliseconds: () => 10_000,
    });
    await controller.start();
    recorder.stop = vi.fn(() => {
      recorder.emit(new Blob(["final"], { type: "audio/mp4" }));
      recorder.state = "inactive";
      recorder.dispatchEvent(new Event("stop"));
    });

    await controller.stop();
    expect(persistChunk).toHaveBeenCalledOnce();
  });

  test("marks recording interrupted when the page becomes hidden", async () => {
    const recorder = new FakeRecorder();
    let visible = true;
    let visibilityListener: () => void = () => undefined;
    const controller = new RecordingController({
      getUserMedia: async () => ({ getTracks: () => [] } as unknown as MediaStream),
      createRecorder: () => recorder as unknown as MediaRecorder,
      requestWakeLock: async () => null,
      persistChunk: async () => undefined,
      nowMilliseconds: () => 0,
      visibility: {
        isVisible: () => visible,
        subscribe: (listener) => { visibilityListener = listener; return () => undefined; },
      },
    });
    await controller.start();

    visible = false;
    visibilityListener();
    await vi.waitFor(() => expect(controller.status()).toBe("interrupted"));

    expect(recorder.stop).toHaveBeenCalledOnce();
  });

  test("marks a recorder error as interrupted", async () => {
    const recorder = new FakeRecorder();
    const onInterrupted = vi.fn().mockResolvedValue(undefined);
    const controller = new RecordingController({
      getUserMedia: async () => ({ getTracks: () => [] } as unknown as MediaStream),
      createRecorder: () => recorder as unknown as MediaRecorder,
      requestWakeLock: async () => null,
      persistChunk: async () => undefined,
      nowMilliseconds: () => 0,
      onInterrupted,
    });
    await controller.start();

    recorder.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(controller.status()).toBe("interrupted"));
    await vi.waitFor(() => expect(onInterrupted).toHaveBeenCalledOnce());
  });

  test("reacquires a released wake lock only while visible", async () => {
    const recorder = new FakeRecorder();
    const firstLock = new EventTarget() as EventTarget & { release(): Promise<void> };
    firstLock.release = vi.fn().mockResolvedValue(undefined);
    const secondLock = new EventTarget() as EventTarget & { release(): Promise<void> };
    secondLock.release = vi.fn().mockResolvedValue(undefined);
    const requestWakeLock = vi.fn().mockResolvedValueOnce(firstLock).mockResolvedValueOnce(secondLock);
    const controller = new RecordingController({
      getUserMedia: async () => ({ getTracks: () => [] } as unknown as MediaStream),
      createRecorder: () => recorder as unknown as MediaRecorder,
      requestWakeLock,
      persistChunk: async () => undefined,
      nowMilliseconds: () => 0,
      visibility: { isVisible: () => true, subscribe: () => () => undefined },
    });
    await controller.start();

    firstLock.dispatchEvent(new Event("release"));
    await vi.waitFor(() => expect(requestWakeLock).toHaveBeenCalledTimes(2));
    await controller.stop();
  });
});
