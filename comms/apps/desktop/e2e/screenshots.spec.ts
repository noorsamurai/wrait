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
  { username: `dana-${stamp}`, displayName: "Dana Reyes", password: "danapassword" },
  { username: `marcus-${stamp}`, displayName: "Marcus Bell", password: "marcuspassword" },
  { username: `priya-${stamp}`, displayName: "Priya Anand", password: "priyapassword" },
  { username: `tom-${stamp}`, displayName: "Tom Whitfield", password: "tompassword" },
];

async function signUp(page: Page, who: (typeof PEOPLE)[number]) {
  await page.goto("/");
  await page.getByRole("tab", { name: "Create account" }).click();
  await page.getByLabel("Office server").fill(SERVER);
  await page.getByLabel("Username").fill(who.username);
  await page.getByLabel("Display name").fill(who.displayName);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Office" })).toBeVisible();
}

test("capture the interface", async ({ browser }) => {
  await mkdir(OUT, { recursive: true });

  const desktop = await browser.newContext({ viewport: { width: 1180, height: 780 }, colorScheme: "dark" });
  const page = await desktop.newPage();

  // The sign-in screen, before anyone is authenticated.
  await page.goto("/");
  await page.getByLabel("Office server").fill(SERVER);
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
  await expect(page.getByRole("option").first()).toBeVisible();

  const marcus = others[0];
  await page.getByRole("option").filter({ hasText: "Marcus Bell" }).click();

  // A short exchange, so the log shows both sides and a grouped run.
  await marcus.page.getByRole("option").filter({ hasText: "Dana Reyes" }).click();

  const say = async (from: Page, label: string, text: string) => {
    await from.getByLabel(label).fill(text);
    await from.getByRole("button", { name: "Send", exact: true }).click();
    await from.waitForTimeout(180);
  };

  await say(page, "Message Marcus", "Morning - are the Q3 numbers ready?");
  await say(marcus.page, "Message Dana", "Just finishing the last tab now.");
  await say(marcus.page, "Message Dana", "Give me ten minutes and I'll send it over.");
  await say(page, "Message Marcus", "No rush, thanks.");

  // One alert-flagged message, to show that treatment.
  await marcus.page.getByRole("button", { name: "Send with an alert sound" }).click();
  await say(marcus.page, "Message Dana", "Sent! Let me know if the totals look off.");

  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/02-conversation.png` });

  // The settings sheet, over the conversation.
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.screenshot({ path: `${OUT}/03-settings.png` });

  // Reduced-effects mode, for low-memory machines.
  await page.getByRole("switch", { name: "Reduce visual effects" }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/04-reduced-effects.png` });
  await page.getByRole("switch", { name: "Reduce visual effects" }).click();
  await page.getByRole("button", { name: "Done" }).click();

  // Light appearance.
  const light = await browser.newContext({ viewport: { width: 1180, height: 780 }, colorScheme: "light" });
  const lightPage = await light.newPage();
  await lightPage.goto("/");
  await lightPage.getByLabel("Office server").fill(SERVER);
  await lightPage.getByLabel("Username").fill(PEOPLE[0].username);
  await lightPage.getByLabel("Password", { exact: true }).fill(PEOPLE[0].password);
  await lightPage.getByRole("button", { name: "Sign in" }).click();
  await expect(lightPage.getByRole("heading", { name: "Office" })).toBeVisible();
  await lightPage.getByRole("option").filter({ hasText: "Marcus Bell" }).click();
  await lightPage.waitForTimeout(600);
  await lightPage.screenshot({ path: `${OUT}/05-light.png` });

  // iPhone-sized: the roster is the root screen, the conversation slides over.
  const phone = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark",
  });
  const phonePage = await phone.newPage();
  await phonePage.goto("/");
  await phonePage.getByLabel("Office server").fill(SERVER);
  await phonePage.getByLabel("Username").fill(PEOPLE[0].username);
  await phonePage.getByLabel("Password", { exact: true }).fill(PEOPLE[0].password);
  await phonePage.getByRole("button", { name: "Sign in" }).click();
  await expect(phonePage.getByRole("heading", { name: "Office" })).toBeVisible();
  await phonePage.waitForTimeout(500);
  await phonePage.screenshot({ path: `${OUT}/06-phone-roster.png` });

  await phonePage.getByRole("option").filter({ hasText: "Marcus Bell" }).click();
  await phonePage.waitForTimeout(600);
  await phonePage.screenshot({ path: `${OUT}/07-phone-conversation.png` });

  for (const other of others) await other.context.close();
  await desktop.close();
  await light.close();
  await phone.close();
});
