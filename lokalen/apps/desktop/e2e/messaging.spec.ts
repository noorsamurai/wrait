import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = "http://127.0.0.1:8788";

/** Each run gets fresh usernames so the suite is re-runnable against one relay. */
const stamp = Date.now().toString(36);
const ANNA = { room: "Behandlingsrum 1", operator: "Anna" };
const BJORN = { room: "Reception", operator: "Björn" };

/**
 * A machine signs in as the room it stands in, optionally naming who is at
 * it. There is no password anywhere in an open office.
 */
async function joinOffice(page: Page, who: { room: string; operator: string }) {
  await page.goto("/");
  await page.getByLabel("Kontorets server").fill(SERVER);
  await page.getByLabel("Vilket rum är den här datorn i?").selectOption(who.room);
  await page.getByLabel("Ditt namn (valfritt)").fill(who.operator);
  await page.getByRole("button", { name: "Gå in i rummet" }).click();
  await expect(page.getByRole("heading", { name: "Kontoret" })).toBeVisible();
}

test("två rum chattar, larmar och byter fil", async ({ browser }) => {
  // Separate contexts: two different machines, two different localStorage jars.
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const a = await alice.newPage();
  const b = await bob.newPage();

  await joinOffice(a, ANNA);
  await joinOffice(b, BJORN);

  // Anna's roster should list Björn once he exists.
  await a.reload();
  await expect(a.getByRole("option", { name: new RegExp(BJORN.room) })).toBeVisible();

  await a.getByRole("option", { name: new RegExp(BJORN.room) }).click();
  await expect(
    a.locator(".chat__empty").getByText(BJORN.room, { exact: false }),
  ).toBeVisible();

  await test.step("ett vanligt meddelande kommer fram", async () => {
    await a.getByLabel(/^Meddelande till /).fill("Avstämning om fem?");
    await a.getByRole("button", { name: "Skicka", exact: true }).click();

    // Scope to the message log: the roster also shows the text as a preview.
    await expect(a.locator(".chat__log").getByText("Avstämning om fem?")).toBeVisible();

    // Björn has not opened the thread, so it should surface as unread.
    const annaRow = b.getByRole("option").filter({ hasText: ANNA.room });
    await expect(annaRow.locator(".badge")).toHaveText("1");

    await annaRow.click();
    await expect(b.locator(".chat__log").getByText("Avstämning om fem?")).toBeVisible();
  });

  await test.step("avsändaren ser läskvitto", async () => {
    await expect(a.locator(".bubble--mine").last()).toContainText("Läst");
  });

  await test.step("ett meddelande med signal märks ut", async () => {
    await a.getByRole("button", { name: "Skicka med ljudsignal" }).click();
    await a.getByLabel(/^Meddelande till /).fill("Kom till receptionen");
    await a.getByRole("button", { name: "Skicka", exact: true }).click();

    const alerted = b.locator(".bubble--alert").last();
    await expect(alerted).toContainText("Kom till receptionen", { timeout: 15_000 });
    await expect(alerted).toContainText("Signal");
  });

  await test.step("en fil överförs och kan laddas ner intakt", async () => {
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
    await card.getByRole("button", { name: /^Spara / }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe("quarterly-report.bin");

    const stream = await saved.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
  });

  await test.step("närvaron uppdateras när någon går", async () => {
    await bob.close();
    // The conversation header tracks the other person's presence.
    await expect(a.locator(".chat__head-meta")).toHaveText("Offline", { timeout: 15_000 });
  });

  await alice.close();
});
