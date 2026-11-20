import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import config from "../models.json";
import demoQuestions from "./demo-questions.json";

type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  SWITCHYARD_URL: string;
  RATE_LIMIT_PER_MIN: string;
  APP_PASSCODE?: string; // optional: require a passcode for the API
  ADMIN_PASSCODE?: string; // required for "Reset demo data"
};

type ModelInfo = { label: string; color: string; tier: string; inputPerMTok: number; outputPerMTok: number };
const MODELS = config.models as Record<string, ModelInfo>;
const STRATEGY_IDS = new Set(config.strategies.map((s) => s.id));
const BASELINE = MODELS[config.baselineModel];

function cost(model: ModelInfo | undefined, inTok: number, outTok: number): number | null {
  if (!model) return null;
  return (inTok * model.inputPerMTok + outTok * model.outputPerMTok) / 1_000_000;
}

const app = new Hono<{ Bindings: Env }>();

// ------------------------------------------------------------ optional passcode gate
app.use("/api/*", async (c, next) => {
  const pass = c.env.APP_PASSCODE;
  if (!pass || c.req.path === "/api/login") return next();
  if (getCookie(c, "demo_pass") === pass) return next();
  return c.json({ error: "passcode required" }, 401);
});

app.post("/api/login", async (c) => {
  const { passcode } = await c.req.json<{ passcode?: string }>().catch(() => ({ passcode: "" }));
  if (!c.env.APP_PASSCODE || passcode === c.env.APP_PASSCODE) {
    setCookie(c, "demo_pass", c.env.APP_PASSCODE ?? "", { httpOnly: true, sameSite: "Strict", path: "/" });
    return c.json({ ok: true });
  }
  return c.json({ error: "wrong passcode" }, 401);
});

// ------------------------------------------------------------ config for the browser (no secrets)
app.get("/api/config", (c) =>
  c.json({
    maxTokens: config.maxTokens,
    baselineModel: config.baselineModel,
    models: MODELS,
    strategies: config.strategies,
    demoQuestions,
  }),
);

// ------------------------------------------------------------ chat
type ChatMessage = { role: "user" | "assistant"; content: string };

app.post("/api/chat", async (c) => {
  const body = await c.req
    .json<{ sessionId?: string; strategy?: string; messages?: ChatMessage[] }>()
    .catch(() => null);
  const sessionId = String(body?.sessionId ?? "").slice(0, 64);
  const strategy = String(body?.strategy ?? "");
  const messages = (Array.isArray(body?.messages) ? body!.messages : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));

  if (!sessionId || !STRATEGY_IDS.has(strategy) || !messages.length || messages[messages.length - 1].role !== "user") {
    return c.json({ error: "bad request: need sessionId, a known strategy and a trailing user message" }, 400);
  }

  // Rate limit: max N requests per rolling minute per session.
  const limit = Number(c.env.RATE_LIMIT_PER_MIN || 30);
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE session_id = ? AND ts > ?")
    .bind(sessionId, Date.now() - 60_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= limit) {
    return c.json({ error: `rate limit: max ${limit} requests per minute per session` }, 429);
  }

  const id = crypto.randomUUID();
  const started = Date.now();
  const prompt = messages[messages.length - 1].content.slice(0, 500);
  const base = c.env.SWITCHYARD_URL.replace(/\/$/, "");

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (event: string, data: unknown) =>
    writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  const log = (row: {
    model?: string | null; reason?: string | null; inTok?: number; outTok?: number;
    latency: number; cost?: number | null; routerCost?: number | null; baseline?: number | null;
    success: boolean; error?: string | null;
  }) =>
    c.env.DB.prepare(
      `INSERT INTO requests (id, ts, session_id, strategy, prompt, model, routing_reason, input_tokens, output_tokens,
        latency_ms, cost_usd, router_cost_usd, baseline_usd, success, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(id, started, sessionId, strategy, prompt, row.model ?? null, row.reason ?? null, row.inTok ?? null,
        row.outTok ?? null, row.latency, row.cost ?? null, row.routerCost ?? null, row.baseline ?? null,
        row.success ? 1 : 0, row.error ?? null)
      .run();

  const run = async () => {
    let model: string | null = null;
    try {
      const upstream = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          // A unique Switchyard session per request, so session-stats returns exactly this request's
          // judge verdict. Strategies here judge every request, so no cross-turn affinity is lost.
          "x-switchyard-session-id": id,
          "x-switchyard-origin": "switchyard-router-demo",
        },
        body: JSON.stringify({ model: strategy, max_tokens: config.maxTokens, stream: true, messages }),
      });

      model = upstream.headers.get("x-model-router-selected-model");
      if (!upstream.ok || !upstream.body) {
        const text = (await upstream.text().catch(() => "")).slice(0, 500);
        throw new Error(`Switchyard returned HTTP ${upstream.status}: ${text}`);
      }
      if (model) await send("meta", { model });

      let inTok = 0, outTok = 0, buf = "", stopReason: string | null = null, gotText = false;
      const reader = upstream.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          let ev: any;
          try { ev = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
          if (ev.type === "message_start") {
            const u = ev.message?.usage ?? {};
            inTok = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
            outTok = u.output_tokens ?? 0;
            if (ev.message?.model && ev.message.model !== model) {
              model = ev.message.model;
              await send("meta", { model });
            }
          } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            if (ev.delta.text) gotText = true;
            await send("delta", { text: ev.delta.text });
          } else if (ev.type === "message_delta") {
            if (ev.usage?.output_tokens != null) outTok = ev.usage.output_tokens;
            if (ev.usage?.input_tokens) inTok = ev.usage.input_tokens;
            stopReason = ev.delta?.stop_reason ?? stopReason;
          } else if (ev.type === "error") {
            throw new Error(ev.error?.message ?? "upstream stream error");
          }
        }
      }

      const latency = Date.now() - started;
      const { reason, routerCost } = await fetchRouting(base, id);
      const answerCost = cost(model ? MODELS[model] : undefined, inTok, outTok);
      const actual = answerCost == null ? null : answerCost + (routerCost ?? 0);
      const baseline = cost(BASELINE, inTok, outTok); // Opus-only would need no judge
      await log({ model, reason, inTok, outTok, latency, cost: actual, routerCost, baseline, success: true });
      await send("done", { id, model, reason, inputTokens: inTok, outputTokens: outTok, latencyMs: latency,
        costUsd: actual, answerCostUsd: answerCost, routerCostUsd: routerCost, baselineUsd: baseline, stopReason,
        empty: !gotText });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await log({ model, latency: Date.now() - started, success: false, error: message.slice(0, 500) }).catch(() => {});
      await send("error", { message });
    } finally {
      await writer.close().catch(() => {});
    }
  };
  c.executionCtx.waitUntil(run());

  return new Response(readable, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
});

/**
 * Reads this request's routing record from Switchyard (GET /v1/routing/session-stats, enabled by
 * --routing-log-file). Tested: `outcomes[].judgments[]` gives the judge's selected target/category and
 * `evidence` (null for custom mode; scores for some algorithms). `targets.judge` gives the judge
 * call's token usage, which we price with models.json.
 */
async function fetchRouting(base: string, sessionId: string): Promise<{ reason: string | null; routerCost: number | null }> {
  try {
    const res = await fetch(`${base}/v1/routing/session-stats?session_id=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return { reason: null, routerCost: null };
    const stats: any = await res.json();
    const outcomes: any[] = stats.outcomes ?? [];
    const o = outcomes.at(-1);
    const j = outcomes.flatMap((x) => x.judgments ?? []).at(-1);
    let reason: string | null = null;
    if (j) {
      const pick = j.category ?? j.target ?? "none";
      reason = `${o?.algorithm ?? "classifier"}: Haiku judge chose "${pick}"`;
      const ev = j.evidence ?? o?.evidence;
      if (ev) reason += ` · ${JSON.stringify(ev).slice(0, 300)}`;
    } else if (o?.evidence) {
      reason = `${o.algorithm}: ${JSON.stringify(o.evidence).slice(0, 300)}`;
    }
    const judge = stats.targets?.judge;
    const routerCost = judge
      ? cost(MODELS[judge.model], (judge.prompt_tokens ?? 0), judge.completion_tokens ?? 0)
      : null;
    return { reason, routerCost };
  } catch {
    return { reason: null, routerCost: null };
  }
}

// ------------------------------------------------------------ dashboard data
app.get("/api/stats", async (c) => {
  const db = c.env.DB;
  const where: string[] = [];
  const binds: unknown[] = [];
  const model = c.req.query("model");
  const strategy = c.req.query("strategy");
  if (model) { where.push("model = ?"); binds.push(model); }
  if (strategy) { where.push("strategy = ?"); binds.push(strategy); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const wOk = `WHERE success = 1${where.length ? " AND " + where.join(" AND ") : ""}`;

  const [totals, perModel, recent] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS queries, SUM(success) AS ok, COALESCE(SUM(cost_usd),0) AS spend,
                COALESCE(SUM(baseline_usd),0) AS baseline FROM requests ${w}`).bind(...binds).first(),
    db.prepare(`SELECT model, COUNT(*) AS n, AVG(latency_ms) AS avg_latency, SUM(cost_usd) AS spend
                FROM requests ${wOk} GROUP BY model ORDER BY n DESC`).bind(...binds).all(),
    db.prepare(`SELECT id, ts, strategy, prompt, model, routing_reason, input_tokens, output_tokens, latency_ms,
                cost_usd, baseline_usd, success, error FROM requests ${w} ORDER BY ts DESC LIMIT 100`).bind(...binds).all(),
  ]);
  return c.json({ totals, perModel: perModel.results, recent: recent.results });
});

app.post("/api/reset", async (c) => {
  const admin = c.env.ADMIN_PASSCODE;
  const { passcode } = await c.req.json<{ passcode?: string }>().catch(() => ({ passcode: "" }));
  if (!admin) return c.json({ error: "reset disabled: set ADMIN_PASSCODE in .dev.vars" }, 403);
  if (passcode !== admin) return c.json({ error: "wrong admin passcode" }, 403);
  await c.env.DB.prepare("DELETE FROM requests").run();
  await fetch(`${c.env.SWITCHYARD_URL.replace(/\/$/, "")}/v1/stats/reset`, { method: "POST" }).catch(() => {});
  return c.json({ ok: true });
});

export default app;
