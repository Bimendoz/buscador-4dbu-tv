// HLS Stream Detector — popup
// Vista "Esta pestaña" (flujos detectados, en vivo) y "Guardados" (favoritos persistentes).
const $ = (id) => document.getElementById(id);

const state = {
  view: "tab", tabId: null, tabTitle: "", tabIndex: 0,
  streams: [], favorites: [], settings: { ...DEFAULT_SETTINGS },
  names: new Map(),     // key -> nombre editado (vista pestaña)
  analysis: new Map(),  // key -> resultado o "pending"
  openMore: new Set(),  // tarjetas con el panel "⋯" abierto
  ytMode: new Map(),    // key -> usar directo del canal (vista pestaña)
  publish: {},          // link único de lista (Gist)
  tokenDraft: "",
  categories: [],       // categorías creadas por el usuario (group-title de la lista)
  filter: "",           // Guardados: categoría visible ("" = todas)
  newCat: null,         // tarjeta (key) o "__global" con el campo "nueva categoría" abierto
  newCatDraft: "",
  addOpen: false,       // Guardados: formulario "Agregar link"
  addDraft: { url: "", name: "", group: "" },
  health: {}, healthMeta: {}, // revisión automática de Guardados
  carCheck: new Map(),  // key -> "pending" o resultado de «Probar en CarTV»
  search: null,         // búsqueda de canal en curso o la última (la corre background.js)
  searchDraft: "",
  pageDraft: "",         // «¿No aparece? Pega el link de la página»
  searchMode: "search",  // «Buscar canal» o «Escaneo global»
  scan: null,            // escaneo global en curso o el último (lo corre background.js)
  scanSel: new Set(),    // resultados marcados para guardar
  scanForm: { category: "", max: 0 },   // 0 = todos
  countryOpen: false,   // selector de países abierto
  scanGroup: ""
};

// ---------- utilidades de UI ----------
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const c of children) if (c != null && c !== false) n.append(c);
  return n;
}
// Etiqueta de botón: "texto" o ["ícono", "texto"]
function setLabel(b, label) {
  const [ic, txt] = Array.isArray(label) ? label : [null, label];
  b.replaceChildren(...(ic ? [icon(ic, 14)] : []), ...(txt ? [el("span", { textContent: txt })] : []));
}
function flash(b, text = "Copiado") {
  if (!b._old) b._old = [...b.childNodes];
  clearTimeout(b._t);
  b.replaceChildren(icon("check", 14), el("span", { textContent: text }));
  b.classList.add("done");
  b._t = setTimeout(() => { b.replaceChildren(...b._old); b._old = null; b.classList.remove("done"); }, 1300);
}
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); flash(btn); } catch { flash(btn, "Error"); }
}
function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: "audio/x-mpegurl" }));
  const a = el("a", { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const btn = (label, onclick, cls = "b", title = "") => { const b = el("button", { className: cls, title }); setLabel(b, label); b.onclick = onclick; return b; };

// ---------- análisis ----------
async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { credentials: "include", cache: "no-store", signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = await r.text();
    return { text: text.length > 3e6 ? "" : text, url: r.url || url };
  } finally { clearTimeout(timer); }
}

async function analyze(item) {
  if (state.analysis.has(item.key)) return;
  const k = item.kind || detectKind(item.url);
  if (k === "file") { state.analysis.set(item.key, { kind: "file", live: false }); return render(); }
  if (k === "youtube" || /youtube\.com\//.test(item.url)) { state.analysis.set(item.key, { kind: "youtube", live: !!item.live }); return render(); }
  state.analysis.set(item.key, "pending");
  let result;
  try {
    const { text, url } = await fetchText(item.url);
    const kind = item.kind || detectKind(item.url) || "hls";
    result = kind === "dash" ? analyzeMpd(text) : analyzeHls(text, url);
    // Lista maestra: se revisa su calidad más liviana para saber si es EN VIVO o VOD
    if (result.kind === "master") {
      const detected = new Map(state.streams.map((x) => [x.key, x.url]));
      const v = result.variants[result.variants.length - 1];
      try {
        const sub = await fetchText(detected.get(keyOf(v.url)) || v.url);
        const a = analyzeHls(sub.text, sub.url);
        if (a.kind === "media") { result.live = a.live; result.enc = a.enc; result.target = a.target; }
      } catch {}
    }
  } catch (e) {
    result = { kind: "error", error: String(e.message || e) };
  }
  state.analysis.set(item.key, result);
  render();
}

async function analyzeAll(items) {
  const pending = items.filter((s) => !state.analysis.has(s.key));
  await Promise.all(Array.from({ length: 4 }, async () => { while (pending.length) await analyze(pending.shift()); }));
}

// ---------- datos de la vista pestaña ----------
function variantKeys() {
  const set = new Set();
  for (const s of state.streams) {
    const a = state.analysis.get(s.key);
    if (a?.kind === "master") {
      a.variants.forEach((v) => set.add(keyOf(v.url)));
      a.media.forEach((m) => m.url && set.add(keyOf(m.url)));
    }
  }
  return set;
}
function tabList() {
  const vk = variantKeys();
  let list = state.streams.filter((s) => !vk.has(s.key));
  const grouped = state.streams.length - list.length;
  let hiddenVod = 0;
  if (state.settings.onlyLive) {
    const before = list.length;
    list = list.filter((s) => { const a = state.analysis.get(s.key); return !a || a === "pending" || a.live === true || a.kind === "error"; });
    hiddenVod = before - list.length;
  }
  const isMaster = (s) => state.analysis.get(s.key)?.kind === "master";
  return { list: [...list.filter(isMaster), ...list.filter((s) => !isMaster(s))], grouped, hiddenVod };
}
function defaultName(s, i, total) {
  if (s.kind === "youtube") return cleanTitle((s.useChannel && s.author) || s.title || s.pageTitle) || "YouTube";
  const base = cleanTitle(s.pageTitle || state.tabTitle) || hostOf(s.url) || "Canal";
  return total > 1 ? `${base} (${i + 1})` : base;
}

// ---------- favoritos ----------
const favOf = (key) => state.favorites.find((f) => f.key === key);
const isSaved = (key) => !!favOf(key);
// Un flujo de la pestaña que ya está guardado usa la categoría de Guardados en la lista
const withGroup = (item) => (item.group !== undefined ? item : { ...item, group: favOf(item.key)?.group || "" });
function liveOf(item) {
  if (item.kind === "youtube") return item.live;
  const a = state.analysis.get(item.key);
  return typeof a?.live === "boolean" ? a.live : item.live;
}
async function saveFavorites() { await chrome.storage.local.set({ favorites: state.favorites }); }
function makeFavorite(s, name, group = "") {
  const { hits, firstSeen, lastSeen, via, contentType, origin, ...keep } = s;
  return { ...keep, live: liveOf(s), kind: s.kind || detectKind(s.url) || "hls", referer: s.referer || "", name, group, addedAt: Date.now() };
}
// Lo que se guarda sin haber pasado la prueba como CarTV se prueba solo en segundo plano
const checkSaved = (keys) => { keys = keys.filter((k) => !favOf(k)?.car); if (keys.length) chrome.runtime.sendMessage({ action: "carCheckSaved", keys }).catch(() => {}); };
async function toggleFavorite(s, name) {
  if (isSaved(s.key)) state.favorites = state.favorites.filter((f) => f.key !== s.key);
  else state.favorites.unshift(makeFavorite(s, name));
  await saveFavorites();
  checkSaved([s.key]);
  render();
}
// Enviar a una categoría: si no estaba guardado, se guarda ahí mismo
async function assignCategory(item, group, name) {
  const f = favOf(item.key);
  if (f) f.group = group; else state.favorites.unshift(makeFavorite(item, name, group));
  state.newCat = null; state.newCatDraft = "";
  await saveFavorites();
  checkSaved([item.key]);
  render();
}

// ---------- categorías ----------
async function saveCategories() { await chrome.storage.local.set({ categories: state.categories }); }
function addCategory(raw) {
  const n = cleanTitle(raw).slice(0, 40);
  if (!n) return "";
  const hit = state.categories.find((c) => c.toLowerCase() === n.toLowerCase());
  if (hit) return hit;
  state.categories.push(n);
  return n;
}
async function deleteCategory(c) {
  state.categories = state.categories.filter((x) => x !== c);
  state.favorites.forEach((f) => { if (f.group === c) f.group = ""; });
  if (state.filter === c) state.filter = "";
  await saveCategories();
  await saveFavorites();
  render();
}
const opt = (value, textContent) => el("option", { value, textContent });

function newCatInput(forKey, onCreate) {
  const inp = el("input", { className: "name catname", placeholder: "Nombre de la nueva categoría", maxLength: 40, value: state.newCatDraft, spellcheck: false });
  inp.dataset.key = "__cat:" + forKey;
  inp.oninput = () => (state.newCatDraft = inp.value);
  const ok = btn(["check", "Crear"], async () => {
    const n = addCategory(inp.value);
    if (!n) return inp.focus();
    await saveCategories();
    await onCreate(n);
  }, "b primary");
  const no = btn(["x"], () => { state.newCat = null; state.newCatDraft = ""; render(); }, "b sq", "Cancelar");
  inp.onkeydown = (e) => { if (e.key === "Enter") ok.click(); else if (e.key === "Escape") no.click(); };
  return el("div", { className: "cat" }, inp, ok, no);
}

// Selector 📁 de cada tarjeta: guarda o mueve el link a una categoría
function catControl(item, curName) {
  if (state.newCat === item.key) return newCatInput(item.key, (n) => assignCategory(item, n, curName()));
  const f = favOf(item.key);
  const sel = el("select", { className: "catsel", title: "Categoría: así sale agrupado en VLC y en las apps IPTV" });
  if (!f) sel.append(opt("__none", "Guardar en categoría…"));
  sel.append(opt("", `Automática · ${autoGroupFor({ ...item, live: liveOf(item) })}`));
  state.categories.forEach((c) => sel.append(opt(c, c)));
  sel.append(opt("__new", "+ Nueva categoría…"));
  sel.value = f ? (state.categories.includes(f.group) ? f.group : "") : "__none";
  sel.onchange = () => {
    if (sel.value === "__new") { state.newCat = item.key; state.newCatDraft = ""; render(); return; }
    if (sel.value !== "__none") assignCategory(item, sel.value, curName());
  };
  return el("div", { className: "cat" }, icon("folder", 14), sel);
}

// ---------- tarjeta ----------
function metaFor(a, item) {
  const exp = tokenExpiry(item.url);
  const chips = [];
  if ((item.kind || detectKind(item.url)) === "dash") chips.push(["DASH", "dash"]);
  let text = "", err = false;

  if (a?.kind === "file") {
    chips.push(["ARCHIVO", "file"]);
    const ext = (item.url.match(/\.(\w{2,4})(?:$|[?#])/) || [])[1];
    text = [item.height ? item.height + "p" : "", item.duration ? fmtDuration(item.duration) : "", fmtBytes(item.size), ext ? ext.toUpperCase() : "", "video completo"].filter(Boolean).join(" · ");
  } else if (a?.kind === "youtube") {
    chips.push(["YOUTUBE", "yt"]);
    chips.push(item.live ? ["EN VIVO", "live"] : item.upcoming ? ["PRÓXIMO", "enc"] : ["VIDEO", ""]);
    text = (item.author ? `Canal: ${item.author}` : "YouTube") +
      (item.useChannel && item.channelLive ? " · En la lista va el directo del canal: no caduca." : "") +
      " Se reproduce en VLC o Kodi; en apps IPTV como CarTV no.";
  } else if (a?.kind === "verified") {
    chips.push(["Verificado", "vod", "check"]);
    chips.push(a.live ? ["EN VIVO", "live"] : ["VOD", "vod"]);
    text = [a.res ? `máx ${a.res.split("x")[1]}p` : "", a.variants > 1 ? `${a.variants} calidades` : "", a.bw ? fmtMbps(a.bw) : ""].filter(Boolean).join(" · ") || "Probado: funciona";
  } else if (!a || a === "pending") text = "Analizando…";
  else if (a.kind === "master") {
    chips.push(["MAESTRA", "master"]);
    if (a.live === true) chips.push(["EN VIVO", "live"]); else if (a.live === false) chips.push(["VOD", "vod"]);
    if (a.enc) chips.push([a.enc, "enc"]);
    const top = a.variants[0];
    const audios = a.media.filter((m) => m.type === "AUDIO").length;
    text = `${a.variants.length} calidad${a.variants.length > 1 ? "es" : ""}`;
    if (top.res) text += ` · máx ${top.res.split("x")[1]}p`;
    if (top.bw) text += ` · ${fmtMbps(top.bw)}`;
    if (audios) text += ` · ${audios} pista${audios > 1 ? "s" : ""} de audio`;
  } else if (a.kind === "media") {
    chips.push(a.live ? ["EN VIVO", "live"] : ["VOD", "vod"]);
    if (a.enc) chips.push([a.enc, "enc"]);
    text = a.live ? `En vivo · segmentos de ${a.target || "?"} s` : `VOD · ${fmtDuration(a.dur)} · ${a.segs} segmento${a.segs === 1 ? "" : "s"}`;
  } else if (a.kind === "dash") {
    chips.push(a.live ? ["EN VIVO", "live"] : ["VOD", "vod"]);
    if (a.drm) chips.push(["DRM", "enc"]);
    text = `${a.reps} calidad${a.reps === 1 ? "" : "es"}` + (a.maxH ? ` · máx ${a.maxH}p` : "") + (a.maxBw ? ` · ${fmtMbps(a.maxBw)}` : "") + (!a.live && a.dur ? ` · ${fmtDuration(a.dur)}` : "");
    if (a.drm) text += " · Protegido con DRM: no se reproducirá fuera del sitio.";
  } else if (a.kind === "error") {
    err = true;
    text = /HTTP 40[13]/.test(a.error) && exp && exp < Date.now()
      ? `El servidor rechaza el link (${a.error}): el token ya venció.`
      : `No se pudo analizar (${a.error}). La URL puede funcionar igual en VLC.`;
  } else { err = true; text = "Contenido no reconocido."; }

  if (exp && (item.kind !== "youtube")) {
    const left = exp - Date.now();
    chips.push([left <= 0 ? "Token vencido" : fmtRemaining(left).replace("vence en ", ""), left <= 0 ? "expired" : left < 3600e3 ? "soon" : "exp", "clock", "Vence: " + new Date(exp).toLocaleString()]);
  }
  const lock = item.kind !== "youtube" && networkLock(item.url);
  if (lock) {
    chips.push(["Solo esta red", "soon", "lock", lockText(lock)]);
    text += (text ? " · " : "") + (lock.type === "asn" ? "Solo funciona en la misma red donde se capturó." : "Solo funciona desde tu misma IP.");
  }
  return { chips, text, err, exp, lock };
}

function card(item, { name, onName, saved, hits, onMode }) {
  const a = state.analysis.get(item.key);
  const meta = metaFor(a, item);
  const kind = item.kind || detectKind(item.url) || "hls";
  const h = saved && state.health[item.key];
  if (kind !== "youtube" && kind !== "dash") {
    const c = item.car;
    if (c) meta.chips.unshift(c.ok ? ["Apto CarTV", "car-ok", "cast", `Probado como CarTV ${ago(c.at)}${c.verdict === "referer" ? " · necesita Referer (va en la lista)" : ""}`]
      : ["No apto CarTV", "car-bad", "x", `${c.why || "no pasó la prueba"} · ${ago(c.at)}`]);
    else if (saved) meta.chips.unshift(["Probando CarTV…", "car-unk", "cast", "Se está probando como CarTV"]);
  }
  if (kind !== "youtube") {
    const si = tierOf(item);
    meta.chips.unshift([TIER_LABEL[si.tier], "t-" + si.tier, si.tier === "official" ? "check" : si.tier === "unofficial" ? "alert" : si.tier === "cdn" ? "signal" : "globe", si.why.join(" · ")]);
  }
  if (h && h.ok !== null) meta.chips.unshift(h.ok ? ["Funciona", "up", "dot", "Funcionaba en la revisión " + ago(h.at)] : ["Caído", "down", "dot", `${h.why} · revisión ${ago(h.at)}`]);

  const nameInput = el("input", { className: "name", value: name, spellcheck: false, title: "Nombre del canal" });
  nameInput.dataset.key = item.key;
  nameInput.addEventListener("input", () => onName(nameInput.value));
  const curName = () => nameInput.value.trim() || name || hostOf(item.url);
  const entry = () => m3uFile([m3uFor(withGroup(item), state.settings, curName())]);
  const link = () => (kind === "youtube" ? effUrl(item) : outUrl(item.url, state.settings));

  const more = el("div", { className: "more" + (state.openMore.has(item.key) ? " open" : "") });
  const cmds = buildCommands(effUrl(item), item.referer, curName(), kind);
  // formato que entienden CarTV/Kodi para mandar Referer y User-Agent: url|User-Agent=…&Referer=…
  const carEntry = () => m3uFile([m3uFor(withGroup(item), { ...state.settings, listFormat: "iptv", vlcOpts: true }, curName())]);
  const bCar = btn(["copy", "Copiar para CarTV"], () => copy(carEntry(), bCar), "b", "M3U en formato de apps IPTV (lleva el Referer y el User-Agent pegados al link)");
  const bTest = btn(["cast", state.carCheck.get(item.key) === "pending" ? "Probando…" : "Probar en CarTV"], () => carCheck(item), "b primary",
    "Pide el video como lo hace una app IPTV (sin cookies ni datos del navegador) y te dice si funcionará y qué le falta");
  bTest.disabled = kind === "youtube" || kind === "dash" || state.carCheck.get(item.key) === "pending";
  more.append(
    el("div", { className: "btns" }, bTest, bCar),
    el("div", { className: "btns", style: "margin-top:4px" }, btn(["download", "Descargar .m3u"], () => download(entry(), safeFile(curName()) + ".m3u"))),
    el("div", { className: "lbl", textContent: "Comandos para probar o grabar tus transmisiones:" }),
    ...Object.keys(cmds).map((k) => {
      const label = COMMAND_LABELS[k];
      const b = btn(["copy", "Copiar"], () => copy(buildCommands(effUrl(item), item.referer, curName(), kind)[k], b), "b mini");
      b.title = cmds[k];
      return el("div", { className: "cmd" }, el("span", { textContent: label }), b);
    })
  );
  const bMore = btn(["more"], () => {
    more.classList.toggle("open");
    more.classList.contains("open") ? state.openMore.add(item.key) : state.openMore.delete(item.key);
  }, "b sq", "Más opciones");

  const bCopy = btn(["link", "URL"], () => copy(link(), bCopy), "b", "Copiar el link");
  const bM3u = btn(["copy", "M3U"], () => copy(entry(), bM3u), "b", "Copiar como entrada M3U");
  const bMon = kind === "youtube"
    ? btn(["play", "Ver"], () => chrome.tabs.create({ url: effUrl(item), index: state.tabIndex + 1 }), "b primary", "Abrir en YouTube")
    : btn(["monitor", "Monitor"], () => chrome.tabs.create({ url: monitorUrl(item.url, item.referer, curName(), kind), index: state.tabIndex + 1 }), "b primary",
      kind === "dash" ? "El monitor no reproduce DASH" : kind === "file" ? "Vista previa del video" : "Vista previa y salud del directo");
  if (kind === "dash") bMon.disabled = true;
  const bSide = saved
    ? btn(["trash"], () => { state.favorites = state.favorites.filter((f) => f.key !== item.key); saveFavorites().then(render); }, "b sq", "Quitar de guardados")
    : btn([isSaved(item.key) ? "starFill" : "star"], () => toggleFavorite(item, curName()), "b sq star" + (isSaved(item.key) ? " on" : ""), isSaved(item.key) ? "Quitar de guardados" : "Guardar");

  // Link guardado con token: abrir la página lo renueva solo (background.js actualiza Guardados)
  const bRenew = saved && item.pageUrl && kind !== "youtube" && (meta.exp || meta.lock)
    ? btn(["refresh"], () => chrome.tabs.create({ url: item.pageUrl, index: state.tabIndex + 1 }), "b sq",
      "Renovar: abre la página del video; al reproducirse, el link se actualiza solo en Guardados y en tu lista")
    : null;
  if (saved && item.renewedAt) meta.text += (meta.text ? " · " : "") + `Link renovado ${ago(item.renewedAt)}`;

  const state_ = h && h.ok === false ? "down" : kind === "youtube" ? "yt" : kind === "file" ? "file"
    : a && a !== "pending" && a.kind !== "error" ? (a.live === true || (a.kind === "verified" && a.live) ? "live" : a.live === false ? "vod" : "") : "";
  const c = el("div", { className: "card" },
    el("div", { className: "row" },
      ...meta.chips.map(([t, cls, ic, title]) => el("span", { className: "chip " + cls, title: title || "" }, ...(ic ? [icon(ic, 11)] : []), t)),
      el("span", { className: "host", textContent: hostOf(item.url) }),
      hits > 1 ? el("span", { className: "hits", textContent: `×${hits}`, title: "Veces solicitada" }) : null
    ),
    nameInput,
    el("div", { className: "url", textContent: item.url, title: item.url }),
    el("div", { className: "meta" + (meta.err ? " err" : ""), textContent: meta.text }),
    carResult(item),
    ytModeRow(item, onMode),
    catControl(item, curName),
    el("div", { className: "btns" }, bCopy, bM3u, bMon, bRenew, bSide, bMore),
    more
  );
  if (a?.kind === "master") c.append(variantList(item, a, curName));
  if (state_) c.dataset.state = state_;
  return c;
}

// ---------- ¿funciona en CarTV? ----------
async function carCheck(item) {
  state.carCheck.set(item.key, "pending");
  render();
  const r = await chrome.runtime.sendMessage({ action: "playerCheck", url: item.url, referer: item.referer || "" }).catch((e) => ({ verdict: "down", why: e.message }));
  state.carCheck.set(item.key, r || { verdict: "down", why: "sin respuesta" });
  const fav = favOf(item.key);
  if (fav && r?.verdict) { fav.car = carFrom(r.verdict, r.why || ""); await saveFavorites(); }
  render();
}
function carResult(item) {
  const r = state.carCheck.get(item.key);
  const box = (cls, ic, text) => el("div", { className: "carchk " + cls }, icon(ic, 14), el("span", { textContent: text }));
  if (!r) return item.needs === "referer"
    ? box("warn", "alert", "CarTV: funciona solo con Referer. Usa «Más → Copiar para CarTV», o el formato «Apps IPTV» en Ajustes para la lista.")
    : null;
  if (r === "pending") return box("", "cast", "Probando como CarTV…");
  const txt = {
    ok: ["ok", "check", "CarTV: funciona tal cual."],
    referer: ["warn", "alert", "CarTV: funciona solo si la app manda el Referer. Usa «Copiar para CarTV», o el formato «Apps IPTV» en Ajustes para la lista."],
    browser: ["bad", "x", `CarTV: no. Solo funciona dentro de Chrome, el servidor exige las cookies o el origen de la página (${r.why}).`],
    down: ["bad", "x", `No funciona ni en Chrome: ${r.why}.`]
  }[r.verdict] || ["bad", "x", "Resultado desconocido"];
  const extra = [r.lock, r.exp ? (r.exp < Date.now() ? "El token ya venció." : `El token ${fmtRemaining(r.exp - Date.now())}: después deja de funcionar.`) : ""].filter(Boolean).join(" ");
  return box(txt[0], txt[1], txt[2] + (extra && r.verdict !== "down" ? " " + extra : ""));
}

// YouTube: elegir entre el link de este directo o el del canal (siempre apunta al directo actual)
function ytModeRow(item, onMode) {
  if (item.kind !== "youtube" || !item.channelLive || !onMode) return null;
  const cb = el("input", { type: "checkbox", checked: !!item.useChannel });
  cb.onchange = () => onMode(cb.checked);
  return el("label", { className: "ytmode", title: item.channelLive }, cb,
    item.live ? "Usar el directo del canal (no caduca cuando termine este)" : "Usar el directo del canal (cuando transmita en vivo)");
}

function variantList(master, a, masterName) {
  const detected = new Map(state.streams.map((x) => [x.key, x]));
  const d = el("details", {}, el("summary", { textContent: `Ver ${a.variants.length} calidad${a.variants.length === 1 ? "" : "es"}` }));
  for (const v of a.variants) {
    const live = detected.get(keyOf(v.url)); // si el reproductor la pidió, su URL trae token fresco
    const url = live ? live.url : v.url;
    const p = v.res ? v.res.split("x")[1] + "p" : "";
    const label = [p, v.fps ? Math.round(v.fps) + "fps" : "", v.bw ? fmtMbps(v.bw) : ""].filter(Boolean).join(" · ") || "Variante";
    const bC = btn(["link", "URL"], () => copy(outUrl(url, state.settings), bC), "b mini");
    const bM = btn(["copy", "M3U"], () => copy(m3uFile([m3uEntry(`${masterName()} ${p}`.trim(), url, master.referer, state.settings)]), bM), "b mini");
    const bP = btn(["monitor"], () => chrome.tabs.create({ url: monitorUrl(url, master.referer, `${masterName()} ${p}`.trim()), index: state.tabIndex + 1 }), "b mini", "Monitorear esta calidad");
    d.append(el("div", { className: "variant", title: v.codecs }, el("span", { textContent: label + (live ? "  · en uso" : "") }), bC, bM, bP));
  }
  return d;
}

// ---------- link único de lista ----------
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? "hace un momento" : s < 3600 ? `hace ${Math.floor(s / 60)} min` : s < 86400 ? `hace ${Math.floor(s / 3600)} h` : new Date(ts).toLocaleDateString();
}
async function doPublish(b) {
  const orig = [...b.childNodes];
  b.disabled = true; setLabel(b, ["refresh", "Publicando…"]);
  const r = await chrome.runtime.sendMessage({ action: "publish" }).catch((e) => ({ ok: false, error: e.message }));
  b.disabled = false;
  b.replaceChildren(...orig);
  if (r?.ok) flash(b, "Publicado"); else setLabel(b, ["refresh", "Reintentar"]);
}
function publishBox() {
  const p = state.publish || {};
  const box = el("div", { className: "pub" }, el("div", { className: "pub-t" }, icon("link", 14), "Link único de tu lista"));
  if (!p.token) {
    box.append(el("div", { className: "pub-d", textContent: "Publica tus guardados como una lista .m3u con link fijo (Gist secreto de GitHub, gratis). Pega ese link en VLC, Kodi o tu app IPTV y verás todos los canales." }));
    const a = el("a", { href: "#" }, "1. Crear token de GitHub con permiso «gist» ", icon("external", 12));
    a.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: "https://github.com/settings/tokens/new?scopes=gist&description=HLS%20Stream%20Detector" }); };
    const inp = el("input", { type: "password", className: "name mono", placeholder: "2. Pega aquí el token (ghp_…)", value: state.tokenDraft });
    inp.dataset.key = "__token";
    inp.oninput = () => (state.tokenDraft = inp.value);
    const b = btn(["link", "3. Conectar y publicar"], async () => {
      const t = inp.value.trim();
      if (!t) return inp.focus();
      state.tokenDraft = "";
      await chrome.storage.local.set({ publish: { ...p, token: t, auto: p.auto ?? true } });
      doPublish(b);
    }, "b primary");
    box.append(a, inp, el("div", { className: "btns" }, b));
    if (p.link) box.append(el("div", { className: "status", textContent: "Al reconectar se conserva tu link anterior." }));
    return box;
  }
  if (p.link) {
    const li = el("input", { className: "name mono", value: p.link, readOnly: true, title: "Link de tu lista" });
    li.onclick = () => li.select();
    const bc = btn(["copy", "Copiar link"], () => copy(p.link, bc), "b primary");
    const bu = btn(["refresh", "Actualizar ahora"], () => doPublish(bu));
    box.append(li, el("div", { className: "btns" }, bc, bu));
    if (p.pageLink) {
      const bp = btn(["copy"], () => copy(p.pageLink, bp), "b sq", "Copiar");
      const bo = btn(["external"], () => chrome.tabs.create({ url: p.pageLink }), "b sq", "Abrir");
      box.append(el("div", { className: "status", textContent: "Página para el celular (canales con logo, estado y botón de reproducir):" }),
        el("div", { className: "btns" }, el("input", { className: "name mono", value: p.pageLink, readOnly: true, style: "margin:0;flex:3" }), bp, bo));
    }
  } else {
    const bu = btn(["link", "Crear link"], () => doPublish(bu), "b primary");
    box.append(el("div", { className: "btns" }, bu));
  }
  const auto = el("input", { type: "checkbox", checked: p.auto !== false });
  auto.onchange = () => chrome.storage.local.set({ publish: { ...state.publish, auto: auto.checked } });
  const out = el("a", { href: "#", textContent: "Desconectar" });
  out.onclick = (e) => { e.preventDefault(); const { token, ...rest } = state.publish; chrome.storage.local.set({ publish: rest }); };
  box.append(
    el("label", {}, auto, "Actualizar el link al guardar o quitar canales"),
    el("div", { className: "status" + (p.lastError ? " err" : ""),
      textContent: p.lastError ? `Error: ${p.lastError}` : p.lastPublished ? `Publicado ${ago(p.lastPublished)} · ${p.count} canal${p.count === 1 ? "" : "es"} · VLC/apps pueden tardar ~5 min en ver cambios` : "Aún sin publicar" }),
    el("div", { className: "status" }, "En CarTV, TiviMate o Smarters: agregar lista, «M3U por URL», pega el link. Los canales de YouTube solo funcionan en VLC o Kodi."),
    el("div", { className: "status" }, "Quien tenga el link puede ver la lista. ", out)
  );
  return box;
}

// ---------- render ----------
let favTimer = null;
function render() {
  const act = document.activeElement;
  const focusKey = act?.classList?.contains("name") ? act.dataset.key : null;
  const sel = focusKey ? [act.selectionStart, act.selectionEnd] : null;

  const main = $("lista");
  main.replaceChildren();
  const tl = tabList();
  $("countThis").textContent = tl.list.length;
  $("countThis").classList.toggle("zero", !tl.list.length);
  $("countSaved").textContent = state.favorites.length;
  $("countSaved").classList.toggle("zero", !state.favorites.length);
  $("tabThis").classList.toggle("on", state.view === "tab");
  $("tabSaved").classList.toggle("on", state.view === "saved");
  $("tabSearch").classList.toggle("on", state.view === "search");
  $("footThis").hidden = state.view !== "tab";
  $("footSaved").hidden = state.view !== "saved";

  if (state.view === "tab") {
    const { list, grouped, hiddenVod } = tl;
    if (grouped) main.append(el("div", { className: "note", textContent: `${grouped} variante${grouped > 1 ? "s" : ""} agrupada${grouped > 1 ? "s" : ""} dentro de su lista maestra` }));
    if (hiddenVod) main.append(el("div", { className: "note", textContent: `${hiddenVod} flujo${hiddenVod > 1 ? "s" : ""} VOD oculto${hiddenVod > 1 ? "s" : ""} (filtro "Solo en vivo")` }));
    if (!list.length) main.append(el("div", { className: "empty", textContent: state.settings.onlyLive && hiddenVod ? "No hay transmisiones en vivo en esta pestaña." : "Reproduce un video en esta pestaña: los directos (HLS/DASH), los videos de la página y los de YouTube aparecerán aquí." }));
    list.forEach((s0, i) => {
      const s = state.ytMode.has(s0.key) ? { ...s0, useChannel: state.ytMode.get(s0.key) } : s0;
      main.append(card(s, {
        name: state.names.get(s.key) ?? defaultName(s, i, list.length),
        onName: (v) => state.names.set(s.key, v),
        onMode: (v) => { state.ytMode.set(s.key, v); state.names.delete(s.key); render(); },
        hits: s.hits
      }));
    });
    $("btnCopyAll").disabled = $("btnExport").disabled = !list.length;
  } else if (state.view === "saved") {
    main.append(publishBox());
    const sections = savedSections();
    if (state.filter && !sections.some(([g]) => g === state.filter)) state.filter = "";
    main.append(savedToolbar(sections));
    if (state.newCat === "__global") main.append(newCatInput("__global", (n) => { state.newCat = null; state.newCatDraft = ""; state.filter = n; render(); }));
    if (state.addOpen) main.append(addBox());
    if (!state.favorites.length) main.append(el("div", { className: "empty", textContent: "Aún no tienes canales guardados. Usa la estrella o el selector de categoría en un flujo, agrega un link con «Agregar link» o importa un .m3u." }));
    else {
      const hm = state.healthMeta;
      main.append(el("div", { className: "note", textContent: hm.lastRun
        ? `Última revisión ${ago(hm.lastRun)}: ${hm.ok} funcionan · ${hm.down} caído(s)${hm.renewed ? ` · ${hm.renewed} renovado(s)` : ""}`
        : "Los links con token pueden vencer: el reloj te dice cuánto les queda y el botón de renovar los actualiza." }));
    }
    for (const [g, items] of sections) {
      if (state.filter && state.filter !== g) continue;
      main.append(sectionHead(g, items));
      if (!items.length) main.append(el("div", { className: "note", textContent: "Vacía. Usa el selector de categoría de cualquier tarjeta para enviar un link aquí." }));
      items.forEach((f) => main.append(card(f, {
        name: f.name, saved: true,
        onName: (v) => { f.name = v; clearTimeout(favTimer); favTimer = setTimeout(saveFavorites, 400); },
        onMode: (v) => { f.useChannel = v; saveFavorites().then(render); }
      })));
    }
    $("btnExportSaved").disabled = $("btnClearSaved").disabled = !state.favorites.length;
  } else {
    main.append(searchModeRow());
    if (state.searchMode === "scan") renderScan(main); else renderSearch(main);
  }

  if (focusKey) {
    const inp = main.querySelector(`input.name[data-key="${CSS.escape(focusKey)}"]`);
    if (inp) { inp.focus(); inp.setSelectionRange(...sel); }
  } else if (state.newCat) main.querySelector("input.catname")?.focus();
}

// ---------- idioma y escaneo global ----------
function langSelect() {
  const sel = el("select", { className: "catsel", title: "Idioma de la búsqueda y del escaneo" });
  LANG_MODES.forEach(([v, t]) => sel.append(opt(v, t)));
  sel.value = langMode(state.settings.langMode);
  sel.onchange = async () => {
    const { settings: cur = {} } = await chrome.storage.local.get("settings");
    state.settings = { ...state.settings, ...cur, langMode: sel.value };
    await chrome.storage.local.set({ settings: state.settings });
  };
  return el("div", { className: "cat" }, icon("globe", 14), sel);
}
function searchModeRow() {
  const b = (v, ic, t) => { const x = el("button", { className: "fchip" + (state.searchMode === v ? " on" : "") }, icon(ic, 12), t); x.onclick = () => { state.searchMode = v; render(); }; return x; };
  return el("div", {}, el("div", { className: "filters" }, b("search", "search", "Buscar canal"), b("scan", "globe", "Escaneo global"), langSelect()), countryPicker());
}
// Países (varios a la vez): se usan en la búsqueda por nombre y en el escaneo global
async function saveCountries(list) {
  const { settings: cur = {} } = await chrome.storage.local.get("settings");
  state.settings = { ...state.settings, ...cur, countries: cleanCountries(list) };
  await chrome.storage.local.set({ settings: state.settings });
  render();
}
function countryPicker() {
  const want = cleanCountries(state.settings.countries);
  const head = el("button", { className: "fchip" + (want.length ? " on" : ""), title: "Países de la búsqueda y del escaneo" }, icon("globe", 12),
    `Países: ${countriesLabel(want)}`.slice(0, 70), icon(state.countryOpen ? "x" : "plus", 11));
  head.onclick = () => { state.countryOpen = !state.countryOpen; render(); };
  if (!state.countryOpen) return el("div", { className: "filters" }, head);
  const chip = (code, label) => {
    const on = code === "" ? !want.length : want.includes(code);
    const x = el("button", { className: "fchip" + (on ? " on" : ""), textContent: label });
    x.onclick = () => {
      if (code === "") return saveCountries([]);
      const next = on ? want.filter((c) => c !== code) : [...want, code];
      saveCountries(next);
    };
    return x;
  };
  return el("div", { className: "filters" }, head, chip("", "Todos"), chip("LATAM", "Toda Latinoamérica"),
    ...LATAM_SPANISH.map(([c, n]) => chip(c, n)), chip("US", "EE. UU. (hispanos)"), chip("ES", "España"));
}
const scanRunning = (job) => job?.status === "running" && Date.now() - (job.updatedAt || job.startedAt) < 3 * 60e3;
function renderScan(main) {
  const job = state.scan, running = scanRunning(job), F = state.scanForm;
  const cat = el("select", { className: "catsel" }, ...SCAN_CATEGORIES.map(([c, n]) => opt(c, n)));
  cat.value = F.category; cat.onchange = () => (F.category = cat.value);
  const max = el("input", { className: "name", type: "number", min: "0", step: "1", value: String(F.max), title: "0 = todos", style: "width:70px;margin:0" });
  max.onchange = () => { F.max = Math.max(0, Math.round(+max.value) || 0); max.value = F.max; };
  const go = btn([running ? "x" : "globe", running ? "Detener" : "Escanear"], () => {
    if (running) return chrome.runtime.sendMessage({ action: "cancelScan" });
    F.max = Math.max(0, Math.round(+max.value) || 0);
    state.scanSel.clear();
    chrome.runtime.sendMessage({ action: "scan", filters: { langMode: state.settings.langMode, countries: cleanCountries(state.settings.countries), category: F.category, max: F.max, portableOnly: state.settings.portableOnly !== false } });
  }, running ? "b" : "b primary");
  main.append(el("div", { className: "scanf" },
    el("label", {}, "Categoría", cat),
    el("label", { title: "Cuántos links probar (0 = todos los que cumplan)" }, "Probar", max), go));
  if (!job) {
    main.append(el("div", { className: "empty", textContent: "Elige idioma, países (arriba) y categoría: reviso el directorio público de canales gratuitos, pruebo cada link como CarTV y te muestro todos los que funcionan para que marques los que quieras guardar." }));
    return;
  }
  const st = el("div", { className: "sstat" + (running ? " run" : "") },
    el("div", {}, running ? el("span", { className: "spin" }) : null, running ? job.step : job.status === "running" ? "El escaneo se interrumpió." : job.step),
    el("div", { className: "sub", textContent: `${job.tried} de ${job.goal} probado(s) · ${job.found.length} funcionan · ${job.total} cumplen los filtros` }));
  if (job.failed?.length) st.append(el("details", {}, el("summary", { textContent: "Ver por qué se descartaron (últimos)" }),
    el("ul", {}, ...job.failed.map((f) => el("li", { textContent: `${f.name || f.host}: ${f.why}` })))));
  main.append(st);
  if (!job.found.length) return;
  const pending = job.found.filter((f) => !isSaved(f.key));
  const selN = pending.filter((f) => state.scanSel.has(f.key)).length;
  const dest = el("select", { className: "catsel" }, opt("", "Automática"), ...state.categories.map((c) => opt(c, c)));
  dest.value = state.categories.includes(state.scanGroup) ? state.scanGroup : "";
  dest.onchange = () => (state.scanGroup = dest.value);
  const all = btn(["check", selN === pending.length && pending.length ? "Quitar todos" : "Marcar todos"], () => {
    if (selN === pending.length) state.scanSel.clear(); else pending.forEach((f) => state.scanSel.add(f.key));
    render();
  });
  const saveSel = btn(["star", `Guardar ${selN}`], async () => {
    const pick = pending.filter((f) => state.scanSel.has(f.key));
    if (!pick.length) return;
    for (const f of pick) state.favorites.unshift(makeFavorite(f, f.name, dest.value));
    await saveFavorites();
    checkSaved(pick.map((f) => f.key));
    state.scanSel.clear();
    render();
  }, "b primary");
  saveSel.disabled = !selN;
  main.append(el("div", { className: "scanbar" }, all, el("span", {}, "Categoría:"), el("div", { className: "cat" }, icon("folder", 14), dest), saveSel));
  for (const f of job.found) {
    const saved = isSaved(f.key);
    const cb = el("input", { type: "checkbox", checked: saved || state.scanSel.has(f.key), disabled: saved });
    cb.onchange = () => { cb.checked ? state.scanSel.add(f.key) : state.scanSel.delete(f.key); render(); };
    const meta = [f.lang, audioLabel(f.audio), f.country, f.res ? f.res.split("x")[1] + "p" : "", f.live ? "en vivo" : "grabado",
      f.needs === "referer" ? "necesita Referer" : "", f.lock ? "solo esta red" : "", f.geo ? "puede tener bloqueo por país" : "", saved ? "ya guardado" : ""].filter(Boolean).join(" · ");
    const logo = f.thumb ? el("img", { src: f.thumb, alt: "", referrerPolicy: "no-referrer" }) : el("span", { className: "nologo" }, icon("tv", 14));
    if (f.thumb) logo.onerror = () => logo.replaceWith(el("span", { className: "nologo" }, icon("tv", 14)));
    main.append(el("label", { className: "scanrow" + (saved ? " saved" : "") }, cb, logo,
      el("span", { className: "t" }, el("b", { textContent: f.name }), el("small", { textContent: meta }),
        el("small", { className: "mono", textContent: f.url }))));
  }
}

// ---------- buscador de canales ----------
// sigue viva si avanzó hace poco (una búsqueda larga puede durar muchos minutos)
const searchRunning = (job) => job?.status === "running" && Date.now() - (job.updatedAt || job.startedAt) < 3 * 60e3;
function renderSearch(main) {
  const job = state.search;
  const running = searchRunning(job);
  const inp = el("input", { className: "name", placeholder: "Nombre del canal, p. ej. Canal Capital", value: state.searchDraft, spellcheck: false });
  inp.dataset.key = "__search";
  inp.oninput = () => (state.searchDraft = inp.value);
  const go = btn([running ? "x" : "search", running ? "Detener" : "Buscar"], () => {
    if (running) return chrome.runtime.sendMessage({ action: "cancelSearch" });
    const q = state.searchDraft.trim();
    if (!q) return inp.focus();
    chrome.runtime.sendMessage({ action: "search", query: q });
  }, running ? "b" : "b primary");
  inp.onkeydown = (e) => { if (e.key === "Enter" && !running) go.click(); };
  main.append(el("div", { className: "sbox" }, inp, go));
  // ¿No aparece? Extraer el video de la página donde está
  const pg = el("input", { className: "name mono", placeholder: "…o pega el link de la página donde está el video", value: state.pageDraft, spellcheck: false });
  pg.dataset.key = "__page";
  pg.oninput = () => (state.pageDraft = pg.value);
  const ex = btn(["wand", "Extraer"], () => {
    const u = state.pageDraft.trim();
    if (!/^https?:\/\/\S+$/i.test(u)) return pg.focus();
    chrome.runtime.sendMessage({ action: "search", pageUrl: u });
  }, "b", "Abre la página por detrás, le da play, captura el video y lo prueba como CarTV");
  ex.disabled = running;
  pg.onkeydown = (e) => { if (e.key === "Enter" && !running) ex.click(); };
  main.append(el("div", { className: "sbox" }, pg, ex));
  if (!job) {
    main.append(el("div", { className: "empty", textContent: "Escribe el nombre de un canal: lo busco en el directorio público de canales gratuitos y en su página oficial. Si no aparece, pega el link de la página donde lo ves: la abro por detrás y saco el video. Pruebo cada link como CarTV y solo te entrego los que funcionan." }));
    return;
  }
  const st = el("div", { className: "sstat" + (running ? " run" : "") },
    el("div", {}, running ? el("span", { className: "spin" }) : null, `${job.pageUrl ? "Página " + hostOf(job.pageUrl) : "«" + job.query + "»"} · ${running ? job.step : job.status === "running" ? "La búsqueda se interrumpió." : job.step}`),
    el("div", { className: "sub", textContent: `${job.tried}${job.goal ? ` de ${job.goal}` : ""} probado(s) · ${job.found.length} verificado(s) · ${job.failed.length} descartado(s)` }));
  if (job.pages?.length) st.append(el("details", {}, el("summary", { textContent: `Páginas revisadas (${job.pages.length})` }),
    el("ul", {}, ...job.pages.map((pg) => el("li", { textContent: `${pg.found ? "✓" : "·"} ${pg.url.replace(/^https?:\/\/(www\.)?/, "")}${pg.found ? ` — ${pg.found} link(s)` : ""}` })))));
  if (job.failed.length) st.append(el("details", {}, el("summary", { textContent: "Ver por qué se descartaron" }),
    el("ul", {}, ...job.failed.slice(-15).map((f) => el("li", { textContent: `${f.host}: ${f.why}` })))));
  main.append(st);
  if (job.found.length) {
    const c = {}; job.found.forEach((f) => (c[f.tier || "unknown"] = (c[f.tier || "unknown"] || 0) + 1));
    main.append(el("div", { className: "note", textContent: "Funcionan: " + ["official", "cdn", "page", "unknown", "unofficial"].filter((t) => c[t]).map((t) => `${c[t]} ${TIER_LABEL[t].toLowerCase()}`).join(" · ") + ". Tú eliges cuáles guardar." }));
  }
  if (!running && !job.found.length) main.append(el("div", { className: "note", textContent: "Prueba con otro nombre (sin «canal» ni «TV»), o abre su página y dale play: la extensión lo detecta en «Esta pestaña»." }));
  for (const f of job.found) {
    // ya se probó en segundo plano (con su Referer): no volver a analizarlo desde el popup
    if (!state.analysis.has(f.key)) state.analysis.set(f.key, { kind: "verified", live: f.live, res: f.res, bw: f.bw, variants: f.variants });
    const extra = [f.lang || "", audioLabel(f.audio), f.res ? f.res.split("x")[1] + "p" : "", f.variants > 1 ? `${f.variants} calidades` : "", f.live ? "en vivo" : "grabado",
      f.source === "sitio" ? `de ${hostOf(f.pageUrl)}` : "del directorio", f.needs === "referer" ? "necesita Referer" : "probado como CarTV",
      f.weak ? "link sin sesión del reproductor: puede fallar en CarTV" : ""].filter(Boolean).join(" · ");
    main.append(el("div", { className: "verif" + (f.weak ? " weak" : "") }, icon(f.weak ? "alert" : "check", 12), `Verificado ${ago(f.verifiedAt)} · ${extra}`));
    main.append(card(f, { name: state.names.get(f.key) ?? f.name, onName: (v) => state.names.set(f.key, v) }));
  }
}

// ---------- Guardados por categoría ----------
// [[categoría, items]]: primero las del usuario (aunque estén vacías), luego las automáticas con contenido
function savedSections() {
  const map = new Map(state.categories.map((c) => [c, []]));
  for (const f of state.favorites) {
    const g = groupFor(f);
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(f);
  }
  const order = [...state.categories, ...AUTO_GROUPS];
  const rank = (g) => { const i = order.indexOf(g); return i < 0 ? order.length : i; };
  return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
}

function savedToolbar(sections) {
  const chip = (value, label, n) => {
    const b = el("button", { className: "fchip" + (state.filter === value ? " on" : ""), textContent: n == null ? label : `${label} · ${n}` });
    b.onclick = () => { state.filter = value; render(); };
    return b;
  };
  const action = (ic, label, fn) => { const b = el("button", { className: "fchip act" }, icon(ic, 12), label); b.onclick = fn; return b; };
  return el("div", { className: "filters" },
    chip("", "Todas", state.favorites.length),
    ...sections.map(([g, items]) => chip(g, g, items.length)),
    action(state.addOpen ? "x" : "plus", state.addOpen ? "Cerrar" : "Agregar link", () => { state.addOpen = !state.addOpen; render(); }),
    action("folder", "Categoría", () => { state.newCat = "__global"; state.newCatDraft = ""; render(); }),
    action("refresh", state.healthMeta.running ? "Revisando…" : "Revisar todos", () => { if (!state.healthMeta.running) chrome.runtime.sendMessage({ action: "runHealth" }); }));
}

function sectionHead(g, items) {
  const isUser = state.categories.includes(g);
  const head = el("div", { className: "sec" },
    el("span", { className: "sec-t", textContent: g }),
    el("span", { className: "chip", textContent: items.length }),
    el("span", { className: "sec-k", textContent: isUser ? "" : "automática" }));
  if (items.length) head.append(btn(["download", "Exportar"], () => download(m3uFile(items.map((f) => m3uFor(f, state.settings)), state.settings), safeFile(g) + ".m3u"), "b mini", `Descargar solo «${g}» como .m3u`));
  if (isUser) {
    const del = btn(["trash"], () => {
      if (del.dataset.armed) return deleteCategory(g);
      del.dataset.armed = "1"; setLabel(del, ["trash", "¿Borrar?"]); del.classList.add("danger");
      setTimeout(() => { delete del.dataset.armed; setLabel(del, ["trash"]); del.classList.remove("danger"); }, 2500);
    }, "b mini", "Borrar la categoría (sus links pasan a Automática, no se borran)");
    head.append(del);
  }
  return head;
}

// Agregar a mano un link de video o canal (.m3u8, .mp4, YouTube…)
function addBox() {
  const d = state.addDraft;
  const url = el("input", { className: "name mono", placeholder: "Link del video o canal (.m3u8, .mp4, YouTube…)", value: d.url, spellcheck: false });
  url.dataset.key = "__add:url";
  url.oninput = () => (d.url = url.value);
  const name = el("input", { className: "name", placeholder: "Nombre (opcional)", value: d.name, spellcheck: false });
  name.dataset.key = "__add:name";
  name.oninput = () => (d.name = name.value);
  const sel = el("select", { className: "catsel" }, opt("", "Automática"), ...state.categories.map((c) => opt(c, c)));
  sel.value = state.categories.includes(d.group) ? d.group : state.categories.includes(state.filter) ? state.filter : "";
  sel.onchange = () => (d.group = sel.value);
  const msg = el("div", { className: "status" });
  const fail = (t) => { msg.textContent = t; msg.classList.add("err"); };
  const ok = btn(["plus", "Agregar"], async () => {
    const u = d.url.trim();
    if (!/^https?:\/\/\S+$/i.test(u)) { fail("Pega un link completo que empiece por http:// o https://"); return url.focus(); }
    const id = ytId(u);
    const kind = detectKind(u) || (/(^|\.)youtube\.com$/i.test(hostOf(u)) ? "youtube" : "hls");
    const key = id ? "yt:" + id : keyOf(u);
    if (isSaved(key)) return fail("Ese link ya está en Guardados.");
    const item = { key, url: id ? ytWatchUrl(id) : u, kind, referer: "", name: cleanTitle(d.name) || hostOf(u) || "Canal", group: sel.value, addedAt: Date.now() };
    if (id) Object.assign(item, { ytId: id, thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` });
    state.favorites.unshift(item);
    setTimeout(() => checkSaved([item.key]), 300);
    state.addDraft = { url: "", name: "", group: sel.value };
    state.addOpen = false;
    await saveFavorites();
    render();
    analyzeAll(state.favorites);
  }, "b primary");
  url.onkeydown = name.onkeydown = (e) => { if (e.key === "Enter") ok.click(); };
  return el("div", { className: "card addbox" }, url, name, el("div", { className: "cat" }, sel, ok), msg);
}

function setView(v) {
  state.view = v;
  render();
  if (v !== "search") analyzeAll(v === "tab" ? state.streams : state.favorites);
  if (v === "search") document.querySelector('input[data-key="__search"]')?.focus();
}

// ---------- inicio ----------
document.addEventListener("DOMContentLoaded", async () => {
  hydrateIcons();
  $("ver").textContent = "v" + chrome.runtime.getManifest().version;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab?.id ?? null;
  state.tabTitle = tab?.title || "";
  state.tabIndex = tab?.index ?? 0;
  const key = `tab:${state.tabId}`;

  const local = await chrome.storage.local.get(["settings", "favorites", "publish", "categories", "health", "healthMeta"]);
  state.health = local.health || {};
  state.healthMeta = local.healthMeta || {};
  state.publish = local.publish || {};
  const migrated = migrateSettings(local.settings);
  if (migrated) { local.settings = migrated; chrome.storage.local.set({ settings: migrated }); }
  state.settings = { ...DEFAULT_SETTINGS, ...(local.settings || {}) };
  state.favorites = local.favorites || [];
  state.categories = local.categories || [];
  // categorías usadas por algún guardado pero que no están en la lista (p. ej. de otra versión)
  const orphan = [...new Set(state.favorites.map((f) => f.group).filter((g) => g && !state.categories.includes(g)))];
  if (orphan.length) { state.categories.push(...orphan); saveCategories(); }
  const sess = await chrome.storage.session.get([key, "search", "scan"]);
  state.scan = sess.scan || null;
  state.streams = sess[key]?.streams || [];
  state.search = sess.search || null;
  if (state.search) state.searchDraft = state.search.query;

  // opciones
  // «Links a probar»: se guarda con el botón Guardar, con Enter o al salir del campo, y se confirma en pantalla
  const cnt = $("optSearchCount");
  cnt.value = searchCountOf(state.settings.searchCount ?? DEFAULT_SETTINGS.searchCount);
  const txt = (n) => (n ? `${n} links` : "todos los links");
  $("searchCountSaved").textContent = "Ahora: " + txt(+cnt.value);
  const saveCount = async (v) => {
    const n = searchCountOf(typeof v === "number" ? v : cnt.value);
    cnt.value = n;
    const { settings: cur = {} } = await chrome.storage.local.get("settings"); // sin pisar otros ajustes
    state.settings = { ...state.settings, ...cur, searchCount: n };
    await chrome.storage.local.set({ settings: state.settings });
    const ok = (await chrome.storage.local.get("settings")).settings?.searchCount === n;
    $("searchCountSaved").textContent = ok ? `✓ Guardado: ${txt(n)}` : "No se pudo guardar";
  };
  $("btnSaveCount").onclick = () => saveCount();
  $("btnAllCount").onclick = () => saveCount(0);
  cnt.onchange = () => saveCount();
  cnt.onkeydown = (e) => { if (e.key === "Enter") saveCount(); };
  const opts = { optLive: "onlyLive", optAutoClear: "autoClear", optVlc: "vlcOpts", optStrip: "stripQuery", optPortable: "portableOnly" };
  $("optFormat").value = state.settings.listFormat;
  $("optFormat").onchange = (e) => { state.settings.listFormat = e.target.value; chrome.storage.local.set({ settings: state.settings }); render(); };
  for (const [id, prop] of Object.entries(opts)) {
    $(id).checked = state.settings[prop];
    $(id).onchange = (e) => { state.settings[prop] = e.target.checked; chrome.storage.local.set({ settings: state.settings }); render(); };
  }
  $("btnSettings").onclick = () => $("settings").classList.toggle("open");
  $("lnkShortcuts").onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: "chrome://extensions/shortcuts" }); };
  $("lnkOptions").onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
  $("tabThis").onclick = () => setView("tab");
  $("tabSaved").onclick = () => setView("saved");
  $("tabSearch").onclick = () => setView("search");

  // pie: esta pestaña
  const tabEntries = () => {
    const { list } = tabList();
    return list.map((s0, i) => {
      const s = state.ytMode.has(s0.key) ? { ...s0, useChannel: state.ytMode.get(s0.key) } : s0;
      return m3uFor(withGroup(s), state.settings, state.names.get(s.key) ?? defaultName(s, i, list.length));
    });
  };
  $("btnCopyAll").onclick = (e) => copy(m3uFile(tabEntries(), state.settings), e.currentTarget);
  $("btnExport").onclick = () => download(m3uFile(tabEntries(), state.settings), safeFile(cleanTitle(state.tabTitle) || "hls_lista") + ".m3u");
  // enviar a +4dBu TV: la lista va a tu página (Cloudflare) y tu +4dBu TV la agrega a tus favoritos solo
  // la página de donde salió cada link: +4dBu TV la usa para sacar un link nuevo cuando el viejo vence (link vivo)
  const pagesOf = (items) => { const o = {}; for (const it of items) { const pg = it.pageUrl || ""; if (!/^https?:/i.test(pg)) continue; for (const u of [it.url, effUrl(it)]) if (u) o[u] = pg; } return o; };
  const openTvSend = (getEntries, what, getItems = () => []) => {
    const box = $("tvSend"), s = state.settings || {};
    if (!box.hidden && box.dataset.what === what) { box.hidden = true; return; }
    box.dataset.what = what;
    const head = el("div", { className: "tvh" }, icon("cast", 14), el("span", { textContent: "Enviar a +4dBu TV" }));
    if (!s.tvUrl || !s.tvKey) {
      box.replaceChildren(head, el("div", { className: "tvst", textContent: "Falta conectar tu +4dBu TV: Más opciones → «+4dBu TV» (dirección y clave del puente)." }),
        el("div", { className: "row" }, btn(["settings", "Abrir Más opciones"], () => chrome.runtime.openOptionsPage(), "b primary"), btn("Cerrar", () => { box.hidden = true; })));
      box.hidden = false; return;
    }
    const n = getEntries().length;
    const dl = el("datalist", { id: "tvCats" }); for (const c of state.categories || []) dl.append(el("option", { value: c }));
    const inp = el("input", { type: "text", placeholder: "Categoría en +4dBu TV (vacío = la que ya tenga cada uno)", value: s.tvLastGroup || "" }); inp.setAttribute("list", "tvCats");
    const st = el("div", { className: "tvst", textContent: n ? `${n} elemento(s) de ${what}.` : "No hay nada para enviar." });
    const go = btn(["cast", `Enviar ${n}`], async () => {
      const entries = getEntries(); if (!entries.length) return;
      go.disabled = true; st.className = "tvst"; st.textContent = "Enviando…";
      try {
        const r = await fetch(`${s.tvUrl.trim().replace(/\/+$/, "")}/entrada?k=${encodeURIComponent(s.tvKey.trim())}`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ m3u: m3uFile(entries, s), pages: pagesOf(getItems()), group: inp.value.trim(), from: state.view === "tab" ? (state.tabTitle || "") : "Guardados de la extensión" }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(r.status === 401 ? "la clave del puente no coincide" : r.status === 404 ? "publica tu +4dBu TV de nuevo (PUBLICAR.bat)" : d.error || "respondió " + r.status);
        st.className = "tvst ok"; st.textContent = `✓ Enviado (${entries.length}). Aparece en tu +4dBu TV en menos de un minuto.`;
        const { settings: cur = {} } = await chrome.storage.local.get("settings");
        await chrome.storage.local.set({ settings: { ...cur, tvLastGroup: inp.value.trim() } });
      } catch (e) { st.className = "tvst err"; st.textContent = "✗ No se pudo: " + (e.message || e); }
      go.disabled = false;
    }, "b primary");
    go.disabled = !n;
    box.replaceChildren(head, dl, inp, el("div", { className: "row" }, go, btn("Cerrar", () => { box.hidden = true; })), st);
    box.hidden = false; inp.focus();
  };
  $("btnTvSend").onclick = () => openTvSend(tabEntries, "esta pestaña", () => tabList().list);
  $("btnTvSendSaved").onclick = () => openTvSend(() => sortByCategory(state.filter ? state.favorites.filter((f) => groupFor(f) === state.filter) : state.favorites, state.categories).map((f) => m3uFor(f, state.settings)), state.filter ? `«${state.filter}»` : "tus guardados", () => state.filter ? state.favorites.filter((f) => groupFor(f) === state.filter) : state.favorites);
  $("btnClear").onclick = () => { if (state.tabId != null) chrome.runtime.sendMessage({ action: "clearStreams", tabId: state.tabId }); };

  // pie: guardados
  $("btnExportSaved").onclick = () => download(m3uFile(sortByCategory(state.favorites, state.categories).map((f) => m3uFor(f, state.settings)), state.settings), "canales_guardados.m3u");
  $("btnImport").onclick = () => $("fileImport").click();
  $("fileImport").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const items = parseM3u(await file.text());
    let added = 0;
    for (const it of items) {
      const id = ytId(it.url);
      const k = id ? "yt:" + id : keyOf(it.url);
      if (isSaved(k)) continue;
      // las categorías de la lista importada se conservan (las automáticas se recalculan)
      const g = it.group && !AUTO_GROUPS.includes(it.group) ? it.group : "";
      if (g && !state.categories.includes(g)) state.categories.push(g);
      state.favorites.push({ key: k, url: it.url, kind: detectKind(it.url) || (/youtube\.com\//.test(it.url) ? "youtube" : "hls"), referer: it.referer, name: it.name, thumb: it.thumb || "", group: g, addedAt: Date.now() });
      added++;
    }
    await saveCategories();
    await saveFavorites();
    e.target.value = "";
    flash($("btnImport"), `+${added} canales`);
    setView("saved");
  };
  let armed = false;
  $("btnClearSaved").onclick = async (e) => {
    const b = $("btnClearSaved");
    if (!armed) { armed = true; setLabel(b, ["trash", "¿Seguro?"]); setTimeout(() => { armed = false; setLabel(b, ["trash", "Vaciar"]); }, 2500); return; }
    state.favorites = []; await saveFavorites(); armed = false; setLabel(b, ["trash", "Vaciar"]); render();
  };

  // vista inicial: si la pestaña no tiene flujos pero hay guardados, mostrar guardados
  setView(searchRunning(state.search) ? "search" : !state.streams.length && state.favorites.length ? "saved" : "tab");

  // actualización en vivo
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.scan) {
      state.scan = changes.scan.newValue || null;
      if (state.view === "search" && state.searchMode === "scan") render();
    }
    if (area === "session" && changes.search) {
      state.search = changes.search.newValue || null;
      if (state.view === "search") render();
    }
    if (area === "session" && changes[key]) {
      state.streams = changes[key].newValue?.streams || [];
      if (!state.streams.length) state.analysis.clear();
      render();
      if (state.view === "tab") analyzeAll(state.streams);
    }
    // background.js renovó el token de un guardado: tomar el link nuevo sin pisar lo que se esté editando
    if (area === "local" && changes.favorites) {
      const nv = changes.favorites.newValue || [];
      if (JSON.stringify(nv) !== JSON.stringify(state.favorites)) {
        const typing = document.activeElement?.matches?.("input.name, input.catname");
        if (changes.syncApplying && !typing) {
          // llegaron cambios desde el iPhone: se toma la lista completa
          state.favorites = nv;
        } else {
          // renovación de un token: solo el link, sin pisar lo que se esté editando
          for (const nf of nv) {
            const f = favOf(nf.key);
            if (f && f.url !== nf.url) { f.url = nf.url; f.referer = nf.referer; f.renewedAt = nf.renewedAt; state.analysis.delete(f.key); }
          }
        }
        if (state.view === "saved" && !typing) { render(); analyzeAll(state.favorites); }
      }
    }
    if (area === "local" && (changes.health || changes.healthMeta)) {
      if (changes.health) state.health = changes.health.newValue || {};
      if (changes.healthMeta) state.healthMeta = changes.healthMeta.newValue || {};
      if (state.view === "saved") render();
    }
    if (area === "local" && changes.categories && JSON.stringify(changes.categories.newValue || []) !== JSON.stringify(state.categories)) {
      state.categories = changes.categories.newValue || [];
      render();
    }
    if (area === "local" && changes.publish) { state.publish = changes.publish.newValue || {}; if (state.view === "saved") render(); }
  });
});
