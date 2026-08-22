import { expect, test, type Page } from "@playwright/test";

async function openCatalog(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ id: "owner", sessionExpiresAt: "2099-01-01T00:00:00.000Z" }),
      });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: "[]" });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "会议本", exact: true })).toBeVisible();
}

async function activeControl(page: Page): Promise<{ label: string; inRail: boolean; left: number; right: number }> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement;
    const rect = active.getBoundingClientRect();
    return {
      label: active.getAttribute("aria-label") ?? active.textContent?.trim() ?? active.tagName,
      inRail: Boolean(active.closest(".folder-rail")),
      left: rect.left,
      right: rect.right,
    };
  });
}

test("portrait drawer leaves focus and accessibility navigation only while open", async ({ page }) => {
  await page.setViewportSize({ width: 744, height: 1133 });
  await openCatalog(page);
  const shell = page.getByRole("main");
  const rail = page.locator(".folder-rail");
  const trigger = page.getByRole("button", { name: "打开分类" });
  await expect(shell).toHaveAttribute("data-layout", "portrait");
  await expect(rail).toHaveAttribute("inert", "");
  await expect(rail).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("complementary", { name: "会议分类" })).toHaveCount(0);

  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press("Tab");
    const active = await activeControl(page);
    expect(active.inRail, `${active.label} must not be reachable in the closed rail`).toBe(false);
    expect(active.left).toBeGreaterThanOrEqual(0);
    expect(active.right).toBeLessThanOrEqual(744);
  }

  await trigger.click();
  await expect(rail).not.toHaveAttribute("inert", "");
  await expect(rail).not.toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("complementary", { name: "会议分类" })).toBeVisible();
  const closeButton = page.getByRole("button", { name: "关闭分类", exact: true });
  await expect(closeButton).toBeFocused();
  await closeButton.click();
  await expect(trigger).toBeFocused();
  await expect(rail).toHaveAttribute("inert", "");

  await trigger.click();
  await expect(closeButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "新建分类" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "全部会议" })).toBeFocused();
  await expect.poll(async () => (await rail.boundingBox())?.x).toBeGreaterThanOrEqual(0);
  const openRailBox = await rail.boundingBox();
  expect(openRailBox).not.toBeNull();
  expect(openRailBox!.x).toBeGreaterThanOrEqual(0);
  expect(openRailBox!.x + openRailBox!.width).toBeLessThanOrEqual(744);

  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(rail).toHaveAttribute("inert", "");

  await trigger.click();
  await page.getByRole("button", { name: "关闭分类抽屉" }).click({ position: { x: 700, y: 300 } });
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByRole("button", { name: "未分类" }).click();
  await expect(trigger).toBeFocused();
  await expect(shell).toHaveAttribute("data-drawer", "closed");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("landscape rail stays semantic, focusable, and separate from meeting content", async ({ page }) => {
  await page.setViewportSize({ width: 1133, height: 744 });
  await openCatalog(page);
  const shell = page.getByRole("main");
  const physicalRail = page.locator(".folder-rail");
  const rail = page.getByRole("complementary", { name: "会议分类" });
  await expect(shell).toHaveAttribute("data-layout", "landscape");
  await expect(rail).toBeVisible();
  await expect(rail).not.toHaveAttribute("inert", "");
  await expect(rail).not.toHaveAttribute("aria-hidden", "true");
  const createFolder = page.getByRole("button", { name: "新建分类" });
  await createFolder.focus();
  await expect(createFolder).toBeFocused();

  const railBox = await rail.boundingBox();
  const panelBox = await page.locator(".meeting-panel").boundingBox();
  expect(railBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  expect(railBox!.x + railBox!.width).toBeLessThanOrEqual(panelBox!.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.setViewportSize({ width: 744, height: 1133 });
  await expect(shell).toHaveAttribute("data-layout", "portrait");
  await expect(physicalRail).toHaveAttribute("inert", "");
  await expect(physicalRail).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("complementary", { name: "会议分类" })).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "打开分类" });
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(page.getByRole("button", { name: "关闭分类", exact: true })).toBeFocused();

  await page.setViewportSize({ width: 1133, height: 744 });
  await expect(shell).toHaveAttribute("data-layout", "landscape");
  await expect(rail).toBeVisible();
  await expect(physicalRail).not.toHaveAttribute("inert", "");
  await expect(physicalRail).not.toHaveAttribute("aria-hidden", "true");
  await expect(createFolder).toBeFocused();
});
