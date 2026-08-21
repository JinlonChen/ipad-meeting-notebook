import { CreateFolderInputSchema, FolderSchema } from "@meeting/contracts";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import { FolderNotFoundError, type FolderRepository } from "./repository.js";

const IdParamsSchema = z.object({ id: z.uuid() }).strict();
const CreateSchema = CreateFolderInputSchema.strict();
const PatchSchema = z.object({ name: CreateFolderInputSchema.shape.name }).strict();

function invalid(reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  return reply.code(400).send({ code: "INVALID_REQUEST" });
}

function sameCreation(existing: z.infer<typeof FolderSchema>, input: z.infer<typeof CreateSchema>): boolean {
  return existing.name === input.name
    && existing.createdAt === new Date(input.clientCreatedAt).toISOString().replace(/\.(\d{3})\d*Z$/, ".$1Z");
}

export function registerFolderRoutes(app: FastifyInstance, options: {
  folders: FolderRepository;
  preHandler: preHandlerHookHandler;
  now?: () => Date;
}): void {
  const now = options.now ?? (() => new Date());

  app.get("/api/folders", { preHandler: options.preHandler }, async (_request, reply) => reply.send(options.folders.list()));

  app.post("/api/folders", { preHandler: options.preHandler }, async (request, reply) => {
    const parsed = CreateSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const existing = options.folders.get(parsed.data.id);
    if (existing) {
      return sameCreation(existing, parsed.data)
        ? reply.code(200).send(FolderSchema.parse(existing))
        : reply.code(409).send({ code: "FOLDER_CONFLICT" });
    }
    try {
      return reply.code(201).send(FolderSchema.parse(options.folders.create(parsed.data)));
    } catch (error) {
      if (isUniqueError(error)) return reply.code(409).send({ code: "FOLDER_NAME_CONFLICT" });
      throw error;
    }
  });

  app.patch("/api/folders/:id", { preHandler: options.preHandler }, async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    const patch = PatchSchema.safeParse(request.body);
    if (!params.success || !patch.success) return invalid(reply);
    try {
      return reply.send(FolderSchema.parse(options.folders.rename(params.data.id, patch.data.name, now().toISOString())));
    } catch (error) {
      if (error instanceof FolderNotFoundError) return reply.code(404).send({ code: "FOLDER_NOT_FOUND" });
      if (isUniqueError(error)) return reply.code(409).send({ code: "FOLDER_NAME_CONFLICT" });
      throw error;
    }
  });

  app.delete("/api/folders/:id", { preHandler: options.preHandler }, async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply);
    try {
      options.folders.remove(params.data.id, now().toISOString());
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof FolderNotFoundError) return reply.code(404).send({ code: "FOLDER_NOT_FOUND" });
      throw error;
    }
  });
}

function isUniqueError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "SQLITE_CONSTRAINT_UNIQUE";
}
