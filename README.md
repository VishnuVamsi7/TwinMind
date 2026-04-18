# TwinMind Assessment

TwinMind is a three-pane web assessment tool: **live microphone transcription** (~30s segments), **Groq-powered live suggestions** (three cards per segment), and a **chat column** for longer answers when you tap a suggestion or continue the thread. A small **FastAPI** backend proxies audio and chat calls to **Groq** so the browser never embeds secrets in build output—you paste `GROQ_API_KEY` in **Settings**.

This document covers architecture, **prompt engineering** (how requirements were specified so models behave predictably), tech choices, deployment (including Netlify for the frontend), and **honest** notes about friction we hit in the codebase (no invented war stories).

---

## Prompt engineering: techniques, structure, and how information was specified

This section is for **evaluators**: it explains the **prompting discipline** used when defining TwinMind’s behavior—not vague “be helpful” instructions, but **contracts** the app and backend can rely on. The **canonical text** of every default system prompt lives in `backend/app/main.py` (`SUGGESTIONS_CHUNK_ONLY`, `SUGGESTIONS_WITH_EXTENDED`, `CHAT_EXPAND_SYSTEM`, `CHAT_CONTINUE_SYSTEM`). What follows is the **method** behind that text.

### Goals the prompts were designed to satisfy

- **Grounding** — Suggestions must follow what was actually said in the latest segment, not invented context.
- **Controllable creativity** — Enough structure to get three **typed**, **distinct** cards every time; not open-ended brainstorming.
- **Parseability** — The suggestions path must return **JSON** the server can validate; chat paths can be natural language but still **role-bounded**.
- **Two ingestion modes** — Same product feature (live suggestions) with **strict chunk-only** vs **primary + optional rolling transcript**, each with its own system contract so the model is not asked to resolve conflicting instructions in one blob.

### Techniques used to convey information correctly

| Technique | What it does | Where it shows up |
|-----------|----------------|-------------------|
| **Persona + scope in one breath** | First line states who the model is *and* the situational frame (“live suggestions for a real-time conversation”). | All suggestion system strings |
| **Markdown sectioning (`##`)** | Turns the prompt into a skippable outline for the model: Input → Task → Types → Rules → Output. Reduces instruction bleed and makes edits auditable. | Suggestions prompts |
| **Labeled severity** | Phrases like **“(strict)”**, **“exactly 3”**, **“strict JSON only, no markdown”** remove ambiguity about hardness of constraints. | Chunk-only input + output sections |
| **Explicit data roles** | Chunk-only: “**one segment only**”. Extended: numbered **PRIMARY** vs **OPTIONAL REFERENCE** with rules for when reference is allowed. | `SUGGESTIONS_CHUNK_ONLY` vs `SUGGESTIONS_WITH_EXTENDED` |
| **Negative constraints** | “Do not assume facts not present”, “Do **not** introduce topics that appear only in the reference…”, “no duplicate kinds for all three” — closes common failure modes. | Suggestions prompts |
| **Controlled vocabulary (`kind`)** | Enum-like list with **definitions** (`question`, `talking_point`, …) so the UI and backend can normalize labels. | `## Types` sections |
| **Field-level guidance** | Character-ish bound on `preview`, sentence bound on `detail`, “no filler” — shapes card UX without a separate template engine. | `## Rules` |
| **Schema-in-prompt** | Literal JSON example in the prompt body so the model sees the exact key names (`suggestions`, `kind`, `preview`, `detail`). | `## Output` |
| **System vs user message split** | **System** = durable contract. **User** = instance: `chunk_id`, `PRIMARY SEGMENT`, optional tagged transcript. Keeps long prompts stable and logs/debuggable. | `create_suggestions` message construction |
| **API-level JSON mode** | `response_format: {"type": "json_object"}` plus **retry without** it if the provider rejects the combo—prompt + API alignment. | `main.py` suggestions handler |
| **Temperature per task** | Slightly higher for variety on suggestions (`0.65`), lower for expand (`0.5`), mid for continue (`0.55`) — simple control without extra chains. | `main.py` payloads |
| **Second system message for context** | Chat-continue adds transcript as a **separate** system message so the “who you are” instructions stay clean from “what was said”. | `continue_chat` |
| **Grounded chat expand** | User message assembled from typed fields (`Suggestion type`, `Card preview`, …) plus optional transcript block — structured injection, not one blob of prose. | `expand_suggestion` |

### Prompt structure (template you can reuse)

When specifying a new LLM feature in this project, the pattern is:

1. **Identity** — One line: role + domain + stakes (“TwinMind — live suggestions…”).
2. **Input contract** — What data exists, what is forbidden, what is optional (`## Input` / `## Input (strict)`).
3. **Task** — Measurable deliverable (“**exactly 3** … items”).
4. **Taxonomy** — Allowed labels with meanings; mixing rules to avoid degenerate outputs.
5. **Quality rules** — Length, tone, anti-hallucination, anti-filler.
6. **Output contract** — Machine-readable when needed (JSON keys + “Exactly N objects”); for chat, formatting bullets (markdown headings, bold).


---

## Product behavior (high level)

1. **Transcript** — `MediaRecorder` captures audio; every ~30s the recorder restarts and the blob is POSTed to `/transcribe`. The UI prepends finalized segments at the top. You can **edit** a segment; saving re-runs suggestions for that chunk.
2. **Suggestions** — After each segment finishes transcribing, the client POSTs `/api/suggestions` with the chunk text and optional rolling transcript context.
3. **Chat** — “Open in chat” calls `/api/chat-expand`; the freeform box calls `/api/chat-continue`. Both can receive a **separate** transcript window from Settings (independent of the suggestion context window).
4. **Export** — Downloads JSON (transcript, batches, chat, and settings snapshot fields useful for grading).

---

## Technical approach (as architected in the project)

- **Split frontend / backend** — Browser handles capture, chunking, and UI state; **no Groq calls from the client except through your backend**, keeping the key out of `NEXT_PUBLIC_*` env for Groq itself.
- **Streaming transcription** — Backend returns **NDJSON** lines so the transcript can update word-by-word (simulated pacing after Whisper returns full text).
- **Suggestion batching** — Each completion returns a `batch` with `triggerChunkId` so the UI can show **per-chunk** refresh and history.
- **Idempotent-ish transcript rows** — New transcription upserts by `chunkId` while a stable `rowId` keeps React keys stable (see “Friction” below).
- **Lightweight markdown in chat** — A small `MarkdownLite` renderer covers headings and bold/italic without pulling in `react-markdown` (keeps dependencies minimal for this assessment repo).

---

## Tech stack and why it was chosen

| Layer | Choice | Rationale |
|--------|--------|------------|
| UI | **Next.js (App Router) 16**, **React 18**, **TypeScript** | Familiar full-stack React model, static export-friendly home page, good DX with strict typing for assessment criteria. |
| Styling | **Tailwind CSS** | Fast layout for a dense three-column dashboard without hand-writing a large CSS design system. |
| API | **FastAPI** | Async-friendly, automatic OpenAPI, easy multipart for audio and JSON bodies for chat. |
| HTTP client | **httpx** (async) | Clean async calls to Groq from FastAPI handlers. |
| Models | **Groq** — `whisper-large-v3`, `openai/gpt-oss-120b` | Assignment-aligned speech + reasoning; single vendor simplifies keys and latency for a demo. |

---

## Local development

### Frontend

```bash
cd frontend
npm install
npm run dev
```

App: `http://localhost:3000`  
Optional: `NEXT_PUBLIC_BACKEND_URL` (default `http://localhost:8000`).

### Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

API: `http://localhost:8000`  
CORS is currently permissive (`*`) for local dev and split deployments.

---

## Deploying the frontend on Netlify

Netlify can host this **Next.js** frontend like any static/SSR Next site.

**Monorepo layout:** `package.json` is under `frontend/`, not the repo root. The root **`netlify.toml`** sets `[build] base = "frontend"` and **`publish = ".next"`** (relative to `base`, so output is `frontend/.next`). That avoids `@netlify/plugin-nextjs` failing when publish would otherwise default to the **same path as base**. In the Netlify UI, do **not** set **Publish directory** to `frontend`; leave publish unset in the UI or match `.next` under the base. Prefer one source of truth: this file. If you previously set a custom build in the UI, remove conflicting **Base directory** / **Publish directory** / build command overrides so `netlify.toml` applies cleanly.

1. Connect the Git repo (root = TwinMind monorepo).
2. Rely on **`netlify.toml` at the repo root** (or set site **Base directory** to `frontend` and build command `npm run build` in the UI—do not leave base at repo root without one of these).
3. Set **`NEXT_PUBLIC_BACKEND_URL`** in Netlify to the **public HTTPS URL** of your FastAPI deployment (e.g. Railway, Render, Fly.io, Azure, etc.). The browser calls that URL from the user’s machine.

**Important:** Netlify does **not** run this repo’s Python FastAPI app by default. You still need a **separate** host for `backend` (or merge into a single platform that runs both). The UI only works end-to-end if that backend URL is reachable and allows browser CORS from your Netlify domain (you may need to tighten `allow_origins` in `main.py` for production).

---

## Friction, bugs, and how the code addresses them (honest, code-backed)

These are grounded in what the implementation actually does—not a generic “lessons learned” essay.

1. **Record control showed `?` for both start and stop** — That was a literal UI placeholder in `page.tsx`. It is replaced with **inline SVG** (microphone when idle, square when recording) so every font and OS renders the affordance consistently.

2. **Stable list identity for transcript rows** — Transcript items use a **`rowId`** (UUID) for React `key` while **`chunkId`** stays monotonic for API correlation. Comments in code note avoiding duplicate keys / conflating segment identity when the recorder rolls.

3. **Duplicate rows for the same chunk** — When a new transcription starts for a chunk id, the client **filters out** any prior row with the same `chunkId` before prepending the streaming row, so you do not accumulate duplicate cards for one segment.

4. **Tiny or empty audio blobs** — Very small blobs were sent in early iterations and caused fragile behavior; the client **skips** chunks below `MIN_CHUNK_BYTES` and logs a short info message instead of hammering the API.

5. **Groq `json_object` compatibility** — If Groq returns an error that implicates `response_format`, the backend **retries once** without `response_format` and logs that path (`[suggestions] Retrying without response_format…`). This is a pragmatic compatibility shim, not a guarantee every model behaves identically.

6. **Suggestion prompts: two modes** — “Chunk-only” and “extended context” use **different** system prompts on the server. The Settings UI exposes **two** optional override fields so you are not forced to cram both behaviors into one textarea.

7. **Chat transcript window vs suggestion window** — Earlier logic tied chat grounding to “extended mode” or a very large implicit window. The product expectation was **independent** windows; the UI now has **Suggestions rolling window (minutes)** and **Chat grounding window (minutes)** separately, both applied through the same `buildExtendedContextTranscript` helper with different minute values.

8. **Clock display vs SSR** — Timestamps render via a small **`ClientLocalTime`** component that sets text in `useEffect`, so the server HTML does not depend on the user’s locale at first paint (reduces “flash” / mismatch patterns common when formatting times during SSR/hydration).

9. **Settings persistence** — Keys and prompt overrides are stored in **`localStorage`** under `twinmind-settings-v1` (best-effort: corrupt JSON or quota errors are ignored). This is still **browser-local**, not a cloud account.

---

## API summary

| Endpoint | Role |
|-----------|------|
| `POST /transcribe` | Multipart audio → streaming NDJSON transcription |
| `POST /api/suggestions` | Chunk + optional extended transcript → three suggestion cards |
| `POST /api/chat-expand` | Tapped card → long answer |
| `POST /api/chat-continue` | Multi-turn chat with transcript grounding |
| `GET /health` | Liveness |

Optional JSON fields (when non-empty): `system_prompt_chunk_only`, `system_prompt_extended` on suggestions; `system_prompt` on chat-expand and chat-continue.

---

## Repository layout

- `frontend/` — Next.js UI  
- `backend/` — FastAPI Groq proxy  

If you extend the project, keep **secrets out of git**—use Settings + env on the deployed backend only.
