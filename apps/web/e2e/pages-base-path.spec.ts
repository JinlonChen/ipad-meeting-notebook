import { expect, test } from "@playwright/test";

import { offlineMeeting, openCatalog, supabaseOrigin } from "./supabase-fixture.js";

const appPath = "/ipad-meeting-notebook/";

test("GitHub Pages base path remains installable after reload", async ({ page }) => {
  const supabaseRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(supabaseOrigin)) supabaseRequests.push(request.url());
  });
  const meeting = offlineMeeting();
  await openCatalog(page, [meeting], appPath);
  expect(supabaseRequests.length).toBeGreaterThan(0);

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestHref).toBe(`${appPath}manifest.webmanifest`);
  const manifest = await page.evaluate(async (href) => {
    const response = await fetch(href);
    if (!response.ok) throw new Error(`Manifest request failed with ${response.status}`);
    return response.json();
  }, manifestHref!);

  expect(manifest).toMatchObject({ start_url: appPath, scope: appPath });
  expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual([
    `${appPath}icons/icon-192.png`,
    `${appPath}icons/icon-512.png`,
    `${appPath}icons/icon-maskable-512.png`,
  ]);
  const iconStatuses = await page.evaluate(async (icons: Array<{ src: string }>) => (
    Promise.all(icons.map(async ({ src }) => (await fetch(src)).status))
  ), manifest.icons);
  expect(iconStatuses).toEqual([200, 200, 200]);

  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.getByRole("heading", { name: "会议本", exact: true })).toBeVisible();
  await expect(page.getByText(meeting.title, { exact: true })).toBeVisible();

  const serviceWorker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return {
      controlled: navigator.serviceWorker.controller !== null,
      scope: registration.scope,
      scriptURL: registration.active?.scriptURL ?? "",
    };
  });
  expect(serviceWorker.controlled).toBe(true);
  expect(new URL(serviceWorker.scope).pathname).toBe(appPath);
  expect(new URL(serviceWorker.scriptURL).pathname).toBe(`${appPath}sw.js`);

  const cachedUrls = await page.evaluate(async () => {
    const entries = await Promise.all((await caches.keys()).map(async (name) => (await caches.open(name)).keys()));
    return entries.flat().map((request) => request.url);
  });
  expect(cachedUrls.length).toBeGreaterThan(0);
  expect(cachedUrls.every((url) => new URL(url).origin !== supabaseOrigin)).toBe(true);
});
