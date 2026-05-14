# QuizMorph user guide

QuizMorph turns an **exam PDF** into a **Google Forms quiz** in **your** Google account, with optional help from **Quilgo** for a timed exam. Processing uses **Ollama** (AI) and **PyMuPDF** (text from PDF pages).

---

## What you need installed

| Requirement | Why |
|-------------|-----|
| **Node.js 20+** and **npm** | Run the web app, API, and worker |
| **Docker** (recommended) | **PostgreSQL** and **Redis** (`docker compose`) |
| **Python 3** + **`python3-venv`** | Worker uses a **venv** for PyMuPDF (PEP 668 on Ubuntu) |
| **Ollama** + a **vision model** (e.g. `qwen2.5vl:7b`) | AI extraction per PDF page |
| **Google Cloud OAuth client** | Sign-in and **creating forms in your Drive** |

---

## One-time setup

### 1. Clone and install

```bash
cd QuizMorph
npm install
```

### 2. Environment file

Copy the example and edit values:

```bash
cp .env.example .env
```

At minimum set:

- **`DATABASE_URL`** – matches your Postgres (default in `.env.example` matches `docker-compose.yml`).
- **`REDIS_URL`** – default `redis://localhost:6379` is fine with compose.
- **`GOOGLE_CLIENT_ID`** and **`GOOGLE_CLIENT_SECRET`** – from [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → OAuth 2.0 Client ID (Web application).
- **`GOOGLE_CALLBACK_URL`** – must be exactly  
  `http://localhost:3001/auth/google/callback`  
  and listed under **Authorized redirect URIs** for that client.
- **`FRONTEND_URL`** – `http://localhost:3000` for local dev.
- **`JWT_SECRET`** – any long random string for API-issued session tokens.
- **`NEXT_PUBLIC_API_URL`** – `http://localhost:3001` so the browser talks to the API.

In **OAuth consent screen**, add scopes for **email**, **profile**,  
`https://www.googleapis.com/auth/forms.body` (create/edit forms), and  
`https://www.googleapis.com/auth/drive.file` (upload files the app creates to your Drive, e.g. images for form questions).  
so QuizMorph can create quizzes in **your** Google Drive.

### 3. Database

Start Postgres and Redis:

```bash
docker compose up -d
```

Apply the schema (from repo root; loads root `.env`):

```bash
npm run db:push
```

### 4. Worker Python environment (Linux / PEP 668)

```bash
sudo apt install python3-venv   # if `python3 -m venv` fails
npm run worker:setup-python
```

This creates `apps/worker/.venv` and installs **PyMuPDF**. The worker uses that Python automatically.

### 5. Ollama model

```bash
ollama pull qwen2.5vl:7b
```

Match **`OLLAMA_MODEL`** in `.env` (default `qwen2.5vl:7b`).

### 6. Build workspace packages

```bash
npm run build
```

---

## Running QuizMorph

From the **repository root**:

```bash
npm run dev
```

This starts:

- **Web** – [http://localhost:3000](http://localhost:3000)
- **API** – [http://localhost:3001](http://localhost:3001)
- **Worker** – BullMQ consumer for PDF + AI jobs
- TypeScript watchers for shared packages

Check the API:

```bash
curl http://localhost:3001/health
```

You should see `{"status":"ok"}`.

---

## Using the product (web UI)

Open **[http://localhost:3000](http://localhost:3000)**.

### Step 1 – Sign in with Google

1. Click **Continue with Google**.
2. You are sent to Google, then back to the app with a session token stored in the browser.
3. If you change OAuth scopes later, **sign out and sign in again** so a **refresh token** is saved (needed to create forms in your Drive).

### Step 2 – Upload a PDF

1. Choose **only `.pdf`** files.
2. After upload, note the **Document ID** shown on the page.

### Step 3 – Start processing

1. Click **Start processing**.
2. Status defaults to pages **`DEFAULT_PAGE_START`**–**`DEFAULT_PAGE_END`** from `.env` (often **2–24** for full exams). For a **pre-cropped** PDF you can rely on defaults or change those env values before restart.
3. The **worker** reads text per page (Python), calls **Ollama** for structured questions, and writes results to Postgres.
4. Use **Refresh status** until status is **`ready`** (or inspect errors if it stays **`failed`**).

### Step 4 – Review questions (optional)

Click **Load questions** to fetch the extracted JSON from the API.

### Step 5 – Generate the Google Form

1. Click **Generate form (timer flag on)**.
2. The API uses the **Google Forms API** with **your** stored Google refresh token, so the new form lives in **your Google account** (you own it; you can edit it in Google Forms).
3. The UI shows **form URL**, **edit URL**, and a short note about **Quilgo** if the timer flag is on.

### Step 6 – Timer (Quilgo)

Google Forms does not provide a full proctored countdown by itself. For a timed quiz, use **[Quilgo](https://quilgo.com)** (or similar): attach your **published** form URL and configure the timer there. QuizMorph records that you wanted the timer flag on in its database for reference.

---

## Configuration reference

| Variable | Role |
|----------|------|
| `DEFAULT_PAGE_START` / `DEFAULT_PAGE_END` | First and last **1-based** PDF page the worker processes (when you do not pass overrides in the API). |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | Where and which model the worker calls. |
| `FILE_STORAGE_PATH` | Where uploaded PDFs are stored on disk (absolute path recommended for predictable behavior). |
| `PYTHON_EXECUTABLE` | Optional override for the Python binary used for PDF extraction. |

The **API** loads `.env` from **`apps/api/.env`**, then **`apps/.env`**, then the **repo root** `.env` (all that exist; later files override earlier for duplicate keys).

The **worker** loads the same three paths in order at startup (see `apps/worker/src/load-env.ts`), so a **single repo root `.env`** is enough for `DATABASE_URL`, `REDIS_URL`, Ollama settings, and page defaults when you run `npm run dev` from Turbo.

---

## Troubleshooting (short)

| Symptom | Things to check |
|---------|------------------|
| **Cannot reach localhost:3001** | Is `npm run dev` running? Did the API crash (see terminal)? Is Postgres up (`docker compose`)? |
| **DB / Prisma errors** | `docker compose up -d`, then `npm run db:push` with valid `DATABASE_URL`. |
| **Worker says DATABASE_URL not set** | Restart dev after updating the worker; keep `DATABASE_URL` in the **repo root** `.env` (the worker loads `apps/worker/.env`, then `apps/.env`, then root `.env`). |
| **`pip` / PyMuPDF errors** | Use `npm run worker:setup-python` and `python3-venv`; do not install PyMuPDF system-wide on PEP 668 distros. |
| **Ollama errors** | Is Ollama running? Is the model pulled? Does `OLLAMA_MODEL` match? |
| **“Sign in again” / cannot generate form** | Re-consent Google with **Forms** scope; ensure `google_refresh_token` is populated (sign out of the app and sign in again). |
| **OAuth redirect mismatch** | `GOOGLE_CALLBACK_URL` must match the Google Cloud **Authorized redirect URIs** exactly. |

---

## API-only flow (advanced)

If you build another client against the API:

- **Auth:** `GET /auth/google` → browser follows redirects → JWT in callback query to your frontend; send **`Authorization: Bearer <jwt>`** on API calls.
- **Upload:** `POST /documents` (multipart field **`file`**, PDF only).
- **Process:** `POST /documents/:id/process` with optional JSON `{ "pageStart", "pageEnd" }`.
- **Status / questions:** `GET /documents/:id/status`, `GET /documents/:id/questions`.
- **Form:** `POST /documents/:id/generate-form` with body `{ "timerEnabled": true }` (optional).

---

For architecture and stack details, see [AGENTS.md](AGENTS.md).
