// Utilidades compartidas por el popup, el monitor y el service worker.
// Sin acceso al DOM en el nivel superior (el service worker lo carga con importScripts).

const DEFAULT_SETTINGS = {
  autoClear: true, stripQuery: false, vlcOpts: true, onlyLive: false,
  alertNotify: true, alertSound: true,
  listFormat: "iptv", // "iptv" = CarTV, TiviMate, Smarters, OTT Navigator, Kodi (Referer pegado al link) · "both" = VLC + apps IPTV · "vlc"
  fmtV2: true,        // ya se aplicó el cambio de formato por defecto a «iptv»
  // revisión automática de Guardados
  healthEvery: 15,     // minutos (0 = apagada)
  healthRenew: true,   // renovar solos los links vencidos o por vencer abriendo su página
  // lista publicada
  epgUrl: "",          // guía de programación XMLTV (url-tvg)
  mobilePage: true,    // publicar también la página para el celular
  // modo producción (+4dBu)
  eventName: "", tgToken: "", tgChat: "", cmbPhone: "", cmbKey: "",
  // puente con la app del iPhone (usa el mismo GitHub de la lista publicada)
  relayOn: true,
  syncOn: true,       // sincronizar Guardados con la app del iPhone
  cartvOnly: true,    // solo aptos para CarTV: todo se prueba como CarTV antes de mostrarse o al guardarse
  searchCount: 0,     // cuántos links prueba cada búsqueda, en orden (directorio → sitios oficiales → web). 0 = TODOS
  langMode: "latam",
  portableOnly: true, // solo links que funcionan en cualquier red (celular con datos): descarta los amarrados a esta red y los que vencen pronto sin poder renovarse
  countries: [],      // países de la búsqueda y del escaneo: [] = todos · "LATAM" · "MX", "CO"… (ver lib/lang.js)  // idioma de la búsqueda y del escaneo: latam | spa | es | any (ver lib/lang.js)    // cuántos links prueba cada búsqueda, en orden (directorio → sitio oficial → web). Sin tope.
  braveKey: ""        // clave de Brave Search API (buscador principal); sin clave se usa DuckDuckGo/Bing
};
// «Links a probar»: 0 = todos
const searchCountOf = (v) => (v === "" || v == null || !Number.isFinite(+v) ? 0 : Math.max(0, Math.round(+v))); // 0 = todos
// car = { ok, verdict, why, at }: resultado de la última prueba «como CarTV» (ok/referer = apto)
const carFrom = (verdict, why = "") => ({ ok: verdict === "ok" || verdict === "referer", verdict, why, at: Date.now() });
// Ajustes con claves privadas: nunca van en la copia de seguridad
const SECRET_SETTINGS = ["tgToken", "cmbKey", "braveKey"];

const keyOf = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; } };
const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };
const oneLine = (t) => (t || "").replace(/[\r\n]+/g, " ").trim();
const cleanTitle = (t) => (t || "").replace(/\s+/g, " ").trim().slice(0, 70);
const safeFile = (t) => (t || "lista").replace(/[\\/:*?"<>|\r\n]+/g, "_").replace(/\s+/g, "_").slice(0, 60) || "lista";

// ---------- tipo de flujo ----------
const FILE_EXT = /\.(mp4|m4v|webm|mov|mkv|ogv)$/i;
const FILE_CT = /^video\/(mp4|webm|quicktime|x-matroska|ogg|x-m4v)/i;

function detectKind(url, contentType = "") {
  let path = "";
  try { path = new URL(url).pathname; } catch {}
  if (ytId(url)) return "youtube";
  if (/\.m3u8/i.test(path) || /mpegurl/i.test(contentType)) return "hls";
  if (/\.mpd$/i.test(path) || /dash\+xml/i.test(contentType)) return "dash";
  if (FILE_EXT.test(path) || FILE_CT.test(contentType)) return "file";
  return null;
}

// ---------- YouTube ----------
// Devuelve el ID de 11 caracteres de un link de YouTube (watch, youtu.be, live, embed, shorts) o null
function ytId(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^(www|m|music)\./, "");
    let id = null;
    if (h === "youtu.be") id = u.pathname.slice(1, 12);
    else if (h === "youtube.com" || h === "youtube-nocookie.com") {
      if (u.pathname === "/watch") id = u.searchParams.get("v");
      else id = (u.pathname.match(/^\/(?:live|embed|shorts|v)\/([\w-]{11})/) || [])[1];
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
const ytWatchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

// URL que va a la lista: para YouTube en vivo se puede usar el directo del canal (no caduca)
function effUrl(item) {
  return item.kind === "youtube" && item.useChannel && item.channelLive ? item.channelLive : item.url;
}

function fmtBytes(n) {
  if (!n) return "";
  return n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : n >= 1e6 ? Math.round(n / 1e6) + " MB" : Math.round(n / 1e3) + " KB";
}

// ---------- vencimiento de tokens ----------
// Busca fechas de expiración típicas de CDNs (Akamai, CloudFront, AWS, Wowza, nginx, JWT).
function jwtExp(t) {
  try {
    let p = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    p += "=".repeat((4 - (p.length % 4)) % 4);
    return JSON.parse(atob(p)).exp || null;
  } catch { return null; }
}

function tokenExpiry(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const now = Date.now() / 1000;
  const found = [];
  const push = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    const s = n > 1e12 ? n / 1000 : n; // milisegundos -> segundos
    if (s > now - 86400 * 365 && s < now + 86400 * 3650) found.push(s);
  };
  const EXP_KEY = /^(exp|expires|expire|expiry|expiration|e|validto|valid_to|deadline|policy_exp)$/i;
  const EXP_INNER = /(?:^|[~&;,:])exp(?:ires)?=(\d{10,13})/i;

  for (const [k, v] of u.searchParams) {
    if (EXP_KEY.test(k) || /tokenendtime$/i.test(k)) push(v);
    const m = v.match(EXP_INNER); if (m) push(m[1]);
    if (/^[\w-]{8,}\.[\w-]{8,}\.[\w-]+$/.test(v)) { const e = jwtExp(v); if (e) push(e); }
  }
  // Inicio + duración: ?s=1790570026&e=10800 (hora de creación + segundos de validez)
  const START_KEY = /^(s|st|start|starttime|start_time|issued|iat|t0)$/i;
  const DUR_KEY = /^(e|exp|expires|duration|validity|valid|ttl|lifetime|window)$/i;
  let start = null, dur = null;
  for (const [k, v] of u.searchParams) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (START_KEY.test(k) && n > 1e9) start = n > 1e12 ? n / 1000 : n;
    else if (DUR_KEY.test(k) && n < 86400 * 30) dur = n;
  }
  if (start && dur) push(start + dur);
  // AWS firmado: X-Amz-Date + X-Amz-Expires (duración en segundos)
  const d = u.searchParams.get("X-Amz-Date"), ex = u.searchParams.get("X-Amz-Expires");
  const m = d && d.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (m && ex) push(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 + Number(ex));
  // Tokens dentro de la ruta: /exp=1712345678~acl=.../
  const pm = decodeURIComponent(u.pathname).match(/(?:^|[\/~;,])exp(?:ires)?=(\d{10,13})/i);
  if (pm) push(pm[1]);

  return found.length ? Math.min(...found) * 1000 : null;
}

// ---------- links amarrados a una red ----------
// Algunos servidores firman el link con la red (ASN) o la IP de quien lo pidió:
// solo funciona desde esa misma conexión (mismo wifi / mismo proveedor).
function networkLock(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  for (const [k, v] of u.searchParams) {
    if (/^(asn|as|asnum|isp)$/i.test(k) && /^\d{2,10}$/.test(v)) return { type: "asn", value: v };
    if (/^(ip|cip|clientip|client_ip|ipaddr|ip_addr|userip|user_ip|viewerip)$/i.test(k) && /^[\d.:a-f]{7,}$/i.test(v)) return { type: "ip", value: v };
    // también dentro de un token (hdnts=exp=…~ip=1.2.3.4~acl=…)
    const im = v.match(/(?:^|[~&;,:])(ip|clientip|cip|asn)=([\d.:a-f]{2,})/i);
    if (im && (/asn/i.test(im[1]) ? /^\d{2,10}$/.test(im[2]) : /^[\d.:a-f]{7,}$/i.test(im[2]))) return { type: /asn/i.test(im[1]) ? "asn" : "ip", value: im[2] };
  }
  const pm = decodeURIComponent(u.pathname).match(/(?:^|[\/~;,&])(asn|ip)=([\d.:a-f]{2,})/i);
  if (pm) return { type: pm[1].toLowerCase(), value: pm[2] };
  return null;
}
function lockText(lock) {
  return lock.type === "asn"
    ? `Amarrado a tu red (ASN ${lock.value}): solo se reproduce desde la misma conexión a internet donde lo capturaste (mismo wifi o proveedor). Con datos móviles u otro wifi el servidor lo rechaza.`
    : `Amarrado a tu IP (${lock.value}): solo se reproduce desde la misma conexión donde lo capturaste.`;
}

// ¿Este link sirve fuera de este computador? "" = sí · texto = por qué no (para no perder tiempo con él)
function portableIssue(url, canRenew) {
  if (networkLock(url)) return "amarrado a la red de este computador: no funcionaría en el celular con datos ni en otra red";
  const exp = tokenExpiry(url);
  if (exp && exp - Date.now() < 6 * 3600e3 && !canRenew) return `el link vence ${exp <= Date.now() ? "ya" : "en " + Math.max(1, Math.round((exp - Date.now()) / 60e3)) + " min"} y no hay página para renovarlo`;
  return "";
}
function fmtRemaining(ms) {
  if (ms <= 0) return "vencido";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `vence en ${s} s`;
  if (s < 3600) return `vence en ${Math.floor(s / 60)} min`;
  if (s < 172800) return `vence en ${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `vence en ${Math.floor(s / 86400)} días`;
}

// ---------- formato ----------
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
}
const fmtMbps = (bw) => (bw / 1e6).toFixed(bw >= 1e7 ? 0 : 1) + " Mbps";

// ---------- análisis HLS ----------
function parseAttrs(s) {
  const o = {}, re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) o[m[1]] = m[2].replace(/^"|"$/g, "");
  return o;
}
function resolveUrl(ref, base) { try { return new URL(ref, base).href; } catch { return ref; } }

function analyzeHls(text, base) {
  if (!text.replace(/^﻿/, "").trimStart().startsWith("#EXTM3U")) return { kind: "invalid" };
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [], media = [];
  let segs = 0, dur = 0, target = null, endlist = false, enc = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("#EXT-X-STREAM-INF:")) {
      const a = parseAttrs(l.slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith("#"))) j++;
      if (j < lines.length) {
        variants.push({ bw: +a.BANDWIDTH || 0, res: a.RESOLUTION || "", fps: a["FRAME-RATE"] || "", codecs: a.CODECS || "", url: resolveUrl(lines[j], base) });
        i = j;
      }
    } else if (l.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttrs(l.slice(13));
      media.push({ type: a.TYPE, name: a.NAME || a.LANGUAGE || "", url: a.URI ? resolveUrl(a.URI, base) : "" });
    } else if (l.startsWith("#EXTINF:")) { segs++; dur += parseFloat(l.slice(8)) || 0; }
    else if (l.startsWith("#EXT-X-TARGETDURATION:")) target = +l.slice(22);
    else if (l === "#EXT-X-ENDLIST") endlist = true;
    else if (l.startsWith("#EXT-X-KEY:")) { const a = parseAttrs(l.slice(11)); if (a.METHOD && a.METHOD !== "NONE") enc = a.METHOD; }
  }
  if (variants.length) return { kind: "master", variants: variants.sort((a, b) => b.bw - a.bw), media };
  if (segs) return { kind: "media", live: !endlist, segs, dur, target, enc };
  return { kind: "unknown" };
}

// ---------- análisis DASH (necesita DOMParser: solo popup/monitor) ----------
function parseIsoDuration(s) {
  const m = (s || "").match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
}
function analyzeMpd(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const mpd = doc.getElementsByTagName("MPD")[0];
  if (!mpd) return { kind: "invalid" };
  const reps = [...doc.getElementsByTagName("Representation")];
  const isVideo = (r) => r.getAttribute("height") || /video/.test(r.getAttribute("mimeType") || r.parentNode.getAttribute("mimeType") || "");
  const video = reps.filter(isVideo);
  return {
    kind: "dash",
    live: mpd.getAttribute("type") === "dynamic",
    reps: video.length,
    maxH: Math.max(0, ...video.map((r) => +r.getAttribute("height") || 0)),
    maxBw: Math.max(0, ...video.map((r) => +r.getAttribute("bandwidth") || 0)),
    drm: doc.getElementsByTagName("ContentProtection").length > 0,
    dur: parseIsoDuration(mpd.getAttribute("mediaPresentationDuration"))
  };
}

// ---------- salidas: M3U y comandos ----------
function outUrl(url, settings) {
  if (!settings?.stripQuery) return url;
  try { const u = new URL(url); u.search = ""; u.hash = ""; return u.href; } catch { return url; }
}

// User-Agent que va en la lista y con el que se prueba «como CarTV». Es el del ejemplo que funciona en CarTV
// (Blu Radio): Chrome de escritorio, escrito de las 3 formas (atributo http-user-agent, #EXTHTTP y «|User-Agent=»).
const CARTV_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
// Cada reproductor lee el Referer/User-Agent de forma distinta:
//  VLC -> #EXTVLCOPT · apps IPTV (CarTV, TiviMate, Smarters, OTT Navigator) -> atributos http-*, #EXTHTTP
//  Kodi/ExoPlayer "solo IPTV" -> url|User-Agent=...&Referer=... (este sufijo rompe VLC, por eso solo en modo "iptv")
function m3uEntry(name, url, referer, settings, extra = {}) {
  const q = (v) => oneLine(v).replace(/"/g, "'");
  const n = q(name);
  const fmt = settings?.listFormat || "both";
  const ua = oneLine(extra.ua) || CARTV_UA;
  // Formato «Apps IPTV» (CarTV): SIEMPRE con User-Agent, como el ejemplo que funciona en CarTV.
  // VLC / VLC + apps: solo cuando el canal exige Referer y está activado «Incluir Referer y User-Agent».
  const headers = extra.kind !== "youtube" && (fmt === "iptv" || (settings?.vlcOpts && !!oneLine(referer)));
  let attrs = ` tvg-name="${n}"`;
  if (extra.tvgId) attrs += ` tvg-id="${q(extra.tvgId)}"`;
  if (extra.logo) attrs += ` tvg-logo="${q(extra.logo)}"`;
  if (extra.group) attrs += ` group-title="${q(extra.group)}"`;
  if (headers && fmt !== "vlc") {
    if (referer) attrs += ` http-referrer="${q(referer)}"`;
    attrs += ` http-user-agent="${q(ua)}"`;
  }
  let s = `#EXTINF:-1${attrs},${n}\n`;
  if (headers && fmt !== "iptv") {
    if (referer) s += `#EXTVLCOPT:http-referrer=${oneLine(referer)}\n`;
    s += `#EXTVLCOPT:http-user-agent=${ua}\n`;
  }
  if (headers && fmt !== "vlc") s += `#EXTHTTP:${JSON.stringify(referer ? { "User-Agent": ua, Referer: oneLine(referer) } : { "User-Agent": ua })}\n`;
  let u = outUrl(url, settings);
  if (headers && fmt === "iptv") u += `|User-Agent=${encodeURIComponent(ua)}` + (referer ? `&Referer=${encodeURIComponent(oneLine(referer))}` : "");
  return s + u + "\n";
}

// Grupo que muestran las apps IPTV: la categoría que eligió el usuario o una automática
const AUTO_GROUPS = ["En vivo", "Grabados", "Videos", "YouTube"];
function autoGroupFor(item) {
  if (item.kind === "youtube") return "YouTube";
  if (item.kind === "file") return "Videos";
  return item.live === false ? "Grabados" : "En vivo";
}
function groupFor(item) {
  if (item.group) return item.group;
  if (item.kind === "youtube") return "YouTube";
  if (item.kind === "file") return "Videos";
  return item.live === false ? "Grabados" : "En vivo";
}
// Con guía de programación (EPG), las apps IPTV muestran qué están dando en cada canal
const m3uFile = (entries, settings) => {
  const epg = oneLine(settings?.epgUrl || "").replace(/"/g, "");
  return (epg ? `#EXTM3U url-tvg="${epg}" x-tvg-url="${epg}"\n` : "#EXTM3U\n") + entries.join("");
};

// Ordena por categoría (primero las creadas por el usuario, en su orden; luego las automáticas)
// para que la lista salga agrupada también en VLC. El orden dentro de cada categoría se conserva.
function sortByCategory(items, categories = []) {
  const order = [...categories, ...AUTO_GROUPS];
  const rank = (g) => { const i = order.indexOf(g); return i < 0 ? order.length : i; };
  return items.map((it, i) => [it, i]).sort((a, b) => rank(groupFor(a[0])) - rank(groupFor(b[0])) || a[1] - b[1]).map((x) => x[0]);
}

// Entrada M3U de un flujo/canal guardado (usa la URL efectiva y el logo si hay)
function m3uFor(item, settings, name) {
  return m3uEntry(name ?? item.name, effUrl(item), item.referer, settings, { logo: item.thumb, kind: item.kind, group: groupFor(item), tvgId: item.tvgId, ua: item.ua });
}

// Lee un .m3u (propio o de otra app) -> [{name, url, referer}]
function parseM3u(text) {
  const out = [];
  let cur = {};
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l === "#EXTM3U") continue;
    if (l.startsWith("#EXTINF:")) {
      // la coma que separa el nombre es la primera fuera de comillas
      const m = l.match(/^#EXTINF:[^,"]*(?:"[^"]*"[^,"]*)*,(.*)$/);
      cur.name = (m ? m[1] : l.slice(l.indexOf(",") + 1)).trim();
      const r = l.match(/http-referrer="([^"]*)"/); if (r) cur.referer = r[1];
      const g = l.match(/tvg-logo="([^"]*)"/); if (g) cur.thumb = g[1];
      const gt = l.match(/group-title="([^"]*)"/); if (gt) cur.group = gt[1].trim();
      const ti = l.match(/tvg-id="([^"]*)"/); if (ti) cur.tvgId = ti[1].trim();
      const ua = l.match(/http-user-agent="([^"]*)"/); if (ua) cur.ua = ua[1];
    }
    else if (l.startsWith("#EXTVLCOPT:http-user-agent=")) cur.ua = l.slice(27);
    else if (l.startsWith("#EXTVLCOPT:http-referrer=")) cur.referer = l.slice(25);
    else if (l.startsWith("#EXTHTTP:")) { try { const j = JSON.parse(l.slice(9)); if (j.Referer) cur.referer = j.Referer; if (j["User-Agent"]) cur.ua = j["User-Agent"]; } catch {} }
    else if (!l.startsWith("#")) {
      let url = l;
      const pipe = l.indexOf("|"); // formato Kodi/IPTV: url|User-Agent=...&Referer=...
      if (pipe > 0) {
        url = l.slice(0, pipe);
        const pp = new URLSearchParams(l.slice(pipe + 1));
        if (pp.get("Referer")) cur.referer = pp.get("Referer");
        if (pp.get("User-Agent")) cur.ua = pp.get("User-Agent");
      }
      out.push({ name: cur.name || hostOf(url) || "Canal", url, referer: cur.referer || "", thumb: cur.thumb || "", group: cur.group || "", tvgId: cur.tvgId || "", ua: cur.ua || "" });
      cur = {};
    }
  }
  return out;
}

// Comandos para grabar o probar tus propias transmisiones desde la terminal
const COMMAND_LABELS = {
  vlc: "Ver en VLC con streamlink", ffplay: "Reproducir con ffplay",
  ffmpeg: "Grabar con ffmpeg", streamlink: "Grabar con streamlink"
};

function buildCommands(url, referer, name, kind = "hls") {
  const ua = navigator.userAgent;
  const file = safeFile(name || "grabacion");
  const ref = referer ? ` -referer "${referer}"` : "";
  if (kind === "youtube") return {
    vlc: `streamlink --player vlc "${url}" best`,
    streamlink: `streamlink "${url}" best -o "${file}.ts"`
  };
  if (kind === "file") return {
    ffplay: `ffplay -user_agent "${ua}"${ref} -i "${url}"`,
    ffmpeg: `ffmpeg -user_agent "${ua}"${ref} -i "${url}" -c copy "${file}.mp4"`
  };
  return {
    ffplay: `ffplay -user_agent "${ua}"${ref} -i "${url}"`,
    ffmpeg: `ffmpeg -user_agent "${ua}"${ref} -i "${url}" -c copy "${file}.ts"`,
    streamlink: `streamlink --http-header "User-Agent=${ua}"` +
      (referer ? ` --http-header "Referer=${referer}"` : "") +
      ` "${kind === "dash" ? "dash" : "hls"}://${url}" best -o "${file}.ts"`
  };
}

function monitorUrl(url, referer, name, kind = "") {
  const p = new URLSearchParams({ u: url, r: referer || "", n: name || "", k: kind || "" });
  return chrome.runtime.getURL("monitor.html") + "?" + p.toString();
}

// Escapa texto para meterlo en HTML generado (página del celular)
const escHtml = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- extraer links de video del código de una página (compartido con la PWA) ----------
function unescapeUrl(u) {
  return u.replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/\\u002F/gi, "/").replace(/&amp;/g, "&").replace(/[\\'"),;]+$/, "");
}
function findM3u8(html, base) {
  const out = new Set();
  const abs = /https?:(?:\\?\/){2}[^\s"'<>`]+?\.m3u8(?:[^\s"'<>`]*)?/gi;
  for (const m of html.matchAll(abs)) out.add(unescapeUrl(m[0]));
  const rel = /["'`]([^"'`\s<>]+?\.m3u8[^"'`\s<>]*)["'`]/gi; // cualquier texto entre comillas que termine en .m3u8
  for (const m of html.matchAll(rel)) { try { out.add(new URL(unescapeUrl(m[1]), base).href); } catch {} }
  return [...out].filter((u) => /^https?:\/\//i.test(u));
}
function findIframes(html, base) {
  const out = [];
  for (const m of html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) {
    try { const u = new URL(m[1].replace(/&amp;/g, "&"), base).href; if (/^https?:/i.test(u) && !/youtube|facebook|twitter|doubleclick|googlesyndication/i.test(u)) out.push(u); } catch {}
  }
  return [...new Set(out)];
}

// Una sola vez: quien tenía el formato viejo por defecto («both») pasa a «iptv», que es el que CarTV entiende
function migrateSettings(st) {
  if (!st || st.fmtV2) return null;
  const next = { ...st, fmtV2: true };
  if (!st.listFormat || st.listFormat === "both") next.listFormat = "iptv";
  return next;
}

// ---------- ¿de dónde viene el link? (mismo código en la extensión y en la PWA) ----------
// official  -> sale de la página del canal o de su mismo dominio
// cdn       -> plataforma profesional de video (Mediastream, Akamai, CloudFront, Wowza…): casi siempre la del canal
// unofficial-> IP suelta, puerto raro, DNS casero o panel IPTV de terceros: suele caerse o bloquear
// unknown   -> no se puede saber
const PRO_CDN = /(^|\.)(mdstrm\.com|mediastre\.am|akamaized\.net|akamaihd\.net|akamai\.net|cloudfront\.net|fastly\.net|fastlylb\.net|llnwd\.net|llnwi\.net|edgecastcdn\.net|azureedge\.net|streamlock\.net|wowza\.com|bcovlive\.io|brightcove\.(com|net)|jwpcdn\.com|jwplayer\.com|dailymotion\.com|dmcdn\.net|ttvnw\.net|cdn77\.org|cdnvideo\.ru|vimeocdn\.com|amagi\.tv|cloudflarestream\.com|videodelivery\.net|mediapackage\.[\w-]+\.amazonaws\.com|mediatailor\.[\w-]+\.amazonaws\.com|zype\.com|castr\.(io|com)|hlsliveamdgl|googlevideo\.com|youtube\.com|livestream\.com|ustream\.tv|kaltura\.com|vhx\.tv|lldns\.net|footprint\.net|level3\.net|limelight\.com|b-cdn\.net|bunnycdn\.com|gcdn\.co|streamhoster\.com|tulix\.tv|streann\.com|mux\.com|dacast\.com|boxcast\.io|ottera\.tv)$/i;
const HOME_DNS = /(^|\.)(ddns\.net|duckdns\.org|no-ip\.(com|org|biz|info)|noip\.me|myftp\.(org|biz)|hopto\.org|zapto\.org|sytes\.net|servehttp\.com|serveftp\.com|dyndns\.(org|info|tv)|dynu\.net|freeddns\.org|ddnsking\.com|3utilities\.com|mooo\.com)$/i;
function isIpHost(h) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || /^\[/.test(h); }
function baseDomain(host) {
  host = (host || "").toLowerCase().replace(/^www\./, "");
  if (!host || isIpHost(host)) return host;
  const p = host.split(".");
  if (p.length > 2 && p[p.length - 1].length === 2 && /^(com|gov|gob|net|org|edu|co|ac|mil|tv)$/.test(p[p.length - 2])) return p.slice(-3).join(".");
  return p.slice(-2).join(".");
}
function sourceInfo(url, ctx = {}) {
  let u; try { u = new URL(url); } catch { return { tier: "unknown", why: ["link inválido"] }; }
  const host = u.hostname.replace(/^\[|\]$/g, ""), why = [];
  const dom = (x) => { try { return baseDomain(new URL(x).hostname); } catch { return ""; } };
  const sameOfficial = !!ctx.website && dom(ctx.website) === baseDomain(host);
  const samePage = !!ctx.pageUrl && dom(ctx.pageUrl) === baseDomain(host);
  const sameSite = sameOfficial || samePage;
  const port = u.port && !["80", "443"].includes(u.port) ? u.port : "";
  const xtream = /\/(live|movie|series)\/[^/]+\/[^/]+\/\d+(\.\w+)?$/i.test(u.pathname) || /\/get\.php$/i.test(u.pathname) || /[?&](username|password)=/i.test(u.search);
  if (isIpHost(host)) why.push("servidor sin dominio, solo una dirección IP");
  if (port) why.push(`puerto no estándar (${port})`);
  if (HOME_DNS.test(host)) why.push("dominio de IP dinámica (servidor casero)");
  if (xtream) why.push("formato de panel IPTV de terceros");
  if (u.protocol === "http:") why.push("sin cifrar (http)");
  const bad = isIpHost(host) || HOME_DNS.test(host) || xtream || (port && !sameSite);
  if (sameOfficial && !bad) return { tier: "official", why: ["mismo dominio que la página oficial del canal"] };
  if (ctx.fromOfficialPage && !bad) return { tier: "official", why: ["lo pide el reproductor de la página oficial del canal"] };
  if (samePage && !bad) return { tier: "page", why: ["del mismo sitio donde lo encontraste (" + baseDomain(host) + "); no se sabe si es el oficial del canal"] };
  if (bad) return { tier: "unofficial", why };
  if (PRO_CDN.test(host)) return { tier: "cdn", why: ["plataforma profesional de video (" + baseDomain(host) + ")"] };
  return { tier: "unknown", why: why.length ? why : ["dominio " + baseDomain(host) + " (no se puede confirmar si es del canal)"] };
}
const TIER_LABEL = { official: "Oficial", cdn: "Plataforma", page: "De la página", unknown: "Sin confirmar", unofficial: "No oficial" };
const TIER_RANK = { official: 0, cdn: 1, page: 2, unknown: 3, unofficial: 4 };
const tierOf = (item) => (item.tier ? { tier: item.tier, why: item.tierWhy || [] } : sourceInfo(item.url, { pageUrl: item.pageUrl }));

// ---------- sincronización de canales (extensión ↔ PWA) — mismo código en los dos lados ----------
// Un solo archivo en el Gist del puente guarda la lista compartida: { items, tomb, categories, catU, pub }.
// Cada canal lleva _u (cuándo cambió). Gana el cambio más reciente; lo borrado deja una «lápida» (tomb)
// para que el otro lado no lo vuelva a agregar. «base» es lo último que este equipo sincronizó: comparando
// contra ella se sabe qué cambió aquí sin tener que marcar cada edición a mano.
const SYNC_FILE = "canales-sync.json";
const SHARED_FIELDS = ["key", "url", "kind", "referer", "name", "group", "thumb", "live", "tvgId", "tier", "tierWhy", "pageUrl", "useChannel", "channelLive", "ytId", "author", "car"];
function shareOf(it) {
  const o = {};
  for (const f of SHARED_FIELDS) if (it[f] !== undefined && it[f] !== null && it[f] !== "") o[f] = it[f];
  return o;
}
function syncMerge(localItems, localCats, base, remote, now = Date.now()) {
  base = base || {}; remote = remote || {};
  const bh = base.hashes || {}, bu = base.u || {};
  const tomb = { ...(remote.tomb || {}) };
  const local = localItems.map((it) => {
    const s = shareOf(it), h = JSON.stringify(s);
    return { ...s, _u: bh[s.key] === h ? (bu[s.key] || 1) : now }; // cambió aquí desde la última vez -> ahora
  });
  const localKeys = new Set(local.map((x) => x.key));
  for (const k of Object.keys(bh)) if (!localKeys.has(k)) tomb[k] = Math.max(tomb[k] || 0, now); // borrado aquí
  const out = new Map();
  for (const it of remote.items || []) out.set(it.key, it);
  for (const it of local) { const r = out.get(it.key); if (!r || it._u >= (r._u || 0)) out.set(it.key, it); }
  for (const [k, t] of Object.entries(tomb)) {
    const it = out.get(k);
    if (it && (it._u || 0) <= t) out.delete(k);
    if (now - t > 60 * 864e5) delete tomb[k]; // las lápidas viejas se limpian a los 60 días
  }
  // categorías: la primera vez se juntan; después gana el cambio más reciente
  const lc = localCats || [], rc = remote.categories;
  let categories, catU;
  if (base.cats === undefined) { categories = [...new Set([...(rc || []), ...lc])]; catU = now; }
  else if (JSON.stringify(lc) !== base.cats && now >= (remote.catU || 0)) { categories = lc; catU = now; }
  else { categories = rc || lc; catU = remote.catU || now; }
  const items = [...out.values()];
  const hashes = {}, u = {};
  for (const it of items) { const { _u, ...s } = it; hashes[it.key] = JSON.stringify(shareOf(s)); u[it.key] = _u || 1; }
  return { items, tomb, categories, catU, base: { hashes, u, cats: JSON.stringify(categories) } };
}
// Rehace la lista local con lo sincronizado, conservando los datos que solo existen en este equipo
function syncApply(localItems, mergedItems, toLocal) {
  const byKey = new Map(localItems.map((x) => [x.key, x]));
  return mergedItems.map((s) => {
    const { _u, ...shared } = s;
    const old = byKey.get(s.key);
    if (!old) return toLocal ? toLocal(shared, null) : { ...shared, addedAt: Date.now() };
    const keep = { ...old };
    for (const f of SHARED_FIELDS) delete keep[f];
    return toLocal ? toLocal(shared, keep) : { ...keep, ...shared };
  });
}
