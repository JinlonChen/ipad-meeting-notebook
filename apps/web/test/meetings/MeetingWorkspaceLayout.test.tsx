import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { MeetingWorkspaceLayout } from "../../src/meetings/MeetingWorkspaceLayout.js";

beforeEach(() => {
  localStorage.clear();
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: 1_024 },
    innerHeight: { configurable: true, value: 768 },
  });
});

afterEach(() => vi.unstubAllGlobals());

function layout(revision = 0) {
  return render(<MeetingWorkspaceLayout
    transcript={<div>转写内容</div>}
    transcriptRevision={revision}
    handwriting={<div>手写内容</div>}
    keyboard={<textarea aria-label="键盘区域" />}
    summary={<div>总结内容</div>}
  />);
}

test("opens handwriting by default and preserves mounted tab content", () => {
  layout();
  expect(screen.getByRole("tab", { name: "手写" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("手写内容")).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "键盘" }));
  fireEvent.change(screen.getByLabelText("键盘区域"), { target: { value: "保留的笔记" } });
  fireEvent.click(screen.getByRole("tab", { name: "AI 总结" }));
  fireEvent.click(screen.getByRole("tab", { name: "键盘" }));
  expect(screen.getByLabelText("键盘区域")).toHaveValue("保留的笔记");
});

test("starts at 45 percent, clamps to 30-70, and persists keyboard adjustments", () => {
  layout();
  const separator = screen.getByRole("separator", { name: "调整转写区域高度" });
  expect(separator).toHaveAttribute("aria-valuenow", "45");
  for (let index = 0; index < 10; index += 1) fireEvent.keyDown(separator, { key: "ArrowUp" });
  expect(separator).toHaveAttribute("aria-valuenow", "30");
  for (let index = 0; index < 20; index += 1) fireEvent.keyDown(separator, { key: "ArrowDown" });
  expect(separator).toHaveAttribute("aria-valuenow", "70");
  expect(localStorage.getItem("meeting-workspace-ratio-landscape")).toBe("70");
});

test("restores and saves each orientation ratio during live rotation and removes listeners", async () => {
  localStorage.setItem("meeting-workspace-ratio-landscape", "64");
  localStorage.setItem("meeting-workspace-ratio-portrait", "36");
  const addListener = vi.spyOn(window, "addEventListener");
  const removeListener = vi.spyOn(window, "removeEventListener");
  const rendered = layout();
  const separator = screen.getByRole("separator", { name: "调整转写区域高度" });
  expect(separator).toHaveAttribute("aria-valuenow", "64");

  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: 744 },
    innerHeight: { configurable: true, value: 1_133 },
  });
  fireEvent(window, new Event("resize"));
  await waitFor(() => expect(separator).toHaveAttribute("aria-valuenow", "36"));
  fireEvent.keyDown(separator, { key: "ArrowDown" });
  expect(localStorage.getItem("meeting-workspace-ratio-portrait")).toBe("41");
  expect(localStorage.getItem("meeting-workspace-ratio-landscape")).toBe("64");

  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: 1_133 },
    innerHeight: { configurable: true, value: 744 },
  });
  fireEvent(window, new Event("orientationchange"));
  await waitFor(() => expect(separator).toHaveAttribute("aria-valuenow", "64"));
  fireEvent.keyDown(separator, { key: "ArrowUp" });
  expect(localStorage.getItem("meeting-workspace-ratio-landscape")).toBe("59");
  expect(localStorage.getItem("meeting-workspace-ratio-portrait")).toBe("41");

  const resizeListener = addListener.mock.calls.find(([type]) => type === "resize")?.[1];
  const orientationListener = addListener.mock.calls.find(([type]) => type === "orientationchange")?.[1];
  rendered.unmount();
  expect(removeListener).toHaveBeenCalledWith("resize", resizeListener);
  expect(removeListener).toHaveBeenCalledWith("orientationchange", orientationListener);
});

test("pauses transcript following after user scroll and returns to latest", () => {
  const rendered = layout();
  const scroller = screen.getByLabelText("实时转写区域");
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, writable: true, value: 200 },
  });
  fireEvent.wheel(scroller);
  fireEvent.scroll(scroller);
  expect(screen.getByRole("button", { name: "回到最新" })).toBeVisible();
  rendered.rerender(<MeetingWorkspaceLayout transcript={<div>新转写</div>} transcriptRevision={1} handwriting={<div />} keyboard={<div />} summary={<div />} />);
  expect(scroller.scrollTop).toBe(200);
  fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
  expect(scroller.scrollTop).toBe(1_000);
});

test("follows live transcript content growth until the user scrolls away", () => {
  let resize: ResizeObserverCallback | undefined;
  let observed: Element | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe(element: Element) { observed = element; }
    disconnect = disconnect;
  });

  const rendered = layout();
  const scroller = screen.getByLabelText("实时转写区域");
  let scrollHeight = 1_000;
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, get: () => scrollHeight },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });

  expect(observed).toBe(scroller.firstElementChild);
  resize?.([], {} as ResizeObserver);
  expect(scroller.scrollTop).toBe(1_000);

  scroller.scrollTop = 200;
  fireEvent.wheel(scroller);
  fireEvent.scroll(scroller);
  resize?.([], {} as ResizeObserver);
  expect(scroller.scrollTop).toBe(200);

  fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
  scrollHeight = 1_400;
  resize?.([], {} as ResizeObserver);
  expect(scroller.scrollTop).toBe(1_400);

  rendered.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});

test("does not pause follow mode for a browser scroll caused by content layout", () => {
  let resize: ResizeObserverCallback | undefined;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  layout();
  const scroller = screen.getByLabelText("实时转写区域");
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });

  fireEvent.scroll(scroller);
  expect(screen.queryByRole("button", { name: "回到最新" })).not.toBeInTheDocument();
  resize?.([], {} as ResizeObserver);
  expect(scroller.scrollTop).toBe(1_000);
});
