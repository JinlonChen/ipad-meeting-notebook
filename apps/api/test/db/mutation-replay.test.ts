import { afterEach, describe, expect, test } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import {
  MutationReplayConflictError,
  replayableMutation,
} from "../../src/db/mutation-replay.js";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("replayableMutation", () => {
  test("replays undefined requests and rejects the same key for an object request", () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    let mutationCount = 0;
    const mutate = () => ({ mutationCount: ++mutationCount });
    const parse = (value: unknown) => value as ReturnType<typeof mutate>;

    expect(replayableMutation(db, "operation-1", "test.mutation", "entity-1", undefined, parse, mutate)).toEqual({ mutationCount: 1 });
    expect(replayableMutation(db, "operation-1", "test.mutation", "entity-1", undefined, parse, mutate)).toEqual({ mutationCount: 1 });
    expect(mutationCount).toBe(1);
    expect(db.prepare("SELECT request_json FROM catalog_mutation_replays WHERE operation_id = ?").get("operation-1")).toEqual({
      request_json: "undefined",
    });
    expect(() => replayableMutation(db, "operation-1", "test.mutation", "entity-1", {}, parse, mutate)).toThrow(MutationReplayConflictError);
  });

  test("rejects request values that cannot be serialized", () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    const cyclicRequest: Record<string, unknown> = {};
    cyclicRequest.self = cyclicRequest;
    let mutationCount = 0;
    const mutate = () => ++mutationCount;

    expect(() => replayableMutation(db, "operation-symbol", "test.mutation", "entity-1", Symbol("request"), Number, mutate)).toThrow(
      "Mutation replay request must be JSON-serializable",
    );
    expect(() => replayableMutation(db, "operation-cyclic", "test.mutation", "entity-1", cyclicRequest, Number, mutate)).toThrow(
      "Mutation replay request must be JSON-serializable",
    );
    expect(mutationCount).toBe(0);
  });
});
