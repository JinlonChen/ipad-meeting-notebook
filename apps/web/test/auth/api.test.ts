import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, test, vi } from "vitest";

import {
  AuthApiError,
  AuthNetworkError,
  legacyHttpAuthApi,
  supabaseAuthApi,
} from "../../src/auth/api.js";
import type { Database } from "../../src/supabase/types.js";

const userId = "550e8400-e29b-41d4-a716-446655440000";
const expiry = "2099-09-07T00:00:00.000Z";
const expirySeconds = Date.parse(expiry) / 1_000;

type Client = Pick<SupabaseClient<Database>, "auth">;

function client(auth: Record<string, unknown>): Client {
  return { auth } as unknown as Client;
}

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("supabaseAuthApi", () => {
  test("subscribes to safe session identities and unsubscribes from Supabase auth events", () => {
    let callback!: (event: string, session: unknown) => void;
    const unsubscribe = vi.fn();
    const onAuthStateChange = vi.fn().mockImplementation((listener) => {
      callback = listener;
      return { data: { subscription: { unsubscribe } } };
    });
    const listener = vi.fn();
    const api = supabaseAuthApi(client({ onAuthStateChange }));

    const stop = api.onSessionChange(listener);
    callback("INITIAL_SESSION", { access_token: "secret-initial-jwt", user: { id: userId, email: "secret@example.com" } });
    callback("SIGNED_IN", { access_token: "secret-jwt", user: { id: userId, email: "secret@example.com" } });
    callback("SIGNED_OUT", null);

    expect(listener.mock.calls).toEqual([
      [{ event: "initial", userId }],
      [{ event: "session", userId }],
      [{ event: "signed_out", userId: null }],
    ]);
    expect(JSON.stringify(listener.mock.calls)).not.toMatch(/secret-(initial-)?jwt|secret@example\.com/);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test("maps malformed auth event users to one safe invalid event", () => {
    let callback!: (event: string, session: unknown) => void;
    const onAuthStateChange = vi.fn().mockImplementation((listener) => {
      callback = listener;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    const listener = vi.fn();
    const api = supabaseAuthApi(client({ onAuthStateChange }));
    api.onSessionChange(listener);

    callback("TOKEN_REFRESHED", { access_token: "private-token", user: { id: "private@example.com", email: "private@example.com" } });

    expect(listener).toHaveBeenCalledWith({ event: "invalid", userId: null });
    expect(JSON.stringify(listener.mock.calls)).not.toMatch(/private-token|private@example\.com/);
  });

  test("verifies the remote user before reading and normalizing the current session expiry", async () => {
    const calls: string[] = [];
    const getUser = vi.fn().mockImplementation(async () => {
      calls.push("getUser");
      return { data: { user: { id: userId } }, error: null };
    });
    const getSession = vi.fn().mockImplementation(async () => {
      calls.push("getSession");
      return { data: { session: { user: { id: userId }, expires_at: expirySeconds } }, error: null };
    });
    const api = supabaseAuthApi(client({ getUser, getSession }));

    await expect(api.me()).resolves.toEqual({ id: userId, sessionExpiresAt: expiry });
    expect(calls).toEqual(["getUser", "getSession"]);
  });

  test("rejects a session whose validated user differs from getUser without exposing either identity", async () => {
    const otherUserId = "00000000-0000-4000-8000-00000000000b";
    const api = supabaseAuthApi(client({
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: userId } }, error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: otherUserId }, expires_at: expirySeconds } }, error: null }),
    }));

    await expect(api.me()).rejects.toEqual(new AuthApiError(401, "AUTH_REQUIRED"));
  });

  test("rejects malformed current-session user UUIDs without exposing returned data", async () => {
    const api = supabaseAuthApi(client({
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: userId } }, error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "private@example.com" }, expires_at: expirySeconds } }, error: null }),
    }));

    await expect(api.me()).rejects.toEqual(new AuthApiError(500, "REQUEST_FAILED"));
  });

  test.each([
    ["missing user", { data: { user: null }, error: null }],
    ["unauthorized user", { data: { user: null }, error: { status: 401, message: "JWT: secret-token" } }],
  ])("maps %s to a safe auth-required failure", async (_label, userResult) => {
    const getSession = vi.fn();
    const api = supabaseAuthApi(client({ getUser: vi.fn().mockResolvedValue(userResult), getSession }));

    await expect(api.me()).rejects.toEqual(new AuthApiError(401, "AUTH_REQUIRED"));
    expect(getSession).not.toHaveBeenCalled();
  });

  test("requires a present, unexpired session with a valid expiry", async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: userId } }, error: null });
    const getSession = vi.fn()
      .mockResolvedValueOnce({ data: { session: null }, error: null })
      .mockResolvedValueOnce({ data: { session: { user: { id: userId }, expires_at: 1_700_000_000 } }, error: null })
      .mockResolvedValueOnce({ data: { session: { user: { id: userId }, expires_at: "secret-refresh-token" } }, error: null });
    const api = supabaseAuthApi(client({ getUser, getSession }));

    await expect(api.me()).rejects.toEqual(new AuthApiError(401, "AUTH_REQUIRED"));
    await expect(api.me()).rejects.toEqual(new AuthApiError(401, "AUTH_REQUIRED"));
    await expect(api.me()).rejects.toEqual(new AuthApiError(500, "REQUEST_FAILED"));
  });

  test("safely maps current-session auth, transport, and service failures", async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: userId } }, error: null });
    const getSession = vi.fn()
      .mockResolvedValueOnce({ data: { session: null }, error: { status: 401, message: "secret JWT" } })
      .mockRejectedValueOnce(new TypeError("refresh-token-secret"))
      .mockResolvedValueOnce({ data: { session: null }, error: { status: 500, message: "internal secret" } });
    const api = supabaseAuthApi(client({ getUser, getSession }));

    await expect(api.me()).rejects.toEqual(new AuthApiError(401, "AUTH_REQUIRED"));
    await expect(api.me()).rejects.toEqual(new AuthNetworkError());
    await expect(api.me()).rejects.toEqual(new AuthApiError(500, "REQUEST_FAILED"));
  });

  test.each([
    ["user", null, { session: { user: { id: userId }, expires_at: expirySeconds } }],
    ["session", { user: { id: userId } }, null],
  ])("maps malformed successful %s data to a safe request failure", async (_label, userData, sessionData) => {
    const api = supabaseAuthApi(client({
      getUser: vi.fn().mockResolvedValue({ data: userData, error: null }),
      getSession: vi.fn().mockResolvedValue({ data: sessionData, error: null }),
    }));

    await expect(api.me()).rejects.toEqual(new AuthApiError(500, "REQUEST_FAILED"));
  });

  test("rejects malformed remote user UUIDs without exposing returned data", async () => {
    const api = supabaseAuthApi(client({
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: "email@example.com" } }, error: null }),
      getSession: vi.fn(),
    }));

    await expect(api.me()).rejects.toEqual(new AuthApiError(500, "REQUEST_FAILED"));
  });

  test("signs in with email and password and signs out", async () => {
    const signInWithPassword = vi.fn().mockResolvedValue({ data: {}, error: null });
    const signOut = vi.fn().mockResolvedValue({ error: null });
    const api = supabaseAuthApi(client({ signInWithPassword, signOut }));

    await expect(api.login("person@example.com", "not-retained-password")).resolves.toBeUndefined();
    await expect(api.logout()).resolves.toBeUndefined();
    expect(signInWithPassword).toHaveBeenCalledWith({ email: "person@example.com", password: "not-retained-password" });
    expect(signOut).toHaveBeenCalledWith();
  });

  test("maps thrown transport failures without leaking credentials", async () => {
    const api = supabaseAuthApi(client({
      signInWithPassword: vi.fn().mockRejectedValue(new TypeError("person@example.com not-retained-password")),
    }));

    await expect(api.login("person@example.com", "not-retained-password")).rejects.toEqual(new AuthNetworkError());
  });

  test("maps returned network, unauthorized, and other failures to safe errors", async () => {
    const signInWithPassword = vi.fn()
      .mockResolvedValueOnce({ data: {}, error: { status: 0, name: "AuthRetryableFetchError", message: "email and password" } })
      .mockResolvedValueOnce({ data: {}, error: { status: 400, code: "invalid_credentials", message: "email and password" } });
    const signOut = vi.fn().mockResolvedValue({ error: { status: 500, message: "refresh-token-secret" } });
    const api = supabaseAuthApi(client({ signInWithPassword, signOut }));

    await expect(api.login("person@example.com", "not-retained-password")).rejects.toEqual(new AuthNetworkError());
    await expect(api.login("person@example.com", "not-retained-password")).rejects.toEqual(new AuthApiError(401, "AUTH_REQUIRED"));
    await expect(api.logout()).rejects.toEqual(new AuthApiError(500, "REQUEST_FAILED"));
  });

  test.each(["session_expired", "no_authorization"])("maps 400 %s auth errors to AUTH_REQUIRED", async (code) => {
    const api = supabaseAuthApi(client({
      signInWithPassword: vi.fn().mockResolvedValue({ data: {}, error: { status: 400, code, message: "raw auth details" } }),
    }));

    await expect(api.login("person@example.com", "not-retained-password")).rejects.toEqual(new AuthApiError(401, "AUTH_REQUIRED"));
  });
});

describe("legacyHttpAuthApi", () => {
  test("provides a compatible no-op session subscription", () => {
    const listener = vi.fn();
    const stop = legacyHttpAuthApi(vi.fn()).onSessionChange(listener);

    expect(listener).not.toHaveBeenCalled();
    expect(stop()).toBeUndefined();
  });

  test("keeps local HTTP composition working while accepting the unified login interface", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ id: "owner", sessionExpiresAt: "2026-09-21T00:00:00.000Z" }))
      .mockResolvedValueOnce(response(undefined, 204))
      .mockResolvedValueOnce(response(undefined, 204));
    const api = legacyHttpAuthApi(fetcher);

    await expect(api.me()).resolves.toEqual({ id: "owner", sessionExpiresAt: "2026-09-21T00:00:00.000Z" });
    await expect(api.login("ignored@example.com", "not-retained-password")).resolves.toBeUndefined();
    await expect(api.logout()).resolves.toBeUndefined();

    expect(fetcher.mock.calls).toEqual([
      ["/api/auth/me", expect.objectContaining({ credentials: "include" })],
      ["/api/auth/login", expect.objectContaining({ method: "POST", credentials: "include", body: JSON.stringify({ password: "not-retained-password" }) })],
      ["/api/auth/logout", expect.objectContaining({ method: "POST", credentials: "include" })],
    ]);
  });

  test("retains safe HTTP and transport error mapping", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("socket unavailable"))
      .mockResolvedValueOnce(response({ internal: "do not expose" }, 401))
      .mockResolvedValueOnce(response({ internal: "do not expose" }, 500))
      .mockResolvedValueOnce(response({ id: "not-owner" }));
    const api = legacyHttpAuthApi(fetcher);

    await expect(api.me()).rejects.toEqual(new AuthNetworkError());
    await expect(api.me()).rejects.toEqual(new AuthApiError(401, "AUTH_REQUIRED"));
    await expect(api.me()).rejects.toEqual(new AuthApiError(500, "REQUEST_FAILED"));
    await expect(api.me()).rejects.toEqual(new AuthApiError(200, "REQUEST_FAILED"));
  });
});
