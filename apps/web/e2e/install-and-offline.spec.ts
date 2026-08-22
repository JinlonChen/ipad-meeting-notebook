import { expect, test } from "@playwright/test";

import { installSupabaseRoutes, offlineMeeting, openCatalog, removeSupabaseRoutes, supabaseOrigin } from "./supabase-fixture.js";

async function expireDeviceMarker(page: Parameters<typeof openCatalog>[0]): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("meeting-catalog");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const transaction = open.result.transaction("settings", "readwrite");
        transaction.objectStore("settings").put({
          key: "deviceAccess",
          value: { authorizedAt: "2026-08-22T00:00:00.000Z", expiresAt: "2026-08-22T00:01:00.000Z" },
        });
        transaction.oncomplete = () => { open.result.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  });
}

test("installs the meeting notebook shell and enforces offline authorization", async ({ browser, context, page }) => {
  const appPath = "/";
  const meeting = offlineMeeting();
  await openCatalog(page, [meeting], appPath);

  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveCount(1);
  const manifestHref = await manifestLink.getAttribute("href");
  expect(manifestHref).toBeTruthy();
  const manifest = await page.evaluate(async (href) => {
    const response = await fetch(href);
    if (!response.ok) {
      throw new Error(`Manifest request failed with ${response.status}`);
    }
    return response.json();
  }, manifestHref!);
  expect(manifest).toMatchObject({
    name: "会议本",
    short_name: "会议本",
    description: "个人会议目录与离线同步",
    display: "standalone",
    start_url: appPath,
    scope: appPath,
    lang: "zh-CN",
  });
  expect(manifest.icons).toEqual([
    { src: `${appPath}icons/icon-192.png`, sizes: "192x192", type: "image/png" },
    { src: `${appPath}icons/icon-512.png`, sizes: "512x512", type: "image/png" },
    { src: `${appPath}icons/icon-maskable-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
  ]);

  const catalogHeading = page.getByRole("heading", { name: "会议本", exact: true });
  await expect(page.getByText(meeting.title, { exact: true })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);

  const cachedUrls = await page.evaluate(async () => {
    const urls = await Promise.all((await caches.keys()).map(async (cacheName) => {
      const requests = await (await caches.open(cacheName)).keys();
      return requests.map((request) => request.url);
    }));
    return urls.flat();
  });
  expect(cachedUrls.some((url) => new URL(url).pathname.startsWith("/api/"))).toBe(false);
  expect(cachedUrls.some((url) => new URL(url).origin === supabaseOrigin)).toBe(false);

  await removeSupabaseRoutes(page);
  await context.setOffline(true);
  await page.reload();

  await expect(catalogHeading).toBeVisible();
  await expect(page.getByText(meeting.title, { exact: true })).toBeVisible();

  await expireDeviceMarker(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "离线解锁需要登录" })).toBeVisible();
  await expect(catalogHeading).toHaveCount(0);

  const freshContext = await browser.newContext();
  const freshPage = await freshContext.newPage();
  await installSupabaseRoutes(freshPage);
  await freshPage.goto("/");
  await expect(freshPage.getByRole("heading", { name: "登录会议本" })).toBeVisible();
  await freshPage.evaluate(() => navigator.serviceWorker.ready);
  await removeSupabaseRoutes(freshPage);
  await freshContext.setOffline(true);
  await freshPage.reload();
  await expect(freshPage.getByRole("heading", { name: "登录会议本" })).toBeVisible();
  await expect(freshPage.getByRole("heading", { name: "会议本", exact: true })).toHaveCount(0);
  await freshContext.close();
});
