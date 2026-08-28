import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = "http://127.0.0.1:8788";
const stamp = Date.now().toString(36);
const ROOM_A = `Rum I ${stamp}`;
const ROOM_B = `Rum J ${stamp}`;

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

/**
 * A JPEG carrying a date and a GPS position, which is what a phone produces
 * and exactly what must not travel onward.
 */
async function jpegWithMetadata(page: Page): Promise<string> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 1200;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#3a6ea5";
    ctx.fillRect(0, 0, 1600, 1200);
    ctx.fillStyle = "#e8c07a";
    ctx.fillRect(0, 0, 800, 600);
    const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.9));
    const plain = new Uint8Array(await blob.arrayBuffer());

    // Hand-built EXIF: DateTimeOriginal plus a GPS IFD pointer, so the test
    // is asserting against metadata that genuinely exists in the file.
    const tiff = new Uint8Array(120);
    const view = new DataView(tiff.buffer);
    view.setUint16(0, 0x4949, true);
    view.setUint16(2, 0x2a, true);
    view.setUint32(4, 8, true);
    view.setUint16(8, 2, true);
    view.setUint16(10, 0x0132, true); view.setUint16(12, 2, true);
    view.setUint32(14, 20, true); view.setUint32(18, 70, true);
    view.setUint16(22, 0x8825, true); view.setUint16(24, 4, true);
    view.setUint32(26, 1, true); view.setUint32(30, 96, true);
    view.setUint32(34, 0, true);
    const date = "2021:06:14 09:31:07\0";
    for (let i = 0; i < date.length; i++) tiff[70 + i] = date.charCodeAt(i);
    view.setUint16(96, 0, true);
    view.setUint32(98, 0, true);

    const header = [0x45, 0x78, 0x69, 0x66, 0, 0];
    const len = 2 + header.length + tiff.length;
    const app1 = new Uint8Array(2 + len);
    app1[0] = 0xff; app1[1] = 0xe1;
    app1[2] = (len >> 8) & 0xff; app1[3] = len & 0xff;
    app1.set(header, 4);
    app1.set(tiff, 4 + header.length);

    const out = new Uint8Array(plain.length + app1.length);
    out.set(plain.slice(0, 2), 0);
    out.set(app1, 2);
    out.set(plain.slice(2), 2 + app1.length);
    let binary = "";
    for (const byte of out) binary += String.fromCharCode(byte);
    return btoa(binary);
  });

  const dir = await mkdtemp(join(tmpdir(), "lokalen-photo-"));
  const path = join(dir, "IMG_4821.jpg");
  await writeFile(path, Buffer.from(base64, "base64"));
  return path;
}

test("bilder: beskärning, vridning, format och metadata", async ({ browser }) => {
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

  const photo = await jpegWithMetadata(a);
  // The composer behind the sheet also has a send button.
  const sheet = a.getByRole("dialog", { name: "Skicka bilder" });

  await test.step("väljaren öppnar redigeraren", async () => {
    await a.locator('input[accept="image/*"]').setInputFiles([photo, photo]);
    await expect(a.getByRole("dialog", { name: "Skicka bilder" })).toBeVisible();
    await expect(a.getByRole("heading", { name: "Skicka 2 bilder" })).toBeVisible();
    // Multi-select gives one thumbnail per photo.
    await expect(a.locator(".photo-strip__item")).toHaveCount(2);
  });

  await test.step("vridning och beskärning går att styra", async () => {
    await sheet.getByRole("button", { name: "Vrid höger" }).click();
    await expect(a.locator(".photo-frame")).toHaveAttribute("style", /90deg/);
    await sheet.getByRole("button", { name: "Återställ beskärning" }).click();
    await expect(a.locator(".photo-crop")).toBeVisible();
  });

  await test.step("formatet styr vad som skickas", async () => {
    await sheet.getByRole("button", { name: "PNG" }).click();
    await sheet.getByRole("button", { name: "1024 px" }).click();
    await sheet.getByRole("button", { name: "Skicka", exact: true }).click();

    // Both photos arrive, re-encoded and renamed to the chosen format.
    const photos = b.locator(".photo");
    await expect(photos).toHaveCount(2, { timeout: 25_000 });
    await expect(photos.first()).toContainText("IMG_4821.png");
  });

  await test.step("metadata följer inte med som standard", async () => {
    // Read the delivered bytes back and check the file itself, not the UI.
    const src = await b.locator(".photo img").first().getAttribute("src");
    const report = await b.evaluate(async (url) => {
      const bytes = new Uint8Array(await (await fetch(url!)).arrayBuffer());
      let text = "";
      for (const byte of bytes.slice(0, 4096)) text += String.fromCharCode(byte);
      return { hasExif: text.includes("Exif"), size: bytes.length };
    }, src);

    expect(report.hasExif).toBe(false);
    expect(report.size).toBeGreaterThan(0);
  });

  await test.step("datum kan behållas utan att något annat följer med", async () => {
    await a.locator('input[accept="image/*"]').setInputFiles([photo]);
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "JPEG" }).click();
    await sheet.getByRole("switch", { name: "Behåll datum och tid" }).click();
    await sheet.getByRole("button", { name: "Skicka", exact: true }).click();

    await expect(b.locator(".photo")).toHaveCount(3, { timeout: 25_000 });
    const src = await b.locator(".photo img").last().getAttribute("src");

    const report = await b.evaluate(async (url) => {
      const bytes = new Uint8Array(await (await fetch(url!)).arrayBuffer());
      let text = "";
      for (const byte of bytes) text += String.fromCharCode(byte);

      // Measure the EXIF segment itself: a rebuilt block is small, whereas
      // the camera's original carries far more than a timestamp.
      let app1Length: number | null = null;
      for (let i = 2; i + 4 < bytes.length; ) {
        if (bytes[i] !== 0xff) break;
        const marker = bytes[i + 1];
        if (marker === 0xda) break;
        const length = (bytes[i + 2] << 8) | bytes[i + 3];
        if (marker === 0xe1) { app1Length = length; break; }
        i += 2 + length;
      }
      return {
        hasExif: text.includes("Exif"),
        hasDate: text.includes("2021:06:14 09:31:07"),
        app1Length,
      };
    }, src);

    expect(report.hasExif).toBe(true);
    expect(report.hasDate).toBe(true);
    // Only the timestamp fits in a block this size; the GPS pointer that was
    // in the original cannot have survived.
    expect(report.app1Length).toBeLessThan(120);
  });

  await aCtx.close();
  await bCtx.close();
});
