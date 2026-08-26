import { InkStrokeSchema, type InkStroke } from "@meeting/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { LocalInkMutation } from "../meetings/local-db.js";
import type { Database, MeetingInkStrokeRow } from "../supabase/types.js";
import type { InkApiPort } from "./sync.js";

function failed(): Error {
  return new Error("INK_REQUEST_FAILED");
}

type SelectedInkRow = Pick<MeetingInkStrokeRow,
  "id" | "meeting_id" | "stroke_order" | "tool" | "color" | "width" | "points" | "version" | "deleted_at"
>;

function fromRow(row: SelectedInkRow): InkStroke {
  return InkStrokeSchema.parse({
    id: row.id,
    meetingId: row.meeting_id,
    order: row.stroke_order,
    tool: row.tool,
    color: row.color,
    width: row.width,
    points: row.points,
    deleted: row.deleted_at !== null,
    version: row.version,
  });
}

export class SupabaseInkApi implements InkApiPort {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async apply(mutation: LocalInkMutation, expectedUserId: string): Promise<InkStroke> {
    const { data, error } = await this.client.rpc("apply_meeting_ink_mutation", {
      p_mutation_id: mutation.mutationId,
      p_stroke: mutation.stroke,
      p_expected_user_id: expectedUserId,
    });
    if (error) throw failed();
    try {
      return InkStrokeSchema.parse(data);
    } catch {
      throw failed();
    }
  }

  async list(meetingId: string): Promise<InkStroke[]> {
    const { data, error } = await this.client
      .from("meeting_ink_strokes")
      .select("id,meeting_id,stroke_order,tool,color,width,points,version,deleted_at")
      .eq("meeting_id", meetingId)
      .order("stroke_order");
    if (error) throw failed();
    try {
      return (data ?? []).map((row) => fromRow(row));
    } catch {
      throw failed();
    }
  }
}
