import { test, expect, type Page } from "@playwright/test";

const SERVER = "http://127.0.0.1:8788";
const stamp = Date.now().toString(36);
const ROOM_A = `Rum C ${stamp}`;
const ROOM_B = `Rum D ${stamp}`;


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

test("ändra, ta bort, original och utkast", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ensureRoom(ROOM_A);
  await ensureRoom(ROOM_B);
  await joinOffice(a, ROOM_A);
  await joinOffice(b, ROOM_B);
  await a.locator(".roster").getByRole("option").filter({ hasText: ROOM_B }).click();
  await b.locator(".roster").getByRole("option").filter({ hasText: ROOM_A }).click();

  await test.step("en ändring syns hos båda och originalet går att läsa", async () => {
    await a.getByLabel(/^Meddelande till /).fill("Patienten kommer 13:00");
    await a.getByRole("button", { name: "Skicka", exact: true }).click();
    await expect(b.locator(".chat__log")).toContainText("Patienten kommer 13:00");

    const bubble = a.locator(".bubble--mine", { hasText: "Patienten kommer 13:00" });
    await bubble.getByRole("button", { name: "Ändra" }).click();
    // Scoped to the page: the bubble locator matched on text, which the
    // textarea replaces once editing starts.
    await a.getByLabel("Ändra meddelandet").fill("Patienten kommer 13:30");
    await a.getByRole("button", { name: "Spara", exact: true }).click();

    // The recipient sees the new wording, marked as changed.
    const received = b.locator(".bubble", { hasText: "Patienten kommer 13:30" });
    await expect(received).toBeVisible({ timeout: 10_000 });
    await expect(b.locator(".chat__log")).not.toContainText("Patienten kommer 13:00");

    // And can read back what it used to say - the point of keeping revisions.
    await received.getByRole("button", { name: "Ändrad · visa original" }).click();
    await expect(received.locator(".bubble__revision")).toHaveText("Patienten kommer 13:00");
  });

  await test.step("ett borttaget meddelande lämnar ett spår", async () => {
    await a.getByLabel(/^Meddelande till /).fill("Fel rum, förlåt");
    await a.getByRole("button", { name: "Skicka", exact: true }).click();
    await expect(b.locator(".chat__log")).toContainText("Fel rum, förlåt");

    const bubble = a.locator(".bubble--mine", { hasText: "Fel rum, förlåt" });
    await bubble.getByRole("button", { name: "Ta bort" }).click();

    // Both sides lose the text but keep the fact that something was withdrawn.
    await expect(a.locator(".chat__log")).not.toContainText("Fel rum, förlåt");
    await expect(a.locator(".bubble--tombstone").last()).toHaveText("Du tog bort ett meddelande");
    await expect(b.locator(".bubble--tombstone").last()).toHaveText(
      "Ett meddelande togs bort",
      { timeout: 10_000 },
    );
  });

  await test.step("bara egna meddelanden kan ändras", async () => {
    const theirs = b.locator(".bubble--theirs", { hasText: "Patienten kommer 13:30" });
    await expect(theirs.getByRole("button", { name: "Ändra" })).toHaveCount(0);
  });

  await test.step("utkast överlever byte av rum och omstart", async () => {
    await a.getByLabel(/^Meddelande till /).fill("Halvfärdigt till receptionen");
    await a.locator(".roster").getByRole("option").filter({ hasText: "Alla" }).click();
    await expect(a.getByLabel(/^Meddelande till /)).toHaveValue("");

    await a.locator(".roster").getByRole("option").filter({ hasText: ROOM_B }).click();
    await expect(a.getByLabel(/^Meddelande till /)).toHaveValue("Halvfärdigt till receptionen");

    await a.reload();
    await a.locator(".roster").getByRole("option").filter({ hasText: ROOM_B }).click();
    await expect(a.getByLabel(/^Meddelande till /)).toHaveValue("Halvfärdigt till receptionen");
  });

  await aCtx.close();
  await bCtx.close();
});
