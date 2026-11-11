# Report Explainer

Report Explainer converts uploaded lab reports (PDFs, PNG, JPEG) into simple, calm English and Urdu explanations with source line references. Each test is parsed with its numeric value, unit, and printed reference range. Unclear or truncated values are flagged for review without silent changes or diagnoses.

## How to run

### Run locally

Requires Node.js 24 or newer. Chrome or Chromium is used for PDF downloads (auto-detected via Playwright or system install).

```bash
npm ci
npm start
```

Open `http://127.0.0.1:4173`. Image OCR uses the bundled offline English model (`eng.traineddata`) and requires no network access at runtime.

### Run with Docker

```bash
docker build -t report-explainer .
docker run --name report-explainer -p 4173:4173 -v report-explainer-data:/data report-explainer
```

The named volume keeps SQLite data across container restarts. Check `http://localhost:4173/health` for the health endpoint.

## Environment variables

- `NODE_ENV` — set to `production` for a deployment; defaults to local behavior.
- `HOST` — bind address; defaults to `127.0.0.1` locally and `0.0.0.0` in production.
- `PORT` — HTTP port; defaults to `4173`.
- `DATA_DIR` — directory for the default SQLite database; defaults to `./data`.
- `DB_PATH` — full SQLite database path; overrides `DATA_DIR`.
- `CHROME_PATH` — optional custom path to Chrome or Chromium executable; otherwise system / Playwright Chromium is used automatically.
- `CHROME_NO_SANDBOX` — set to `true` when required by the container environment.
- `GUEST_COOKIE_SECRET` — optional secret for HMAC-signed guest session cookies (stored locally in DB if omitted).
- `GUEST_RETENTION_HOURS` — guest report retention in hours before automated cleanup (default `24`).
- `USER_RETENTION_DAYS` — future signed-in user report retention in days (default `7`).

## Deploy

Build and run the Docker image on any container host. Attach persistent storage at `/data`, expose the configured HTTP port through a TLS reverse proxy, and supply production environment variables.
