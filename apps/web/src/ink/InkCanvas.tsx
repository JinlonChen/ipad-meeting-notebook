import { INK_LOGICAL_WIDTH, type InkPoint, type InkStroke } from "@meeting/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { InkToolbar, type InkTool } from "./InkToolbar.js";
import {
  applyInkAction,
  createInkHistory,
  hitStroke,
  pressureWidth,
  redoInkAction,
  splitLongStroke,
  toLogicalPoint,
  undoInkAction,
  type InkHistory,
} from "./model.js";

type Draft = { pointerId: number; startedAt: number; stroke: InkStroke };
const INK_CANVAS_DEFAULT_HEIGHT = 2_400;

function strokeRevision(strokes: InkStroke[]): string {
  return JSON.stringify([...strokes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(singleStrokeRevision));
}

function singleStrokeRevision(stroke: InkStroke): string {
  return JSON.stringify([
    stroke.id, stroke.meetingId, stroke.order, stroke.tool, stroke.color, stroke.width, stroke.deleted, stroke.version,
    stroke.points.map((point) => [point.x, point.y, point.pressure, point.elapsedMs]),
  ]);
}

function drawStroke(context: CanvasRenderingContext2D, stroke: InkStroke): void {
  if (stroke.deleted) return;
  context.strokeStyle = stroke.color;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.globalAlpha = stroke.tool === "highlighter" ? 0.28 : 1;
  for (let index = 1; index < stroke.points.length; index += 1) {
    const before = stroke.points[index - 1]!;
    const point = stroke.points[index]!;
    context.beginPath();
    context.moveTo(before.x, before.y);
    context.lineTo(point.x, point.y);
    context.lineWidth = pressureWidth(stroke.width, point.pressure, stroke.tool);
    context.stroke();
  }
  context.globalAlpha = 1;
}

export function InkCanvas({ meetingId, initialStrokes, onSave }: {
  meetingId: string;
  initialStrokes: InkStroke[];
  onSave(strokes: InkStroke[]): Promise<void>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<Draft | null>(null);
  const lockedScrollTopRef = useRef<number | null>(null);
  const versionsRef = useRef(new Map(initialStrokes.map((stroke) => [stroke.id, stroke.version])));
  const localEchoesRef = useRef(new Map<string, string>());
  const failedStrokesRef = useRef<InkStroke[] | null>(null);
  const incomingRevisionRef = useRef(strokeRevision(initialStrokes));
  const [history, setHistory] = useState<InkHistory>(() => createInkHistory(initialStrokes));
  const historyRef = useRef(history);
  const [canvasHeight] = useState(INK_CANVAS_DEFAULT_HEIGHT);
  const canvasHeightRef = useRef(canvasHeight);
  const [tool, setTool] = useState<InkTool>("pen");
  const [color, setColor] = useState("#1d2529");
  const [width, setWidth] = useState(4);
  const [error, setError] = useState("");
  const [isWriting, setIsWriting] = useState(false);
  const [scrollPosition, setScrollPosition] = useState(0);
  const [scrollMaximum, setScrollMaximum] = useState(0);
  historyRef.current = history;
  canvasHeightRef.current = canvasHeight;

  const updateScrollMetrics = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    setScrollMaximum(Math.max(0, surface.scrollHeight - surface.clientHeight));
    setScrollPosition(surface.scrollTop);
  }, []);

  useEffect(() => {
    const revision = strokeRevision(initialStrokes);
    if (revision === incomingRevisionRef.current) return;
    incomingRevisionRef.current = revision;
    versionsRef.current = new Map(initialStrokes.map((stroke) => [stroke.id, stroke.version]));
    if (revision === strokeRevision(historyRef.current.strokes)) {
      for (const stroke of initialStrokes) {
        if (localEchoesRef.current.get(stroke.id) === singleStrokeRevision(stroke)) localEchoesRef.current.delete(stroke.id);
      }
      return;
    }
    const isLocalEcho = initialStrokes.every((stroke) =>
      localEchoesRef.current.get(stroke.id) === singleStrokeRevision(stroke)
      || historyRef.current.strokes.some((current) => singleStrokeRevision(current) === singleStrokeRevision(stroke)),
    ) && historyRef.current.strokes.every((stroke) =>
      initialStrokes.some((incoming) => singleStrokeRevision(incoming) === singleStrokeRevision(stroke)),
    );
    if (isLocalEcho) {
      for (const stroke of initialStrokes) {
        if (localEchoesRef.current.get(stroke.id) === singleStrokeRevision(stroke)) localEchoesRef.current.delete(stroke.id);
      }
      return;
    }
    setHistory(createInkHistory(initialStrokes));
  }, [initialStrokes]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const cssHeight = canvasHeightRef.current;
    canvas.width = Math.max(1, Math.round(bounds.width * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    const scale = bounds.width / INK_LOGICAL_WIDTH;
    context.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    context.clearRect(0, 0, INK_LOGICAL_WIDTH, cssHeight / scale);
    for (const stroke of historyRef.current.strokes) drawStroke(context, stroke);
    if (draftRef.current) drawStroke(context, draftRef.current.stroke);
  }, []);

  const resizeAndRedraw = useCallback(() => {
    const canvas = canvasRef.current;
    const bounds = canvas?.getBoundingClientRect();
    if (!canvas || !bounds || bounds.width <= 0) return;
    redraw();
    updateScrollMetrics();
  }, [redraw, updateScrollMetrics]);

  useEffect(() => {
    resizeAndRedraw();
    const frame = requestAnimationFrame(updateScrollMetrics);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resizeAndRedraw);
    if (canvasRef.current) resizeObserver?.observe(canvasRef.current);
    window.addEventListener("resize", resizeAndRedraw);
    return () => {
      resizeObserver?.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resizeAndRedraw);
    };
  }, [resizeAndRedraw, updateScrollMetrics]);

  useEffect(() => {
    redraw();
  }, [history, redraw]);

  const nextVersion = (id: string): number => {
    const version = (versionsRef.current.get(id) ?? 0) + 1;
    versionsRef.current.set(id, version);
    return version;
  };

  const persist = useCallback(async (strokes: InkStroke[]): Promise<boolean> => {
    const revisions = strokes.map((stroke) => [stroke.id, singleStrokeRevision(stroke)] as const);
    for (const [id, revision] of revisions) localEchoesRef.current.set(id, revision);
    try {
      await onSave(strokes);
      failedStrokesRef.current = null;
      setError("");
      return true;
    } catch {
      for (const [id, revision] of revisions) {
        if (localEchoesRef.current.get(id) === revision) localEchoesRef.current.delete(id);
      }
      failedStrokesRef.current = strokes;
      setError("手写未保存，请重试");
      return false;
    }
  }, [onSave]);

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>, startedAt: number): InkPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return toLogicalPoint(event, bounds, performance.now() - startedAt);
  };

  const erase = async (point: InkPoint) => {
    const target = [...historyRef.current.strokes].reverse().find((stroke) => hitStroke(stroke, point, 18));
    if (!target) return;
    const deleted = { ...target, deleted: true, version: nextVersion(target.id) };
    setHistory((current) => applyInkAction(current, { kind: "put", before: target, after: deleted }));
    await persist([deleted]);
  };

  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    if (event.pointerType === "touch") {
      return;
    }
    if (error) return;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // iPad Safari can reject pointer capture for a Pencil cancellation; the stroke itself remains valid.
    }
    const startedAt = performance.now();
    const point = pointFromEvent(event, startedAt);
    if (tool === "eraser") {
      void erase(point);
      return;
    }
    lockedScrollTopRef.current = surfaceRef.current?.scrollTop ?? 0;
    setIsWriting(true);
    draftRef.current = {
      pointerId: event.pointerId,
      startedAt,
      stroke: {
        id: crypto.randomUUID(), meetingId, order: Math.max(-1, ...historyRef.current.strokes.map((stroke) => stroke.order)) + 1,
        tool, color, width: tool === "highlighter" ? Math.max(10, width) : width,
        points: [point, point], deleted: false, version: 1,
      },
    };
    redraw();
  };

  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    if (event.pointerType === "touch") {
      return;
    }
    const draft = draftRef.current;
    if (!draft || draft.pointerId !== event.pointerId) return;
    const point = pointFromEvent(event, draft.startedAt);
    const points = draft.stroke.points;
    draft.stroke = {
      ...draft.stroke,
      points: points.length === 2 && points[0] === points[1] ? [points[0]!, point] : [...points, point],
    };
    redraw();
  };

  const finishDraft = useCallback(async (point?: InkPoint) => {
    const draft = draftRef.current;
    if (!draft) return;
    const points = [...draft.stroke.points];
    if (point) {
      if (points.length === 2 && points[0] === points[1]) points[1] = point;
      else if (points.at(-1)?.x !== point.x || points.at(-1)?.y !== point.y) points.push(point);
    }
    const strokes = splitLongStroke({ ...draft.stroke, points }, () => crypto.randomUUID());
    draftRef.current = null;
    lockedScrollTopRef.current = null;
    setIsWriting(false);
    for (const stroke of strokes) versionsRef.current.set(stroke.id, 1);
    setHistory((current) => strokes.reduce(
      (next, stroke) => applyInkAction(next, { kind: "put", before: null, after: stroke }),
      current,
    ));
    await persist(strokes);
  }, [persist]);

  const finishPointer = async (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const draft = draftRef.current;
    if (!draft || draft.pointerId !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Safari can have already released capture when a Pencil leaves the screen.
    }
    await finishDraft(pointFromEvent(event, draft.startedAt));
  };

  const cancelPointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Safari can have already released capture for a cancelled Pencil gesture.
    }
    if (draftRef.current?.pointerId === event.pointerId) void finishDraft();
  };

  const keepSurfaceStationary = () => {
    const surface = surfaceRef.current;
    const lockedScrollTop = lockedScrollTopRef.current;
    if (surface && lockedScrollTop !== null && surface.scrollTop !== lockedScrollTop) {
      surface.scrollTop = lockedScrollTop;
      return;
    }
    if (surface) setScrollPosition(surface.scrollTop);
  };

  const setSurfaceScroll = (value: number) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    surface.scrollTop = value;
    setScrollPosition(value);
  };

  useEffect(() => {
    const commitWhenHidden = () => {
      if (document.hidden) void finishDraft();
    };
    const commitBeforeUnload = () => { void finishDraft(); };
    document.addEventListener("visibilitychange", commitWhenHidden);
    window.addEventListener("pagehide", commitBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", commitWhenHidden);
      window.removeEventListener("pagehide", commitBeforeUnload);
    };
  }, [finishDraft]);

  useEffect(() => {
    const editor = canvasRef.current?.closest<HTMLElement>(".ink-editor");
    if (!editor) return;
    const isVisible = () => !editor.closest("[hidden]");
    const preventBrowserSelection = (event: Event) => {
      if (isVisible()) event.preventDefault();
    };
    document.addEventListener("contextmenu", preventBrowserSelection, true);
    document.addEventListener("selectstart", preventBrowserSelection, true);
    document.addEventListener("dragstart", preventBrowserSelection, true);
    document.addEventListener("gesturestart", preventBrowserSelection, true);
    return () => {
      document.removeEventListener("contextmenu", preventBrowserSelection, true);
      document.removeEventListener("selectstart", preventBrowserSelection, true);
      document.removeEventListener("dragstart", preventBrowserSelection, true);
      document.removeEventListener("gesturestart", preventBrowserSelection, true);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const preventSafariGesture = (event: TouchEvent) => event.preventDefault();
    const preventPointerGesture = (event: PointerEvent) => event.preventDefault();
    canvas.addEventListener("touchstart", preventSafariGesture, { passive: false });
    canvas.addEventListener("touchmove", preventSafariGesture, { passive: false });
    canvas.addEventListener("touchend", preventSafariGesture, { passive: false });
    canvas.addEventListener("touchcancel", preventSafariGesture, { passive: false });
    canvas.addEventListener("pointerdown", preventPointerGesture, { capture: true, passive: false });
    canvas.addEventListener("pointermove", preventPointerGesture, { capture: true, passive: false });
    return () => {
      canvas.removeEventListener("touchstart", preventSafariGesture);
      canvas.removeEventListener("touchmove", preventSafariGesture);
      canvas.removeEventListener("touchend", preventSafariGesture);
      canvas.removeEventListener("touchcancel", preventSafariGesture);
      canvas.removeEventListener("pointerdown", preventPointerGesture, true);
      canvas.removeEventListener("pointermove", preventPointerGesture, true);
    };
  }, []);

  const undo = async () => {
    const action = historyRef.current.undo.at(-1);
    if (!action) return;
    const next = undoInkAction(historyRef.current);
    const restored = action.before
      ? { ...action.before, version: nextVersion(action.after.id) }
      : { ...action.after, deleted: true, version: nextVersion(action.after.id) };
    setHistory({ ...next, strokes: action.before ? next.strokes.map((item) => item.id === restored.id ? restored : item) : next.strokes });
    await persist([restored]);
  };

  const redo = async () => {
    const action = historyRef.current.redo.at(-1);
    if (!action) return;
    const restored = { ...action.after, version: nextVersion(action.after.id) };
    const next = redoInkAction(historyRef.current);
    setHistory({ ...next, strokes: next.strokes.map((item) => item.id === restored.id ? restored : item) });
    await persist([restored]);
  };

  const retrySave = async () => {
    const failed = failedStrokesRef.current;
    if (failed) await persist(failed);
  };

  return <section className="ink-editor" aria-label="手写笔记" data-writing={isWriting ? "true" : "false"}>
    <InkToolbar
      tool={tool} color={color} width={width} canUndo={history.undo.length > 0} canRedo={history.redo.length > 0} disabled={Boolean(error) || isWriting}
      onTool={setTool} onColor={setColor} onWidth={setWidth} onUndo={() => void undo()} onRedo={() => void redo()}
    />
    <div className="ink-surface-frame">
      <div ref={surfaceRef} className="ink-surface" onScroll={keepSurfaceStationary}>
        <canvas
          ref={canvasRef}
          className="ink-canvas"
          style={{ height: `${canvasHeight}px` }}
          aria-label="手写画布"
          aria-disabled={Boolean(error)}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={(event) => void finishPointer(event)}
          onPointerCancel={cancelPointer}
        />
      </div>
      <input
        className="ink-scrollbar"
        aria-label="画布滚动"
        type="range"
        min="0"
        max={scrollMaximum}
        step="1"
        value={Math.min(scrollPosition, scrollMaximum)}
        disabled={isWriting}
        onChange={(event) => setSurfaceScroll(Number(event.target.value))}
      />
    </div>
    {error && <div className="ink-error" role="alert"><span>{error}</span><button className="text-button" onClick={() => void retrySave()}>重试保存手写</button></div>}
  </section>;
}
