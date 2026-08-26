import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import { MeetingIntelligencePanel } from "../../src/intelligence/MeetingIntelligencePanel.js";

const meetingId = "00000000-0000-4000-8000-000000000001";

describe("MeetingIntelligencePanel", () => {
  test("generates AI minutes on demand from the existing transcript", async () => {
    const user = userEvent.setup();
    const api = {
      configured: vi.fn().mockResolvedValue(true),
      summarize: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue({
        job: { status: "ready", errorCode: null },
        transcript: [{ id: "00000000-0000-4000-8000-000000000002", meetingId, position: 0, text: "确认下周发布", startedOffsetMs: 0, endedOffsetMs: 3_000, speaker: null, source: "asr", confidence: null }],
        minutes: { summary: "团队确认下周发布。", topics: [], decisions: [{ text: "下周发布", evidenceSegmentIds: [] }], risks: [], actions: [] },
      }),
    };

    render(<MeetingIntelligencePanel api={api} meetingId={meetingId} online />);
    expect(await screen.findByText("团队确认下周发布。")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重新生成 AI 总结" }));
    expect(api.summarize).toHaveBeenCalledWith(meetingId);
    expect(screen.queryByText(/生成转写/)).not.toBeInTheDocument();
  });

  test("shows live partial text and reloads when a final segment is persisted", async () => {
    let report: (meetingId: string, snapshot: { status: "streaming"; partial: string; revision: number }) => void = () => undefined;
    const api = {
      configured: vi.fn().mockResolvedValue(true),
      summarize: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue({ job: null, transcript: [], minutes: null }),
    };
    const recorder = {
      transcriptionState: vi.fn().mockReturnValue({ status: "streaming", partial: "正在讨论预算", revision: 0 }),
      subscribeTranscription: vi.fn((listener) => { report = listener; return () => undefined; }),
    };
    render(<MeetingIntelligencePanel api={api} meetingId={meetingId} online recorder={recorder} />);

    expect(await screen.findByText("正在讨论预算")).toBeVisible();
    report(meetingId, { status: "streaming", partial: "", revision: 1 });
    await vi.waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
  });

  test("allows an on-demand summary from keyboard notes without a transcript", async () => {
    const user = userEvent.setup();
    const api = {
      configured: vi.fn().mockResolvedValue(true),
      summarize: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue({ job: null, transcript: [], minutes: null }),
    };
    render(<MeetingIntelligencePanel api={api} meetingId={meetingId} online view="summary" hasKeyboardNote />);

    const button = await screen.findByRole("button", { name: "生成 AI 总结" });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(api.summarize).toHaveBeenCalledWith(meetingId);
  });

  test("waits for keyboard notes to sync before requesting the summary", async () => {
    const user = userEvent.setup();
    let release!: (value: boolean) => void;
    const beforeSummarize = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const api = {
      configured: vi.fn().mockResolvedValue(true),
      summarize: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue({ job: null, transcript: [], minutes: null }),
    };
    render(<MeetingIntelligencePanel api={api} meetingId={meetingId} online view="summary" hasKeyboardNote beforeSummarize={beforeSummarize} />);

    await user.click(await screen.findByRole("button", { name: "生成 AI 总结" }));
    expect(beforeSummarize).toHaveBeenCalledOnce();
    expect(api.summarize).not.toHaveBeenCalled();
    release(true);
    await vi.waitFor(() => expect(api.summarize).toHaveBeenCalledWith(meetingId));
  });
});
