import { INK_LOGICAL_HEIGHT, INK_LOGICAL_WIDTH, INK_MAX_POINTS, type InkPoint, type InkStroke } from "@meeting/contracts";

export type InkAction = { kind: "put"; before: InkStroke | null; after: InkStroke };
export type InkHistory = { strokes: InkStroke[]; undo: InkAction[]; redo: InkAction[] };

export const INK_CANVAS_MIN_HEIGHT = 720;
export const INK_CANVAS_GROWTH_STEP = 480;
export const INK_CANVAS_BOTTOM_PADDING = 96;

function maximumCanvasHeight(scale: number): number {
  return INK_LOGICAL_HEIGHT * scale;
}

export function nextInkCanvasHeight(currentHeight: number, pointY: number, scale: number): number {
  if (scale <= 0 || pointY * scale < currentHeight - INK_CANVAS_BOTTOM_PADDING) return currentHeight;
  return Math.min(maximumCanvasHeight(scale), currentHeight + INK_CANVAS_GROWTH_STEP);
}

export function inkCanvasHeightForStrokes(strokes: InkStroke[], scale: number): number {
  if (scale <= 0) return INK_CANVAS_MIN_HEIGHT;
  const deepestPoint = Math.max(0, ...strokes
    .filter((stroke) => !stroke.deleted)
    .flatMap((stroke) => stroke.points.map((point) => point.y)));
  const requiredHeight = deepestPoint * scale + INK_CANVAS_BOTTOM_PADDING;
  const steppedHeight = Math.ceil(requiredHeight / INK_CANVAS_GROWTH_STEP) * INK_CANVAS_GROWTH_STEP;
  return Math.min(maximumCanvasHeight(scale), Math.max(INK_CANVAS_MIN_HEIGHT, steppedHeight));
}

export function inkCanvasHeightAfterResize(currentHeight: number, strokes: InkStroke[], scale: number): number {
  const requiredHeight = inkCanvasHeightForStrokes(strokes, scale);
  return Math.max(requiredHeight, Math.min(currentHeight, maximumCanvasHeight(scale)));
}

export function pressureWidth(base: number, pressure: number, tool: InkStroke["tool"]): number {
  if (tool === "highlighter") return Math.min(40, Math.max(1, base));
  return Math.min(40, Math.max(1, base * (0.5 + Math.min(1, Math.max(0, pressure)))));
}

export function toLogicalPoint(
  input: { clientX: number; clientY: number; pressure: number },
  bounds: { left: number; top: number; width: number },
  elapsedMs: number,
): InkPoint {
  const scale = INK_LOGICAL_WIDTH / bounds.width;
  return {
    x: (input.clientX - bounds.left) * scale,
    y: (input.clientY - bounds.top) * scale,
    pressure: input.pressure > 0 ? input.pressure : 0.5,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
  };
}

function distanceToSegment(point: { x: number; y: number }, start: InkPoint, end: InkPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const position = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + position * dx), point.y - (start.y + position * dy));
}

export function hitStroke(stroke: InkStroke, point: { x: number; y: number }, radius: number): boolean {
  if (stroke.deleted) return false;
  for (let index = 1; index < stroke.points.length; index += 1) {
    if (distanceToSegment(point, stroke.points[index - 1]!, stroke.points[index]!) <= radius + stroke.width / 2) return true;
  }
  return false;
}

export function splitLongStroke(stroke: InkStroke, createId: () => string): InkStroke[] {
  if (stroke.points.length <= INK_MAX_POINTS) return [stroke];
  const segments: InkStroke[] = [];
  let pointIndex = 0;
  while (pointIndex < stroke.points.length - 1) {
    const points = stroke.points.slice(pointIndex, pointIndex + INK_MAX_POINTS);
    segments.push({
      ...stroke,
      id: segments.length === 0 ? stroke.id : createId(),
      order: stroke.order + segments.length,
      points,
    });
    pointIndex += points.length - 1;
  }
  return segments;
}

function put(strokes: InkStroke[], value: InkStroke | null, id: string): InkStroke[] {
  const next = strokes.filter((stroke) => stroke.id !== id);
  if (value) next.push(value);
  return next.sort((left, right) => left.order - right.order);
}

export function createInkHistory(strokes: InkStroke[]): InkHistory {
  return { strokes: [...strokes].sort((left, right) => left.order - right.order), undo: [], redo: [] };
}

export function applyInkAction(history: InkHistory, action: InkAction): InkHistory {
  return { strokes: put(history.strokes, action.after, action.after.id), undo: [...history.undo, action], redo: [] };
}

export function undoInkAction(history: InkHistory): InkHistory {
  const action = history.undo.at(-1);
  if (!action) return history;
  return {
    strokes: put(history.strokes, action.before, action.after.id),
    undo: history.undo.slice(0, -1),
    redo: [...history.redo, action],
  };
}

export function redoInkAction(history: InkHistory): InkHistory {
  const action = history.redo.at(-1);
  if (!action) return history;
  return {
    strokes: put(history.strokes, action.after, action.after.id),
    undo: [...history.undo, action],
    redo: history.redo.slice(0, -1),
  };
}
