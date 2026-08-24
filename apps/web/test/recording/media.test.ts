import { describe, expect, test, vi } from "vitest";

import { RecordingUnavailableError, selectRecordingMimeType } from "../../src/recording/media.js";

describe("selectRecordingMimeType", () => {
  test("prefers Opus WebM when the browser supports it", () => {
    const isTypeSupported = vi.fn(() => true);
    expect(selectRecordingMimeType({ isTypeSupported })).toBe("audio/webm;codecs=opus");
    expect(isTypeSupported).toHaveBeenCalledWith("audio/webm;codecs=opus");
  });

  test("falls back to Safari MP4 before plain WebM", () => {
    const isTypeSupported = (mime: string) => mime === "audio/mp4" || mime === "audio/webm";
    expect(selectRecordingMimeType({ isTypeSupported })).toBe("audio/mp4");
  });

  test("uses the browser default when MediaRecorder exists but reports no candidate", () => {
    expect(selectRecordingMimeType({ isTypeSupported: () => false })).toBe("");
  });

  test("rejects browsers without MediaRecorder", () => {
    expect(() => selectRecordingMimeType(undefined)).toThrow(RecordingUnavailableError);
  });
});
