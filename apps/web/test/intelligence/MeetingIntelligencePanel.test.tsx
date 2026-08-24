import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import { MeetingIntelligencePanel } from "../../src/intelligence/MeetingIntelligencePanel.js";

const meetingId = "00000000-0000-4000-8000-000000000001";

describe("MeetingIntelligencePanel", () => {
  test("starts meeting processing and renders its resulting transcript and minutes", async () => {
    const user = userEvent.setup();
    const api = {
      configured: vi.fn().mockResolvedValue(true),
      process: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue({
        job: { status: "ready", errorCode: null },
        transcript: [{ id: "00000000-0000-4000-8000-000000000002", meetingId, position: 0, text: "确认下周发布", startedOffsetMs: 0, endedOffsetMs: 3_000, speaker: null, source: "asr", confidence: null }],
        minutes: { summary: "团队确认下周发布。", topics: [], decisions: [{ text: "下周发布", evidenceSegmentIds: [] }], risks: [], actions: [] },
      }),
    };

    render(<MeetingIntelligencePanel api={api} meetingId={meetingId} online />);
    expect(await screen.findByText("团队确认下周发布。")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重新生成转写与纪要" }));
    expect(api.process).toHaveBeenCalledWith(meetingId);
  });
});
