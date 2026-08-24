import type { Minutes, TranscriptSegment } from "@meeting/contracts";
import { useCallback, useEffect, useState } from "react";

export type MeetingIntelligenceSnapshot = {
  job: { status: "queued" | "processing" | "ready" | "failed"; errorCode: string | null } | null;
  transcript: TranscriptSegment[];
  minutes: Minutes | null;
};

export type MeetingIntelligencePort = {
  configured(): Promise<boolean>;
  process(meetingId: string): Promise<void>;
  read(meetingId: string): Promise<MeetingIntelligenceSnapshot>;
};

function stateLabel(status: "queued" | "processing" | "ready" | "failed"): string {
  return ({ queued: "等待处理", processing: "正在生成转写与纪要", ready: "转写与纪要已完成", failed: "生成失败，可重试" })[status];
}

export function MeetingIntelligencePanel({ api, meetingId, online }: { api: MeetingIntelligencePort; meetingId: string; online: boolean }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [snapshot, setSnapshot] = useState<MeetingIntelligenceSnapshot | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const [nextConfigured, nextSnapshot] = await Promise.all([api.configured(), api.read(meetingId)]);
    setConfigured(nextConfigured);
    setSnapshot(nextSnapshot);
  }, [api, meetingId]);

  useEffect(() => { void load().catch(() => setError("无法读取转写与纪要")); }, [load]);

  const process = async () => {
    setError("");
    setProcessing(true);
    try {
      await api.process(meetingId);
      await load();
    } catch {
      setError("无法开始处理，请确认录音已上传和 AI 配置正确");
    } finally {
      setProcessing(false);
    }
  };

  const hasResult = Boolean(snapshot?.minutes || snapshot?.transcript.length);
  const actionLabel = hasResult ? "重新生成转写与纪要" : "生成转写与纪要";
  return <section className="intelligence-panel" aria-label="转写与 AI 纪要">
    <div className="intelligence-heading"><div><span>转写与 AI 纪要</span>{snapshot?.job && <small role="status">{stateLabel(snapshot.job.status)}</small>}</div>
      <button className="text-button" disabled={!online || configured !== true || processing} onClick={() => void process()}>{processing ? "正在提交处理" : actionLabel}</button>
    </div>
    {configured === false && <p className="intelligence-hint">请先在 AI 设置中填写转写与总结 API。</p>}
    {!online && <p className="intelligence-hint">联网后可生成转写与纪要。</p>}
    {snapshot?.minutes && <section className="minutes-result" aria-label="会议纪要"><h2>会议纪要</h2><p>{snapshot.minutes.summary}</p>
      {snapshot.minutes.decisions.length > 0 && <MinutesList title="结论" items={snapshot.minutes.decisions.map((item) => item.text)} />}
      {snapshot.minutes.risks.length > 0 && <MinutesList title="风险" items={snapshot.minutes.risks.map((item) => item.text)} />}
      {snapshot.minutes.actions.length > 0 && <MinutesList title="待办" items={snapshot.minutes.actions.map((item) => `${item.text}${item.owner ? ` · ${item.owner}` : " · 待确认"}`)} />}
    </section>}
    {snapshot?.transcript.length ? <section className="transcript-result" aria-label="会议转写"><h2>会议转写</h2>{snapshot.transcript.map((segment) => <p key={segment.id}><time>{Math.floor(segment.startedOffsetMs / 60_000).toString().padStart(2, "0")}:{Math.floor(segment.startedOffsetMs / 1_000 % 60).toString().padStart(2, "0")}</time><span>{segment.text}</span></p>)}</section> : null}
    {error && <p className="workspace-error" role="alert">{error}</p>}
  </section>;
}

function MinutesList({ title, items }: { title: string; items: string[] }) {
  return <div className="minutes-list"><h3>{title}</h3><ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul></div>;
}
