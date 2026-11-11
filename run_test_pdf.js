import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import pdfParse from 'pdf-parse';

async function testFiles() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();

  const files = ['sample_report_2.pdf', 'sample_lab_report.png'];

  for (const f of files) {
    console.log(`\n=================== TESTING ${f} ===================`);
    await page.goto('http://127.0.0.1:4173/#upload');
    const fileInput = await page.locator('#reportFile');
    await fileInput.setInputFiles(path.resolve(f));
    await page.locator('[data-action="process-upload"]').click();

    await page.waitForURL(/#ocr/, { timeout: 120000 });
    await page.goto('http://127.0.0.1:4173/#summary');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('a[href$=".pdf"]').first().click()
    ]);
    const pdfPath = `downloaded_${f.replace(/\.[^.]+$/, '')}.pdf`;
    await download.saveAs(pdfPath);
    console.log(`Saved PDF to ${pdfPath} (${fs.statSync(pdfPath).size} bytes)`);

    const parsed = await pdfParse(fs.readFileSync(pdfPath));
    console.log('\n--- EXTRACTED PDF TEXT ---');
    console.log(parsed.text.trim());
  }

  await browser.close();
}

testFiles().catch(e => console.error(e));
