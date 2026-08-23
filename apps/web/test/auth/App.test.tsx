import { StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { App } from "../../src/app/App.js";
import { AuthApiError, AuthNetworkError, type AuthApi, type AuthSessionChange } from "../../src/auth/api.js";
import { MeetingCatalogRepository } from "../../src/meetings/repository.js";
import { CatalogSync, type MeetingCatalogApi } from "../../src/meetings/sync.js";

const now = "2026-08-21T00:00:00.000Z";
const expiry = "2026-09-21T00:00:00.000Z";
const userA = "00000000-0000-4000-8000-00000000000a";
const userB = "00000000-0000-4000-8000-00000000000b";
const repositories: MeetingCatalogRepository[] = [];
let databaseNumber = 0;

function repository() {
  const result = new MeetingCatalogRepository(`app-test-${databaseNumber++}`);
  repositories.push(result);
  return result;
}
function api(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    me: vi.fn().mockResolvedValue({ id: userA, sessionExpiresAt: expiry }),
    login: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    onSessionChange: vi.fn().mockReturnValue(() => undefined),
    ...overrides,
  };
}
function synchronizer(state: "idle" | "paused_auth" | "conflict" | "error" = "idle") {
  return { refresh: vi.fn().mockResolvedValue({ state }), pauseForUserChange: vi.fn(), resumeAfterLogin: vi.fn() };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}
afterEach(async () => {
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.all(repositories.splice(0).map((item) => item.deleteDatabase()));
});

describe("App session gate", () => {
  test("renders with injected dependencies without reading runtime configuration", async () => {
    const catalog = repository();
    render(<App repository={catalog} auth={api()} synchronizer={synchronizer()} now={() => now} />);

    await screen.findByRole("heading", { name: "会议本" });
    expect(screen.queryByText("Supabase")).not.toBeInTheDocument();
  });

  test("shows a fixed configuration panel without exposing runtime values", () => {
    render(<App configurationError />);

    expect(screen.getByRole("heading", { name: "需要配置云端服务" })).toBeVisible();
    expect(screen.getByText("请先配置 Supabase 后再启动会议本。")).toBeVisible();
    expect(screen.queryByText(/SUPABASE_CONFIGURATION_REQUIRED|https?:\/\//)).not.toBeInTheDocument();
  });

  test("shows a distinct safe startup panel for non-configuration failures", () => {
    const retry = vi.fn();
    render(<App startupError onStartupRetry={retry} />);

    expect(screen.getByRole("heading", { name: "无法启动会议本" })).toBeVisible();
    expect(screen.queryByText(/SUPABASE_CONFIGURATION_REQUIRED|private-value|https?:\/\//)).not.toBeInTheDocument();
    screen.getByRole("button", { name: "重试" }).click();
    expect(retry).toHaveBeenCalledOnce();
  });

  test("authorizes a successful session and enters the meeting catalog", async () => {
    const catalog = repository();
    render(<App repository={catalog} auth={api()} synchronizer={synchronizer()} now={() => now} />);

    await screen.findByRole("heading", { name: "会议本" });
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(true);
  });

  test("pauses stale synchronization before checking the authenticated session and resumes after activation", async () => {
    const calls: string[] = [];
    const catalog = repository();
    const sync = synchronizer();
    sync.pauseForUserChange.mockImplementation(() => { calls.push("pause"); });
    sync.resumeAfterLogin.mockImplementation(() => { calls.push("resume"); });
    const auth = api({ me: vi.fn().mockImplementation(async () => {
      calls.push("me");
      return { id: userA, sessionExpiresAt: expiry };
    }) });

    render(<App repository={catalog} auth={auth} synchronizer={sync} now={() => now} />);

    await screen.findByRole("heading", { name: "会议本" });
    expect(calls.slice(0, 3)).toEqual(["pause", "me", "resume"]);
  });

  test("pauses stale synchronization before login changes the remote session", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const catalog = repository();
    const sync = synchronizer();
    sync.pauseForUserChange.mockImplementation(() => { calls.push("pause"); });
    sync.resumeAfterLogin.mockImplementation(() => { calls.push("resume"); });
    const auth = api({
      me: vi.fn()
        .mockImplementationOnce(async () => { calls.push("me-initial"); throw new AuthApiError(401, "AUTH_REQUIRED"); })
        .mockImplementationOnce(async () => { calls.push("me-login"); return { id: userB, sessionExpiresAt: expiry }; }),
      login: vi.fn().mockImplementation(async () => { calls.push("login"); }),
    });
    render(<App repository={catalog} auth={auth} synchronizer={sync} now={() => now} />);
    await screen.findByRole("heading", { name: "登录会议本" });

    await user.type(screen.getByLabelText("邮箱"), "b@example.com");
    await user.type(screen.getByLabelText("密码"), "private-secret");
    await user.click(screen.getByRole("button", { name: "登录" }));

    await screen.findByRole("heading", { name: "会议本" });
    expect(calls).toEqual(["pause", "me-initial", "pause", "login", "me-login", "resume"]);
  });

  test("pauses stale synchronization before logout changes the remote session", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const sync = synchronizer();
    const auth = api();
    render(<App repository={catalog} auth={auth} synchronizer={sync} now={() => now} />);
    await screen.findByRole("heading", { name: "会议本" });

    await user.click(screen.getByRole("button", { name: "退出" }));

    await screen.findByRole("heading", { name: "登录会议本" });
    expect(sync.pauseForUserChange).toHaveBeenCalledTimes(2);
    expect(sync.pauseForUserChange.mock.invocationCallOrder[1]).toBeLessThan((auth.logout as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
  });

  test("switches users immediately for a cross-tab session without sending later A operations as B", async () => {
    const catalog = repository();
    await catalog.activateUser(userA);
    const first = await catalog.create("A first", null, now);
    const second = await catalog.create("A second", null, "2026-08-21T00:01:00.000Z");
    let authListener!: (change: AuthSessionChange) => void;
    const auth = api({
      me: vi.fn()
        .mockResolvedValueOnce({ id: userA, sessionExpiresAt: expiry })
        .mockResolvedValueOnce({ id: userB, sessionExpiresAt: expiry }),
      onSessionChange: vi.fn().mockImplementation((listener) => {
        authListener = listener;
        return () => undefined;
      }),
    });
    let releaseFirst!: (response: { meeting: typeof first }) => void;
    const firstResponse = new Promise<{ meeting: typeof first }>((resolve) => { releaseFirst = resolve; });
    const send = vi.fn().mockImplementationOnce(() => firstResponse).mockResolvedValue({ meeting: second });
    const remote: MeetingCatalogApi = {
      send,
      listFolders: vi.fn().mockResolvedValue([]),
      listMeetings: vi.fn().mockResolvedValue([]),
    };
    const sync = new CatalogSync(catalog, remote);
    render(<App repository={catalog} auth={auth} synchronizer={sync} now={() => now} />);
    await waitFor(() => expect(send).toHaveBeenCalledOnce());

    act(() => authListener({ event: "session", userId: userB }));
    await screen.findByText("还没有会议");
    releaseFirst({ meeting: first });

    await waitFor(() => expect(remote.listMeetings).toHaveBeenCalled());
    expect(send).toHaveBeenCalledOnce();
    await expect(catalog.pendingOperations()).resolves.toEqual([]);
    await catalog.activateUser(userA);
    await expect(catalog.pendingOperations()).resolves.toEqual([expect.objectContaining({ entityId: second.id })]);
  });

  test("clears local authorization immediately when another tab signs out", async () => {
    const catalog = repository();
    let authListener!: (change: AuthSessionChange) => void;
    const unsubscribe = vi.fn();
    const auth = api({ onSessionChange: vi.fn().mockImplementation((listener) => {
      authListener = listener;
      return unsubscribe;
    }) });
    const sync = synchronizer();
    const rendered = render(<App repository={catalog} auth={auth} synchronizer={sync} now={() => now} />);
    await screen.findByRole("heading", { name: "会议本" });
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(true);
    sync.pauseForUserChange.mockClear();

    act(() => authListener({ event: "signed_out", userId: null }));

    await screen.findByRole("heading", { name: "登录会议本" });
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(false);
    expect(sync.pauseForUserChange).toHaveBeenCalledOnce();
    rendered.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test("does not let an older cross-tab sign-out clear a newer user marker", async () => {
    const catalog = repository();
    const originalClear = catalog.clearDeviceAccess.bind(catalog);
    const releaseOldClear = deferred<void>();
    const oldClearFinished = deferred<void>();
    vi.spyOn(catalog, "clearDeviceAccess").mockImplementationOnce(async (expected) => {
      await releaseOldClear.promise;
      await originalClear(expected);
      oldClearFinished.resolve();
    });
    let authListener!: (change: AuthSessionChange) => void;
    const auth = api({
      me: vi.fn()
        .mockResolvedValueOnce({ id: userA, sessionExpiresAt: expiry })
        .mockResolvedValueOnce({ id: userB, sessionExpiresAt: expiry }),
      onSessionChange: vi.fn().mockImplementation((listener) => {
        authListener = listener;
        return () => undefined;
      }),
    });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);
    await screen.findByRole("heading", { name: "会议本" });

    act(() => authListener({ event: "signed_out", userId: null }));
    await waitFor(() => expect(catalog.clearDeviceAccess).toHaveBeenCalledOnce());
    act(() => authListener({ event: "session", userId: userB }));
    await screen.findByRole("heading", { name: "会议本" });
    await expect(catalog.validDeviceAccess(now)).resolves.toMatchObject({ userId: userB });

    releaseOldClear.resolve();
    await oldClearFinished.promise;
    await expect(catalog.validDeviceAccess(now)).resolves.toMatchObject({ userId: userB });
  });

  test("ignores same-user session refresh events without switching catalogs or refreshing", async () => {
    const catalog = repository();
    let authListener!: (change: AuthSessionChange) => void;
    const auth = api({ onSessionChange: vi.fn().mockImplementation((listener) => {
      authListener = listener;
      return () => undefined;
    }) });
    const sync = synchronizer();
    render(<App repository={catalog} auth={auth} synchronizer={sync} now={() => now} />);
    await screen.findByRole("heading", { name: "会议本" });
    await waitFor(() => expect(sync.refresh).toHaveBeenCalledOnce());
    vi.mocked(auth.me).mockClear();
    sync.pauseForUserChange.mockClear();
    sync.refresh.mockClear();

    act(() => authListener({ event: "session", userId: userA }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sync.pauseForUserChange).not.toHaveBeenCalled();
    expect(auth.me).not.toHaveBeenCalled();
    expect(sync.refresh).not.toHaveBeenCalled();
  });

  test("extends offline access on a same-user token refresh without pausing or refreshing the catalog", async () => {
    let currentNow = new Date("2026-08-21T00:00:00.000Z");
    const initialExpiry = "2026-08-21T00:01:00.000Z";
    const refreshedExpiry = "2026-08-21T00:02:00.000Z";
    const catalog = repository();
    let authListener!: (change: AuthSessionChange) => void;
    const auth = api({
      me: vi.fn().mockResolvedValue({ id: userA, sessionExpiresAt: initialExpiry }),
      onSessionChange: vi.fn().mockImplementation((listener) => {
        authListener = listener;
        return () => undefined;
      }),
    });
    const sync = synchronizer();
    render(<App repository={catalog} auth={auth} synchronizer={sync} now={() => currentNow.toISOString()} />);
    await screen.findByRole("heading", { name: "会议本" });
    await waitFor(() => expect(sync.refresh).toHaveBeenCalledOnce());
    vi.mocked(auth.me).mockClear();
    sync.pauseForUserChange.mockClear();
    sync.refresh.mockClear();

    act(() => authListener({ event: "token_refreshed", userId: userA, sessionExpiresAt: refreshedExpiry }));

    await waitFor(async () => expect(await catalog.validDeviceAccess(currentNow.toISOString())).toMatchObject({
      userId: userA,
      authorizedAt: "2026-08-21T00:00:00.000Z",
      expiresAt: refreshedExpiry,
    }));
    expect(sync.pauseForUserChange).not.toHaveBeenCalled();
    expect(auth.me).not.toHaveBeenCalled();
    expect(sync.refresh).not.toHaveBeenCalled();

    vi.useFakeTimers();
    act(() => window.dispatchEvent(new Event("offline")));
    currentNow = new Date(initialExpiry);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole("heading", { name: "会议本" })).toBeVisible();

    currentNow = new Date(refreshedExpiry);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole("heading", { name: "离线解锁需要登录" })).toBeVisible();
  });

  test("adopts the longest current marker returned for an out-of-order same-user refresh", async () => {
    let currentNow = new Date("2026-08-21T00:00:00.000Z");
    const initialExpiry = "2026-08-21T00:01:00.000Z";
    const longestExpiry = "2026-08-21T00:02:00.000Z";
    const catalog = repository();
    const refreshDeviceAccess = vi.spyOn(catalog, "refreshDeviceAccess").mockResolvedValue({
      userId: userA,
      authorizedAt: currentNow.toISOString(),
      expiresAt: longestExpiry,
    });
    let authListener!: (change: AuthSessionChange) => void;
    const auth = api({
      me: vi.fn().mockResolvedValue({ id: userA, sessionExpiresAt: initialExpiry }),
      onSessionChange: vi.fn().mockImplementation((listener) => {
        authListener = listener;
        return () => undefined;
      }),
    });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => currentNow.toISOString()} />);
    await screen.findByRole("heading", { name: "会议本" });

    await act(async () => {
      authListener({ event: "token_refreshed", userId: userA, sessionExpiresAt: "2026-08-21T00:00:30.000Z" });
      await Promise.resolve();
    });
    expect(refreshDeviceAccess).toHaveBeenCalledWith(userA, "2026-08-21T00:00:30.000Z");

    vi.useFakeTimers();
    act(() => window.dispatchEvent(new Event("offline")));
    currentNow = new Date(initialExpiry);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole("heading", { name: "会议本" })).toBeVisible();

    currentNow = new Date(longestExpiry);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole("heading", { name: "离线解锁需要登录" })).toBeVisible();
  });

  test("fully revalidates a token refresh that belongs to a different user", async () => {
    const catalog = repository();
    let authListener!: (change: AuthSessionChange) => void;
    const auth = api({
      me: vi.fn()
        .mockResolvedValueOnce({ id: userA, sessionExpiresAt: expiry })
        .mockResolvedValueOnce({ id: userB, sessionExpiresAt: expiry }),
      onSessionChange: vi.fn().mockImplementation((listener) => {
        authListener = listener;
        return () => undefined;
      }),
    });
    const sync = synchronizer();
    render(<App repository={catalog} auth={auth} synchronizer={sync} now={() => now} />);
    await screen.findByRole("heading", { name: "会议本" });
    sync.pauseForUserChange.mockClear();

    act(() => authListener({ event: "token_refreshed", userId: userB, sessionExpiresAt: expiry }));

    await waitFor(async () => expect(await catalog.validDeviceAccess(now)).toMatchObject({ userId: userB }));
    expect(auth.me).toHaveBeenCalledTimes(2);
    expect(sync.pauseForUserChange).toHaveBeenCalled();
  });

  test("does not let an older A token refresh overwrite a newer B marker", async () => {
    const catalog = repository();
    const releaseRefresh = deferred<void>();
    const refresh = catalog.refreshDeviceAccess.bind(catalog);
    vi.spyOn(catalog, "refreshDeviceAccess").mockImplementationOnce(async (...args) => {
      await releaseRefresh.promise;
      return refresh(...args);
    });
    let authListener!: (change: AuthSessionChange) => void;
    const auth = api({
      me: vi.fn()
        .mockResolvedValueOnce({ id: userA, sessionExpiresAt: expiry })
        .mockResolvedValueOnce({ id: userB, sessionExpiresAt: expiry }),
      onSessionChange: vi.fn().mockImplementation((listener) => {
        authListener = listener;
        return () => undefined;
      }),
    });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);
    await screen.findByRole("heading", { name: "会议本" });

    act(() => authListener({ event: "token_refreshed", userId: userA, sessionExpiresAt: "2026-10-21T00:00:00.000Z" }));
    await waitFor(() => expect(catalog.refreshDeviceAccess).toHaveBeenCalledOnce());
    act(() => authListener({ event: "session", userId: userB }));
    await waitFor(async () => expect(await catalog.validDeviceAccess(now)).toMatchObject({ userId: userB }));
    releaseRefresh.resolve();

    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(catalog.validDeviceAccess(now)).resolves.toMatchObject({ userId: userB });
    expect(screen.getByRole("heading", { name: "会议本" })).toBeVisible();
  });

  test("locks safely when persisting a same-user token refresh fails and recovers through revalidation", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    let authListener!: (change: AuthSessionChange) => void;
    vi.spyOn(catalog, "refreshDeviceAccess").mockRejectedValueOnce(new Error("private-refresh-value"));
    const auth = api({ onSessionChange: vi.fn().mockImplementation((listener) => {
      authListener = listener;
      return () => undefined;
    }) });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);
    await screen.findByRole("heading", { name: "会议本" });

    act(() => authListener({ event: "token_refreshed", userId: userA, sessionExpiresAt: "2026-10-21T00:00:00.000Z" }));

    await screen.findByRole("heading", { name: "无法验证访问权限" });
    expect(catalog.refreshDeviceAccess).toHaveBeenCalledOnce();
    expect(document.body).not.toHaveTextContent("private-refresh-value");
    expect(screen.queryByRole("heading", { name: "会议本" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("heading", { name: "会议本" });
  });

  test("fails closed on malformed cross-tab auth events without exposing event details", async () => {
    const catalog = repository();
    let authListener!: (change: AuthSessionChange) => void;
    const auth = api({ onSessionChange: vi.fn().mockImplementation((listener) => {
      authListener = listener;
      return () => undefined;
    }) });
    const sync = synchronizer();
    render(<App repository={catalog} auth={auth} synchronizer={sync} now={() => now} />);
    await screen.findByRole("heading", { name: "会议本" });
    sync.pauseForUserChange.mockClear();

    act(() => authListener({ event: "invalid", userId: null }));

    await screen.findByRole("heading", { name: "无法验证访问权限" });
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(false);
    expect(sync.pauseForUserChange).toHaveBeenCalledOnce();
    expect(document.body).not.toHaveTextContent(/token|email|private/i);
  });

  test("does not double-authorize callbacks emitted by this tab's login and logout", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    let authListener!: (change: AuthSessionChange) => void;
    const me = vi.fn()
      .mockRejectedValueOnce(new AuthApiError(401, "AUTH_REQUIRED"))
      .mockResolvedValueOnce({ id: userB, sessionExpiresAt: expiry });
    const auth = api({
      me,
      onSessionChange: vi.fn().mockImplementation((listener) => {
        authListener = listener;
        return () => undefined;
      }),
      login: vi.fn().mockImplementation(async () => { authListener({ event: "session", userId: userB }); }),
      logout: vi.fn().mockImplementation(async () => { authListener({ event: "signed_out", userId: null }); }),
    });
    const sync = synchronizer();
    render(<App repository={catalog} auth={auth} synchronizer={sync} now={() => now} />);
    await screen.findByRole("heading", { name: "登录会议本" });

    await user.type(screen.getByLabelText("邮箱"), "b@example.com");
    await user.type(screen.getByLabelText("密码"), "private-secret");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByRole("heading", { name: "会议本" });
    await user.click(screen.getByRole("button", { name: "退出" }));
    await screen.findByRole("heading", { name: "登录会议本" });

    expect(me).toHaveBeenCalledTimes(2);
    expect(sync.pauseForUserChange).toHaveBeenCalledTimes(5);
    expect(sync.resumeAfterLogin).toHaveBeenCalledOnce();
  });

  test("invalidates an older login when session events change from A to B", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const loginRequest = deferred<void>();
    const staleUserA = deferred<{ id: string; sessionExpiresAt: string }>();
    let authListener!: (change: AuthSessionChange) => void;
    const me = vi.fn()
      .mockRejectedValueOnce(new AuthApiError(401, "AUTH_REQUIRED"))
      .mockImplementationOnce(() => staleUserA.promise)
      .mockResolvedValueOnce({ id: userB, sessionExpiresAt: expiry });
    const auth = api({
      me,
      login: vi.fn().mockImplementation(() => loginRequest.promise),
      onSessionChange: vi.fn().mockImplementation((listener) => {
        authListener = listener;
        return () => undefined;
      }),
    });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);
    await screen.findByRole("heading", { name: "登录会议本" });

    await user.type(screen.getByLabelText("邮箱"), "person@example.com");
    await user.type(screen.getByLabelText("密码"), "private-secret");
    void user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(auth.login).toHaveBeenCalledOnce());
    act(() => authListener({ event: "session", userId: userA }));
    await waitFor(() => expect(me).toHaveBeenCalledTimes(2));
    act(() => authListener({ event: "session", userId: userB }));

    await screen.findByRole("heading", { name: "会议本" });
    staleUserA.resolve({ id: userA, sessionExpiresAt: expiry });
    loginRequest.resolve();
    await waitFor(async () => expect(await catalog.validDeviceAccess(now)).toMatchObject({ userId: userB }));
    expect(me).toHaveBeenCalledTimes(3);
  });

  test("switches local catalogs with the authenticated Supabase user", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    await catalog.activateUser(userA);
    await catalog.create("A 的本地会议", null, now);
    const auth = api({
      me: vi.fn()
        .mockResolvedValueOnce({ id: userA, sessionExpiresAt: expiry })
        .mockResolvedValueOnce({ id: userB, sessionExpiresAt: expiry })
        .mockResolvedValueOnce({ id: userA, sessionExpiresAt: expiry }),
    });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);
    await screen.findByText("A 的本地会议");

    await user.click(screen.getByRole("button", { name: "退出" }));
    await user.type(await screen.findByLabelText("邮箱"), "b@example.com");
    await user.type(screen.getByLabelText("密码"), "private-secret");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByText("还没有会议");
    expect(screen.queryByText("A 的本地会议")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "退出" }));
    await user.type(await screen.findByLabelText("邮箱"), "a@example.com");
    await user.type(screen.getByLabelText("密码"), "private-secret");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByText("A 的本地会议");
  });

  test("clears device authorization before showing login for an initial 401", async () => {
    const catalog = repository();
    await catalog.authorizeDevice(userA, expiry, now);
    render(<App repository={catalog} auth={api({ me: vi.fn().mockRejectedValue(new AuthApiError(401, "AUTH_REQUIRED")) })} synchronizer={synchronizer()} now={() => now} />);

    await screen.findByRole("heading", { name: "登录会议本" });
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(false);
  });

  test("stays behind a safe retry when an initial 401 cannot clear device authorization", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    await catalog.authorizeDevice(userA, expiry, now);
    vi.spyOn(catalog, "clearDeviceAccess").mockRejectedValueOnce(new Error("private-value"));
    render(<App repository={catalog} auth={api({ me: vi.fn().mockRejectedValue(new AuthApiError(401, "AUTH_REQUIRED")) })} synchronizer={synchronizer()} now={() => now} />);

    await screen.findByRole("heading", { name: "无法验证访问权限" });
    expect(screen.queryByText("private-value")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "登录会议本" })).not.toBeInTheDocument();
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(true);
    await user.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("heading", { name: "登录会议本" });
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(false);
  });

  test("clears authorization again when the post-login session check returns 401", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const auth = api({ me: vi.fn().mockRejectedValue(new AuthApiError(401, "AUTH_REQUIRED")) });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);
    await screen.findByRole("heading", { name: "登录会议本" });
    await catalog.authorizeDevice(userA, expiry, now);

    await user.type(screen.getByLabelText("邮箱"), "a@example.com");
    await user.type(screen.getByLabelText("密码"), "private-secret");
    await user.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(auth.me).toHaveBeenCalledTimes(2));
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(false);
    expect(screen.getByRole("heading", { name: "登录会议本" })).toBeVisible();
  });

  test("shows the safe error when a post-login 401 cannot clear authorization", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const auth = api({ me: vi.fn().mockRejectedValue(new AuthApiError(401, "AUTH_REQUIRED")) });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);
    await screen.findByRole("heading", { name: "登录会议本" });
    await catalog.authorizeDevice(userA, expiry, now);
    vi.spyOn(catalog, "clearDeviceAccess").mockRejectedValueOnce(new Error("private-value"));

    await user.type(screen.getByLabelText("邮箱"), "a@example.com");
    await user.type(screen.getByLabelText("密码"), "private-secret");
    await user.click(screen.getByRole("button", { name: "登录" }));

    await screen.findByRole("heading", { name: "无法验证访问权限" });
    expect(screen.queryByText("private-value")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "登录会议本" })).not.toBeInTheDocument();
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(true);
  });

  test("keeps the catalog locked when a sync 401 cannot clear authorization", async () => {
    const catalog = repository();
    vi.spyOn(catalog, "clearDeviceAccess").mockRejectedValueOnce(new Error("private-value"));
    render(<App repository={catalog} auth={api()} synchronizer={synchronizer("paused_auth")} now={() => now} />);

    await screen.findByRole("heading", { name: "无法验证访问权限" });
    expect(screen.queryByRole("heading", { name: "登录会议本" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "会议本" })).not.toBeInTheDocument();
    expect(screen.queryByText("private-value")).not.toBeInTheDocument();
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(true);
  });

  test("keeps authorization active through StrictMode's effect restart", async () => {
    const catalog = repository();
    render(<StrictMode><App repository={catalog} auth={api()} synchronizer={synchronizer()} now={() => now} /></StrictMode>);

    await screen.findByRole("heading", { name: "会议本" });
  });

  test("keeps an unexpired local marker available offline but keeps expired access behind the login gate", async () => {
    const valid = repository();
    await valid.authorizeDevice(userA, expiry, now);
    const offlineSync = synchronizer();
    const rendered = render(<App repository={valid} auth={api({ me: vi.fn().mockRejectedValue(new AuthNetworkError()) })} synchronizer={offlineSync} now={() => now} />);
    await screen.findByText("离线，0 项待同步");
    expect(offlineSync.pauseForUserChange).toHaveBeenCalledOnce();
    expect(offlineSync.resumeAfterLogin).not.toHaveBeenCalled();
    expect(offlineSync.refresh).not.toHaveBeenCalled();
    rendered.unmount();

    const expired = repository();
    await expired.authorizeDevice(userA, now, "2026-08-01T00:00:00.000Z");
    render(<App repository={expired} auth={api({ me: vi.fn().mockRejectedValue(new AuthNetworkError()) })} synchronizer={synchronizer()} now={() => now} />);
    await screen.findByRole("heading", { name: "离线解锁需要登录" });
  });

  test("does not treat Supabase's initial persisted session as an external offline user switch", async () => {
    const catalog = repository();
    await catalog.authorizeDevice(userA, expiry, now);
    const auth = api({
      me: vi.fn().mockRejectedValue(new AuthNetworkError()),
      onSessionChange: vi.fn().mockImplementation((listener) => {
        listener({ event: "initial", userId: userA } as AuthSessionChange);
        return () => undefined;
      }),
    });

    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);

    await screen.findByText("离线，0 项待同步");
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(true);
  });

  test.each([
    ["different user", userB],
    ["signed out", null],
  ])("rejects offline marker A when the initial session is %s", async (_label, initialUserId) => {
    const catalog = repository();
    await catalog.authorizeDevice(userA, expiry, now);
    const auth = api({
      me: vi.fn().mockRejectedValue(new AuthNetworkError()),
      onSessionChange: vi.fn().mockImplementation((listener) => {
        listener({ event: "initial", userId: initialUserId } as AuthSessionChange);
        return () => undefined;
      }),
    });

    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);

    await screen.findByRole("heading", { name: "离线解锁需要登录" });
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(false);
  });

  test("clears an A marker when a delayed initial session B arrives after the offline catalog opens", async () => {
    const catalog = repository();
    await catalog.authorizeDevice(userA, expiry, now);
    let authListener!: (change: AuthSessionChange) => void;
    const auth = api({
      me: vi.fn().mockRejectedValue(new AuthNetworkError()),
      onSessionChange: vi.fn().mockImplementation((listener) => {
        authListener = listener;
        return () => undefined;
      }),
    });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);
    await screen.findByText("离线，0 项待同步");

    act(() => authListener({ event: "initial", userId: userB }));

    await screen.findByRole("heading", { name: "离线解锁需要登录" });
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(false);
  });

  test("fails closed with a fixed retry when an initial mismatch marker cannot be cleared", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    await catalog.authorizeDevice(userA, expiry, now);
    vi.spyOn(catalog, "clearDeviceAccess").mockRejectedValueOnce(new Error("private-clear-value"));
    const auth = api({
      me: vi.fn().mockRejectedValue(new AuthNetworkError()),
      onSessionChange: vi.fn().mockImplementation((listener) => {
        listener({ event: "initial", userId: userB });
        return () => undefined;
      }),
    });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);

    await screen.findByRole("heading", { name: "无法验证访问权限" });
    expect(document.body).not.toHaveTextContent("private-clear-value");
    expect(screen.queryByRole("heading", { name: "会议本" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("heading", { name: "离线解锁需要登录" });
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(false);
  });

  test("does not refresh as online until an offline catalog revalidates its session", async () => {
    const catalog = repository();
    await catalog.authorizeDevice(userA, expiry, now);
    const reauthorization = deferred<{ id: string; sessionExpiresAt: string }>();
    const auth = api({
      me: vi.fn()
        .mockRejectedValueOnce(new AuthNetworkError())
        .mockImplementationOnce(() => reauthorization.promise),
    });
    const sync = synchronizer();
    render(<App repository={catalog} auth={auth} synchronizer={sync} now={() => now} />);
    await screen.findByText("离线，0 项待同步");

    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(sync.pauseForUserChange).toHaveBeenCalledTimes(2));
    expect(sync.refresh).not.toHaveBeenCalled();

    reauthorization.resolve({ id: userA, sessionExpiresAt: expiry });
    await waitFor(() => expect(sync.refresh).toHaveBeenCalledOnce());
  });

  test("locks an open offline catalog when its device authorization expires", async () => {
    let currentNow = new Date("2026-08-21T00:00:00.000Z");
    const expiresAt = "2026-08-21T00:01:00.000Z";
    const catalog = repository();
    render(<App repository={catalog} auth={api({ me: vi.fn().mockResolvedValue({ id: userA, sessionExpiresAt: expiresAt }) })} synchronizer={synchronizer()} now={() => currentNow.toISOString()} />);
    await screen.findByRole("heading", { name: "会议本" });

    vi.useFakeTimers();
    act(() => window.dispatchEvent(new Event("offline")));
    currentNow = new Date(expiresAt);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.getByRole("heading", { name: "离线解锁需要登录" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "会议本" })).not.toBeInTheDocument();
  });

  test("does not unlock local catalog for HTTP or malformed session failures", async () => {
    const catalog = repository();
    await catalog.authorizeDevice(userA, expiry, now);
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

  test("composes synchronization from an injected catalog without runtime configuration", async () => {
    const catalog = repository();
    const meeting = await catalog.create("待同步", null, now);
    const remote: MeetingCatalogApi = {
      send: vi.fn().mockResolvedValue({ meeting }),
      listFolders: vi.fn().mockResolvedValue([]),
      listMeetings: vi.fn().mockResolvedValue([meeting]),
    };

    render(<App repository={catalog} auth={api()} catalog={remote} now={() => now} />);
    await screen.findByRole("heading", { name: "会议本" });
    await waitFor(async () => expect(await catalog.pendingOperations()).toEqual([]));
    expect(remote.send).toHaveBeenCalledTimes(1);
  });

  test("resumes the same injected catalog synchronizer before retrying catalog refresh", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const synchronizer = {
      refresh: vi.fn().mockResolvedValueOnce({ state: "paused_auth" as const }).mockResolvedValue({ state: "idle" as const }),
      pauseForUserChange: vi.fn(),
      resumeAfterLogin: vi.fn(),
    };
    const auth = api({ me: vi.fn().mockRejectedValueOnce(new AuthApiError(401, "AUTH_REQUIRED")).mockResolvedValue({ id: userA, sessionExpiresAt: expiry }) });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer} now={() => now} />);

    await user.type(await screen.findByLabelText("邮箱"), "person@example.com");
    await user.type(screen.getByLabelText("密码"), "private-secret");
    await user.click(screen.getByRole("button", { name: "登录" }));
    expect(auth.login).toHaveBeenLastCalledWith("person@example.com", "private-secret");
    await waitFor(() => expect(synchronizer.refresh).toHaveBeenCalledTimes(1));
    await user.type(await screen.findByLabelText("邮箱"), "person@example.com");
    await user.type(screen.getByLabelText("密码"), "private-secret");
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
    const auth = api({ me: vi.fn().mockRejectedValueOnce(Object.assign(new Error("required"), { status: 401 })).mockResolvedValue({ id: userA, sessionExpiresAt: expiry }) });
    await catalog.create("保留的会议", null, now);
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);
    const email = await screen.findByLabelText("邮箱");
    const password = await screen.findByLabelText("密码");
    await user.type(email, "person@example.com");
    await user.type(password, "private-secret");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(password).toHaveValue(""));
    expect(email).toHaveValue("person@example.com");
    await screen.findByRole("heading", { name: "会议本" });
    await user.click(screen.getByRole("button", { name: "退出" }));
    await screen.findByRole("heading", { name: "登录会议本" });
    await expect(catalog.list()).resolves.toMatchObject([{ title: "保留的会议" }]);
  });

  test("logout invalidates an older authorization and leaves no device marker after it succeeds", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const stale = deferred<{ id: string; sessionExpiresAt: string }>();
    const auth = api({ me: vi.fn().mockResolvedValueOnce({ id: userA, sessionExpiresAt: expiry }).mockImplementationOnce(() => stale.promise) });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);

    await screen.findByRole("heading", { name: "会议本" });
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(auth.me).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "退出" }));
    stale.resolve({ id: userA, sessionExpiresAt: expiry });

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
        .mockResolvedValueOnce({ id: userA, sessionExpiresAt: expiry }),
    });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);

    await screen.findByRole("heading", { name: "登录会议本" });
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(auth.me).toHaveBeenCalledTimes(2));
    await user.type(screen.getByLabelText("邮箱"), "person@example.com");
    await user.type(screen.getByLabelText("密码"), "private-secret");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByRole("heading", { name: "会议本" });
    stale.resolve({ id: userA, sessionExpiresAt: now });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(async () => expect(await catalog.hasDeviceAccess(now)).toBe(true));
  });

  test("does not commit a deferred authorization after unmount", async () => {
    const catalog = repository();
    const pending = deferred<{ id: string; sessionExpiresAt: string }>();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rendered = render(<App repository={catalog} auth={api({ me: vi.fn().mockImplementation(() => pending.promise) })} synchronizer={synchronizer()} now={() => now} />);

    rendered.unmount();
    pending.resolve({ id: userA, sessionExpiresAt: expiry });
    await Promise.resolve();
    await Promise.resolve();

    expect(error).not.toHaveBeenCalled();
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(false);
    error.mockRestore();
  });

  test("does not let an older paused refresh clear a newer login session", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const refresh = deferred<{ state: "paused_auth" }>();
    const auth = api({ me: vi.fn().mockResolvedValue({ id: userA, sessionExpiresAt: expiry }) });
    const sync = { refresh: vi.fn().mockImplementationOnce(() => refresh.promise).mockResolvedValue({ state: "idle" as const }), pauseForUserChange: vi.fn(), resumeAfterLogin: vi.fn() };
    render(<App repository={catalog} auth={auth} synchronizer={sync} now={() => now} />);

    await screen.findByRole("heading", { name: "会议本" });
    await waitFor(() => expect(sync.refresh).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "退出" }));
    await screen.findByRole("heading", { name: "登录会议本" });
    await user.type(screen.getByLabelText("邮箱"), "person@example.com");
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
    const rendered = render(<App repository={catalog} auth={api()} synchronizer={{ refresh: vi.fn().mockImplementation(() => refresh.promise), pauseForUserChange: vi.fn(), resumeAfterLogin: vi.fn() }} now={() => now} />);

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

  test("does not enter login when clearing local access fails and allows a safe retry", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const clear = vi.spyOn(catalog, "clearDeviceAccess").mockRejectedValueOnce(new Error("private-value"));
    const auth = api();
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);
    await screen.findByRole("heading", { name: "会议本" });

    await user.click(screen.getByRole("button", { name: "退出" }));
    await screen.findByRole("heading", { name: "无法安全退出" });
    expect(screen.queryByRole("heading", { name: "登录会议本" })).not.toBeInTheDocument();
    expect(screen.queryByText("private-value")).not.toBeInTheDocument();
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(true);

    await user.click(screen.getByRole("button", { name: "重试退出" }));
    await screen.findByRole("heading", { name: "登录会议本" });
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(false);
    expect(clear).toHaveBeenCalledTimes(2);
  });

  test("keeps an explicit logout closed across online events even when logout fails", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const staleSession = deferred<{ id: string; sessionExpiresAt: string }>();
    const auth = api({
      me: vi.fn().mockResolvedValueOnce({ id: userA, sessionExpiresAt: expiry }).mockImplementationOnce(() => staleSession.promise),
      logout: vi.fn().mockRejectedValue(new Error("offline")),
    });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);

    await screen.findByRole("heading", { name: "会议本" });
    await user.click(screen.getByRole("button", { name: "退出" }));
    await screen.findByRole("heading", { name: "登录会议本" });
    window.dispatchEvent(new Event("online"));
    staleSession.resolve({ id: userA, sessionExpiresAt: expiry });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(auth.me).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "登录会议本" })).toBeVisible();
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(false);
  });

  test("keeps an explicit logout closed when another tab reports a new session", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    let authListener!: (change: AuthSessionChange) => void;
    const auth = api({ onSessionChange: vi.fn().mockImplementation((listener) => {
      authListener = listener;
      return () => undefined;
    }) });
    render(<App repository={catalog} auth={auth} synchronizer={synchronizer()} now={() => now} />);
    await screen.findByRole("heading", { name: "会议本" });
    await user.click(screen.getByRole("button", { name: "退出" }));
    await screen.findByRole("heading", { name: "登录会议本" });
    vi.mocked(auth.me).mockClear();

    act(() => authListener({ event: "session", userId: userB }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByRole("heading", { name: "登录会议本" })).toBeVisible();
    expect(auth.me).not.toHaveBeenCalled();
  });
});
