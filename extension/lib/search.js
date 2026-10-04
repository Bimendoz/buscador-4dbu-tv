// Buscador de canales (lo carga background.js con importScripts).
// 1) Busca el nombre en el directorio público de canales gratuitos de iptv-org.
// 2) Si ahí no hay uno que funcione, abre el sitio oficial del canal (o los primeros resultados de la web)
//    en una pestaña de fondo y deja que el detector capture el directo.
// Cada link se PRUEBA (lista, calidad, un segmento real y que el directo avance) y solo se entregan los verificados.

const DIR_API = "https://iptv-org.github.io/api/";
const DIR_TTL = 24 * 3600e3;
const SEARCH_MAX_FOUND = Infinity;  // sin límite: se muestran TODOS los que funcionan y tú eliges cuáles guardar
const SEARCH_MAX_TESTS = Infinity;  // sin límite: se prueban todos los links del directorio
// Servicios de video que solo entregan el directo con la sesión de SU reproductor (player, uid, sid…).
// El link «pelado» del directorio suele fallar en CarTV aunque aquí responda: se prefiere sacarlo de la página oficial.
const SESSION_HOSTS = /(^|\.)(mdstrm\.com|mediastream\.[a-z.]+)$/i;
// (los /live-stream-playlist/ de Mediastream funcionan sin sesión: ejemplo de Blu Radio en CarTV)
const needsPlayerSession = (url) => { try { const u = new URL(url); return SESSION_HOSTS.test(u.hostname) && !u.searchParams.has("player") && !/\/live-stream-playlist\//i.test(u.pathname); } catch { return false; } };
const STOP_WORDS = new Set(["canal", "tv", "television", "hd", "channel", "en", "vivo", "el", "la", "de", "del", "y", "senal", "live"]);

const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (s) => norm(s).split(" ").filter((w) => w && !STOP_WORDS.has(w));

// Qué tanto se parece un nombre a lo que se escribió (0 = nada)
function nameScore(query, name) {
  const q = norm(query), n = norm(name);
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.replace(/ /g, "") === q.replace(/ /g, "")) return 95;
  if (n.startsWith(q + " ")) return 85;
  const nw = n.split(" "), qw = q.split(" ");
  if (qw.every((w) => nw.includes(w))) return 75;
  const cq = words(query), cn = words(name);
  if (cq.length && cq.every((w) => cn.includes(w))) return cn.length === cq.length ? 72 : 62;
  if (cq.length && cq.join("").length >= 4 && cn.join("").includes(cq.join(""))) return 50;
  return 0;
}

function userCountry() {
  const m = (navigator.language || "").match(/-([A-Z]{2})$/i);
  return m ? m[1].toUpperCase() : "";
}

// ---------- directorio (con caché de 24 h) ----------
async function dirJson(name) {
  const url = DIR_API + name + ".json";
  const cache = await caches.open("hls-directorio");
  const cached = await cache.match(url);
  if (cached && Date.now() - (+cached.headers.get("x-fetched") || 0) < DIR_TTL) return cached.json();
  try {
    const r = await fetchT(url, 30000);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const body = await r.text();
    await cache.put(url, new Response(body, { headers: { "content-type": "application/json", "x-fetched": String(Date.now()) } }));
    return JSON.parse(body);
  } catch (e) {
    if (cached) return cached.json(); // sin conexión: usar la copia vieja
    throw e;
  }
}

async function directoryCandidates(query, mode = "any", wantCountries = []) {
  mode = langMode(mode);
  const want = cleanCountries(wantCountries);
  const [channels, streams] = await Promise.all([dirJson("channels"), dirJson("streams")]);
  let logos = [], feeds = [], countries = [];
  try { logos = await dirJson("logos"); } catch {}
  try { [feeds, countries] = await Promise.all([dirJson("feeds"), dirJson("countries")]); } catch {}
  const idx = buildLangIndex(feeds, countries);
  const byId = new Map(channels.map((c) => [c.id, c]));
  const feedsOf = new Map();
  for (const f of feeds) { if (!feedsOf.has(f.channel)) feedsOf.set(f.channel, []); feedsOf.get(f.channel).push(f); }
  // ¿el canal tiene alguna señal en el idioma pedido?
  // ¿el canal tiene alguna señal en el idioma y en los países pedidos?
  const chOk = (c) => (feedsOf.get(c.id) || [null]).some((f) => { const s0 = { channel: c.id, feed: f?.id };
    return langOk(streamLang(s0, c, idx), mode) && countryOk(c.country, streamAreas(s0, idx), want); });
  const cc = userCountry();
  const scored = [];
  for (const c of channels) {
    if (c.is_nsfw || c.closed) continue;
    const best = Math.max(nameScore(query, c.name), ...(c.alt_names || []).map((a) => nameScore(query, a)));
    if (best && chOk(c)) scored.push({ c, score: best + (cc && c.country === cc ? 8 : 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored; // TODOS los canales que coinciden con el nombre
  const topById = new Map(top.map((x) => [x.c.id, x]));
  const logoOf = (id) => byId.get(id)?.logo || logos.find((l) => l.channel === id)?.url || "";
  const out = [];
  for (const s of streams) {
    if (!s.url || !/\.m3u8(\?|$)/i.test(s.url)) continue;
    const hit = topById.get(s.channel);
    const tScore = !hit && s.title ? nameScore(query, s.title) : 0;
    if (!hit && tScore < 70) continue;
    const ch = hit?.c || byId.get(s.channel) || null;
    const lang = streamLang(s, ch, idx);
    if (!langOk(lang, mode) || !countryOk(ch?.country || "", streamAreas(s, idx), want)) continue;
    out.push({
      url: s.url, referer: s.referrer || "", ua: s.user_agent || "", quality: s.quality || "",
      name: hit ? hit.c.name : s.title, logo: ch ? logoOf(ch.id) : "", tvgId: ch ? ch.id : "",
      website: ch?.website || "", country: ch?.country || "", score: hit ? hit.score : tScore, lang
    });
  }
  // español latino primero; dentro de cada idioma, el nombre que más se parece
  out.sort((a, b) => (mode === "any" ? 0 : langRank(a.lang) - langRank(b.lang)) || b.score - a.score);
  return { streams: out, websites: [...new Set(top.filter((x) => x.score >= 60 && x.c.website).map((x) => x.c.website))], best: top[0]?.c };
}
// Palabras que se agregan a la búsqueda web según el idioma elegido
const langQuery = (query, mode, countries = []) => {
  const one = cleanCountries(countries).filter((c) => c !== "LATAM");
  const place = one.length === 1 ? " " + (SPANISH_COUNTRIES.find(([k]) => k === one[0]) || ["", ""])[1] : "";
  return ({ latam: query + " en español latino", spa: query + " en español", es: query + " España" }[langMode(mode)] || query) + place;
};

// ---------- búsqueda web (respaldo cuando el directorio no alcanza) ----------
const SKIP_HOSTS = /(^|\.)(youtube\.com|youtu\.be|facebook\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com|wikipedia\.org|google\.[a-z.]+|bing\.com|duckduckgo\.com|reddit\.com|linkedin\.com|spotify\.com)$/i;
// Bing entrega sus resultados por un redireccionador (bing.com/ck/a?…&u=a1<base64>): se saca el link real
function unBing(u) {
  try {
    const x = new URL(u);
    if (!/(^|\.)bing\.com$/i.test(x.hostname)) return u;
    const p = x.searchParams.get("u") || "";
    if (!p.startsWith("a1")) return u;
    const b = p.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    return atob(b + "===".slice((b.length + 3) % 4));
  } catch { return u; }
}
async function webResults(query, siteDomain = "", max = 3) {
  max = Math.max(1, max);
  const q = encodeURIComponent(siteDomain ? `site:${siteDomain} ${query} en vivo` : query + " en vivo señal en directo");
  const found = [];
  const add = (u) => {
    try {
      const x = new URL(u);
      if (!/^https?:$/.test(x.protocol) || SKIP_HOSTS.test(x.hostname)) return;
      if (siteDomain) { if (baseDomain(x.hostname) === siteDomain && !found.includes(x.href)) found.push(x.href); return; }
      x.hash = "";
      if (!found.includes(x.href)) found.push(x.href);
    } catch {}
  };
  // 1) Brave Search API (oficial, con clave del usuario)
  const { settings: stB } = await chrome.storage.local.get("settings");
  const braveKey = (stB?.braveKey || "").trim();
  if (braveKey) {
    try {
      const r = await fetchT(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=20&country=co&search_lang=es`, 12000,
        { headers: { Accept: "application/json", "X-Subscription-Token": braveKey } });
      if (r.ok) for (const it of (await r.json())?.web?.results || []) add(it.url);
      else await chrome.storage.local.set({ braveStatus: { error: r.status === 401 || r.status === 403 ? "la clave de Brave no es válida" : r.status === 429 ? "se acabó la cuota de Brave del mes" : `Brave respondió ${r.status}`, at: Date.now() } });
      if (r.ok) await chrome.storage.local.set({ braveStatus: { ok: true, at: Date.now() } });
    } catch {}
  }
  // 2) respaldo: DuckDuckGo y Bing, página tras página de resultados (no solo la primera),
  //    hasta juntar los que se piden o hasta que el buscador ya no dé nada nuevo. Sin tope fijo de páginas.
  const pages = async (mk, re, pick) => {
    for (let n = 0; found.length < max; n++) {
      const before = found.length;
      try {
        const html = await (await fetchT(mk(n), 12000)).text();
        for (const m of html.matchAll(re)) { try { add(pick(m)); } catch {} }
      } catch {}
      if (found.length === before) break; // esa página no trajo nada nuevo: el buscador se acabó
    }
  };
  if (found.length < max) await pages((n) => n ? `https://html.duckduckgo.com/html/?s=${n * 30}&dc=${n * 30 + 1}&q=` + q : "https://html.duckduckgo.com/html/?q=" + q,
    /uddg=([^&"']+)/g, (m) => decodeURIComponent(m[1]));
  if (found.length < max) await pages((n) => `https://www.bing.com/search?setlang=es&count=50&first=${n * 50 + 1}&q=` + q,
    /<h2[^>]*><a[^>]+href="(https?:\/\/[^"]+)"/g, (m) => unBing(m[1].replace(/&amp;/g, "&")));
  return found.slice(0, max);
}

// ---------- recorrer el sitio oficial, página por página, hasta dar con el directo ----------
const LIVE_WORDS = /(en[-_ ]?vivo|envivo|se[ñn]al|\blive\b|directo|streaming|tv[-_ ]?en[-_ ]?l[ií]nea|ver[-_ ]?(tv|canal)|transmisi[oó]n)/i;
const LIVE_PATHS = ["/en-vivo", "/envivo", "/senal-en-vivo", "/senal-vivo", "/live", "/en-directo", "/tv-en-vivo", "/ver-en-vivo"];
// Páginas del sitio oficial ordenadas de más a menos probable: links del menú que dicen «en vivo», direcciones
// típicas que existan de verdad y resultados de la web dentro del mismo sitio.
async function officialLivePages(website, query) {
  const site = baseDomain(new URL(website).hostname);
  const pages = [];
  const add = (u, score) => {
    try {
      const x = new URL(u, website); x.hash = "";
      if (!/^https?:$/.test(x.protocol) || baseDomain(x.hostname) !== site || /\.(jpe?g|png|gif|svg|pdf|mp3|css|js|xml)(\?|$)/i.test(x.pathname)) return;
      const e = pages.find((p) => p.url === x.href);
      if (e) e.score = Math.max(e.score, score); else pages.push({ url: x.href, score });
    } catch {}
  };
  add(website, 5);
  try {
    const r = await fetchT(website, 10000, { credentials: "include" });
    if (r.ok) {
      const html = await r.text(), base = r.url || website;
      for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
        const href = m[1].replace(/&amp;/g, "&"), text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        let sc = 0;
        if (LIVE_WORDS.test(href)) sc += 6;
        if (LIVE_WORDS.test(text)) sc += 5;
        if (/vivo|live|directo/i.test(text) && text.length < 40) sc += 3;
        if (sc) { try { add(new URL(href, base).href, sc); } catch {} }
      }
    }
  } catch {}
  for (const p of LIVE_PATHS) {
    const u = new URL(p, website).href;
    if (pages.some((x) => x.url === u)) continue;
    try { const r = await fetchT(u, 6000, { credentials: "include" }); if (r.ok && !/\/(404|error)/i.test(r.url)) add(r.url || u, 2); } catch {}
  }
  try { for (const u of await webResults(query, site, 1000)) add(u, 4); } catch {}
  return pages.sort((a, b) => b.score - a.score).map((p) => p.url);
}
// Sin página oficial en el directorio: la busca en la web y la reconoce por el nombre del canal en el dominio
async function guessOfficialSite(query) {
  const full = norm(query).replace(/ /g, "");
  const ws = words(query).filter((w) => w.length >= 4);
  const results = await webResults(query, "", 8).catch(() => []);
  const name = (u) => { try { return norm(baseDomain(new URL(u).hostname).split(".")[0]).replace(/ /g, ""); } catch { return ""; } };
  return results.find((u) => name(u).includes(full)) || results.find((u) => ws.length && ws.every((w) => name(u).includes(w))) || "";
}

// ---------- verificación ----------
// Modo "player" (por defecto): pide el video como lo hace una app IPTV (CarTV, TiviMate…):
//   sin cookies, sin Origin, con User-Agent de reproductor Android y solo el Referer que irá en la lista.
// Modo "browser": como Chrome dentro de la página (con cookies y Origin). Sirve para diagnosticar.
const PLAYER_UA = CARTV_UA; // se prueba con el MISMO User-Agent que va en la lista (el que funciona en CarTV)

function fetchT(url, ms = 9000, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { cache: "no-store", credentials: "omit", ...init, signal: ctrl.signal }).finally(() => clearTimeout(t));
}
// Espera sin que Chrome duerma el service worker (cada llamada a la API lo mantiene activo)
async function keepAliveSleep(ms, ctl) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ctl?.cancelled) return;
    await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())));
    await chrome.runtime.getPlatformInfo();
  }
}
const mediaSeq = (t) => +((t.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1] || 0);
function segmentUrls(text, base) {
  const out = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith("#EXTINF")) {
    let j = i + 1;
    while (j < lines.length && (!lines[j] || lines[j].startsWith("#"))) j++;
    if (j < lines.length) out.push(resolveUrl(lines[j], base));
  }
  return out;
}

// Cabeceras de la prueba: regla temporal de declarativeNetRequest, solo para peticiones de la extensión
// y solo hacia los servidores que va tocando la prueba (lista, calidades y segmentos pueden estar en hosts distintos).
let ruleSeq = 0;
async function withHeaders(spec, fn) {
  const { referer = "", ua = "", mode = "player" } = spec;
  const requestHeaders = [];
  let origin = "";
  try { origin = referer ? new URL(referer).origin : ""; } catch {}
  if (mode === "player") {
    requestHeaders.push(referer ? { header: "referer", operation: "set", value: referer } : { header: "referer", operation: "remove" });
    requestHeaders.push({ header: "origin", operation: "remove" });
    requestHeaders.push({ header: "user-agent", operation: "set", value: ua || PLAYER_UA });
    for (const h of ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"]) requestHeaders.push({ header: h, operation: "remove" });
  } else {
    if (referer) requestHeaders.push({ header: "referer", operation: "set", value: referer });
    if (origin) requestHeaders.push({ header: "origin", operation: "set", value: origin });
    if (ua) requestHeaders.push({ header: "user-agent", operation: "set", value: ua });
  }
  const id = 1900000000 + (ruleSeq++ % 1000);
  const hosts = new Set();
  const apply = () => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id], addRules: requestHeaders.length ? [{ id, priority: 3,
    action: { type: "modifyHeaders", requestHeaders },
    condition: { requestDomains: [...hosts], initiatorDomains: [chrome.runtime.id], resourceTypes: ["xmlhttprequest", "other"] } }] : [] });
  const init = { credentials: mode === "browser" ? "include" : "omit" };
  const get = async (u, ms = 9000, extra = {}) => {
    const h = new URL(u).hostname;
    if (!hosts.has(h)) { hosts.add(h); await apply(); }
    return fetchT(u, ms, { ...init, ...extra });
  };
  try { return await fn(get); } finally { chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {}); }
}

// Prueba de verdad: lista válida, sin DRM, un segmento descargable y, si es en vivo, que avance.
async function verifyHls(url, spec = {}, ctl) {
  return withHeaders(spec, async (get) => {
    const getText = async (u) => {
      const r = await get(u);
      if (!r.ok) throw new Error(`el servidor respondió ${r.status}`);
      return { text: await r.text(), url: r.url || u };
    };
    const first = await getText(url);
    let a = analyzeHls(first.text, first.url);
    if (a.kind === "invalid") throw new Error("no es una lista HLS");
    const info = { res: "", bw: 0, variants: 0 };
    info.audio = audioLangs(first.text);
    let mediaUrl = first.url, media = first;
    if (a.kind === "master") {
      const top = a.variants[0];
      Object.assign(info, { res: top.res, bw: top.bw, variants: a.variants.length });
      const low = a.variants[a.variants.length - 1];
      media = await getText(low.url);
      mediaUrl = media.url;
      a = analyzeHls(media.text, mediaUrl);
    }
    if (a.kind !== "media" || !a.segs) throw new Error("la lista no trae video");
    if (/METHOD=SAMPLE-AES|KEYFORMAT="?(com\.widevine|com\.microsoft|com\.apple\.streamingkeydelivery|urn:uuid)/i.test(media.text)) throw new Error("protegido con DRM");
    const key = (media.text.match(/#EXT-X-KEY:[^\n]*URI="([^"]+)"/) || [])[1];
    if (key) { const kr = await get(resolveUrl(key, mediaUrl), 9000); if (!kr.ok) throw new Error(`la llave de cifrado no descarga (${kr.status})`); }
    const segs = segmentUrls(media.text, mediaUrl);
    const seg = segs[segs.length - 1];
    const r = await get(seg, 10000, { headers: { Range: "bytes=0-4095" } });
    if (!r.ok) throw new Error(`el video no descarga (${r.status})`);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!buf.length) throw new Error("el video llega vacío");
    if (a.live && !spec.quick) {
      const seq0 = mediaSeq(media.text), last0 = seg;
      const wait = Math.min(Math.max((a.target || 6) * 1000, 4000), 10000);
      for (let i = 0; i < 2; i++) {
        await keepAliveSleep(wait, ctl);
        const again = await getText(mediaUrl);
        const s2 = segmentUrls(again.text, again.url);
        if (mediaSeq(again.text) !== seq0 || s2[s2.length - 1] !== last0) break;
        if (i === 1) throw new Error("el directo está congelado");
      }
    }
    return { live: !!a.live, res: info.res, bw: info.bw, variants: info.variants, target: a.target || 0, lock: networkLock(url), audio: info.audio || [] };
  });
}

// ¿Funciona en CarTV? Prueba como reproductor externo y, si falla, averigua qué le falta.
//   ok       -> funciona tal cual en apps IPTV
//   referer  -> funciona solo si la app manda el Referer (formato «Solo apps IPTV»)
//   browser  -> solo funciona dentro de Chrome (cookies/origen de la página): no sirve en CarTV
//   down     -> no funciona ni en Chrome
async function playerCheck(url, referer = "", ctl) {
  const lock = networkLock(url), exp = tokenExpiry(url);
  const base = { lock: lock ? lockText(lock) : "", exp };
  const errText = (e) => (e?.name === "AbortError" ? "no respondió a tiempo" : String(e?.message || e));
  let firstErr = "";
  try { return { ...base, verdict: "ok", info: await verifyHls(url, { mode: "player", quick: true }, ctl) }; }
  catch (e) { firstErr = errText(e); }
  if (referer) {
    try { return { ...base, verdict: "referer", info: await verifyHls(url, { mode: "player", referer, quick: true }, ctl), why: firstErr }; } catch {}
  }
  try { await verifyHls(url, { mode: "browser", referer, quick: true }, ctl); return { ...base, verdict: "browser", why: firstErr }; }
  catch (e) { return { ...base, verdict: "down", why: errText(e) }; }
}

// ---------- orquestación ----------
// runSearch(query)                 -> busca por nombre (directorio + sitio oficial + web)
// runSearch("", { pageUrl })       -> extrae el video de una página que da el usuario
// opts.onSave / opts.ctl: los encargos del iPhone (relay) usan su propio control y no tocan el popup.
let searchCtl = null;

async function runSearch(query, opts = {}) {
  const pageUrl = opts.pageUrl || "";
  query = cleanTitle(query) || (pageUrl ? hostOf(pageUrl) : "");
  const own = !opts.ctl;
  if (own && searchCtl) searchCtl.cancelled = true;
  const ctl = opts.ctl || (searchCtl = { cancelled: false, tabs: new Set() });
  const job = { query, pageUrl, status: "running", step: pageUrl ? "Leyendo la página…" : "Buscando en el directorio de canales…",
    tried: 0, failed: [], found: [], startedAt: Date.now() };
  const save = opts.onSave ? () => opts.onSave(job) : () => { job.updatedAt = Date.now(); return searchCtl === ctl ? chrome.storage.session.set({ search: job }) : null; };
  const step = (t) => { job.step = t; return save(); };
  await save();

  // Orden estricto: un link a la vez, en el orden de la búsqueda (directorio → sitio oficial → web).
  // Se prueban EXACTAMENTE los links que pediste en Ajustes («Links a probar»), aunque alguno ya haya funcionado;
  // solo para antes si ya no hay más links que probar. Al sacar de una página (pageUrl) se prueba todo lo que tenga.
  const { settings: stS } = await chrome.storage.local.get("settings");
  const sc = searchCountOf(opts.searchCount ?? { ...DEFAULT_SETTINGS, ...(stS || {}) }.searchCount);
  const N = pageUrl || sc === 0 ? Infinity : sc; // 0 = TODOS los links que aparezcan
  job.goal = Number.isFinite(N) ? N : 0;
  const mode = pageUrl ? "any" : langMode(opts.langMode ?? { ...DEFAULT_SETTINGS, ...(stS || {}) }.langMode);
  job.langMode = mode;
  const portable = opts.portableOnly ?? ({ ...DEFAULT_SETTINGS, ...(stS || {}) }.portableOnly !== false);
  const countries = pageUrl ? [] : cleanCountries(opts.countries ?? { ...DEFAULT_SETTINGS, ...(stS || {}) }.countries);
  job.countries = countries;
  const enough = () => ctl.cancelled || job.tried >= N;
  const tested = new Set();
  const test = async (cand, source) => {
    const k = keyOf(cand.url);
    if (tested.has(k) || enough()) return;
    tested.add(k);
    job.tried++;
    await save();
    try {
      // se prueba como lo pedirá CarTV: primero sin nada; si no, con el Referer que irá en la lista
      let v, needs = "";
      try { v = await verifyHls(cand.url, { mode: "player", ua: cand.ua }, ctl); }
      catch (e) {
        if (!cand.referer) throw e;
        v = await verifyHls(cand.url, { mode: "player", referer: cand.referer, ua: cand.ua }, ctl);
        needs = "referer";
      }
      if (ctl.cancelled) return;
      // idioma: si la lista declara su audio y no hay español, se descarta (con el filtro de idioma activo)
      if (!audioOk(v.audio, mode)) throw new Error(`el audio está en ${v.audio.map((l) => LANG_NAMES[l] || l).join(", ")}, no en español`);
      // no perder tiempo: fuera los que no van a funcionar en el celular
      const pi = portable ? portableIssue(cand.url, !!(cand.pageUrl || cand.website)) : "";
      if (pi) throw new Error(pi);
      const si = sourceInfo(cand.url, { website: cand.website, pageUrl: cand.pageUrl, fromOfficialPage: !!cand.officialPage });
      job.found.push({
        tier: si.tier, tierWhy: si.why, car: carFrom(needs ? "referer" : "ok"),
        // el Referer capturado se guarda SIEMPRE: aunque el computador responda sin él, servicios como
        // Mediastream pueden exigirlo desde el celular (CarTV lo acepta sin problema)
        key: k, url: cand.url, kind: "hls", referer: cand.referer || "", name: cand.name || query,
        thumb: cand.logo || "", live: v.live, pageUrl: cand.pageUrl || cand.website || "", source,
        res: v.res, bw: v.bw, variants: v.variants, lock: !!v.lock, verifiedAt: Date.now(), needs, tvgId: cand.tvgId || "",
        ua: cand.ua || "", lang: cand.lang?.label || (v.audio?.includes("spa") ? "Español" : ""), audio: v.audio || [], country: cand.country || ""
      });
    } catch (e) {
      job.failed.push({ host: hostOf(cand.url), why: e.name === "AbortError" ? "no respondió a tiempo" : String(e.message || e) });
    }
    await save();
  };
  const pool = async (items, n, fn) => {
    const q = [...items];
    await Promise.all(Array.from({ length: n }, async () => { while (q.length && !enough()) await fn(q.shift()); }));
  };
  // Una página: 1) links escritos en su código (rápido) · 2) abrirla por detrás y capturar lo que pide el reproductor
  const fromPage = async (site, meta) => {
    const ref = new URL(site).origin + "/";
    const pre = meta.label ? meta.label + " · " : "";
    await step(`${pre}leyendo el código de ${hostOf(site)}…`);
    const inHtml = await staticExtract(site).catch(() => ({ streams: [], title: "" }));
    const name = meta.name || cleanTitle(inHtml.title) || query;
    const before = job.found.length;
    for (const u of inHtml.streams) await test({ url: u, referer: ref, ...meta, name, pageUrl: site }, "sitio");
    if (enough()) return;
    await step(`${pre}abriendo la página por detrás para capturar el video…`);
    const cap = await captureFromPage(site, ctl, pageUrl ? 30000 : 25000);
    if (cap.streams.length) await step(`${pre}probando ${cap.streams.length} link(s) como CarTV…`);
    for (const c of cap.streams) await test({ ...c, ...meta, name: meta.name || cleanTitle(cap.title) || name, pageUrl: site }, "sitio");
  };

  try {
    if (pageUrl) {
      await fromPage(pageUrl, {});
    } else {
      // 1) directorio público
      let dir = { streams: [], websites: [] };
      try { dir = await directoryCandidates(query, mode, countries); }
      catch { job.failed.push({ host: "iptv-org.github.io", why: "no se pudo leer el directorio" }); }
      if (dir.streams.length && !opts.skipDirTests) {
        await step(`Directorio: ${dir.streams.length} link(s) del canal · los pruebo todos, en orden${Number.isFinite(N) ? ` (meta: ${N})` : ""}…`);
        await pool(dir.streams, 1, (c) => test(c, "directorio"));
      }
      job.found.forEach((f) => { if (needsPlayerSession(f.url)) f.weak = true; });
      // 2) sitios oficiales (todos los de los canales que coinciden + el que se adivine en la web), página por página
      job.pages = job.pages || [];
      const meta0 = { name: dir.best?.name || "", logo: dir.best?.logo || "", tvgId: dir.best?.id || "" };
      const lleva = () => (Number.isFinite(N) ? `Llevo ${job.tried} de ${N}` : `Llevo ${job.tried} probado(s)`);
      const walked = new Set();
      if (!enough()) {
        await step(`${lleva()}: busco en los sitios oficiales…`);
        const guess = await guessOfficialSite(query).catch(() => "");
        const officials = [...dir.websites, guess].filter((u, i, a) => u && a.findIndex((x) => baseDomain(hostOf(x)) === baseDomain(hostOf(u))) === i);
        for (const [oi, official] of officials.entries()) {
          if (enough()) break;
          const pages = await officialLivePages(official, query).catch(() => [official]);
          for (const [i, page] of pages.entries()) {
            if (enough()) break;
            if (walked.has(page)) continue;
            walked.add(page);
            const before = job.found.length;
            await fromPage(page, { ...meta0, website: official, officialPage: true,
              label: `${lleva()} · sitio oficial ${oi + 1} de ${officials.length}, página ${i + 1} de ${pages.length}: ${page.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)}` });
            job.pages.push({ url: page, found: job.found.length - before });
            await save();
          }
        }
      }
      // 3) resultados de la web, en su orden, TODOS los que den los buscadores (o hasta completar los links pedidos)
      if (!enough()) {
        await step(`${lleva()}: busco más páginas en la web…`);
        const web = await webResults(langQuery(query, mode, countries), "", Number.isFinite(N) ? Math.max(15, (N - job.tried) * 3) : 1000);
        const sites = web.filter((u) => !walked.has(u));
        job.web = { got: sites.length };
        for (const [i, site] of sites.entries()) {
          if (enough()) break;
          walked.add(site);
          const before = job.found.length;
          await fromPage(site, { ...meta0, website: "", officialPage: false, label: `${lleva()} · página web ${i + 1} de ${sites.length}: ${hostOf(site)}` });
          job.pages.push({ url: site, found: job.found.length - before });
          await save();
        }
      }
    }
    // se dejan en el orden en que se encontraron (orden de la búsqueda); cada uno lleva su marca oficial / no oficial
    const nOff = job.found.filter((f) => f.tier === "official" || f.tier === "cdn").length;
    job.status = ctl.cancelled ? "cancelled" : "done";
    const short = job.goal && job.tried < job.goal
      ? ` Pediste ${job.goal}, pero solo encontré ${job.tried} link(s) para probar (revisé el directorio, ${job.pages?.length || 0} página(s) y todo lo que dio la web).` : "";
    job.step = ctl.cancelled ? "Búsqueda cancelada." : job.found.length
      ? `${job.found.length} funcionan de ${job.tried} probado(s) · ${nOff} oficial(es) o de plataforma.${short}`
      : job.tried ? `Probé ${job.tried} link(s) y ninguno funcionó.${short}`
      : pageUrl ? "No encontré ningún video en esa página (puede necesitar que inicies sesión, o usar DRM)." : "No encontré ese canal.";
  } catch (e) {
    job.status = "error";
    job.step = "Error: " + (e.message || e);
  } finally {
    for (const id of ctl.tabs) chrome.tabs.remove(id).catch(() => {});
    job.finishedAt = Date.now();
    await save();
    if (own && searchCtl === ctl) searchCtl = null;
  }
  return job;
}

// Links .m3u8 escritos en el código de la página (y de sus iframes, un nivel). No sirve si el reproductor
// arma el link en vivo: para eso está captureFromPage().
async function staticExtract(pageUrl) {
  const get = async (u) => { const r = await fetchT(u, 10000, { credentials: "include" }); return r.ok ? { html: await r.text(), url: r.url || u } : null; };
  const top = await get(pageUrl);
  if (!top) return { streams: [], title: "" };
  const found = findM3u8(top.html, top.url);
  for (const f of findIframes(top.html, top.url)) {
    const sub = await get(f).catch(() => null);
    if (sub) found.push(...findM3u8(sub.html, sub.url));
  }
  const title = ((top.html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "").replace(/&amp;/g, "&").trim();
  return { streams: [...new Set(found)], title };
}

// Abre la página en una pestaña de fondo (silenciada), le da play, espera a que el reproductor pida el directo y la cierra
async function captureFromPage(url, ctl, ms = 25000) {
  let tab;
  try { tab = await chrome.tabs.create({ url, active: false }); } catch { return { streams: [], title: "" }; }
  ctl.tabs.add(tab.id);
  chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
  const end = Date.now() + ms;
  let hls = [], title = "";
  while (Date.now() < end && !ctl.cancelled) {
    await keepAliveSleep(1500, ctl);
    chrome.tabs.sendMessage(tab.id, { action: "autoplay" }).catch(() => {}); // llega a la página y a sus iframes
    const { streams } = await getTab(tab.id);
    hls = streams.filter((s) => s.kind === "hls");
    if (hls.length && Date.now() > end - ms + 8000) break; // unos segundos más para que aparezca la lista maestra
  }
  try { title = (await chrome.tabs.get(tab.id)).title || ""; } catch {}
  chrome.tabs.remove(tab.id).catch(() => {});
  ctl.tabs.delete(tab.id);
  chrome.storage.session.remove(tabKey(tab.id)).catch(() => {});
  const rank = (s) => (/master|playlist|index|manifest/i.test(s.url) ? 0 : 1);
  return { title, streams: hls.sort((a, b) => rank(a) - rank(b)).map((s) => ({ url: s.url, referer: s.referer || (new URL(url).origin + "/") })) };
}

function cancelSearch() {
  if (searchCtl) searchCtl.cancelled = true;
}

// Guía EPG: busca en el directorio el id de cada guardado que no lo tenga (solo coincidencias muy claras)
async function assignGuideIds(favorites) {
  const channels = await dirJson("channels");
  const cc = userCountry();
  let n = 0;
  for (const f of favorites) {
    if (f.tvgId || f.kind === "youtube") continue;
    let best = null, bestScore = 0;
    for (const c of channels) {
      if (c.closed) continue;
      const sc = Math.max(nameScore(f.name, c.name), ...(c.alt_names || []).map((a) => nameScore(f.name, a))) + (cc && c.country === cc ? 8 : 0);
      if (sc > bestScore) { best = c; bestScore = sc; }
    }
    if (best && bestScore >= 85) { f.tvgId = best.id; n++; }
  }
  return n;
}
