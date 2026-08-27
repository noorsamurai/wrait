import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

/**
 * Not an assertion suite - this drives the app into a few representative
 * states and writes images, so the design can be reviewed without building
 * for a real device.
 *
 * Run with:  npx playwright test screenshots
 */

const SERVER = "http://127.0.0.1:8788";
const OUT = "screenshots";
const stamp = Date.now().toString(36);

const PEOPLE = [
  { displayName: `Elin Vikström ${stamp}` },
  { displayName: `Marcus Berg ${stamp}` },
  { displayName: `Priya Anand ${stamp}` },
  { displayName: `Tomas Wikland ${stamp}` },
];

async function signUp(page: Page, who: (typeof PEOPLE)[number]) {
  await page.goto("/");
  await page.getByLabel("Kontorets server").fill(SERVER);
  await page.getByLabel("Ditt namn").fill(who.displayName);
  await page.getByRole("button", { name: "Gå med" }).click();
  await expect(page.getByRole("heading", { name: "Kontoret" })).toBeVisible();
}

test("fångar gränssnittet", async ({ browser }) => {
  await mkdir(OUT, { recursive: true });

  const desktop = await browser.newContext({
    viewport: { width: 1180, height: 780 },
    colorScheme: "dark",
    locale: "sv-SE",
  });
  const page = await desktop.newPage();

  // The sign-in screen, before anyone is authenticated.
  await page.goto("/");
  await page.getByLabel("Kontorets server").fill(SERVER);
  // Let the office probe settle so the capture shows the resolved form.
  await expect(page.getByText("Inget lösenord behövs")).toBeVisible();
  await page.screenshot({ path: `${OUT}/01-sign-in.png` });

  await signUp(page, PEOPLE[0]);

  // Populate the office so the roster is not empty.
  const others = [];
  for (const who of PEOPLE.slice(1)) {
    const context = await browser.newContext();
    const other = await context.newPage();
    await signUp(other, who);
    others.push({ context, page: other, who });
  }

  await page.reload();
  await expect(page.locator(".roster").getByRole("option").first()).toBeVisible();

  const marcus = others[0];
  await page.locator(".roster").getByRole("option").filter({ hasText: "Marcus Berg" }).click();

  // A short exchange, so the log shows both sides and a grouped run.
  await marcus.page.locator(".roster").getByRole("option").filter({ hasText: "Elin Vikström" }).click();

  const say = async (from: Page, text: string) => {
    await from.getByLabel(/^Meddelande till /).fill(text);
    await from.getByRole("button", { name: "Skicka", exact: true }).click();
    await from.waitForTimeout(180);
  };

  await say(page, "God morgon - är Q3-siffrorna klara?");
  await say(marcus.page, "Håller på med sista fliken nu.");
  await say(marcus.page, "Ge mig tio minuter så skickar jag över.");
  await say(page, "Ingen brådska, tack.");

  // One alert-flagged message, to show that treatment.
  await marcus.page.getByRole("button", { name: "Skicka med ljudsignal" }).click();
  await say(marcus.page, "Skickat! Säg till om summorna ser fel ut.");

  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/02-conversation.png` });

  // The settings sheet, over the conversation.
  // The task panel, with a mix of personal and delegated work.
  await page.getByRole("button", { name: "Att göra", exact: true }).click();
  const addTask = async (title: string, due: string, to?: string) => {
    await page.getByLabel("Ny uppgift").fill(title);
    if (due) await page.getByLabel("Datum").fill(due);
    if (to) await page.getByLabel("Till vem").selectOption({ label: to });
    await page.getByRole("button", { name: "Lägg till" }).click();
    await page.waitForTimeout(150);
  };
  await addTask("Ringa leverantören om leveransen", "2030-01-08");
  await addTask("Skriva under avtalet", "2030-01-09");
  await addTask("Boka konferensrummet", "", `Till Priya Anand ${stamp}`);
  await addTask("Beställa kaffe till fikarummet", "");  // personal: the recipient resets
  await page.locator(".task", { hasText: "Beställa kaffe" })
    .getByRole("button", { name: "Markera som klar" }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/08-tasks.png` });
  await page.getByRole("button", { name: "Stäng uppgifter" }).click();

  await page.getByRole("button", { name: "Inställningar" }).click();
  await expect(page.getByRole("dialog", { name: "Inställningar" })).toBeVisible();
  await page.screenshot({ path: `${OUT}/03-settings.png` });

  // The opt-in glass appearance, for machines that can spare the GPU time.
  await page.getByRole("switch", { name: "Glasutseende" }).click();
  await page.getByRole("button", { name: "Klar" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/04-glass-appearance.png` });

  // Back to the flat default.
  await page.getByRole("button", { name: "Inställningar" }).click();
  await page.getByRole("switch", { name: "Glasutseende" }).click();
  await page.getByRole("button", { name: "Klar" }).click();

  // An open office refuses a name that is already online, so the earlier
  // sessions have to close before these captures can sign in as the same
  // person and show the same conversation.
  for (const other of others) await other.context.close();
  await desktop.close();

  // Light appearance.
  const light = await browser.newContext({
    viewport: { width: 1180, height: 780 },
    colorScheme: "light",
    locale: "sv-SE",
  });
  const lightPage = await light.newPage();
  await lightPage.goto("/");
  await lightPage.getByLabel("Kontorets server").fill(SERVER);
  await lightPage.getByLabel("Ditt namn").fill(PEOPLE[0].displayName);
  await lightPage.getByRole("button", { name: "Gå med" }).click();
  await expect(lightPage.getByRole("heading", { name: "Kontoret" })).toBeVisible();
  await lightPage.locator(".roster").getByRole("option").filter({ hasText: "Marcus Berg" }).click();
  await lightPage.waitForTimeout(600);
  await lightPage.screenshot({ path: `${OUT}/05-light.png` });

  await light.close();

  // iPhone-sized: the roster is the root screen, the conversation slides over.
  const phone = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark",
    locale: "sv-SE",
  });
  const phonePage = await phone.newPage();
  await phonePage.goto("/");
  await phonePage.getByLabel("Kontorets server").fill(SERVER);
  await phonePage.getByLabel("Ditt namn").fill(PEOPLE[0].displayName);
  await phonePage.getByRole("button", { name: "Gå med" }).click();
  await expect(phonePage.getByRole("heading", { name: "Kontoret" })).toBeVisible();
  await phonePage.waitForTimeout(500);
  await phonePage.screenshot({ path: `${OUT}/06-phone-roster.png` });

  await phonePage.locator(".roster").getByRole("option").filter({ hasText: "Marcus Berg" }).click();
  await phonePage.waitForTimeout(600);
  await phonePage.screenshot({ path: `${OUT}/07-phone-conversation.png` });

  await phone.close();
});
