const $ = (id) => document.getElementById(id);
let cfg, pie, bar;
const usd = (n) => (n == null ? "–" : n < 0.01 ? `$${Number(n).toFixed(5)}` : `$${Number(n).toFixed(4)}`);
const label = (m) => cfg.models[m]?.label ?? m ?? "error";
const color = (m) => cfg.models[m]?.color ?? "#999";
const stratLabel = (id) => cfg.strategies.find((s) => s.id === id)?.label.split(" (")[0] ?? id;

async function api(path, opts) {
  let res = await fetch(path, opts);
  if (res.status === 401) {
    const passcode = prompt("Passcode for this demo:");
    await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode }) });
    res = await fetch(path, opts);
  }
  return res;
}

async function init() {
  cfg = await (await api("/api/config")).json();
  for (const [id, m] of Object.entries(cfg.models)) $("fModel").add(new Option(m.label, id));
  for (const s of cfg.strategies) $("fStrategy").add(new Option(s.label, s.id));
  $("fModel").onchange = $("fStrategy").onchange = load;
  const text = getComputedStyle(document.body).color;
  Chart.defaults.color = text;
  pie = new Chart($("pie"), { type: "doughnut", data: { labels: [], datasets: [{ data: [], backgroundColor: [] }] },
    options: { maintainAspectRatio: false, plugins: { legend: { position: "right" } } } });
  bar = new Chart($("bar"), { type: "bar", data: { labels: [], datasets: [{ data: [], backgroundColor: [] }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { y: { title: { display: true, text: "seconds" }, beginAtZero: true } } } });
  await load();
  setInterval(() => { if ($("auto").checked) load(); }, 4000);
}

async function load() {
  const q = new URLSearchParams();
  if ($("fModel").value) q.set("model", $("fModel").value);
  if ($("fStrategy").value) q.set("strategy", $("fStrategy").value);
  const d = await (await api(`/api/stats?${q}`)).json();
  const t = d.totals ?? {};
  $("kQueries").textContent = `${t.queries ?? 0}${t.queries && t.ok < t.queries ? ` (${t.queries - t.ok} failed)` : ""}`;
  $("kSpend").textContent = usd(t.spend ?? 0);
  $("kBaseline").textContent = usd(t.baseline ?? 0);
  $("kSaved").textContent = t.baseline > 0 ? `${((1 - t.spend / t.baseline) * 100).toFixed(0)}%` : "–";

  const pm = d.perModel ?? [];
  pie.data.labels = pm.map((r) => label(r.model));
  pie.data.datasets[0].data = pm.map((r) => r.n);
  pie.data.datasets[0].backgroundColor = pm.map((r) => color(r.model));
  pie.update();
  bar.data.labels = pm.map((r) => label(r.model));
  bar.data.datasets[0].data = pm.map((r) => (r.avg_latency / 1000).toFixed(2));
  bar.data.datasets[0].backgroundColor = pm.map((r) => color(r.model));
  bar.update();

  const rows = $("rows");
  rows.innerHTML = "";
  for (const r of d.recent ?? []) {
    const tr = document.createElement("tr");
    tr.className = "clickable";
    tr.title = "Click to see the question, the judge's decision and the full answer";
    tr.onclick = () => showDetail(r.id);
    const cells = [
      new Date(r.ts).toLocaleTimeString(),
      r.turn ?? "–",
      r.prompt,
      stratLabel(r.strategy),
      shortReason(r.routing_reason),
      r.success ? label(r.model) : `Error: ${r.error ?? ""}`,
      r.latency_ms != null ? `${(r.latency_ms / 1000).toFixed(1)}s` : "–",
      r.input_tokens != null ? `${r.input_tokens} / ${r.output_tokens}` : "–",
      usd(r.cost_usd),
    ];
    cells.forEach((v, i) => {
      const td = document.createElement("td");
      td.textContent = v;
      if (i === 1) td.className = "num";
      if (i === 2) { td.className = "snippet"; td.title = r.prompt; }
      if (i === 4) { td.className = "decision"; td.title = r.routing_reason ?? ""; }
      if (i === 5 && r.success) {
        const dot = document.createElement("span"); dot.className = "dot"; dot.style.background = color(r.model);
        td.prepend(dot);
      }
      if (i >= 6) td.className = "num";
      tr.appendChild(td);
    });
    rows.appendChild(tr);
  }
}

/** "Haiku judge: 55% chance Haiku solves it (< 90% needed) → Opus" → "55% < 90% → Opus" */
function shortReason(r) {
  if (!r) return "–";
  const m = /(\d+)% chance Haiku solves it \(([<≥]) (\d+)% needed\) → (\w+)/.exec(r);
  if (m) return `${m[1]}% ${m[2]} ${m[3]}% → ${m[4]}`;
  const p = /picked (\w+)/.exec(r) ?? /chose "(\w+)"/.exec(r);
  return p ? `picked ${p[1]}` : r.slice(0, 40);
}

function md(text) {
  const el = document.createElement("div");
  el.className = "md";
  if (window.marked && window.DOMPurify) el.innerHTML = DOMPurify.sanitize(marked.parse(text ?? ""), { FORBID_TAGS: ["style", "img"] });
  else { el.textContent = text ?? ""; el.style.whiteSpace = "pre-wrap"; }
  return el;
}

async function showDetail(id) {
  const res = await api(`/api/requests/${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const r = await res.json();
  const body = $("detailBody");
  body.innerHTML = "";
  const add = (title, node) => {
    const h = document.createElement("h3"); h.textContent = title; body.appendChild(h);
    body.appendChild(typeof node === "string" ? Object.assign(document.createElement("p"), { textContent: node }) : node);
  };
  const meta = [new Date(r.ts).toLocaleString(), stratLabel(r.strategy), r.turn ? `turn ${r.turn} of the conversation` : null,
    r.success ? label(r.model) : "failed", r.latency_ms != null ? `${(r.latency_ms / 1000).toFixed(1)}s` : null,
    r.input_tokens != null ? `${r.input_tokens} in / ${r.output_tokens} out tokens` : null,
    r.cost_usd != null ? `${usd(r.cost_usd)} (judge ${usd(r.router_cost_usd)})` : null].filter(Boolean).join(" · ");
  add("Request", meta);
  add("Question", r.prompt);
  add("Judge decision", r.routing_reason ?? "No judge decision recorded for this strategy.");
  add(r.success ? `Answer from ${label(r.model)}` : "Error", r.success ? md(r.response ?? "(answer not logged; older request)") : (r.error ?? ""));
  $("detail").showModal();
}

$("closeDetail").onclick = () => $("detail").close();
$("detail").onclick = (e) => { if (e.target === $("detail")) $("detail").close(); };

$("reset").onclick = async () => {
  const passcode = prompt("Admin passcode to delete all logged requests:");
  if (passcode == null) return;
  const res = await api("/api/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode }) });
  if (!res.ok) alert((await res.json().catch(() => ({}))).error ?? "Reset failed");
  load();
};
init();
