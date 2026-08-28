import { test, expect, type Page } from "@playwright/test";

const SERVER = "http://127.0.0.1:8788";
const stamp = Date.now().toString(36);
const ROOM_A = `Rum G ${stamp}`;
const ROOM_B = `Rum H ${stamp}`;

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

/** Pastes real clipboard HTML, the way a journal system or Word would. */
async function pasteHtml(page: Page, html: string) {
  await page.getByLabel(/^Meddelande till /).click();
  await page.evaluate((markup) => {
    const data = new DataTransfer();
    data.setData("text/html", markup);
    data.setData("text/plain", "fallback");
    document
      .querySelector<HTMLElement>('[contenteditable]')!
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, html);
}

test("formatering överlever inklistring, men inte skadlig markup", async ({ browser }) => {
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

  await test.step("fetstil, kursiv och listor följer med", async () => {
    await pasteHtml(
      a,
      "<p>Ta med <strong>remissen</strong> och <em>röntgenbilderna</em></p><ul><li>Journal</li><li>Samtycke</li></ul>",
    );
    await a.getByRole("button", { name: "Skicka", exact: true }).click();

    const received = b.locator(".bubble__body").last();
    await expect(received).toContainText("Ta med remissen", { timeout: 10_000 });
    // The structure survives, not just the words.
    await expect(received.locator("b")).toHaveText("remissen");
    await expect(received.locator("i")).toHaveText("röntgenbilderna");
    await expect(received.locator("li")).toHaveCount(2);
  });

  await test.step("skript och farliga länkar tas bort", async () => {
    await pasteHtml(
      a,
      '<p>Hej<script>window.__pwned = true;</script> ' +
        '<a href="javascript:window.__pwned=true">klicka</a> ' +
        '<img src=x onerror="window.__pwned=true"> ' +
        '<a href="https://example.com/journal">riktig länk</a></p>',
    );
    await a.getByRole("button", { name: "Skicka", exact: true }).click();

    const received = b.locator(".bubble__body").last();
    await expect(received).toContainText("Hej", { timeout: 10_000 });

    // Nothing executed, on either side.
    expect(await a.evaluate(() => (window as never as { __pwned?: boolean }).__pwned)).toBeUndefined();
    expect(await b.evaluate(() => (window as never as { __pwned?: boolean }).__pwned)).toBeUndefined();

    // The script and the image are gone; a javascript: link keeps its text
    // but loses its href; a real link survives.
    await expect(received.locator("script")).toHaveCount(0);
    await expect(received.locator("img")).toHaveCount(0);
    await expect(received).toContainText("klicka");
    await expect(received.locator("a")).toHaveCount(1);
    await expect(received.locator("a")).toHaveAttribute("href", "https://example.com/journal");
  });

  await test.step("högerklick erbjuder kopiering utan formatering", async () => {
    await b.locator(".bubble__body").first().click({ button: "right" });
    await expect(b.getByRole("menuitem", { name: "Kopiera", exact: true })).toBeVisible();
    await expect(b.getByRole("menuitem", { name: "Kopiera utan formatering" })).toBeVisible();
  });

  await aCtx.close();
  await bCtx.close();
});
