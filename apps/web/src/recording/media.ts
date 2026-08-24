export type MediaRecorderSupport = {
  isTypeSupported(mimeType: string): boolean;
};

export class RecordingUnavailableError extends Error {
  constructor() {
    super("This browser does not support meeting recording");
    this.name = "RecordingUnavailableError";
  }
}

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/webm",
  "audio/ogg;codecs=opus",
] as const;

export function selectRecordingMimeType(mediaRecorder: MediaRecorderSupport | undefined): string {
  if (!mediaRecorder) throw new RecordingUnavailableError();
  return MIME_CANDIDATES.find((mimeType) => mediaRecorder.isTypeSupported(mimeType)) ?? "";
}
