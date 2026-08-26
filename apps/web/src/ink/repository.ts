import { InkStrokeSchema, type InkStroke } from "@meeting/contracts";
import type { MeetingCatalogDatabase, LocalInkMutation } from "../meetings/local-db.js";

export class InkRepository {
  constructor(private readonly database: () => MeetingCatalogDatabase) {}

  async save(value: InkStroke): Promise<LocalInkMutation> {
    const [mutation] = await this.saveMany([value]);
    return mutation!;
  }

  async saveMany(values: InkStroke[]): Promise<LocalInkMutation[]> {
    const strokes = values.map((value) => InkStrokeSchema.parse(value));
    const createdAt = new Date().toISOString();
    const mutations: LocalInkMutation[] = strokes.map((stroke) => ({
      strokeId: stroke.id,
      mutationId: crypto.randomUUID(),
      stroke,
      createdAt,
    }));
    if (strokes.length === 0) return [];
    const database = this.database();
    await database.transaction("rw", database.inkStrokes, database.inkOutbox, async () => {
      await database.inkStrokes.bulkPut(strokes);
      await database.inkOutbox.bulkPut(mutations);
    });
    return mutations;
  }

  async list(meetingId: string, includeDeleted = false): Promise<InkStroke[]> {
    const values = await this.database().inkStrokes.where("meetingId").equals(meetingId).sortBy("order");
    return includeDeleted ? values : values.filter((stroke) => !stroke.deleted);
  }

  pending(): Promise<LocalInkMutation[]> {
    return this.database().inkOutbox.orderBy("createdAt").toArray();
  }

  async acceptAcknowledged(value: InkStroke, mutationId: string): Promise<void> {
    const stroke = InkStrokeSchema.parse(value);
    const database = this.database();
    await database.transaction("rw", database.inkStrokes, database.inkOutbox, async () => {
      const currentMutation = await database.inkOutbox.get(stroke.id);
      if (currentMutation?.mutationId !== mutationId) return;
      const local = await database.inkStrokes.get(stroke.id);
      if (!local || stroke.version >= local.version) await database.inkStrokes.put(stroke);
      await database.inkOutbox.delete(stroke.id);
    });
  }

  async acceptRemote(value: InkStroke): Promise<void> {
    const stroke = InkStrokeSchema.parse(value);
    const database = this.database();
    await database.transaction("rw", database.inkStrokes, database.inkOutbox, async () => {
      if (await database.inkOutbox.get(stroke.id)) return;
      const local = await database.inkStrokes.get(stroke.id);
      if (!local || stroke.version >= local.version) await database.inkStrokes.put(stroke);
    });
  }
}
