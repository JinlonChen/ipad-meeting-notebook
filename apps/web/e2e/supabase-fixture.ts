import { expect, type Page } from "@playwright/test";

export const supabaseOrigin = "http://127.0.0.1:54321";
const userId = "00000000-0000-4000-8000-000000000001";

export type RemoteMeeting = {
  id: string;
  title: string;
  folder_id: string | null;
  status: "draft" | "recording" | "recoverable" | "uploading" | "processing" | "ready" | "failed" | "trashed";
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  trashed_at: string | null;
  sync_version: number;
};

const defaultMeeting: RemoteMeeting = {
  id: "00000000-0000-4000-8000-000000000010",
  title: "离线会议",
  folder_id: null,
  status: "ready",
  started_at: "2026-08-22T01:00:00.000Z",
  ended_at: "2026-08-22T02:00:00.000Z",
  created_at: "2026-08-22T01:00:00.000Z",
  updated_at: "2026-08-22T02:00:00.000Z",
  trashed_at: null,
  sync_version: 1,
};

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export async function installSupabaseRoutes(page: Page, meetings: RemoteMeeting[] = []): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
  const user = { id: userId, aud: "authenticated", role: "authenticated", email: "owner@example.com" };
  const accessToken = `${base64Url({ alg: "none", typ: "JWT" })}.${base64Url({ sub: userId, role: "authenticated", exp: expiresAt })}.e2e`;

  await page.route(`${supabaseOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/auth/v1/token") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ access_token: accessToken, refresh_token: "e2e-refresh-token", token_type: "bearer", expires_in: 3_600, expires_at: expiresAt, user }),
      });
      return;
    }
    if (url.pathname === "/auth/v1/user") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(user) });
      return;
    }
    if (url.pathname === "/auth/v1/logout") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (url.pathname === "/rest/v1/folders") {
      await route.fulfill({ contentType: "application/json", body: "[]" });
      return;
    }
    if (url.pathname === "/rest/v1/meetings") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(meetings) });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "E2E route not configured" }) });
  });
}

export async function removeSupabaseRoutes(page: Page): Promise<void> {
  await page.unroute(`${supabaseOrigin}/**`);
}

export async function openCatalog(page: Page, meetings: RemoteMeeting[] = [], appPath = "/"): Promise<void> {
  await installSupabaseRoutes(page, meetings);
  await page.goto(appPath);
  await page.getByLabel("邮箱").fill("owner@example.com");
  await page.getByLabel("密码").fill("e2e-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "会议本", exact: true })).toBeVisible();
}

export function offlineMeeting(): RemoteMeeting {
  return { ...defaultMeeting };
}
