// Sends every demo question through each strategy via the running Worker (npm run dev)
// and prints which model answered. Billable: ~15 calls per strategy plus judge calls.
// Usage: node scripts/run-demo.mjs [strategyId ...]   (default: all strategies)
const BASE = process.env.DEMO_URL ?? "http://127.0.0.1:8787";
const cfg = await (await fetch(`${BASE}/api/config`)).json();
const strategies = process.argv.slice(2).length ? process.argv.slice(2) : cfg.strategies.map((s) => s.id);
const label = (m) => cfg.models[m]?.label ?? m ?? "?";

async function ask(strategy, text) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: `demo-run-${strategy}-${Date.now()}`, strategy, messages: [{ role: "user", content: text }] }),
  });
  if (!res.ok) return { error: `HTTP ${res.status} ${await res.text()}` };
  const body = await res.text();
  const frames = body.split("\n\n").filter(Boolean).map((f) => ({
    ev: /^event: (.*)$/m.exec(f)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(f)?.[1] ?? "{}"),
  }));
  const done = frames.find((f) => f.ev === "done")?.data;
  const err = frames.find((f) => f.ev === "error")?.data;
  return done ?? { error: err?.message ?? "no done event" };
}

const summary = {};
for (const strategy of strategies) {
  console.log(`\n=== ${strategy} ===`);
  const counts = {}; let cost = 0, baseline = 0;
  for (const q of cfg.demoQuestions) {
    const r = await ask(strategy, q.text);
    if (r.error) { console.log(`  [${q.level.padEnd(6)}] ERROR ${r.error.slice(0, 200)}`); counts.error = (counts.error ?? 0) + 1; continue; }
    counts[label(r.model)] = (counts[label(r.model)] ?? 0) + 1;
    cost += r.costUsd ?? 0; baseline += r.baselineUsd ?? 0;
    console.log(`  [${q.level.padEnd(6)}] ${label(r.model).padEnd(10)} ${(r.latencyMs / 1000).toFixed(1).padStart(5)}s ` +
      `${String(r.outputTokens).padStart(4)} out  $${(r.costUsd ?? 0).toFixed(5)}` +
      `${r.stopReason === "max_tokens" ? " CUT" : "    "}${r.empty ? " EMPTY" : "      "}  ${q.text.slice(0, 50).replace(/\n/g, " ")}` +
      (r.reason ? `\n             reason: ${r.reason.slice(0, 160)}` : ""));
  }
  summary[strategy] = { counts, cost: cost.toFixed(4), baseline: baseline.toFixed(4) };
}
console.log("\n=== summary ===");
console.log(JSON.stringify(summary, null, 2));
