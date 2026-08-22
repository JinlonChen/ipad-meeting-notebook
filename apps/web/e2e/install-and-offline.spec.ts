import { expect, test } from "@playwright/test";

test("installs the meeting notebook shell and starts it offline", async ({ context, page }) => {
  await page.goto("/");

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
    start_url: "/",
    scope: "/",
    lang: "zh-CN",
  });
  expect(manifest.icons).toEqual([
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ]);

  const catalogHeading = page.getByRole("heading", { name: "会议本", exact: true });
  const configurationHeading = page.getByRole("heading", { name: "需要配置云端服务", exact: true });
  await expect(catalogHeading.or(configurationHeading)).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);

  const cachedUrls = await page.evaluate(async () => {
    const urls = await Promise.all((await caches.keys()).map(async (cacheName) => {
      const requests = await (await caches.open(cacheName)).keys();
      return requests.map((request) => request.url);
    }));
    return urls.flat();
  });
  expect(cachedUrls.some((url) => new URL(url).pathname.startsWith("/api/"))).toBe(false);

  await context.setOffline(true);
  await page.reload();

  await expect(catalogHeading.or(configurationHeading)).toBeVisible();
  if (await configurationHeading.isVisible()) {
    await expect(page.getByText("请先配置 Supabase 后再启动会议本。", { exact: true })).toBeVisible();
  } else {
    await expect(page.getByRole("button", { name: "新建会议", exact: true })).toBeVisible();
  }
});
