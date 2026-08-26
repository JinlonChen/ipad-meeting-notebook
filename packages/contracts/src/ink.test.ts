import { describe, expect, test } from "vitest";

import { InkMutationSchema, InkStrokeSchema } from "./ink.js";

const stroke = {
  id: "00000000-0000-4000-8000-000000000001",
  meetingId: "00000000-0000-4000-8000-000000000002",
  order: 0,
  tool: "pen",
  color: "#1d2529",
  width: 4,
  points: [
    { x: 10, y: 20, pressure: 0.4, elapsedMs: 0 },
    { x: 12, y: 24, pressure: 0.7, elapsedMs: 16 },
  ],
  deleted: false,
  version: 1,
};

describe("InkStrokeSchema", () => {
  test("accepts a bounded vector stroke", () => {
    expect(InkStrokeSchema.parse(stroke)).toEqual(stroke);
  });

  test("rejects unsafe visual values and oversized paths", () => {
    expect(() => InkStrokeSchema.parse({ ...stroke, color: "red" })).toThrow();
    expect(() => InkStrokeSchema.parse({ ...stroke, width: 0 })).toThrow();
    expect(() => InkStrokeSchema.parse({ ...stroke, points: Array(2_049).fill(stroke.points[0]) })).toThrow();
    expect(() => InkStrokeSchema.parse({ ...stroke, points: [{ ...stroke.points[0], pressure: 2 }] })).toThrow();
    expect(() => InkStrokeSchema.parse({ ...stroke, points: [{ ...stroke.points[0], x: 3_000 }] })).toThrow();
  });
});

describe("InkMutationSchema", () => {
  test("requires a stable mutation id and strict stroke payload", () => {
    const mutation = {
      mutationId: "00000000-0000-4000-8000-000000000003",
      stroke,
    };
    expect(InkMutationSchema.parse(mutation)).toEqual(mutation);
    expect(() => InkMutationSchema.parse({ ...mutation, unexpected: true })).toThrow();
  });
});
