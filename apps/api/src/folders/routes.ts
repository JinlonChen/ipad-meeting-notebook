import { CreateFolderInputSchema, FolderMutationBodySchema, FolderRenameBodySchema, FolderSchema, IdempotencyKeySchema } from "@meeting/contracts";
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from "fastify";
import { z } from "zod";

import { FolderConflictError, FolderNotFoundError, FolderSyncVersionConflictError, type FolderRepository } from "./repository.js";
import { MutationReplayConflictError } from "../db/mutation-replay.js";

const IdParamsSchema = z.object({ id: z.uuid() }).strict();
const CreateSchema = CreateFolderInputSchema.strict();
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

export function registerFolderRoutes(app: FastifyInstance, options: {
  folders: FolderRepository;
  onRequest: onRequestHookHandler;
  now?: () => Date;
}): void {
  const now = options.now ?? (() => new Date());

  app.get("/api/folders", { onRequest: options.onRequest }, async (request, reply) => {
    if (!EmptyQuerySchema.safeParse(request.query).success || !NoBodySchema.safeParse(request.body).success || hasUnexpectedBody(request)) return invalid(reply);
    return reply.send(z.array(FolderSchema).parse(options.folders.list()));
  });

  app.post("/api/folders", { onRequest: options.onRequest }, async (request, reply) => {
    if (!EmptyQuerySchema.safeParse(request.query).success) return invalid(reply);
    const parsed = CreateSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    try {
      const result = options.folders.createOrReplay(parsed.data);
      return reply.code(result.created ? 201 : 200).send(FolderSchema.parse(result.folder));
    } catch (error) {
      if (error instanceof FolderConflictError) return reply.code(409).send({ code: "FOLDER_CONFLICT" });
      if (isUniqueError(error)) return reply.code(409).send({ code: "FOLDER_NAME_CONFLICT" });
      throw error;
    }
  });

  app.patch("/api/folders/:id", { onRequest: options.onRequest }, async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    const patch = FolderRenameBodySchema.safeParse(request.body);
    const operation = operationId(request);
    if (!params.success || !patch.success || !operation.success || !EmptyQuerySchema.safeParse(request.query).success) return invalid(reply);
    try {
      return reply.send(FolderSchema.parse(options.folders.rename(params.data.id, patch.data.name, now().toISOString(), patch.data.expectedSyncVersion, operation.data)));
    } catch (error) {
      if (error instanceof FolderNotFoundError) return reply.code(404).send({ code: "FOLDER_NOT_FOUND" });
      if (error instanceof FolderSyncVersionConflictError) return reply.code(409).send({ code: "SYNC_VERSION_CONFLICT" });
      if (error instanceof MutationReplayConflictError) return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
      if (isUniqueError(error)) return reply.code(409).send({ code: "FOLDER_NAME_CONFLICT" });
      throw error;
    }
  });

  app.delete("/api/folders/:id", { onRequest: options.onRequest }, async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    const body = FolderMutationBodySchema.optional().safeParse(request.body);
    const operation = operationId(request);
    if (!params.success || !operation.success || !EmptyQuerySchema.safeParse(request.query).success || !body.success) return invalid(reply);
    try {
      options.folders.remove(params.data.id, now().toISOString(), body.data?.expectedSyncVersion, operation.data);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof FolderNotFoundError) return reply.code(404).send({ code: "FOLDER_NOT_FOUND" });
      if (error instanceof FolderSyncVersionConflictError) return reply.code(409).send({ code: "SYNC_VERSION_CONFLICT" });
      if (error instanceof MutationReplayConflictError) return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
      throw error;
    }
  });
}

function isUniqueError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "SQLITE_CONSTRAINT_UNIQUE";
}
