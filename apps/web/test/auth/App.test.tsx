import { StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { App } from "../../src/app/App.js";
import { AuthApiError, AuthNetworkError, type AuthApi } from "../../src/auth/api.js";
import { MeetingCatalogRepository } from "../../src/meetings/repository.js";

const now = "2026-08-21T00:00:00.000Z";
const expiry = "2026-09-21T00:00:00.000Z";
const repositories: MeetingCatalogRepository[] = [];
let databaseNumber = 0;

function repository() {
  const result = new MeetingCatalogRepository(`app-test-${databaseNumber++}`);
  repositories.push(result);
  return result;
}
function api(overrides: Partial<AuthApi> = {}): AuthApi {
  return { me: vi.fn().mockResolvedValue({ id: "owner", sessionExpiresAt: expiry }), login: vi.fn().mockResolvedValue(undefined), logout: vi.fn().mockResolvedValue(undefined), ...overrides };
}
function synchronizer(state: "idle" | "paused_auth" | "conflict" | "error" = "idle") {
  return { refresh: vi.fn().mockResolvedValue({ state }), resumeAfterLogin: vi.fn() };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.all(repositories.splice(0).map((item) => item.deleteDatabase()));
});

describe("App session gate", () => {
  test("authorizes a successful session and enters the meeting catalog", async () => {
    const catalog = repository();
    render(<App repository={catalog} auth={api()} synchronizer={synchronizer()} now={() => now} />);

    await screen.findByRole("heading", { name: "会议本" });
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(true);
  });

  test("keeps authorization active through StrictMode's effect restart", async () => {
    const catalog = repository();
    render(<StrictMode><App repository={catalog} auth={api()} synchronizer={synchronizer()} now={() => now} /></StrictMode>);

    await screen.findByRole("heading", { name: "会议本" });
  });

  test("keeps an unexpired local marker available offline but keeps expired access behind the login gate", async () => {
    const valid = repository();
    await valid.authorizeDevice(expiry, now);
    const rendered = render(<App repository={valid} auth={api({ me: vi.fn().mockRejectedValue(new AuthNetworkError()) })} synchronizer={synchronizer()} now={() => now} />);
    await screen.findByText("离线，等待同步");
    rendered.unmount();

    const expired = repository();
    await expired.authorizeDevice(now, "2026-08-01T00:00:00.000Z");
    render(<App repository={expired} auth={api({ me: vi.fn().mockRejectedValue(new AuthNetworkError()) })} synchronizer={synchronizer()} now={() => now} />);
    await screen.findByRole("heading", { name: "离线解锁需要登录" });
  });

  test("does not unlock local catalog for HTTP or malformed session failures", async () => {
    const catalog = repository();
    await catalog.authorizeDevice(expiry, now);
    const rendered = render(<App repository={catalog} auth={api({ me: vi.fn().mockRejectedValue(new AuthApiError(500, "REQUEST_FAILED")) })} synchronizer={synchronizer()} now={() => now} />);

    await screen.findByRole("heading", { name: "无法验证访问权限" });
    expect(screen.queryByRole("heading", { name: "会议本" })).not.toBeInTheDocument();
    rendered.unmount();
  });

  test("returns to login and clears device access when pull synchronization requires auth", async () => {
    const catalog = repository();
    render(<App repository={catalog} auth={api()} synchronizer={synchronizer("paused_auth")} now={() => now} />);

    await screen.findByRole("heading", { name: "登录会议本" });
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(false);
  });

  test("uses the injected repository for its default sync instance", async () => {
    const catalog = repository();
    const meeting = await catalog.create("待同步", null, now);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(meeting), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([meeting]), { headers: { "content-type": "application/json" } }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      render(<App repository={catalog} auth={api()} now={() => now} />);
      await screen.findByRole("heading", { name: "会议本" });
      await waitFor(async () => expect(await catalog.pendingOperations()).toEqual([]));
      expect(fetcher).toHaveBeenCalledWith("/api/meetings", expect.objectContaining({ method: "POST" }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("resumes the same injected catalog synchronizer before retrying catalog refresh", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const synchronizer = {
      refresh: vi.fn().mockResolvedValueOnce({ state: "paused_auth" as const }).mockResolvedValue({ state: "idle" as const }),
      resumeAfterLogin: vi.fn(),
    };
    const auth = api({ me: vi.fn().mockRejectedValueOnce(new AuthApiError(401, "AUTH_REQUIRED")).mockResolvedValue({ id: "owner", sessionExpiresAt: expiry }) });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer} now={() => now} />);

    await user.type(await screen.findByLabelText("密码"), "private-secret");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(synchronizer.refresh).toHaveBeenCalledTimes(1));
    await user.type(await screen.findByLabelText("密码"), "private-secret");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByText("已同步");
    expect(synchronizer.resumeAfterLogin).toHaveBeenCalledTimes(2);
    expect(synchronizer.refresh).toHaveBeenCalledTimes(2);
  });

  test("removes online and offline listeners when unmounted", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const rendered = render(<App repository={repository()} auth={api()} synchronizer={synchronizer()} now={() => now} />);
    await screen.findByRole("heading", { name: "会议本" });
    rendered.unmount();
    expect(add).toHaveBeenCalledWith("online", expect.any(Function));
    expect(add).toHaveBeenCalledWith("offline", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("online", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("offline", expect.any(Function));
  });

  test("clears an uncontrolled password field after login and logout retains catalog data", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const auth = api({ me: vi.fn().mockRejectedValueOnce(Object.assign(new Error("required"), { status: 401 })).mockResolvedValue({ id: "owner", sessionExpiresAt: expiry }) });
    await catalog.create("保留的会议", null, now);
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);
    const password = await screen.findByLabelText("密码");
    await user.type(password, "private-secret");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(password).toHaveValue(""));
    await screen.findByRole("heading", { name: "会议本" });
    await user.click(screen.getByRole("button", { name: "退出" }));
    await screen.findByRole("heading", { name: "登录会议本" });
    await expect(catalog.list()).resolves.toMatchObject([{ title: "保留的会议" }]);
  });

  test("logout invalidates an older authorization and leaves no device marker after it succeeds", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const stale = deferred<{ id: string; sessionExpiresAt: string }>();
    const auth = api({ me: vi.fn().mockResolvedValueOnce({ id: "owner", sessionExpiresAt: expiry }).mockImplementationOnce(() => stale.promise) });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);

    await screen.findByRole("heading", { name: "会议本" });
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(auth.me).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "退出" }));
    stale.resolve({ id: "owner", sessionExpiresAt: expiry });

    await screen.findByRole("heading", { name: "登录会议本" });
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(false);
  });

  test("does not let an old authorization clear a newer login marker", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const stale = deferred<{ id: string; sessionExpiresAt: string }>();
    const auth = api({
      me: vi.fn()
        .mockRejectedValueOnce(new AuthApiError(401, "AUTH_REQUIRED"))
        .mockImplementationOnce(() => stale.promise)
        .mockResolvedValueOnce({ id: "owner", sessionExpiresAt: expiry }),
    });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);

    await screen.findByRole("heading", { name: "登录会议本" });
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(auth.me).toHaveBeenCalledTimes(2));
    await user.type(screen.getByLabelText("密码"), "private-secret");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByRole("heading", { name: "会议本" });
    stale.resolve({ id: "owner", sessionExpiresAt: now });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(async () => expect(await catalog.hasDeviceAccess(now)).toBe(true));
  });

  test("does not commit a deferred authorization after unmount", async () => {
    const catalog = repository();
    const pending = deferred<{ id: string; sessionExpiresAt: string }>();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rendered = render(<App repository={catalog} auth={api({ me: vi.fn().mockImplementation(() => pending.promise) })} synchronizer={synchronizer()} now={() => now} />);

    rendered.unmount();
    pending.resolve({ id: "owner", sessionExpiresAt: expiry });
    await Promise.resolve();
    await Promise.resolve();

    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  test("does not let an older paused refresh clear a newer login session", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const refresh = deferred<{ state: "paused_auth" }>();
    const auth = api({ me: vi.fn().mockResolvedValue({ id: "owner", sessionExpiresAt: expiry }) });
    const sync = { refresh: vi.fn().mockImplementationOnce(() => refresh.promise).mockResolvedValue({ state: "idle" as const }), resumeAfterLogin: vi.fn() };
    render(<App repository={catalog} auth={auth} synchronizer={sync} now={() => now} />);

    await screen.findByRole("heading", { name: "会议本" });
    await waitFor(() => expect(sync.refresh).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "退出" }));
    await screen.findByRole("heading", { name: "登录会议本" });
    await user.type(screen.getByLabelText("密码"), "private-secret");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByRole("heading", { name: "会议本" });
    refresh.resolve({ state: "paused_auth" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("heading", { name: "会议本" })).toBeVisible();
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(true);
  });

  test("does not commit a paused refresh after unmount", async () => {
    const catalog = repository();
    const refresh = deferred<{ state: "paused_auth" }>();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rendered = render(<App repository={catalog} auth={api()} synchronizer={{ refresh: vi.fn().mockImplementation(() => refresh.promise), resumeAfterLogin: vi.fn() }} now={() => now} />);

    await screen.findByRole("heading", { name: "会议本" });
    rendered.unmount();
    refresh.resolve({ state: "paused_auth" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  test("keeps login unavailable until logout has settled", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const loggingOut = deferred<void>();
    const auth = api({ logout: vi.fn().mockImplementation(() => loggingOut.promise) });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);

    await screen.findByRole("heading", { name: "会议本" });
    await user.click(screen.getByRole("button", { name: "退出" }));
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在退出");
    loggingOut.resolve();

    await screen.findByRole("heading", { name: "登录会议本" });
  });

  test("keeps an explicit logout closed across online events even when logout fails", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const staleSession = deferred<{ id: string; sessionExpiresAt: string }>();
    const auth = api({
      me: vi.fn().mockResolvedValueOnce({ id: "owner", sessionExpiresAt: expiry }).mockImplementationOnce(() => staleSession.promise),
      logout: vi.fn().mockRejectedValue(new Error("offline")),
    });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);

    await screen.findByRole("heading", { name: "会议本" });
    await user.click(screen.getByRole("button", { name: "退出" }));
    await screen.findByRole("heading", { name: "登录会议本" });
    window.dispatchEvent(new Event("online"));
    staleSession.resolve({ id: "owner", sessionExpiresAt: expiry });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(auth.me).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "登录会议本" })).toBeVisible();
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(false);
  });
});
