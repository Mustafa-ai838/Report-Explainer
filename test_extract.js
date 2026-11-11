import fs from 'node:fs';
import pdfParse from 'pdf-parse';

function cleanName(n) {
  let s = n.trim();
  if (/^HbAlc$/i.test(s)) return 'HbA1c';
  return s;
}

function cleanUnit(u) {
  let s = u.trim();
  s = s.replace(/x10[7^]?3\s*\/\s*uL/i, 'x10^3/uL');
  s = s.replace(/ulU\s*\/\s*mL/i, 'uIU/mL');
  return s;
}

function parseRange(referenceRange) {
  const lessMatch = referenceRange.match(/^[<]\s*([+-]?\d+(?:[.,]\d+)?)/);
  if (lessMatch) {
    return { type: 'less', high: Number(lessMatch[1].replace(',', '.')) };
  }
  const greaterMatch = referenceRange.match(/^[>]\s*([+-]?\d+(?:[.,]\d+)?)/);
  if (greaterMatch) {
    return { type: 'greater', low: Number(greaterMatch[1].replace(',', '.')) };
  }
  const rangeMatch = referenceRange.match(/([+-]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)\s*([+-]?\d+(?:[.,]\d+)?)/i);
  if (rangeMatch) {
    return {
      type: 'between',
      low: Number(rangeMatch[1].replace(',', '.')),
      high: Number(rangeMatch[2].replace(',', '.'))
    };
  }
  return null;
}

function checkSuspicious(valueStr, rangeStr, val, parsedRange, isOcr) {
  if (!isOcr) return { suspicious: false, reason: '' };
  if (/\b0\d+\b/.test(rangeStr)) {
    return { suspicious: true, reason: 'The reference range looks incomplete or may have lost a decimal point' };
  }
  if (/\b0\d+\b/.test(valueStr)) {
    return { suspicious: true, reason: 'The value may have lost a decimal point' };
  }

  if (parsedRange && typeof val === 'number') {
    if (parsedRange.type === 'between') {
      const { low, high } = parsedRange;
      if (low > high) {
        return { suspicious: true, reason: 'The reference range numbers appear inverted or misread' };
      }
      if (val > 0 && low > 0 && low / val > 5) {
        return { suspicious: true, reason: 'The value appears significantly outside its reference range' };
      }
      if (val > 0 && high > 0 && val / high > 5) {
        return { suspicious: true, reason: 'The value appears significantly outside its reference range' };
      }
      const span = Math.abs(high - low) || 1;
      if (val < low - 5 * span || val > high + 5 * span) {
        return { suspicious: true, reason: 'The value is far outside the printed reference range' };
      }
    } else if (parsedRange.type === 'less') {
      if (parsedRange.high > 0 && val > 5 * parsedRange.high) {
        return { suspicious: true, reason: 'The value is more than 5 times above the printed limit' };
      }
    }
  }
  return { suspicious: false, reason: '' };
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
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const rows = [];
  const singleLinePattern = /^\s*(.*?)\s+([+-]?\d+(?:[.,]\d+)?|[OIl|]+)\s+([^\s]+)\s+((?:[<>]=?|[+-]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)?\s*(?:[+-]?\d+(?:[.,]\d+)?)?)\s*(?:[LH])?\s*$/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // Try single line
    let m = line.match(singleLinePattern);
    if (m && m[1].trim() && /\d/.test(m[4])) {
      const name = cleanName(m[1].trim());
      const valueStr = m[2].trim();
      const unit = cleanUnit(m[3].trim());
      const rangeStr = m[4].trim();

      const isNumeric = /^[+-]?\d+(?:[.,]\d+)?$/.test(valueStr);
      const val = isNumeric ? Number(valueStr.replace(',', '.')) : null;
      const parsedRange = parseRange(rangeStr);
      const check = !isNumeric 
        ? { suspicious: true, reason: 'Could not confidently read numeric value' } 
        : checkSuspicious(valueStr, rangeStr, val, parsedRange, isOcr);

      rows.push({
        name,
        value: isNumeric ? val : null,
        unit,
        referenceRange: rangeStr,
        sourceLine: i + 1,
        sourceText: line,
        needsReview: check.suspicious,
        reviewReason: check.reason,
        status: check.suspicious ? "review" : classifyRange(val, parsedRange)
      });
      continue;
    }

    // Try multi-line (e.g. sample_report_2)
    // line i: Name
    // line i+1: Value
    // line i+2: Unit + Range (+ Flag)
    if (i + 2 < lines.length) {
      const lVal = lines[i + 1].trim();
      const lRest = lines[i + 2].trim();
      if (/^[+-]?\d+(?:[.,]\d+)?$/.test(lVal)) {
        const restMatch = lRest.match(/^([a-zA-Z%^0-9\/\(\)]+?)\s*((?:[<>]=?|[+-]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)?\s*(?:[+-]?\d+(?:[.,]\d+)?)?)\s*(?:[LH])?\s*$/i);
        if (restMatch && /\d/.test(restMatch[2])) {
          const name = cleanName(line);
          const valueStr = lVal;
          const unit = cleanUnit(restMatch[1]);
          const rangeStr = restMatch[2].trim();

          const val = Number(valueStr.replace(',', '.'));
          const parsedRange = parseRange(rangeStr);
          const check = checkSuspicious(valueStr, rangeStr, val, parsedRange, isOcr);

          rows.push({
            name,
            value: val,
            unit,
            referenceRange: rangeStr,
            sourceLine: i + 1,
            sourceText: line + ' ' + valueStr + ' ' + lRest,
            needsReview: check.suspicious,
            reviewReason: check.reason,
            status: check.suspicious ? "review" : classifyRange(val, parsedRange)
          });
          i += 2;
          continue;
        }
      }
    }
  }
  return rows;
}

const d = await pdfParse(fs.readFileSync('sample_report_2.pdf'));
const r2 = extract(d.text, false);
console.log('sample_report_2 tests found:', r2.length);
r2.forEach(r => console.log(r.name, '|', r.value, '|', r.unit, '|', r.referenceRange, '|', r.status));
