import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MeetingRecordingControls, type MeetingRecorderPort } from "../../src/recording/MeetingRecordingControls.js";

function port(overrides: Partial<MeetingRecorderPort> = {}): MeetingRecorderPort {
  return {
    hasActiveRecording: vi.fn().mockReturnValue(false),
    prepare: vi.fn().mockResolvedValue("idle"),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => undefined),
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("MeetingRecordingControls", () => {
  test("starts, shows a stable timer, and stops recording", async () => {
    vi.useFakeTimers();
    const recorder = port();
    render(<MeetingRecordingControls meetingId="00000000-0000-4000-8000-000000000001" recorder={recorder} online />);
    await act(async () => Promise.resolve());

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "开始录音" })); });
    expect(recorder.start).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("录音中 00:00");
    act(() => vi.advanceTimersByTime(61_000));
    expect(screen.getByRole("status")).toHaveTextContent("录音中 01:01");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "停止录音" })); });
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "开始录音" })).toBeVisible();
  });

  test("shows a direct Safari microphone permission error", async () => {
    const denied = new DOMException("denied", "NotAllowedError");
    render(<MeetingRecordingControls meetingId="00000000-0000-4000-8000-000000000001" recorder={port({ start: vi.fn().mockRejectedValue(denied) })} online />);
    await act(async () => Promise.resolve());

    fireEvent.click(screen.getByRole("button", { name: "开始录音" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("请在 Safari 设置中允许麦克风");
  });

  test("keeps recording available offline and reports local-only saving", async () => {
    render(<MeetingRecordingControls meetingId="00000000-0000-4000-8000-000000000001" recorder={port()} online={false} />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "开始录音" }));

    expect(await screen.findByText("录音分片将保存到本机，联网后上传")).toBeVisible();
  });

  test("offers a clear finish action for an interrupted session", async () => {
    const recorder = port({ prepare: vi.fn().mockResolvedValue("recoverable") });
    render(<MeetingRecordingControls meetingId="00000000-0000-4000-8000-000000000001" recorder={recorder} online />);

    expect(await screen.findByRole("alert")).toHaveTextContent("上次录音已中断");
    fireEvent.click(screen.getByRole("button", { name: "结束并保存录音" }));
    await waitFor(() => expect(recorder.stop).toHaveBeenCalledOnce());
  });

  test("shows an interrupted recording immediately after the recorder reports it", async () => {
    let reportInterrupted: () => void = () => undefined;
    const recorder = port();
    recorder.subscribe = (listener) => {
      reportInterrupted = () => listener("00000000-0000-4000-8000-000000000001", "recoverable");
      return () => undefined;
    };
    render(<MeetingRecordingControls meetingId="00000000-0000-4000-8000-000000000001" recorder={recorder} online />);
    await act(async () => Promise.resolve());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "开始录音" })); });

    act(() => reportInterrupted());

    expect(screen.getByRole("alert")).toHaveTextContent("上次录音已中断");
    expect(screen.getByRole("button", { name: "结束并保存录音" })).toBeVisible();
  });
});
