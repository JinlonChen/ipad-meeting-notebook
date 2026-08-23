import "fake-indexeddb/auto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MeetingCatalogSupabaseApi } from "../../src/meetings/api.js";
import { MeetingCatalogRepository } from "../../src/meetings/repository.js";
import { CatalogSync } from "../../src/meetings/sync.js";
import type { Database } from "../../src/supabase/types.js";

type SupabaseCatalogClient = Pick<SupabaseClient<Database>, "from" | "rpc">;

const repositories: MeetingCatalogRepository[] = [];
const timestamp = "2026-08-21T00:00:00.000Z";
const userId = "00000000-0000-4000-8000-00000000000a";

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.deleteDatabase()));
});

describe("Supabase catalog synchronization", () => {
  test("stores only a fixed sync failure when Supabase returns private error details", async () => {
    const repository = new MeetingCatalogRepository(`supabase-sync-${crypto.randomUUID()}`);
    repositories.push(repository);
    await repository.activateUser(userId);
    const meeting = await repository.create("Offline meeting", null, timestamp);
    const client = {
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { status: 503, message: "service-role-key and private database details" },
      }),
      from: vi.fn(),
    } as unknown as SupabaseCatalogClient;

    await expect(new CatalogSync(repository, new MeetingCatalogSupabaseApi(client)).flush()).resolves.toEqual({ state: "error" });
    await expect(repository.pendingOperations()).resolves.toEqual([
      expect.objectContaining({ entityId: meeting.id, attempts: 1, lastError: "SYNC_FAILED" }),
    ]);
    expect(JSON.stringify(await repository.pendingOperations())).not.toContain("service-role-key");
    expect(JSON.stringify(await repository.pendingOperations())).not.toContain("private database details");
  });

  test("classifies a typed missing meeting note mutation as a resolvable conflict", async () => {
    const repository = new MeetingCatalogRepository(`supabase-note-conflict-${crypto.randomUUID()}`);
    repositories.push(repository);
    await repository.activateUser(userId);
    const meeting = await repository.create("Offline meeting", null, timestamp);
    await repository.saveNote(meeting.id, "local note", "2026-08-21T00:01:00.000Z");
    const client = {
      rpc: vi.fn()
        .mockResolvedValueOnce({ data: { status: 200, meeting: {
          user_id: userId,
          id: meeting.id,
          title: meeting.title,
          folder_id: null,
          status: "draft",
          started_at: null,
          ended_at: null,
          created_at: timestamp,
          updated_at: timestamp,
          trashed_at: null,
          status_before_trash: null,
          sync_version: 0,
          note: "",
        } }, error: null })
        .mockResolvedValueOnce({ data: { status: 404, code: "MEETING_NOT_FOUND" }, error: null }),
      from: vi.fn(),
    } as unknown as SupabaseCatalogClient;

    const sync = new CatalogSync(repository, new MeetingCatalogSupabaseApi(client));
    await expect(sync.flush()).resolves.toEqual({ state: "conflict" });
    await expect(repository.pendingStatus()).resolves.toEqual({
      count: 1,
      conflict: expect.objectContaining({ kind: "meeting.note" }),
    });
  });
});
