import { chromium } from 'playwright';
import fs from 'node:fs';
import pdfParse from 'pdf-parse';

async function makePdf() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  await page.setContent(`
    <!doctype html>
    <html>
    <head><style>body { font-family: Arial, sans-serif; font-size: 14px; }</style></head>
    <body>
      <h2>CITY CARE DIAGNOSTIC LAB</h2>
      <p>SAMPLE REPORT - FOR SOFTWARE TESTING ONLY</p>
      <p>Patient Name: Test Patient Report No: TST-2026-0001</p>
      <p>Age / Sex: 45 Years | Male Collected: 05-Nov-2026 08:15</p>
      <p>Referred by: Dr. Sample Doctor Reported: 05-Nov-2026 14:40</p>
      <p>Test Result Unit Reference Range Flag</p>
      <h3>COMPLETE BLOOD COUNT (CBC)</h3>
      <p>Hemoglobin 9.8 g/dL 13.0-17.0 L</p>
      <p>RBC Count 4.1 million/uL 4.5-5.5 L</p>
      <p>Hematocrit (PCV) 31 % 40-50 L</p>
      <p>MCV 74 fL 83-101 L</p>
      <p>WBC Count 11.8 x10^3/uL 4.0-11.0 H</p>
      <p>Platelet Count 245 x10^3/uL 150-400</p>
      <h3>BLOOD SUGAR</h3>
      <p>Fasting Glucose 128 mg/dL 70-100 H</p>
      <p>HbA1c 6.9 % 4.0-5.6 H</p>
      <h3>LIPID PROFILE</h3>
      <p>Total Cholesterol 232 mg/dL &lt;200 H</p>
      <p>LDL Cholesterol 152 mg/dL &lt;100 H</p>
      <p>HDL Cholesterol 38 mg/dL &gt;40 L</p>
      <p>Triglycerides 210 mg/dL &lt;150 H</p>
      <h3>KIDNEY AND LIVER</h3>
      <p>Creatinine 0.9 mg/dL 0.7-1.3</p>
      <p>Urea 28 mg/dL 15-40</p>
      <p>ALT (SGPT) 62 U/L 7-55 H</p>
      <p>AST (SGOT) 30 U/L 8-48</p>
      <h3>OTHER TESTS</h3>
      <p>TSH 2.1 uIU/mL 0.4-4.0</p>
      <p>Vitamin D (25-OH) 14 ng/mL 30-100 L</p>
    </body>
    </html>
  `);
  await page.pdf({ path: 'sample_lab_report.pdf', format: 'A4' });
  await browser.close();

  const d = await pdfParse(fs.readFileSync('sample_lab_report.pdf'));
  console.log('Playwright PDF created and parsed! Text:\n', d.text.trim());
}

makePdf();
