// Página de opciones: categorías, canales en bloque, revisión automática, lista/EPG, modo producción,
// historial de caídas y copia de seguridad.
const $ = (id) => document.getElementById(id);
const S = { settings: { ...DEFAULT_SETTINGS }, favorites: [], categories: [], health: {}, healthMeta: {}, publish: {}, incidents: [], relay: {} };
const selected = new Set();

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const c of children) if (c != null && c !== false) n.append(c);
  return n;
}
const opt = (value, textContent) => el("option", { value, textContent });
function setText(b, text) { const sp = [...b.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()); if (sp) sp.textContent = text; else b.append(text); }
function flash(b, text) { const old = [...b.childNodes]; b.replaceChildren(icon("check"), text); b.classList.add("done"); setTimeout(() => { b.replaceChildren(...old); b.classList.remove("done"); }, 1400); }
function setStatus(id, text, cls = "") { const e = $(id); e.textContent = text; e.className = "status " + cls; }
function download(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
// armar un botón de "¿Seguro?" (dos clics) para acciones que borran
function armed(btn, label, fn) {
  btn.onclick = () => {
    if (btn.dataset.armed) { delete btn.dataset.armed; setText(btn, label); return fn(); }
    btn.dataset.armed = "1"; setText(btn, "¿Seguro?");
    setTimeout(() => { delete btn.dataset.armed; setText(btn, label); }, 2500);
  };
}
const saveFavs = () => chrome.storage.local.set({ favorites: S.favorites });
const saveCats = () => chrome.storage.local.set({ categories: S.categories });
const saveSettings = () => chrome.storage.local.set({ settings: S.settings });
function ago(ts) {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? "hace un momento" : s < 3600 ? `hace ${Math.floor(s / 60)} min` : s < 86400 ? `hace ${Math.floor(s / 3600)} h` : new Date(ts).toLocaleString();
}
const catOptions = (sel, withAll) => {
  const cur = sel.dataset.ready ? sel.value : withAll ? "*" : ""; // la primera vez: «Todas»
  sel.dataset.ready = "1";
  sel.replaceChildren(...(withAll ? [opt("*", "Todas las categorías")] : []), opt("", "Automática"), ...S.categories.map((c) => opt(c, c)));
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : withAll ? "*" : "";
};

// ---------- categorías ----------
let dragFrom = null;
function renderCats() {
  const ul = $("catList");
  ul.replaceChildren();
  if (!S.categories.length) ul.append(el("li", { className: "status", textContent: "Aún no tienes categorías propias. Tus canales van en las automáticas: En vivo, Grabados, Videos, YouTube." }));
  S.categories.forEach((c, i) => {
    const count = S.favorites.filter((f) => f.group === c).length;
    const name = el("input", { type: "text", value: c, maxLength: 40, title: "Cambiar el nombre" });
    name.onchange = async () => {
      const n = cleanTitle(name.value).slice(0, 40);
      if (!n || S.categories.some((x, j) => j !== i && x.toLowerCase() === n.toLowerCase())) { name.value = c; return; }
      S.categories[i] = n;
      S.favorites.forEach((f) => { if (f.group === c) f.group = n; });
      await saveCats(); await saveFavs();
    };
    const del = el("button", { className: "danger", title: "Borrar categoría" }, icon("trash"), "Borrar");
    armed(del, "Borrar", async () => {
      S.categories.splice(i, 1);
      S.favorites.forEach((f) => { if (f.group === c) f.group = ""; });
      await saveCats(); await saveFavs();
    });
    const li = el("li", { draggable: true }, el("span", { className: "handle", title: "Arrastra para ordenar" }, icon("grip")), name, el("span", { className: "n", textContent: count }), del);
    li.ondragstart = (e) => { dragFrom = i; li.classList.add("drag"); e.dataTransfer.effectAllowed = "move"; };
    li.ondragend = () => li.classList.remove("drag");
    li.ondragover = (e) => { e.preventDefault(); li.classList.add("over"); };
    li.ondragleave = () => li.classList.remove("over");
    li.ondrop = async (e) => {
      e.preventDefault(); li.classList.remove("over");
      if (dragFrom == null || dragFrom === i) return;
      const [m] = S.categories.splice(dragFrom, 1);
      S.categories.splice(i, 0, m);
      dragFrom = null;
      await saveCats();
    };
    ul.append(li);
  });
}
async function addCat() {
  const n = cleanTitle($("newCat").value).slice(0, 40);
  if (!n) return $("newCat").focus();
  if (!S.categories.some((c) => c.toLowerCase() === n.toLowerCase())) { S.categories.push(n); await saveCats(); }
  $("newCat").value = "";
}

// ---------- canales ----------
function healthCell(f) {
  const h = S.health[f.key];
  const d = (cls, text, title = "") => el("span", { className: "dot " + cls, title }, icon("dot", 10), text);
  if (f.kind === "youtube") return el("span", { className: "dot unk" }, "YouTube");
  if (!h) return d("unk", "Sin revisar");
  return h.ok ? d("ok", `Funciona${h.renewed ? " · renovado" : ""}`, ago(h.at)) : d("bad", "Caído", `${h.why} · ${ago(h.at)}`);
}
function renderChannels() {
  catOptions($("chanFilter"), true);
  catOptions($("bulkTarget"), false);
  const filter = $("chanFilter").value;
  const list = sortByCategory(S.favorites, S.categories).filter((f) => filter === "*" || (filter === "" ? !f.group : f.group === filter));
  for (const k of [...selected]) if (!S.favorites.some((f) => f.key === k)) selected.delete(k);
  const body = $("chanBody");
  body.replaceChildren();
  if (!list.length) body.append(el("tr", {}, el("td", { colSpan: 6, className: "status", textContent: "No hay canales aquí." })));
  for (const f of list) {
    const cb = el("input", { type: "checkbox", checked: selected.has(f.key) });
    cb.onchange = () => { cb.checked ? selected.add(f.key) : selected.delete(f.key); syncBulk(); };
    body.append(el("tr", {},
      el("td", {}, cb),
      el("td", {}, f.thumb ? el("img", { src: f.thumb, alt: "", loading: "lazy" }) : ""),
      el("td", { className: "nm", textContent: f.name, title: f.url }),
      el("td", { textContent: groupFor(f) + (f.group ? "" : " (auto)") }),
      el("td", {}, healthCell(f)),
      el("td", { className: "status", title: f.tvgId || "Sin identificador de guía" }, f.tvgId ? icon("check", 14) : "—")));
  }
  $("chkAll").checked = list.length > 0 && list.every((f) => selected.has(f.key));
  $("chkAll").onchange = () => { list.forEach((f) => ($("chkAll").checked ? selected.add(f.key) : selected.delete(f.key))); renderChannels(); };
  $("chanCount").textContent = `${list.length} canal(es)`;
  syncBulk();
}
function syncBulk() {
  const n = selected.size;
  $("btnBulkMove").disabled = $("btnBulkDel").disabled = !n;
  setText($("btnBulkMove"), n ? `Mover ${n}` : "Mover");
}

// ---------- revisión automática ----------
function renderHealth() {
  const m = S.healthMeta || {};
  const txt = m.running ? "Revisando…" : m.lastRun
    ? `Última revisión ${ago(m.lastRun)}: ${m.ok} funcionan · ${m.down} caído(s)` + (m.renewed ? ` · ${m.renewed} renovado(s)` : "")
    : "Aún no se ha revisado.";
  setStatus("healthStatus", txt, m.down ? "err" : m.lastRun ? "ok" : "");
  $("btnHealthNow").disabled = !!(m.running && Date.now() - (m.startedAt || 0) < 10 * 60e3);
}

// ---------- lista publicada ----------
function renderLinks() {
  const box = $("pubLinks");
  box.replaceChildren();
  const p = S.publish || {};
  if (!p.token || !p.link) { box.append(el("p", { className: "status", textContent: "Aún no has conectado GitHub. Hazlo en el popup: Guardados, «Link único de tu lista»." })); return; }
  const row = (label, value) => {
    const inp = el("input", { type: "text", value, readOnly: true, className: "grow" });
    inp.onclick = () => inp.select();
    const b = el("button", { title: "Copiar" }, icon("copy"), "Copiar");
    b.onclick = () => navigator.clipboard.writeText(value).then(() => flash(b, "¡Copiado!"));
    const o = el("button", { title: "Abrir" }, icon("external"), "Abrir");
    o.onclick = () => chrome.tabs.create({ url: value });
    return el("label", { className: "row" }, el("span", { textContent: label }), inp, b, o);
  };
  box.append(row("Link de la lista (M3U)", p.link));
  if (p.pageLink) box.append(row("Página para el celular", p.pageLink));
  else if (S.settings.mobilePage) box.append(el("p", { className: "status", textContent: "La página aparece al próximo publicar (cambia algo o usa «Actualizar ahora» en el popup)." }));
}

// ---------- historial ----------
const fmtDate = (ts) => new Date(ts).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "medium" });
function histList() {
  const f = $("histFilter").value;
  return S.incidents.filter((i) => f === "*" || (i.event || "") === f).sort((a, b) => b.start - a.start);
}
function renderHist() {
  const events = [...new Set(S.incidents.map((i) => i.event || ""))];
  const sel = $("histFilter"), cur = sel.value || "*";
  sel.replaceChildren(opt("*", "Todos los eventos"), ...events.map((e) => opt(e, e || "(sin evento)")));
  sel.value = events.includes(cur) || cur === "*" ? cur : "*";
  const list = histList();
  const total = list.reduce((a, i) => a + (i.duration || 0), 0);
  $("histSum").textContent = list.length ? `${list.length} caída(s) · ${fmtDuration(total)} sin señal en total` : "";
  const body = $("histBody");
  body.replaceChildren();
  if (!list.length) body.append(el("tr", {}, el("td", { colSpan: 5, className: "status", textContent: "Sin caídas registradas. Se anotan solas mientras un monitor está abierto." })));
  for (const i of list.slice(0, 300)) body.append(el("tr", {},
    el("td", { textContent: i.event || "—" }), el("td", { className: "nm", textContent: i.name, title: i.url }),
    el("td", { textContent: i.type, title: i.why || "" }), el("td", { textContent: fmtDate(i.start) }),
    el("td", { textContent: i.end ? fmtDuration(i.duration) : "sin cerrar" })));
  $("btnHistCsv").disabled = !list.length;
}
function histCsv() {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["Evento", "Canal", "Tipo", "Motivo", "Inicio", "Fin", "Duración (s)", "Duración", "URL"]];
  for (const i of histList().reverse()) rows.push([i.event || "", i.name, i.type, i.why || "", fmtDate(i.start), i.end ? fmtDate(i.end) : "", i.duration || "", i.end ? fmtDuration(i.duration) : "sin cerrar", i.url]);
  const f = $("histFilter").value;
  download("﻿" + rows.map((r) => r.map(q).join(";")).join("\r\n"), `reporte_caidas_${safeFile(f === "*" ? "todos" : f || "sin_evento")}.csv`, "text/csv");
}

// ---------- copia de seguridad ----------
function backup() {
  const settings = { ...S.settings };
  SECRET_SETTINGS.forEach((k) => delete settings[k]);
  const data = { app: "HLS Stream Detector", version: chrome.runtime.getManifest().version, exportedAt: new Date().toISOString(),
    favorites: S.favorites, categories: S.categories, settings };
  download(JSON.stringify(data, null, 2), `hls_copia_${new Date().toISOString().slice(0, 10)}.json`, "application/json");
  setStatus("backupStatus", `Copia descargada: ${S.favorites.length} canal(es), ${S.categories.length} categoría(s).`, "ok");
}
async function restore(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return setStatus("backupStatus", "Ese archivo no es una copia válida.", "err"); }
  if (!Array.isArray(data.favorites)) return setStatus("backupStatus", "Ese archivo no es una copia de HLS Stream Detector.", "err");
  const favs = data.favorites.filter((f) => f && f.url && f.key);
  const cats = (data.categories || []).filter((c) => typeof c === "string" && c.trim());
  const settings = { ...(data.settings || {}) };
  SECRET_SETTINGS.forEach((k) => delete settings[k]);
  if ($("restoreReplace").checked) {
    S.favorites = favs; S.categories = cats;
    S.settings = { ...DEFAULT_SETTINGS, ...settings, ...Object.fromEntries(SECRET_SETTINGS.map((k) => [k, S.settings[k]])) };
  } else {
    let added = 0;
    for (const f of favs) if (!S.favorites.some((x) => x.key === f.key)) { S.favorites.push(f); added++; }
    for (const c of cats) if (!S.categories.includes(c)) S.categories.push(c);
    setStatus("backupStatus", `Restaurado: ${added} canal(es) nuevo(s).`, "ok");
  }
  await chrome.storage.local.set({ favorites: S.favorites, categories: S.categories, settings: S.settings });
  if ($("restoreReplace").checked) setStatus("backupStatus", `Restaurado todo: ${S.favorites.length} canal(es), ${S.categories.length} categoría(s).`, "ok");
}

// ---------- ajustes ligados a campos ----------
function bindSettings() {
  const map = { optBraveKey: "braveKey", optSync: "syncOn", optRelay: "relayOn", optHealthEvery: "healthEvery", optHealthRenew: "healthRenew", optMobile: "mobilePage", optEpg: "epgUrl",
    optEvent: "eventName", optTgToken: "tgToken", optTgChat: "tgChat", optCmbPhone: "cmbPhone", optCmbKey: "cmbKey" };
  for (const [id, prop] of Object.entries(map)) {
    const e = $(id);
    if (e.type === "checkbox") e.checked = !!S.settings[prop];
    else e.value = S.settings[prop] ?? "";
    e.onchange = () => {
      S.settings[prop] = e.type === "checkbox" ? e.checked : prop === "healthEvery" ? +e.value : e.value.trim();
      saveSettings();
    };
  }
}

async function load() {
  const d = await chrome.storage.local.get(["settings", "favorites", "categories", "health", "healthMeta", "publish", "incidents", "relay", "syncMeta"]);
  S.relay = d.relay || {};
  S.syncMeta = d.syncMeta || {};
  S.braveStatus = (await chrome.storage.local.get("braveStatus")).braveStatus || {};
  S.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  S.favorites = d.favorites || []; S.categories = d.categories || []; S.health = d.health || {};
  S.healthMeta = d.healthMeta || {}; S.publish = d.publish || {}; S.incidents = d.incidents || [];
}
function renderRelay() {
  const r = S.relay || {};
  if (!S.publish.token) return setStatus("relayStatus", "Primero conecta GitHub en el popup → Guardados.", "err");
  if (!S.settings.relayOn) return setStatus("relayStatus", "Apagado.");
  const parts = [r.lastCheck ? `Última revisión ${ago(r.lastCheck)}` : "Aún sin revisar", r.pending ? `${r.pending} encargo(s) pendiente(s)` : "",
    r.lastJob ? `último encargo: ${r.lastJob.what} (${r.lastJob.found} link(s)) ${ago(r.lastJob.at)}` : ""].filter(Boolean);
  setStatus("relayStatus", r.lastError ? "Error: " + r.lastError : parts.join(" · "), r.lastError ? "err" : r.lastCheck ? "ok" : "");
}
function renderSync() {
  const m = S.syncMeta || {};
  if (!S.publish.token) return setStatus("syncStatus", "Primero conecta GitHub en el popup → Guardados.", "err");
  if (!S.settings.syncOn) return setStatus("syncStatus", "Apagada.");
  setStatus("syncStatus", m.error ? "Error: " + m.error : m.lastSync ? `Sincronizado ${ago(m.lastSync)} · ${m.count} canal(es)` : "Aún sin sincronizar", m.error ? "err" : m.lastSync ? "ok" : "");
}
function renderBrave() {
  const b = S.braveStatus || {};
  if (!S.settings.braveKey) return setStatus("braveStatus", "Sin clave: se usa DuckDuckGo/Bing.");
  setStatus("braveStatus", b.error ? "Error: " + b.error : b.ok ? `Funcionando · última búsqueda ${ago(b.at)}` : "Clave guardada · se usará en la próxima búsqueda que llegue a la web.", b.error ? "err" : b.ok ? "ok" : "");
}
function renderAll() { renderBrave(); renderCats(); renderChannels(); renderHealth(); renderLinks(); renderHist(); renderRelay(); renderSync(); }

document.addEventListener("DOMContentLoaded", async () => {
  hydrateIcons();
  await load();
  bindSettings();
  renderAll();

  $("btnAddCat").onclick = addCat;
  $("newCat").onkeydown = (e) => { if (e.key === "Enter") addCat(); };
  $("chanFilter").onchange = renderChannels;
  $("btnBulkMove").onclick = async () => {
    const g = $("bulkTarget").value;
    S.favorites.forEach((f) => { if (selected.has(f.key)) f.group = g; });
    selected.clear(); await saveFavs();
  };
  armed($("btnBulkDel"), "Borrar", async () => {
    S.favorites = S.favorites.filter((f) => !selected.has(f.key));
    selected.clear(); await saveFavs();
  });
  $("btnHealthNow").onclick = () => { $("btnHealthNow").disabled = true; setStatus("healthStatus", "Revisando…"); chrome.runtime.sendMessage({ action: "runHealth" }); };
  $("btnGuide").onclick = async () => {
    setStatus("guideStatus", "Buscando en el directorio…");
    const r = await chrome.runtime.sendMessage({ action: "assignGuide" }).catch((e) => ({ error: e.message }));
    if (r?.error) setStatus("guideStatus", r.error, "err");
    else setStatus("guideStatus", r.assigned ? `Listo: ${r.assigned} canal(es) con guía.` : "No encontré coincidencias claras para los que faltan.", r.assigned ? "ok" : "");
  };
  $("btnTestAlert").onclick = async () => {
    setStatus("alertStatus", "Enviando…");
    const r = await chrome.runtime.sendMessage({ action: "remoteAlert",  text: "Prueba de alertas de HLS Stream Detector" }).catch((e) => ({ errors: [e.message] }));
    const ok = r?.sent?.length ? `Enviado por ${r.sent.join(" y ")}.` : "";
    setStatus("alertStatus", [ok, ...(r?.errors || [])].filter(Boolean).join(" · "), r?.errors?.length ? "err" : "ok");
  };
  $("btnHistCsv").onclick = histCsv;
  $("btnSyncNow").onclick = async () => { setStatus("syncStatus", "Sincronizando…"); await chrome.runtime.sendMessage({ action: "syncNow" }).catch(() => {}); };
  $("btnRelayNow").onclick = async () => { setStatus("relayStatus", "Revisando…"); await chrome.runtime.sendMessage({ action: "relayNow" }).catch(() => {}); };
  $("histFilter").onchange = renderHist;
  armed($("btnHistClear"), "Borrar historial", () => chrome.storage.local.set({ incidents: [] }));
  $("btnBackup").onclick = backup;
  $("btnRestore").onclick = () => $("fileRestore").click();
  $("fileRestore").onchange = async (e) => { const f = e.target.files[0]; if (f) await restore(f); e.target.value = ""; };

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    await load();
    if (changes.settings) bindSettings();
    renderAll();
  });
  setInterval(renderHealth, 30000);
});
