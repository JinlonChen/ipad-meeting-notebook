import { describe, expect, test, vi } from "vitest";

import { WorkspaceRecorder } from "../../src/recording/workspace-recorder.js";

function repository() {
  return {
    deleteExpiredAudio: vi.fn().mockResolvedValue(0),
    recoverInterruptedSessions: vi.fn().mockResolvedValue(0),
    session: vi.fn().mockResolvedValue(null),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    completeRecovery: vi.fn().mockResolvedValue(undefined),
    abortFailedStart: vi.fn().mockResolvedValue("discarded"),
    appendChunk: vi.fn().mockResolvedValue(undefined),
  };
}

test("prepares retention and reports a recoverable meeting", async () => {
  const recording = repository();
  recording.session.mockResolvedValue({ state: "recoverable" });
  const workspace = new WorkspaceRecorder(recording, () => ({ start: vi.fn(), stop: vi.fn() }), () => "2026-08-24T00:00:00.000Z");

  await expect(workspace.prepare("meeting")).resolves.toBe("recoverable");
  expect(recording.deleteExpiredAudio).toHaveBeenCalledOnce();
  expect(recording.recoverInterruptedSessions).toHaveBeenCalledOnce();
});

test("does not recover a live recording when the same workspace is reopened", async () => {
  const recording = repository();
  const workspace = new WorkspaceRecorder(recording, () => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }), () => "2026-08-24T00:00:00.000Z");
  await workspace.prepare("meeting");
  await workspace.start("meeting");

  await expect(workspace.prepare("meeting")).resolves.toBe("recording");
  expect(recording.recoverInterruptedSessions).toHaveBeenCalledOnce();
});

test("reports only a controller owned by the current page as active", async () => {
  const recording = repository();
  const workspace = new WorkspaceRecorder(recording, () => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }), () => "2026-08-24T00:00:00.000Z");

  expect(workspace.hasActiveRecording()).toBe(false);
  await workspace.start("meeting");
  expect(workspace.hasActiveRecording()).toBe(true);
  await workspace.stop("meeting");
  expect(workspace.hasActiveRecording()).toBe(false);
});

test("starts capture and aborts an empty session when microphone startup fails", async () => {
  const recording = repository();
  const start = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
  const workspace = new WorkspaceRecorder(recording, () => ({ start, stop: vi.fn() }), () => "2026-08-24T00:00:00.000Z");

  await expect(workspace.start("meeting")).rejects.toMatchObject({ name: "NotAllowedError" });
  expect(recording.start).toHaveBeenCalledOnce();
  expect(recording.abortFailedStart).toHaveBeenCalledWith("meeting");
});

test("schedules upload only after a captured chunk is durably appended", async () => {
  const recording = repository();
  const uploaded = vi.fn();
  let persist: (_blob: Blob, _start: number, _end: number) => Promise<void> = async () => undefined;
  const workspace = new WorkspaceRecorder(recording, (options) => {
    persist = options.persistChunk;
    return { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
  }, () => "2026-08-24T00:00:10.000Z", uploaded);
  await workspace.start("meeting");

  await persist(new Blob(["audio"]), 0, 10_000);

  expect(recording.appendChunk).toHaveBeenCalledOnce();
  expect(uploaded).toHaveBeenCalledOnce();
});

test("stops live capture and completes an already recoverable meeting", async () => {
  const recording = repository();
  const stop = vi.fn().mockResolvedValue(undefined);
  const workspace = new WorkspaceRecorder(recording, () => ({ start: vi.fn().mockResolvedValue(undefined), stop }), () => "2026-08-24T00:10:00.000Z");
  await workspace.start("meeting");
  await workspace.stop("meeting");
  expect(stop).toHaveBeenCalledOnce();
  expect(recording.stop).toHaveBeenCalledWith("meeting", "2026-08-24T00:10:00.000Z");

  recording.session.mockResolvedValue({ state: "recoverable" });
  await workspace.stop("recovered");
  expect(recording.completeRecovery).toHaveBeenCalledWith("recovered", "2026-08-24T00:10:00.000Z");
});

test("clears the live controller when capture is interrupted", async () => {
  const recording = repository();
  let interrupt: () => Promise<void> = async () => undefined;
  const stop = vi.fn().mockResolvedValue(undefined);
  const workspace = new WorkspaceRecorder(recording, (options) => {
    interrupt = options.onInterrupted;
    return { start: vi.fn().mockResolvedValue(undefined), stop };
  }, () => "2026-08-24T00:10:00.000Z");
  await workspace.start("meeting");

  await interrupt();
  recording.session.mockResolvedValue({ state: "recoverable" });
  await workspace.stop("meeting");

  expect(stop).not.toHaveBeenCalled();
  expect(recording.completeRecovery).toHaveBeenCalledWith("meeting", "2026-08-24T00:10:00.000Z");
});

test("clears the live controller when interrupted-session persistence fails", async () => {
  const recording = repository();
  recording.recoverInterruptedSessions.mockRejectedValueOnce(new Error("indexeddb-write-failed"));
  let interrupt: () => Promise<void> = async () => undefined;
  const workspace = new WorkspaceRecorder(recording, (options) => {
    interrupt = options.onInterrupted;
    return { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
  }, () => "2026-08-24T00:10:00.000Z");
  const changed = vi.fn();
  workspace.subscribe(changed);
  await workspace.start("meeting");

  await expect(interrupt()).resolves.toBeUndefined();

  expect(workspace.hasActiveRecording()).toBe(false);
  expect(changed).toHaveBeenCalledWith("meeting", "recoverable");
});

test("retries the durable stop after the controller has already stopped", async () => {
  const recording = repository();
  recording.stop.mockRejectedValueOnce(new Error("indexeddb-write-failed")).mockResolvedValueOnce(undefined);
  const controllerStop = vi.fn().mockResolvedValue(undefined);
  const workspace = new WorkspaceRecorder(recording, () => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: controllerStop,
  }), () => "2026-08-24T00:10:00.000Z");
  await workspace.start("meeting");

  await expect(workspace.stop("meeting")).rejects.toThrow("indexeddb-write-failed");
  expect(workspace.hasActiveRecording()).toBe(false);
  recording.session.mockResolvedValue({ state: "recording" });

  await expect(workspace.stop("meeting")).resolves.toBeUndefined();

  expect(controllerStop).toHaveBeenCalledOnce();
  expect(recording.stop).toHaveBeenCalledTimes(2);
  expect(recording.stop).toHaveBeenLastCalledWith("meeting", "2026-08-24T00:10:00.000Z");
  expect(recording.completeRecovery).not.toHaveBeenCalled();
});
