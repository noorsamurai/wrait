/**
 * Measures what the appearance setting actually costs.
 *
 * Signs up a small office, fills a conversation, then samples frame times
 * while continuously scrolling the message log - scrolling is the case that
 * forces the compositor to resample whatever sits behind each panel, which is
 * precisely what backdrop-filter makes expensive.
 *
 * Run it against a built app and a running relay:
 *
 *   node --experimental-sqlite ../server/src/index.js &
 *   npx vite preview --port 4173 --strictPort --host 127.0.0.1 &
 *   node perf/measure-appearance.mjs
 *
 * Set CHROMIUM_PATH to use a preinstalled browser instead of a downloaded one.
 */

import { chromium } from "@playwright/test";

const APP = "http://127.0.0.1:4173";
const SERVER = "http://127.0.0.1:8787";
const stamp = Date.now().toString(36);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });

async function signUp(page, username, displayName) {
  await page.goto(APP);
  await page.getByRole("tab", { name: "Create account" }).click();
  await page.getByLabel("Office server").fill(SERVER);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Display name").fill(displayName);
  await page.getByLabel("Password", { exact: true }).fill("measurepassword");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("heading", { name: "Office" }).waitFor();
}

// A populated office, so the roster and the log actually have content to paint.
const ctx = await browser.newContext({ viewport: { width: 1180, height: 780 }, colorScheme: "dark" });
const page = await ctx.newPage();
await signUp(page, `perf-a-${stamp}`, "Dana Reyes");

const extras = [];
for (let i = 0; i < 8; i++) {
  const c = await browser.newContext();
  const p = await c.newPage();
  await signUp(p, `perf-${i}-${stamp}`, `Colleague Number${i}`);
  extras.push(c);
}

await page.reload();
await page.getByRole("option").first().click();

// Fill the log so scrolling it is real work.
for (let i = 0; i < 40; i++) {
  await page.getByLabel(/^Message /).fill(`Message number ${i} with enough text to wrap onto a second line in the log.`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
await page.waitForTimeout(800);

/** Frame times while continuously scrolling the message log. */
async function sample(page) {
  return page.evaluate(async () => {
    const log = document.querySelector(".chat__log");
    const frames = [];
    let last = performance.now();
    let direction = 1;

    await new Promise((done) => {
      const start = last;
      function tick(now) {
        frames.push(now - last);
        last = now;
        // Scrolling forces the compositor to redo whatever sits behind each
        // panel, which is exactly what backdrop-filter makes expensive.
        log.scrollTop += direction * 22;
        if (log.scrollTop <= 0 || log.scrollTop + log.clientHeight >= log.scrollHeight - 1) direction *= -1;
        if (now - start < 3000) requestAnimationFrame(tick);
        else done();
      }
      requestAnimationFrame(tick);
    });

    frames.shift();
    const sorted = [...frames].sort((a, b) => a - b);
    const blurred = [...document.querySelectorAll("*")].filter((el) => {
      const s = getComputedStyle(el);
      const v = s.backdropFilter || s.webkitBackdropFilter;
      return v && v !== "none";
    }).length;
    const animating = document.getAnimations().filter((a) => a.playState === "running").length;

    return {
      frames: frames.length,
      mean: +(frames.reduce((s, f) => s + f, 0) / frames.length).toFixed(2),
      p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
      worst: +sorted[sorted.length - 1].toFixed(2),
      blurredElements: blurred,
      runningAnimations: animating,
    };
  });
}

const flat = await sample(page);

// Switch to the opt-in glass appearance and repeat, same page, same content.
await page.getByRole("button", { name: "Settings" }).click();
await page.getByRole("switch", { name: "Glass appearance" }).click();
await page.getByRole("button", { name: "Done" }).click();
await page.waitForTimeout(800);
const glass = await sample(page);

const row = (name, o) =>
  `${name.padEnd(7)} frames=${String(o.frames).padStart(4)}  mean=${String(o.mean).padStart(6)}ms  ` +
  `p95=${String(o.p95).padStart(6)}ms  worst=${String(o.worst).padStart(7)}ms  ` +
  `blurred-elements=${String(o.blurredElements).padStart(3)}  running-animations=${o.runningAnimations}`;

console.log(row("flat", flat));
console.log(row("glass", glass));
console.log(`\nflat renders ${(glass.mean / flat.mean).toFixed(2)}x faster per frame than glass`);

for (const c of extras) await c.close();
await ctx.close();
await browser.close();
