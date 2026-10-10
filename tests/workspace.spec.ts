import { test, expect } from "@playwright/test";

function csvSample() {
  const rows = ["time_utc,open,high,low,close,tick_volume"];
  const start = Date.parse("2026-10-05T10:00:00Z");
  for (let i = 0; i < 25; i += 1) {
    const o = (89.38 + i * 0.01).toFixed(2);
    const h = (89.45 + i * 0.01).toFixed(2);
    const l = (89.29 + i * 0.01).toFixed(2);
    const c = (89.4 + i * 0.01).toFixed(2);
    rows.push(new Date(start + i * 60_000).toISOString() + "," +
      [o, h, l, c, "100"].join(","));
  }
  return rows.join("\n") + "\n";
}

test("workspace drawers, CSV import and manual trading remain usable", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto("/calyze/");
  await expect(page.locator(".topbar .brand-mark")).toBeVisible();

  await page.locator(".top-actions .header-action").nth(1).click();
  await expect(page.getByRole("dialog", { name: "Save states" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Save states" })).toHaveCount(0);

  await page.locator(".top-actions .header-action").nth(2).click();
  await expect(page.getByRole("dialog", { name: "Cloud & datasets" })).toBeVisible();
  await page.getByRole("button", { name: "Close Cloud & datasets" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.locator("input[type='file']").first().setInputFiles({
    name: "fxpro_WTI_m1.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csvSample())
  });

  await expect(page.locator(".chart-shell")).toBeVisible();
  await expect(page.locator(".workspace-stats")).toContainText("Balance");
  await expect(page.locator(".chart-shell")).toContainText("USOIL.S");
  await expect(page.locator(".marketbar .play")).toBeVisible();

  const phone = (page.viewportSize()?.width ?? 1440) <= 900;
  if (phone) {
    await expect(page.locator(".mobile-workspace-nav")).toBeVisible();
    await page.locator(".mobile-workspace-nav button").nth(1).click();
  } else {
    await expect(page.locator(".mobile-workspace-nav")).toBeHidden();
  }
  await expect(page.locator(".trade-panel")).toBeVisible();
  await expect(page.locator(".order-estimates")).toContainText("Buy margin");
  await page.locator(".deal-buttons .buy").click();

  if (phone) {
    await page.locator(".view-open-orders").click();
    await expect(page.locator(".blotter")).toBeVisible();
  }
  await expect(page.locator(".blotter tbody")).toContainText("BUY");
  await page.locator(".tabs button").nth(1).click();
  await expect(page.locator(".blotter tbody")).toContainText("No closed trades yet");

  const viewport = page.viewportSize()?.width ?? 1440;
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scroll).toBeLessThanOrEqual(viewport + 2);
  expect(failures).toEqual([]);
});
