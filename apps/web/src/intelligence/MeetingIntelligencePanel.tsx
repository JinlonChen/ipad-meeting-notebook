import type { Minutes, TranscriptSegment } from "@meeting/contracts";
import { useCallback, useEffect, useState } from "react";
import type { MeetingRecorderPort } from "../recording/MeetingRecordingControls.js";
import type { RealtimeTranscriptionSnapshot } from "../transcription/browser-session.js";
import type { RealtimeTranscriptionSession, RealtimeTranscriptionUpdate } from "../transcription/browser-session.js";

export type MeetingIntelligenceSnapshot = {
  job: { status: "queued" | "processing" | "ready" | "failed"; errorCode: string | null } | null;
  transcript: TranscriptSegment[];
  minutes: Minutes | null;
};

export type MeetingIntelligencePort = {
  configured(): Promise<boolean>;
  summarize(meetingId: string): Promise<void>;
  read(meetingId: string): Promise<MeetingIntelligenceSnapshot>;
  createRealtimeSession?(meetingId: string, onUpdate: (update: RealtimeTranscriptionUpdate) => void): RealtimeTranscriptionSession;
};

function stateLabel(status: "queued" | "processing" | "ready" | "failed"): string {
  return ({ queued: "等待生成 AI 总结", processing: "正在生成 AI 总结", ready: "AI 总结已完成", failed: "AI 总结失败，可重试" })[status];
}

type TranscriptionRecorder = Pick<MeetingRecorderPort, "transcriptionState" | "subscribeTranscription">;

export function MeetingIntelligencePanel({ api, meetingId, online, recorder }: { api: MeetingIntelligencePort; meetingId: string; online: boolean; recorder?: TranscriptionRecorder }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [snapshot, setSnapshot] = useState<MeetingIntelligenceSnapshot | null>(null);
  const [live, setLive] = useState<RealtimeTranscriptionSnapshot>(() => recorder?.transcriptionState?.(meetingId) ?? { status: "idle", partial: "", revision: 0 });
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const [nextConfigured, nextSnapshot] = await Promise.all([api.configured(), api.read(meetingId)]);
    setConfigured(nextConfigured);
    setSnapshot(nextSnapshot);
  }, [api, meetingId]);

  useEffect(() => { void load().catch(() => setError("无法读取转写与纪要")); }, [load]);

  useEffect(() => recorder?.subscribeTranscription?.((changedMeetingId, next) => {
    if (changedMeetingId === meetingId) setLive(next);
  }), [meetingId, recorder]);

  useEffect(() => {
    if (live.revision > 0) void load().catch(() => setError("无法刷新会议转写"));
  }, [live.revision, load]);

  const summarize = async () => {
    setError("");
    setProcessing(true);
    try {
      await api.summarize(meetingId);
      await load();
    } catch {
      setError("无法生成 AI 总结，请确认已有转写且总结 API 配置正确");
    } finally {
      setProcessing(false);
    }
  };

  const actionLabel = snapshot?.minutes ? "重新生成 AI 总结" : "生成 AI 总结";
  return <section className="intelligence-panel" aria-label="转写与 AI 纪要">
    <div className="intelligence-heading"><div><span>实时转写与 AI 总结</span>{snapshot?.job && <small role="status">{stateLabel(snapshot.job.status)}</small>}</div>
      <button className="text-button" disabled={!online || configured !== true || processing || !snapshot?.transcript.length} onClick={() => void summarize()}>{processing ? "正在生成 AI 总结" : actionLabel}</button>
    </div>
    {configured === false && <p className="intelligence-hint">请先在 AI 设置中填写语音转写和会议总结 API。</p>}
    {!online && <p className="intelligence-hint">实时转写已暂停；录音仍保存在本机。</p>}
    {snapshot?.minutes && <section className="minutes-result" aria-label="会议纪要"><h2>会议纪要</h2><p>{snapshot.minutes.summary}</p>
      {snapshot.minutes.decisions.length > 0 && <MinutesList title="结论" items={snapshot.minutes.decisions.map((item) => item.text)} />}
      {snapshot.minutes.risks.length > 0 && <MinutesList title="风险" items={snapshot.minutes.risks.map((item) => item.text)} />}
      {snapshot.minutes.actions.length > 0 && <MinutesList title="待办" items={snapshot.minutes.actions.map((item) => `${item.text}${item.owner ? ` · ${item.owner}` : " · 待确认"}`)} />}
    </section>}
    {(snapshot?.transcript.length || live.partial) ? <section className="transcript-result" aria-label="会议转写"><h2>会议转写</h2>{snapshot?.transcript.map((segment) => <p key={segment.id}><time>{Math.floor(segment.startedOffsetMs / 60_000).toString().padStart(2, "0")}:{Math.floor(segment.startedOffsetMs / 1_000 % 60).toString().padStart(2, "0")}</time><span>{segment.text}</span></p>)}{live.partial && <p className="transcript-partial"><span>{live.partial}</span></p>}</section> : null}
    {error && <p className="workspace-error" aria-live="polite">{error}</p>}
  </section>;
}

function MinutesList({ title, items }: { title: string; items: string[] }) {
  return <div className="minutes-list"><h3>{title}</h3><ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul></div>;
}
