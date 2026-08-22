import { expect, test } from "@playwright/test";

test("installs the meeting notebook shell and starts it offline", async ({ context, page }) => {
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "owner",
        sessionExpiresAt: "2099-01-01T00:00:00.000Z",
      }),
    });
  });

  await page.goto("/");

  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "会议本" })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);

  await page.evaluate(() => fetch("/api/auth/me", { credentials: "include" }));
  const cachedUrls = await page.evaluate(async () => {
    const urls = await Promise.all((await caches.keys()).map(async (cacheName) => {
      const requests = await (await caches.open(cacheName)).keys();
      return requests.map((request) => request.url);
    }));
    return urls.flat();
  });
  expect(cachedUrls.some((url) => new URL(url).pathname.startsWith("/api/"))).toBe(false);

  await page.unroute("**/api/auth/me");
  await context.setOffline(true);
  await page.reload();

  await expect(page.getByRole("heading", { name: "会议本" })).toBeVisible();
});
