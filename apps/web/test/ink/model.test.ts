import { describe, expect, test } from "vitest";

import { INK_LOGICAL_HEIGHT, INK_MAX_POINTS, type InkStroke } from "@meeting/contracts";
import {
  applyInkAction,
  createInkHistory,
  hitStroke,
  inkCanvasHeightAfterResize,
  inkCanvasHeightForStrokes,
  nextInkCanvasHeight,
  pressureWidth,
  redoInkAction,
  splitLongStroke,
  toLogicalPoint,
  undoInkAction,
} from "../../src/ink/model.js";

const stroke: InkStroke = {
  id: "00000000-0000-4000-8000-000000000001",
  meetingId: "00000000-0000-4000-8000-000000000002",
  order: 0, tool: "pen", color: "#1d2529", width: 4,
  points: [{ x: 10, y: 10, pressure: 0.5, elapsedMs: 0 }, { x: 100, y: 10, pressure: 0.5, elapsedMs: 16 }],
  deleted: false, version: 1,
};

describe("ink geometry", () => {
  test("maps pressure to bounded pen width and keeps highlighter width fixed", () => {
    expect(pressureWidth(4, 0, "pen")).toBe(2);
    expect(pressureWidth(4, 1, "pen")).toBe(6);
    expect(pressureWidth(40, 1, "pen")).toBe(40);
    expect(pressureWidth(12, 0.1, "highlighter")).toBe(12);
  });

  test("maps screen coordinates into the fixed logical canvas", () => {
    expect(toLogicalPoint({ clientX: 110, clientY: 70, pressure: 0.7 }, { left: 10, top: 20, width: 512 }, 25)).toEqual({
      x: 400, y: 200, pressure: 0.7, elapsedMs: 25,
    });
  });

  test("hits the whole stroke near a line segment", () => {
    expect(hitStroke(stroke, { x: 50, y: 14 }, 6)).toBe(true);
    expect(hitStroke(stroke, { x: 50, y: 40 }, 6)).toBe(false);
  });

  test("grows the rendered canvas near its logical bottom and caps it at the contract limit", () => {
    const scale = 0.25;
    expect(nextInkCanvasHeight(720, 2_000, scale)).toBe(720);
    expect(nextInkCanvasHeight(720, 2_500, scale)).toBe(1_200);
    expect(nextInkCanvasHeight(49_800, 199_900, scale)).toBe(INK_LOGICAL_HEIGHT * scale);
  });

  test("restores enough canvas height for deep vectors with bottom padding", () => {
    const deepStroke = {
      ...stroke,
      points: [
        { x: 10, y: 4_900, pressure: 0.5, elapsedMs: 0 },
        { x: 100, y: 5_000, pressure: 0.5, elapsedMs: 16 },
      ],
    };

    expect(inkCanvasHeightForStrokes([], 0.25)).toBe(720);
    expect(inkCanvasHeightForStrokes([deepStroke], 0.25)).toBe(1_440);
  });

  test("clamps a deep canvas to the logical limit after its width shrinks", () => {
    const deepestStroke = {
      ...stroke,
      points: [
        { x: 10, y: 199_800, pressure: 0.5, elapsedMs: 0 },
        { x: 100, y: 199_900, pressure: 0.5, elapsedMs: 16 },
      ],
    };

    expect(inkCanvasHeightAfterResize(50_000, [deepestStroke], 0.125)).toBe(25_000);
    expect(inkCanvasHeightAfterResize(720, [{ ...stroke, points: deepestStroke.points.map((point) => ({ ...point, y: point.y / 40 })) }], 0.25)).toBe(1_440);
    expect(inkCanvasHeightAfterResize(2_000, [stroke], 0.25)).toBe(2_000);
  });

  test("splits long gestures into ordered continuous strokes without losing samples", () => {
    const points = Array.from({ length: INK_MAX_POINTS * 2 + 7 }, (_, index) => ({
      x: index % 2_049,
      y: index,
      pressure: (index % 11) / 10,
      elapsedMs: index * 3,
    }));
    const continuationIds = [
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
    ];

    const segments = splitLongStroke({ ...stroke, order: 8, points }, () => continuationIds.shift()!);

    expect(segments.map(({ id, order, points: segmentPoints }) => ({ id, order, count: segmentPoints.length }))).toEqual([
      { id: stroke.id, order: 8, count: INK_MAX_POINTS },
      { id: "00000000-0000-4000-8000-000000000011", order: 9, count: INK_MAX_POINTS },
      { id: "00000000-0000-4000-8000-000000000012", order: 10, count: 9 },
    ]);
    expect(segments.every((segment) => segment.points.length >= 2 && segment.points.length <= INK_MAX_POINTS)).toBe(true);
    expect(segments.slice(1).every((segment, index) => segment.points[0] === segments[index]!.points.at(-1))).toBe(true);
    expect(segments.flatMap((segment, index) => index === 0 ? segment.points : segment.points.slice(1))).toEqual(points);
  });
});

describe("ink history", () => {
  test("undoes and redoes an added stroke", () => {
    const added = applyInkAction(createInkHistory([]), { kind: "put", before: null, after: stroke });
    expect(added.strokes).toEqual([stroke]);
    const undone = undoInkAction(added);
    expect(undone.strokes).toEqual([]);
    expect(redoInkAction(undone).strokes).toEqual([stroke]);
  });

  test("undoes a tombstone and clears redo after a new action", () => {
    const initial = createInkHistory([stroke]);
    const deleted = { ...stroke, deleted: true, version: 2 };
    const erased = applyInkAction(initial, { kind: "put", before: stroke, after: deleted });
    const restored = undoInkAction(erased);
    expect(restored.strokes[0]?.deleted).toBe(false);
    const replacement = { ...stroke, color: "#a6473c", version: 2 };
    expect(applyInkAction(restored, { kind: "put", before: stroke, after: replacement }).redo).toEqual([]);
  });
});
