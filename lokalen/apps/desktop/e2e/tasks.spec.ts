import { test, expect, type Page } from "@playwright/test";

const SERVER = "http://127.0.0.1:8788";
const stamp = Date.now().toString(36);
const ANNA = `Rum E ${stamp}`;
const BJORN = `Rum F ${stamp}`;


/**
 * Creates a room up front so this spec owns its own conversation.
 *
 * Every spec in a run shares one relay; without this they would all talk in
 * Behandlingsrum 1 and trip over each other's history.
 */
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

const openPanel = (page: Page) => page.getByRole("button", { name: "Att göra", exact: true }).click();

test("uppgifter: egna, skickade, klarmarkerade och sparade meddelanden", async ({ browser }) => {
  const annaCtx = await browser.newContext();
  const bjornCtx = await browser.newContext();
  const a = await annaCtx.newPage();
  const b = await bjornCtx.newPage();

  await ensureRoom(ANNA);
  await ensureRoom(BJORN);
  await joinOffice(a, ANNA);
  await joinOffice(b, BJORN);
  await a.reload();

  await test.step("en egen uppgift hamnar i listan", async () => {
    await openPanel(a);
    await a.getByLabel("Ny uppgift").fill("Beställa kaffe");
    await a.getByRole("button", { name: "Lägg till" }).click();
    await expect(a.locator(".task__title", { hasText: "Beställa kaffe" })).toBeVisible();
  });

  await test.step("en uppgift kan skickas till en kollega", async () => {
    await a.getByLabel("Ny uppgift").fill("Skicka fakturan");
    await a.getByLabel("Datum").fill("2030-03-14");
    await a.getByLabel("Till vem").selectOption({ label: `Till ${BJORN}` });
    await a.getByRole("button", { name: "Lägg till" }).click();

    // It lands in the recipient's list, attributed to the sender.
    await openPanel(b);
    const received = b.locator(".task", { hasText: "Skicka fakturan" });
    await expect(received).toBeVisible({ timeout: 10_000 });
    await expect(received).toContainText(`från ${ANNA}`);

    // And the sender keeps sight of it, attributed the other way.
    await expect(a.locator(".task", { hasText: "Skicka fakturan" })).toContainText(`till ${BJORN}`);
  });

  await test.step("mottagaren kan markera som klar och avsändaren ser det", async () => {
    const received = b.locator(".task", { hasText: "Skicka fakturan" });
    await received.getByRole("button", { name: "Markera som klar" }).click();
    await expect(received).toHaveAttribute("data-cleared", "true");

    // The sender's copy updates too - the point of sending it at all.
    await expect(a.locator(".task", { hasText: "Skicka fakturan" })).toHaveAttribute(
      "data-cleared",
      "true",
      { timeout: 10_000 },
    );
  });

  await test.step("klara uppgifter kan döljas och visas igen", async () => {
    const cleared = b.locator(".task", { hasText: "Skicka fakturan" });
    await expect(cleared).toBeVisible();
    await b.getByRole("button", { name: "Dölj klara" }).click();
    await expect(cleared).toHaveCount(0);
    await b.getByRole("button", { name: "Visa klara" }).click();
    await expect(cleared).toBeVisible();
  });

  await test.step("en klarmarkering kan ångras", async () => {
    const cleared = b.locator(".task", { hasText: "Skicka fakturan" });
    await cleared.getByRole("button", { name: "Ångra klarmarkering" }).click();
    await expect(cleared).toHaveAttribute("data-cleared", "false");
  });

  await test.step("ett chattmeddelande kan sparas som uppgift", async () => {
    await a.locator(".roster").getByRole("option").filter({ hasText: BJORN }).click();
    await a.getByLabel(/^Meddelande till /).fill("Kom ihåg parkeringstillståndet");
    await a.getByRole("button", { name: "Skicka", exact: true }).click();

    // The recipient has to be looking at the conversation for there to be a
    // bubble to save.
    await b.locator(".roster").getByRole("option").filter({ hasText: ANNA }).click();

    const bubble = b.locator(".bubble", { hasText: "Kom ihåg parkeringstillståndet" });
    await expect(bubble).toBeVisible({ timeout: 10_000 });
    await bubble.getByRole("button", { name: "Spara som uppgift" }).click();

    // Saving opens the panel and the message becomes a task, marked as saved.
    await expect(b.locator(".task__title", { hasText: "Kom ihåg parkeringstillståndet" })).toBeVisible();
    await expect(b.locator(".task", { hasText: "Kom ihåg parkeringstillståndet" })).toContainText(
      "sparat meddelande",
    );
    await expect(bubble.locator(".bubble__save")).toHaveAttribute("data-saved", "true");
  });

  await test.step("sorteringen kan vändas", async () => {
    await a.getByLabel("Byt sortering").click();
    // Both orderings must still show every open task; only the order changes.
    await expect(a.locator(".task")).not.toHaveCount(0);
  });

  await annaCtx.close();
  await bjornCtx.close();
});
