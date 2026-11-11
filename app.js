const state = {
  page: location.hash.slice(1) || "home",
  language: localStorage.getItem("report-explainer-language") || "en",
  explanationLanguage: "en",
  translations: { en: {}, ur: {} },
  report: null,
  reports: [],
  selectedFile: null,
  ocrText: "",
  results: [],
  selectedResult: 0,
  editingResult: null,
  processingStep: 1,
  processingToken: 0
};

const flowPages = ["ocr", "data", "explanation", "source"];
const pageHeadings = {
  ocr: ["ocr.title", "ocr.lede"],
  data: ["data.title", "data.lede"],
  explanation: ["explanation.title", "explanation.lede"],
  source: ["source.title", "source.lede"],
  summary: ["summary.title", "summary.lede"]
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function text(key, values = {}) {
  let value = state.translations[state.language]?.[key] || state.translations.en?.[key] || key;
  for (const [name, replacement] of Object.entries(values)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return escapeHtml(value);
}

function navigate(page) {
  if (!page) return;
  state.page = page;
  history.pushState({ page }, "", `#${page}`);
  render();
  window.scrollTo(0, 0);
}

function header() {
  const simple = state.page === "login";
  return `
    <header class="topbar">
      <a class="brand" href="#home" data-page="home" aria-label="${text("brand.title")}">
        <span class="brand-mark" aria-hidden="true">+</span>
        <span class="brand-copy">
          <span class="brand-title">${text("brand.title")}</span>
          <span class="brand-subtitle">${text("brand.subtitle")}</span>
        </span>
      </a>
      ${simple ? "" : `
        <nav class="main-nav" aria-label="${text("nav.home")}">
          <a href="#home" data-page="home" class="${state.page === "home" ? "active" : ""}">${text("nav.home")}</a>
          <a href="#how" data-page="how" class="${state.page === "how" ? "active" : ""}">${text("nav.how")}</a>
          <a href="#privacy" data-page="privacy" class="${state.page === "privacy" ? "active" : ""}">${text("nav.privacy")}</a>
          <a href="#history" data-page="history" class="${state.page === "history" ? "active" : ""}">${text("nav.history")}</a>
        </nav>
      `}
      <div class="header-actions">
        <div class="lang-switch" aria-label="${text("explanation.language")}">
          <button type="button" data-language="en" aria-pressed="${state.language === "en"}">${text("language.english")}</button>
          <button type="button" data-language="ur" aria-pressed="${state.language === "ur"}">${text("language.urdu")}</button>
        </div>
        ${simple ? "" : state.report
          ? `<a class="button primary small" href="#upload" data-page="upload">${text("nav.upload")}</a>`
          : `<a class="button ghost small" href="#login" data-page="login">${text("nav.login")}</a>`}
      </div>
    </header>`;
}

function stepbar() {
  if (!flowPages.includes(state.page)) return "";
  const current = flowPages.indexOf(state.page);
  return `
    <nav class="stepbar" aria-label="${text("how.title")}">
      ${flowPages.map((page, index) => {
        const label = text(`${page}.title`);
        const status = index < current ? "done" : index === current ? "current" : "";
        return `<a class="step-link ${status}" href="#${page}" data-page="${page}" aria-current="${index === current ? "step" : "false"}">
          <span class="step-circle">${index < current ? "✓" : index + 1}</span>${label}
        </a>`;
      }).join("")}
      ${state.report ? `<span class="meta-pill">${escapeHtml(state.report.fileName)}</span>` : ""}
    </nav>`;
}

function pageShell(headingKey, ledeKey, content, options = {}) {
  const heading = text(headingKey, options.values);
  const lede = text(ledeKey, options.values);
  return `<main class="page ${options.narrow ? "narrow" : ""}">
    ${options.eyebrow ? `<span class="eyebrow">${text(options.eyebrow)}</span>` : ""}
    <div class="page-heading-row"><div><h1 class="page-title">${heading}</h1><p class="page-lede">${lede}</p></div>${options.actions || ""}</div>
    ${content}
  </main>`;
}

function homePage() {
  return `
    <main class="page">
      <section class="home-hero">
        <div class="home-hero-content">
          <h1 aria-label="${text("home.title.line1")} ${text("home.title.line2")}">
            <span>${text("home.title.line1")}</span>
            <span>${text("home.title.line2")}</span>
          </h1>
          <p>${text("home.lede")}</p>
          <div class="home-hero-actions">
            <button class="button home-upload-button" type="button" data-action="home-upload">
              <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M8 10V2m0 0L5 5m3-3 3 3M2.5 9.5v4h11v-4" />
              </svg>${text("home.upload")}
            </button>
            <a class="button" href="#how" data-page="how">${text("home.how")}</a>
          </div>
        </div>
        <input class="sr-only" id="homeReportFile" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png">
      </section>
      <section class="card-grid" aria-label="${text("home.title.line1")} ${text("home.title.line2")}">
        ${[
          ["ocr", "home.ocr", "home.ocr.desc"],
          ["data", "home.extract", "home.extract.desc"],
          ["explain", "home.explain", "home.explain.desc"],
          ["source", "home.source", "home.source.desc"]
        ].map(([icon, title, description]) => `
          <article class="panel feature-card"><span class="home-feature-icon home-feature-icon-${icon}" aria-hidden="true">
            ${icon === "ocr" ? `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 16V10a2 2 0 0 1 2-2h6M32 8h6a2 2 0 0 1 2 2v6M40 32v6a2 2 0 0 1-2 2h-6M16 40h-6a2 2 0 0 1-2-2v-6"/><rect x="15" y="13" width="18" height="22" rx="2.5"/><path d="M19 20h10M19 25h10M19 30h6"/></svg>` : ""}
            ${icon === "data" ? `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="10" width="34" height="28" rx="4"/><rect x="8" y="19" width="32" height="6.5" rx="1" fill="#0b7a6c" stroke="none"/><path d="M7 19h34M7 26h34M7 32h34M20 19v19"/></svg>` : ""}
            ${icon === "explain" ? `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12a4 4 0 0 1 4-4h22a4 4 0 0 1 4 4v15a4 4 0 0 1-4 4H23l-9 7v-7h-1a4 4 0 0 1-4-4z"/><path d="M16 16h16M16 22h9"/></svg>` : ""}
            ${icon === "source" ? `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="6" width="25" height="33" rx="3"/><path d="M13 14h15M13 20h15"/><rect x="12" y="24.5" width="17" height="5.5" rx="1.5" fill="#0e8fa8" stroke="none"/><circle cx="34" cy="35" r="9" fill="#0e8fa8" stroke="white" stroke-width="2"/><path d="M32.1 36.9l-1.2 1.2a2.1 2.1 0 0 1-3-3l3-3a2.1 2.1 0 0 1 3 0M35.9 33.1l1.2-1.2a2.1 2.1 0 0 1 3 3l-3 3a2.1 2.1 0 0 1-3 0M31.8 35h4.4"/></svg>` : ""}
          </span>
            <h3>${text(title)}</h3><p>${text(description)}</p>
          </article>`).join("")}
      </section>
      <section class="privacy-strip" aria-label="${text("nav.privacy")}">
        <div>✓ ${text("home.safe1")}</div><div>✓ ${text("home.safe2")}</div><div>✓ ${text("home.safe3")}</div>
      </section>
    </main>`;
}

function howPage() {
  const steps = [
    ["how.step1", "how.desc1"], ["how.step2", "how.desc2"],
    ["how.step3", "how.desc3"], ["how.step4", "how.desc4"]
  ];
  return pageShell("how.title", "how.lede", `
    <section class="how-grid">
      ${steps.map(([title, description], index) => `<article class="panel how-card">
        <span class="number">${index + 1}</span><h2>${text(title)}</h2><p class="muted">${text(description)}</p>
      </article>`).join("")}
    </section>
    <div class="page-actions end"><a class="button primary" href="#upload" data-page="upload">${text("how.cta")}</a></div>
  `);
}

function loginPage() {
  return `
    <main class="login-layout">
      <section class="login-panel">
        <h1>${text("login.title")}</h1>
        <p class="page-lede">${text("login.lede")}</p>
        <form class="form" data-form="login">
          <div class="field"><label for="email">${text("login.email")}</label><input id="email" type="email" placeholder="name@example.com" autocomplete="email" required></div>
          <div class="field"><label for="password">${text("login.password")}</label><input id="password" type="password" placeholder="At least 8 characters" autocomplete="current-password" required></div>
          <div class="form-meta"><label class="inline-check"><input type="checkbox">${text("login.remember")}</label><a href="#forgot" data-page="forgot">${text("login.forgot")}</a></div>
          <button class="button primary full" type="submit">${text("login.submit")}</button>
          <button class="button full" type="button" data-page="home">${text("login.guest")}</button>
          <p class="muted">${text("login.new")} <a href="#account" data-page="account">${text("login.create")}</a></p>
          <button class="button full" type="button" data-action="unavailable-account">${text("login.google")}</button>
        </form>
      </section>
      <aside class="login-hero">
        <span class="brand-mark" aria-hidden="true">+</span><h2>${text("login.hero")}</h2>
        <ul><li>${text("login.bullet1")}</li><li>${text("login.bullet2")}</li><li>${text("login.bullet3")}</li></ul>
      </aside>
    </main>`;
}

function accountPage() {
  return pageShell("account.title", "account.lede", `
    <div class="panel panel-body">
      <p class="muted">${text("account.lede")}</p>
      <a class="button primary" href="#home" data-page="home">${text("account.guest")}</a>
    </div>`, { narrow: true });
}

function forgotPage() {
  return pageShell("forgot.title", "forgot.lede", `
    <div class="panel panel-body">
      <a class="button primary" href="#home" data-page="home">${text("login.guest")}</a>
      <a class="button" href="#login" data-page="login">${text("forgot.back")}</a>
    </div>`, { narrow: true });
}

function privacyPage() {
  const questions = [
    ["faq.files.q", "faq.files.a"], ["faq.unclear.q", "faq.unclear.a"],
    ["faq.language.q", "faq.language.a"], ["faq.review.q", "faq.review.a"],
    ["faq.doctor.q", "faq.doctor.a"], ["faq.support.q", "faq.support.a"],
    ["faq.password.q", "faq.password.a"]
  ];
  return pageShell("privacy.title", "privacy.lede", `
    <section class="faq-grid">
      <div>
        <h2>${text("faq.title")}</h2>
        <div class="faq-list">
          ${questions.map(([question, answer]) => `<details class="faq">
            <summary>${text(question)}</summary><p>${text(answer)}</p>
          </details>`).join("")}
        </div>
      </div>
      <aside class="privacy-cards">
        <article class="panel info-card"><span class="feature-icon">◇</span><h3>${text("privacy.storageTitle")}</h3><p>${text("privacy.storage")}</p></article>
        <article class="panel info-card"><span class="feature-icon">◷</span><h3>${text("privacy.durationTitle")}</h3><p>${text("privacy.duration")}</p></article>
        <article class="panel info-card"><span class="feature-icon">!</span><h3>${text("privacy.accessTitle")}</h3><p>${text("privacy.access")}</p></article>
        <article class="panel info-card"><span class="feature-icon">×</span><h3>${text("privacy.deleteTitle")}</h3><p>${text("privacy.delete")}</p></article>
      </aside>
    </section>`);
}

function uploadPage() {
  const file = state.selectedFile;
  const error = state.uploadError ? `<div class="form-error visible" role="alert">${state.uploadError}</div>` : "";
  return pageShell("upload.title", "upload.lede", `
    <div class="panel panel-body">
      <label class="upload-box" id="dropArea" for="reportFile">
        <span><span class="upload-icon" aria-hidden="true">⇧</span><br>
          <strong>${text("upload.drop")}</strong><br>
          <span class="file-meta">${text("upload.types")}</span>
          <span class="file-meta" id="selectedFileName">${file ? escapeHtml(file.name) : ""}</span>
        </span>
        <input class="sr-only" id="reportFile" name="report" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg">
      </label>
      ${error}
      <p class="muted">${text("upload.privacy")}</p>
      <div class="page-actions end"><button class="button primary" type="button" data-action="process-upload" ${file ? "" : "disabled"}>${text("upload.start")}</button></div>
    </div>
  `, { narrow: true });
}

function processingPage() {
  const labels = ["processing.ocr", "processing.extract", "processing.explain", "processing.source"];
  return pageShell("processing.title", "processing.wait", `
    <section class="processing-grid">
      <article class="panel panel-body">
        <div class="page-heading-row"><h2>${text("processing.title")}</h2><span class="muted">${escapeHtml(state.report?.fileName || "")}</span></div>
        <div class="progress-track"><div class="progress-bar" style="width:${Math.max(8, state.processingStep * 25)}%"></div></div>
        <p class="muted">${text("processing.step", { current: state.processingStep })}</p>
        <ol class="processing-steps">
          ${labels.map((key, index) => `<li class="${index + 1 < state.processingStep ? "done" : index + 1 === state.processingStep ? "active" : ""}">
            <span class="step-state">${index + 1 < state.processingStep ? "✓" : index + 1}</span>${text(key)}
          </li>`).join("")}
        </ol>
      </article>
      <aside class="panel panel-body"><h2>${text("processing.wait")}</h2>
        <p>${escapeHtml(state.report?.fileName || "")}</p>
        <button class="button" type="button" data-action="cancel-processing">${text("processing.cancel")}</button>
      </aside>
    </section>`);
}

function reportPreview() {
  if (!state.report?.id) return `<div class="empty-state">${text("ocr.empty")}</div>`;
  const url = `/api/reports/${encodeURIComponent(state.report.id)}/file`;
  if (state.report.mimeType === "application/pdf") {
    return `<iframe title="${text("ocr.original")}" src="${url}"></iframe>`;
  }
  return `<img src="${url}" alt="${escapeHtml(state.report.fileName)}">`;
}

function ocrPage() {
  const lines = state.ocrText.split(/\r?\n/);
  return pageShell("ocr.title", "ocr.lede", `
    <div class="result-stats">
      <span class="pill">${text("ocr.original")}: ${escapeHtml(state.report?.fileName || "")}</span>
      <span class="pill">${escapeHtml(state.report?.mimeType || "")}</span>
      <span class="pill green">${lines.length} ${text("common.tests")}</span>
    </div>
    <section class="report-view">
      <div><h2>${text("ocr.original")}</h2><div class="panel document-preview">${reportPreview()}</div></div>
      <div><h2>${text("ocr.extracted")}</h2><div class="panel ocr-lines">
        ${lines.map((line, index) => `<div class="ocr-line" data-ocr-line="${index + 1}"><span class="muted">${index + 1}</span> ${escapeHtml(line) || "&nbsp;"}</div>`).join("")}
      </div></div>
    </section>
    <div class="page-actions"><a class="button" href="#upload" data-page="upload">${text("ocr.back")}</a>
      <a class="button primary" href="#data" data-page="data">${text("ocr.next")}</a></div>
  `);
}

function statusPill(status) {
  const keys = { within: "status.within", below: "status.below", above: "status.above", review: "status.review" };
  return `<span class="status ${escapeHtml(status || "review")}">${text(keys[status] || "common.unknown")}</span>`;
}

function dataPage() {
  const counts = state.results.reduce((total, row) => {
    total[row.status] = (total[row.status] || 0) + 1;
    return total;
  }, {});
  return pageShell("data.title", "data.lede", `
    <div class="result-stats">
      <span class="pill">${state.results.length} ${text("common.tests")}</span>
      <span class="pill green">${counts.within || 0} ${text("data.clear")}</span>
      <span class="pill purple">${counts.review || 0} ${text("data.review")}</span>
    </div>
    ${state.results.length ? `<div class="table-wrap"><table>
      <thead><tr><th>${text("data.test")}</th><th>${text("data.value")}</th><th>${text("data.unit")}</th><th>${text("data.range")}</th><th>${text("data.status")}</th></tr></thead>
      <tbody>${state.results.map((row, index) => `<tr class="result-row ${row.status === "review" ? "review" : ""}">
        <td>${escapeHtml(row.name)}</td>
        <td>${state.editingResult === index ? `<form class="edit-form" data-form="edit-result" data-index="${index}">
          <input aria-label="${text("data.value")} ${escapeHtml(row.name)}" name="value" value="${escapeHtml(row.value ?? "")}" required>
          <button class="button primary small" type="submit">${text("data.correct")}</button>
          <button class="button small" type="button" data-action="cancel-edit">${text("common.cancel")}</button>
        </form>` : `<span>${escapeHtml(row.value ?? text("common.unknown"))}</span>
          <button class="button small" type="button" data-edit-index="${index}">${text("data.correct")}</button>`}</td>
        <td>${escapeHtml(row.unit)}</td><td>${escapeHtml(row.referenceRange)}</td><td>${statusPill(row.status)}</td>
      </tr>`).join("")}</tbody>
    </table></div>` : `<div class="empty-state">${text("data.none")}</div>`}
    ${state.results.some((row) => row.status === "review") ? `<div class="summary-note">${text("faq.unclear.a")}</div>` : ""}
    <div class="page-actions"><a class="button" href="#ocr" data-page="ocr">${text("data.back")}</a>
      <a class="button primary" href="#explanation" data-page="explanation">${text("data.next")}</a></div>
  `);
}

function explanationPage() {
  const langButtons = ["en", "ur", "both"].map((language) => {
    const label = language === "en" ? text("language.english") : language === "ur" ? text("language.urdu") : text("language.both");
    return `<button type="button" data-explanation-language="${language}" aria-pressed="${state.explanationLanguage === language}">${label}</button>`;
  }).join("");
  const cards = state.results.map((row, index) => {
    const explanation = row.needsReview || row.status === "review"
      ? text("explanation.review")
      : `${escapeHtml(row.name)}: ${escapeHtml(row.value)} ${escapeHtml(row.unit)} — ${escapeHtml(row.status)} (${escapeHtml(row.referenceRange)}). ${text("source.disclaimer")}`;
    const urExplanation = row.needsReview || row.status === "review"
      ? text("explanation.review")
      : `${escapeHtml(row.name)}: ${escapeHtml(row.value)} ${escapeHtml(row.unit)} — ${escapeHtml(row.referenceRange)}۔ ${text("source.disclaimer")}`;
    return `<article class="panel explanation-card">
      <h3>${escapeHtml(row.name)} ${statusPill(row.status)}</h3>
      <p>${text("data.value")}: <strong>${escapeHtml(row.value ?? text("common.unknown"))} ${escapeHtml(row.unit)}</strong>
        &nbsp; ${text("data.range")}: <strong>${escapeHtml(row.referenceRange)}</strong></p>
      <p>${explanation}</p>
      ${state.explanationLanguage !== "en" ? `<p class="urdu-copy" lang="ur" dir="rtl">${urExplanation}</p>` : ""}
      <a class="source-link" href="#source" data-source-index="${index}">${text("common.source")} →</a>
    </article>`;
  }).join("");
  return pageShell("explanation.title", "explanation.lede", `
    <div class="page-heading-row"><span></span><div class="lang-switch" aria-label="${text("explanation.language")}">${langButtons}</div></div>
    <section class="explanation-grid">${cards || `<div class="empty-state">${text("data.none")}</div>`}</section>
    <div class="page-actions"><a class="button" href="#data" data-page="data">${text("explanation.back")}</a>
      <a class="button primary" href="#source" data-page="source">${text("explanation.next")}</a></div>
  `);
}

function sourcePage() {
  const row = state.results[state.selectedResult] || state.results[0];
  const selectedLine = row?.sourceLine || 1;
  const line = state.ocrText.split(/\r?\n/)[selectedLine - 1] || "";
  return pageShell("source.title", "source.lede", `
    <section class="source-grid">
      <nav class="panel test-list" aria-label="${text("data.test")}">
        ${state.results.map((item, index) => `<button class="test-select" type="button" data-source-index="${index}" aria-current="${index === state.selectedResult}">
          <span>${escapeHtml(item.name)}</span><span>${escapeHtml(item.value ?? "")}</span>
        </button>`).join("")}
      </nav>
      <article class="panel explanation-card">
        <div class="page-heading-row"><h2>${escapeHtml(row?.name || text("source.noLine"))}</h2>${row ? statusPill(row.status) : ""}</div>
        ${row ? `<p>${escapeHtml(row.value ?? text("common.unknown"))} ${escapeHtml(row.unit)} · ${escapeHtml(row.referenceRange)}</p>` : ""}
        <div class="summary-note"><strong>${text("source.checks")}</strong><p>${text("source.check.value")}</p><p>${text("source.check.range")}</p></div>
        <p>${text("source.disclaimer")}</p>
      </article>
      <div>
        <div class="page-heading-row"><h2>${text("source.original")}</h2><span class="pill">${text("source.pageLine", { line: selectedLine })}</span></div>
        <div class="panel source-document">
          ${line ? `<p class="source-highlight"><strong>${selectedLine}.</strong> ${escapeHtml(line)}</p>` : `<p>${text("source.noLine")}</p>`}
          <a class="source-link" href="/api/reports/${encodeURIComponent(state.report?.id || "")}/file" target="_blank" rel="noreferrer">${text("source.original")} ↗</a>
        </div>
        <div class="panel document-preview">${reportPreview()}</div>
      </div>
    </section>
    <div class="page-actions"><a class="button" href="#explanation" data-page="explanation">${text("source.back")}</a>
      <a class="button primary" href="#summary" data-page="summary">${text("source.next")}</a></div>
  `);
}

function summaryPage() {
  const counts = state.results.reduce((total, row) => {
    total[row.status] = (total[row.status] || 0) + 1;
    return total;
  }, {});
  const total = state.results.length || 1;
  const within = Math.round(((counts.within || 0) / total) * 100);
  const outside = Math.round((((counts.below || 0) + (counts.above || 0)) / total) * 100);
  const stops = `conic-gradient(var(--green) 0 ${within}%, #df9200 ${within}% ${within + outside}%, #8364c4 ${within + outside}% 100%)`;
  return pageShell("summary.title", "summary.lede", `
    <section class="summary-layout">
      <article class="panel chart-panel">
        <div class="donut" style="background:${stops}"><span>${state.results.length}</span></div>
        <div class="legend">
          <span>● ${text("summary.within", { count: counts.within || 0 })}</span>
          <span>● ${text("summary.outside", { count: (counts.below || 0) + (counts.above || 0) })}</span>
          <span>● ${text("summary.review", { count: counts.review || 0 })}</span>
        </div>
      </article>
      <div>
        <div class="table-wrap"><table><tbody>${state.results.map((row) => `<tr>
          <td><strong>${escapeHtml(row.name)}</strong></td><td>${escapeHtml(row.value ?? text("common.unknown"))} ${escapeHtml(row.unit)}</td>
          <td>${escapeHtml(row.referenceRange)}</td><td>${statusPill(row.status)}</td>
        </tr>`).join("")}</tbody></table></div>
        <div class="summary-note"><strong>${text("summary.nextStep")}</strong>: ${text("summary.advice")}</div>
      </div>
    </section>
    <section class="panel download-panel" aria-label="${text("summary.downloads")}">
      <h2>${text("summary.downloads")}</h2>
      <p class="muted">${escapeHtml(state.report?.fileName || "")}</p>
      <div class="download-actions">
        <a class="button primary" href="/api/reports/${encodeURIComponent(state.report?.id || "")}/download.pdf" download>${text("summary.downloadPdf")}</a>
        <a class="button" href="/api/reports/${encodeURIComponent(state.report?.id || "")}/download.csv" download>${text("summary.downloadCsv")}</a>
      </div>
    </section>
    <div class="page-actions">
      <a class="button" href="#source" data-page="source">${text("summary.back")}</a>
      <div class="header-actions">
        <button class="button" type="button" data-action="delete-report">${text("common.delete")}</button>
        <a class="button primary" href="#upload" data-page="upload">${text("summary.startOver")}</a>
      </div>
    </div>
  `);
}

function formatHistoryDate(value, options) {
  const date = new Date(`${String(value).replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return new Intl.DateTimeFormat(state.language === "ur" ? "ur-PK" : "en-US", options).format(date);
}

function historyPage() {
  const statusLabels = {
    uploaded: "history.statusUploaded",
    processing: "history.statusProcessing",
    completed: "history.statusCompleted",
    failed: "history.statusFailed"
  };
  const rows = state.reports.map((report) => `
    <tr data-report-id="${escapeHtml(report.id)}">
      <td><strong>${escapeHtml(report.fileName)}</strong></td>
      <td>${formatHistoryDate(report.createdAt, { dateStyle: "medium", timeZone: "UTC" })}</td>
      <td>${formatHistoryDate(report.createdAt, { timeStyle: "short", timeZone: "UTC" })} UTC</td>
      <td><span class="status ${report.status === "completed" ? "within" : report.status === "failed" ? "review" : ""}">${text(statusLabels[report.status] || "history.statusUploaded")}</span></td>
      <td class="history-actions">
        <button class="button small" type="button" data-open-report="${escapeHtml(report.id)}">${text("history.open")}</button>
        <a class="button small" href="/api/reports/${encodeURIComponent(report.id)}/download.pdf" download>${text("summary.downloadPdf")}</a>
        <a class="button small" href="/api/reports/${encodeURIComponent(report.id)}/download.csv" download>${text("summary.downloadCsv")}</a>
      </td>
    </tr>`).join("");
  return pageShell("history.title", "history.lede", state.reports.length ? `
    <div class="table-wrap history-table"><table>
      <thead><tr><th>${text("history.file")}</th><th>${text("history.date")}</th><th>${text("history.time")}</th><th>${text("history.status")}</th><th>${text("history.actions")}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>` : `<div class="empty-state">${text("history.empty")}</div>`);
}

function render() {
  document.documentElement.lang = state.language;
  document.documentElement.dir = state.language === "ur" ? "rtl" : "ltr";
  document.body.innerHTML = `${header()}${stepbar()}<div id="view">
    ${({
      home: homePage, how: howPage, login: loginPage, account: accountPage, forgot: forgotPage,
      privacy: privacyPage, upload: uploadPage, processing: processingPage, ocr: ocrPage,
      data: dataPage, explanation: explanationPage, source: sourcePage, summary: summaryPage, history: historyPage
    }[state.page] || homePage)()}
  </div><div id="toast" class="toast" role="status" aria-live="polite"></div>`;
}

function showNotice(message, isError = false) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  toast.setAttribute("data-error", String(isError));
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => toast.classList.remove("visible"), 8000);
}

const errorText = {
  server_unreachable: [
    "The report server is not reachable. Check that it is running and open this app at its HTTP URL.",
    "رپورٹ سرور تک رسائی نہیں ہو رہی۔ دیکھیں کہ سرور چل رہا ہے اور ایپ HTTP لنک سے کھولیں۔"
  ],
  storage_full: [
    "The server is out of disk space. Free space on the server drive, then try again.",
    "سرور کی ڈرائیو میں جگہ ختم ہے۔ کچھ جگہ خالی کر کے دوبارہ کوشش کریں۔"
  ],
  storage_unavailable: [
    "The report database cannot be written. Check that the data folder is writable.",
    "رپورٹ ڈیٹابیس میں لکھا نہیں جا سکا۔ دیکھیں کہ data فولڈر قابلِ تحریر ہے۔"
  ],
  database_busy: [
    "The report database is busy. Wait a moment and try again.",
    "رپورٹ ڈیٹابیس مصروف ہے۔ تھوڑی دیر بعد دوبارہ کوشش کریں۔"
  ],
  file_too_large: [
    "The file is larger than 12 MB. Choose a smaller file.",
    "فائل 12 MB سے بڑی ہے۔ چھوٹی فائل منتخب کریں۔"
  ],
  unsupported_file_type: [
    "File type not supported. Choose a PDF, PNG, or JPEG report.",
    "فائل کی قسم قابلِ قبول نہیں۔ PDF، PNG یا JPEG رپورٹ منتخب کریں۔"
  ],
  upload_field_missing: [
    "No report file was attached. Choose a file and try again.",
    "رپورٹ فائل منسلک نہیں ہوئی۔ فائل منتخب کر کے دوبارہ کوشش کریں۔"
  ],
  ocr_engine_unavailable: [
    "OCR engine not found or its English data could not be loaded. Check server setup and network access.",
    "OCR انجن دستیاب نہیں یا اس کا انگریزی ڈیٹا نہیں کھل سکا۔ سرور کی ترتیبات اور نیٹ ورک دیکھیں۔"
  ],
  pdf_read_failed: [
    "The PDF could not be read. Try a valid, text-based PDF or a clear report photo.",
    "PDF نہیں پڑھی جا سکی۔ درست متنی PDF یا رپورٹ کی صاف تصویر آزمائیں۔"
  ],
  no_readable_text: [
    "No readable text was found in the report. Try a clearer, upright photo or a text-based PDF.",
    "رپورٹ میں پڑھنے کے قابل متن نہیں ملا۔ صاف سیدھی تصویر یا متنی PDF آزمائیں۔"
  ],
  unsupported_page: [
    "This screen is not available. Return to Home and try again.",
    "یہ صفحہ دستیاب نہیں۔ صفحۂ اول پر واپس جا کر دوبارہ کوشش کریں۔"
  ]
};

function showError(error) {
  const code = error?.code || "server_error";
  const messages = errorText[code];
  const english = messages?.[0] || error?.message || "The server could not complete the request.";
  const urdu = messages?.[1] || "سرور یہ درخواست مکمل نہیں کر سکا۔";
  console.error("Report Explainer request failed:", error?.stack || error);
  showNotice(`${english} — ${urdu}`, true);
}

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (cause) {
    throw Object.assign(new Error(cause.message || "Network request failed."), { code: "server_unreachable", cause });
  }
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch (cause) {
    throw Object.assign(new Error(`Server returned HTTP ${response.status} with an invalid response: ${raw.slice(0, 180)}`), {
      code: response.status >= 500 ? "server_error" : "invalid_server_response",
      status: response.status, cause
    });
  }
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error || `Request failed with HTTP ${response.status}.`), {
      code: payload?.code || "server_error", status: response.status
    });
  }
  return payload;
}

function setLanguage(language) {
  state.language = language;
  localStorage.setItem("report-explainer-language", language);
  render();
}

function selectFile(file) {
  state.selectedFile = file || null;
  state.uploadError = "";
  render();
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function processUpload() {
  const file = state.selectedFile;
  if (!file) return;
  const token = ++state.processingToken;
  state.processingStep = 1;
  state.page = "processing";
  history.pushState({ page: "processing" }, "", "#processing");
  render();

  try {
    const body = new FormData();
    body.append("report", file);
    state.report = await api("/api/reports", { method: "POST", body });
    if (token !== state.processingToken) {
      await api(`/api/reports/${encodeURIComponent(state.report.id)}`, { method: "DELETE" });
      return;
    }
    state.report.fileUrl = `/api/reports/${encodeURIComponent(state.report.id)}/file`;
    state.processingStep = 2;
    render();

    const processing = api(`/api/reports/${encodeURIComponent(state.report.id)}/process`, { method: "POST" });
    await delay(350);
    state.processingStep = 3;
    render();
    await delay(350);
    state.processingStep = 4;
    render();
    const processed = await processing;
    if (token !== state.processingToken) {
      await api(`/api/reports/${encodeURIComponent(state.report.id)}`, { method: "DELETE" });
      return;
    }
    state.ocrText = processed.ocrText || "";
    state.results = processed.results || [];
    state.report.status = "completed";
    state.selectedResult = 0;
    state.selectedFile = null;
    await delay(150);
    navigate("ocr");
    showNotice(`${text("ocr.title")} · ${escapeHtml(state.report.fileName)}`);
  } catch (error) {
    if (token !== state.processingToken) return;
    state.page = "upload";
    state.report = null;
    render();
    showError(error);
  }
}

async function openHistory() {
  try {
    state.reports = await api("/api/reports");
    navigate("history");
  } catch (error) {
    showError(error);
  }
}

async function openSavedReport(id) {
  try {
    const report = await api(`/api/reports/${encodeURIComponent(id)}`);
    state.report = report;
    state.ocrText = report.ocrText || "";
    state.results = report.results || [];
    state.selectedResult = 0;
    state.editingResult = null;
    navigate(report.status === "completed" ? "summary" : "ocr");
  } catch (error) {
    showError(error);
  }
}

async function saveResult(form) {
  const index = Number(form.dataset.index);
  const value = new FormData(form).get("value");
  try {
    const updated = await api(`/api/reports/${encodeURIComponent(state.report.id)}/results/${index}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value })
    });
    state.results = updated.results;
    state.editingResult = null;
    render();
    showNotice(text("success.saved"));
  } catch (error) {
    showError(error);
  }
}

async function deleteReport() {
  if (!state.report?.id || !window.confirm(text("delete.confirm"))) return;
  try {
    await api(`/api/reports/${encodeURIComponent(state.report.id)}`, { method: "DELETE" });
    state.report = null;
    state.ocrText = "";
    state.results = [];
    state.selectedFile = null;
    navigate("home");
    showNotice(text("success.deleted"));
  } catch (error) {
    showError(error);
  }
}

document.addEventListener("click", (event) => {
  const pageLink = event.target.closest("[data-page]");
  if (pageLink) {
    event.preventDefault();
    if (pageLink.dataset.page === "history") {
      openHistory();
      return;
    }
    if (pageLink.dataset.page === "upload") state.selectedFile = null;
    navigate(pageLink.dataset.page);
    return;
  }

  const savedReport = event.target.closest("[data-open-report]");
  if (savedReport) {
    openSavedReport(savedReport.dataset.openReport);
    return;
  }

  const languageButton = event.target.closest("[data-language]");
  if (languageButton) {
    setLanguage(languageButton.dataset.language);
    return;
  }

  const explanationLanguage = event.target.closest("[data-explanation-language]");
  if (explanationLanguage) {
    state.explanationLanguage = explanationLanguage.dataset.explanationLanguage;
    render();
    return;
  }

  const sourceButton = event.target.closest("[data-source-index]");
  if (sourceButton) {
    state.selectedResult = Number(sourceButton.dataset.sourceIndex);
    if (state.page !== "source") navigate("source");
    else render();
    return;
  }

  const editButton = event.target.closest("[data-edit-index]");
  if (editButton) {
    state.editingResult = Number(editButton.dataset.editIndex);
    render();
    return;
  }

  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "home-upload") {
    document.getElementById("homeReportFile").click();
    return;
  }
  if (action === "process-upload") processUpload();
  if (action === "cancel-edit") {
    state.editingResult = null;
    render();
  }
  if (action === "delete-report") deleteReport();
  if (action === "cancel-processing") {
    const reportId = state.report?.id;
    state.processingToken += 1;
    state.report = null;
    state.selectedFile = null;
    navigate("upload");
    if (reportId) {
      api(`/api/reports/${encodeURIComponent(reportId)}`, { method: "DELETE" }).catch(showError);
    }
  }
  if (action === "unavailable-account") showNotice(text("account.lede"));
});

document.addEventListener("change", (event) => {
  if (event.target.id === "reportFile") selectFile(event.target.files[0]);
  if (event.target.id === "homeReportFile" && event.target.files[0]) {
    const file = event.target.files[0];
    if (!/\.(pdf|jpe?g|png)$/i.test(file.name)) {
      showNotice(text("error.fileType"), true);
      return;
    }
    state.selectedFile = file;
    processUpload();
  }
});

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (form.matches('[data-form="edit-result"]')) {
    event.preventDefault();
    saveResult(form);
  } else if (form.matches('[data-form="login"]')) {
    event.preventDefault();
    showNotice(text("account.lede"));
  }
});

document.addEventListener("dragover", (event) => {
  if (event.target.closest("#dropArea")) {
    event.preventDefault();
    event.target.closest("#dropArea").classList.add("dragover");
  }
});

document.addEventListener("dragleave", (event) => {
  event.target.closest("#dropArea")?.classList.remove("dragover");
});

document.addEventListener("drop", (event) => {
  if (!event.target.closest("#dropArea")) return;
  event.preventDefault();
  selectFile(event.dataTransfer.files[0]);
});

window.addEventListener("popstate", () => {
  state.page = location.hash.slice(1) || "home";
  render();
});

async function start() {
  try {
    const [english, urdu] = await Promise.all([
      fetch("/api/translations/en").then((response) => response.json()),
      fetch("/api/translations/ur").then((response) => response.json())
    ]);
    state.translations = { en: english, ur: urdu };
    if (!["en", "ur"].includes(state.language)) state.language = "en";
    if (!["home", "how", "login", "account", "forgot", "privacy", "upload", "processing", "ocr", "data", "explanation", "source", "summary", "history"].includes(state.page)) {
      state.page = "home";
    }
    if (state.page === "history") state.reports = await api("/api/reports");
    render();
  } catch (error) {
    document.body.innerHTML = `<main class="page"><div class="form-error visible" role="alert">Could not load the app translations. Check that the server is running at this HTTP address. — سرور کی ترجمہ فائلیں نہیں کھل سکیں۔</div></main>`;
    console.error("Could not initialize Report Explainer:", error.stack || error);
  }
}

start();
