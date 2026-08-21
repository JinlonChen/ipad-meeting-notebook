import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { App } from "../../src/app/App.js";
import type { AuthApi } from "../../src/auth/api.js";
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
afterEach(async () => { await Promise.all(repositories.splice(0).map((item) => item.deleteDatabase())); });

describe("App session gate", () => {
  test("authorizes a successful session and enters the meeting catalog", async () => {
    const catalog = repository();
    render(<App repository={catalog} auth={api()} refresh={async () => ({ state: "idle" })} now={() => now} />);

    await screen.findByRole("heading", { name: "会议本" });
    await expect(catalog.hasDeviceAccess(now)).resolves.toBe(true);
  });

  test("keeps an unexpired local marker available offline but keeps expired access behind the login gate", async () => {
    const valid = repository();
    await valid.authorizeDevice(expiry, now);
    const rendered = render(<App repository={valid} auth={api({ me: vi.fn().mockRejectedValue(new TypeError("network")) })} refresh={async () => ({ state: "idle" })} now={() => now} />);
    await screen.findByText("离线，等待同步");
    rendered.unmount();

    const expired = repository();
    await expired.authorizeDevice(now, "2026-08-01T00:00:00.000Z");
    render(<App repository={expired} auth={api({ me: vi.fn().mockRejectedValue(new TypeError("network")) })} refresh={async () => ({ state: "idle" })} now={() => now} />);
    await screen.findByRole("heading", { name: "离线解锁需要登录" });
  });

  test("clears an uncontrolled password field after login and logout retains catalog data", async () => {
    const user = userEvent.setup();
    const catalog = repository();
    const auth = api({ me: vi.fn().mockRejectedValueOnce(Object.assign(new Error("required"), { status: 401 })).mockResolvedValue({ id: "owner", sessionExpiresAt: expiry }) });
    await catalog.create("保留的会议", null, now);
    render(<App repository={catalog} auth={auth} refresh={async () => ({ state: "idle" })} now={() => now} />);
    const password = await screen.findByLabelText("密码");
    await user.type(password, "private-secret");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(password).toHaveValue(""));
    await screen.findByRole("heading", { name: "会议本" });
    await user.click(screen.getByRole("button", { name: "退出" }));
    await screen.findByRole("heading", { name: "登录会议本" });
    await expect(catalog.list()).resolves.toMatchObject([{ title: "保留的会议" }]);
  });
});
