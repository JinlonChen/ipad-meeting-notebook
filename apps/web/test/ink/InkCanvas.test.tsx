import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { INK_LOGICAL_HEIGHT, INK_MAX_POINTS, type InkStroke } from "@meeting/contracts";
import { InkCanvas } from "../../src/ink/InkCanvas.js";

const stroke: InkStroke = {
  id: "00000000-0000-4000-8000-000000000001",
  meetingId: "00000000-0000-4000-8000-000000000002",
  order: 0, tool: "pen", color: "#1d2529", width: 4,
  points: [{ x: 10, y: 10, pressure: 0.5, elapsedMs: 0 }, { x: 100, y: 10, pressure: 0.5, elapsedMs: 16 }],
  deleted: false, version: 1,
};

function pointer(target: Element, type: string, values: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])));
  fireEvent(target, event);
  return event;
}

beforeEach(() => {
  const context = {
    setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
    lineTo: vi.fn(), stroke: vi.fn(), lineCap: "round", lineJoin: "round",
    strokeStyle: "", lineWidth: 1, globalAlpha: 1,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  Object.defineProperty(HTMLCanvasElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 512, height: 720, right: 512, bottom: 720, x: 0, y: 0, toJSON: () => ({}),
  });
});

afterEach(() => vi.unstubAllGlobals());

test("preserves every sampled point and pressure in a Pencil stroke", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[]} onSave={save} />);
  const canvas = screen.getByLabelText("手写画布");

  pointer(canvas, "pointerdown", { pointerId: 1, pointerType: "pen", clientX: 10, clientY: 20, pressure: 0.3 });
  pointer(canvas, "pointermove", { pointerId: 1, pointerType: "pen", clientX: 30, clientY: 40, pressure: 0.8 });
  pointer(canvas, "pointermove", { pointerId: 1, pointerType: "pen", clientX: 40, clientY: 50, pressure: 0.6 });
  pointer(canvas, "pointerup", { pointerId: 1, pointerType: "pen", clientX: 50, clientY: 60, pressure: 0.4 });

  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]?.[0][0]).toMatchObject({ meetingId: stroke.meetingId, tool: "pen", deleted: false, version: 1 });
  expect(save.mock.calls[0]?.[0][0].points).toEqual([
    expect.objectContaining({ x: 40, y: 80, pressure: 0.3 }),
    expect.objectContaining({ x: 120, y: 160, pressure: 0.8 }),
    expect.objectContaining({ x: 160, y: 200, pressure: 0.6 }),
    expect.objectContaining({ x: 200, y: 240, pressure: 0.4 }),
  ]);
});

test("keeps a fixed writing canvas instead of growing under the Pencil", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[]} onSave={save} />);
  const canvas = screen.getByLabelText("手写画布") as HTMLCanvasElement;

  expect(canvas.style.height).toBe("2400px");
  pointer(canvas, "pointerdown", { pointerId: 12, pointerType: "pen", clientX: 20, clientY: 2_300, pressure: 0.5 });
  expect(canvas.style.height).toBe("2400px");
  pointer(canvas, "pointerup", { pointerId: 12, pointerType: "pen", clientX: 30, clientY: 2_320, pressure: 0.5 });

  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]?.[0][0].points).toEqual([
    expect.objectContaining({ x: 80, y: 9_200 }),
    expect.objectContaining({ x: 120, y: 9_280 }),
  ]);
});

test("locks the writing surface scroll position during a Pencil stroke", () => {
  render(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[]} onSave={vi.fn()} />);
  const canvas = screen.getByLabelText("手写画布");
  const surface = canvas.parentElement!;

  pointer(canvas, "pointerdown", { pointerId: 31, pointerType: "pen", clientX: 20, clientY: 30, pressure: 0.5 });
  surface.scrollTop = 180;
  fireEvent.scroll(surface);

  expect(surface.scrollTop).toBe(0);
});

test("expands for restored deep vectors and redraws them", () => {
  const deepStroke: InkStroke = {
    ...stroke,
    points: [
      { x: 10, y: 4_900, pressure: 0.5, elapsedMs: 0 },
      { x: 100, y: 5_000, pressure: 0.5, elapsedMs: 16 },
    ],
  };
  const context = document.createElement("canvas").getContext("2d") as unknown as {
    lineTo: ReturnType<typeof vi.fn>;
  };

  render(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[deepStroke]} onSave={vi.fn()} />);

  expect(screen.getByLabelText("手写画布")).toHaveStyle({ height: "2400px" });
  expect(context.lineTo).toHaveBeenCalledWith(100, 5_000);
});

test("keeps the fixed canvas height after a viewport width change", () => {
  let width = 512;
  let resize: ResizeObserverCallback | undefined;
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLCanvasElement) {
    const height = Number.parseFloat(this.style.height) || 720;
    return { left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) };
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  const deepStroke: InkStroke = {
    ...stroke,
    points: [
      { x: 10, y: 199_800, pressure: 0.5, elapsedMs: 0 },
      { x: 100, y: 199_900, pressure: 0.5, elapsedMs: 16 },
    ],
  };
  render(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[deepStroke]} onSave={vi.fn()} />);
  const canvas = screen.getByLabelText("手写画布") as HTMLCanvasElement;
  expect(canvas.style.height).toBe("2400px");

  width = 256;
  resize?.([], {} as ResizeObserver);
  expect(canvas.style.height).toBe("2400px");
});

test("persists an oversized Pencil gesture as valid ordered continuation strokes", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const save = vi.fn().mockResolvedValue(undefined);
  render(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[]} onSave={save} />);
  const canvas = screen.getByLabelText("手写画布");

  pointer(canvas, "pointerdown", { pointerId: 11, pointerType: "pen", clientX: 0, clientY: 20, pressure: 0.2 });
  for (let index = 1; index < INK_MAX_POINTS; index += 1) {
    pointer(canvas, "pointermove", {
      pointerId: 11,
      pointerType: "pen",
      clientX: index % 512,
      clientY: 20 + index / 100,
      pressure: (index % 10) / 10 || 1,
    });
  }
  pointer(canvas, "pointerup", { pointerId: 11, pointerType: "pen", clientX: 1, clientY: 41, pressure: 0.7 });

  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  const segments = save.mock.calls[0]?.[0] as InkStroke[];
  expect(segments.map((segment) => ({ id: segment.id, order: segment.order, count: segment.points.length }))).toEqual([
    { id: segments[0]!.id, order: 0, count: INK_MAX_POINTS },
    { id: segments[1]!.id, order: 1, count: 2 },
  ]);
  expect(segments[1]!.id).not.toBe(segments[0]!.id);
  expect(segments[1]!.points[0]).toEqual(segments[0]!.points.at(-1));
  expect(segments.flatMap((segment, index) => index === 0 ? segment.points : segment.points.slice(1))).toHaveLength(INK_MAX_POINTS + 1);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(canvas).toHaveAttribute("aria-disabled", "false");
});

test("retains every continuation and undo history when persistence echoes complete out of order", async () => {
  const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const saved: InkStroke[] = [];
  let receivedBatch = false;
  function Harness() {
    const [strokes, setStrokes] = useState<InkStroke[]>([]);
    return <>
      <span aria-label="笔画数量">{strokes.length}</span>
      <InkCanvas
        meetingId={stroke.meetingId}
        initialStrokes={strokes}
        onSave={async (value: InkStroke | InkStroke[]) => {
          receivedBatch = Array.isArray(value);
          const values = Array.isArray(value) ? value : [value];
          saved.push(...values);
          if (!Array.isArray(value)) await releases[value.order]?.promise;
          setStrokes((current) => [...current.filter((item) => !values.some((savedStroke) => savedStroke.id === item.id)), ...values]);
        }}
      />
    </>;
  }

  render(<Harness />);
  const canvas = screen.getByLabelText("手写画布");
  pointer(canvas, "pointerdown", { pointerId: 13, pointerType: "pen", clientX: 0, clientY: 20, pressure: 0.2 });
  for (let index = 1; index < INK_MAX_POINTS; index += 1) {
    pointer(canvas, "pointermove", {
      pointerId: 13,
      pointerType: "pen",
      clientX: index % 512,
      clientY: 20 + index / 100,
      pressure: 0.5,
    });
  }
  pointer(canvas, "pointerup", { pointerId: 13, pointerType: "pen", clientX: 1, clientY: 41, pressure: 0.7 });

  await waitFor(() => expect(saved).toHaveLength(2));
  releases[1]!.resolve();
  if (!receivedBatch) await waitFor(() => expect(screen.getByLabelText("笔画数量")).toHaveTextContent("1"));
  releases[0]!.resolve();
  await waitFor(() => expect(screen.getByLabelText("笔画数量")).toHaveTextContent("2"));

  expect(screen.getByRole("button", { name: "撤销" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "重做" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "重做" }));
  await waitFor(() => expect(saved).toHaveLength(4));
  expect(saved.slice(-2).map((value) => value.deleted)).toEqual([true, false]);
}, 10_000);

test("keeps undo and redo history when saved strokes echo through props", async () => {
  const saved: InkStroke[] = [];
  function Harness() {
    const [strokes, setStrokes] = useState<InkStroke[]>([]);
    return <InkCanvas
      meetingId={stroke.meetingId}
      initialStrokes={strokes}
      onSave={async (values) => {
        saved.push(...values);
        setStrokes((current) => [...current.filter((item) => !values.some((value) => value.id === item.id)), ...values]);
      }}
    />;
  }

  render(<Harness />);
  const canvas = screen.getByLabelText("手写画布");
  pointer(canvas, "pointerdown", { pointerId: 3, pointerType: "pen", clientX: 10, clientY: 20, pressure: 0.3 });
  pointer(canvas, "pointerup", { pointerId: 3, pointerType: "pen", clientX: 30, clientY: 40, pressure: 0.8 });

  await waitFor(() => expect(saved).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole("button", { name: "撤销" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  await waitFor(() => expect(saved).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "重做" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "重做" }));
  await waitFor(() => expect(saved).toHaveLength(3));

  expect(saved.map((value) => ({ deleted: value.deleted, version: value.version }))).toEqual([
    { deleted: false, version: 1 },
    { deleted: true, version: 2 },
    { deleted: false, version: 3 },
  ]);
});

test("selects highlighter and color through feature-complete controls", () => {
  render(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[]} onSave={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "荧光笔" }));
  fireEvent.click(screen.getByRole("button", { name: "红色" }));
  expect(screen.getByRole("button", { name: "荧光笔" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "红色" })).toHaveAttribute("aria-pressed", "true");
});

test("erases a whole stroke and supports undo and redo", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[stroke]} onSave={save} />);
  fireEvent.click(screen.getByRole("button", { name: "橡皮" }));
  pointer(screen.getByLabelText("手写画布"), "pointerdown", { pointerId: 2, pointerType: "pen", clientX: 15, clientY: 3, pressure: 0.5 });
  await waitFor(() => expect(save).toHaveBeenCalledWith([expect.objectContaining({ id: stroke.id, deleted: true, version: 2 })]));

  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith([expect.objectContaining({ id: stroke.id, deleted: false, version: 3 })]));
  fireEvent.click(screen.getByRole("button", { name: "重做" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith([expect.objectContaining({ id: stroke.id, deleted: true, version: 4 })]));
});

test("locks new input and reports when local persistence fails", async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error("disk")).mockResolvedValue(undefined);
  render(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[]} onSave={save} />);
  const canvas = screen.getByLabelText("手写画布");
  pointer(canvas, "pointerdown", { pointerId: 1, pointerType: "pen", clientX: 10, clientY: 20, pressure: 0.3 });
  pointer(canvas, "pointerup", { pointerId: 1, pointerType: "pen", clientX: 12, clientY: 22, pressure: 0.3 });
  expect(await screen.findByRole("alert")).toHaveTextContent("手写未保存");
  expect(canvas).toHaveAttribute("aria-disabled", "true");

  fireEvent.click(screen.getByRole("button", { name: "重试保存手写" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(canvas).toHaveAttribute("aria-disabled", "false");
});

test("commits a cancelled Pencil stroke at its last valid point", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[]} onSave={save} />);
  const canvas = screen.getByLabelText("手写画布");

  pointer(canvas, "pointerdown", { pointerId: 15, pointerType: "pen", clientX: 20, clientY: 30, pressure: 0.4 });
  pointer(canvas, "pointermove", { pointerId: 15, pointerType: "pen", clientX: 40, clientY: 50, pressure: 0.6 });
  pointer(canvas, "pointercancel", { pointerId: 15, pointerType: "pen", clientX: 0, clientY: 0, pressure: 0.5 });

  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  const saved = save.mock.calls[0]?.[0][0];
  expect(saved?.points.at(-1)).toMatchObject({ x: 160, y: 200, pressure: 0.6 });
});

test("keeps an active Pencil stroke when a palm pointer is cancelled", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[]} onSave={save} />);
  const canvas = screen.getByLabelText("手写画布");

  pointer(canvas, "pointerdown", { pointerId: 16, pointerType: "pen", clientX: 20, clientY: 30, pressure: 0.4 });
  pointer(canvas, "pointermove", { pointerId: 16, pointerType: "pen", clientX: 40, clientY: 50, pressure: 0.6 });
  pointer(canvas, "pointercancel", { pointerId: 28, pointerType: "touch", clientX: 0, clientY: 0, pressure: 0.5 });

  expect(save).not.toHaveBeenCalled();
  pointer(canvas, "pointermove", { pointerId: 16, pointerType: "pen", clientX: 60, clientY: 70, pressure: 0.7 });
  pointer(canvas, "pointerup", { pointerId: 16, pointerType: "pen", clientX: 80, clientY: 90, pressure: 0.5 });

  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]?.[0][0].points).toEqual(expect.arrayContaining([
    expect.objectContaining({ x: 240, y: 280, pressure: 0.7 }),
    expect.objectContaining({ x: 320, y: 360, pressure: 0.5 }),
  ]));
});

test("prevents palm touch gestures from scrolling the handwriting surface", () => {
  render(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[]} onSave={vi.fn()} />);
  const canvas = screen.getByLabelText("手写画布");

  const touch = pointer(canvas, "pointerdown", { pointerId: 29, pointerType: "touch", clientX: 20, clientY: 30, pressure: 0.5 });

  expect(touch.defaultPrevented).toBe(true);
});

test("locks the toolbar while a Pencil stroke is in progress", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[]} onSave={save} />);
  const canvas = screen.getByLabelText("手写画布");

  pointer(canvas, "pointerdown", { pointerId: 30, pointerType: "pen", clientX: 20, clientY: 30, pressure: 0.5 });
  expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
  expect(screen.getByLabelText("笔迹粗细")).toBeDisabled();

  pointer(canvas, "pointerup", { pointerId: 30, pointerType: "pen", clientX: 30, clientY: 40, pressure: 0.5 });
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(screen.getByLabelText("笔迹粗细")).toBeEnabled();
});

test("commits the active Pencil stroke when the page becomes hidden", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[]} onSave={save} />);
  const canvas = screen.getByLabelText("手写画布");
  pointer(canvas, "pointerdown", { pointerId: 7, pointerType: "pen", clientX: 10, clientY: 20, pressure: 0.4 });
  pointer(canvas, "pointermove", { pointerId: 7, pointerType: "pen", clientX: 40, clientY: 60, pressure: 0.8 });

  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  document.dispatchEvent(new Event("visibilitychange"));

  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]?.[0][0].points).toHaveLength(2);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

test("adopts remotely refreshed vectors without remounting", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const rendered = render(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[]} onSave={save} />);

  rendered.rerender(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[stroke]} onSave={save} />);
  fireEvent.click(screen.getByRole("button", { name: "橡皮" }));
  pointer(screen.getByLabelText("手写画布"), "pointerdown", { pointerId: 9, pointerType: "pen", clientX: 15, clientY: 3, pressure: 0.5 });

  await waitFor(() => expect(save).toHaveBeenCalledWith([expect.objectContaining({ id: stroke.id, deleted: true, version: 2 })]));
});

test("keeps backing pixels while hidden and redraws at the visible canvas width", () => {
  let width = 512;
  let resize: ResizeObserverCallback | undefined;
  const context = document.createElement("canvas").getContext("2d") as unknown as {
    clearRect: ReturnType<typeof vi.fn>;
    stroke: ReturnType<typeof vi.fn>;
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    left: 0, top: 0, width, height: width === 0 ? 0 : 720, right: width, bottom: width === 0 ? 0 : 720,
    x: 0, y: 0, toJSON: () => ({}),
  }));
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {}
    disconnect() {}
  });

  render(<InkCanvas meetingId={stroke.meetingId} initialStrokes={[stroke]} onSave={vi.fn()} />);
  const canvas = screen.getByLabelText("手写画布") as HTMLCanvasElement;
  expect(canvas.width).toBe(512);
  expect(context.stroke).toHaveBeenCalled();
  const strokesBeforeHide = context.stroke.mock.calls.length;

  width = 0;
  fireEvent(window, new Event("resize"));
  expect(canvas.width).toBe(512);

  width = 744;
  resize?.([], {} as ResizeObserver);
  expect(canvas.width).toBe(744);
  expect(context.clearRect).toHaveBeenCalled();
  expect(context.stroke.mock.calls.length).toBeGreaterThan(strokesBeforeHide);
});
