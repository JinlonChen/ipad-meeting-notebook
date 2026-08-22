import {
  CreateMeetingInputSchema,
  IdempotencyKeySchema,
  MeetingMutationBodySchema,
  MeetingPatchBodySchema,
  MeetingSchema,
} from "@meeting/contracts";
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from "fastify";
import { z } from "zod";

import { FolderNotFoundError } from "../folders/repository.js";
import { MutationReplayConflictError } from "../db/mutation-replay.js";
import {
  MeetingFolderNotFoundError,
  MeetingNotFoundError,
  MeetingConflictError,
  MeetingSyncVersionConflictError,
  type MeetingRepository,
} from "./repository.js";

const IdParamsSchema = z.object({ id: z.uuid() }).strict();
const CreateSchema = CreateMeetingInputSchema.strict();
const QuerySchema = z.object({
  search: z.string().trim().max(120).optional().default(""),
  includeTrashed: z.enum(["true", "false"]).optional().default("false").transform((value) => value === "true"),
}).strict();
const EmptyQuerySchema = z.object({}).strict();
const NoBodySchema = z.undefined();

function operationId(request: FastifyRequest) {
  return IdempotencyKeySchema.optional().safeParse(request.headers["idempotency-key"]);
}

function invalid(reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  return reply.code(400).send({ code: "INVALID_REQUEST" });
}

function hasUnexpectedBody(request: FastifyRequest): boolean {
  const length = request.headers["content-length"];
  return request.body !== undefined || request.headers["transfer-encoding"] !== undefined || (typeof length === "string" && Number(length) > 0);
}

export function registerMeetingRoutes(app: FastifyInstance, options: {
  meetings: MeetingRepository;
  onRequest: onRequestHookHandler;
  now?: () => Date;
}): void {
  const now = options.now ?? (() => new Date());

  app.get("/api/meetings", { onRequest: options.onRequest }, async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query);
    if (!parsed.success || !NoBodySchema.safeParse(request.body).success || hasUnexpectedBody(request)) return invalid(reply);
    return reply.send(z.array(MeetingSchema).parse(options.meetings.list(parsed.data)));
  });

  app.post("/api/meetings", { onRequest: options.onRequest }, async (request, reply) => {
    if (!EmptyQuerySchema.safeParse(request.query).success) return invalid(reply);
    const parsed = CreateSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    try {
      const result = options.meetings.createOrReplay(parsed.data);
      return reply.code(result.created ? 201 : 200).send(MeetingSchema.parse(result.meeting));
    } catch (error) {
      if (error instanceof MeetingConflictError) return reply.code(409).send({ code: "MEETING_CONFLICT" });
      if (isForeignKeyError(error)) return reply.code(404).send({ code: "FOLDER_NOT_FOUND" });
      throw error;
    }
  });

  app.patch("/api/meetings/:id", { onRequest: options.onRequest }, async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    const patch = MeetingPatchBodySchema.safeParse(request.body);
    const operation = operationId(request);
    if (!params.success || !patch.success || !operation.success || !EmptyQuerySchema.safeParse(request.query).success) return invalid(reply);
    try {
      const { expectedSyncVersion, ...changes } = patch.data;
      return reply.send(MeetingSchema.parse(options.meetings.update(params.data.id, changes, now().toISOString(), expectedSyncVersion, operation.data)));
    } catch (error) {
      if (error instanceof MeetingNotFoundError) return reply.code(404).send({ code: "MEETING_NOT_FOUND" });
      if (error instanceof MeetingSyncVersionConflictError) return reply.code(409).send({ code: "SYNC_VERSION_CONFLICT" });
      if (error instanceof MutationReplayConflictError) return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
      if (error instanceof MeetingFolderNotFoundError || error instanceof FolderNotFoundError || isForeignKeyError(error)) {
        return reply.code(404).send({ code: "FOLDER_NOT_FOUND" });
      }
      throw error;
    }
  });

  app.delete("/api/meetings/:id", { onRequest: options.onRequest }, async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    const body = MeetingMutationBodySchema.optional().safeParse(request.body);
    const operation = operationId(request);
    if (!params.success || !operation.success || !EmptyQuerySchema.safeParse(request.query).success || !body.success) return invalid(reply);
    try {
      return reply.send(MeetingSchema.parse(options.meetings.trash(params.data.id, now().toISOString(), body.data?.expectedSyncVersion, operation.data)));
    } catch (error) {
      if (error instanceof MeetingNotFoundError) return reply.code(404).send({ code: "MEETING_NOT_FOUND" });
      if (error instanceof MeetingSyncVersionConflictError) return reply.code(409).send({ code: "SYNC_VERSION_CONFLICT" });
      if (error instanceof MutationReplayConflictError) return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
      throw error;
    }
  });

  app.post("/api/meetings/:id/restore", { onRequest: options.onRequest }, async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    const body = MeetingMutationBodySchema.optional().safeParse(request.body);
    const operation = operationId(request);
    if (!params.success || !operation.success || !EmptyQuerySchema.safeParse(request.query).success || !body.success) return invalid(reply);
    try {
      return reply.send(MeetingSchema.parse(options.meetings.restore(params.data.id, now().toISOString(), body.data?.expectedSyncVersion, operation.data)));
    } catch (error) {
      if (error instanceof MeetingNotFoundError) return reply.code(404).send({ code: "MEETING_NOT_FOUND" });
      if (error instanceof MeetingSyncVersionConflictError) return reply.code(409).send({ code: "SYNC_VERSION_CONFLICT" });
      if (error instanceof MutationReplayConflictError) return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
      throw error;
    }
  });
}

function isForeignKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "SQLITE_CONSTRAINT_FOREIGNKEY";
}
