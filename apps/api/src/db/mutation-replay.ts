import type Database from "better-sqlite3";

type ReplayRow = {
  kind: string;
  entity_id: string;
  request_json: string;
  response_json: string | null;
};

export class MutationReplayConflictError extends Error {
  constructor() {
    super("Idempotency key conflicts with a prior catalog mutation");
    this.name = "MutationReplayConflictError";
  }
}

function serializeMutationRequest(request: unknown): string {
  if (request === undefined) return "undefined";
  try {
    const serialized = JSON.stringify(request);
    if (serialized === undefined) throw new Error();
    return serialized;
  } catch {
    throw new Error("Mutation replay request must be JSON-serializable");
  }
}

export function replayableMutation<T>(
  db: Database.Database,
  operationId: string | undefined,
  kind: string,
  entityId: string,
  request: unknown,
  parse: (value: unknown) => T,
  mutate: () => T,
): T {
  if (operationId === undefined) return mutate();
  const requestJson = serializeMutationRequest(request);
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT kind, entity_id, request_json, response_json
      FROM catalog_mutation_replays WHERE operation_id = ?
    `).get(operationId) as ReplayRow | undefined;
    if (existing) {
      if (existing.kind !== kind || existing.entity_id !== entityId || existing.request_json !== requestJson) {
        throw new MutationReplayConflictError();
      }
      return parse(existing.response_json === null ? undefined : JSON.parse(existing.response_json));
    }
    const response = mutate();
    db.prepare(`
      INSERT INTO catalog_mutation_replays (operation_id, kind, entity_id, request_json, response_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(operationId, kind, entityId, requestJson, response === undefined ? null : JSON.stringify(response));
    return response;
  }).immediate();
}
