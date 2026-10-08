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
// a dónde lleva «Ver ahora» en cada sitio (lo que el propio sitio mostró: /movie/x → /player/movie/x)
const PLAYER_ROUTE = new Map();

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
  await settle(page, st, RENDER.settle, scroll);
  if (await acceptConsent(page)) st("COOKIES_OK");
  if (scroll) {
    for (let i = 0; i < RENDER.scrolls; i++) { await page.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {}); await sleep(RENDER.scrollWait); }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(400);
    st("SCROLLED");
  }
  return { ok: true, stages };
}
// el aviso de cookies/privacidad tapa la página (una capa encima de todo): se acepta como lo haría una persona
async function acceptConsent(page) {
  for (const f of page.frames()) {
    const ok = await f.evaluate(() => {
      const all = window.__x4deep ? window.__x4deep() : [...document.querySelectorAll("*")];
      const OK = /^(acepta|aceptar|acepto|accept|allow|permitir|entendido|de acuerdo|estoy de acuerdo|ok\b|got it|agree|i agree|continuar$)/i;
      const btns = all.filter((e) => (e.tagName === "BUTTON" || e.getAttribute?.("role") === "button" || e.tagName === "A") && e.getBoundingClientRect().width > 20);
      const txt = (e) => (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
      const b = btns.find((e) => { const t = txt(e); return t.length < 45 && OK.test(t) && !/rechaz|reject|config|ajust|manage|prefer/i.test(t); });
      let did = false;
      if (b) { b.click(); did = true; }
      // si aún queda la capa del aviso de privacidad/cookies encima de todo, se quita (no es una protección del video)
      setTimeout(() => {
        for (const e of all) {
          if (!e.isConnected) continue;
          const t = (e.innerText || "").slice(0, 400);
          if (/cookie|privacidad|privacy|consent/i.test(t) && /overlay|dialog|modal|consent|cookie|banner/i.test((typeof e.className === "string" ? e.className : "") + " " + (e.id || "") + " " + (e.getAttribute("role") || ""))) e.remove();
        }
        document.querySelectorAll(".cdk-overlay-backdrop").forEach((x) => x.remove());
      }, 300);
      return did || /cookie|privacidad|privacy/i.test((document.body?.innerText || "").slice(-3000));
    }).catch(() => false);
    if (ok) { await sleep(600); return true; }
  }
  return false;
}
// tiempo de render: hasta que aparezca el reproductor o la página deje de crecer
// list = página de lista (portada, categoría): un video de fondo NO significa que ya terminó de armarse; se espera
// a que la página deje de crecer (sus carruseles con carátulas)
async function settle(page, st = () => {}, ms = RENDER.settle, list = false) {
  let last = -1, still = 0, grew = false, saw = false;
  const base = (await scan(page)).nodes;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(RENDER.poll);
    const s = await scan(page);
    if ((s.vids || s.ifr.length) && !saw) { saw = true; st("PLAYER_VISIBLE"); if (!list) break; }
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
    if (!src || seen.has(src) || /logo|icon|avatar|sprite|banner-ad|social/i.test(src + " " + im.className + " " + (im.alt || ""))) continue;
    if (w > innerWidth * 0.6) continue; // un banner o la portada grande, no una carátula
    seen.add(src);
    // ¿está en el carrusel grande de arriba (hero)? esas van al final
    let hero = false; for (let x = im, k = 0; x && k < 14; x = x.parentElement || (x.getRootNode && x.getRootNode().host), k++) { const t = (x.tagName || "") + " " + (typeof x.className === "string" ? x.className : ""); if (/hero|banner|billboard|jumbotron/i.test(t)) { hero = true; break; } }
    let name = im.alt || im.getAttribute("aria-label") || im.title || "";
    if (!name) { let p = im.parentElement; for (let k = 0; k < 4 && p && !name; k++, p = p.parentElement) name = (p.getAttribute && (p.getAttribute("aria-label") || p.title)) || (p.innerText || "").trim().split("\n")[0].slice(0, 80); }
    window.__x4cards.push(im);
    out.push({ i: window.__x4cards.length - 1, name: name.trim(), img: src, hero, w: Math.round(w), h: Math.round(h) });
  }
  return out.sort((a, b) => a.hero - b.hero);
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
  learn.why = "";
  let tail = ""; try { tail = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || ""); } catch {}
  if (!tail || tail.length < 3) return null;
  const hits = [];
  const visit = (o, parent) => {
    if (!o || typeof o !== "object" || hits.length > 40) return;
    if (Array.isArray(o)) { for (const x of o) visit(x, parent); return; }
    for (const [k, v] of Object.entries(o)) if (typeof v === "string" && (v === tail || v.endsWith("/" + tail) || v.endsWith(":" + tail))) { hits.push({ k, obj: o, parent, path: v.endsWith("/" + tail), urn: v.endsWith(":" + tail) }); break; }
    for (const v of Object.values(o)) if (v && typeof v === "object") visit(v, o);
  };
  for (const j of jsons) visit(j, null);
  if (!hits.length) return null;
  const nn = normS(name);
  const findName = (o) => { if (!o) return ""; const ks = Object.keys(o).filter((k) => typeof o[k] === "string"); return (nn && (ks.find((k) => normS(o[k]) === nn) || ks.find((k) => o[k].length > 3 && /\s|[A-ZÁÉÍÓÚ]/.test(o[k]) && (nn.includes(normS(o[k])) || normS(o[k]).includes(nn))))) || ""; };
  let hit = null, nameKey = "", fromParent = false;
  for (const h of hits) { const a = findName(h.obj); if (a) { hit = h; nameKey = a; break; } }
  if (!hit) for (const h of hits) { const a = findName(h.parent); if (a) { hit = h; nameKey = a; fromParent = true; break; } }
  if (!hit) { hit = hits[0]; nameKey = ["title", "name", "titulo", "displayName", "label", "originalTitle"].find((k) => typeof hit.obj[k] === "string") || ""; }
  if (!nameKey) { learn.why = "campos: " + Object.entries(hits[0].obj).slice(0, 18).map(([k, v]) => k + "=" + (typeof v === "string" ? v.slice(0, 18) : Array.isArray(v) ? "[…]" : typeof v === "object" && v ? "{…}" : v)).join(" "); return null; }
  const o = hit.obj, keys = Object.keys(o).filter((k) => typeof o[k] === "string");
  const IMG = /^https?:\/\/\S+\.(jpe?g|png|webp|avif)(\?|$)/i;
  let imgKey = keys.find((k) => IMG.test(o[k]));
  if (!imgKey) for (const [k, v] of Object.entries(o)) if (v && typeof v === "object" && !Array.isArray(v)) { const k2 = Object.keys(v).find((x) => typeof v[x] === "string" && IMG.test(v[x])); if (k2) { imgKey = k + "." + k2; break; } }
  const typeKey = ["type", "contentType", "content_type", "kind", "mediaType", "assetType", "category"].find((k) => typeof o[k] === "string");
  // urn: el enlace es /<tipo>/<slug> con los dos últimos pedazos del identificador (/movie/x, /tvseries/y…)
  // ¿qué campo dice el tipo que va en el camino? (/movie/x → un campo con «movie»)
  let segKey = "", segIdx = -1;
  try { const sg = new URL(url).pathname.split("/").filter(Boolean); for (let i = 0; i < sg.length - 1 && !segKey; i++) { const k2 = keys.find((k) => k !== hit.k && o[k].toLowerCase() === sg[i].toLowerCase()); if (k2) { segKey = k2; segIdx = i; } } } catch {}
  let urn2 = false;
  if (hit.urn) { const sg = o[hit.k].split(":"); try { urn2 = new URL(url).pathname.replace(/\/+$/, "") === "/" + sg.slice(-2).join("/"); } catch {} }
  if (hit.urn && !urn2) return null;
  return { k: hit.k, path: hit.path, urn2, segKey, segIdx, fromParent, urnType: urn2 ? o[hit.k].split(":").slice(-2)[0] : "", nameKey, imgKey, typeKey, typeVal: typeKey ? o[typeKey] : null, url, tail };
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
  const visit = (o, parent) => {
    if (!o || typeof o !== "object" || out.length >= 400) return;
    if (Array.isArray(o)) { o.forEach((x) => visit(x, parent)); return; }
    const v = o[L.k], nm = L.fromParent ? parent?.[L.nameKey] : o[L.nameKey];
    const ownPath = L.path || L.urn2 || !!L.segKey; // cada uno trae su propio camino: sirve para películas y series a la vez
    if (typeof v === "string" && v && typeof nm === "string" && nm.trim() && (ownPath || !L.typeKey || o[L.typeKey] === L.typeVal)) {
      let u = "";
      try {
        if (L.urn2) { const sg = v.split(":"); if (sg.length >= 3 && (sg[sg.length - 2] === L.urnType || /^(movies?|tvseries|series|shows?|channels?|live|specials?|documentar(y|ies))$/i.test(sg[sg.length - 2]))) u = new URL("/" + sg.slice(-2).join("/"), L.url).href; }
        else if (L.segKey && !L.path) { // /<tipo>/<slug> con el tipo y el slug de cada uno
          const ty = o[L.segKey];
          const seg0 = new URL(L.url).pathname.split("/").filter(Boolean)[L.segIdx].toLowerCase();
          // el mismo tipo que se abrió, u otro tipo de contenido del sitio usado igual en el camino (/movie/ ↔ /tvseries/)
          if (typeof ty === "string" && (ty.toLowerCase() === seg0 || (/^(movies?|tvseries|series|shows?)$/i.test(ty) && /^(movies?|tvseries|series|shows?)$/i.test(seg0))) && /^[\w.~%-]+$/.test(v)) {
            const uu = new URL(swapTail(L.url, L.tail, v)); const sg = uu.pathname.split("/"); const i = sg.findIndex((x) => x.toLowerCase() === seg0); if (i >= 0) sg[i] = ty; uu.pathname = sg.join("/"); u = uu.href;
          }
        }
        else u = L.path ? new URL(v, L.url).href : /^[\w.~%-]+$/.test(v) ? swapTail(L.url, L.tail, v) : "";
      } catch {}
      if (u && !seen.has(u)) { seen.add(u); const im = L.imgKey ? L.imgKey.split(".").reduce((a, k) => (a && typeof a === "object" ? a[k] : undefined), o) : ""; out.push({ url: u, name: nm.trim().slice(0, 120), img: typeof im === "string" ? im : "", via: "datos del sitio" }); }
    }
    Object.values(o).forEach((x) => { if (x && typeof x === "object") visit(x, o); });
  };
  jsons.forEach((j) => visit(j, null));
  return out;
}
// tocar una tarjeta y ver a qué título lleva (vuelve atrás después)
async function clickCard(page, home, c) {
  if (page.url() !== home) { await page.goto(home, { waitUntil: "domcontentloaded", timeout: RENDER.load }).catch(() => {}); await settle(page, () => {}, 5000, true); }
  await page.evaluate(DEEP).catch(() => {});
  const list = await page.evaluate(cardsCollect).catch(() => []);
  const cur = list.find((x) => x.img === c.img); if (!cur) return null;
  const geo = () => page.evaluate((i) => {
    const e = window.__x4cards[i]; e.scrollIntoView({ block: "center", inline: "center" });
    const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    let t = document.elementFromPoint(x, y); for (let k = 0; t && t.shadowRoot && k < 6; k++) { const u = t.shadowRoot.elementFromPoint(x, y); if (!u || u === t) break; t = u; }
    const d = (n) => n ? n.tagName.toLowerCase() + (typeof n.className === "string" && n.className.trim() ? "." + n.className.trim().split(/\s+/)[0] : "") : "-";
    return { x, y, w: Math.round(r.width), h: Math.round(r.height), top: d(t) + " < " + d(t?.parentElement || t?.getRootNode?.()?.host) };
  }, cur.i);
  await page.evaluate(() => document.querySelectorAll(".cdk-overlay-backdrop, .modal-backdrop, [class*='overlay-backdrop']").forEach((b) => b.click())).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  let pt = await geo();
  const before = page.url();
  const navd = async (ms) => { for (let k = 0; k < ms / 200; k++) { await sleep(200); if (page.url() !== before) return page.url(); } return ""; };
  const pop = page.waitForEvent("popup", { timeout: 4000 }).catch(() => null);
  await page.mouse.move(pt.x, pt.y, { steps: 4 }); await sleep(450); // pasar el mouse (muchas tarjetas se agrandan al pasar)
  pt = await geo();
  await page.mouse.click(pt.x, pt.y);
  let url = await navd(3000);
  if (!url) { // clic por código en la tarjeta y en lo que la envuelve (dentro del componente)
    await page.evaluate((i) => { let x = window.__x4cards[i]; for (let k = 0; x && k < 5; k++, x = x.parentElement || (x.getRootNode && x.getRootNode().host)) { x.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, view: window })); } }, cur.i).catch(() => {});
    url = await navd(2000);
  }
  const p = await Promise.race([pop, sleep(50).then(() => null)]); if (p) { if (!url) url = p.url(); p.close().catch(() => {}); }
  if (!url || url === home) { clickCard.fails = (clickCard.fails || []).concat(`${pt.w}x${pt.h} encima: ${pt.top}`).slice(-6); await page.keyboard.press("Escape").catch(() => {}); return null; }
  let name = c.name;
  for (let k = 0; k < 6; k++) { // el nombre de verdad está en la página del título (la tarjeta a veces solo dice «Nueva temporada»)
    await sleep(250);
    const h = await page.evaluate(() => (window.__x4deep ? null : null, (document.querySelector("h1")?.innerText || document.querySelector('meta[property="og:title"]')?.content || "").trim().slice(0, 120))).catch(() => "");
    if (h) { name = h; break; }
  }
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
  await settle(page, () => {}, 4000, true);
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
  clickCard.fails = [];
  for (const c of cards.slice(0, 8)) { first = await clickCard(page, home, c).catch((e) => { if (isBrowserInfrastructureError(e)) throw e; return null; }); if (first) break; }
  for (const f of clickCard.fails) emit({ type: "spa-stage", stage: `CLICK_FAIL ${f}`, ms: Date.now() - t0 });
  if (!first) { emit({ type: "spa-stage", stage: `CARDS_SAMPLE ${cards.slice(0, 4).map((c) => `${c.w}x${c.h}${c.hero ? " hero" : ""} «${c.name.slice(0, 30)}»`).join(" | ")}`, ms: Date.now() - t0 }); return []; }
  found.push(first);
  const L = learn(tap.bodies, first.url, first.name);
  if (!L) {
    let tail = ""; try { tail = new URL(first.url).pathname.split("/").filter(Boolean).pop() || ""; } catch {}
    let ctxs = "";
    for (const b of tap.bodies) { const t = JSON.stringify(b); const i = tail ? t.indexOf(tail) : -1; if (i >= 0) { ctxs = t.slice(Math.max(0, i - 70), i + tail.length + 20).replace(/https?:\/\/[^"\\]+/g, "(url)"); break; } }
    emit({ type: "spa-stage", stage: `TEMPLATE_MISS datos=${tap.bodies.length} nombre=«${first.name}» ${learn.why || (ctxs ? "visto: " + ctxs : "el título no aparece en los datos")}`, ms: Date.now() - t0 });
  }
  if (L) {
    const byName = new Map(cards.map((c) => [normS(c.name), c.img]));
    const all = applyLearn(tap.bodies, L).map((x) => ({ ...x, img: x.img || byName.get(normS(x.name)) || "" }));
    if (all.some((x) => x.url === first.url)) {
      LEARNED.set(host, L);
      emit({ type: "spa-stage", stage: `TEMPLATE ${all.length}`, ms: Date.now() - t0 });
      // las tarjetas que esos datos no cubren (otro tipo de contenido) se tocan
      // solo si esos datos dejaron por fuera bastantes tarjetas (otro tipo de contenido) se tocan unas pocas
      const imgs = new Set(all.map((x) => x.img).filter(Boolean)), names = new Set(all.map((x) => normS(x.name)));
      const rest = cards.filter((c) => !imgs.has(c.img) && !(c.name && names.has(normS(c.name))));
      if (all.length < cards.length * 0.8) for (const c of rest.slice(0, 4)) { const r = await clickCard(page, home, c).catch(() => null); if (r && !all.some((x) => x.url === r.url)) all.push(r); }
      return all;
    }
  }
  // sin datos que leer: 4 pestañas a la vez
  const todo = cards.filter((c) => c.img !== first.img);
  const pages = [page];
  for (let k = 1; k < 4 && k <= todo.length / 3; k++) { const p = await ctx.newPage(); p.on("popup", (x) => x.close().catch(() => {})); await p.goto(home, { waitUntil: "domcontentloaded", timeout: RENDER.load }).catch(() => {}); pages.push(p); }
  await Promise.all(pages.slice(1).map((p) => settle(p, () => {}, 6000, true)));
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
  const TXT = /^(ver ahora|ver( la)? pel[ií]cula|ver gratis|ver en vivo|ver (el )?(primer )?episodio.*|ver (t|temporada)\s*\d.*|ver serie|continuar( viendo)?.*|reproducir.*|empezar|comenzar|play|watch( now)?|mirar|ver)$/i;
  const inPlayer = (e) => { for (let x = e; x; x = x.parentElement) if (/player-(controls?|layout|main)|vjs-|jw-|plyr/i.test(typeof x.className === "string" ? x.className : "")) return true; return false; };
  let best = null, sc = -1;
  for (const e of all) {
    if (!/^(BUTTON|A)$/.test(e.tagName) && e.getAttribute("role") !== "button") continue;
    if (!vis(e) || inPlayer(e)) continue;
    const t = (e.getAttribute("aria-label") || e.textContent || "").replace(/\s+/g, " ").trim();
    let s = TXT.test(t) ? 3 : 0;
    if (/cta|primary|watch|play/i.test(typeof e.className === "string" ? e.className : "")) s += 1;
    if (e.querySelector && e.querySelector('[class*="icon-play" i],[name*="play" i]')) s += 2;
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

// DRM (Widevine/PlayReady/FairPlay): si el video pide licencia, se informa como contenido protegido y no se sigue
export const DRM_HOOK = `(() => { try {
  const n = navigator, r = n.requestMediaKeySystemAccess && n.requestMediaKeySystemAccess.bind(n);
  window.__x4drm = { ks: "", req: false };
  if (r) n.requestMediaKeySystemAccess = function (ks, cfg) { window.__x4drm.ks = ks; return r(ks, cfg); };
  const g = window.MediaKeySession && MediaKeySession.prototype.generateRequest;
  if (g) MediaKeySession.prototype.generateRequest = function () { window.__x4drm.req = true; return g.apply(this, arguments); };
} catch {} })()`;
const drmOf = async (page) => { for (const f of page.frames()) { const d = await f.evaluate(() => window.__x4drm || null).catch(() => null); if (d?.req) return d; } return null; };
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
  const done0 = (o) => { net.stop(); try { page.off("popup", onPop); } catch {} return { ...out, ...o, sourceTested: true, ms: Date.now() - t0, stages: steps, media: net.since(0), net: net.log.slice(-60) }; };
  const done = async (o) => {
    const drm = await drmOf(page);
    if (drm) { stage("DRM"); return done0({ ...o, status: "failed", reason: "SOURCE_ERROR", drm: drm.ks || "DRM", detail: `contenido protegido con DRM (${drm.ks || "licencia"}): solo se reproduce dentro del sitio, no se puede pasar a tu reproductor` }); }
    return done0(o);
  };
  try {
    stage("OPENING");
    for (const f of page.frames()) await f.evaluate(markOld).catch(() => {});
    await page.evaluate(DEEP).catch(() => {});
    let v = await newVideo(page);
    let action = "direct";
    if (!v || a.arch === "PLAYER_PENDING" || a.player.playButton) {
      await acceptConsent(page);
      let cta = null;
      for (let k = 0; k < 20 && !cta; k++) { await page.evaluate(DEEP).catch(() => {}); cta = await page.evaluate(ctaMark).catch(() => null); if (!cta) await sleep(200); }
      if (cta) {
        action = `clic en «${cta.text}»`;
        const pop = page.waitForEvent("popup", { timeout: 2500 }).catch(() => null);
        const path0 = new URL(page.url()).pathname;
        await page.mouse.click(cta.x, cta.y).catch(() => page.evaluate(() => window.__x4cta?.click()).catch(() => {}));
        stage("ACTION_EXECUTED");
        // ¿el clic hizo algo? si no cambió de página ni apareció el video, clic por código; y si el sitio ya mostró
        // a dónde lleva «Ver ahora» (/player/…), se va directo ahí
        const moved = async (ms) => { for (let k = 0; k < ms / 200; k++) { await sleep(200); if (new URL(page.url()).pathname !== path0 || (await newVideo(page))) return true; } return false; };
        let ok = await moved(2400);
        if (!ok) { await acceptConsent(page); await page.evaluate(() => window.__x4cta?.click()).catch(() => {}); ok = await moved(1600); }
        let host = ""; try { host = new URL(page.url()).hostname; } catch {}
        if (ok) { const p1 = new URL(page.url()).pathname; if (p1 !== path0 && p1.endsWith(path0)) PLAYER_ROUTE.set(host, p1.slice(0, p1.length - path0.length)); }
        else if (PLAYER_ROUTE.has(host)) { action += " · ir al reproductor"; await page.goto(new URL(PLAYER_ROUTE.get(host) + path0, page.url()).href, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {}); await acceptConsent(page); }
        const p = await pop;
        if (p) { await sleep(800); const pv = await findVideo(p).catch(() => null); if (pv) { v = pv; stage("PLAYER_FOUND"); } else p.close().catch(() => {}); }
      } else if (!v) stage("ACTION_EXECUTED");
    } else stage("ACTION_EXECUTED");
    // el reproductor tiene el tiempo de la acción (sourceAction) para aparecer
    const until = Math.min(t0 + LIMITS.sourceAction, deadline - 1500);
    while (!v && Date.now() < until) { await sleep(200); v = await newVideo(page); }
    if (!v) {
      const dg = await page.evaluate(() => {
        const all = window.__x4deep ? window.__x4deep() : [...document.querySelectorAll("*")];
        const vids = all.filter((e) => e.tagName === "VIDEO").map((v) => `${Math.round(v.getBoundingClientRect().width)}x${Math.round(v.getBoundingClientRect().height)}${v.dataset.x4old ? " (ya estaba)" : ""}`);
        const dlg = all.filter((e) => /dialog|modal|overlay-pane|toast|snack|alert|error|login|sign-in|paywall/i.test((typeof e.className === "string" ? e.className : "") + " " + (e.getAttribute && e.getAttribute("role") || "")) && e.getBoundingClientRect().width > 50).slice(0, 2).map((e) => (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120)).filter(Boolean);
        return { path: location.pathname, vids, ifr: document.querySelectorAll("iframe").length, dlg };
      }).catch(() => ({}));
      const path0 = (() => { try { return new URL(job.url).pathname; } catch { return ""; } })();
      const bl = [...(job.__blocked || [])].slice(0, 6).join(", ");
      return done({ status: "failed", reason: "NO_PLAYER", action,
        detail: `no apareció el reproductor · acción: ${action}${dg.path && dg.path !== path0 ? " · pasó a " + dg.path : " · siguió en la misma página"} · videos: ${dg.vids?.length ? dg.vids.join(", ") : "ninguno"} · iframes: ${dg.ifr ?? "?"}${dg.dlg?.length ? " · aviso en pantalla: «" + dg.dlg.join(" / ") + "»" : ""}${bl ? " · bloqueados: " + bl : ""}` });
    }
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
    const blocked = new Set(); job.__blocked = blocked;
    await ctx.route("**/*", (r) => { let h = ""; try { h = new URL(r.request().url()).hostname; } catch {} const t = r.request().resourceType();
      const ad = AD.test(h) && !(que === "directo" && /(^|\.)imasdk\.googleapis\.com$/i.test(h));
      if (ad) blocked.add(h);
      return ad || t === "font" || ((que === "directo" || que === "fuentes") && t === "image") ? r.abort().catch(() => {}) : r.continue().catch(() => {}); });
    if (que === "directo") await ctx.addInitScript(DRM_HOOK);
    const page = await ctx.newPage();
    emit({ type: "preflight", ok: true });
    // solo encender (se pide al abrir la ficha de un título: cuando le des play, el navegador ya está listo)
    if (que === "ping") { emit({ type: "done", status: "done" }); return; }
    // la prueba de SIEMPRE (fuentes en orden con explorar.js), pero en este Chrome que ya está encendido
    if (que === "fuentes") {
      const { probarTitulo } = await import("./explorar.js");
      const r = await probarTitulo(page, { url: job.url, sources: job.sources || [], code, totalMs: job.ms || 10000, emit });
      if (job.relay && r.status === "working") { const w = (r.results || []).find((x) => x.status === "working"); if (w) { const rl = await keep.relay(w, ctx, page, emit); if (rl) kept = true; } }
      emit({ type: "done", ...r, results: undefined });
      return;
    }
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
      const inl = await page.evaluate(() => [...document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__, script#ng-state, script#serverApp-state')].map((x) => x.textContent).filter((t) => t && t.length < 3e6)).catch(() => []);
      for (const t of inl) { try { tap.bodies.push(JSON.parse(t)); } catch {} }
      const a = await detectSiteArchitecture(page, { url: job.url, code });
      const out = { type: "spa", ok: true, url: page.url(), title: await page.title().catch(() => ""), arch: a.arch, ops: a.ops, player: a.player, wall: a.wall, stages: rd.stages };
      if (pagina) {
        await page.evaluate(DEEP).catch(() => {});
        let html = await page.evaluate(slimDoc).catch(() => "");
        // ¿cuántas carátulas traen su propio enlace a un título del sitio? (los logos y redes sociales no cuentan)
        const linked = await page.evaluate(() => {
          const all = window.__x4deep ? window.__x4deep() : [...document.querySelectorAll("*")];
          return all.filter((a) => {
            if (a.tagName !== "A") return false;
            let u; try { u = new URL(a.getAttribute("href") || "", location.href); } catch { return false; }
            if (u.hostname !== location.hostname || u.pathname.length < 3) return false;
            const im = a.querySelector("img"); if (!im) return false;
            const r = im.getBoundingClientRect();
            return (r.width || im.width) >= 80 && (r.height || im.height) >= 60 && !/logo|icon|social/i.test((im.src || "") + " " + (im.alt || "") + " " + (im.className || ""));
          }).length;
        }).catch(() => 0);
        out.linked = linked;
        emit({ type: "spa-stage", stage: `LINKED_CARDS ${linked}`, ms: 0 });
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
      let last = Date.now(), beat = 0, running = 0, runningPre = 0;
      while (!isCancel() && Date.now() - START < maxMs) {
        const idle = !running && Date.now() - last > WARM_MIN * 60e3 && (!relay || relay.rl.idle() > 30 * 60e3);
        if (idle) break;
        const d = await take().catch(() => ({}));
        if (d?.cancel) break;
        const t = (d?.tasks || []).find((x) => !done.has(x.tid) && (x.pre ? running < 3 && runningPre < 1 : running < 3));
        if (t) {
          done.add(t.tid);
          running++; if (t.pre) runningPre++;
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
          } finally { running--; if (t.pre) runningPre--; last = Date.now(); } })();
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
export { learn as __learn, applyLearn as __applyLearn };
