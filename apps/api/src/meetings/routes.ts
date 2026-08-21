import {
  CreateMeetingInputSchema,
  MeetingSchema,
} from "@meeting/contracts";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import { FolderNotFoundError } from "../folders/repository.js";
import {
  MeetingFolderNotFoundError,
  MeetingNotFoundError,
  type MeetingRepository,
} from "./repository.js";

const IdParamsSchema = z.object({ id: z.uuid() }).strict();
const CreateSchema = CreateMeetingInputSchema.strict();
const PatchSchema = z.object({
  title: CreateMeetingInputSchema.shape.title.optional(),
  folderId: CreateMeetingInputSchema.shape.folderId.optional(),
}).strict().refine((value) => value.title !== undefined || value.folderId !== undefined);
const QuerySchema = z.object({
  search: z.string().trim().max(120).optional().default(""),
  includeTrashed: z.enum(["true", "false"]).optional().default("false").transform((value) => value === "true"),
}).strict();

function invalid(reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  return reply.code(400).send({ code: "INVALID_REQUEST" });
}

function sameCreation(existing: z.infer<typeof MeetingSchema>, input: z.infer<typeof CreateSchema>): boolean {
  return existing.title === input.title
    && existing.folderId === input.folderId
    && existing.createdAt === new Date(input.clientCreatedAt).toISOString().replace(/\.(\d{3})\d*Z$/, ".$1Z");
}

export function registerMeetingRoutes(app: FastifyInstance, options: {
  meetings: MeetingRepository;
  preHandler: preHandlerHookHandler;
  now?: () => Date;
}): void {
  const now = options.now ?? (() => new Date());

  app.get("/api/meetings", { preHandler: options.preHandler }, async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    return reply.send(options.meetings.list(parsed.data));
  });

  app.post("/api/meetings", { preHandler: options.preHandler }, async (request, reply) => {
    const parsed = CreateSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const existing = options.meetings.get(parsed.data.id);
    if (existing) {
      return sameCreation(existing, parsed.data)
        ? reply.code(200).send(MeetingSchema.parse(existing))
        : reply.code(409).send({ code: "MEETING_CONFLICT" });
    }
    try {
      return reply.code(201).send(MeetingSchema.parse(options.meetings.create(parsed.data)));
    } catch (error) {
      if (isForeignKeyError(error)) return reply.code(404).send({ code: "FOLDER_NOT_FOUND" });
      throw error;
    }
  });

  app.patch("/api/meetings/:id", { preHandler: options.preHandler }, async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    const patch = PatchSchema.safeParse(request.body);
    if (!params.success || !patch.success) return invalid(reply);
    try {
      return reply.send(MeetingSchema.parse(options.meetings.update(params.data.id, patch.data, now().toISOString())));
    } catch (error) {
      if (error instanceof MeetingNotFoundError) return reply.code(404).send({ code: "MEETING_NOT_FOUND" });
      if (error instanceof MeetingFolderNotFoundError || error instanceof FolderNotFoundError || isForeignKeyError(error)) {
        return reply.code(404).send({ code: "FOLDER_NOT_FOUND" });
      }
      throw error;
    }
  });

  app.delete("/api/meetings/:id", { preHandler: options.preHandler }, async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply);
    try {
      return reply.send(MeetingSchema.parse(options.meetings.trash(params.data.id, now().toISOString())));
    } catch (error) {
      if (error instanceof MeetingNotFoundError) return reply.code(404).send({ code: "MEETING_NOT_FOUND" });
      throw error;
    }
  });

  app.post("/api/meetings/:id/restore", { preHandler: options.preHandler }, async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply);
    try {
      return reply.send(MeetingSchema.parse(options.meetings.restore(params.data.id, now().toISOString())));
    } catch (error) {
      if (error instanceof MeetingNotFoundError) return reply.code(404).send({ code: "MEETING_NOT_FOUND" });
      throw error;
    }
  });
}

function isForeignKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "SQLITE_CONSTRAINT_FOREIGNKEY";
}
