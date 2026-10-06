// Informe del Grabador de pasos (lib/recorder.js + content.js): lo que hiciste a mano, paso a paso, en texto
// listo para pegar en el chat. Los dominios se tapan aquí (no al grabar) para que elijas qué se ve.
const $ = (id) => document.getElementById(id);
let RECS = [], cur = null;
const ts = (ms) => { const s = Math.max(0, ms || 0) / 1000; return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`; };
const dur = (ms) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`; };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const domOf = (x) => baseDomain(String(x || "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#:].*$/, ""));

// ---------- tapar dominios ----------
function makeMask(rec, o) {
  const pairs = [], done = new Set();
  const add = (dom, name) => {
    if (!dom || done.has(dom)) return; done.add(dom);
    pairs.push({ re: new RegExp(esc(dom), "gi"), to: name + ".com", dom, name });
    const label = dom.split(".")[0];
    if (label.length >= 4) pairs.push({ re: new RegExp(esc(label), "gi"), to: name }); // también en títulos, rutas y links codificados
  };
  if (o.mine) add(domOf(hostOf(rec.startUrl)), "misitio");
  o.extra.forEach((d, i) => add(domOf(d), "otrositio" + (i + 1)));
  if (o.all) {
    let n = 0;
    for (const e of rec.events) for (const u of [e.url, e.at, e.href, ...(e.redir || []), ...(e.ifr || [])]) { const h = domOf(hostOf(u || "")); if (h && !done.has(h)) add(h, "dominio" + ++n); }
    for (const h of Object.keys(rec.segs || {})) { const d = domOf(h); if (d && !done.has(d)) add(d, "dominio" + ++n); }
  }
  pairs.sort((a, b) => b.re.source.length - a.re.source.length); // primero los más largos (sub.dominio antes que su nombre)
  const M = (s) => { s = String(s ?? ""); for (const p of pairs) s = s.replace(p.re, p.to); return s; };
  M.list = pairs.filter((p) => p.dom).map((p) => `${p.name}.com`);
  return M;
}

// ---------- texto del informe ----------
const USER = new Set(["start", "click", "select", "submit", "enter", "note"]);
const where = (e, M) => (e.top === false ? `dentro del iframe ${M(hostOf(e.at))}` : "en la página principal");
const vDesc = (e, M) => {
  const src = !e.src ? "sin fuente" : /^blob:/i.test(e.src) ? "blob: (el reproductor arma el video con una lista pedida por red)" : M(e.src);
  return `${e.w && e.h ? e.w + "×" + e.h + " · " : ""}${e.dur === -1 ? "EN VIVO · " : e.dur ? "dura " + dur(e.dur * 1000) + " · " : ""}${e.muted ? "silenciado · " : ""}fuente: ${src}`;
};
function stepHead(e, M) {
  const P = `[P${e.p || 1}]`;
  switch (e.k) {
    case "start": return `EMPECÉ A GRABAR ${P} en ${M(e.url)}${e.title ? ` «${M(e.title)}»` : ""}`;
    case "click": {
      const L = [`CLIC ${P} ${where(e, M)}${e.text ? ` en «${M(e.text)}»` : ""}`, `elemento: ${M(e.el)}`];
      if (e.hit) L.push(`tocaste justo: ${M(e.hit)}`);
      if (e.up?.length) L.push(`dentro de: ${e.up.map(M).join(" ⟵ ")}`);
      if (e.path) L.push(`ruta: ${M(e.path)}`);
      if (e.href) L.push(`enlace: ${M(e.href)}${e.target ? ` (target=${e.target})` : ""}`);
      if (e.sib) L.push(`es la opción ${e.sib.i} de ${e.sib.n}: ${e.sib.list.map((s) => `«${M(s)}»`).join(" · ")}`);
      if (e.box) L.push(`clic en ${e.x},${e.y} (pantalla ${e.vw}×${e.vh}) · elemento ${e.box.w}×${e.box.h} en ${e.box.x},${e.box.y}${e.cover ? " · CUBRE casi toda la pantalla (capa encima del reproductor)" : ""} · había ${e.nv} video(s) y ${e.nf} iframe(s)`);
      if (e.block) L.push(`código del bloque: ${M(e.block)}`);
      return L.join("\n      ");
    }
    case "select": return `ELEGISTE «${M(e.text)}» en una lista ${P} ${where(e, M)}\n      lista: ${M(e.el)} · valor: ${M(e.value)}\n      opciones: ${(e.opts || []).map((s) => `«${M(s)}»`).join(" · ")}`;
    case "submit": return `ENVIASTE UN FORMULARIO ${P} ${where(e, M)}: ${e.method} ${M(e.action)}\n      campos: ${(e.fields || []).map(M).join(" & ")}`;
    case "enter": return `ESCRIBISTE «${M(e.value)}» Y PRESIONASTE ENTER ${P} ${where(e, M)}\n      campo: ${M(e.el)}`;
    case "note": return `TU NOTA: ${M(e.text)}`;
  }
  return e.k;
}
function line(e, M) {
  const P = e.p ? `[P${e.p}] ` : "";
  const st = e.err ? ` → FALLÓ (${e.err})` : e.st ? ` → ${e.st}${e.ct ? " " + e.ct : ""}` : "";
  const rd = e.redir?.length ? `\n          redirige a: ${e.redir.map(M).join(" → ")}` : "";
  const bd = e.body ? `\n          datos enviados: ${M(e.body.length > 400 ? e.body.slice(0, 400) + "…" : e.body)}` : "";
  const by = e.from && !/^\d+$/.test(String(e.from)) ? ` (lo pide ${M(hostOf(e.from) || e.from)})` : "";
  switch (e.k) {
    case "nav": return `${P}abre la página ${M(e.url)}${e.method && e.method !== "GET" ? ` (${e.method})` : ""}${st}${rd}${bd}`;
    case "frame": return `${P}carga un iframe ${M(e.url)}${by}${st}${rd}`;
    case "frame-ad": return `${P}iframe de publicidad/estadísticas: ${M(hostOf(e.url))}`;
    case "xhr": return `${P}red ${e.method} ${M(e.url)} (${e.type === "xmlhttprequest" ? "xhr/fetch" : e.type})${by}${st}${rd}${bd}`;
    case "media": return `${P}VIDEO/LISTA pedido: ${M(e.url)}${by}${st}${rd}`;
    case "seg": return `${P}empiezan a llegar pedazos de video desde ${M(hostOf(e.url))} (ej.: ${M(e.url)})${st}`;
    case "page": return `${P}página cargada ${e.top ? "(principal)" : "(iframe)"}: ${M(e.url)}${e.title ? ` «${M(e.title)}»` : ""} · ${e.nv} video(s), ${e.nf} iframe(s)${e.ifr?.length ? `\n          iframes: ${e.ifr.map(M).join(" | ")}` : ""}`;
    case "tab-new": return `${P}se abrió una PESTAÑA NUEVA desde P${e.from}${e.url ? `: ${M(e.url)}` : ""}`;
    case "tab-close": return `${P}pestaña cerrada`;
    case "tab-switch": return `${P}queda a la vista la pestaña P${e.p}`;
    case "v-play": return `${P}▶ el video arranca ${where(e, M)} · ${vDesc(e, M)}`;
    case "v-ok": return `${P}✔ EL VIDEO AVANZA (${e.progress} s reproducidos) ${where(e, M)} · ${vDesc(e, M)}`;
    case "v-err": return `${P}✖ ERROR DEL VIDEO (código ${e.code}${e.msg ? ": " + M(e.msg) : ""}) ${where(e, M)} · ${vDesc(e, M)}`;
  }
  return `${P}${e.k}`;
}
function build(rec, o) {
  const M = makeMask(rec, o), ev = rec.events || [], out = [];
  out.push(`INFORME DE PASOS · Grabador de la extensión HLS Stream Detector v${rec.ver || "?"}`);
  out.push(`Grabado: ${new Date(rec.startedAt).toLocaleString("es-CO")} · duración ${dur((rec.endedAt || Date.now()) - rec.startedAt)} · ${rec.nTabs || 1} pestaña(s) · ${ev.length} eventos${rec.full ? " (se llenó: lo último no quedó)" : ""}${rec.stopReason && rec.stopReason !== "manual" ? ` · se detuvo: ${rec.stopReason}` : ""}`);
  out.push(`Página inicial: ${M(rec.startUrl)}`);
  if (M.list.length) out.push(`Dominios tapados: ${M.list.join(", ")}`);
  out.push("Leyenda: [P1] = pestaña 1 · PASO = lo que hiciste tú · ↳ = lo que pasó después (red, iframes, pestañas, reproductor)");
  let n = 0;
  const stepAt = [];
  for (const e of ev) {
    if (USER.has(e.k)) { n++; out.push("", `PASO ${n} · ${ts(e.t)} · ${stepHead(e, M)}`); }
    else out.push(`   ↳ ${ts(e.t)} ${line(e, M)}`);
    stepAt.push(n);
  }
  // ---------- resumen ----------
  out.push("", "==================== RESUMEN ====================");
  const oks = ev.map((e, i) => [e, stepAt[i]]).filter(([e]) => e.k === "v-ok");
  out.push(oks.length ? `Videos que AVANZARON de verdad (${oks.length}):` : "Ningún video llegó a avanzar mientras grababas.");
  for (const [e, s] of oks) {
    const lists = ev.filter((x) => x.k === "media" && x.p === e.p && x.t <= e.t && /\.(m3u8|mpd)(\?|#|$)|mpegurl|dash/i.test(x.url + " " + (x.ct || ""))).slice(-2);
    out.push(`  · tras el PASO ${s} (${ts(e.t)}) ${where(e, M)} · ${vDesc(e, M)}${lists.length ? `\n      listas que se pidieron justo antes: ${lists.map((x) => M(x.url)).join(" | ")}` : ""}`);
  }
  const media = [...new Map(ev.filter((e) => e.k === "media").map((e) => [e.url, e])).values()];
  if (media.length) { out.push(`Listas y videos que pidió la página (${media.length}):`); for (const e of media) out.push(`  · ${ts(e.t)} [P${e.p}] ${M(e.url)}${e.err ? ` → FALLÓ (${e.err})` : e.st ? ` → ${e.st}` : ""}`); }
  const errs = ev.filter((e) => e.k === "v-err");
  if (errs.length) { out.push(`Errores del reproductor (${errs.length}):`); for (const e of errs) out.push(`  · ${ts(e.t)} código ${e.code} ${where(e, M)}`); }
  const tabs = ev.filter((e) => e.k === "tab-new");
  if (tabs.length) {
    out.push(`Pestañas nuevas (${tabs.length}):`);
    for (const e of tabs) { const c = ev.find((x) => x.k === "tab-close" && x.p === e.p); out.push(`  · P${e.p} desde P${e.from}${e.url ? ": " + M(e.url) : ""}${c ? ` · cerrada a los ${dur(c.t - e.t)}` : " · quedó abierta"}`); }
  }
  const segs = Object.entries(rec.segs || {});
  if (segs.length) out.push(`Pedazos de video recibidos: ${segs.map(([h, k]) => `${M(h)} (${k})`).join(" · ")}`);
  const notes = ev.filter((e) => e.k === "note");
  if (notes.length) { out.push("Tus notas:"); for (const e of notes) out.push(`  · ${ts(e.t)} ${M(e.text)}`); }
  return out.join("\n");
}

// ---------- pantalla ----------
const opts = () => ({ mine: $("mine").checked, all: $("all").checked, extra: $("extra").value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) });
function show() {
  if (!cur) { $("out").value = ""; $("stats").textContent = ""; return; }
  $("out").value = build(cur, opts());
  const ev = cur.events || [];
  $("stats").textContent = `${ev.filter((e) => USER.has(e.k)).length} pasos · ${ev.length} eventos · ${ev.filter((e) => e.k === "v-ok").length} video(s) que avanzaron`;
}
async function load() {
  const { recordings = [], recMaskExtra = "" } = await chrome.storage.local.get(["recordings", "recMaskExtra"]);
  RECS = recordings;
  if (document.activeElement !== $("extra")) $("extra").value = recMaskExtra;
  const want = location.hash.slice(1);
  cur = RECS.find((r) => r.id === (cur?.id || want)) || RECS[0] || null;
  $("sel").replaceChildren(...RECS.map((r) => {
    const o = document.createElement("option"); o.value = r.id; o.selected = r === cur;
    let h = ""; try { h = new URL(r.startUrl).host; } catch {}
    o.textContent = `${new Date(r.startedAt).toLocaleString("es-CO")} · ${opts().mine ? "misitio" : h} · ${dur((r.endedAt || r.startedAt) - r.startedAt)}`;
    return o;
  }));
  $("ctl").hidden = !cur;
  if (!cur) { $("out").value = "Todavía no hay informes. En el popup de la extensión toca ● (Grabar pasos), haz a mano lo que harías para ver el video y toca «Detener y ver informe»."; return; }
  show();
}
$("sel").onchange = () => { cur = RECS.find((r) => r.id === $("sel").value) || null; location.hash = cur?.id || ""; show(); };
for (const id of ["mine", "all"]) $(id).onchange = () => { show(); load(); };
let saveT = 0;
$("extra").oninput = () => { show(); clearTimeout(saveT); saveT = setTimeout(() => chrome.storage.local.set({ recMaskExtra: $("extra").value }), 600); };
const flash = (b, t) => { const o = b.textContent; b.textContent = t; b.classList.add("done"); setTimeout(() => { b.textContent = o; b.classList.remove("done"); }, 1400); };
$("copy").onclick = async () => { try { await navigator.clipboard.writeText($("out").value); flash($("copy"), "Copiado ✓"); } catch { $("out").select(); document.execCommand("copy"); flash($("copy"), "Copiado ✓"); } };
$("dl").onclick = () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([$("out").value], { type: "text/plain;charset=utf-8" }));
  a.download = `informe-pasos-${new Date(cur.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$("del").onclick = async () => {
  if (!cur || !confirm("¿Borrar este informe? No se puede recuperar.")) return;
  const { recordings = [] } = await chrome.storage.local.get("recordings");
  await chrome.storage.local.set({ recordings: recordings.filter((r) => r.id !== cur.id) });
  cur = null; location.hash = ""; load();
};
chrome.storage.onChanged.addListener((c, a) => { if (a === "local" && c.recordings) load(); });
load();
