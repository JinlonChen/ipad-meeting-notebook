import Dexie from "dexie";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, test, vi } from "vitest";

import type { InkStroke } from "@meeting/contracts";
import { useMeetingInk } from "../../src/ink/useMeetingInk.js";
import { InkRepository } from "../../src/ink/repository.js";
import { MeetingCatalogDatabase } from "../../src/meetings/local-db.js";

const meetingId = "00000000-0000-4000-8000-000000000001";
const stroke: InkStroke = {
  id: "00000000-0000-4000-8000-000000000002",
  meetingId,
  order: 0,
  tool: "pen",
  color: "#1d2529",
  width: 4,
  points: [{ x: 1, y: 2, pressure: 0.5, elapsedMs: 0 }, { x: 2, y: 3, pressure: 0.6, elapsedMs: 16 }],
  deleted: false,
  version: 1,
};

const databases: MeetingCatalogDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    const name = database.name;
    database.close();
    await Dexie.delete(name);
  }
});

function createRepository() {
  const database = new MeetingCatalogDatabase(`ink-hook-${crypto.randomUUID()}`);
  databases.push(database);
  return new InkRepository(() => database);
}

function Harness({ repository, synchronizer, online }: {
  repository: InkRepository;
  synchronizer: { flush(): Promise<"idle" | "paused_auth" | "error">; refresh(id: string): Promise<"idle" | "paused_auth" | "error"> };
  online: boolean;
}) {
  const ink = useMeetingInk({ meetingId, repository, synchronizer, online });
  return <><span role="status">{ink.state}</span><span role="alert">{ink.error}</span><button onClick={() => void ink.save(stroke)}>保存笔画</button></>;
}

function BatchHarness({ repository, synchronizer, snapshots }: {
  repository: InkRepository;
  synchronizer: { flush(): Promise<"idle" | "paused_auth" | "error">; refresh(id: string): Promise<"idle" | "paused_auth" | "error"> };
  snapshots: string[][];
}) {
  const ink = useMeetingInk({ meetingId, repository, synchronizer, online: true });
  const saveMany = (ink as typeof ink & { saveMany?: (strokes: InkStroke[]) => Promise<void> }).saveMany;
  useEffect(() => { snapshots.push(ink.strokes.map((item) => item.id)); }, [ink.strokes, snapshots]);
  const continuation = { ...stroke, id: "00000000-0000-4000-8000-000000000003", order: 1 };
  return <>
    <span role="status">{ink.state}</span>
    <button disabled={!saveMany} onClick={() => void saveMany?.([stroke, continuation])}>保存续段</button>
  </>;
}

test("saves offline first and refreshes after reconnect", async () => {
  const repository = createRepository();
  const synchronizer = { flush: vi.fn().mockResolvedValue("idle" as const), refresh: vi.fn().mockResolvedValue("idle" as const) };
  const rendered = render(<Harness repository={repository} synchronizer={synchronizer} online={false} />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("idle"));

  fireEvent.click(screen.getByRole("button", { name: "保存笔画" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("saved-local"));
  await expect(repository.list(meetingId)).resolves.toEqual([stroke]);
  expect(synchronizer.flush).not.toHaveBeenCalled();

  rendered.rerender(<Harness repository={repository} synchronizer={synchronizer} online />);
  await waitFor(() => expect(synchronizer.refresh).toHaveBeenCalledWith(meetingId));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("synced"));
});

test("flushes an online stroke and keeps the local copy when cloud sync fails", async () => {
  const repository = createRepository();
  const synchronizer = { flush: vi.fn().mockResolvedValue("error" as const), refresh: vi.fn().mockResolvedValue("idle" as const) };
  render(<Harness repository={repository} synchronizer={synchronizer} online />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("synced"));

  fireEvent.click(screen.getByRole("button", { name: "保存笔画" }));

  await waitFor(() => expect(synchronizer.flush).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("saved-local"));
  await expect(repository.list(meetingId)).resolves.toEqual([stroke]);
});

test("keeps a local stroke when the post-sync refresh fails", async () => {
  const repository = createRepository();
  let failReload = false;
  const originalList = repository.list.bind(repository);
  vi.spyOn(repository, "list").mockImplementation((id, includeDeleted) =>
    failReload ? Promise.reject(new Error("refresh failed")) : originalList(id, includeDeleted),
  );
  const synchronizer = {
    flush: vi.fn().mockImplementation(() => {
      failReload = true;
      return Promise.resolve("idle" as const);
    }),
    refresh: vi.fn().mockResolvedValue("error" as const),
  };
  render(<Harness repository={repository} synchronizer={synchronizer} online />);
  await waitFor(() => expect(synchronizer.refresh).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("idle"));

  fireEvent.click(screen.getByRole("button", { name: "保存笔画" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("saved-local"));
  expect(synchronizer.flush).toHaveBeenCalledOnce();
});

test("publishes a continuation batch once and triggers one cloud flush", async () => {
  const repository = createRepository();
  const synchronizer = { flush: vi.fn().mockResolvedValue("idle" as const), refresh: vi.fn().mockResolvedValue("idle" as const) };
  const snapshots: string[][] = [];
  render(<BatchHarness repository={repository} synchronizer={synchronizer} snapshots={snapshots} />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("synced"));

  const save = screen.getByRole("button", { name: "保存续段" });
  expect(save).toBeEnabled();
  fireEvent.click(save);

  await waitFor(() => expect(synchronizer.flush).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("synced"));
  await expect(repository.list(meetingId)).resolves.toHaveLength(2);
  expect(snapshots.filter((ids) => ids.length > 0)).toEqual([[
    stroke.id,
    "00000000-0000-4000-8000-000000000003",
  ]]);
});
