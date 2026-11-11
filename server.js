import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pdfParse from "pdf-parse";
import { createWorker } from "tesseract.js";
import { chromium } from "playwright";

const BUILD_VERSION = "2026-11-11 18:55:00 UTC";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.resolve(root, process.env.DATA_DIR || "data");
const databasePath = path.resolve(root, process.env.DB_PATH || path.join(dataDirectory, "reports.sqlite"));
const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const port = Number(process.env.PORT || 4173);
const guestRetentionHours = positiveSetting("GUEST_RETENTION_HOURS", 24);
const userRetentionDays = positiveSetting("USER_RETENTION_DAYS", 7);
const maxBytes = 12 * 1024 * 1024;
const guestCookieName = "report_guest";
const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin"
};
const rateLimits = new Map();
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a whole number from 1 to 65535.");
if (process.env.GUEST_COOKIE_SECRET && Buffer.byteLength(process.env.GUEST_COOKIE_SECRET) < 32) {
  throw new Error("GUEST_COOKIE_SECRET must contain at least 32 characters.");
}
void userRetentionDays;
mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA secure_delete = ON;
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY, file_name TEXT NOT NULL, mime_type TEXT NOT NULL,
    file_data BLOB NOT NULL, ocr_text TEXT NOT NULL DEFAULT '',
    results_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'uploaded', owner_id TEXT NOT NULL
  );
`);
const reportColumns = db.prepare("PRAGMA table_info(reports)").all();
if (!reportColumns.some((column) => column.name === "status")) {
  db.exec("ALTER TABLE reports ADD COLUMN status TEXT NOT NULL DEFAULT 'uploaded'");
  db.exec("UPDATE reports SET status='completed' WHERE length(ocr_text) > 0");
}
if (!reportColumns.some((column) => column.name === "owner_id")) {
  db.exec("ALTER TABLE reports ADD COLUMN owner_id TEXT");
}

const configuredCookieSecret = process.env.GUEST_COOKIE_SECRET;
const storedCookieSecret = db.prepare("SELECT value FROM app_settings WHERE key='guest_cookie_secret'").get()?.value;
const guestCookieSecret = configuredCookieSecret || storedCookieSecret || randomBytes(32).toString("base64url");
if (!configuredCookieSecret && !storedCookieSecret) {
  db.prepare("INSERT INTO app_settings (key,value) VALUES ('guest_cookie_secret',?)").run(guestCookieSecret);
}

function positiveSetting(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

function getOrCreateGuestOwner(request, response) {
  const cookie = (request.headers.cookie || "").split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${guestCookieName}=`))?.slice(guestCookieName.length + 1);
  const match = cookie?.match(/^([0-9a-f-]{36})\.([0-9a-f]{64})$/i);
  if (match) {
    const expected = createHmac("sha256", guestCookieSecret).update(match[1]).digest();
    const supplied = Buffer.from(match[2], "hex");
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) return `guest:${match[1]}`;
  }

  const id = randomUUID();
  const signature = createHmac("sha256", guestCookieSecret).update(id).digest("hex");
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${guestCookieName}=${id}.${signature}; Path=/; Max-Age=${Math.floor(guestRetentionHours * 3600)}; HttpOnly; SameSite=Lax${secure}`);
  return `guest:${id}`;
}

function checkRateLimit(request, pathname, response) {
  const now = Date.now();
  const ip = request.socket.remoteAddress || "unknown";
  const rules = [{ key: `api:${ip}`, limit: 120, window: 60_000 }];
  if (request.method === "POST" && pathname === "/api/reports") {
    rules.push({ key: `upload:${ip}`, limit: 10, window: 60 * 60_000 });
  }

  for (const rule of rules) {
    let entry = rateLimits.get(rule.key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + rule.window };
      rateLimits.set(rule.key, entry);
    }
    if (entry.count >= rule.limit) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      response.setHeader("Retry-After", String(retryAfter));
      json(response, 429, { error: "Too many requests. Please wait and try again.", code: "rate_limit_exceeded" });
      return false;
    }
    entry.count += 1;
  }

  if (rateLimits.size > 10_000) {
    for (const [key, entry] of rateLimits) if (entry.resetAt <= now) rateLimits.delete(key);
  }
  return true;
}

function resolveBrowserPath() {
  if (process.env.CHROME_PATH) {
    if (existsSync(process.env.CHROME_PATH)) return path.resolve(process.env.CHROME_PATH);
    throw Object.assign(new Error("CHROME_PATH does not point to an installed Chrome or Chromium executable."), {
      status: 503, code: "pdf_browser_unavailable"
    });
  }

  const candidates = [chromium.executablePath()];
  if (process.platform === "win32") {
    for (const directory of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (directory) candidates.push(path.join(directory, "Google", "Chrome", "Application", "chrome.exe"));
      if (directory) candidates.push(path.join(directory, "Chromium", "Application", "chrome.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    candidates.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome");
  }
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (executable) return executable;
  throw Object.assign(new Error("No Chrome or Chromium browser was found. Install Chromium or Chrome, or set CHROME_PATH to its executable."), {
    status: 503, code: "pdf_browser_unavailable"
  });
}

function cleanExpiredGuestReports() {
  const deleted = db.prepare(`
    DELETE FROM reports
    WHERE owner_id LIKE 'guest:%' AND datetime(created_at) < datetime('now', ?)
  `).run(`-${guestRetentionHours} hours`).changes;
  if (deleted) db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

cleanExpiredGuestReports();
const retentionTimer = setInterval(() => {
  try {
    cleanExpiredGuestReports();
  } catch (error) {
    if (process.env.NODE_ENV === "production") console.error("Guest report cleanup failed.");
    else console.error("Guest report cleanup failed.", error);
  }
}, 60 * 60_000);
retentionTimer.unref();

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    const executablePath = resolveBrowserPath();
    browserPromise = chromium.launch({ executablePath, headless: true }).catch((cause) => {
      browserPromise = null;
      throw Object.assign(new Error("PDF creation is unavailable. Install Chromium or Chrome, or set CHROME_PATH to its executable."), {
        status: 503, code: "pdf_browser_unavailable", cause
      });
    });
  }
  return browserPromise;
}

const server = createServer((request, response) => {
  for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  const ownerId = pathname.startsWith("/api/") && pathname !== "/api/health"
    ? getOrCreateGuestOwner(request, response)
    : null;
  if (pathname.startsWith("/api/") && pathname !== "/api/health" && !checkRateLimit(request, pathname, response)) return;
  handle(request, response, ownerId).catch((error) => {
    if (response.headersSent) return response.destroy(error);
    const failure = publicError(error);
    if (process.env.NODE_ENV === "production") {
      console.error(`[${request.method} ${pathname}] ${failure.message}`);
    } else {
      console.error(`[${request.method} ${pathname}]`, error.stack || error);
      if (error.cause) console.error("Underlying cause:", error.cause.stack || error.cause);
    }
    json(response, failure.status, { error: failure.message, code: failure.code });
  });
});
server.listen(port, host, () => {
  console.log(`Report Explainer build: ${BUILD_VERSION}`);
  console.log(`Report Explainer listening on ${host}:${port}`);
});

async function handle(req, res, ownerId) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const p = url.pathname;
  if (req.method === "GET" && p === "/health") return json(res, 200, { status: "ok" });
  if (req.method === "GET" && p === "/api/health") return json(res, 200, { status: "ok", build: BUILD_VERSION });

  const translation = p.match(/^\/api\/translations\/(en|ur)$/);
  if (req.method === "GET" && translation) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(readFileSync(path.join(root, "i18n", `${translation[1]}.json`)));
  }

  if (req.method === "POST" && p === "/api/reports") {
    const body = await readBody(req, maxBytes + 64_000);
    const file = multipartFile(body, req.headers["content-type"] || "");
    if (!file) return json(res, 400, { error: "Choose a PDF, PNG, or JPEG report.", code: "upload_field_missing" });
    if (file.data.length > maxBytes) return json(res, 413, { error: "The file must be 12 MB or smaller.", code: "file_too_large" });
    const mimeType = fileType(file.data);
    if (!mimeType) return json(res, 415, { error: "Only PDF, PNG, and JPEG files are supported.", code: "unsupported_file_type" });
    const id = randomUUID();
    const fileName = path.basename(file.fileName.replace(/[\\/\0]/g, "_"));
    db.prepare("INSERT INTO reports (id,file_name,mime_type,file_data,owner_id) VALUES (?,?,?,?,?)")
      .run(id, fileName, mimeType, file.data, ownerId);
    return json(res, 201, { id, fileName, mimeType });
  }

  const processMatch = p.match(/^\/api\/reports\/([0-9a-f-]{36})\/process$/i);
  if (req.method === "POST" && processMatch) {
    const report = findReport(processMatch[1], ownerId);
    if (!report) return json(res, 404, { error: "Report not found. Upload it again to continue.", code: "report_not_found" });
    db.prepare("UPDATE reports SET status='processing' WHERE id=?").run(report.id);
    let processed;
    try {
      processed = await processReport(report);
      db.prepare("UPDATE reports SET status='completed' WHERE id=?").run(report.id);
    } catch (error) {
      db.prepare("UPDATE reports SET status='failed' WHERE id=?").run(report.id);
      throw error;
    }
    return json(res, 200, processed);
  }

  const download = p.match(/^\/api\/reports\/([0-9a-f-]{36})\/download\.(pdf|csv)$/i);
  if (req.method === "GET" && download) {
    const report = findReport(download[1], ownerId);
    if (!report) return json(res, 404, { error: "Report not found. Upload it again to continue." });
    const extension = download[2].toLowerCase();
    const safeName = path.basename(report.file_name, path.extname(report.file_name))
      .replace(/[^\w.-]+/g, "_") || "report";
    const language = url.searchParams.get("lang") || "both";
    const content = extension === "pdf" ? await createReportPdf(report, language) : createReportCsv(report);
    res.writeHead(200, {
      "Content-Type": extension === "pdf" ? "application/pdf" : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeName}-report.${extension}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store"
    });
    return res.end(content);
  }

  if (req.method === "GET" && p === "/api/reports") {
    const reports = db.prepare(`
      SELECT id, file_name, mime_type, created_at, status
      FROM reports WHERE owner_id=? ORDER BY created_at DESC, rowid DESC
    `).all(ownerId);
    return json(res, 200, reports.map(publicHistoryItem));
  }

  const fileMatch = p.match(/^\/api\/reports\/([0-9a-f-]{36})\/file$/i);
  if (req.method === "GET" && fileMatch) {
    const report = findReport(fileMatch[1], ownerId);
    if (!report) return json(res, 404, { error: "Report not found." });
    res.writeHead(200, {
      "Content-Type": report.mime_type,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(report.file_name)}`,
      "X-Content-Type-Options": "nosniff"
    });
    return res.end(report.file_data);
  }

  const explanations = p.match(/^\/api\/reports\/([0-9a-f-]{36})\/explanations$/i);
  if (req.method === "GET" && explanations) {
    const report = findReport(explanations[1], ownerId);
    if (!report) return json(res, 404, { error: "Report not found. Upload it again to continue." });
    const language = url.searchParams.get("language");
    if (!["en", "ur", "both"].includes(language)) return json(res, 400, { error: "Choose English, Urdu, or Both." });
    return json(res, 200, { explanations: JSON.parse(report.results_json).map((r) => explanation(r, language)) });
  }

  const edit = p.match(/^\/api\/reports\/([0-9a-f-]{36})\/results\/(\d+)$/i);
  if (req.method === "PATCH" && edit) {
    const report = findReport(edit[1], ownerId);
    if (!report) return json(res, 404, { error: "Report not found. Upload it again to continue." });
    const body = await jsonBody(req, 32_000);
    const results = JSON.parse(report.results_json);
    const index = Number(edit[2]);
    const value = typeof body.value === "string" ? body.value.trim() : "";
    if (index < 0 || index >= results.length) return json(res, 404, { error: "That result was not found.", code: "result_not_found" });
    if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(value)) return json(res, 400, { error: "Enter a valid number, for example 10.2." });
    results[index].value = Number(value.replace(",", "."));
    results[index].needsReview = false;
    results[index].reviewReason = "";
    results[index].status = classifyRow(results[index]);
    db.prepare("UPDATE reports SET results_json=? WHERE id=?").run(JSON.stringify(results), report.id);
    return json(res, 200, { result: results[index], results });
  }

  const ocr = p.match(/^\/api\/reports\/([0-9a-f-]{36})\/ocr$/i);
  if (req.method === "POST" && ocr) {
    const report = findReport(ocr[1], ownerId);
    if (!report) return json(res, 404, { error: "Report not found. Upload it again to continue." });
    const body = await jsonBody(req, 600_000);
    if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 500_000) {
      return json(res, 400, { error: "OCR text is empty or too large. Try a clearer report." });
    }
    const results = extract(body.text, true);
    db.prepare("UPDATE reports SET ocr_text=?,results_json=? WHERE id=?")
      .run(body.text, JSON.stringify(results), report.id);
    return json(res, 200, { ocrText: body.text, results });
  }

  const reportMatch = p.match(/^\/api\/reports\/([0-9a-f-]{36})$/i);
  if (reportMatch && req.method === "GET") {
    const report = findReport(reportMatch[1], ownerId);
    return report ? json(res, 200, publicReport(report)) : json(res, 404, { error: "Report not found. Upload it again to continue." });
  }
  if (reportMatch && req.method === "DELETE") {
    const deleted = db.prepare("DELETE FROM reports WHERE id=? AND owner_id=?").run(reportMatch[1], ownerId).changes;
    if (!deleted) return json(res, 404, { error: "Report not found." });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && staticFile(p, res)) return;
  return json(res, 404, { error: "Page not found." });
}

function staticFile(urlPath, res) {
  const files = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/tests/sample.png": ["tests/sample.png", "image/png"],
    "/tests/sample.pdf": ["tests/sample.pdf", "application/pdf"]
  };
  const found = files[urlPath];
  if (!found || !existsSync(path.join(root, found[0]))) return false;
  res.writeHead(200, { "Content-Type": found[1], "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
  res.end(readFileSync(path.join(root, found[0])));
  return true;
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function publicError(error) {
  if (error.code === "SQLITE_FULL" || error.code === "ENOSPC") {
    return { status: 507, code: "storage_full", message: "The server is out of disk space. Free space on the server drive and try again." };
  }
  if (error.code === "SQLITE_READONLY" || error.code === "EACCES" || error.code === "EPERM") {
    return { status: 500, code: "storage_unavailable", message: "The report database cannot be written. Check that the data folder is writable." };
  }
  if (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED") {
    return { status: 503, code: "database_busy", message: "The report database is busy. Wait a moment and try again." };
  }
  if (process.env.NODE_ENV === "production" && (!error.status || error.status >= 500)) {
    return { status: error.status || 500, code: error.code || "server_error", message: "The server could not complete this request." };
  }
  return {
    status: error.status || 500,
    code: error.code || "server_error",
    message: error.status ? error.message : "The server could not complete this request."
  };
}

async function processReport(report) {
  let ocrText;
  let isOcr = false;
  if (report.mime_type === "application/pdf") {
    try {
      const parsed = await pdfParse(report.file_data);
      ocrText = parsed.text;
    } catch (error) {
      throw Object.assign(new Error("The PDF could not be read. Try a valid, text-based PDF or a clear image."), {
        status: 422, code: "pdf_read_failed", cause: error
      });
    }
  } else {
    isOcr = true;
    let worker;
    try {
      worker = await createWorker("eng", undefined, {
        langPath: root,
        corePath: path.join(root, "node_modules", "tesseract.js-core"),
        workerPath: path.join(root, "node_modules", "tesseract.js", "src", "worker-script", "node", "index.js"),
        cacheMethod: "none",
        gzip: false
      });
      const result = await worker.recognize(report.file_data);
      ocrText = result.data.text;
    } catch (error) {
      throw Object.assign(new Error("The offline OCR engine or English language data could not be loaded. Check the app files and restart the server."), {
        status: 503, code: "ocr_engine_unavailable", cause: error
      });
    } finally {
      if (worker) await worker.terminate();
    }
  }

  ocrText = (ocrText || "").replace(/\r/g, "").trim();
  if (!ocrText) {
    if (report.mime_type === "application/pdf") {
      throw Object.assign(new Error("This PDF has no readable text. Please upload a clear photo or screenshot of the report instead."), {
        status: 422, code: "pdf_no_readable_text"
      });
    }
    throw Object.assign(new Error("No readable text was found in the uploaded report."), {
      status: 422, code: "no_readable_text"
    });
  }
  const results = extract(ocrText, isOcr);
  db.prepare("UPDATE reports SET ocr_text=?,results_json=? WHERE id=?")
    .run(ocrText, JSON.stringify(results), report.id);
  return { ocrText, results };
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(Object.assign(new Error("The upload is too large. Files must be 12 MB or smaller."), {
          status: 413, code: "file_too_large"
        }));
        req.resume();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function jsonBody(req, max) {
  try {
    return JSON.parse((await readBody(req, max)).toString("utf8"));
  } catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error("Invalid JSON request."), { status: 400 });
  }
}

function multipartFile(body, contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) return null;
  const boundary = Buffer.from(`--${(match[1] || match[2]).trim()}`);
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length + 2;
    const endHeaders = body.indexOf(Buffer.from("\r\n\r\n"), start);
    const end = body.indexOf(Buffer.concat([Buffer.from("\r\n"), boundary]), endHeaders + 4);
    if (endHeaders === -1 || end === -1) return null;
    const headers = body.subarray(start, endHeaders).toString("utf8");
    const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || "";
    if (disposition.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1] === "report") {
      const fileName = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1];
      return fileName ? { fileName, data: body.subarray(endHeaders + 4, end) } : null;
    }
    pos = body.indexOf(boundary, end + 2);
  }
  return null;
}

function fileType(bytes) {
  if (bytes.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  return null;
}

function findReport(id, ownerId) {
  return db.prepare("SELECT * FROM reports WHERE id=? AND owner_id=?").get(id, ownerId) || null;
}
function publicReport(row) {
  return {
    id: row.id, fileName: row.file_name, mimeType: row.mime_type, ocrText: row.ocr_text,
    results: JSON.parse(row.results_json), createdAt: row.created_at, status: row.status
  };
}
function publicHistoryItem(row) {
  return { id: row.id, fileName: row.file_name, mimeType: row.mime_type, createdAt: row.created_at, status: row.status };
}
function csvCell(value) {
  let cell = String(value ?? "");
  if (typeof value !== "number" && /^[\s]*[=+\-@]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replace(/"/g, '""')}"`;
}
function createReportCsv(report) {
  const results = JSON.parse(report.results_json);
  const header = ["File Name", "Created At (UTC)", "Status", "Test", "Value", "Unit", "Reference Range", "Result Status", "Source Line"];
  const metadata = [report.file_name, report.created_at, report.status];
  const rows = results.length
    ? results.map((result) => [
      ...metadata, result.name, result.value ?? "Needs review", result.unit,
      result.referenceRange, result.status, result.sourceLine
    ])
    : [[...metadata, "No test rows recognized", "", "", "", "", ""]];
  const content = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  return Buffer.from(`\uFEFF${content}\r\n`, "utf8");
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

function formatDisplayDate(dateStr) {
  const d = new Date(dateStr.includes("T") ? dateStr : `${dateStr.replace(" ", "T")}Z`);
  if (isNaN(d.getTime())) return dateStr;
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC" });
  return `${day}, ${time}`;
}

const TEST_DESCRIPTIONS = {
  "Hemoglobin": {
    en: "Hemoglobin carries oxygen from your lungs to the rest of your body.",
    ur: "ہیموگلوبن آپ کے پھیپھڑوں سے پورے جسم میں آکسیجن پہنچانے میں مدد دیتا ہے۔"
  },
  "RBC Count": {
    en: "Red blood cells carry oxygen throughout your body.",
    ur: "سرخ خلیات پورے جسم میں آکسیجن کی ترسیل کا کام کرتے ہیں۔"
  },
  "Hematocrit (PCV)": {
    en: "Hematocrit measures the percentage of red blood cells in your blood.",
    ur: "ہیماٹوکرٹ خون میں سرخ خلیات کے تناسب کی پیمائش کرتا ہے۔"
  },
  "MCV": {
    en: "MCV measures the average size of your red blood cells.",
    ur: "ایم سی وی آپ کے سرخ خلیات کے اوسط سائز کی پیمائش کرتا ہے۔"
  },
  "WBC Count": {
    en: "White blood cells help your body fight infections.",
    ur: "سفید خلیات جسم کے دفاعی نظام اور قوت مدافعت کا حصہ ہیں۔"
  },
  "Platelet Count": {
    en: "Platelets help your blood clot normally to stop bleeding.",
    ur: "پلیٹلٹس خون کے جمنے اور بہاؤ کو روکنے میں مدد دیتے ہیں۔"
  },
  "Ferritin": {
    en: "Ferritin measures how much iron your body has stored.",
    ur: "فیریٹن جسم میں محفوظ شدہ آئرن کی مقدار کو ظاہر کرتا ہے۔"
  },
  "Fasting Glucose": {
    en: "Fasting glucose measures the level of sugar in your blood after fasting.",
    ur: "فاسٹنگ گلوکوز خالی پیٹ خون میں شکر کی سطح کی پیمائش کرتا ہے۔"
  },
  "HbA1c": {
    en: "HbA1c reflects your average blood sugar levels over the past two to three months.",
    ur: "ایچ بی اے ون سی پچھلے دو سے تین ماہ کے دوران اوسط شوگر کی عکاسی کرتا ہے۔"
  },
  "Total Cholesterol": {
    en: "Total cholesterol measures the overall amount of cholesterol in your blood.",
    ur: "ٹوٹل کولیسٹرول خون میں مجموعی چکنائی کی مقدار کو جانچتا ہے۔"
  },
  "LDL Cholesterol": {
    en: "LDL cholesterol measures low-density lipoprotein, commonly tracked for heart health.",
    ur: "ایل ڈی ایل کولیسٹرول جسم میں مخصوص چکنائی کی سطح ظاہر کرتا ہے۔"
  },
  "HDL Cholesterol": {
    en: "HDL cholesterol measures high-density lipoprotein in your blood.",
    ur: "ایچ ڈی ایل کولیسٹرول خون میں مفید سمجھی جانے والی چکنائی کی پیمائش ہے۔"
  },
  "Triglycerides": {
    en: "Triglycerides are a type of fat found in your blood.",
    ur: "ٹرائی گلیسرائیڈز خون میں موجود چکنائی کی ایک عام قسم ہیں۔"
  },
  "Creatinine": {
    en: "Creatinine reflects normal muscle breakdown and indicates kidney function.",
    ur: "کریٹینائن گردوں کی عمومی کارکردگی کا اشارہ دیتا ہے۔"
  },
  "Urea": {
    en: "Urea is a waste product filtered and removed by the kidneys.",
    ur: "یوریا جسم کا ایک فاسد مادہ ہے جسے گردے فلٹر کرتے ہیں۔"
  },
  "ALT (SGPT)": {
    en: "ALT is an enzyme found mostly in the liver that assists metabolism.",
    ur: "اے ایل ٹی جگر میں پایا جانے والا ایک انزائم ہے۔"
  },
  "AST (SGOT)": {
    en: "AST is an enzyme found in liver and muscle cells.",
    ur: "اے ایس ٹی جگر اور پٹھوں کے خلیات میں پایا جانے والا انزائم ہے۔"
  },
  "TSH": {
    en: "TSH is a hormone that regulates thyroid activity and metabolism.",
    ur: "ٹی ایس ایچ تھائیرائڈ غدود کے نظام کو متوازن رکھنے والا ہارمون ہے۔"
  },
  "Vitamin D (25-OH)": {
    en: "Vitamin D is essential for bone strength and overall immune health.",
    ur: "وٹامن ڈی ہڈیوں کی مضبوطی اور عمومی صحت کے لیے ضروری ہے۔"
  }
};

function buildSafeExplanation(r, lang) {
  if (r.needsReview || r.status === "review") {
    const reasonText = r.reviewReason || "The value or range requires careful review before an explanation can be provided.";
    return {
      en: `Needs Review: ${reasonText}. Please refer directly to your printed laboratory report and consult your doctor.`,
      ur: `جائزہ درکار ہے: ${reasonText}۔ براہِ کرم اصل رپورٹ دیکھیں اور اپنے ڈاکٹر سے رجوع کریں۔`
    };
  }

  const desc = TEST_DESCRIPTIONS[r.name] || {
    en: `${r.name} was measured as part of this laboratory panel.`,
    ur: `${r.name} کی پیمائش لیبارٹری ٹیسٹ کے تحت کی گئی ہے۔`
  };

  const statusWords = {
    below: { en: "below", ur: "سے کم" },
    above: { en: "above", ur: "سے زیادہ" },
    within: { en: "within", ur: "کے اندر" }
  };
  const sw = statusWords[r.status] || { en: "relative to", ur: "کے مطابق" };

  const enText = `${r.name} is ${r.value} ${r.unit}, which is ${sw.en} the printed reference range (${r.referenceRange}). ${desc.en} Please discuss what this means for your individual health with your doctor.`;
  const urText = `${r.name} کی قدر ${r.value} ${r.unit} ہے، جو رپورٹ کی عام حد (${r.referenceRange}) ${sw.ur} ہے۔ ${desc.ur} براہِ کرم اس نتیجے کے بارے میں اپنے معالج سے مشورہ کریں۔`;

  return { en: enText, ur: urText };
}

async function createReportPdf(report, language = "both") {
  const results = JSON.parse(report.results_json);
  const browser = await getBrowser();
  const page = await browser.newPage();

  const formattedDate = formatDisplayDate(report.created_at);

  const cardsHtml = results.length
    ? results.map(r => {
        const isRev = r.needsReview || r.status === "review";
        const statusClass = isRev ? "review" : r.status;
        const statusLabel = isRev ? "Needs Review" : r.status;
        const expl = buildSafeExplanation(r, language);

        const enBlock = (language === "en" || language === "both")
          ? `<div class="expl-en">${escapeHtml(expl.en)}</div>`
          : "";
        const urBlock = (language === "ur" || language === "both")
          ? `<div class="expl-ur" dir="rtl" lang="ur">${escapeHtml(expl.ur)}</div>`
          : "";

        return `
          <div class="test-card ${statusClass}">
            <div class="card-header">
              <div class="test-identity">
                <span class="test-name">${escapeHtml(r.name)}</span>
                <span class="source-tag">Page 1, Line ${r.sourceLine || 1}</span>
              </div>
              <div class="reading">
                <span class="val-unit">${escapeHtml(r.value ?? "—")} ${escapeHtml(r.unit)}</span>
                <span class="range-info">Range: ${escapeHtml(r.referenceRange)}</span>
                <span class="status-pill ${statusClass}">${escapeHtml(statusLabel)}</span>
              </div>
            </div>
            ${isRev && r.reviewReason ? `<div class="review-reason"><strong>Note:</strong> ${escapeHtml(r.reviewReason)}</div>` : ""}
            <div class="card-expl">
              ${enBlock}
              ${urBlock}
            </div>
          </div>
        `;
      }).join("")
    : `<div class="empty-msg">No test rows recognized.</div>`;

  const html = `
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>Report Explainer - Results Summary</title>
      <style>
        @page {
          size: A4;
          margin: 18mm 15mm 20mm 15mm;
          @bottom-right {
            content: counter(page) " of " counter(pages);
            font-size: 10px;
            color: #708395;
            font-family: "Segoe UI", Tahoma, Arial, sans-serif;
          }
        }
        * { box-sizing: border-box; }
        body {
          font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, Tahoma, Arial, sans-serif;
          color: #172635;
          font-size: 12px;
          line-height: 1.5;
          margin: 0;
          padding: 0;
        }
        .header {
          border-bottom: 2px solid #0a3f70;
          padding-bottom: 12px;
          margin-bottom: 16px;
        }
        .title {
          font-size: 22px;
          font-weight: 750;
          color: #0a3f70;
          margin: 0 0 6px 0;
        }
        .meta-strip {
          display: flex;
          justify-content: space-between;
          color: #506477;
          font-size: 11px;
        }
        .meta-strip strong { color: #172635; }
        .test-card {
          border: 1px solid #d7e3ed;
          border-radius: 8px;
          background: #ffffff;
          margin-bottom: 11px;
          padding: 10px 14px;
          page-break-inside: avoid;
          break-inside: avoid;
        }
        .test-card.review {
          background: #faf8ff;
          border-color: #d1c4e9;
        }
        .card-header {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          border-bottom: 1px solid #eef3f7;
          padding-bottom: 6px;
          margin-bottom: 6px;
        }
        .test-name {
          font-size: 14px;
          font-weight: 700;
          color: #0a3f70;
        }
        .source-tag {
          font-size: 10px;
          color: #708395;
          margin-left: 8px;
        }
        .reading {
          display: flex;
          align-items: baseline;
          gap: 10px;
        }
        .val-unit {
          font-weight: 700;
          font-size: 13px;
          color: #172635;
        }
        .range-info {
          font-size: 11px;
          color: #506477;
        }
        .status-pill {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 99px;
          font-weight: 700;
          font-size: 10px;
          text-transform: capitalize;
        }
        .status-pill.within { background: #e4f5ea; color: #17834c; }
        .status-pill.below, .status-pill.above { background: #fff3d4; color: #a56d00; }
        .status-pill.review { background: #f0eafa; color: #5e418c; }
        .review-reason {
          background: #fff9e6;
          border: 1px solid #ffe082;
          color: #795548;
          border-radius: 4px;
          padding: 5px 8px;
          font-size: 11px;
          margin-bottom: 6px;
        }
        .card-expl {
          font-size: 11.5px;
          line-height: 1.5;
        }
        .expl-en {
          color: #334455;
          margin-bottom: 4px;
        }
        .expl-ur {
          font-family: "Noto Nastaliq Urdu", "Jameel Noori Nastaleeq", "Urdu Typesetting", "Arial", sans-serif;
          font-size: 13px;
          line-height: 1.8;
          color: #0d2a45;
          text-align: right;
          direction: rtl;
        }
        .footer-note {
          margin-top: 18px;
          padding-top: 10px;
          border-top: 1px solid #d7e3ed;
          font-size: 10.5px;
          color: #607282;
          text-align: center;
        }
        .empty-msg {
          text-align: center;
          padding: 30px;
          color: #506477;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1 class="title">Report Explainer — Results Summary</h1>
        <div class="meta-strip">
          <span><strong>File:</strong> ${escapeHtml(report.file_name)}</span>
          <span><strong>Date:</strong> ${escapeHtml(formattedDate)}</span>
          <span><strong>Tests Extracted:</strong> ${results.length}</span>
        </div>
      </div>

      <div class="cards-container">
        ${cardsHtml}
      </div>

      <div class="footer-note">
        This summary restates your report. Please ask your doctor about your results.
      </div>
    </body>
    </html>
  `;

  await page.setContent(html, { waitUntil: "load" });
  const buffer = await page.pdf({
    format: "A4",
    margin: { top: "15mm", bottom: "18mm", left: "15mm", right: "15mm" },
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate: `
      <div style="width: 100%; font-size: 9px; color: #708395; font-family: Segoe UI, Arial, sans-serif; padding: 0 15mm; display: flex; justify-content: space-between;">
        <span>Report Explainer</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>
    `
  });
  await page.close();
  return buffer;
}

function cleanName(n) {
  let s = n.trim();
  if (/^HbAlc$/i.test(s)) return "HbA1c";
  return s;
}

function cleanUnit(u) {
  let s = u.trim();
  s = s.replace(/x10[7^]?3\s*\/\s*uL/i, "x10^3/uL");
  s = s.replace(/ulU\s*\/\s*mL/i, "uIU/mL");
  return s;
}

const KNOWN_UNITS = [
  "g/dL", "mg/dL", "million/uL", "x10^3/uL", "%", "fL", "ng/mL", "U/L", "uIU/mL",
  "mmol/L", "mg/L", "ug/dL", "pg/mL", "IU/L", "mIU/mL", "g/L", "umol/L", "x10^6/uL"
];

function isKnownUnit(u) {
  const norm = u.toLowerCase().replace(/[\^]/g, "");
  return KNOWN_UNITS.some(k => k.toLowerCase().replace(/[\^]/g, "") === norm);
}

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
  if (!isOcr) return { suspicious: false, reason: "" };
  if (/\b0\d+\b/.test(rangeStr)) {
    return { suspicious: true, reason: "The reference range looks incomplete or may have lost a decimal point" };
  }
  if (/\b0\d+\b/.test(valueStr)) {
    return { suspicious: true, reason: "The value may have lost a decimal point" };
  }

  if (parsedRange && typeof val === "number") {
    if (parsedRange.type === "between") {
      const { low, high } = parsedRange;
      if (low > high) {
        return { suspicious: true, reason: "The reference range numbers appear inverted or misread" };
      }
      if (val > 0 && low > 0 && low / val > 5) {
        return { suspicious: true, reason: "The value appears significantly outside its reference range" };
      }
      if (val > 0 && high > 0 && val / high > 5) {
        return { suspicious: true, reason: "The value appears significantly outside its reference range" };
      }
      const span = Math.abs(high - low) || 1;
      if (val < low - 5 * span || val > high + 5 * span) {
        return { suspicious: true, reason: "The value is far outside the printed reference range" };
      }
    } else if (parsedRange.type === "less") {
      if (parsedRange.high > 0 && val > 5 * parsedRange.high) {
        return { suspicious: true, reason: "The value is more than 5 times above the printed limit" };
      }
    }
  }
  return { suspicious: false, reason: "" };
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

function classifyRow(row) {
  const parsedRange = parseRange(row.referenceRange || "");
  return classifyRange(row.value, parsedRange);
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
      const unit = cleanUnit(m[3].trim());
      if (isKnownUnit(unit) || !m[2].includes("-")) {
        const name = cleanName(m[1].trim());
        const valueStr = m[2].trim();
        const rangeStr = m[4].trim();

        const isNumeric = /^[+-]?\d+(?:[.,]\d+)?$/.test(valueStr);
        const val = isNumeric ? Number(valueStr.replace(",", ".")) : null;
        const parsedRange = parseRange(rangeStr);
        const check = !isNumeric
          ? { suspicious: true, reason: "Could not confidently read numeric value" }
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
          const unit = cleanUnit(restMatch[1]);
          if (isKnownUnit(unit)) {
            const name = cleanName(line);
            const valueStr = lVal;
            const rangeStr = restMatch[2].trim();

            const val = Number(valueStr.replace(",", "."));
            const parsedRange = parseRange(rangeStr);
            const check = checkSuspicious(valueStr, rangeStr, val, parsedRange, isOcr);

            rows.push({
              name,
              value: val,
              unit,
              referenceRange: rangeStr,
              sourceLine: i + 1,
              sourceText: `${line} ${valueStr} ${lRest}`,
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
  }
  return rows;
}

function explanation(row, language) {
  if (row.needsReview || row.status === "review") return { sourceLine: row.sourceLine, en: "This value needs your review before an explanation can be provided.", ur: "وضاحت سے پہلے اس قدر کی جانچ ضروری ہے۔" };
  const statuses = { en: { below: "below", above: "above", within: "within" }, ur: { below: "حد سے کم", above: "حد سے زیادہ", within: "حد کے اندر" } };
  return {
    sourceLine: row.sourceLine,
    en: language === "ur" ? null : `${row.name} is ${row.value} ${row.unit}, which is ${statuses.en[row.status]} the reference range printed on your report (${row.referenceRange}). This result alone does not diagnose a condition. Ask your healthcare professional if you have questions.`,
    ur: language === "en" ? null : `${row.name} کی قدر ${row.value} ${row.unit} ہے، جو آپ کی رپورٹ پر درج عام حد (${row.referenceRange}) ${statuses.ur[row.status]} ہے۔ یہ نتیجہ اکیلے کسی بیماری کی تشخیص نہیں کرتا۔ سوالات کے لیے اپنے ڈاکٹر سے بات کریں۔`
  };
}
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
