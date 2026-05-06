# AGENTS.md

AICut — B 站直播切片本地工具。三服务 monorepo：API (Fastify+SQLite)、Web (React+Vite)、ASR Worker (Python FastAPI+SenseVoice)。

## Commands

| Command | Notes |
|---------|-------|
| `pnpm install` | Node deps only; Python venv is separate |
| `pnpm check:env` | Verifies node/pnpm/python/ffmpeg, creates `library/` dirs |
| `pnpm dev` | All 3 services in one terminal |
| `pnpm dev:split` | Each service in its own PowerShell window |
| `pnpm dev:api` | API only — 127.0.0.1:43110 |
| `pnpm dev:web` | Web only — 127.0.0.1:43111, proxies `/api` → backend |
| `pnpm dev:asr` | ASR Worker only — 127.0.0.1:43112 |
| `pnpm build` | `apps/**` only — ASR worker is not built |
| `pnpm typecheck` | `apps/**` only — `--noEmit` |
| `pnpm lint` | Identical to `typecheck` (no ESLint) |
| `pnpm format` | Prettier across whole repo |

Python ASR deps (one-time):
```
cd services/asr-worker
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
```

## Structure

```
apps/api/              @aicut/api   Fastify + node:sqlite, Node 22+
apps/web/              @aicut/web   React 19 + Vite + TailwindCSS
services/asr-worker/   (outside pnpm workspace)  Python FastAPI + SenseVoice
config/                gitignored — cookie.json, keywords.json, prompts.json
library/               gitignored — runtime data (db, sources, transcripts, exports)
```

- `pnpm-workspace.yaml` only includes `apps/*` — ASR worker is outside the workspace
- `pnpm build`/`typecheck`/`lint` filter `./apps/**`, skip `services/`
- API dev uses `tsx watch` (no compile step during development)

## Key Constraints

- **Node.js 22+ required** — uses `node:sqlite` (`DatabaseSync`), not better-sqlite3
- **No DB migrations** — `schema.sql` runs on every startup via `CREATE TABLE IF NOT EXISTS`; schema changes require deleting the `.db` file
- **API imports use `.js` extensions** — `module: "NodeNext"` / `moduleResolution: "NodeNext"` in tsconfig; write `import { x } from "./foo.js"` even for `.ts` source files
- **No test suite** — there are no tests; `lint` = `typecheck`
- **`config/` is gitignored** — contains `cookie.json` (B站 login), `keywords.json`, `prompts.json`; first-time setup needs `config/cookie.json` (see `cookie.example.json`)
- **`library/` is gitignored** — runtime output dir; `check:env` creates the subdirectory structure
- **ASR Worker runs in its own venv** — not managed by pnpm; `AICUT_PYTHON` env var overrides the python binary used by `dev.js`/`dev-asr.js`
- **HLS routes live in `core/hls/`** — not in `routes/`; registered directly in `index.ts`
- **EventBus** (`events/bus.ts`) is the sole real-time channel; frontend consumes via SSE at `/api/events/stream`
- **Transcript timestamps are global seconds** from session start, drift-calibrated — map directly to player `currentTime`

## API Internals

- `db/index.ts`: `getDb()`, `row()`, `rows()` — thin wrappers over `DatabaseSync`
- `config.ts`: all env vars with defaults; paths resolved relative to repo root
- `src/core/recorder/`: HLS direct recording engine (`engine.ts` + `hlsDownloader.ts` + `playlist.ts`). Uses `@bililive-tools/bilibili-recorder` only for stream URL resolution (`biliApi.ts`) and danmaku listening (`danmuClient.ts`); actual recording is custom HLS segment download via ffmpeg. `recorderManager.ts` is a thin re-export from `engine.ts`.
- `src/core/hls/`: serves recorded `.ts` segments as dynamic m3u8 playlists — zero transmux
- `src/core/asr/`: `streamClient.ts` manages HTTP+SSE to Python ASR Worker
- `src/core/analysis/`: scoring pipeline — stats → rules → optional LLM → candidates
- `src/core/export/`: ffmpeg-based rough cut export with SRT generation
- `src/routes/`: sources, sessions, candidates, exports, settings, events — Zod validation
- Route registration in `src/index.ts`; `onReady` hook restores auto-record sources

## Web Internals

- `api/client.ts`: `apiGet` / `apiPost` / `apiPatch` — thin fetch wrappers
- Pages: Sources, Sessions, LivePreview, Review, Settings — switched by `SystemRail` sidebar
- Video: `@vidstack/react` + `hls.js`, HLS DVR mode
- `hooks/useEventStream.ts` consumes the SSE event stream

## Design Context

UI follows high-density console aesthetic: strong hierarchy, warm signal colors, explicit status indicators. Avoid purple-blue gradients, glassmorphism, mascots, over-decoration. See `docs/design-context.md` for full guidelines.

## Docs

| Doc | Content |
|-----|---------|
| `docs/design-context.md` | User persona, brand tone, aesthetic direction, design principles |
| `docs/AICut-V1-方案.md` | V1 spec: phases, data model, API design, UI prototypes |
| `docs/scoring-algorithm.md` | Scoring: dynamic thresholds, dimension weights, LLM enhancement |
| `AICut V2 重构计划文档.md` | V2 refactor: streaming ASR, HLS DVR, SenseVoice |
