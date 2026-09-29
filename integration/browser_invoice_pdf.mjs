// Capture the exact native print layout used by the invoice's Cetak / Unduh PDF button.
import { chromium } from "playwright";

const baseUrl = process.env.OPERRO_BASE_URL ?? "http://127.0.0.1:3003";
const invoiceNumber = process.env.OPERRO_INVOICE_NUMBER;
if (!invoiceNumber) throw new Error("Set OPERRO_INVOICE_NUMBER to an existing local QA invoice");
const browser = await chromium.launch({ executablePath: process.env.OPERRO_CHROME_PATH, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
try {
  await page.goto(`${baseUrl}/login`);
  await page.locator('input[type="email"]').fill("wbudiman1995@gmail.com");
  await page.locator('input[type="password"]').fill(process.env.QA_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("**/dashboard");
  await page.goto(`${baseUrl}/finance`);
  const invoiceLink = page.getByRole("link", { name: invoiceNumber });
  const href = await invoiceLink.getAttribute("href");
  if (!href) throw new Error(`QA invoice link missing: ${invoiceNumber}`);
  await page.goto(new URL(href, baseUrl).toString(), { waitUntil: "networkidle" });
  await page.locator("h1").first().waitFor();
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode().catch(() => {}))));
  console.log(`invoice: ${page.url()}`);
  console.log((await page.locator("body").innerText()).slice(0, 2000));
  await page.pdf({ path: process.env.OPERRO_PDF_OUTPUT ?? "/tmp/operro-invoice-qa.pdf", format: "A4", printBackground: true });
} finally {
  await browser.close();
}
