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
    const cells = [
      new Date(r.ts).toLocaleTimeString(),
      r.prompt,
      r.success ? label(r.model) : `Error: ${r.error ?? ""}`,
      stratLabel(r.strategy),
      r.latency_ms != null ? `${(r.latency_ms / 1000).toFixed(1)}s` : "–",
      r.input_tokens != null ? `${r.input_tokens} / ${r.output_tokens}` : "–",
      usd(r.cost_usd),
    ];
    cells.forEach((v, i) => {
      const td = document.createElement("td");
      td.textContent = v;
      if (i === 1) { td.className = "snippet"; td.title = r.prompt; }
      if (i === 2 && r.success) {
        const dot = document.createElement("span"); dot.className = "dot"; dot.style.background = color(r.model);
        td.prepend(dot); td.title = r.routing_reason ? `Routing reason: ${r.routing_reason}` : "";
      }
      if (i >= 4) td.className = "num";
      tr.appendChild(td);
    });
    rows.appendChild(tr);
  }
}

$("reset").onclick = async () => {
  const passcode = prompt("Admin passcode to delete all logged requests:");
  if (passcode == null) return;
  const res = await api("/api/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode }) });
  if (!res.ok) alert((await res.json().catch(() => ({}))).error ?? "Reset failed");
  load();
};
init();
