const $ = (id) => document.getElementById(id);
let cfg, sessionId, history = [], busy = false;
let totals = { actual: 0, baseline: 0 };

function newSession() {
  sessionId = crypto.randomUUID();
  try { sessionStorage.setItem("sessionId", sessionId); } catch {}
  history = []; totals = { actual: 0, baseline: 0 };
  $("log").innerHTML = ""; $("log").appendChild(emptyEl); renderTotals();
}
const emptyEl = $("empty");
const usd = (n) => (n == null ? "–" : n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(4)}`);

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
  const sel = $("strategy");
  for (const s of cfg.strategies) sel.add(new Option(s.label, s.id));
  try { const saved = localStorage.getItem("strategy"); if (saved) sel.value = saved; } catch {}
  sel.title = cfg.strategies.find((s) => s.id === sel.value)?.description ?? "";
  sel.onchange = () => {
    sel.title = cfg.strategies.find((s) => s.id === sel.value)?.description ?? "";
    try { localStorage.setItem("strategy", sel.value); } catch {}
  };
  const list = $("demoList");
  for (const level of ["easy", "medium", "hard"]) {
    const h = document.createElement("h3"); h.textContent = level; list.appendChild(h);
    for (const q of cfg.demoQuestions.filter((q) => q.level === level)) {
      const b = document.createElement("button"); b.className = "q"; b.textContent = q.text;
      b.onclick = () => { $("demoDialog").close(); send(q.text); };
      list.appendChild(b);
    }
  }
  try { sessionId = sessionStorage.getItem("sessionId"); } catch {}
  if (!sessionId) newSession();
}

function renderTotals() {
  $("tActual").textContent = usd(totals.actual);
  $("tBaseline").textContent = usd(totals.baseline);
  const pct = totals.baseline > 0 ? (1 - totals.actual / totals.baseline) * 100 : 0;
  $("tSaved").textContent = `${pct.toFixed(0)}%`;
}

function bubble(role, text) {
  emptyEl.remove();
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  $("log").appendChild(el);
  $("log").scrollTop = $("log").scrollHeight;
  return el;
}

function pill(model, reason) {
  const m = cfg.models[model];
  const p = document.createElement("span");
  p.className = "pill";
  p.style.background = m?.color ?? "#777";
  p.textContent = m?.label ?? model ?? "unknown model";
  p.title = reason ? `Routing reason: ${reason}` : "Switchyard did not expose a per-request reason for this strategy";
  return p;
}

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true; $("send").disabled = true;
  bubble("user", text);
  history.push({ role: "user", content: text });
  const out = bubble("assistant", "");
  const textNode = document.createElement("div"); textNode.className = "typing"; out.appendChild(textNode);
  const tag = document.createElement("div"); tag.className = "tag"; tag.textContent = "Haiku judge is choosing a model…"; out.appendChild(tag);
  let answer = "";
  const strategy = $("strategy").value;

  try {
    const res = await api("/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, strategy, messages: history }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(frame)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? "{}");
        if (ev === "meta") { tag.textContent = ""; tag.appendChild(pill(data.model)); tag.append(" answering…"); }
        else if (ev === "delta") { answer += data.text; textNode.textContent = answer; $("log").scrollTop = $("log").scrollHeight; }
        else if (ev === "error") throw new Error(data.message);
        else if (ev === "done") {
          tag.textContent = "";
          tag.appendChild(pill(data.model, data.reason));
          const bits = [`${(data.latencyMs / 1000).toFixed(1)}s`, `${data.inputTokens} in / ${data.outputTokens} out tokens`,
            data.routerCostUsd ? `${usd(data.costUsd)} (incl. judge ${usd(data.routerCostUsd)})` : `${usd(data.costUsd)}`,
            `Opus would cost ${usd(data.baselineUsd)}`];
          if (data.stopReason === "max_tokens") bits.push(`cut off at ${cfg.maxTokens} tokens`);
          if (data.empty) textNode.textContent = "(The model used its whole token budget thinking and returned no text.)";
          tag.append(bits.join(" · "));
          if (data.reason) {
            const judge = document.createElement("div");
            judge.className = "judge";
            judge.textContent = `⚖ ${data.reason}`;
            out.appendChild(judge);
          }
          totals.actual += data.costUsd ?? 0; totals.baseline += data.baselineUsd ?? 0; renderTotals();
        }
      }
    }
    history.push({ role: "assistant", content: answer || "(no text)" });
  } catch (err) {
    out.classList.add("error");
    textNode.textContent = `Error: ${err.message}`;
    tag.textContent = "";
    history.pop(); // drop the unanswered user turn so the conversation stays valid
  } finally {
    textNode.classList.remove("typing");
    busy = false; $("send").disabled = false;
  }
}

$("form").onsubmit = (e) => { e.preventDefault(); const t = $("input").value; $("input").value = ""; send(t); };
$("input").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("form").requestSubmit(); } };
$("demoBtn").onclick = () => $("demoDialog").showModal();
$("closeDemo").onclick = () => $("demoDialog").close();
$("newBtn").onclick = newSession;
init();
