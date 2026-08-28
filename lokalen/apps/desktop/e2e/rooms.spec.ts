import { test, expect, type Page } from "@playwright/test";

const SERVER = "http://127.0.0.1:8788";

async function joinOffice(page: Page, room: string, operator?: string) {
  await page.goto("/");
  await page.getByLabel("Kontorets server").fill(SERVER);
  await page.getByLabel("Vilket rum är den här datorn i?").selectOption(room);
  if (operator) await page.getByLabel("Ditt namn (valfritt)").fill(operator);
  await page.getByRole("button", { name: "Gå in i rummet" }).click();
  await expect(page.getByRole("heading", { name: "Kontoret" })).toBeVisible();
}

test("rum, Alla-kanalen, närvaro och snabbt ljudläge", async ({ browser }) => {
  const receptionCtx = await browser.newContext();
  const roomCtx = await browser.newContext();
  const reception = await receptionCtx.newPage();
  const rum1 = await roomCtx.newPage();

  await test.step("varje dator loggar in som sitt rum", async () => {
    await joinOffice(reception, "Reception", "Elin");
    await joinOffice(rum1, "Behandlingsrum 1");

    // The roster is rooms, not people, with the Alla channel pinned above.
    const rows = reception.locator(".roster").getByRole("option");
    await expect(rows.first()).toContainText("Alla");
    await expect(reception.locator(".roster")).toContainText("Behandlingsrum 1");
    await expect(reception.locator(".roster")).toContainText("Behandlingsrum 2");

    // This machine shows the room it is, and who said they are at it.
    await expect(reception.locator(".roster__self")).toContainText("Reception");
    await expect(reception.locator(".roster__self")).toContainText("Elin");
  });

  await test.step("ett meddelande i Alla når alla rum", async () => {
    await reception.locator(".roster").getByRole("option").filter({ hasText: "Alla" }).click();
    await reception.getByLabel(/^Meddelande till /).fill("Vi stänger 16 i dag");
    await reception.getByRole("button", { name: "Skicka", exact: true }).click();

    await rum1.locator(".roster").getByRole("option").filter({ hasText: "Alla" }).click();
    await expect(rum1.locator(".chat__log")).toContainText("Vi stänger 16 i dag");

    // The sender sees exactly one copy, not an echo of its own broadcast.
    await expect(reception.locator(".chat__log").getByText("Vi stänger 16 i dag")).toHaveCount(1);
  });

  await test.step("rum till rum fungerar oberoende av Alla", async () => {
    await rum1.locator(".roster").getByRole("option").filter({ hasText: "Reception" }).click();
    await rum1.getByLabel(/^Meddelande till /).fill("Kan du boka in återbesök?");
    await rum1.getByRole("button", { name: "Skicka", exact: true }).click();

    // Every spec in a run shares one relay, so this room may already carry
    // unread messages from an earlier test: assert that it is marked unread,
    // not the exact count.
    const row = reception.locator(".roster").getByRole("option").filter({ hasText: "Behandlingsrum 1" });
    await expect(row.locator(".badge")).toBeVisible();
    await row.click();
    await expect(reception.locator(".chat__log")).toContainText("Kan du boka in återbesök?");
    // The direct message must not have leaked into the shared channel.
    await expect(rum1.locator(".chat__log")).not.toContainText("Vi stänger 16 i dag");
  });

  await test.step("Med patient syns i andra rum", async () => {
    await rum1.getByRole("button", { name: "Med patient" }).click();
    await expect(
      reception.locator(".roster").getByRole("option").filter({ hasText: "Behandlingsrum 1" }),
    ).toContainText("Med patient", { timeout: 10_000 });
  });

  await test.step("ljudet kan stängas av var som helst", async () => {
    const mute = rum1.getByRole("button", { name: "Stäng av ljudet" });
    await expect(mute).toBeVisible();
    await mute.click();
    await expect(rum1.getByRole("button", { name: "Slå på ljudet" })).toBeVisible();
  });

  await receptionCtx.close();
  await roomCtx.close();
});
