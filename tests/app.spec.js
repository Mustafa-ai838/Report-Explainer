import { test, expect } from "@playwright/test";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pdfParse from "pdf-parse";

const fixtureDirectory = path.join(os.tmpdir(), `report-explainer-${process.pid}`);
const fixtures = {};
const fixtureNames = Object.fromEntries(
  ["pdf", "png", "jpg"].map((kind) => [kind, `sample-report-${process.pid}.${kind}`])
);
fixtureNames.scannedPdf = `scanned-report-${process.pid}.pdf`;
const reports = {
  pdf: { marker: "PdfMarker", value: "6.7", unit: "mg/dL", range: "5.0 - 8.0" },
  png: { marker: "PngMarker", value: "7.3", unit: "mg/L", range: "3.0 - 9.0" },
  jpg: { marker: "JpgMarker", value: "8.4", unit: "mmol/L", range: "4.0 - 10.0" }
};

async function extractPdfText(pdf) {
  const parsed = await pdfParse(pdf);
  return parsed.text;
}

test.beforeAll(async ({ browser }) => {
  await mkdir(fixtureDirectory, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

  for (const [kind, report] of Object.entries(reports)) {
    await page.setContent(`
      <!doctype html>
      <html><head><style>
        @page { size: A4; margin: 22mm; }
        body { background: white; color: #111; font: 28px Arial, sans-serif; }
        main { padding: 18px; }
        h1 { font-size: 38px; margin: 0 0 26px; }
        p { margin: 22px 0; font-size: 31px; }
      </style></head>
      <body><main>
        <h1>LAB REPORT</h1>
        <p>${report.marker} ${report.value} ${report.unit} ${report.range}</p>
        <p>Hemoglobin 10.2 g/dL 12.0 - 15.5</p>
      </main></body></html>`);

    if (kind === "pdf") {
      await page.pdf({ path: path.join(fixtureDirectory, fixtureNames.pdf), format: "A4" });
    } else {
      await page.screenshot({
        path: path.join(fixtureDirectory, fixtureNames[kind]),
        type: kind === "png" ? "png" : "jpeg",
        quality: kind === "jpg" ? 94 : undefined,
        fullPage: true
      });
    }
    fixtures[kind] = path.join(fixtureDirectory, fixtureNames[kind]);
  }
  const image = await readFile(fixtures.png);
  await page.setContent(`<img alt="" src="data:image/png;base64,${image.toString("base64")}">`);
  fixtures.scannedPdf = path.join(fixtureDirectory, fixtureNames.scannedPdf);
  await page.pdf({ path: fixtures.scannedPdf, format: "A4" });
  await page.close();
});

test.afterAll(async ({ request }) => {
  const historyResponse = await request.get("/api/reports");
  expect(historyResponse.status()).toBe(200);
  const fixtureNameSet = new Set(Object.values(fixtureNames));
  for (const report of await historyResponse.json()) {
    if (!fixtureNameSet.has(report.fileName)) continue;
    const response = await request.delete(`/api/reports/${report.id}`);
    expect(response.status()).toBe(204);
  }
  await rm(fixtureDirectory, { recursive: true, force: true });
});

test("the server provides both translation dictionaries", async ({ request }) => {
  for (const language of ["en", "ur"]) {
    const response = await request.get(`/api/translations/${language}`);
    expect(response.status(), `${language} translation response`).toBe(200);
    const translations = await response.json();
    expect(translations["brand.title"]).toBeTruthy();
    expect(translations["home.title"]).toBeTruthy();
  }
});

test("accepted uploads are immediately saved in persistent History", async ({ request }) => {
  const uploadResponse = await request.post("/api/reports", {
    multipart: {
      report: {
        name: "history-pending.png",
        mimeType: "image/png",
        buffer: await readFile(fixtures.png)
      }
    }
  });
  expect(uploadResponse.status()).toBe(201);
  expect(uploadResponse.headers()["set-cookie"]).toMatch(/HttpOnly; SameSite=Lax/);
  const uploaded = await uploadResponse.json();
  try {
    const historyResponse = await request.get("/api/reports");
    expect(historyResponse.status()).toBe(200);
    expect(await historyResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: uploaded.id,
        fileName: "history-pending.png",
        status: "uploaded",
        createdAt: expect.any(String)
      })
    ]));
  } finally {
    const deleteResponse = await request.delete(`/api/reports/${uploaded.id}`);
    expect(deleteResponse.status()).toBe(204);
  }
});

test("reports are private to the browser guest that uploaded them", async ({ browser }) => {
  const owner = await browser.newContext();
  const otherGuest = await browser.newContext();
  const uploadResponse = await owner.request.post("/api/reports", {
    multipart: {
      report: {
        name: "private-report.png",
        mimeType: "image/png",
        buffer: await readFile(fixtures.png)
      }
    }
  });
  expect(uploadResponse.status()).toBe(201);
  const uploaded = await uploadResponse.json();
  try {
    expect(await (await otherGuest.request.get("/api/reports")).json()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: uploaded.id })])
    );
    expect((await otherGuest.request.get(`/api/reports/${uploaded.id}`)).status()).toBe(404);
    expect((await otherGuest.request.get(`/api/reports/${uploaded.id}/file`)).status()).toBe(404);
    expect((await otherGuest.request.delete(`/api/reports/${uploaded.id}`)).status()).toBe(404);
  } finally {
    expect((await owner.request.delete(`/api/reports/${uploaded.id}`)).status()).toBe(204);
    await owner.close();
    await otherGuest.close();
  }
});

test("the public health endpoint returns ok", async ({ request }) => {
  const response = await request.get("/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("the designed pages, navigation, translations, menus, and accordions work", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Understand your lab report in plain language" })).toBeVisible();
  await page.getByRole("navigation", { name: "Home" }).getByRole("link", { name: "How it works" }).click();
  await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
  await page.getByRole("link", { name: "Upload report" }).click();
  await expect(page.getByRole("heading", { name: "Upload your report" })).toBeVisible();

  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Privacy & Help" }).click();
  await expect(page.getByRole("heading", { name: "Privacy and Help" })).toBeVisible();
  const accordions = page.locator("details.faq");
  await expect(accordions).toHaveCount(7);
  for (let index = 0; index < await accordions.count(); index += 1) {
    const accordion = accordions.nth(index);
    await accordion.locator("summary").click();
    await expect(accordion).toHaveAttribute("open", "");
    await expect(accordion.locator("p")).toBeVisible();
    await accordion.locator("summary").click();
    await expect(accordion).not.toHaveAttribute("open");
  }

  await page.getByRole("button", { name: "اردو" }).first().click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "رازداری اور مدد" })).toBeVisible();
  await page.getByRole("button", { name: "English" }).first().click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("heading", { name: "Privacy and Help" })).toBeVisible();

  await page.getByRole("link", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  await page.getByLabel("Email").fill("guest@example.com");
  await page.getByLabel("Password").fill("report-test-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("status")).toContainText("Accounts will be available soon");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page.getByRole("status")).toContainText("Accounts will be available soon");
  await page.getByRole("button", { name: "اردو" }).first().click();
  await page.getByRole("button", { name: "Google کے ساتھ جاری رکھیں" }).click();
  await expect(page.getByRole("status")).toContainText("اکاؤنٹس جلد دستیاب ہوں گے۔");
  await page.getByRole("button", { name: "English" }).first().click();
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page.getByRole("heading", { name: "Password help" })).toBeVisible();
  await page.getByRole("link", { name: "Back to Log in" }).click();
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
  await expect(page.getByText("Accounts will be available soon").first()).toBeVisible();
  await page.getByRole("link", { name: "Continue as guest" }).click();
  await expect(page.getByRole("heading", { name: "Understand your lab report in plain language" })).toBeVisible();

  await page.goto("/#processing");
  await page.getByRole("button", { name: "Cancel and return" }).click();
  await expect(page.getByRole("heading", { name: "Upload your report" })).toBeVisible();
  await page.getByRole("link", { name: "Report Explainer" }).click();
  await expect(page.getByRole("heading", { name: "Understand your lab report in plain language" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("scanned PDFs show a clear English and Urdu explanation", async ({ page }) => {
  await page.goto("/#upload");
  await page.locator("#reportFile").setInputFiles(fixtures.scannedPdf);
  const uploadResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/reports") && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Process report" }).click();
  const uploaded = await (await uploadResponsePromise).json();
  try {
    await expect(page.getByRole("status")).toContainText(
      "This PDF has no readable text. Please upload a clear photo or screenshot of the report instead."
    );
    await expect(page.getByRole("status")).toContainText(
      "اس PDF میں پڑھنے کے قابل متن نہیں ہے۔ براہِ کرم اس کے بجائے رپورٹ کی صاف تصویر یا اسکرین شاٹ اپ لوڈ کریں۔"
    );
  } finally {
    expect((await page.request.delete(`/api/reports/${uploaded.id}`)).status()).toBe(204);
  }
});

test("upload errors show the actual cause in English and Urdu", async ({ page }) => {
  await page.goto("/#upload");
  await page.locator("#reportFile").setInputFiles({
    name: "unsupported.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a supported report")
  });
  await page.getByRole("button", { name: "Process report" }).click();
  await expect(page.getByRole("status")).toContainText("File type not supported");
  await expect(page.getByRole("status")).toContainText("فائل کی قسم قابلِ قبول نہیں");

  await page.route("**/api/reports", (route) => route.abort());
  await page.locator("#reportFile").setInputFiles({
    name: "network-test.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4")
  });
  await page.getByRole("button", { name: "Process report" }).click();
  await expect(page.getByRole("status")).toContainText("The report server is not reachable");
  await expect(page.getByRole("status")).toContainText("رپورٹ سرور تک رسائی نہیں ہو رہی");
});

for (const kind of ["pdf", "png", "jpg"]) {
  test(`uploads and follows the complete report flow for a real ${kind.toUpperCase()} file`, async ({ page }) => {
    const report = reports[kind];
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/#upload");
    await expect(page.getByRole("heading", { name: "Upload your report" })).toBeVisible();
    await page.locator("#reportFile").setInputFiles(fixtures[kind]);
    await expect(page.locator("#selectedFileName")).toContainText(fixtureNames[kind]);
    const uploadResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/reports") && response.request().method() === "POST"
    );
    const processResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/process") && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Process report" }).click();
    const uploadResponse = await uploadResponsePromise;
    expect(uploadResponse.status()).toBe(201);
    const uploaded = await uploadResponse.json();
    expect(uploaded.mimeType).toBe(kind === "pdf" ? "application/pdf" : kind === "png" ? "image/png" : "image/jpeg");
    await expect(page.locator("h1.page-title")).toHaveText("Working on your report…");

    await expect(page.getByRole("heading", { name: "OCR Text" })).toBeVisible({ timeout: 90_000 });
    const processResponse = await processResponsePromise;
    expect(processResponse.status()).toBe(200);
    const processedReport = await processResponse.json();
    expect(processedReport.ocrText).toContain(report.marker);
    expect(processedReport.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: report.marker, value: Number(report.value) })
    ]));
    await expect(page.locator(".ocr-lines")).toContainText(report.marker);
    await expect(page.locator(".ocr-lines")).toContainText(report.value);

    const markerRow = page.locator("tr.result-row").filter({ hasText: report.marker });
    await page.getByRole("link", { name: "Next: Data Extraction" }).click();
    await expect(page.getByRole("heading", { name: "Data Extraction" })).toBeVisible();
    await expect(page.getByText(report.marker, { exact: true })).toBeVisible();
    await expect(markerRow).toContainText(report.value);

    await page.getByRole("link", { name: "Back: OCR Text" }).click();
    await expect(page.getByRole("heading", { name: "OCR Text" })).toBeVisible();
    await page.getByRole("link", { name: "Next: Data Extraction" }).click();
    await markerRow.getByRole("button", { name: "Correct" }).click();
    const editForm = page.locator('form[data-form="edit-result"]');
    await editForm.getByRole("button", { name: "Cancel" }).click();
    await markerRow.getByRole("button", { name: "Correct" }).click();
    await editForm.locator('input[name="value"]').fill(report.value);
    await editForm.getByRole("button", { name: "Correct" }).click();
    await expect(page.locator("tr.result-row").filter({ hasText: report.marker })).toContainText(report.value);

    await page.getByRole("link", { name: "Next: Explanation" }).click();
    await expect(page.getByRole("heading", { name: "Plain-language Explanation" })).toBeVisible();
    await expect(page.getByText(report.marker, { exact: false }).first()).toBeVisible();
    await page.locator("#view .lang-switch").getByRole("button", { name: "اردو", exact: true }).click();
    await expect(page.locator(".urdu-copy").first()).toBeVisible();
    await expect(page.locator(".english-copy").first()).toBeHidden();
    await page.locator("#view .lang-switch").getByRole("button", { name: "Both" }).click();
    await expect(page.locator(".urdu-copy").first()).toBeVisible();
    await expect(page.locator(".english-copy").first()).toBeVisible();
    await page.locator("#view .lang-switch").getByRole("button", { name: "English", exact: true }).click();
    await expect(page.locator(".urdu-copy")).toHaveCount(0);

    await page.getByRole("link", { name: "Back: Data Extraction" }).click();
    await expect(page.getByRole("heading", { name: "Data Extraction" })).toBeVisible();
    await page.getByRole("link", { name: "Next: Explanation" }).click();
    await page.getByRole("link", { name: "View source line" }).first().click();
    await expect(page.getByRole("heading", { name: "Source Link" })).toBeVisible();
    await expect(page.locator(".source-highlight")).toContainText(report.marker);
    const [openedReport] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByRole("link", { name: "Original report" }).click()
    ]);
    await openedReport.waitForLoadState();
    expect(openedReport.url()).toContain("/api/reports/");
    await openedReport.close();
    const sourceChoices = page.locator(".test-select");
    await expect(sourceChoices).toHaveCount(2);
    await sourceChoices.nth(1).click();
    await expect(page.locator(".source-highlight")).toContainText("Hemoglobin");
    await page.getByRole("link", { name: "Back: Explanation" }).click();
    await expect(page.getByRole("heading", { name: "Plain-language Explanation" })).toBeVisible();
    await page.getByRole("link", { name: "Next: Source Link" }).click();

    for (const [label, heading] of [
      ["OCR Text", "OCR Text"],
      ["Data Extraction", "Data Extraction"],
      ["Explanation", "Plain-language Explanation"],
      ["Source Link", "Source Link"]
    ]) {
      await page.locator(".stepbar").getByRole("link", { name: new RegExp(label) }).click();
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }

    await page.getByRole("link", { name: "Next: Summary" }).click();
    await expect(page.getByRole("heading", { name: "Results Summary" })).toBeVisible();
    const summaryRow = page.getByRole("row").filter({ hasText: report.marker });
    await expect(summaryRow).toContainText(report.value);
    await expect(summaryRow).toContainText(report.range);

    const [summaryPdfDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Download PDF" }).click()
    ]);
    expect(summaryPdfDownload.suggestedFilename()).toBe(`sample-report-${process.pid}-report.pdf`);
    const summaryPdf = await readFile(await summaryPdfDownload.path());
    const summaryPdfText = await extractPdfText(summaryPdf);
    expect(summaryPdfText).toContain(report.marker);
    expect(summaryPdfText).not.toContain("Report Explainer build");
    const [summaryCsvDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Download CSV" }).click()
    ]);
    expect(summaryCsvDownload.suggestedFilename()).toBe(`sample-report-${process.pid}-report.csv`);
    const summaryCsv = await readFile(await summaryCsvDownload.path());
    expect(summaryCsv.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const summaryCsvText = summaryCsv.toString("utf8");
    expect(summaryCsvText).toContain(report.marker);
    expect(summaryCsvText).toContain(report.value);
    expect(summaryCsvText).toContain(report.range);

    await page.getByRole("link", { name: "Back: Source Link" }).click();
    await page.getByRole("link", { name: "Next: Summary" }).click();

    const pageUrl = new URL(page.url());
    const savedResponse = await page.request.get(`/api/reports/${uploaded.id}`);
    expect(savedResponse.status()).toBe(200);
    const savedReport = await savedResponse.json();
    expect(savedReport.fileName).toBe(fixtureNames[kind]);
    expect(savedReport.ocrText).toContain(report.marker);
    expect(savedReport.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: report.marker, value: Number(report.value) })
    ]));
    expect(savedReport.status).toBe("completed");
    const originalFileResponse = await page.request.get(`/api/reports/${uploaded.id}/file`);
    expect(originalFileResponse.status()).toBe(200);
    expect(await originalFileResponse.body()).toEqual(await readFile(fixtures[kind]));
    const historyResponse = await page.request.get("/api/reports");
    expect(historyResponse.status()).toBe(200);
    expect(await historyResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: uploaded.id,
        fileName: fixtureNames[kind],
        status: "completed",
        createdAt: expect.any(String)
      })
    ]));
    expect(pageUrl.origin).toBe("http://127.0.0.1:4173");

    await page.getByRole("link", { name: "History", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Report History" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Report History" })).toBeVisible();
    const historyRow = page.locator(`tr[data-report-id="${uploaded.id}"]`);
    await expect(historyRow).toContainText("Complete");
    await expect(historyRow.locator("td").nth(1)).not.toBeEmpty();
    await expect(historyRow.locator("td").nth(2)).toContainText("UTC");

    const [historyPdfDownload] = await Promise.all([
      page.waitForEvent("download"),
      historyRow.getByRole("link", { name: "Download PDF" }).click()
    ]);
    expect(await extractPdfText(await readFile(await historyPdfDownload.path()))).toContain(report.marker);
    const [historyCsvDownload] = await Promise.all([
      page.waitForEvent("download"),
      historyRow.getByRole("link", { name: "Download CSV" }).click()
    ]);
    const historyCsv = await readFile(await historyCsvDownload.path(), "utf8");
    expect(historyCsv).toContain(report.marker);
    expect(historyCsv).toContain(report.value);
    await historyRow.getByRole("button", { name: "Open report" }).click();
    await expect(page.getByRole("heading", { name: "Results Summary" })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: report.marker })).toContainText(report.value);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete report" }).click();
    await expect(page.getByRole("heading", { name: "Understand your lab report in plain language" })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
}
