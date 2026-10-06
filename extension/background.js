// HLS Stream Detector — service worker (Manifest V3)
// Estado por pestaña en chrome.storage.session: sobrevive a que Chrome duerma el service worker.
importScripts("lib/common.js", "lib/icons.js", "lib/lang.js", "lib/search.js", "lib/scan.js", "lib/health.js", "lib/relay.js", "lib/sync.js", "lib/recorder.js");

const MAX_PER_TAB = 100;
const reqHeaders = new Map(); // requestId -> { referer, origin }, solo mientras dura la petición
const tabKey = (tabId) => `tab:${tabId}`;

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
async function getTab(tabId) {
  const k = tabKey(tabId);
  return (await chrome.storage.session.get(k))[k] || { streams: [] };
}
function setBadge(tabId, count) {
  if (recOn(tabId)) { // grabando pasos en esta pestaña (lib/recorder.js)
    chrome.action.setBadgeText({ tabId, text: "REC" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#ff3b30" }).catch(() => {});
    return;
  }
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#e5484d" }).catch(() => {});
}

// Cola en serie: evita que peticiones simultáneas se pisen al escribir en storage
let queue = Promise.resolve();
function serial(fn) {
  queue = queue.catch(() => {}).then(fn).catch((e) => console.warn("[HLS]", e));
  return queue;
}

// ---------- registro ----------
async function record(tabId, info) {
  const data = await getTab(tabId);
  const key = info.key || keyOf(info.url);
  const now = Date.now();
  let s = data.streams.find((x) => x.key === key);
  if (s) {
    s.url = info.url; // conservar el token más reciente
    s.lastSeen = now;
    s.hits = (s.hits || 1) + 1;
    if (info.referer) s.referer = info.referer;
    if (info.size) s.size = info.size;
    if (info.meta) for (const [k, v] of Object.entries(info.meta)) if (v) s[k] = v;
  } else {
    let pageTitle = "", pageUrl = "";
    try { const t = await chrome.tabs.get(tabId); pageTitle = t.title || ""; pageUrl = t.url || ""; } catch {}
    s = { key, url: info.url, kind: info.kind, referer: info.referer || "", origin: info.origin || "",
      contentType: info.contentType || "", via: info.via, firstSeen: now, lastSeen: now, hits: 1, pageTitle, pageUrl,
      size: info.size || 0, ...(info.meta || {}) };
    data.streams.push(s);
    if (data.streams.length > MAX_PER_TAB) data.streams.shift();
  }
  await chrome.storage.session.set({ [tabKey(tabId)]: data });
  setBadge(tabId, data.streams.length);
  await refreshFavorite(key, info);
}

// Si el flujo ya está en Guardados y llega con un token nuevo, se actualiza su link
// (y el link único de la lista se republica solo). Así basta con volver a abrir la página.
async function refreshFavorite(key, info) {
  if (!info.url || info.kind === "youtube") return;
  const { favorites = [] } = await chrome.storage.local.get("favorites");
  const f = favorites.find((x) => x.key === key);
  if (!f || f.url === info.url) return;
  f.url = info.url;
  if (info.referer) f.referer = info.referer;
  f.renewedAt = Date.now();
  await chrome.storage.local.set({ favorites });
}
async function clearTab(tabId) {
  await chrome.storage.session.remove(tabKey(tabId));
  setBadge(tabId, 0);
}

// Tamaño total del archivo (Content-Range en descargas parciales, si no Content-Length)
function totalSize(headers) {
  let len = 0;
  for (const h of headers || []) {
    const n = h.name.toLowerCase();
    if (n === "content-range") { const m = h.value.match(/\/(\d+)/); if (m) return +m[1]; }
    else if (n === "content-length") len = +h.value || 0;
  }
  return len;
}

// ---------- YouTube ----------
// Lee de la página del video: título, canal, si está EN VIVO y el ID del canal
async function ytInfo(id) {
  const r = await fetch(ytWatchUrl(id) + "&hl=es", { credentials: "include" });
  const html = await r.text();
  const str = (re) => { const m = html.match(re); try { return m ? JSON.parse('"' + m[1] + '"') : ""; } catch { return m?.[1] || ""; } };
  const channelId = (html.match(/"channelId":"(UC[\w-]{22})"/) || [])[1] || "";
  return {
    title: str(/"videoDetails":\{[^]*?"title":"((?:[^"\\]|\\.)*)"/),
    author: str(/"videoDetails":\{[^]*?"author":"((?:[^"\\]|\\.)*)"/),
    live: /"isLiveNow":true/.test(html),
    upcoming: /"isUpcoming":true/.test(html),
    channelId
  };
}

const ytPending = new Set();
async function recordYouTube(tabId, url, referer = "") {
  const id = ytId(url);
  if (!id || tabId < 0 || ytPending.has(tabId + id)) return;
  const data = await getTab(tabId);
  if (data.streams.some((x) => x.key === "yt:" + id)) return;
  ytPending.add(tabId + id);
  try {
    const info = await ytInfo(id).catch(() => ({}));
    const channelLive = info.channelId ? `https://www.youtube.com/channel/${info.channelId}/live` : "";
    await serial(() => record(tabId, {
      url: ytWatchUrl(id), key: "yt:" + id, kind: "youtube", referer, via: "youtube",
      meta: { ytId: id, live: !!info.live, upcoming: !!info.upcoming, title: info.title || "", author: info.author || "",
        channelId: info.channelId || "", channelLive, useChannel: !!(info.live && channelLive),
        thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }
    }));
  } finally { ytPending.delete(tabId + id); }
}

// Videos de YouTube incrustados en otras páginas
chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId >= 0) recordYouTube(d.tabId, d.url, d.initiator ? d.initiator + "/" : "");
}, { urls: ["*://*.youtube.com/embed/*", "*://*.youtube-nocookie.com/embed/*"], types: ["sub_frame"] });

// Peticiones hechas desde el service worker de una página llegan con tabId -1:
// se asignan a la pestaña cuyo origen coincide con el "initiator".
async function resolveTabId(d) {
  if (d.tabId >= 0) return d.tabId;
  if (!d.initiator || d.initiator === "null") return -1;
  try {
    const tabs = await chrome.tabs.query({});
    const match = tabs.filter((t) => { try { return new URL(t.url).origin === d.initiator; } catch { return false; } });
    return (match.find((t) => t.active) || match[0])?.id ?? -1;
  } catch { return -1; }
}

// ---------- escucha de red ----------
const MEDIA_TYPES = ["xmlhttprequest", "media", "other"];
const ALL = { urls: ["<all_urls>"] };

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0) return;
  serial(async () => { if ((await getSettings()).autoClear) await clearTab(d.tabId); });
}, { ...ALL, types: ["main_frame"] });

chrome.webRequest.onSendHeaders.addListener((d) => {
  let referer = "", origin = "";
  for (const h of d.requestHeaders || []) {
    const n = h.name.toLowerCase();
    if (n === "referer") referer = h.value;
    else if (n === "origin") origin = h.value;
  }
  if (referer || origin) {
    if (reqHeaders.size > 1000) reqHeaders.clear();
    reqHeaders.set(d.requestId, { referer, origin });
  }
}, { ...ALL, types: MEDIA_TYPES }, ["requestHeaders", "extraHeaders"]);

chrome.webRequest.onResponseStarted.addListener((d) => {
  const hdr = reqHeaders.get(d.requestId);
  reqHeaders.delete(d.requestId);
  if (d.statusCode >= 400) return;
  if (d.initiator && d.initiator.startsWith("chrome-extension://")) return; // monitor/análisis propios
  const ct = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === "content-type")?.value || "";
  const kind = detectKind(d.url, ct);
  if (!kind || kind === "youtube") return;
  const size = totalSize(d.responseHeaders);
  if (kind === "file") {
    if (/(^|\.)googlevideo\.com$/.test(hostOf(d.url))) return; // fragmentos internos de YouTube
    if (size && size < 150e3) return; // miniaturas, anuncios cortos
  }
  serial(async () => {
    const tabId = await resolveTabId(d);
    if (tabId < 0) return;
    await record(tabId, {
      url: d.url, kind, contentType: ct, size,
      referer: hdr?.referer || (d.initiator ? d.initiator + "/" : ""),
      origin: hdr?.origin || d.initiator || "",
      via: /mpegurl|dash\+xml/i.test(ct) && !/\.(m3u8|mpd)/i.test(d.url) ? "content-type" : "url"
    });
  });
}, { ...ALL, types: MEDIA_TYPES }, ["responseHeaders"]);

chrome.webRequest.onErrorOccurred.addListener((d) => reqHeaders.delete(d.requestId), { ...ALL, types: MEDIA_TYPES });

// ---------- pestañas ----------
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(tabKey(tabId));
  // regla de Referer que el monitor haya creado para esa pestaña
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete") getTab(tabId).then((d) => setBadge(tabId, d.streams.length));
  const url = info.url || (info.status === "complete" ? tab?.url : "");
  if (url && ytId(url)) recordYouTube(tabId, url);
});

// ---------- copiar sin abrir el popup (documento offscreen) ----------
async function copyText(text) {
  const has = await chrome.offscreen.hasDocument?.();
  if (!has) {
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["CLIPBOARD"], justification: "Copiar el link detectado al portapapeles" });
  }
  return chrome.runtime.sendMessage({ target: "offscreen", action: "copy", text });
}

// Flujo principal de la pestaña: el primer HLS detectado (normalmente la lista maestra)
async function mainStream(tabId) {
  const { streams } = await getTab(tabId);
  return streams.find((s) => s.kind === "hls") || streams.find((s) => s.kind === "youtube") || streams.find((s) => s.kind === "file") || streams[0] || null;
}

async function flashBadge(tabId, text, color) {
  await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  setTimeout(() => getTab(tabId).then((d) => setBadge(tabId, d.streams.length)), 1600);
}

async function runAction(action, tab) {
  if (!tab?.id) return;
  const s = await mainStream(tab.id);
  if (!s) return flashBadge(tab.id, "0", "#6b7079");
  if (action === "copy-main") {
    const ok = await copyText(effUrl(s)).catch(() => false);
    flashBadge(tab.id, ok ? "✓" : "!", ok ? "#1f9d55" : "#e5484d");
  } else if (action === "copy-m3u") {
    const settings = await getSettings();
    const ok = await copyText(m3uFile([m3uFor(s, settings, cleanTitle(s.title || s.pageTitle || tab.title) || hostOf(s.url))])).catch(() => false);
    flashBadge(tab.id, ok ? "✓" : "!", ok ? "#1f9d55" : "#e5484d");
  } else if (action === "monitor-main") {
    if (s.kind === "youtube" || s.kind === "dash") return flashBadge(tab.id, "!", "#6b7079");
    chrome.tabs.create({ url: monitorUrl(s.url, s.referer, cleanTitle(s.pageTitle || tab.title), s.kind), index: tab.index + 1 });
  }
}

// Menú de clic derecho
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const contexts = ["page", "video", "frame", "action"];
    chrome.contextMenus.create({ id: "root", title: "HLS Stream Detector", contexts });
    chrome.contextMenus.create({ id: "copy-main", parentId: "root", title: "Copiar link del flujo principal", contexts });
    chrome.contextMenus.create({ id: "copy-m3u", parentId: "root", title: "Copiar como M3U (VLC)", contexts });
    chrome.contextMenus.create({ id: "monitor-main", parentId: "root", title: "Abrir monitor en vivo", contexts });
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => runAction(info.menuItemId, tab));

// Atajos de teclado (configurables en chrome://extensions/shortcuts)
chrome.commands.onCommand.addListener((command, tab) => (command === "rec-toggle" ? recToggle(tab) : runAction(command, tab)));

// Clic en una alerta del monitor -> ir a esa pestaña
chrome.notifications.onClicked.addListener((id) => {
  const m = id.match(/^mon:(\d+)/);
  if (m) chrome.tabs.update(+m[1], { active: true }).then((t) => chrome.windows.update(t.windowId, { focused: true })).catch(() => {});
  chrome.notifications.clear(id);
});

// ---------- link único de lista: Gist secreto de GitHub ----------
// La lista de "Guardados" se publica como lista.m3u en un Gist; el link raw no cambia
// aunque se actualice, así que sirve como "un solo link" para VLC, Kodi o apps IPTV.
const GIST_FILE = "lista.m3u";
const PAGE_FILE = "canales.html";

async function publishPlaylist() {
  const { publish = {}, favorites = [], settings, categories = [], health = {} } = await chrome.storage.local.get(["publish", "favorites", "settings", "categories", "health"]);
  if (!publish.token) throw new Error("Falta el token de GitHub");
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const content = m3uFile(sortByCategory(favorites, categories).map((f) => m3uFor(f, s)), s);
  const files = { [GIST_FILE]: { content } };
  // página para el celular (necesita saber el link de la lista, que depende del Gist)
  const listLinkOf = (owner, id) => `https://gist.githubusercontent.com/${owner}/${id}/raw/${GIST_FILE}`;
  if (s.mobilePage && publish.gistId && publish.owner) files[PAGE_FILE] = { content: buildMobilePage(favorites, categories, health, s, listLinkOf(publish.owner, publish.gistId)) };
  else if (!s.mobilePage && publish.pageLink) files[PAGE_FILE] = null; // apagada: se borra del Gist
  const body = { description: "Lista M3U — HLS Stream Detector", files };
  const headers = {
    Authorization: `Bearer ${publish.token}`, Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json"
  };
  try {
    let r = publish.gistId
      ? await fetch(`https://api.github.com/gists/${publish.gistId}`, { method: "PATCH", headers, body: JSON.stringify(body) })
      : null;
    if (!r || r.status === 404) r = await fetch("https://api.github.com/gists", { method: "POST", headers, body: JSON.stringify({ ...body, public: false }) });
    if (!r.ok) throw new Error(r.status === 401 ? "El token de GitHub no es válido o venció" : r.status === 403 || r.status === 422 ? "El token no tiene permiso «gist»" : `GitHub respondió ${r.status}`);
    const g = await r.json();
    const owner = g.owner?.login || publish.owner;
    const next = { ...publish, gistId: g.id, owner, htmlUrl: g.html_url,
      link: listLinkOf(owner, g.id),
      pageLink: s.mobilePage && files[PAGE_FILE] ? `https://gist.githack.com/${owner}/${g.id}/raw/${PAGE_FILE}` : "",
      lastPublished: Date.now(), count: favorites.length, lastError: "" };
    // primera publicación: la página se sube en una segunda pasada, ya con el link de la lista
    if (s.mobilePage && !files[PAGE_FILE]) {
      await chrome.storage.local.set({ publish: next });
      return publishPlaylist();
    }
    await chrome.storage.local.set({ publish: next });
    return next;
  } catch (e) {
    const msg = e.message === "Failed to fetch" ? "Sin conexión con GitHub" : e.message;
    await chrome.storage.local.set({ publish: { ...publish, lastError: msg } });
    throw new Error(msg);
  }
}

// Republicar solo cuando cambian los guardados (con pausa para agrupar cambios seguidos)
let publishTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.publish && !!changes.publish.oldValue?.token !== !!changes.publish.newValue?.token) { scheduleRelay(); syncSoon(); }
  if ((changes.favorites || changes.categories) && !changes.syncApplying) syncSoon();
  if (changes.settings) {
    const a = changes.settings.oldValue || {}, b = changes.settings.newValue || {};
    if (a.healthEvery !== b.healthEvery) scheduleHealth();
    if (a.relayOn !== b.relayOn) scheduleRelay();
    if (a.epgUrl === b.epgUrl && a.mobilePage === b.mobilePage && a.listFormat === b.listFormat) return;
  } else if (!(changes.favorites || changes.categories)) return;
  clearTimeout(publishTimer);
  publishTimer = setTimeout(async () => {
    const { publish } = await chrome.storage.local.get("publish");
    if (publish?.token && publish.auto !== false) publishPlaylist().catch(() => {});
  }, 1500);
});

// ---------- mensajes del popup ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === "offscreen") return; // lo atiende offscreen.js
  if (msg?.action === "foundVideo" && _sender.tab?.id >= 0 && /^https?:/i.test(msg.url || "")) {
    if (/(^|\.)googlevideo\.com$/.test(hostOf(msg.url))) return;
    const kind = detectKind(msg.url) || "file";
    if (kind === "youtube") { recordYouTube(_sender.tab.id, msg.url, _sender.url || ""); return; }
    serial(() => record(_sender.tab.id, {
      url: msg.url, kind, referer: _sender.url || "", origin: _sender.origin || "", via: "reproductor",
      meta: kind === "file" ? { duration: msg.duration || 0, width: msg.width || 0, height: msg.height || 0, thumb: msg.poster || "" } : null
    }));
    return;
  }
  if (msg?.action === "search" && ((typeof msg.query === "string" && msg.query.trim()) || /^https?:\/\//i.test(msg.pageUrl || ""))) {
    runSearch(msg.query || "", { pageUrl: msg.pageUrl || "" }); // corre en segundo plano; el progreso queda en storage.session "search"
    sendResponse({ ok: true });
    return;
  }
  if (msg?.action === "cancelSearch") { cancelSearch(); sendResponse({ ok: true }); return; }
  // escaneo global: corre en segundo plano; el progreso queda en storage.session "scan"
  if (msg?.action === "scan" && msg.filters) { runScan(msg.filters); sendResponse({ ok: true }); return; }
  if (msg?.action === "cancelScan") { cancelScan(); sendResponse({ ok: true }); return; }
  if (msg?.action === "playerCheck" && msg.url) {
    playerCheck(msg.url, msg.referer || "").then((r) => sendResponse(r), (e) => sendResponse({ verdict: "down", why: e.message }));
    return true;
  }
  if (msg?.action === "carCheckSaved" && Array.isArray(msg.keys)) {
    (async () => {
      for (const key of msg.keys.slice(0, 20)) {
        const { favorites = [] } = await chrome.storage.local.get("favorites");
        const f = favorites.find((x) => x.key === key);
        if (!f || f.kind === "youtube" || f.kind === "dash") continue;
        const r = f.kind === "file"
          ? await checkOne(f).then((x) => ({ verdict: x.ok ? "ok" : "down", why: x.why }))
          : await playerCheck(f.url, f.referer || "").catch((e) => ({ verdict: "down", why: e.message }));
        const again = (await chrome.storage.local.get("favorites")).favorites || [];
        const g = again.find((x) => x.key === key);
        if (g) { g.car = carFrom(r.verdict, r.why || ""); await chrome.storage.local.set({ favorites: again }); }
      }
    })();
    sendResponse({ ok: true });
    return;
  }
  if (msg?.action === "syncNow") { syncNow("manual").then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: e.message })); return true; }
  if (msg?.action === "relayNow") { relayTick().then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: e.message })); return true; }
  if (msg?.action === "runHealth") { runHealth("manual").then((r) => sendResponse(r), (e) => sendResponse({ error: e.message })); return true; }
  if (msg?.action === "remoteAlert" && msg.text) { sendRemoteAlert(msg.text).then((r) => sendResponse(r), (e) => sendResponse({ errors: [e.message] })); return true; }
  if (msg?.action === "assignGuide") {
    (async () => {
      const { favorites = [] } = await chrome.storage.local.get("favorites");
      const n = await assignGuideIds(favorites);
      if (n) await chrome.storage.local.set({ favorites });
      return { assigned: n };
    })().then((r) => sendResponse(r), (e) => sendResponse({ error: e.message === "Failed to fetch" ? "No se pudo leer el directorio de canales" : e.message }));
    return true;
  }
  if (msg?.action === "publish") {
    publishPlaylist().then((p) => sendResponse({ ok: true, publish: p }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.action === "clearStreams" && typeof msg.tabId === "number") {
    serial(() => clearTab(msg.tabId)).then(() => sendResponse({ status: "cleared" }));
    return true;
  }
});

// ---------- revisión automática programada ----------
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "health") runHealth("auto").catch((e) => console.warn("[HLS] revisión", e));
  if (a.name === "relay") { relayTick().catch((e) => console.warn("[HLS] puente", e)); syncNow("periódica").catch(() => {}); }
});
chrome.runtime.onInstalled.addListener(async () => {
  scheduleHealth(); scheduleRelay();
  const { settings } = await chrome.storage.local.get("settings");
  let m = migrateSettings(settings);
  // v5.2: «no omitir ningún link» → las búsquedas pasan a probar TODOS los links (se puede volver a poner un número)
  const cur = m || settings || {};
  if (!cur.allLinksV1) m = { ...cur, searchCount: 0, allLinksV1: true };
  if (m) await chrome.storage.local.set({ settings: m }); // cambia el formato -> la lista publicada se republica sola
});
chrome.runtime.onStartup.addListener(() => { scheduleHealth(); scheduleRelay(); });
