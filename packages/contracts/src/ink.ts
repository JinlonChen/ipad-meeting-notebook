import { z } from "zod";

export const INK_LOGICAL_WIDTH = 2_048;
export const INK_LOGICAL_HEIGHT = 200_000;
export const INK_MAX_POINTS = 2_048;

export const InkPointSchema = z.object({
  x: z.number().finite().min(0).max(INK_LOGICAL_WIDTH),
  y: z.number().finite().min(0).max(INK_LOGICAL_HEIGHT),
  pressure: z.number().finite().min(0).max(1),
  elapsedMs: z.int().nonnegative().max(86_400_000),
}).strict();

export const InkStrokeSchema = z.object({
  id: z.uuid(),
  meetingId: z.uuid(),
  order: z.int().nonnegative(),
  tool: z.enum(["pen", "highlighter"]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  width: z.number().finite().min(1).max(40),
  points: z.array(InkPointSchema).min(2).max(INK_MAX_POINTS),
  deleted: z.boolean(),
  version: z.int().positive(),
}).strict();

export const InkMutationSchema = z.object({
  mutationId: z.uuid(),
  stroke: InkStrokeSchema,
}).strict();

export type InkPoint = z.infer<typeof InkPointSchema>;
export type InkStroke = z.infer<typeof InkStrokeSchema>;
export type InkMutation = z.infer<typeof InkMutationSchema>;
