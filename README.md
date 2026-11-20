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

The demo is about a **Haiku judge** reading each question and picking a model, so the dropdown offers the
two judge-based strategies. Both are routes in one Switchyard server (`switchyard/routes.toml`). The
dropdown sends the route's `id` as the request's `model`, so switching needs no restart.

| Dropdown | Route id | Switchyard type | What the judge does |
|---|---|---|---|
| Tiered classifier (default) | `switchyard/tiered` | `llm_classifier`, `mode = "custom"` | Picks Haiku, Sonnet or Opus |
| Task classifier | `switchyard/task` | `llm_classifier`, `mode = "capability"` | Scores the chance Haiku solves it; below 85% (90% when unsure) it goes to Opus |

Each reply shows the judge's decision on its own line, for example "⚖ Haiku judge picked Opus", or for
Task "⚖ Haiku judge: 60% chance Haiku solves it (< 90% needed) → Opus".

**Auto is left out of the dropdown on purpose.** `routes.toml` still defines `switchyard/auto`
(Switchyard's default preset), but it doesn't use a judge or read the question. It routes coding agents
on tool-call signals (errors, loops, stalls), so plain chat always stays on Haiku. The Switchyard
docs say this is expected. To bring it back, add it to `strategies` in `models.json`.

**Both judges rate the latest question, not the whole conversation.** By default Switchyard's judge
sees the conversation's *opening* message plus the latest one, and the packaged capability prompt
forecasts whether a *coding agent* finishes a task against a verifier. In a chat that opened with a hard
question, that made later easy questions look hard: "capital of New Zealand" scored 55% and went to
Opus. Both routes now set their own `prompt` in `routes.toml`, written for chat and told to judge the
latest message, with earlier turns as context only. Same follow-up after the same opening question:
Task now scores it 98% and Tiered picks Haiku.

Things worth telling your audience:

- **Only custom mode can choose among three models.** Capability mode and Auto are two-tier.
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
  selection and evidence: the chosen group for Tiered, plus the solve score and threshold for Task. The
  Worker turns that into the "⚖" line under each reply, which also appears when you hover a model cell on
  the dashboard. The same response's `targets.judge` token counts are priced with `models.json` to get the
  judge's cost.

## What gets logged

Every request is one row in D1 (`requests`), local or hosted:

| Column | What |
|---|---|
| `ts`, `session_id`, `turn` | When, which browser session, and which question of the conversation (1 = opening) |
| `strategy`, `prompt` | Route used, and the question (first 500 chars) |
| `routing_reason` | The judge's decision, e.g. "Haiku judge: 55% chance Haiku solves it (< 90% needed) → Opus" |
| `model`, `response` | Model that answered, and its answer (first 8,000 chars) |
| `input_tokens`, `output_tokens`, `latency_ms` | Input includes cached tokens |
| `cost_usd`, `router_cost_usd`, `baseline_usd` | Total cost (answer + judge), the judge's share, and the same tokens at Opus rates |
| `success`, `error` | Failed requests are logged too |

On the dashboard, click any row to see the question, judge decision and full answer. **Download log (CSV)**
exports everything. Both are behind the passcode when hosted. Costs price uncached input, cache writes,
cache reads and output separately, using the rates in `models.json`. Rows logged before 2026-11-20 01:10 UTC
under-counted input on long conversations (cached tokens were dropped) and have no answer text.

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
   question. Point at the "Haiku judge is choosing a model…" step, then the colour-coded badge, latency
   and cost, and the "⚖ Haiku judge picked …" line under each reply.
4. Point at the running total: actual cost vs "if all Opus".
5. Click **New chat**, switch to **Task classifier**, and send an easy and a hard question. The ⚖ line
   now shows the judge's confidence that Haiku can handle the question, and the threshold it was compared
   against.
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

## Host it on Cloudflare (free)

The hosted version costs nothing on Cloudflare: Workers Free, D1 free tier, Cloudflare Tunnel, and
Workers VPC, which is free on all plans during its beta. Anthropic usage is billed as before.
Switchyard keeps running in Docker on your PC, so **the hosted demo only works while your PC is on and
`npm run host:up` is running.**

```
Colleague's browser ──HTTPS──► Worker on workers.dev (passcode, rate limits, $5/day cap) ──► D1
                                   │ Workers VPC Service binding (private, no public URL)
                                   ▼
                        Cloudflare Tunnel ◄──outbound only── cloudflared (Docker, your PC) ──► switchyard:4000
```

Security model:

- **Switchyard has no public address.** The tunnel has no public hostname, and only this Worker's
  VPC binding can reach `switchyard:4000`. `cloudflared` makes outbound connections only, so no ports
  are opened on your PC or router. Docker still binds Switchyard's local port to 127.0.0.1 only.
- **A shared passcode** (`APP_PASSCODE` secret) guards every `/api/*` call. The cookie holds a hash,
  not the passcode. Wrong guesses are slowed to one per second. If the secret is missing, the hosted
  Worker refuses to serve (`REQUIRE_PASSCODE=true`) rather than opening up.
- **Spend limits:** 30 requests per minute per session, 60 per minute in total, and a $5 per day cap
  (UTC) on logged Anthropic spend. Keep a monthly limit in the Claude Console as a backstop.
- **The API key never leaves your PC.** It is in `.env`, read only by the Switchyard container. The tunnel
  token (`TUNNEL_TOKEN`, also in `.env`) is read only by the `cloudflared` container.
- The pages themselves (HTML, JS) are public, but they hold no data or secrets. Everything else goes through
  the passcode-protected API.

One-time setup (all with `npx wrangler`, logged in to your account):

```powershell
npx wrangler d1 create switchyard-demo          # copy the database_id into env.hosted in wrangler.jsonc
npx wrangler tunnel create switchyard-demo      # note the tunnel id
npx wrangler vpc service create switchyard --type http --tunnel-id <TUNNEL_ID> --hostname switchyard --http-port 4000
                                                # copy the service id into env.hosted.vpc_services
npx wrangler secret put APP_PASSCODE --env hosted     # the passcode you give colleagues
npx wrangler secret put ADMIN_PASSCODE --env hosted   # protects "Reset demo data"
```

Put the tunnel token in `.env` as `TUNNEL_TOKEN=`. You can copy it from the dashboard: Workers & Pages →
VPC → Tunnels → your tunnel → install command, the long value after `--token`.

Each time you present:

```powershell
npm run host:up      # Switchyard + cloudflared in Docker
npm run deploy       # only after code changes: migrates the remote D1 and deploys the Worker
```

Stop it with `npm run host:down`. The site then shows an error until you start it again.

Notes: Workers VPC needs the tunnel to connect over QUIC (outbound UDP 7844), which the Compose file
forces. `npm run dev` still runs the fully local version, which needs no tunnel and no passcode.

## Routing results from the local test run (2026-11-20)

All 15 demo questions per strategy, each sent as a fresh one-message conversation (`npm run demo:run`).

| Strategy | Haiku | Sonnet | Opus | Spend | If all Opus |
|---|---|---|---|---|---|
| Tiered classifier | 5 (all easy) | 5 (all medium) | 5 (all hard) | $0.129 | $0.165 |
| Task classifier, threshold 0.6 | 13 | – | 2 (Node leak, payment design) | $0.049 | $0.152 |
| Task classifier, threshold 0.85 (current) | 10 | – | 5 (3 hard, 2 medium) | $0.081 | $0.145 |
| Auto (not in the UI) | 15 | – | – | $0.004 | $0.152 |

- **Tiered** split the set exactly by difficulty, on the first configuration. No tuning was needed.
- **Task** sends a question to Opus when the judge's estimate that Haiku can solve it falls below the
  threshold. At 0.6 only two questions went to Opus, so the threshold is now `base_threshold = 0.85`
  with `threshold_step = 0.05` (0.9 when the verdict is uncertain). Opus now gets the Python dedupe bug
  (judge: 80%), the Node.js leak (60%), the payment design (60%), the word-count function (80%) and the
  HTTPS explanation (85%, uncertain). The judge still rates the bat-and-ball (97%) and seating (93%)
  puzzles as easy for Haiku. That's its honest call and a good talking point about judge calibration.
- **Auto** sent everything to Haiku. That is expected for chat with no tool signals, which is why it's not
  in the dropdown.
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
