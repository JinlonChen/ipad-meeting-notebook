import { Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RealtimeTranscriptionSnapshot } from "../transcription/browser-session.js";

export type MeetingRecorderPort = {
  hasActiveRecording(): boolean;
  prepare(meetingId: string): Promise<"idle" | "recording" | "recoverable">;
  start(meetingId: string): Promise<void>;
  stop(meetingId: string): Promise<void>;
  subscribe(listener: (meetingId: string, state: "idle" | "recoverable") => void): () => void;
  transcriptionState?(meetingId: string): RealtimeTranscriptionSnapshot;
  subscribeTranscription?(listener: (meetingId: string, snapshot: RealtimeTranscriptionSnapshot) => void): () => void;
};

type UiState = "loading" | "idle" | "starting" | "recording" | "stopping" | "recoverable";

function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  return `${minutes}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function microphoneError(error: unknown): string {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "无法开始录音，请在 Safari 设置中允许麦克风";
  }
  return "无法开始录音，请重试";
}

function transcriptionLabel(snapshot: RealtimeTranscriptionSnapshot, online: boolean): string {
  if (!online || snapshot.status === "paused") return "实时转写已暂停";
  if (snapshot.status === "connecting") return "正在连接实时转写";
  if (snapshot.status === "streaming") return "实时转写中";
  if (snapshot.status === "failed") return "实时转写连接失败";
  return "";
}

export function MeetingRecordingControls({ meetingId, recorder, online }: {
  meetingId: string;
  recorder: MeetingRecorderPort;
  online: boolean;
}) {
  const [state, setState] = useState<UiState>("loading");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [transcription, setTranscription] = useState<RealtimeTranscriptionSnapshot>(() => recorder.transcriptionState?.(meetingId) ?? { status: "idle", partial: "", revision: 0 });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void recorder.prepare(meetingId).then((result) => {
      if (mounted.current) setState(result);
    }).catch(() => {
      if (mounted.current) { setState("idle"); setError("无法读取本机录音状态"); }
    });
    return () => { mounted.current = false; };
  }, [meetingId, recorder]);

  useEffect(() => recorder.subscribe((changedMeetingId, nextState) => {
    if (mounted.current && changedMeetingId === meetingId) setState(nextState);
  }), [meetingId, recorder]);

  useEffect(() => recorder.subscribeTranscription?.((changedMeetingId, snapshot) => {
    if (mounted.current && changedMeetingId === meetingId) setTranscription(snapshot);
  }), [meetingId, recorder]);

  useEffect(() => {
    if (state !== "recording") return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [state]);

  const start = async () => {
    setError(null);
    setState("starting");
    try {
      await recorder.start(meetingId);
      if (mounted.current) { setSeconds(0); setState("recording"); }
    } catch (cause) {
      if (mounted.current) { setError(microphoneError(cause)); setState("idle"); }
    }
  };

  const stop = async () => {
    setError(null);
    setState("stopping");
    try {
      await recorder.stop(meetingId);
      if (mounted.current) setState("idle");
    } catch {
      if (mounted.current) { setError("无法结束录音，请重试"); setState("recoverable"); }
    }
  };

  return <section className="recording-controls" aria-label="会议录音">
    <div className="recording-command">
      {state === "recording"
        ? <button className="recording-stop" aria-label="停止录音" title="停止录音" onClick={() => void stop()}><Square size={17} fill="currentColor" /></button>
        : state === "recoverable"
          ? <button className="text-button" onClick={() => void stop()}>结束并保存录音</button>
          : <button className="recording-start" aria-label="开始录音" title="开始录音" disabled={state === "loading" || state === "starting" || state === "stopping"} onClick={() => void start()}><Mic size={18} /></button>}
      <span className={`recording-state ${state === "recording" ? "active" : ""}`} role={state === "recording" ? "status" : undefined} aria-live="polite">
        {state === "recording" ? `录音中 ${duration(seconds)}` : state === "starting" ? "正在启动录音" : state === "stopping" ? "正在保存录音" : "录音已保存到本机"}
      </span>
    </div>
    {!online && state === "recording" && <span className="recording-network">录音分片将保存到本机，联网后上传</span>}
    {state === "recording" && transcriptionLabel(transcription, online) && <span className="recording-network" aria-live="polite">{transcriptionLabel(transcription, online)}</span>}
    <span className="recording-limit">请保持会议本在前台；锁屏或切换应用会中断录音</span>
    {state === "recoverable" && <span className="recording-warning" role="alert">上次录音已中断，已保存的分片仍在本机</span>}
    {error && <span className="recording-warning" role="alert">{error}</span>}
  </section>;
}
