import Dexie from "dexie";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { InkStroke } from "@meeting/contracts";
import { InkRepository } from "../../src/ink/repository.js";
import { MeetingCatalogDatabase } from "../../src/meetings/local-db.js";

const meetingId = "00000000-0000-4000-8000-000000000001";
const strokeId = "00000000-0000-4000-8000-000000000002";

function stroke(version = 1, deleted = false): InkStroke {
  return {
    id: strokeId, meetingId, order: 0, tool: "pen", color: "#1d2529", width: 4,
    points: [{ x: 10, y: 20, pressure: 0.5, elapsedMs: 0 }, { x: 11, y: 22, pressure: 0.6, elapsedMs: 16 }],
    deleted, version,
  };
}

describe("InkRepository", () => {
  const databases: MeetingCatalogDatabase[] = [];
  const names: string[] = [];

  afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    await Promise.all(names.splice(0).map((name) => Dexie.delete(name)));
  });

  function create() {
    const name = `ink-repository-${crypto.randomUUID()}`;
    names.push(name);
    const database = new MeetingCatalogDatabase(name);
    databases.push(database);
    return { database, repository: new InkRepository(() => database) };
  }

  test("saves a stroke and its outbox mutation atomically", async () => {
    const { repository } = create();
    await repository.save(stroke());

    await expect(repository.list(meetingId)).resolves.toEqual([stroke()]);
    await expect(repository.pending()).resolves.toEqual([
      expect.objectContaining({ strokeId, stroke: stroke() }),
    ]);
  });

  test("saves continuation strokes and outbox mutations in one batch", async () => {
    const { repository } = create();
    const continuation = {
      ...stroke(),
      id: "00000000-0000-4000-8000-000000000003",
      order: 1,
    };

    const mutations = await repository.saveMany([stroke(), continuation]);

    await expect(repository.list(meetingId)).resolves.toEqual([stroke(), continuation]);
    await expect(repository.pending()).resolves.toEqual([
      expect.objectContaining({ strokeId, stroke: stroke() }),
      expect.objectContaining({ strokeId: continuation.id, stroke: continuation }),
    ]);
    expect(mutations.map((mutation) => mutation.strokeId)).toEqual([strokeId, continuation.id]);
  });

  test("rolls back every continuation when a batch persistence step fails", async () => {
    const { database, repository } = create();
    const continuation = {
      ...stroke(),
      id: "00000000-0000-4000-8000-000000000004",
      order: 1,
    };
    vi.spyOn(database.inkOutbox, "bulkPut").mockRejectedValueOnce(new Error("disk"));

    await expect(repository.saveMany([stroke(), continuation])).rejects.toThrow("disk");

    await expect(repository.list(meetingId, true)).resolves.toEqual([]);
    await expect(repository.pending()).resolves.toEqual([]);
  });

  test("coalesces repeated changes and keeps a deletion tombstone after reopen", async () => {
    const { database, repository } = create();
    await repository.save(stroke());
    await repository.save(stroke(2, true));
    expect(await repository.pending()).toHaveLength(1);
    database.close();

    const reopened = new MeetingCatalogDatabase(database.name);
    databases.push(reopened);
    const restored = new InkRepository(() => reopened);
    await expect(restored.list(meetingId, true)).resolves.toEqual([stroke(2, true)]);
    await expect(restored.list(meetingId)).resolves.toEqual([]);
  });

  test("accepts canonical state and acknowledges only the matching mutation", async () => {
    const { repository } = create();
    await repository.save(stroke());
    const [pending] = await repository.pending();
    expect(pending).toBeDefined();
    const canonical = { ...stroke(), color: "#176f6b", version: 2 };
    await repository.acceptAcknowledged(canonical, crypto.randomUUID());
    expect(await repository.pending()).toHaveLength(1);
    await expect(repository.list(meetingId)).resolves.toEqual([stroke()]);
    await repository.acceptAcknowledged(canonical, pending!.mutationId);
    await expect(repository.pending()).resolves.toEqual([]);
    await expect(repository.list(meetingId)).resolves.toEqual([canonical]);
  });
});
