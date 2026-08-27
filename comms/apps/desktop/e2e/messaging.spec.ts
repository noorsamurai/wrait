import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = "http://127.0.0.1:8788";

/** Each run gets fresh usernames so the suite is re-runnable against one relay. */
const stamp = Date.now().toString(36);
const ALICE = { username: `alice-${stamp}`, displayName: "Alice Nakamura", password: "correct-horse" };
const BOB = { username: `bob-${stamp}`, displayName: "Bob Ortiz", password: "hunter2hunter2" };

async function createAccount(page: Page, who: typeof ALICE) {
  await page.goto("/");
  await page.getByRole("tab", { name: "Create account" }).click();
  await page.getByLabel("Office server").fill(SERVER);
  await page.getByLabel("Username").fill(who.username);
  await page.getByLabel("Display name").fill(who.displayName);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Office" })).toBeVisible();
}

test("two people sign up, chat, alert and exchange a file", async ({ browser }) => {
  // Separate contexts: two different machines, two different localStorage jars.
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const a = await alice.newPage();
  const b = await bob.newPage();

  await createAccount(a, ALICE);
  await createAccount(b, BOB);

  // Alice's roster should list Bob once he exists.
  await a.reload();
  await expect(a.getByRole("option", { name: /Bob Ortiz/ })).toBeVisible();

  await a.getByRole("option", { name: /Bob Ortiz/ }).click();
  await expect(a.getByText(`This is the start of your conversation with ${BOB.displayName}.`)).toBeVisible();

  await test.step("a plain message arrives", async () => {
    await a.getByLabel("Message Bob").fill("Standup in five?");
    await a.getByRole("button", { name: "Send", exact: true }).click();

    // Scope to the message log: the roster also shows the text as a preview.
    await expect(a.locator(".chat__log").getByText("Standup in five?")).toBeVisible();

    // Bob has not opened the thread, so it should surface as unread.
    const aliceRow = b.getByRole("option").filter({ hasText: "Alice Nakamura" });
    await expect(aliceRow.locator(".badge")).toHaveText("1");

    await aliceRow.click();
    await expect(b.locator(".chat__log").getByText("Standup in five?")).toBeVisible();
  });

  await test.step("the sender sees a read receipt", async () => {
    await expect(a.locator(".bubble--mine").last()).toContainText("Read");
  });

  await test.step("an alert-flagged message is marked as one", async () => {
    await a.getByRole("button", { name: "Send with an alert sound" }).click();
    await a.getByLabel("Message Bob").fill("Need you at the front desk");
    await a.getByRole("button", { name: "Send", exact: true }).click();

    const alerted = b.locator(".bubble--alert").last();
    await expect(alerted).toContainText("Need you at the front desk", { timeout: 15_000 });
    await expect(alerted).toContainText("Alert");
  });

  await test.step("a file transfers and can be downloaded intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "comms-e2e-"));
    const path = join(dir, "quarterly-report.bin");
    // Larger than one 512 KiB chunk, so the chunked path is what runs.
    const payload = randomBytes(700 * 1024);
    await writeFile(path, payload);

    await a.locator('input[type="file"]').setInputFiles(path);

    const card = b.locator(".attachment").last();
    await expect(card).toContainText("quarterly-report.bin", { timeout: 20_000 });
    await expect(card).toContainText("700 KB");

    const download = b.waitForEvent("download");
    await card.getByRole("button", { name: /^Save / }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe("quarterly-report.bin");

    const stream = await saved.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
  });

  await test.step("presence updates when someone leaves", async () => {
    await bob.close();
    // The conversation header tracks the other person's presence.
    await expect(a.locator(".chat__head-meta")).toHaveText("Offline", { timeout: 15_000 });
  });

  await alice.close();
});
