// ======================================================================================================
// GRABADOR DE PASOS (service worker)
// Tú haces a mano lo que harías para ver un video (entrar al título, tocar un servidor, cerrar publicidad,
// darle play…) y la extensión anota cada acción y lo que pasó después: páginas, iframes, pestañas nuevas, pedidos
// de red del reproductor (con lo que envían), listas/videos que llegan y si el video AVANZA de verdad.
// Graba SOLO la pestaña donde lo encendiste y las que se abran desde ella. Nada sale de tu computador: el informe
// (informe.html) lo copias tú, y los dominios se tapan al armar el informe, no al grabar.
// ======================================================================================================
const REC_MAX = 4000;              // eventos por grabación
const REC_KEEP = 8;                // informes guardados
const REC_MAX_MS = 45 * 60e3;      // se detiene sola a los 45 min
const REC_TYPES = ["main_frame", "sub_frame", "xmlhttprequest", "media", "other"];
const REC_NOISE = /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.[a-z.]+|facebook\.(com|net)|fbcdn\.net|hotjar\.com|clarity\.ms|scorecardresearch\.com|quantserve\.com|quantcount\.com|criteo\.(com|net)|taboola\.com|outbrain\.com|adnxs\.com|amazon-adsystem\.com|pubmatic\.com|rubiconproject\.com|cloudflareinsights\.com|mc\.yandex\.ru|yandex\.(ru|com)|histats\.com|disqus\.com|disquscdn\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|imasdk\.googleapis\.com|2mdn\.net|adsrvr\.org|teads\.tv)$/i;
const REC_SEG = /\.(ts|m4s|aac|m4a|vtt|webvtt|srt|key|jpg|jpeg|png|gif|webp|css|woff2?)(\?|#|$)|\/(seg|chunk|frag)[-_]?\d/i;
const REC_MEDIA = /\.(m3u8|mpd|mp4|m4v|webm|mov|mkv|flv)(\?|#|$)/i;
const REC_API = /(ajax|api|embed|player|source|video|stream|play|link|server|servidor|episod|watch|getfile|get_|download|redirect|decrypt|token|hls|dash|manifest|iframe|mirror|option)/i;

let REC = null, recKnown = false, recLoad = null, recSaveT = 0;
const recReq = new Map(); // requestId -> evento (para anotarle estado, tipo y redirecciones)
const recReady = () => (recLoad ||= chrome.storage.session.get("rec").then((o) => { REC = o.rec || null; recKnown = true; }, () => { recKnown = true; }));
recReady();

function recPersist(now = false) {
  clearTimeout(recSaveT);
  const go = () => chrome.storage.session.set({ rec: REC }).catch(() => {});
  if (now) return go();
  recSaveT = setTimeout(go, 700);
}
const recOn = (tabId) => !!REC && tabId >= 0 && REC.tabs.includes(tabId);
function recAdd(ev) {
  if (!REC) return null;
  if (REC.events.length >= REC_MAX) { REC.full = true; return null; }
  ev.t = Date.now() - REC.startedAt;
  if (ev.tab != null) { ev.p = REC.tabNo[ev.tab] || 0; delete ev.tab; }
  REC.events.push(ev);
  recPersist();
  if (ev.t > REC_MAX_MS) recStop("tiempo").then((id) => id && recOpenReport(id));
  return ev;
}
function recBody(rb) {
  if (!rb) return "";
  try {
    if (rb.formData) return Object.entries(rb.formData).map(([k, v]) => `${k}=${[].concat(v).join(",")}`).join("&").slice(0, 700);
    if (rb.raw?.[0]?.bytes) return new TextDecoder().decode(rb.raw[0].bytes).slice(0, 700);
  } catch {}
  return "";
}
const recOpenReport = (id) => chrome.tabs.create({ url: chrome.runtime.getURL("informe.html" + (id ? "#" + id : "")) }).catch(() => {});

async function recStart(tabId) {
  await recReady();
  if (REC) await recStop("se empezó otra grabación");
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/i.test(tab.url || "")) return { ok: false, error: "Abre primero una página web (http/https) en esta pestaña." };
  REC = { id: Date.now().toString(36), startedAt: Date.now(), tabs: [tabId], tabNo: { [tabId]: 1 }, nTabs: 1, lastActive: tabId,
    startUrl: tab.url, startTitle: tab.title || "", events: [], segs: {}, ver: chrome.runtime.getManifest().version };
  recAdd({ k: "start", tab: tabId, url: tab.url, title: tab.title || "" });
  await recPersist(true);
  await chrome.storage.local.set({ recActive: { on: true, at: REC.startedAt } });
  setBadge(tabId, 0);
  let ready = false; // ¿la página tiene el grabador cargado? (las abiertas antes de instalar/actualizar la extensión no)
  try { ready = !!(await chrome.tabs.sendMessage(tabId, { action: "recPing" }, { frameId: 0 })); } catch {}
  return { ok: true, ready };
}
async function recStop(reason = "manual") {
  await recReady();
  if (!REC) return null;
  const r = REC; REC = null; clearTimeout(recSaveT); recReq.clear();
  r.endedAt = Date.now(); r.stopReason = reason;
  const { recordings = [] } = await chrome.storage.local.get("recordings");
  let keep = [r, ...recordings.filter((x) => x.id !== r.id)].slice(0, REC_KEEP);
  for (;;) { // si no cabe, se borran los informes más viejos (nunca el que acabas de grabar)
    try { await chrome.storage.local.set({ recordings: keep }); break; }
    catch { if (keep.length <= 1) { r.events = r.events.slice(0, 1500); r.full = true; keep = [r]; } else keep = keep.slice(0, -1); }
  }
  await chrome.storage.local.set({ recActive: { on: false } });
  await chrome.storage.session.remove("rec").catch(() => {});
  for (const t of r.tabs) getTab(t).then((d) => setBadge(t, d.streams.length)).catch(() => {});
  return r.id;
}
async function recToggle(tab) {
  await recReady();
  if (REC) { const id = await recStop("atajo"); if (id) recOpenReport(id); }
  else if (tab?.id >= 0) { const r = await recStart(tab.id); flashBadge(tab.id, r.ok ? "REC" : "!", r.ok ? "#ff3b30" : "#6b7079"); }
}

// ---------- red de las pestañas grabadas ----------
function recNet(d) {
  if (!recOn(d.tabId) || (d.initiator || "").startsWith("chrome-extension://")) return;
  const host = hostOf(d.url).toLowerCase().replace(/:\d+$/, ""), t = d.type;
  const noise = REC_NOISE.test(host);
  let k;
  if (t === "main_frame") k = "nav";
  else if (t === "sub_frame") k = noise ? "frame-ad" : "frame";
  else {
    if (noise) return;
    let pq = ""; try { const u = new URL(d.url); pq = u.pathname + u.search; } catch {}
    if (/\/cdn-cgi\/(rum|zaraz|trace)\b/i.test(pq)) return; // mediciones de Cloudflare: ruido
    if (REC_MEDIA.test(d.url) || t === "media") k = "media";
    else if (REC_SEG.test(d.url)) { const n = (REC.segs[host] = (REC.segs[host] || 0) + 1); if (n > 1 || !/\.(ts|m4s|aac|m4a)(\?|#|$)|\/(seg|chunk|frag)/i.test(d.url)) { if (n > 1) recPersist(); return; } k = "seg"; }
    else if (d.method !== "GET" || REC_API.test(pq)) k = "xhr";
    else return;
  }
  const ev = recAdd({ k, tab: d.tabId, frame: d.frameId, type: t, method: d.method, url: d.url.slice(0, 700), from: d.initiator || "", body: d.method !== "GET" ? recBody(d.requestBody) : "" });
  if (ev) { recReq.set(d.requestId, ev); if (recReq.size > 1000) recReq.delete(recReq.keys().next().value); }
}
const recFast = () => recKnown && !REC; // sin grabar: no se hace nada más
chrome.webRequest.onBeforeRequest.addListener((d) => { if (!recFast()) recReady().then(() => recNet(d)); }, { urls: ["<all_urls>"], types: REC_TYPES }, ["requestBody"]);
chrome.webRequest.onBeforeRedirect.addListener((d) => {
  const ev = recReq.get(d.requestId); if (!ev) return;
  (ev.redir ||= []).push(String(d.redirectUrl).slice(0, 500)); ev.st = d.statusCode; recPersist();
}, { urls: ["<all_urls>"], types: REC_TYPES });
chrome.webRequest.onResponseStarted.addListener((d) => {
  const ev = recReq.get(d.requestId); if (!ev) return;
  ev.st = d.statusCode;
  ev.ct = ((d.responseHeaders || []).find((h) => h.name.toLowerCase() === "content-type")?.value || "").split(";")[0];
  recPersist();
}, { urls: ["<all_urls>"], types: REC_TYPES }, ["responseHeaders"]);
chrome.webRequest.onErrorOccurred.addListener((d) => {
  const ev = recReq.get(d.requestId); if (!ev) return;
  ev.err = d.error; recReq.delete(d.requestId); recPersist();
}, { urls: ["<all_urls>"], types: REC_TYPES });

// ---------- pestañas ----------
chrome.tabs.onCreated.addListener((tab) => { if (!recFast()) recReady().then(() => {
  if (!recOn(tab.openerTabId)) return;
  REC.tabs.push(tab.id); REC.tabNo[tab.id] = ++REC.nTabs;
  recAdd({ k: "tab-new", tab: tab.id, from: REC.tabNo[tab.openerTabId], url: tab.pendingUrl || tab.url || "" });
  setBadge(tab.id, 0);
}); });
chrome.tabs.onRemoved.addListener((tabId) => { if (!recFast()) recReady().then(() => {
  if (!recOn(tabId)) return;
  recAdd({ k: "tab-close", tab: tabId });
  REC.tabs = REC.tabs.filter((x) => x !== tabId);
  if (!REC.tabs.length) recStop("cerraste las pestañas grabadas").then((id) => id && recOpenReport(id));
}); });
chrome.tabs.onActivated.addListener(({ tabId }) => { if (!recFast()) recReady().then(() => {
  if (!recOn(tabId) || REC.lastActive === tabId) return;
  REC.lastActive = tabId; recAdd({ k: "tab-switch", tab: tabId });
}); });

// ---------- mensajes (página grabada y popup) ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const a = msg?.action;
  if (typeof a !== "string" || !/^rec(Hello|Ev|Start|Stop|Note|Status)$/.test(a)) return;
  recReady().then(async () => {
    const tabId = sender.tab?.id;
    if (a === "recHello") {
      const on = recOn(tabId);
      if (on && msg.info) { const i = msg.info; recAdd({ k: "page", tab: tabId, frame: sender.frameId, url: String(i.url || "").slice(0, 700), top: !!i.top, title: String(i.title || "").slice(0, 150), nv: +i.nv || 0, nf: +i.nf || 0, ifr: (i.ifr || []).slice(0, 12), ref: String(i.ref || "").slice(0, 300) }); }
      return { on };
    }
    if (a === "recEv") { if (recOn(tabId) && msg.e?.k) recAdd({ ...msg.e, k: String(msg.e.k).slice(0, 12), tab: tabId, frame: sender.frameId }); return { ok: true }; }
    if (a === "recStart") return recStart(msg.tabId);
    if (a === "recStop") return { id: await recStop("manual") };
    if (a === "recNote") { const ok = !!REC && !!String(msg.text || "").trim(); if (ok) recAdd({ k: "note", text: String(msg.text).trim().slice(0, 600), tab: REC.lastActive }); return { ok }; }
    return REC ? { on: true, startedAt: REC.startedAt, n: REC.events.length, tabs: REC.tabs, full: !!REC.full } : { on: false };
  }).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
