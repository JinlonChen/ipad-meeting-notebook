import { describe, expect, test, vi } from "vitest";

import { AuthApiError, AuthNetworkError, authApi } from "../../src/auth/api.js";

const expiry = "2026-09-21T00:00:00.000Z";

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("authApi", () => {
  test("uses credentialed relative endpoints and validates the session response", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ id: "owner", sessionExpiresAt: expiry }))
      .mockResolvedValueOnce(response(undefined, 204))
      .mockResolvedValueOnce(response(undefined, 204));
    const api = authApi(fetcher);

    await expect(api.me()).resolves.toEqual({ id: "owner", sessionExpiresAt: expiry });
    await expect(api.login("not-retained-password")).resolves.toBeUndefined();
    await expect(api.logout()).resolves.toBeUndefined();

    expect(fetcher.mock.calls).toEqual([
      ["/api/auth/me", expect.objectContaining({ credentials: "include" })],
      ["/api/auth/login", expect.objectContaining({ method: "POST", credentials: "include", body: JSON.stringify({ password: "not-retained-password" }) })],
      ["/api/auth/logout", expect.objectContaining({ method: "POST", credentials: "include" })],
    ]);
  });

  test("returns safe typed failures without exposing response content", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: "sensitive detail" }, 401))
      .mockResolvedValueOnce(response({ bad: "shape" }));
    const api = authApi(fetcher);

    await expect(api.me()).rejects.toEqual(new AuthApiError(401, "AUTH_REQUIRED"));
    await expect(api.me()).rejects.toThrow();
  });

  test("distinguishes transport failures from HTTP and malformed session responses", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("socket unavailable"))
      .mockResolvedValueOnce(response({ internal: "do not expose" }, 500))
      .mockResolvedValueOnce(response({ id: "not-owner" }));
    const api = authApi(fetcher);

    await expect(api.me()).rejects.toEqual(new AuthNetworkError());
    await expect(api.me()).rejects.toEqual(new AuthApiError(500, "REQUEST_FAILED"));
    await expect(api.me()).rejects.toEqual(new AuthApiError(200, "REQUEST_FAILED"));
  });
});
