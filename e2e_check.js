import { chromium } from 'playwright';
import path from 'node:path';

async function testUploads() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();

  const consoleErrors = [];
  const networkErrors = [];

  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleErrors.push(`[${msg.type().toUpperCase()}] ${msg.text()}`);
    }
  });

  page.on('response', resp => {
    if (resp.status() >= 400) {
      networkErrors.push(`${resp.status()} ${resp.url()}`);
    }
  });

  await page.goto('http://127.0.0.1:4173');

  const files = ['sample_lab_report.pdf', 'sample_lab_report.png', 'sample_lab_report_photo.jpg'];
  const results = {};

  for (const f of files) {
    const filePath = path.resolve(f);
    console.log(`\n--- Uploading ${f} ---`);

    await page.goto('http://127.0.0.1:4173/#upload');
    const fileInput = await page.locator('#reportFile');
    await fileInput.setInputFiles(filePath);
    await page.locator('[data-action="process-upload"]').click();

    // Wait until OCR or error occurs
    await page.waitForURL(/#ocr|#upload/, { timeout: 120000 });
    const currentUrl = page.url();
    console.log('Navigated to:', currentUrl);

    if (currentUrl.includes('#ocr')) {
      // Navigate to summary to download PDF
      await page.goto('http://127.0.0.1:4173/#summary');
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('a[href$=".pdf"]').first().click()
      ]);
      const downloadPath = await download.path();
      console.log('Downloaded result PDF to:', downloadPath);
      results[f] = { status: 'success', downloaded: download.suggestedFilename() };
    } else {
      results[f] = { status: 'failed' };
    }
  }

  await browser.close();

  console.log('\n=== BROWSER CONSOLE ERRORS & WARNINGS ===');
  console.log(consoleErrors.length ? consoleErrors.join('\n') : 'None');

  console.log('\n=== NETWORK 4xx/5xx ERRORS ===');
  console.log(networkErrors.length ? networkErrors.join('\n') : 'None');

  console.log('\n=== RESULTS SUMMARY ===');
  console.log(JSON.stringify(results, null, 2));
}

testUploads().catch(e => console.error('Upload script failed:', e));
