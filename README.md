# Switchyard Router Demo

A chatbot that shows [NVIDIA NeMo Switchyard](https://github.com/NVIDIA-NeMo/Switchyard) routing each
question to **Claude Haiku 5.5**, **Sonnet 5.5** or **Opus 5.5**. Under each reply you see which model
answered, how long it took and what it cost. A dashboard compares total spend with "send everything to Opus".

Everything runs on your PC. You present it by sharing your screen on Zoom.

```
Browser ──► Worker (wrangler dev, 127.0.0.1:8787) ──► Switchyard (Docker, 127.0.0.1:4000) ──► api.anthropic.com
              │  chat UI, dashboard, cost maths                  routing + judge calls
              └─► D1 (local SQLite under .wrangler/)  one row per request
```

| Piece | Where |
|---|---|
| Worker (Hono, TypeScript) | `src/index.ts` |
| Chat UI / dashboard (plain HTML + JS, Chart.js) | `public/` |
| Model IDs, prices, `max_tokens`, strategies | `models.json` (the only place prices live) |
| Demo question set (5 easy, 5 medium, 5 hard) | `src/demo-questions.json` |
| Switchyard config | `switchyard/routes.toml` |
| Switchyard image (built from a pinned commit) | `switchyard/Dockerfile`, `docker-compose.yml` |
| D1 schema | `migrations/0001_init.sql` |

## Prerequisites

- Node.js 20+ and npm
- Docker Desktop (running)
- An Anthropic API key with access to `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5`

No Cloudflare account is needed. `wrangler dev` runs the Worker and D1 locally.

## Setup (once)

```powershell
npm install
Copy-Item .env.example .env            # then put your key after ANTHROPIC_API_KEY=
Copy-Item .dev.vars.example .dev.vars  # then set ADMIN_PASSCODE (protects "Reset demo data")
```

**The API key** lives only in `.env`. Docker Compose passes it to the Switchyard container. The Worker
and the browser never see it. `.env` and `.dev.vars` are gitignored.

**The D1 database** is created automatically: `npm run dev` runs `wrangler d1 migrations apply DB --local`,
which creates the local SQLite file under `.wrangler/state/`.

The first `npm run dev` builds the Switchyard image from source (Rust). That takes about 5–15 minutes.
Later runs reuse the image.

## Run

```powershell
npm run dev
```

This starts Switchyard (`docker compose up -d --build --wait`), applies migrations and starts the Worker.
Open <http://127.0.0.1:8787>. Stop with Ctrl+C, then `npm run router:down`.

Both servers listen on `127.0.0.1` only, so nobody else on your network can reach them or use your key.

## Strategies (the dropdown)

One Switchyard server exposes three routes in `switchyard/routes.toml`. The dropdown sends the chosen
route's `id` as the request's `model`, so switching strategy needs no restart and no second config.

| Dropdown | Route id | Switchyard type | Models |
|---|---|---|---|
| Tiered classifier | `switchyard/tiered` | `llm_classifier`, `mode = "custom"` | Haiku judges, picks Haiku / Sonnet / Opus |
| Task classifier | `switchyard/task` | `llm_classifier`, `mode = "capability"` | Haiku estimates `p_solve`; below 0.6 goes to Opus |
| Auto | `switchyard/auto` | `auto` (Stage router preset) | Haiku (efficient) / Opus (capable) |

Things worth telling your audience:

- **Auto keeps plain chat on Haiku, and that is by design.** It routes on tool-call signals
  (errors, loops, stalls) from coding agents. A chat with no tool history has no signals, so it
  "falls open" to the efficient model. The Switchyard docs list this under troubleshooting:
  "Every fresh chat selects the efficient model: expected for this preset without tool signals."
- **Only the custom classifier mode can choose among three models.** Auto, Stage and capability mode are two-tier.
- **The judge is a real model call** (Haiku 5.5, `reasoning_effort = "low"`). It adds roughly 1–3 s of latency
  and about $0.0001 per question. The per-turn cost in the UI and on the dashboard includes the judge
  (shown as "incl. judge"). The Opus baseline does not, because sending everything to Opus needs no judge.
- All answering targets run at `reasoning_effort = "low"` with a short "answer concisely" system prompt
  (both set in `routes.toml`), and `max_tokens` is capped at 4096 (in
  `models.json`) to bound cost. A reply cut off by the cap is marked "cut off at 4096 tokens".

## How "which model answered" is determined

Verified by testing, not assumed:

- The Worker calls Switchyard's Anthropic-compatible `POST /v1/messages` with `stream: true`.
- Switchyard sets the response header **`x-model-router-selected-model`** (e.g. `claude-sonnet-5-5`).
  The streamed `message_start` event's `message.model` carries the same ID. The Worker uses both.
- Token counts come from the stream's `usage`. Cost = tokens × the rates in `models.json`.
  The "Opus baseline" prices the same token counts at Opus rates. That is an approximation, since Opus
  would produce a different number of output tokens.
- **Routing reason:** the Worker sends `x-switchyard-session-id: <request id>`. Switchyard runs with
  `--routing-log-file`. After the reply, the Worker reads
  `GET /v1/routing/session-stats?session_id=<request id>`, whose `outcomes[].judgments` contain the judge's
  selection and evidence: the chosen group for Tiered, plus the solve score and threshold for Task. Hover
  the model badge (chat) or the model cell (dashboard) to see it. Auto produces no per-request judgment, so
  it shows no reason. The same response's `targets.judge` token counts are priced with `models.json` to
  get the judge's cost.

## Verify routing is active

This follows Switchyard's "Verify routing is active" guide (`docs/operations/local_evaluation.md`),
adapted to the Anthropic endpoint and this config. The last two commands call Anthropic and cost
a fraction of a cent.

```powershell
curl.exe -fsS http://127.0.0.1:4000/health
curl.exe -fsS http://127.0.0.1:4000/v1/models          # lists switchyard/auto, switchyard/task, switchyard/tiered
curl.exe -fsS -X POST http://127.0.0.1:4000/v1/stats/reset
```

Easy question: expect `x-model-router-selected-model: claude-haiku-5-5`.

```powershell
curl.exe -s -i http://127.0.0.1:4000/v1/messages -H "content-type: application/json" -H "anthropic-version: 2023-06-01" -d '{\"model\":\"switchyard/tiered\",\"max_tokens\":200,\"messages\":[{\"role\":\"user\",\"content\":\"Say hello in one sentence.\"}]}'
```

Hard question: expect `claude-opus-5-5`.

```powershell
curl.exe -s -i http://127.0.0.1:4000/v1/messages -H "content-type: application/json" -H "anthropic-version: 2023-06-01" -d '{\"model\":\"switchyard/tiered\",\"max_tokens\":300,\"messages\":[{\"role\":\"user\",\"content\":\"Five people A-E sit in a row. A is not at either end. B sits immediately right of C. D is left of A. E is at an end and not next to B. List every valid seating and prove there are no others.\"}]}'
```

Then read the counters (per-model calls, and judge calls under `classifier`):

```powershell
curl.exe -fsS http://127.0.0.1:4000/v1/stats
```

To run the whole demo set through every strategy from the command line (about 45 billable calls,
under $1), with `npm run dev` running in another terminal:

```powershell
npm run demo:run
```

## Running the demo for an audience

1. Before the call: `npm run dev`, open <http://127.0.0.1:8787>, and click **Reset demo data** on the
   dashboard (it asks for `ADMIN_PASSCODE`).
2. In Zoom, share the browser window. Use browser zoom (Ctrl +) to about 125% so the tags are readable.
3. Start on **Tiered classifier**. Open **Demo questions** and send one easy, one medium and one hard
   question. Point at the colour-coded badge, latency and cost under each reply, and hover the badge
   to show the judge's reason.
4. Point at the running total: actual cost vs "if all Opus".
5. Click **New chat**, switch to **Auto**, and ask a hard question. It stays on Haiku. Explain why:
   Auto is for agents with tool signals, not plain chat.
6. Open **Dashboard**: model share, average latency per model, spend vs Opus baseline, and the recent
   query table (filter by model or strategy; hover a model cell for the reason).

Tips: each question is a conversation turn, so for a clean comparison click **New chat** between topics.
The judge looks at the latest user message, and earlier turns are context only. The UI is rate-limited
to 30 requests per minute per browser session.

## Security and cost controls

- Both servers bind to `127.0.0.1`. The audience watches your screen and cannot send requests.
- The API key is only in `.env`, read by the Switchyard container. It is never in the Worker or the browser.
- `max_tokens` is capped at 4096 per reply (worst case about $0.08 for one Opus reply) (in `models.json`). At most the last 20 messages are sent, each
  capped at 8,000 characters.
- Rate limit: 30 requests per rolling minute per session (`RATE_LIMIT_PER_MIN` in `wrangler.jsonc`),
  counted in D1.
- "Reset demo data" requires `ADMIN_PASSCODE` from `.dev.vars`. An optional `APP_PASSCODE` gates the whole API.

## Changing things

- **Prices / models / max_tokens:** `models.json`. If you change a model ID, change it in
  `switchyard/routes.toml` too, because Switchyard needs the ID in its own config.
- **Routing behaviour:** `switchyard/routes.toml` is mounted into the container, so after editing run
  `docker compose restart switchyard`. Check with
  `docker compose run --rm switchyard --config /config/routes.toml --dry-run`.
- **Switchyard version:** `SWITCHYARD_COMMIT` in `switchyard/Dockerfile`, then `npm run router:up`.

## Deploying to Cloudflare later (not set up)

The Worker is a normal Cloudflare Worker with static assets and D1. To host it you would need
`wrangler d1 create`, a real `database_id` in `wrangler.jsonc`, `SWITCHYARD_URL` pointing at a reachable
Switchyard (a Cloudflare Container on the Workers Paid plan, or this Docker Compose service behind a
Cloudflare Tunnel), and Cloudflare Access or `APP_PASSCODE` in front of it. None of that is needed for
the local demo.

## Routing results from the local test run (2026-11-20)

All 15 demo questions per strategy, each sent as a fresh one-message conversation (`npm run demo:run`).

| Strategy | Haiku | Sonnet | Opus | Spend | If all Opus |
|---|---|---|---|---|---|
| Tiered classifier | 5 (all easy) | 5 (all medium) | 5 (all hard) | $0.129 | $0.165 |
| Task classifier | 13 | – | 2 (Node leak, payment design) | $0.049 | $0.152 |
| Auto | 15 | – | – | $0.004 | $0.152 |

Total for the run: $0.18 (judge calls included).

- **Tiered** split the set exactly by difficulty, on the first configuration. No tuning was needed.
- **Task** sends a request to Opus only when the judge's solve probability falls below the threshold
  (0.6, or 0.7 when the verdict is uncertain). The judge rated most hard questions solvable by Haiku
  (scores 0.72–0.97), so only two went to Opus. Raise `base_threshold` in `routes.toml` to escalate more.
- **Auto** sent everything to Haiku. That is expected for chat with no tool signals.
- The "saved" figure for Tiered is modest because medium questions go to Sonnet and produce long answers.
  Savings are largest when most traffic is easy.

What Switchyard exposes per request (tested): the selected model (`x-model-router-selected-model` header
and the `model` field); for classifier routes, the judge's chosen group (`judgments[].category`); and for
the Task route, the solve score and threshold (`evidence: {"score":0.72,"threshold":0.6}`). Custom-mode
judgments carry no evidence, and Switchyard does not keep free-text judge output, so the Tiered tooltip
shows the judge's pick but not a written reason.

**Token cap:** this run used `max_tokens = 1024`, and most hard answers hit the cap. Opus 5.5 and
Haiku 5.5 always think, and thinking tokens count toward `max_tokens`. In 2 of 45 runs the whole budget
went on thinking and no text came back. The cap is now **4096**, and the answering targets have a short
"answer concisely, under about 300 words" `system_prompt` in `routes.toml`. Switchyard never sends target
prompts to the judge, so routing is unaffected. Re-test on the Tiered route:

| Question | Model | Before (1024 cap, no prompt) | 4096 cap, no prompt | 4096 cap + concise prompt |
|---|---|---|---|---|
| Capital of Australia | Haiku | 75 tok, 2.8 s | – | 17 tok, 2.2 s, $0.0001 |
| Kubernetes pod vs container | Sonnet | 996 tok, 9.0 s | – | 655 tok, 6.8 s, $0.0068 |
| Node.js memory leak | Opus | cut off, no text | 4,072 tok, 43 s, $0.082 | 1,051 tok, 13.1 s, $0.022 |

All three finished normally (`end_turn`).
