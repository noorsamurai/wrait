import { test, expect, type Page } from "@playwright/test";

const SERVER = "http://127.0.0.1:8788";
const stamp = Date.now().toString(36);
const ROOM_A = `Rum K ${stamp}`;
const ROOM_B = `Rum L ${stamp}`;

async function ensureRoom(name: string) {
  await fetch(`${SERVER}/api/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: name }),
  });
}

async function joinOffice(page: Page, room: string) {
  await page.goto("/");
  await page.getByLabel("Kontorets server").fill(SERVER);
  await page.getByLabel("Vilket rum är den här datorn i?").selectOption(room);
  await page.getByRole("button", { name: "Gå in i rummet" }).click();
  await expect(page.getByRole("heading", { name: "Kontoret" })).toBeVisible();
}

test("sökning hittar meddelanden och öppnar konversationen", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ensureRoom(ROOM_A);
  await ensureRoom(ROOM_B);
  await joinOffice(a, ROOM_A);
  await joinOffice(b, ROOM_B);
  await a.locator(".roster").getByRole("option").filter({ hasText: ROOM_B }).click();

  const say = async (text: string) => {
    await a.getByLabel(/^Meddelande till /).fill(text);
    await a.getByRole("button", { name: "Skicka", exact: true }).click();
    await a.waitForTimeout(150);
  };

  await say("Remissen till ortopeden är skickad");
  await say("Röntgenbilderna kom precis");
  await say("Bokade återbesök i november");

  await a.getByRole("button", { name: "Sök i meddelanden" }).first().click();
  const panel = a.locator(".search-panel");
  await expect(panel).toBeVisible();

  await test.step("en träff hittas på ett ord", async () => {
    await panel.getByLabel("Sök i meddelanden").fill("remissen");
    await expect(panel.locator(".search-hit")).toHaveCount(1, { timeout: 10_000 });
    await expect(panel.locator(".search-hit")).toContainText("Remissen till ortopeden");
    // The room the message belongs to is named, not the sender.
    await expect(panel.locator(".search-hit")).toContainText(ROOM_B);
  });

  await test.step("svenska tecken matchar oavsett skiftläge", async () => {
    await panel.getByLabel("Sök i meddelanden").fill("RÖNTGENBILDERNA");
    await expect(panel.locator(".search-hit")).toHaveCount(1, { timeout: 10_000 });
    await expect(panel.locator(".search-hit")).toContainText("Röntgenbilderna");
  });

  await test.step("flera ord smalnar av i stället för att bredda", async () => {
    await panel.getByLabel("Sök i meddelanden").fill("bokade november");
    await expect(panel.locator(".search-hit")).toHaveCount(1, { timeout: 10_000 });

    await panel.getByLabel("Sök i meddelanden").fill("bokade röntgenbilderna");
    await expect(panel.locator(".search-hit")).toHaveCount(0, { timeout: 10_000 });
  });

  await test.step("markup söks inte, bara orden", async () => {
    // A pasted body is stored as HTML; searching for a tag must find nothing.
    await panel.getByLabel("Sök i meddelanden").fill("strong");
    await expect(panel.locator(".search-hit")).toHaveCount(0, { timeout: 10_000 });
  });

  await test.step("en träff öppnar rätt konversation", async () => {
    await panel.getByLabel("Sök i meddelanden").fill("återbesök");
    const hit = panel.locator(".search-hit").first();
    await expect(hit).toBeVisible({ timeout: 10_000 });
    await hit.click();
    await expect(a.locator(".chat__head-name")).toContainText(ROOM_B);
    await expect(a.locator(".chat__log")).toContainText("Bokade återbesök i november");
  });

  void b;
  await aCtx.close();
  await bCtx.close();
});
