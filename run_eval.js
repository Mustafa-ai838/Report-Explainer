import fs from 'node:fs';
import pdfParse from 'pdf-parse';
import { createWorker } from 'tesseract.js';

function parseRange(referenceRange) {
  const lessMatch = referenceRange.match(/^[<]\s*([+-]?\d+(?:[.,]\d+)?)/);
  if (lessMatch) {
    return { type: "less", high: Number(lessMatch[1].replace(",", ".")) };
  }
  const greaterMatch = referenceRange.match(/^[>]\s*([+-]?\d+(?:[.,]\d+)?)/);
  if (greaterMatch) {
    return { type: "greater", low: Number(greaterMatch[1].replace(",", ".")) };
  }
  const rangeMatch = referenceRange.match(/([+-]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)\s*([+-]?\d+(?:[.,]\d+)?)/i);
  if (rangeMatch) {
    return {
      type: "between",
      low: Number(rangeMatch[1].replace(",", ".")),
      high: Number(rangeMatch[2].replace(",", "."))
    };
  }
  return null;
}

function checkSuspicious(valueStr, rangeStr, val, parsedRange, isOcr) {
  if (!isOcr) return false;
  if (/\b0\d+\b/.test(rangeStr)) return true;
  if (/\b0\d+\b/.test(valueStr)) return true;

  if (parsedRange && typeof val === "number") {
    if (parsedRange.type === "between") {
      const { low, high } = parsedRange;
      if (low > high) return true;
      if (val > 0 && low > 0 && low / val > 5) return true;
      if (val > 0 && high > 0 && val / high > 5) return true;
      const span = Math.abs(high - low) || 1;
      if (val < low - 5 * span || val > high + 5 * span) return true;
    } else if (parsedRange.type === "less") {
      if (parsedRange.high > 0 && val > 5 * parsedRange.high) return true;
    }
  }
  return false;
}

function classifyRange(val, parsedRange) {
  if (typeof val !== "number" || !parsedRange) return "review";
  if (parsedRange.type === "between") {
    return val < parsedRange.low ? "below" : val > parsedRange.high ? "above" : "within";
  }
  if (parsedRange.type === "less") {
    return val < parsedRange.high ? "within" : "above";
  }
  if (parsedRange.type === "greater") {
    return val > parsedRange.low ? "within" : "below";
  }
  return "review";
}

function extract(text, isOcr = false) {
  const rows = [];
  const pattern = /^\s*(.*?)\s+([+-]?\d+(?:[.,]\d+)?|[OIl|]+)\s+([^\s]+)\s+((?:[<>]=?|[+-]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)?\s*(?:[+-]?\d+(?:[.,]\d+)?)?)\s*(?:[LH])?\s*$/i;

  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const m = line.match(pattern);
    if (!m || !m[1].trim() || !/\d/.test(m[4])) continue;

    const name = m[1].trim();
    const valueStr = m[2].trim();
    const unit = m[3].trim();
    const rangeStr = m[4].trim();

    const isNumeric = /^[+-]?\d+(?:[.,]\d+)?$/.test(valueStr);
    const val = isNumeric ? Number(valueStr.replace(",", ".")) : null;
    const parsedRange = parseRange(rangeStr);

    const suspicious = !isNumeric || checkSuspicious(valueStr, rangeStr, val, parsedRange, isOcr);
    const row = {
      name,
      value: isNumeric ? val : null,
      unit,
      referenceRange: rangeStr,
      sourceLine: i + 1,
      sourceText: line.trim(),
      needsReview: suspicious,
      status: suspicious ? "review" : classifyRange(val, parsedRange)
    };
    rows.push(row);
  }
  return rows;
}

const expected = {
  "Hemoglobin": "below",
  "RBC Count": "below",
  "Hematocrit (PCV)": "below",
  "MCV": "below",
  "WBC Count": "above",
  "Platelet Count": "within",
  "Fasting Glucose": "above",
  "HbA1c": "above",
  "HbAlc": "above",
  "Total Cholesterol": "above",
  "LDL Cholesterol": "above",
  "HDL Cholesterol": "below",
  "Triglycerides": "above",
  "Creatinine": "within",
  "Urea": "within",
  "ALT (SGPT)": "above",
  "AST (SGOT)": "within",
  "TSH": "within",
  "Vitamin D (25-OH)": "below"
};

function printTable(results) {
  let correct = 0;
  let wrongStatusWithoutReview = 0;

  console.log("Test | Value | Unit | Range | Status");
  console.log("----------------------------------------------------------------------");
  for (const r of results) {
    const dispStatus = r.needsReview || r.status === "review" ? "Needs review" : r.status;
    console.log(`${r.name} | ${r.value ?? "Needs review"} | ${r.unit} | ${r.referenceRange} | ${dispStatus}`);
    
    const exp = expected[r.name];
    if (r.status === exp) {
      correct++;
    } else if (r.status !== "review") {
      wrongStatusWithoutReview++;
    }
  }
  console.log(`found ${results.length} of 18, correct ${correct} of 18, wrong status without Needs review ${wrongStatusWithoutReview}`);
}

async function run() {
  const pdfParsed = await pdfParse(fs.readFileSync("sample_lab_report.pdf"));
  const pdfResults = extract(pdfParsed.text, false);
  console.log("\n=== PDF RESULTS ===");
  printTable(pdfResults);

  const worker = await createWorker("eng");
  const pngOcr = await worker.recognize("sample_lab_report.png");
  const pngResults = extract(pngOcr.data.text, true);
  console.log("\n=== PNG RESULTS ===");
  printTable(pngResults);

  const photoOcr = await worker.recognize("sample_lab_report_photo.jpg");
  const photoResults = extract(photoOcr.data.text, true);
  console.log("\n=== PHOTO JPG RESULTS ===");
  printTable(photoResults);

  await worker.terminate();
}

run();
