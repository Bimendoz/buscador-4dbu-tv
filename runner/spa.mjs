// +4dBu TV · ADAPTADOR PARA PLATAFORMAS ARMADAS CON JAVASCRIPT (módulo NUEVO, aparte)
// No cambia nada de lo que ya funciona: el modo «titulo», explorar.js y la extensión siguen igual.
// Modo «spa» del Chrome de GitHub, un navegador · un contexto · una página por trabajo:
//   · que: "pagina"  → la página ya armada (también lo que vive dentro de componentes con shadow DOM) y, si las
//                      tarjetas no traen enlace, se tocan una por una para saber a qué título llevan
//   · que: "titulo"  → la arquitectura del título: MULTI_SOURCE / DIRECT_PLAYER / PLAYER_PENDING y sus fuentes
//   · que: "directo" → prueba la fuente virtual «Direct Player»: abrir → «Ver ahora» → reproductor → verificar
//                      (mismos eventos que el modo «titulo», para que tu página los lea igual)
// Navegador real: domcontentloaded + tiempo de render (sin networkidle). No salta captchas, DRM ni verificaciones.
import { networkMonitor, findVideo, attemptPlayback, verifyPlayback, isBrowserInfrastructureError, LIMITS } from "./explorar.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
const AD = /(^|\.)(imasdk\.googleapis\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|adnxs(-simple)?\.com|teads\.tv|outbrain(img)?\.com|taboola\.com|pubmatic\.com|adsrvr\.org|amazon-adsystem\.com|criteo\.(com|net)|rubiconproject\.com|scorecardresearch\.com|2mdn\.net|adtrafficquality\.google|facebook\.com|googletagmanager\.com)$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const RENDER = { load: 15000, settle: 8000, poll: 300, scrolls: 4, scrollWait: 400, maxCards: 30, cardsMs: 120000 };
// lo aprendido de un sitio (qué campo de sus datos forma el enlace de cada título) sirve para sus demás páginas
const LEARNED = new Map();

// ---------------------------------------------------------------- utilidades dentro de la página
// recorre TODO el documento, también el interior de los componentes (shadow DOM abierto)
const DEEP = `window.__x4deep = window.__x4deep || function (root) {
  const out = [], walk = (r) => { for (const e of r.querySelectorAll("*")) { out.push(e); if (e.shadowRoot) walk(e.shadowRoot); } };
  walk(root || document); return out;
};`;

function playerProbe() {
  const all = window.__x4deep ? window.__x4deep() : [...document.querySelectorAll("*")];
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 80 && r.height > 60; };
  const vids = all.filter((e) => e.tagName === "VIDEO").length;
  const ifr = all.filter((f) => f.tagName === "IFRAME" && vis(f) && /embed|player|play|video|stream|watch|live|vod/i.test((f.src || "") + " " + f.className + " " + f.id)).map((f) => f.src).filter(Boolean);
  const box = all.some((e) => /jwplayer|video-js|plyr|shaka|clappr|player/i.test((typeof e.className === "string" ? e.className : "") + " " + e.id) && vis(e));
  const vis2 = (e) => { const r = e.getBoundingClientRect(); return r.width > 20 && r.height > 14; };
  const play = all.some((e) => /^(BUTTON|A)$/.test(e.tagName) && vis2(e) && /^(play|reproducir|ver ahora|ver|watch( now)?|ver pel[ií]cula|ver gratis|ver en vivo|continuar viendo)$/i.test((e.getAttribute("aria-label") || e.textContent || "").trim()));
  const anchors = all.filter((e) => e.tagName === "A" && e.getAttribute("href")).length;
  const t = (document.body ? document.body.innerText : "").slice(0, 1200);
  return { vids, ifr, box, play, anchors, nodes: all.length, wall: /verify you are human|checking your browser|just a moment/i.test(t) && t.length < 1200 };
}
async function scan(page) {
  const out = { vids: 0, ifr: [], box: false, play: false, anchors: 0, nodes: 0, wall: false };
  for (const f of page.frames()) {
    await f.evaluate(DEEP).catch(() => {});
    const s = await f.evaluate(playerProbe).catch(() => null); if (!s) continue;
    out.vids += s.vids; out.ifr.push(...s.ifr); out.box ||= s.box; out.play ||= s.play; out.wall ||= s.wall;
    if (f === page.mainFrame()) { out.anchors = s.anchors; out.nodes = s.nodes; }
  }
  out.ifr = [...new Set(out.ifr)].slice(0, 10);
  return out;
}
async function sourcesOf(page, url, code) {
  if (!code) return [];
  await page.evaluate(code).catch(() => {});
  return page.evaluate((u) => (window.X4 ? window.X4.markSources(document, u) : []), url).catch(() => []);
}

// detectSiteArchitecture(page): MULTI_SOURCE · DIRECT_PLAYER · PLAYER_PENDING
export async function detectSiteArchitecture(page, { url, code } = {}) {
  const pl = await scan(page);
  const ops = await sourcesOf(page, url || page.url(), code);
  // un <video> o iframe incrustado es el reproductor mismo, no una lista de servidores
  const real = ops.filter((o) => !o.trailer && o.kind !== "video" && o.kind !== "iframe");
  const embeds = ops.filter((o) => o.kind === "video" || o.kind === "iframe");
  // con botón «Ver ahora» el reproductor todavía no está (un video de fondo suele ser solo el avance)
  const arch = real.length ? "MULTI_SOURCE" : pl.play ? "PLAYER_PENDING" : pl.vids || pl.ifr.length || embeds.length ? "DIRECT_PLAYER" : "PLAYER_PENDING";
  return { arch, ops: real.length ? ops.filter((o) => !o.trailer) : [], player: { videos: pl.vids, iframes: pl.ifr, container: pl.box, playButton: pl.play }, wall: pl.wall };
}

// abrir como un navegador real: domcontentloaded + tiempo de render, y bajar por la página si se pide
async function render(page, url, { scroll = false, emit = () => {} } = {}) {
  const t0 = Date.now(), stages = [];
  const st = (s) => { stages.push({ ms: Date.now() - t0, stage: s }); emit({ type: "spa-stage", stage: s, ms: Date.now() - t0 }); };
  st("OPENING");
  try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: RENDER.load }); }
  catch { if (!page.url() || page.url() === "about:blank") { st("OPEN_FAILED"); return { ok: false, stages }; } }
  st("DOMCONTENTLOADED");
  await settle(page, st);
  if (scroll) {
    for (let i = 0; i < RENDER.scrolls; i++) { await page.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {}); await sleep(RENDER.scrollWait); }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(400);
    st("SCROLLED");
  }
  return { ok: true, stages };
}
// tiempo de render: hasta que aparezca el reproductor o la página deje de crecer
async function settle(page, st = () => {}, ms = RENDER.settle) {
  let last = -1, still = 0, grew = false;
  const base = (await scan(page)).nodes;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(RENDER.poll);
    const s = await scan(page);
    if (s.vids || s.ifr.length) { st("PLAYER_VISIBLE"); break; }
    if (s.nodes > base) grew = true;
    if (s.nodes === last) still++; else still = 0;
    last = s.nodes;
    if (grew && (s.box || s.play) && still >= 3) { st("PLAYER_PENDING_VISIBLE"); break; }
    if ((grew || s.anchors > 0) && still >= 5) break; // ya armada y quieta (también al volver atrás)
  }
  st("RENDERED");
}

// ---------------------------------------------------------------- «pagina»: la página armada, con su shadow DOM
function slimDoc() {
  const KEEP = /^(href|src|data-src|data-lazy-src|data-original|srcset|alt|title|class|id|role|aria-label|property|content|name|style)$/i;
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|SVG|LINK|TEMPLATE|CANVAS|SOURCE|TRACK|IFRAME)$/;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  let size = 0;
  const ser = (n) => {
    if (size > 1.6e6) return "";
    if (n.nodeType === 3) { const t = n.nodeValue.replace(/\s+/g, " "); size += t.length; return esc(t); }
    if (n.nodeType !== 1) return "";
    if (SKIP.test(n.tagName)) return "";
    const tag = n.tagName.toLowerCase();
    let a = "";
    for (const at of n.attributes) {
      if (!KEEP.test(at.name) || at.value.length > 600) continue;
      let v = at.value;
      if (at.name === "style") { if (!/background/i.test(v)) continue; }
      if (at.name === "href" || at.name === "src") { try { v = new URL(v, location.href).href; } catch {} }
      a += ` ${at.name}="${esc(v)}"`;
    }
    if (tag === "img" && n.currentSrc && !/^data:/.test(n.currentSrc)) a = a.replace(/ src="[^"]*"/, "") + ` src="${esc(n.currentSrc)}"`;
    let inner = "";
    if (n.shadowRoot) for (const c of n.shadowRoot.childNodes) inner += ser(c); // lo que vive dentro del componente
    for (const c of n.childNodes) inner += ser(c);
    size += tag.length * 2 + a.length;
    return /^(img|br|hr|input|meta)$/.test(tag) ? `<${tag}${a}>` : `<${tag}${a}>${inner}</${tag}>`;
  };
  const og = [...document.querySelectorAll('meta[property^="og:"]')].map((m) => `<meta property="${esc(m.getAttribute("property"))}" content="${esc(m.content || "")}">`).join("");
  return `<!doctype html><html><head><title>${esc(document.title)}</title>${og}</head>${ser(document.body)}</html>`;
}

// tarjetas con carátula que NO traen enlace (se abren con clic, como en tu grabación): se tocan una por una
function cardsCollect() {
  const all = window.__x4deep();
  const inLink = (e) => { for (let x = e; x; x = x.parentElement || (x.getRootNode && x.getRootNode().host)) if (x.tagName === "A" && x.getAttribute("href")) return true; return false; };
  const seen = new Set(), out = [];
  window.__x4cards = [];
  for (const im of all) {
    if (im.tagName !== "IMG") continue;
    const r = im.getBoundingClientRect(), w = r.width || im.width, h = r.height || im.height;
    if (w < 80 || h < 60 || inLink(im)) continue;
    const src = im.currentSrc || im.src || "";
    if (!src || seen.has(src) || /logo|icon|avatar|sprite|banner-ad/i.test(src + " " + im.className)) continue;
    seen.add(src);
    let name = im.alt || im.getAttribute("aria-label") || im.title || "";
    if (!name) { let p = im.parentElement; for (let k = 0; k < 4 && p && !name; k++, p = p.parentElement) name = (p.getAttribute && (p.getAttribute("aria-label") || p.title)) || (p.innerText || "").trim().split("\n")[0].slice(0, 80); }
    window.__x4cards.push(im);
    out.push({ i: window.__x4cards.length - 1, name: name.trim(), img: src });
  }
  return out;
}
// ---- datos del propio sitio: las listas JSON que piden sus carruseles (título, imagen y el «slug» de cada uno)
function jsonTap(page) {
  const bodies = [];
  const on = async (res) => {
    try {
      const rt = res.request().resourceType(), ct = (res.headers() || {})["content-type"] || "";
      if (!/^(xhr|fetch)$/.test(rt) || !/json/i.test(ct) || res.status() >= 400 || bodies.length >= 60) return;
      const t = await res.text(); if (t.length > 3e6) return;
      bodies.push(JSON.parse(t));
    } catch {}
  };
  page.on("response", on);
  return { bodies, stop: () => { try { page.off("response", on); } catch {} } };
}
const normS = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
// con UN título ya abierto (su enlace real) se aprende qué campo de esos datos forma el enlace de cada título
function learn(jsons, url, name) {
  let tail = ""; try { tail = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || ""); } catch {}
  if (!tail || tail.length < 3) return null;
  let hit = null;
  const visit = (o) => {
    if (hit || !o || typeof o !== "object") return;
    if (Array.isArray(o)) { for (const x of o) visit(x); return; }
    for (const [k, v] of Object.entries(o)) if (typeof v === "string" && (v === tail || v.endsWith("/" + tail))) { hit = { k, obj: o, path: v !== tail }; return; }
    for (const v of Object.values(o)) visit(v);
  };
  for (const j of jsons) visit(j);
  if (!hit) return null;
  const o = hit.obj, keys = Object.keys(o).filter((k) => typeof o[k] === "string");
  const nameKey = (name && keys.find((k) => normS(o[k]) === normS(name))) || ["title", "name", "titulo", "displayName", "label", "originalTitle"].find((k) => typeof o[k] === "string");
  if (!nameKey) return null;
  const imgKey = keys.find((k) => /^https?:\/\/\S+\.(jpe?g|png|webp|avif)(\?|$)/i.test(o[k]));
  const typeKey = ["type", "contentType", "content_type", "kind", "mediaType", "assetType", "category"].find((k) => typeof o[k] === "string");
  return { k: hit.k, path: hit.path, nameKey, imgKey, typeKey, typeVal: typeKey ? o[typeKey] : null, url, tail };
}
// el mismo enlace del título aprendido, con el «slug» de otro título en su lugar (nada inventado: es el campo del sitio)
function swapTail(url, tail, v) {
  const u = new URL(url), segs = u.pathname.split("/");
  const k = segs.map((x) => { try { return decodeURIComponent(x); } catch { return x; } }).lastIndexOf(tail);
  if (k < 0) return "";
  segs[k] = encodeURIComponent(v); u.pathname = segs.join("/"); u.search = ""; u.hash = "";
  return u.href;
}
function applyLearn(jsons, L) {
  const out = [], seen = new Set();
  const visit = (o) => {
    if (!o || typeof o !== "object" || out.length >= 400) return;
    if (Array.isArray(o)) { o.forEach(visit); return; }
    const v = o[L.k], nm = o[L.nameKey];
    if (typeof v === "string" && v && typeof nm === "string" && nm.trim() && (!L.typeKey || o[L.typeKey] === L.typeVal)) {
      let u = "";
      try { u = L.path ? new URL(v, L.url).href : /^[\w.~%-]+$/.test(v) ? swapTail(L.url, L.tail, v) : ""; } catch {}
      if (u && !seen.has(u)) { seen.add(u); out.push({ url: u, name: nm.trim().slice(0, 120), img: L.imgKey && typeof o[L.imgKey] === "string" ? o[L.imgKey] : "", via: "datos del sitio" }); }
    }
    Object.values(o).forEach(visit);
  };
  jsons.forEach(visit);
  return out;
}
// tocar una tarjeta y ver a qué título lleva (vuelve atrás después)
async function clickCard(page, home, c) {
  if (page.url() !== home) { await page.goto(home, { waitUntil: "domcontentloaded", timeout: RENDER.load }).catch(() => {}); await settle(page, () => {}, 5000); }
  await page.evaluate(DEEP).catch(() => {});
  const list = await page.evaluate(cardsCollect).catch(() => []);
  const cur = list.find((x) => x.img === c.img); if (!cur) return null;
  const pt = await page.evaluate((i) => { const e = window.__x4cards[i]; e.scrollIntoView({ block: "center", inline: "center" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, cur.i);
  await sleep(200);
  const before = page.url();
  const pop = page.waitForEvent("popup", { timeout: 2500 }).catch(() => null);
  await page.mouse.click(pt.x, pt.y);
  let url = "";
  for (let k = 0; k < 12 && !url; k++) { await sleep(200); if (page.url() !== before) url = page.url(); }
  const p = await Promise.race([pop, sleep(50).then(() => null)]); if (p) { if (!url) url = p.url(); p.close().catch(() => {}); }
  if (!url || url === home) { await page.keyboard.press("Escape").catch(() => {}); return null; }
  let name = c.name;
  if (!name) { await sleep(800); name = await page.evaluate(() => (document.querySelector("h1")?.innerText || document.querySelector('meta[property="og:title"]')?.content || document.title || "").trim().slice(0, 120)).catch(() => ""); }
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
  await settle(page, () => {}, 4000);
  return { url, name: name || url.split("/").filter(Boolean).pop().replace(/-/g, " "), img: c.img };
}
// RÁPIDO: se toca UNA tarjeta; con su enlace se leen los demás de los datos del sitio. Si no se puede,
// se tocan las tarjetas en 4 pestañas a la vez.
async function discoverCards(ctx, page, home, tap, emit) {
  await page.evaluate(DEEP).catch(() => {});
  const cards = (await page.evaluate(cardsCollect).catch(() => [])).slice(0, RENDER.maxCards);
  if (!cards.length) return [];
  const t0 = Date.now();
  emit({ type: "spa-stage", stage: `CARDS_FOUND ${cards.length}`, ms: 0 });
  const found = [];
  let host = ""; try { host = new URL(home).hostname; } catch {}
  const known = LEARNED.get(host);
  if (known) { // ya se aprendió en otra página del sitio: sin tocar nada
    const byName = new Map(cards.map((c) => [normS(c.name), c.img]));
    const all = applyLearn(tap.bodies, known).map((x) => ({ ...x, img: x.img || byName.get(normS(x.name)) || "" }));
    if (all.filter((x) => byName.has(normS(x.name))).length >= Math.min(3, cards.length)) { emit({ type: "spa-stage", stage: `TEMPLATE ${all.length}`, ms: Date.now() - t0 }); return all; }
  }
  let first = null;
  for (const c of cards.slice(0, 3)) { first = await clickCard(page, home, c).catch((e) => { if (isBrowserInfrastructureError(e)) throw e; return null; }); if (first) break; }
  if (!first) return [];
  found.push(first);
  const L = learn(tap.bodies, first.url, first.name);
  if (L) {
    const byName = new Map(cards.map((c) => [normS(c.name), c.img]));
    const all = applyLearn(tap.bodies, L).map((x) => ({ ...x, img: x.img || byName.get(normS(x.name)) || "" }));
    if (all.some((x) => x.url === first.url)) {
      LEARNED.set(host, L);
      emit({ type: "spa-stage", stage: `TEMPLATE ${all.length}`, ms: Date.now() - t0 });
      // las tarjetas que esos datos no cubren (otro tipo de contenido) se tocan
      const have = new Set(all.map((x) => normS(x.name)));
      const rest = cards.filter((c) => c.name && !have.has(normS(c.name))).slice(0, 8);
      for (const c of rest) { const r = await clickCard(page, home, c).catch(() => null); if (r) all.push(r); }
      return all;
    }
  }
  // sin datos que leer: 4 pestañas a la vez
  const todo = cards.filter((c) => c.img !== first.img);
  const pages = [page];
  for (let k = 1; k < 4 && k <= todo.length / 3; k++) { const p = await ctx.newPage(); p.on("popup", (x) => x.close().catch(() => {})); await p.goto(home, { waitUntil: "domcontentloaded", timeout: RENDER.load }).catch(() => {}); pages.push(p); }
  await Promise.all(pages.slice(1).map((p) => settle(p, () => {}, 6000)));
  let next = 0;
  await Promise.all(pages.map(async (p) => {
    while (next < todo.length && Date.now() - t0 < RENDER.cardsMs) {
      const c = todo[next++];
      const r = await clickCard(p, home, c).catch((e) => { if (isBrowserInfrastructureError(e)) throw e; return null; });
      if (r) { found.push(r); emit({ type: "spa-stage", stage: `CARD ${found.length}`, ms: Date.now() - t0 }); }
    }
  }));
  for (const p of pages.slice(1)) p.close().catch(() => {});
  if (page.url() !== home) await page.goto(home, { waitUntil: "domcontentloaded", timeout: RENDER.load }).catch(() => {});
  return found;
}
const escH = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const cardsHtml = (list) => !list.length ? "" : `<section class="x4-cards"><h2>Títulos</h2><div class="x4-list">${list.map((c) => `<div class="x4-card"><a href="${escH(c.url)}"><img src="${escH(c.img)}" alt="${escH(c.name)}"><h3>${escH(c.name)}</h3></a></div>`).join("")}</div></section>`;

// ---------------------------------------------------------------- «directo»: la fuente virtual Direct Player
// el botón que lleva al reproductor («Ver ahora», «Reproducir», «Play»…), también dentro de componentes
function ctaMark() {
  const all = window.__x4deep();
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 20 && r.height > 14 && s.visibility !== "hidden" && s.display !== "none"; };
  const TXT = /^(ver ahora|ver pel[ií]cula|ver gratis|ver en vivo|ver episodio( \d+)?|ver serie|continuar( viendo)?|reproducir|play|watch( now)?|mirar|ver)$/i;
  const inPlayer = (e) => { for (let x = e; x; x = x.parentElement) if (/player-(controls?|layout|main)|vjs-|jw-|plyr/i.test(typeof x.className === "string" ? x.className : "")) return true; return false; };
  let best = null, sc = -1;
  for (const e of all) {
    if (!/^(BUTTON|A)$/.test(e.tagName) && e.getAttribute("role") !== "button") continue;
    if (!vis(e) || inPlayer(e)) continue;
    const t = (e.getAttribute("aria-label") || e.textContent || "").replace(/\s+/g, " ").trim();
    let s = TXT.test(t) ? 3 : 0;
    if (/cta|primary|watch|play/i.test(typeof e.className === "string" ? e.className : "")) s += 1;
    if (e.querySelector && e.querySelector('[class*="icon-play" i],[name*="play" i]')) s += 1;
    if (s >= 3 && s > sc) { best = e; sc = s; }
  }
  document.querySelectorAll("[data-x4cta]").forEach((x) => x.removeAttribute("data-x4cta"));
  window.__x4cta = best;
  if (!best) return null;
  best.scrollIntoView({ block: "center" });
  const r = best.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (best.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40) };
}
// los videos que ya estaban (un avance de fondo, por ejemplo) quedan marcados para no confundirlos con la película
const markOld = () => { document.querySelectorAll("video").forEach((v) => { v.dataset.x4old = v.currentSrc || v.src || "1"; }); };
async function newVideo(page) {
  let best = null;
  for (const frame of page.frames()) {
    const r = await frame.evaluate(() => {
      const vs = [...document.querySelectorAll("video")];
      let k = -1, area = 0;
      vs.forEach((v, i) => { const b = v.getBoundingClientRect(); const fresh = !v.dataset.x4old || v.dataset.x4old !== (v.currentSrc || v.src || "1"); if (fresh && b.width * b.height >= area) { area = b.width * b.height; k = i; } });
      return { k, area };
    }).catch(() => null);
    if (r && r.k >= 0 && (!best || r.area > best.area)) best = { frame, idx: r.k, area: r.area };
  }
  return best;
}

async function directTest(page, ctx, job, code, emit) {
  const n = 1, name = "Direct Player";
  const out = { index: n, name, status: "testing", reason: null, detail: "", sourceTested: false, stages: [], type: "direct" };
  emit({ type: "source", n, status: "testing", stage: "opening" });
  // la página del título se abre y se deja armar (eso no cuenta en el tiempo de la fuente)
  const rd = await render(page, job.url, { emit });
  if (!rd.ok) return { ...out, status: "failed", reason: "SOURCE_ERROR", detail: "la página no abrió", sourceTested: true, ms: 0 };
  const a = await detectSiteArchitecture(page, { url: job.url, code });
  emit({ type: "spa", ok: true, url: page.url(), arch: a.arch, ops: a.ops, player: a.player, wall: a.wall, stages: rd.stages });
  // ---- la fuente: desde aquí corre su tiempo (ms 0)
  const t0 = Date.now(), total = Math.max(LIMITS.totalSource, +job.ms || 0), deadline = t0 + total;
  const steps = [];
  const stage = (s) => { steps.push({ ms: Date.now() - t0, stage: s }); emit({ type: "stage", n, stage: s }); };
  const net = networkMonitor(page, t0);
  const tabs = [];
  const onPop = (p) => tabs.push(p); page.on("popup", onPop);
  const done = (o) => { net.stop(); try { page.off("popup", onPop); } catch {} return { ...out, ...o, sourceTested: true, ms: Date.now() - t0, stages: steps, media: net.since(0), net: net.log.slice(-60) }; };
  try {
    stage("OPENING");
    for (const f of page.frames()) await f.evaluate(markOld).catch(() => {});
    await page.evaluate(DEEP).catch(() => {});
    let v = await newVideo(page);
    let action = "direct";
    if (!v || a.arch === "PLAYER_PENDING" || a.player.playButton) {
      const cta = await page.evaluate(ctaMark).catch(() => null);
      if (cta) {
        action = `clic en «${cta.text}»`;
        const pop = page.waitForEvent("popup", { timeout: 2500 }).catch(() => null);
        await page.mouse.click(cta.x, cta.y).catch(() => page.evaluate(() => window.__x4cta?.click()).catch(() => {}));
        stage("ACTION_EXECUTED");
        const p = await pop;
        if (p) { await sleep(800); const pv = await findVideo(p).catch(() => null); if (pv) { v = pv; stage("PLAYER_FOUND"); } else p.close().catch(() => {}); }
      } else if (!v) stage("ACTION_EXECUTED");
    } else stage("ACTION_EXECUTED");
    // el reproductor tiene el tiempo de la acción (sourceAction) para aparecer
    const until = Math.min(t0 + LIMITS.sourceAction, deadline - 1500);
    while (!v && Date.now() < until) { await sleep(200); v = await newVideo(page); }
    if (!v) return done({ status: "failed", reason: "NO_PLAYER", detail: "no apareció el reproductor", action });
    stage("PLAYER_FOUND");
    // ¿ya avanza? si no, Play como lo haría una persona (dentro del tiempo que queda)
    stage("VERIFYING");
    let r = await verifyPlayback(v);
    if (!r.working && Date.now() < deadline - 1500) {
      stage("PLAY_ATTEMPT");
      await v.frame.evaluate((i) => { const x = document.querySelectorAll("video")[i]; if (x) { x.muted = true; const p = x.play(); p && p.catch(() => {}); } }, v.idx).catch(() => {});
      stage("VERIFYING");
      r = await verifyPlayback(v);
      if (!r.working && Date.now() < deadline - 3000) r = await attemptPlayback(v.frame.page ? v.frame.page() : page, v, (s) => stage(s.toUpperCase()), tabs, () => {}, { get aborted() { return Date.now() > deadline; } });
    }
    if (r.working) { stage("WORKING"); return done({ status: "working", reason: null, detail: "PLAYBACK_CONFIRMED", progress: r.progress, action, video: { w: r.w, h: r.h } }); }
    if (Date.now() > deadline) return done({ status: "failed", reason: "SOURCE_TIMEOUT", detail: "se acabó el tiempo de la fuente", progress: r.progress ?? 0, action });
    return done({ status: "failed", reason: r.reason === "PLAYBACK_ERROR" ? "SOURCE_ERROR" : "PLAYBACK_NOT_CONFIRMED", detail: r.reason || "", progress: r.progress ?? 0, action });
  } catch (e) {
    if (isBrowserInfrastructureError(e)) return { ...out, status: "browser_error", reason: "BROWSER_UNAVAILABLE", sourceTested: false, detail: String(e?.message || e).slice(0, 160), stages: steps };
    return done({ status: "failed", reason: "SOURCE_ERROR", detail: String(e?.message || e).slice(0, 160) });
  } finally { for (const p of tabs) p.close().catch(() => {}); }
}

// RELEVO (igual que el modo «titulo»): el video confirmado se te pasa desde este mismo computador
async function relayFor(res, ctx, page, emit) {
  const media = (res.media || []).filter((m) => !/\.(ts|m4s|aac|vtt|key)(\?|#|$)|\/init[^/?#]*\.mp4(\?|#|$)/i.test(m.url) && !(m.status >= 400));
  const lists = media.filter((m) => m.type === "manifest" && /\.m3u8|mpegurl/i.test(m.url + " " + (m.ct || "")));
  const pick = lists.find((m) => /master/i.test(m.url)) || lists[0] || media.find((m) => /\.(mp4|m4v|webm)(\?|#|$)/i.test(m.url) || /^video\//i.test(m.ct || ""));
  if (!pick) { emit({ type: "relay", ok: false, why: "no vi la lista del video" }); return null; }
  emit({ type: "relay-start" });
  for (const f of page.frames()) await f.evaluate(() => document.querySelectorAll("video").forEach((v) => v.pause())).catch(() => {});
  try {
    const { startRelay } = await import("./relevo.mjs");
    const rl = await startRelay({ ctx, referer: pick.referer || pick.frame || "", ua: UA });
    const chk = await fetch(rl.local(pick.url), { headers: { range: "bytes=0-2047" } }).catch(() => null);
    const body = chk ? await chk.text().catch(() => "") : "";
    if (!chk || chk.status >= 400) { rl.close(); emit({ type: "relay", ok: false, why: "el servidor no le entregó el video al relevo (" + (chk ? chk.status : "sin respuesta") + ")" }); return null; }
    emit({ type: "relay", ok: true, url: rl.url(pick.url), kind: body.trimStart().startsWith("#EXTM3U") ? "hls" : "file", host: new URL(pick.url).host });
    return rl;
  } catch (e) { emit({ type: "relay", ok: false, why: String(e?.message || e).slice(0, 160) }); return null; }
}

// ---------------------------------------------------------------- una tarea (pagina · titulo · directo)
async function task(browser, job, code, emit, keep) {
  const que = job.que || "titulo";
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 720 }, locale: "es-CO", ignoreHTTPSErrors: true });
  let kept = false;
  try {
    await ctx.route("**/*", (r) => { let h = ""; try { h = new URL(r.request().url()).hostname; } catch {} const t = r.request().resourceType();
      return AD.test(h) || t === "font" || (que === "directo" && t === "image") ? r.abort().catch(() => {}) : r.continue().catch(() => {}); });
    const page = await ctx.newPage();
    emit({ type: "preflight", ok: true });
    if (que === "directo") {
      const res = await directTest(page, ctx, job, code, emit);
      emit({ ...res, type: "result", sourceType: res.type });
      const ok = res.status === "working";
      if (ok && job.relay) { const rl = await keep.relay(res, ctx, page, emit); if (rl) kept = true; }
      emit({ type: "done", status: ok ? "working" : res.status === "browser_error" ? "browser_error" : "failed", reason: ok ? null : res.status === "browser_error" ? "BROWSER_UNAVAILABLE" : "NO_WORKING_SOURCE", selected_source: ok ? { name: res.name, index: 1 } : null });
      return;
    }
    const pagina = que === "pagina";
    page.on("popup", (p) => p.close().catch(() => {}));
    const tap = jsonTap(page);
    const rd = await render(page, job.url, { scroll: pagina, emit });
    if (!rd.ok) emit({ type: "spa", ok: false, reason: "SOURCE_ERROR", detail: "la página no abrió", stages: rd.stages });
    else {
      const a = await detectSiteArchitecture(page, { url: job.url, code });
      const out = { type: "spa", ok: true, url: page.url(), title: await page.title().catch(() => ""), arch: a.arch, ops: a.ops, player: a.player, wall: a.wall, stages: rd.stages };
      if (pagina) {
        await page.evaluate(DEEP).catch(() => {});
        let html = await page.evaluate(slimDoc).catch(() => "");
        const linked = (html.match(/<a\b[^>]*href="[^"]*"[^>]*>(?:(?!<\/a>)[\s\S])*?<img/gi) || []).length;
        if (linked < 6) { const cards = await discoverCards(ctx, page, page.url(), tap, emit); out.cards = cards.length; html = html.replace(/<\/body><\/html>$|<\/html>$/, cardsHtml(cards) + "$&"); }
        // página con señal en vivo (Guía de TV): su propio reproductor ya está transmitiendo
        out.live = await page.evaluate(() => [...document.querySelectorAll("video")].some((v) => !isFinite(v.duration) && v.readyState >= 2)).catch(() => false);
        out.html = html.slice(0, 450000);
      }
      tap.stop();
      emit(out);
    }
    emit({ type: "done", status: "done" });
  } finally { if (!kept) await ctx.close().catch(() => {}); }
}

// SESIÓN CALIENTE: el mismo Chrome se queda encendido unos minutos y atiende las siguientes tareas al instante
// (categorías, títulos, pruebas). Se apaga solo tras WARM_MIN sin tareas (o si lo cancelas).
export const WARM_MIN = 15;
export async function run(job, { send, launchChrome, isCancel = () => false, maxMs = 340 * 60e3, take = null }) {
  const START = Date.now();
  const results = {}, order = [];
  let chain = Promise.resolve(), lastSend = 0, state = "running";
  const flush = (status = state) => { state = status; chain = chain.then(() => send({ status: "running", job: { status, warm: !!take, results, events: take ? [] : results["0"]?.events || [] } })); return chain; };
  let relay = null;
  const keep = { relay: async (res, ctx, page, emit) => { if (relay) { try { relay.rl.close(); } catch {} relay.ctx.close().catch(() => {}); relay = null; } const rl = await relayFor(res, ctx, page, emit); if (rl) relay = { rl, ctx }; return rl; } };
  let browser, code = job.code || "";
  // solo las últimas tareas terminadas quedan a la vista (el espacio es limitado); las que corren nunca se borran
  const trim = () => { while (order.length > 3) { const k = order.find((x) => results[x]?.status === "done"); if (!k) break; order.splice(order.indexOf(k), 1); delete results[k]; } };
  const runOne = async (tid, t) => {
    const ev = []; results[tid] = { status: "running", events: ev, at: Date.now() }; order.push(tid);
    trim();
    const emit = (e) => { ev.push(e); if (e.type !== "stage" || Date.now() - lastSend > 1500) { lastSend = Date.now(); flush("running"); } };
    try { await task(browser, t, code, emit, keep); }
    catch (e) { emit({ type: "done", status: "browser_error", reason: "BROWSER_UNAVAILABLE", detail: String(e?.message || e).slice(0, 160) }); }
    results[tid].status = "done";
    await flush(take ? "waiting" : "done");
  };
  try {
    if (!code && process.env.TV_URL) code = await (await fetch(process.env.TV_URL.replace(/\/+$/, "") + "/explorador-dom.js")).text().catch(() => "");
    browser = await launchChrome({ headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
    await runOne("0", job);
    if (take) {
      const done = new Set(), doneKey = new Map();
      let last = Date.now(), beat = 0, running = 0;
      while (!isCancel() && Date.now() - START < maxMs) {
        const idle = !running && Date.now() - last > WARM_MIN * 60e3 && (!relay || relay.rl.idle() > 30 * 60e3);
        if (idle) break;
        const d = await take().catch(() => ({}));
        if (d?.cancel) break;
        const t = running < 2 ? (d?.tasks || []).find((x) => !done.has(x.tid)) : null;
        if (t) {
          done.add(t.tid);
          running++;
          (async () => { try {
          const key = (t.que || "") + " " + t.url;
          if (t.que === "pagina" && doneKey.has(key) && Date.now() - doneKey.get(key).at < 10 * 60e3) { // ya se hizo: se repite el resultado
            results[t.tid] = { status: "done", events: doneKey.get(key).events, at: Date.now() }; order.push(t.tid); trim();
            await flush("waiting");
          } else {
            await runOne(t.tid, t);
            if (t.que === "pagina") doneKey.set(key, { at: Date.now(), events: results[t.tid]?.events || [] });
          }
          last = Date.now();
          } finally { running--; last = Date.now(); } })();
        } else if (Date.now() - beat > 10000) { beat = Date.now(); await flush("waiting"); }
        await sleep(t ? 50 : 1200);
      }
    }
  } catch (e) {
    if (!results["0"]) results["0"] = { status: "done", events: [{ type: "done", status: "browser_error", reason: "BROWSER_UNAVAILABLE", detail: String(e?.message || e).slice(0, 160) }] };
  } finally {
    state = "done"; await flush("done");
    if (relay && !take) { // sin sesión caliente: igual que antes, el relevo sigue mientras lo ves
      for (;;) { await sleep(30000); await flush("done"); if (isCancel() || relay.rl.idle() > 30 * 60e3 || Date.now() - START > maxMs) break; }
    }
    try { relay?.rl.close(); } catch {}
    await browser?.close().catch(() => {});
  }
}
