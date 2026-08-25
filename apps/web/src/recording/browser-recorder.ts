import { MeetingCatalogDatabase } from "../meetings/local-db.js";
import { RecordingController } from "./controller.js";
import { selectRecordingMimeType } from "./media.js";
import { MeetingRecordingRepository } from "./repository.js";
import { WorkspaceRecorder } from "./workspace-recorder.js";
import type { RealtimeTranscriptionSession, RealtimeTranscriptionUpdate } from "../transcription/browser-session.js";

type BrowserWakeLock = EventTarget & { release(): Promise<void> };

export function createBrowserWorkspaceRecorder(
  database: MeetingCatalogDatabase,
  now: () => string,
  onChunkPersisted: () => void = () => undefined,
  createTranscription?: (meetingId: string, onUpdate: (update: RealtimeTranscriptionUpdate) => void) => RealtimeTranscriptionSession,
): WorkspaceRecorder {
  const repository = new MeetingRecordingRepository(database);
  return new WorkspaceRecorder(repository, ({ meetingId, persistChunk, onInterrupted, onTranscription }) => {
    const Recorder = globalThis.MediaRecorder;
    const mimeType = selectRecordingMimeType(Recorder);
    return new RecordingController({
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      createRecorder: (stream) => new Recorder(stream, mimeType ? { mimeType } : undefined),
      requestWakeLock: async () => {
        const manager = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<BrowserWakeLock> } }).wakeLock;
        if (!manager) return null;
        try { return await manager.request("screen"); } catch { return null; }
      },
      persistChunk,
      onInterrupted,
      nowMilliseconds: () => Date.now(),
      visibility: {
        isVisible: () => document.visibilityState === "visible",
        subscribe: (listener) => {
          document.addEventListener("visibilitychange", listener);
          return () => document.removeEventListener("visibilitychange", listener);
        },
      },
      ...(createTranscription ? { transcription: createTranscription(meetingId, onTranscription) } : {}),
    });
  }, now, onChunkPersisted);
}
