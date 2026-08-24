import { z } from "zod";

const UuidSchema = z.uuid();
const NonNegativeIntegerSchema = z.int().nonnegative();
const SegmentTextSchema = z.string().trim().min(1).max(20_000);
const EvidenceSegmentIdsSchema = z.array(UuidSchema).max(100);

export const TranscriptSourceSchema = z.enum(["asr", "edited"]);

export const TranscriptSegmentSchema = z.object({
  id: UuidSchema,
  meetingId: UuidSchema,
  position: NonNegativeIntegerSchema,
  text: SegmentTextSchema,
  startedOffsetMs: NonNegativeIntegerSchema,
  endedOffsetMs: NonNegativeIntegerSchema,
  speaker: z.string().trim().min(1).max(120).nullable(),
  source: TranscriptSourceSchema,
  confidence: z.number().min(0).max(1).nullable(),
}).strict().superRefine((value, context) => {
  if (value.endedOffsetMs <= value.startedOffsetMs) {
    context.addIssue({ code: "custom", path: ["endedOffsetMs"], message: "Transcript end must follow start" });
  }
});

const EvidenceItemSchema = z.object({
  text: z.string().trim().min(1).max(10_000),
  evidenceSegmentIds: EvidenceSegmentIdsSchema,
}).strict();

export const MinutesActionSchema = EvidenceItemSchema.extend({
  owner: z.string().trim().min(1).max(120).nullable(),
  dueDate: z.iso.date().nullable(),
}).strict();

export const MinutesSchema = z.object({
  summary: z.string().trim().min(1).max(20_000),
  topics: z.array(EvidenceItemSchema).max(100),
  decisions: z.array(EvidenceItemSchema).max(100),
  risks: z.array(EvidenceItemSchema).max(100),
  actions: z.array(MinutesActionSchema).max(100),
}).strict();

export type TranscriptSource = z.infer<typeof TranscriptSourceSchema>;
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;
export type Minutes = z.infer<typeof MinutesSchema>;
export type MinutesAction = z.infer<typeof MinutesActionSchema>;
