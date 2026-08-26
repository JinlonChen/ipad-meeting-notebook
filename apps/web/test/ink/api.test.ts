import { describe, expect, test, vi } from "vitest";

import type { InkStroke } from "@meeting/contracts";
import { SupabaseInkApi } from "../../src/ink/api.js";

const userId = "00000000-0000-4000-8000-00000000000a";
const meetingId = "00000000-0000-4000-8000-000000000001";
const stroke: InkStroke = {
  id: "00000000-0000-4000-8000-000000000002",
  meetingId,
  order: 3,
  tool: "pen",
  color: "#1d2529",
  width: 4,
  points: [{ x: 10, y: 20, pressure: 0.5, elapsedMs: 0 }, { x: 20, y: 30, pressure: 0.7, elapsedMs: 16 }],
  deleted: false,
  version: 1,
};

describe("SupabaseInkApi", () => {
  test("applies an actor-bound idempotent mutation", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: stroke, error: null });
    const api = new SupabaseInkApi({ rpc } as never);
    const mutation = { strokeId: stroke.id, mutationId: crypto.randomUUID(), stroke, createdAt: new Date().toISOString() };

    await expect(api.apply(mutation, userId)).resolves.toEqual(stroke);
    expect(rpc).toHaveBeenCalledWith("apply_meeting_ink_mutation", {
      p_mutation_id: mutation.mutationId,
      p_stroke: stroke,
      p_expected_user_id: userId,
    });
  });

  test("lists and maps owner-filtered rows in stroke order", async () => {
    const order = vi.fn().mockResolvedValue({ data: [{
      id: stroke.id,
      meeting_id: meetingId,
      stroke_order: 3,
      tool: "pen",
      color: "#1d2529",
      width: 4,
      points: stroke.points,
      version: 1,
      deleted_at: null,
    }], error: null });
    const eq = vi.fn().mockReturnValue({ order });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    const api = new SupabaseInkApi({ from } as never);

    await expect(api.list(meetingId)).resolves.toEqual([stroke]);
    expect(from).toHaveBeenCalledWith("meeting_ink_strokes");
    expect(eq).toHaveBeenCalledWith("meeting_id", meetingId);
    expect(order).toHaveBeenCalledWith("stroke_order");
  });

  test("rejects malformed RPC data without exposing provider errors", async () => {
    const api = new SupabaseInkApi({ rpc: vi.fn().mockResolvedValue({ data: { ...stroke, width: 99 }, error: null }) } as never);
    await expect(api.apply({ strokeId: stroke.id, mutationId: crypto.randomUUID(), stroke, createdAt: new Date().toISOString() }, userId))
      .rejects.toThrow("INK_REQUEST_FAILED");
  });
});
