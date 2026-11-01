// HLS Stream Detector · EXPLORAR UN SITIO (1-nov-2026)
// El «Explorar un sitio» del Detector de NOVA, dentro de tu extensión. Corre en TU Chrome: lee el sitio con tu
// internet y con tu sesión (si el sitio pide iniciar sesión, basta con haber entrado en Chrome).
//   1) Abrir sitio → sus categorías (el mismo detector de NOVA: lib/x4.js, sin reglas por sitio)
//   2) Leer títulos de las categorías que elijas (con sus páginas)
//   3) a) «Sacar links»: cada título se abre en una pestaña de fondo, se le da play (y si hace falta se prueban
//         sus servidores) y el video queda en Guardados con su categoría y su página (para renovarlo solo).
//      b) «Descargar .m3u»: la lista con lo sacado, agrupada por categoría.
//      c) «Enviar a NOVA»: el sitio con sus categorías y títulos al catálogo de NOVA (NOVA saca el link al dar play),
//         los links sacados a tus favoritos y, si quieres, tu sesión del sitio.
"use strict";
const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "class") n.className = v;
    else if (k in n && typeof v !== "string") n[k] = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(9)) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
  return n;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOT_WALL = /(just a moment|checking your browser|cf-browser-verification|challenge-platform|attention required|ddos-guard|un momento\.\.\.)/i;
const SERIES = /\b(series?|animes?|doramas?|novelas?|telenovelas?|temporadas?)\b/i;
const SERIES_URL = /\/(series?|tvshows?|tv-shows?|animes?|doramas?|temporadas?)\//i;
const ST = { site: "", name: "", cats: [], sel: new Set(), lists: new Map(), off: new Set(), cap: new Map(), running: false, stop: false, tabs: new Set(), more: new Set(), filter: "" };
const baseDom = (h) => { h = String(h || "").toLowerCase().replace(/^www\./, ""); const p = h.split("."); return p.length > 2 && /^(com|net|org|co|gob|edu)$/.test(p[p.length - 2]) && p[p.length - 1].length === 2 ? p.slice(-3).join(".") : p.slice(-2).join("."); };
const siteDom = () => { try { return baseDom(new URL(ST.site).hostname); } catch { return ""; } };
const msg = (id, t, cls = "") => { const n = $(id); n.className = "msg " + cls; n.textContent = t || ""; };
const getSettings = async () => ({ ...DEFAULT_SETTINGS, ...((await chrome.storage.local.get("settings")).settings || {}) });
const nova = async () => { const s = await getSettings(); const u = (s.tvUrl || "").trim().replace(/\/+$/, ""), k = (s.tvKey || "").trim(); return u && k ? { u, k } : null; };

// ---------------------------------------------------------------- leer páginas (con tu sesión)
async function waitLoad(tabId, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await chrome.tabs.get(tabId)).status === "complete") return true; } catch { return false; } await sleep(400); }
  return false;
}
async function renderedHtml(url, wait = 4500) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false }); ST.tabs.add(tab.id);
    chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
    await waitLoad(tab.id); await sleep(wait);
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ html: document.documentElement.outerHTML, url: location.href }) });
    return r?.result || null;
  } catch { return null; }
  finally { if (tab) { chrome.tabs.remove(tab.id).catch(() => {}); ST.tabs.delete(tab.id); chrome.storage.session.remove("tab:" + tab.id).catch(() => {}); } }
}
async function fetchPage(url) {
  let html = "", fin = url, status = 0;
  try { const r = await fetch(url, { credentials: "include", redirect: "follow", cache: "no-store" }); status = r.status; fin = r.url || url; html = await r.text(); } catch {}
  const links = (html.match(/<a\b/gi) || []).length;
  if (!html || links < 15 || BOT_WALL.test(html.slice(0, 20000))) { // página armada con JavaScript o con verificación: se abre de verdad
    const r2 = await renderedHtml(url);
    if (r2 && (r2.html.match(/<a\b/gi) || []).length > links) return { ...r2, status: 200, via: "pestaña" };
  }
  return html ? { html, url: fin, status, via: "lectura" } : null;
}

// ---------------------------------------------------------------- 1) abrir el sitio → categorías
async function openSite() {
  let site = $("site").value.trim(); if (!site) return $("site").focus();
  if (!/^https?:\/\//i.test(site)) site = "https://" + site;
  try { site = new URL(site).href; } catch { return msg("siteMsg", "Esa dirección no es válida.", "bad"); }
  Object.assign(ST, { site, name: "", cats: [], sel: new Set(), lists: new Map(), off: new Set(), cap: new Map(), more: new Set() });
  $("site").value = site; history.replaceState(null, "", "?u=" + encodeURIComponent(site));
  $("cCats").hidden = $("cTitles").hidden = $("bar").hidden = true;
  $("open").disabled = true; msg("siteMsg", "Leyendo el sitio…");
  const pg = await fetchPage(site);
  $("open").disabled = false;
  if (!pg) return msg("siteMsg", "El sitio no respondió. Ábrelo en una pestaña para ver si carga (o si pide iniciar sesión).", "bad");
  if (BOT_WALL.test(pg.html.slice(0, 20000))) return msg("siteMsg", "El sitio muestra una verificación de robots. Ábrelo en una pestaña, pasa la verificación y vuelve a tocar «Abrir sitio».", "warn");
  const A = X4.analyzeList(pg.html, pg.url);
  const title = (pg.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  ST.name = cleanTitle(title.replace(/&amp;/g, "&").split(/[|·–—-]/)[0]) || new URL(site).hostname.replace(/^www\./, "");
  const seen = new Set();
  ST.cats = [{ url: pg.url, name: "Portada", home: true, titles: A.contents || [] },
    ...(A.categories || []).filter((c) => !seen.has(c.url) && seen.add(c.url) && c.url !== pg.url)];
  ST.lists.set(pg.url, { url: pg.url, name: "Portada", titles: (A.contents || []).slice(), seen: new Set((A.contents || []).map((t) => t.url)), page: 1, next: A.pagination?.next || "", done: true });
  const pw = /<input[^>]+type=["']?password/i.test(pg.html);
  msg("siteMsg", `${ST.name}: ${ST.cats.length - 1} categorías y ${(A.contents || []).length} títulos en la portada${pg.via === "pestaña" ? " (leído abriendo la página)" : ""}.` +
    (pw ? " Ojo: la página muestra un formulario de inicio de sesión; si no ves todo, entra al sitio en Chrome y vuelve a abrirlo aquí." : ""), pw ? "warn" : "ok");
  drawCats(); sessionRow();
  if (ST.cats.length < 2 && !(A.contents || []).length) msg("siteMsg", "No reconocí categorías ni títulos en este sitio.", "bad");
}
function drawCats() {
  $("cCats").hidden = false;
  $("catsLbl").textContent = `Categorías del sitio (${ST.cats.length})`;
  const box = $("cats"); box.replaceChildren();
  let lastG = null;
  for (const c of ST.cats) {
    const g = c.home ? "" : c.group || "";
    if (g !== lastG && g) box.append(el("span", { class: "lbl group-lbl" }, g));
    lastG = g;
    const L = ST.lists.get(c.url), on = ST.sel.has(c.url);
    const cb = el("input", { type: "checkbox", checked: on, onchange: () => { if (cb.checked) ST.sel.add(c.url); else ST.sel.delete(c.url); drawCats(); drawTitles(); } });
    box.append(el("label", { class: "cat" + (on ? " on" : "") }, cb, c.name, L?.titles?.length ? el("small", {}, String(L.titles.length)) : null));
  }
}

// ---------------------------------------------------------------- 2) leer títulos (con sus páginas)
async function readCat(c, more = false) {
  const L = ST.lists.get(c.url) || { url: c.url, name: c.name, titles: [], seen: new Set(), page: 0, next: c.url, done: false };
  ST.lists.set(c.url, L);
  if (L.done && !more) return;
  const max = (+$("pages").value || 200) + (more ? L.page : 0), skip = ST.cats.map((x) => x.url);
  let url = more ? L.next : L.next || c.url;
  L.busy = true; drawTitles();
  while (url && L.page < max && !ST.stop) {
    const pg = await fetchPage(url);
    if (!pg) { L.err = "no respondió"; break; }
    const A = X4.analyzeList(pg.html, pg.url, { skip });
    const got = (A.contents || []).filter((t) => !L.seen.has(t.url) && !skip.includes(t.url));
    for (const t of got) { L.seen.add(t.url); L.titles.push(t); }
    L.page++; url = got.length ? A.pagination?.next || "" : "";
    drawTitles(); drawCats();
  }
  L.next = url; L.busy = false; L.done = true; drawTitles(); drawCats();
}
async function readSelected() {
  const cats = ST.cats.filter((c) => ST.sel.has(c.url));
  if (!cats.length) return msg("readMsg", "Elige al menos una categoría.", "bad");
  ST.stop = false; $("read").disabled = true; msg("readMsg", "Leyendo títulos…"); $("cTitles").hidden = false; $("bar").hidden = false;
  const q = cats.slice();
  await Promise.all([0, 1].map(async () => { while (q.length && !ST.stop) await readCat(q.shift()); }));
  $("read").disabled = false;
  const n = cats.reduce((a, c) => a + (ST.lists.get(c.url)?.titles.length || 0), 0);
  msg("readMsg", `${n} títulos en ${cats.length} categoría(s).`, "ok"); drawTitles();
}

// ---------------------------------------------------------------- pantalla de títulos
const isSeries = (c, t) => SERIES.test(c.name) || SERIES_URL.test(t?.url || "");
const selectedTitles = () => {
  const out = [], seen = new Set();
  for (const c of ST.cats) if (ST.sel.has(c.url)) for (const t of ST.lists.get(c.url)?.titles || []) if (!ST.off.has(t.url) && !seen.has(t.url)) { seen.add(t.url); out.push({ t, c }); }
  return out;
};
const CAPTXT = { wait: "En cola", busy: "Buscando", ok: "Listo", bad: "Sin video", skip: "Serie" };
function card(t, c) {
  const cap = ST.cap.get(t.url), off = ST.off.has(t.url);
  const cb = el("input", { type: "checkbox", checked: !off, title: "Incluir", onclick: (e) => e.stopPropagation(), onchange: () => { if (cb.checked) ST.off.delete(t.url); else ST.off.add(t.url); drawTitles(); } });
  const ph = el("div", { class: "ph" }, t.poster ? el("img", { src: t.poster, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onerror: (e) => e.target.replaceWith(icon("play", 22)) }) : icon("play", 22));
  return el("div", { class: "t" + (off ? " off" : ""), title: cap?.why || t.url, onclick: () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); } },
    ph, cb, cap ? el("span", { class: "st " + cap.st }, cap.txt || CAPTXT[cap.st]) : null,
    el("b", {}, t.name), t.year || cap?.server ? el("small", {}, [t.year, cap?.server].filter(Boolean).join(" · ")) : null);
}
let drawT = 0;
function drawTitles() { if (!drawT) drawT = requestAnimationFrame(() => { drawT = 0; paintTitles(); }); }
function paintTitles() {
  const f = ST.filter.toLowerCase(), secs = [];
  const cats = ST.cats.filter((c) => ST.sel.has(c.url));
  for (const c of cats) {
    const L = ST.lists.get(c.url); if (!L) continue;
    const list = L.titles.filter((t) => !f || t.name.toLowerCase().includes(f));
    const onN = L.titles.filter((t) => !ST.off.has(t.url)).length;
    const all = el("input", { type: "checkbox", checked: onN === L.titles.length && onN > 0, title: "Todos / ninguno",
      onchange: (e) => { for (const t of L.titles) if (e.target.checked) ST.off.delete(t.url); else ST.off.add(t.url); drawTitles(); } });
    const cap = ST.more.has(c.url) ? list : list.slice(0, 240);
    secs.push(el("section", { class: "sec" },
      el("div", { class: "sec-h" }, all, el("h2", {}, c.name), el("span", { class: "n" }, `${onN}/${L.titles.length}${L.busy ? " · leyendo página " + (L.page + 1) + "…" : ""}${L.err ? " · " + L.err : ""}`),
        isSeries(c) ? el("span", { class: "note" }, "Series: van a NOVA como catálogo (NOVA abre sus capítulos)") : null,
        el("span", { class: "grow" }),
        L.next && !L.busy ? el("button", { class: "small", onclick: () => readCat(c, true) }, "Más páginas") : null),
      cap.length ? el("div", { class: "grid" }, cap.map((t) => card(t, c))) : el("div", { class: "empty" }, L.busy ? "Leyendo…" : "Sin títulos"),
      list.length > cap.length ? el("button", { class: "small", onclick: () => { ST.more.add(c.url); drawTitles(); } }, `Mostrar los ${list.length}`) : null));
  }
  $("secs").replaceChildren(...(secs.length ? secs : [el("div", { class: "empty" }, "Elige categorías y toca «Leer títulos».")]));
  const sel = selectedTitles(), ok = [...ST.cap.values()].filter((x) => x.st === "ok").length;
  $("titlesLbl").textContent = `Títulos (${sel.length} elegidos)`;
  $("sum").replaceChildren(el("b", {}, `${sel.length} títulos`), ` elegidos de ${cats.length} categoría(s)`, ok ? ` · ${ok} con link` : "");
  $("m3u").disabled = !ok || ST.running;
  $("capture").disabled = $("toNova").disabled = ST.running || !sel.length;
}

// ---------------------------------------------------------------- 3a) sacar links (pestañas de fondo)
async function streamsOf(tabId) { const k = "tab:" + tabId; return ((await chrome.storage.session.get(k))[k]?.streams || []); }
const good = (s) => s.kind === "hls" || s.kind === "dash" || (s.kind === "file" && (s.duration || 0) > 300);
const rank = (s) => (s.kind === "hls" ? 0 : s.kind === "dash" ? 1 : 2) * 2 + (/master|playlist|index|manifest/i.test(s.url) ? 0 : 1);
async function waitStream(tabId, ms) {
  const end = Date.now() + ms; let first = 0;
  while (Date.now() < end && !ST.stop) {
    await sleep(1500);
    chrome.tabs.sendMessage(tabId, { action: "autoplay" }).catch(() => {});
    const ss = (await streamsOf(tabId)).filter(good);
    if (ss.length) { first ||= Date.now(); if (Date.now() - first > 3000 || ss.some((s) => /master|playlist|manifest/i.test(s.url))) return ss.sort((a, b) => rank(a) - rank(b))[0]; }
  }
  const ss = (await streamsOf(tabId)).filter(good);
  return ss.sort((a, b) => rank(a) - rank(b))[0] || null;
}
async function sourcesIn(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["lib/x4.js"] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => { try { return X4.markSources(document, location.href); } catch { return []; } } });
    return (r?.result || []).filter((o) => !o.trailer);
  } catch { return []; }
}
async function useSource(tabId, o) {
  let clicked = false;
  try { const [r] = await chrome.scripting.executeScript({ target: { tabId }, args: [o.i], func: (i) => { const e = document.querySelector(`[data-x4o="${i}"]`); if (!e) return false; e.scrollIntoView({ block: "center" }); e.click(); return true; } }); clicked = !!r?.result; } catch {}
  if (!clicked && /^https?:/i.test(o.url || "")) await chrome.tabs.update(tabId, { url: o.url }).catch(() => {});
}
async function captureOne(t) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: t.url, active: false }); ST.tabs.add(tab.id);
    chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
    await waitLoad(tab.id);
    let s = await waitStream(tab.id, 16000);
    if (!s && !ST.stop) {
      const opts = await sourcesIn(tab.id);
      for (const o of opts.slice(0, 4)) {
        if (ST.stop) break;
        ST.cap.set(t.url, { st: "busy", txt: "Probando " + String(o.name || "servidor").slice(0, 14) }); drawTitles();
        await useSource(tab.id, o);
        s = await waitStream(tab.id, 14000);
        if (s) { s.server = o.name; break; }
      }
    }
    return s;
  } catch { return null; }
  finally { if (tab) { chrome.tabs.remove(tab.id).catch(() => {}); ST.tabs.delete(tab.id); chrome.storage.session.remove("tab:" + tab.id).catch(() => {}); } }
}
let saveQ = Promise.resolve();
function saveFav(t, c, s) {
  saveQ = saveQ.then(async () => {
    const { favorites = [], categories = [] } = await chrome.storage.local.get(["favorites", "categories"]);
    const group = cleanTitle(c.home ? ST.name : c.name).slice(0, 40) || "Explorados";
    const f = { key: keyOf(s.url), url: s.url, kind: s.kind || detectKind(s.url) || "hls", referer: s.referer || new URL(t.url).origin + "/", name: cleanTitle(t.name), group,
      thumb: t.poster || "", pageUrl: t.url, pageTitle: t.name, addedAt: Date.now(), via: "explorar", ...(s.duration ? { duration: s.duration } : {}) };
    const rest = favorites.filter((x) => x.key !== f.key && x.pageUrl !== t.url);
    if (!categories.some((x) => x.toLowerCase() === group.toLowerCase())) categories.push(group);
    await chrome.storage.local.set({ favorites: [f, ...rest], categories });
    chrome.runtime.sendMessage({ action: "carCheckSaved", keys: [f.key] }).catch(() => {});
  }).catch(() => {});
  return saveQ;
}
async function capture() {
  const all = selectedTitles(); if (!all.length) return;
  const todo = all.filter(({ t, c }) => { if (isSeries(c, t)) { ST.cap.set(t.url, { st: "skip", why: "Las series van a NOVA como catálogo" }); return false; } return ST.cap.get(t.url)?.st !== "ok"; });
  if (!todo.length) { drawTitles(); return alert("No hay películas o canales para sacar (las series se envían a NOVA como catálogo)."); }
  if (todo.length > 25 && !confirm(`Se van a abrir ${todo.length} títulos, de a 2, en pestañas de fondo (unos 20 a 60 segundos cada uno). Puedes seguir usando Chrome y detenerlo cuando quieras. ¿Empezar?`)) return;
  ST.running = true; ST.stop = false; $("stop").hidden = false; $("prog").hidden = false;
  for (const { t } of todo) ST.cap.set(t.url, { st: "wait" });
  drawTitles();
  let done = 0, ok = 0;
  const q = todo.slice();
  await Promise.all([0, 1].map(async () => {
    while (q.length && !ST.stop) {
      const { t, c } = q.shift();
      ST.cap.set(t.url, { st: "busy" }); drawTitles();
      const s = await captureOne(t);
      if (s) { ok++; ST.cap.set(t.url, { st: "ok", url: s.url, referer: s.referer || "", kind: s.kind, server: s.server || "", group: c.home ? ST.name : c.name, name: t.name, poster: t.poster || "", page: t.url }); await saveFav(t, c, s); }
      else ST.cap.set(t.url, { st: ST.stop ? "wait" : "bad", why: "No apareció video (puede necesitar que elijas el servidor a mano)" });
      done++; $("prog").firstElementChild.style.width = Math.round((done / todo.length) * 100) + "%"; drawTitles();
    }
  }));
  for (const [u, x] of ST.cap) if (x.st === "wait" || x.st === "busy") ST.cap.delete(u);
  ST.running = false; $("stop").hidden = true; $("prog").hidden = true; drawTitles();
  msg("readMsg", `${ok} de ${done} títulos con link. Quedaron en Guardados, cada uno en su categoría.${ST.stop ? " (detenido)" : ""}`, ok ? "ok" : "warn");
}
function stopAll() { ST.stop = true; for (const id of ST.tabs) chrome.tabs.remove(id).catch(() => {}); }

// ---------------------------------------------------------------- 3b) descargar .m3u
async function downloadM3u() {
  const s = await getSettings();
  const items = [...ST.cap.values()].filter((x) => x.st === "ok").map((x) => ({ key: keyOf(x.url), url: x.url, kind: x.kind, referer: x.referer, name: x.name, group: cleanTitle(x.group), thumb: x.poster, pageUrl: x.page }));
  const order = [...new Set(items.map((x) => x.group))];
  const text = m3uFile(sortByCategory(items, order).map((f) => m3uFor(f, s)), s);
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "audio/x-mpegurl" })), download: safeFile(ST.name || "sitio") + ".m3u" });
  document.body.append(a); a.click(); a.remove();
}

// ---------------------------------------------------------------- 3c) enviar a NOVA
async function siteCookies() {
  const d = siteDom(); if (!d) return [];
  try { return await chrome.cookies.getAll({ domain: d }); } catch { return []; }
}
async function sendSession(N) {
  const cs = await siteCookies(); if (!cs.length) throw new Error("no hay sesión de este sitio en tu Chrome");
  const r = await fetch(`${N.u}/sesion?k=${encodeURIComponent(N.k)}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ site: ST.site, url: ST.site, via: "extension", ua: navigator.userAgent, cookies: cs.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, hostOnly: c.hostOnly, expirationDate: c.expirationDate })) }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 ? "la clave del puente no coincide" : r.status === 404 ? "publica tu NOVA de nuevo (PUBLICAR.bat)" : j.error || "respondió " + r.status);
  return j;
}
async function sessionRow() {
  const N = await nova(), cs = await siteCookies();
  $("sesRow").hidden = !N || !cs.length;
  $("sesNote").textContent = `Tu Chrome tiene ${cs.length} cookie(s) de ${siteDom()}. Si iniciaste sesión en este sitio, envíala a NOVA para que su Detector y su reproductor también entren como tú.`;
}
async function postEntrada(N, body) {
  const r = await fetch(`${N.u}/entrada?k=${encodeURIComponent(N.k)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 ? "la clave del puente no coincide" : r.status === 404 ? "publica tu NOVA de nuevo (PUBLICAR.bat)" : r.status === 400 && body.catalog ? "publica tu NOVA de nuevo (PUBLICAR.bat) para recibir catálogos" : j.error || "respondió " + r.status);
  return j;
}
async function toNova() {
  const N = await nova();
  if (!N) return alert("Falta conectar tu NOVA: abre la extensión → Más opciones → «NOVA» (dirección y clave del puente).");
  const sel = selectedTitles(), ok = [...ST.cap.values()].filter((x) => x.st === "ok"), cs = await siteCookies();
  const d = $("dlg");
  const nm = el("input", { type: "text", value: ST.name, style: "width:100%" });
  const cCat = el("input", { type: "checkbox", checked: true }), cLinks = el("input", { type: "checkbox", checked: ok.length > 0, disabled: !ok.length }), cSes = el("input", { type: "checkbox", checked: false, disabled: !cs.length });
  const st = el("p", { class: "msg" });
  const go = el("button", { class: "primary", onclick: async () => {
    go.disabled = true; st.className = "msg"; st.textContent = "Enviando…";
    const done = [];
    try {
      if (cSes.checked) { await sendSession(N); done.push("tu sesión"); }
      if (cCat.checked && sel.length) {
        const byCat = new Map();
        for (const { t, c } of sel) { const k = c.home ? ST.site : c.url; if (!byCat.has(k)) byCat.set(k, { url: k, name: c.home ? "Inicio" : c.name, series: isSeries(c), titles: [] }); byCat.get(k).titles.push({ url: t.url, name: t.name, poster: t.poster || "", year: t.year || "" }); }
        let batch = {}, size = 0, n = 0;
        const flush = async () => { if (!Object.keys(batch).length) return; await postEntrada(N, { from: "Explorar un sitio (extensión)", catalog: { site: ST.site, name: nm.value.trim() || ST.name, cats: ST.cats.filter((c) => !c.home).map(({ url, name, group }) => ({ url, name, group: group || "" })), lists: batch } }); batch = {}; size = 0; };
        for (const [k, L] of byCat) { const sz = JSON.stringify(L).length; if (size + sz > 800000) await flush(); batch[k] = L; size += sz; n += L.titles.length; }
        await flush(); done.push(`${n} títulos al catálogo`);
      }
      if (cLinks.checked && ok.length) {
        const s = await getSettings(), items = ok.map((x) => ({ key: keyOf(x.url), url: x.url, kind: x.kind, referer: x.referer, name: x.name, group: cleanTitle(x.group), thumb: x.poster, pageUrl: x.page }));
        const pages = {}; for (const x of ok) pages[x.url] = x.page;
        await postEntrada(N, { m3u: m3uFile(items.map((f) => m3uFor(f, s)), s), pages, group: "", from: "Explorar un sitio (extensión)" });
        done.push(`${ok.length} links a tus favoritos`);
      }
      st.className = "msg ok"; st.textContent = done.length ? `Enviado: ${done.join(", ")}. Aparece en tu NOVA en menos de un minuto.` : "No elegiste nada para enviar.";
    } catch (e) { st.className = "msg bad"; st.textContent = "No se pudo: " + (e.message || e); }
    go.disabled = false;
  } }, icon("cast", 16), "Enviar");
  d.replaceChildren(el("h3", {}, "Enviar a NOVA"),
    el("label", { class: "note", style: "display:block;margin:0 0 6px" }, "Nombre del sitio en NOVA"), nm,
    el("label", {}, cCat, el("span", {}, `Catálogo: ${sel.length} títulos con sus categorías`, el("small", {}, "Aparecen en Películas y Series de NOVA; NOVA saca el link al darle play (siempre fresco)."))),
    el("label", {}, cLinks, el("span", {}, `Links sacados: ${ok.length}`, el("small", {}, ok.length ? "Van a tus favoritos de NOVA con su página, para renovarse solos." : "Primero usa «Sacar links»."))),
    el("label", {}, cSes, el("span", {}, "Mi sesión de este sitio", el("small", {}, cs.length ? "Para sitios con inicio de sesión: NOVA entra como tú (no se envía tu clave, solo la sesión)." : "Tu Chrome no tiene sesión de este sitio."))),
    st, el("div", { class: "acts" }, el("button", { onclick: () => d.close() }, "Cerrar"), go));
  d.showModal();
}

// ---------------------------------------------------------------- arranque
hydrateIcons();
$("open").onclick = openSite;
$("site").addEventListener("keydown", (e) => { if (e.key === "Enter") openSite(); });
$("catsAll").onclick = () => { ST.cats.forEach((c) => ST.sel.add(c.url)); drawCats(); drawTitles(); };
$("catsNone").onclick = () => { ST.sel.clear(); drawCats(); drawTitles(); };
$("read").onclick = readSelected;
$("filter").addEventListener("input", (e) => { ST.filter = e.target.value.trim(); drawTitles(); });
$("capture").onclick = capture;
$("stop").onclick = stopAll;
$("m3u").onclick = downloadM3u;
$("toNova").onclick = toNova;
$("sesSend").onclick = async () => {
  const N = await nova(); if (!N) return;
  $("sesSend").disabled = true;
  try { const j = await sendSession(N); $("sesNote").textContent = `Listo: sesión de ${j.site} enviada a NOVA (${j.n} cookies).`; }
  catch (e) { $("sesNote").textContent = "No se pudo: " + (e.message || e); }
  $("sesSend").disabled = false;
};
addEventListener("beforeunload", () => { for (const id of ST.tabs) chrome.tabs.remove(id).catch(() => {}); });
{ const u = new URLSearchParams(location.search).get("u"); if (u) { $("site").value = u; openSite(); } else $("site").focus(); }
