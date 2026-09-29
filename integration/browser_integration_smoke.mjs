// Local-only browser QA. Run against an isolated Supabase stack and dev server.
// Example: OPERRO_BASE_URL=http://127.0.0.1:3003 QA_PASSWORD=... node integration/browser_integration_smoke.mjs
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const baseUrl = process.env.OPERRO_BASE_URL ?? "http://127.0.0.1:3003";
const chromePath = process.env.OPERRO_CHROME_PATH;
const password = process.env.QA_PASSWORD;
const outputDir = process.env.OPERRO_BROWSER_OUTPUT ?? "/tmp/operro-browser-output";
if (!chromePath || !password) throw new Error("OPERRO_CHROME_PATH and QA_PASSWORD are required");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ executablePath: chromePath, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });

try {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator('button[type="submit"]').waitFor({ state: "visible" });
  console.log(`login page: ${await page.title()}`);
  await page.locator('input[type="email"]').fill("wbudiman1995@gmail.com");
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 30000 });
  await page.locator("h1").first().waitFor({ state: "visible", timeout: 30000 });
  console.log(`owner landed: ${page.url()}`);
  console.log((await page.locator("body").innerText()).slice(0, 700));
  await page.screenshot({ path: `${outputDir}/owner-dashboard.png`, fullPage: true, caret: "initial" });
  for (const route of ["/invoices/new", "/finance", "/programs", "/programs/memberships", "/followups", "/visits", "/payroll", "/my-schedule", "/leaderboard", "/reports", "/bookings", "/schedule", "/operations", "/customers", "/settings/documents"]) {
    const start = Date.now();
    const response = await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.locator("h1").first().waitFor({ state: "visible", timeout: 30000 });
    const heading = await page.locator("h1").first().innerText();
    console.log(`route ${route}: ${response?.status()} ${Date.now() - start}ms h1=${JSON.stringify(heading)} url=${page.url()}`);
    if (["/invoices/new", "/finance", "/programs/memberships", "/payroll", "/followups"].includes(route)) {
      await page.screenshot({ path: `${outputDir}/${route.replaceAll("/", "-")}.png`, fullPage: true, caret: "initial" });
    }
  }
  const groomer = await browser.newPage({ viewport: { width: 375, height: 812 } });
  groomer.on("pageerror", (error) => errors.push(`groomer pageerror: ${error.message}`));
  groomer.on("console", (message) => { if (message.type() === "error") errors.push(`groomer console: ${message.text()}`); });
  await groomer.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await groomer.locator('input[type="email"]').fill("groomer@homepaw.local");
  await groomer.locator('input[type="password"]').fill(password);
  await groomer.locator('button[type="submit"]').click();
  await groomer.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 30000 });
  await groomer.locator("h1").first().waitFor({ state: "visible", timeout: 30000 });
  console.log(`groomer landed: ${groomer.url()} h1=${JSON.stringify(await groomer.locator("h1").first().innerText())}`);
  for (const route of ["/my-schedule", "/followups", "/programs/memberships", "/payroll"]) {
    const response = await groomer.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await groomer.locator("h1").first().waitFor({ state: "visible", timeout: 30000 });
    const overflow = await groomer.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    console.log(`groomer route ${route}: ${response?.status()} h1=${JSON.stringify(await groomer.locator("h1").first().innerText())} overflow=${overflow}px url=${groomer.url()}`);
    if (overflow > 1) throw new Error(`Mobile horizontal overflow on ${route}: ${overflow}px`);
    if (route === "/programs/memberships" || route === "/payroll") console.log(`groomer ${route} body: ${JSON.stringify((await groomer.locator("main").innerText()).slice(0, 500))}`);
    if (route === "/my-schedule" || route === "/followups") {
      await groomer.screenshot({ path: `${outputDir}/groomer${route.replaceAll("/", "-")}-375.png`, fullPage: true, caret: "initial" });
    }
  }
  await groomer.close();
  console.log(`browser errors: ${JSON.stringify(errors)}`);
} finally {
  await browser.close();
}
