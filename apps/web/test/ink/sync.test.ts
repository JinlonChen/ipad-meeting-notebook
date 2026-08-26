import Dexie from "dexie";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { InkMutation, InkStroke } from "@meeting/contracts";
import { InkRepository } from "../../src/ink/repository.js";
import { InkSync } from "../../src/ink/sync.js";
import { MeetingCatalogDatabase } from "../../src/meetings/local-db.js";

const stroke: InkStroke = {
  id: "00000000-0000-4000-8000-000000000001",
  meetingId: "00000000-0000-4000-8000-000000000002",
  order: 0, tool: "pen", color: "#1d2529", width: 4,
  points: [{ x: 1, y: 2, pressure: 0.5, elapsedMs: 0 }, { x: 2, y: 3, pressure: 0.6, elapsedMs: 16 }],
  deleted: false, version: 1,
};

const userId = "00000000-0000-4000-8000-00000000000a";

test("flushes pending mutations in order and acknowledges canonical strokes", async () => {
  const mutation: InkMutation & { strokeId: string } = { mutationId: crypto.randomUUID(), strokeId: stroke.id, stroke };
  const repository = {
    pending: vi.fn().mockResolvedValue([mutation]),
    acceptAcknowledged: vi.fn().mockResolvedValue(undefined),
    acceptRemote: vi.fn().mockResolvedValue(undefined),
  };
  const api = { apply: vi.fn().mockResolvedValue(stroke), list: vi.fn() };
  const sync = new InkSync(repository, api);
  sync.resumeAfterLogin(userId);

  await expect(sync.flush()).resolves.toBe("idle");
  expect(api.apply).toHaveBeenCalledWith(mutation, userId);
  expect(repository.acceptAcknowledged).toHaveBeenCalledWith(stroke, mutation.mutationId);
  expect(repository.acceptRemote).not.toHaveBeenCalled();
});

test("keeps the outbox when the network fails", async () => {
  const mutation = { mutationId: crypto.randomUUID(), strokeId: stroke.id, stroke };
  const repository = { pending: vi.fn().mockResolvedValue([mutation]), acceptAcknowledged: vi.fn(), acceptRemote: vi.fn() };
  const sync = new InkSync(repository, { apply: vi.fn().mockRejectedValue(new Error("offline")), list: vi.fn() });
  sync.resumeAfterLogin(userId);

  await expect(sync.flush()).resolves.toBe("error");
  expect(repository.acceptAcknowledged).not.toHaveBeenCalled();
});

test("pulls canonical rows after flushing", async () => {
  const repository = { pending: vi.fn().mockResolvedValue([]), acceptAcknowledged: vi.fn(), acceptRemote: vi.fn() };
  const api = { apply: vi.fn(), list: vi.fn().mockResolvedValue([stroke]) };
  const sync = new InkSync(repository, api);
  sync.resumeAfterLogin(userId);

  await expect(sync.refresh(stroke.meetingId)).resolves.toBe("idle");
  expect(repository.acceptRemote).toHaveBeenCalledWith(stroke);
});

test("pauses until login and binds every mutation to the active user", async () => {
  const mutation = { mutationId: crypto.randomUUID(), strokeId: stroke.id, stroke };
  const repository = {
    pending: vi.fn().mockResolvedValue([mutation]),
    acceptAcknowledged: vi.fn().mockResolvedValue(undefined),
    acceptRemote: vi.fn().mockResolvedValue(undefined),
  };
  const api = { apply: vi.fn().mockResolvedValue(stroke), list: vi.fn() };
  const sync = new InkSync(repository, api);

  await expect(sync.flush()).resolves.toBe("paused_auth");
  sync.resumeAfterLogin(userId);
  await expect(sync.flush()).resolves.toBe("idle");
  expect(api.apply).toHaveBeenCalledWith(mutation, userId);
});

test("does not apply a stale response after the user changes", async () => {
  let release!: (value: InkStroke) => void;
  const response = new Promise<InkStroke>((resolve) => { release = resolve; });
  const mutation = { mutationId: crypto.randomUUID(), strokeId: stroke.id, stroke };
  const repository = {
    pending: vi.fn().mockResolvedValue([mutation]),
    acceptAcknowledged: vi.fn().mockResolvedValue(undefined),
    acceptRemote: vi.fn().mockResolvedValue(undefined),
  };
  const api = { apply: vi.fn().mockReturnValue(response), list: vi.fn() };
  const sync = new InkSync(repository, api);
  sync.resumeAfterLogin(userId);

  const flushing = sync.flush();
  await vi.waitFor(() => expect(api.apply).toHaveBeenCalledOnce());
  sync.pauseForUserChange();
  release(stroke);

  await expect(flushing).resolves.toBe("paused_auth");
  expect(repository.acceptRemote).not.toHaveBeenCalled();
  expect(repository.acceptAcknowledged).not.toHaveBeenCalled();
});

describe("InkSync IndexedDB acknowledgement races", () => {
  const databases: MeetingCatalogDatabase[] = [];
  const names: string[] = [];

  afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    await Promise.all(names.splice(0).map((name) => Dexie.delete(name)));
  });

  function create() {
    const name = `ink-sync-race-${crypto.randomUUID()}`;
    names.push(name);
    const database = new MeetingCatalogDatabase(name);
    databases.push(database);
    const repository = new InkRepository(() => database);
    return repository;
  }

  test("atomically replaces a sent local stroke with the server canonical response", async () => {
    const repository = create();
    const sent = { ...stroke, version: 2, color: "#a6473c" };
    const canonical = { ...stroke, version: 3, color: "#176f6b" };
    const mutation = await repository.save(sent);
    const api = { apply: vi.fn().mockResolvedValue(canonical), list: vi.fn() };
    const sync = new InkSync(repository, api);
    sync.resumeAfterLogin(userId);

    await expect(sync.flush()).resolves.toBe("idle");

    await expect(repository.list(stroke.meetingId)).resolves.toEqual([canonical]);
    await expect(repository.pending()).resolves.toEqual([]);
    expect(api.apply).toHaveBeenCalledWith(mutation, userId);
  });

  test("keeps a newer local mutation written while the sent request is in flight", async () => {
    const repository = create();
    const sent = { ...stroke, version: 2, color: "#a6473c" };
    const canonical = { ...stroke, version: 3, color: "#176f6b" };
    const newer = { ...stroke, version: 4, color: "#2f5f9d" };
    await repository.save(sent);
    let release!: (value: InkStroke) => void;
    const response = new Promise<InkStroke>((resolve) => { release = resolve; });
    const api = { apply: vi.fn().mockReturnValue(response), list: vi.fn() };
    const sync = new InkSync(repository, api);
    sync.resumeAfterLogin(userId);

    const flushing = sync.flush();
    await vi.waitFor(() => expect(api.apply).toHaveBeenCalledOnce());
    const newerMutation = await repository.save(newer);
    release(canonical);
    await expect(flushing).resolves.toBe("idle");

    await expect(repository.list(stroke.meetingId)).resolves.toEqual([newer]);
    await expect(repository.pending()).resolves.toEqual([newerMutation]);
  });

  test("treats a duplicate canonical acknowledgement as an idempotent replay", async () => {
    const repository = create();
    const sent = { ...stroke, version: 2 };
    const canonical = { ...stroke, version: 3, color: "#176f6b" };
    const mutation = await repository.save(sent);

    await repository.acceptAcknowledged(canonical, mutation.mutationId);
    await repository.acceptAcknowledged(canonical, mutation.mutationId);

    await expect(repository.list(stroke.meetingId)).resolves.toEqual([canonical]);
    await expect(repository.pending()).resolves.toEqual([]);
  });
});
