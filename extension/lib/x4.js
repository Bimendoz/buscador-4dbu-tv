// COPIA EXACTA de NOVA/public/explorador-dom.js (el mismo detector de NOVA, aquí dentro de tu extensión).
// Si cambias uno, copia el archivo al otro: así la extensión y NOVA reconocen los sitios igual.
// +4dBu TV · EXPLORADOR AUTOMÁTICO — análisis estructural de páginas (sin reglas por sitio)
// ---------------------------------------------------------------------------------------------------------
// Un solo código que funciona en dos lugares:
//   · en tu página, sobre el HTML que trae el puente (DOMParser), y
//   · dentro del navegador de la nube, sobre la página ya armada por su JavaScript (el worker lo inyecta).
// Nada aquí depende de dominios, clases CSS, IDs, nombres de sitios ni nombres de servidores. Se mide:
// estructura del DOM, repetición, relaciones entre elementos, posición, navegación y atributos.
// Módulos: CategoryDetector · ContentDetector · PaginationDetector · DetailPageAnalyzer/SourceDetector ·
//          PlayerDetector (estado del reproductor dentro del navegador).
(function (root) {
  "use strict";
  if (root.X4 && root.X4.v >= 1) return; // ya inyectado

  // ---------------------------------------------------------------- utilidades
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);
  const abs = (h, base) => {
    try {
      const s = String(h || "").replace(/&amp;/g, "&").trim();
      if (!s || s === "#" || /^(javascript|mailto|tel|data|blob|about|whatsapp|sms):/i.test(s)) return "";
      const u = new URL(s, base); u.hash = "";
      return /^https?:$/.test(u.protocol) ? u.href : "";
    } catch { return ""; }
  };
  // texto visible de un elemento (sin scripts ni estilos), con espacios normalizados
  function text(el, max = 600) {
    if (!el) return "";
    let out = "";
    const walk = (n) => {
      if (out.length > max) return;
      if (n.nodeType === 3) { out += n.nodeValue + " "; return; }
      if (n.nodeType !== 1 || SKIP_TAGS.has(n.tagName.toUpperCase())) return;
      for (const c of n.childNodes) walk(c);
    };
    walk(el);
    return out.replace(/\s+/g, " ").trim().slice(0, max);
  }
  // dominio registrable aproximado: sitio.com · sitio.com.co · sitio.co.uk
  const regDomain = (host) => {
    const p = String(host || "").toLowerCase().replace(/^www\d?\./, "").split(".").filter(Boolean);
    if (p.length <= 2) return p.join(".");
    const tld = p[p.length - 1], sl = p[p.length - 2];
    return tld.length === 2 && /^(co|com|net|org|gob|gov|edu|ac|nom|mil|info|web|tv|ltd|plc|or|ne|go)$/.test(sl) ? p.slice(-3).join(".") : p.slice(-2).join(".");
  };
  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
  const sameSite = (a, b) => { const x = hostOf(a), y = hostOf(b); return !!x && !!y && regDomain(x) === regDomain(y); };
  const segsOf = (u) => { try { return decodeURIComponent(new URL(u).pathname).split("/").filter(Boolean); } catch { return []; } };
  const tagOf = (el) => (el && el.tagName ? el.tagName.toUpperCase() : "");
  const attr = (el, k) => (el && el.getAttribute ? el.getAttribute(k) || "" : "");
  const dataAttrs = (el) => {
    const o = {};
    if (el && el.attributes) for (const a of el.attributes) if (/^data-/i.test(a.name)) o[a.name.toLowerCase()] = a.value;
    return o;
  };
  const closest = (el, pred, max = 30) => { for (let n = el, i = 0; n && n.nodeType === 1 && i < max; n = n.parentElement, i++) if (pred(n)) return n; return null; };
  const docOrder = (a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1);
  // ¿está dentro de la navegación del sitio? (por estructura y roles, no por nombres de clases)
  const NAV_TAGS = new Set(["NAV", "HEADER", "MENU"]);
  const inNav = (el) => !!closest(el, (n) => NAV_TAGS.has(tagOf(n)) || /^(navigation|menu|menubar|banner)$/i.test(attr(n, "role")));
  const inFooter = (el) => !!closest(el, (n) => tagOf(n) === "FOOTER" || /^contentinfo$/i.test(attr(n, "role")));
  const inAside = (el) => !!closest(el, (n) => tagOf(n) === "ASIDE" || /^complementary$/i.test(attr(n, "role")));
  // un link "de servicio" (iniciar sesión, contacto, legales…): señal débil, nunca la única regla
  const UTILITY = /(^|[\/?=&_-])(login|logout|signin|sign-in|signup|register|registro|registrarse|account|cuenta|perfil|profile|contact|contacto|privacy|privacidad|politica|cookies?|dmca|legal|terminos|terms|faq|ayuda|help|cart|carrito|checkout|feed|rss|wp-admin|wp-login|author|autor|tag|tags|share|compartir|sitemap|donar|donate|premium|vip|app|apk|telegram|discord)([\/?=&_.-]|$)/i;
  const YEAR = /\b(19[2-9]\d|20[0-4]\d)\b/;
  // última parte de la dirección "con pinta de contenido": varias palabras con guiones o un número largo de ficha
  const contentSlug = (u) => {
    const s = segsOf(u), last = s[s.length - 1] || "";
    return (last.split(/[-_]+/).filter(Boolean).length >= 4) || /\d{4,}/.test(last) || /-\d{2,}$/.test(last);
  };
  // imagen de una tarjeta: <img>/<picture> (src, data-src, srcset…) o fondo CSS
  const IMG_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-lazy", "data-srcset", "data-lazy-srcset", "srcset", "src", "data-bg", "data-background", "data-image", "data-poster", "poster"];
  // de un srcset («a.jpg 150w, b.jpg 600w, c.jpg 1200w» o «1x, 2x») se toma la de mayor tamaño
  function bigOfSrcset(v) {
    let best = "", bw = -1;
    for (const part of String(v || "").split(/,\s+(?=\S)/)) {
      const [u, d = ""] = part.trim().split(/\s+/); if (!u) continue;
      const n = parseFloat(d) || 1, w = /w$/i.test(d) ? n : n * 1000;
      if (w > bw) { bw = w; best = u; }
    }
    return best;
  }
  // con srcset, la grande; si no, la de siempre
  const IMG_SET = ["data-srcset", "data-lazy-srcset", "srcset"];
  function imageOf(el, base) {
    if (!el) return "";
    const imgs = [];
    if (/^(IMG|SOURCE)$/.test(tagOf(el))) imgs.push(el);
    if (el.querySelectorAll) imgs.push(...el.querySelectorAll("img, picture source, [data-src], [data-bg], [data-background], [data-image], [style*='background']"));
    for (const im of imgs) {
      for (const k of IMG_SET) { const v = bigOfSrcset(attr(im, k).trim()); if (v && !/^data:/.test(v)) { const u = abs(v, base); if (u) return u; } }
      for (const k of IMG_ATTRS) {
        let v = attr(im, k).trim(); if (!v) continue;
        if (/srcset/.test(k)) v = bigOfSrcset(v); // la imagen MÁS GRANDE del srcset (antes se tomaba la primera = la más pequeña)
        if (/^data:/.test(v) || /(blank|placeholder|loading|spinner|lazy|transparent|pixel)\.(png|gif|svg|jpe?g|webp)/i.test(v)) continue;
        const u = abs(v, base); if (u) return u;
      }
      const st = attr(im, "style").match(/background(?:-image)?\s*:\s*url\(\s*["']?([^"')]+)/i);
      if (st) { const u = abs(st[1], base); if (u) return u; }
    }
    return "";
  }
  const hasImage = (el) => !!(el && el.querySelector && el.querySelector("img, picture, [data-src], [data-bg], [data-background], [style*='background']"));
  // URL escrita en un atributo: directa, //protocolo-relativa, relativa con ruta, o en base64
  function urlIn(v, base) {
    let s = String(v || "").replace(/&amp;/g, "&").trim();
    if (!s) return "";
    if (/^(https?:)?\/\//i.test(s) || (s.startsWith("/") && s.length > 1 && !s.startsWith("//") && /\//.test(s.slice(1)))) return abs(s, base);
    if (/^[A-Za-z0-9+/=_-]{16,}$/.test(s)) {
      try {
        const d = (root.atob || ((x) => Buffer.from(x, "base64").toString("binary")))(s.replace(/-/g, "+").replace(/_/g, "/"));
        if (/^https?:\/\//i.test(d)) return abs(d, base);
      } catch {}
    }
    // iframe escrito como texto dentro del atributo
    const m = s.match(/<iframe[^>]+src=["']([^"']+)/i); if (m) return abs(m[1], base);
    return "";
  }
  const baseOf = (doc, url) => { const b = doc.querySelector && doc.querySelector("base[href]"); return b ? abs(attr(b, "href"), url) || url : url; };

  // ---------------------------------------------------------------- links "navegables" (a, y botones con dirección)
  function linksOf(doc, base) {
    const out = [];
    for (const a of doc.querySelectorAll("a[href]")) { const u = abs(attr(a, "href"), base); if (u) out.push({ el: a, url: u }); }
    // botones que abren categorías por JavaScript: data-href / data-url / onclick="location='…'"
    for (const b of doc.querySelectorAll("[data-href], [data-url], [data-link], [onclick]")) {
      if (tagOf(b) === "A") continue;
      let v = attr(b, "data-href") || attr(b, "data-url") || attr(b, "data-link");
      if (!v) { const m = attr(b, "onclick").match(/(?:location(?:\.href)?|window\.open)\s*(?:=|\()\s*["']([^"']+)["']/i); if (m) v = m[1]; }
      const u = v ? abs(v, base) : ""; if (u) out.push({ el: b, url: u, js: true });
    }
    return out;
  }
  // el contenedor de una lista de links: el ancestro más cercano que reúne 3 o más links
  function listContainer(el) {
    let n = el.parentElement;
    for (let i = 0; n && i < 7; n = n.parentElement, i++) {
      const t = tagOf(n);
      if (t === "BODY" || t === "HTML") break;
      const k = n.querySelectorAll("a[href], [data-href], [data-url]").length;
      if (k >= 3) return k <= 400 ? n : el.parentElement;
    }
    return el.parentElement || el;
  }
  // nombre de un grupo de menú: el link "padre" de un submenú, o el título que lo precede
  function groupLabel(cont) {
    const li = closest(cont.parentElement, (n) => tagOf(n) === "LI", 3);
    if (li) { const a = [...li.children].find((c) => tagOf(c) === "A" || (c.querySelector && c.querySelector(":scope > a"))); const t = text(a, 60); if (t && t.length <= 30) return t; }
    for (let p = cont, i = 0; p && i < 3; p = p.parentElement, i++) {
      let s = p.previousElementSibling;
      for (let j = 0; s && j < 2; s = s.previousElementSibling, j++) if (/^H[1-6]$/.test(tagOf(s)) || (s.querySelector && s.querySelector("h1,h2,h3,h4,h5,h6") && text(s, 80).length <= 40)) { const t = text(s, 60); if (t && t.length <= 40) return t; }
      const h = p.querySelector && p.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6");
      if (h) { const t = text(h, 60); if (t && t.length <= 40) return t; }
    }
    return "";
  }

  // =========================================================================================================
  // CategoryDetector — puntuación por estructura (menú, hermanos, repetición, profundidad, relación)
  // =========================================================================================================
  function categories(doc, url, opts = {}) {
    const base = baseOf(doc, url), home = (() => { try { return new URL(base).origin + "/"; } catch { return ""; } })();
    const contentUrls = opts.contentUrls || new Set();
    const all = linksOf(doc, base);
    const count = new Map(); for (const l of all) count.set(l.url, (count.get(l.url) || 0) + 1);
    const cand = [];
    for (const l of all) {
      if (!sameSite(l.url, base) || l.url === home || contentUrls.has(l.url)) continue;
      const t = text(l.el, 120) || attr(l.el, "title") || attr(l.el, "aria-label");
      const words = t.split(" ").filter(Boolean).length;
      if (!t || t.length < 2 || t.length > 40 || words > 6) continue;
      if (/^\d{1,4}$/.test(t) && !YEAR.test(t)) continue; // números de página
      if (hasImage(l.el)) continue; // con carátula = un contenido, no una categoría
      cand.push({ ...l, t, words });
    }
    // grupos por contenedor
    const groups = new Map();
    for (const c of cand) { const k = listContainer(c.el); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
    const out = [], seen = new Set();
    const ordered = [...groups.entries()].sort((a, b) => docOrder(a[0], b[0]));
    for (const [cont, list] of ordered) {
      const n = list.length;
      const firsts = new Map(); for (const c of list) { const s = segsOf(c.url); const f = s.length > 1 ? s[0] : (s.length === 1 ? "·" : ""); firsts.set(f, (firsts.get(f) || 0) + 1); }
      const topShare = Math.max(...firsts.values()) / n;
      const contentRatio = list.filter((c) => contentSlug(c.url)).length / n;
      const nav = inNav(cont), foot = inFooter(cont), side = inAside(cont);
      let g = 0;
      if (nav) g += 3; if (side) g += 1.5; if (foot) g -= 0.5;
      if (n >= 4) g += 1.5; if (n >= 8) g += 1;
      if (n >= 3 && topShare >= 0.6) g += 2;
      if (contentRatio > 0.5) g -= 3;
      // listas dentro de un menú desplegable (ul dentro de li): típico de géneros / años
      if (closest(cont, (x) => tagOf(x) === "LI", 4) && (tagOf(cont) === "UL" || tagOf(cont) === "OL")) g += 1;
      const label = groupLabel(cont);
      for (const c of list) {
        const s = segsOf(c.url);
        let sc = g;
        if (s.length >= 1 && s.length <= 2) sc += 1; else if (s.length >= 4) sc -= 2;
        let q = null; try { q = new URL(c.url).searchParams; } catch {}
        if (q && [...q.keys()].length && [...q.values()].every((v) => v.length <= 30)) sc += 0.5;
        if (contentSlug(c.url)) sc -= 2;
        if (c.words <= 3) sc += 0.5;
        if (UTILITY.test(new URL(c.url).pathname + new URL(c.url).search) || UTILITY.test(" " + c.t.toLowerCase().replace(/\s+/g, "-") + " ")) sc -= 6;
        if ((count.get(c.url) || 0) > 1) sc += 0.5; // aparece en más de un lugar del sitio (menú + pie)
        if (c.js) sc += 0.5;
        if (sc < 3 || seen.has(c.url)) continue;
        seen.add(c.url);
        out.push({ url: c.url, name: c.t, group: label || (s.length > 1 && topShare >= 0.6 ? s[0] : ""), score: +sc.toFixed(1) });
      }
    }
    return out;
  }

  // =========================================================================================================
  // ContentDetector — tarjetas repetidas (imagen · título · año · enlace) por similitud estructural
  // =========================================================================================================
  // forma de un elemento: su etiqueta y la de sus hijos/nietos (sin clases ni ids)
  function shape(el) {
    const kids = [...el.children].filter((c) => !SKIP_TAGS.has(tagOf(c)));
    const k = kids.map((c) => tagOf(c) + (c.children.length ? "(" + [...c.children].map(tagOf).join(",") + ")" : "")).join(",");
    return tagOf(el) + "[" + k.slice(0, 200) + "]";
  }
  // "esqueleto" más laxo: qué trae (link, imagen, título, año) — tarjetas iguales con hijos levemente distintos
  function feature(el) {
    return [tagOf(el), el.querySelector("a[href]") ? "a" : "", hasImage(el) ? "img" : "", el.querySelector("h1,h2,h3,h4,h5,h6") ? "h" : ""].join("|");
  }
  function cardInfo(el, base, skip) {
    const links = [...el.querySelectorAll("a[href]")].concat(tagOf(el) === "A" ? [el] : []).map((a) => ({ a, u: abs(attr(a, "href"), base) }))
      .filter((x) => x.u && !skip.has(x.u) && !UTILITY.test(new URL(x.u).pathname));
    if (!links.length) return null;
    const distinct = [...new Set(links.map((x) => x.u))];
    // el link principal: el que envuelve la imagen o el título; si no, el más repetido
    const score = (x) => (hasImage(x.a) ? 3 : 0) + (x.a.querySelector("h1,h2,h3,h4,h5,h6") || closest(x.a, (n) => /^H[1-6]$/.test(tagOf(n)), 3) ? 2 : 0) + links.filter((y) => y.u === x.u).length;
    const main = links.slice().sort((p, q) => score(q) - score(p))[0];
    const h = el.querySelector("h1,h2,h3,h4,h5,h6");
    const im = el.querySelector("img");
    const name = (h && text(h, 160)) || attr(main.a, "title") || (im && attr(im, "alt")) || links.map((x) => text(x.a, 160)).sort((p, q) => q.length - p.length)[0] || "";
    const full = text(el, 400);
    const year = (full.replace(name, " ").match(YEAR) || full.match(YEAR) || [])[1] || "";
    const meta = [...new Set([...el.querySelectorAll("span, small, em, b, i, strong, time, li, p, div")]
      .filter((n) => !n.children.length).map((n) => text(n, 40)).filter((t) => t && t.length <= 20 && t !== name && t !== year && !/^\d+$/.test(t)))].slice(0, 4);
    const nm = clean(name).replace(new RegExp("\\s*[(\\[]\\s*" + (year || "\\d{4}") + "\\s*[)\\]]\\s*$"), "").trim() || clean(name);
    return { url: main.u, name: nm, poster: imageOf(el, base), year, meta, distinct: distinct.length, img: hasImage(el), head: !!h, len: full.length };
  }
  const clean = (t) => String(t || "").replace(/\s+/g, " ").replace(/^(ver|watch|mirar)\s+/i, "").replace(/\s+(online|gratis|free|hd)$/i, "").trim();
  function contents(doc, url, opts = {}) {
    const base = baseOf(doc, url);
    const skip = new Set([base, ...(opts.skip || [])]);
    try { skip.add(new URL(base).origin + "/"); } catch {}
    const groups = [];
    for (const p of doc.querySelectorAll("body *")) {
      if (SKIP_TAGS.has(tagOf(p)) || p.children.length < 2) continue;
      // hijos agrupados por forma exacta y, si no alcanza, por esqueleto
      for (const keyFn of [shape, feature]) {
        const by = new Map();
        for (const c of p.children) { if (SKIP_TAGS.has(tagOf(c))) continue; const k = keyFn(c); if (!by.has(k)) by.set(k, []); by.get(k).push(c); }
        let best = null; for (const v of by.values()) if (!best || v.length > best.length) best = v;
        if (best && best.length >= 2) { groups.push({ parent: p, els: best }); break; }
      }
    }
    const accepted = [];
    for (const g of groups) {
      const infos = g.els.map((e) => ({ e, i: cardInfo(e, base, skip) })).filter((x) => x.i && x.i.name && x.i.distinct <= 4 && x.i.len <= 600);
      const n = infos.length; if (n < 2) continue;
      const urls = new Set(infos.map((x) => x.i.url));
      if (urls.size < n * 0.8) continue;           // cada tarjeta lleva a un contenido distinto
      const imgF = infos.filter((x) => x.i.img).length / n, headF = infos.filter((x) => x.i.head).length / n;
      const same = infos.filter((x) => sameSite(x.i.url, base)).length / n;
      const depths = new Map(); for (const x of infos) { const d = segsOf(x.i.url).length; depths.set(d, (depths.get(d) || 0) + 1); }
      const depthF = Math.max(...depths.values()) / n;
      let sc = Math.min(n, 12) * 0.5 + imgF * 3 + headF * 1.5 + depthF * 1.5 + same * 1.5;
      if (inNav(g.parent)) sc -= 4;
      if (inFooter(g.parent)) sc -= 2;
      if (imgF < 0.5 && headF < 0.5) sc -= 3; // una lista de links sin carátula ni título no es una grilla de contenidos
      if (n === 2 && imgF < 1) continue;
      if (sc < 5) continue;
      accepted.push({ g, infos, sc });
    }
    // tarjetas dentro de tarjetas ya aceptadas no cuentan (se procesan las más grandes primero)
    accepted.sort((a, b) => b.infos.length - a.infos.length);
    const taken = [], out = [], byUrl = new Map();
    for (const a of accepted) {
      if (taken.some((t) => a.infos.some((x) => t !== x.e && t.contains(x.e)))) continue;
      for (const x of a.infos) taken.push(x.e);
    }
    const cards = accepted.flatMap((a) => a.infos).filter((x) => taken.includes(x.e)).sort((p, q) => docOrder(p.e, q.e));
    for (const { i } of cards) {
      const had = byUrl.get(i.url);
      if (had) { had.poster ||= i.poster; had.year ||= i.year; continue; }
      const t = { url: i.url, name: i.name, poster: i.poster, year: i.year, meta: i.meta };
      byUrl.set(i.url, t); out.push(t);
    }
    return out;
  }

  // =========================================================================================================
  // PaginationDetector — por los links reales de navegación (números, flechas, rel=next/prev)
  // =========================================================================================================
  const ARROW_NEXT = /^(›|»|>|>>|→|⟩|next|siguiente|sig\.?|próxima|proxima|suivant|weiter|avanti|próximo|proximo|more|más|mas)\b/i;
  const ARROW_PREV = /^(‹|«|<|<<|←|⟨|prev|previous|anterior|ant\.?|précédent|zurück|indietro)\b/i;
  function pagination(doc, url) {
    const base = baseOf(doc, url);
    const relN = doc.querySelector("link[rel~='next'][href], a[rel~='next'][href]"), relP = doc.querySelector("link[rel~='prev'][href], a[rel~='prev'][href], link[rel~='previous'][href]");
    let next = relN ? abs(attr(relN, "href"), base) : "", prev = relP ? abs(attr(relP, "href"), base) : "";
    // links con número (o flecha) agrupados por contenedor
    const groups = new Map();
    for (const l of linksOf(doc, base)) {
      if (!sameSite(l.url, base)) continue;
      const t = (text(l.el, 20) || attr(l.el, "aria-label") || attr(l.el, "title")).trim();
      const num = /^\d{1,5}$/.test(t) ? +t : null;
      const kind = num != null ? "n" : ARROW_NEXT.test(t) ? "next" : ARROW_PREV.test(t) ? "prev" : "";
      if (!kind) continue;
      const k = l.el.parentElement && tagOf(l.el.parentElement) === "LI" ? l.el.parentElement.parentElement : l.el.parentElement;
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ ...l, t, num, kind });
    }
    let best = null;
    for (const [k, v] of groups) {
      const nums = v.filter((x) => x.kind === "n");
      const sc = nums.length * 2 + v.filter((x) => x.kind !== "n").length - (inNav(k) ? 3 : 0);
      if ((nums.length >= 2 || (nums.length >= 1 && v.length >= 2)) && (!best || sc > best.sc)) best = { k, v, sc };
    }
    const res = { current: 1, next, prev, pages: [], template: "" };
    if (best) {
      const nums = best.v.filter((x) => x.kind === "n");
      // plantilla: la parte de la dirección que cambia con el número de página
      const tplCount = new Map();
      for (const x of nums) {
        if (x.num < 2) continue;
        const re = new RegExp(`([\\/=_-])${x.num}(?=[\\/?&#._-]|$)`, "g");
        const ms = [...x.url.matchAll(re)]; if (!ms.length) continue;
        const m = ms[ms.length - 1];
        const tpl = x.url.slice(0, m.index) + m[1] + "{n}" + x.url.slice(m.index + m[0].length);
        tplCount.set(tpl, (tplCount.get(tpl) || 0) + 1);
      }
      res.template = [...tplCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
      // página actual: la que se marca (aria-current) o el número sin link dentro del mismo bloque
      const cur = best.k.querySelector("[aria-current]") || [...best.k.querySelectorAll("span, strong, b, em, li, a")].find((n) => /^\d{1,5}$/.test(text(n, 8)) && !n.children.length && (tagOf(n) !== "A" || !attr(n, "href") || abs(attr(n, "href"), base) === base));
      if (cur && /^\d{1,5}$/.test(text(cur, 8))) res.current = +text(cur, 8);
      else if (res.template) { const m = base.match(new RegExp("^" + res.template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\{n\\}", "(\\d+)") + "$")); if (m) res.current = +m[1]; }
      const pages = new Map();
      for (const x of nums) if (!pages.has(x.num)) pages.set(x.num, x.url);
      if (!pages.has(res.current)) pages.set(res.current, base);
      res.pages = [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([n, u]) => ({ n, url: u }));
      res.last = Math.max(...res.pages.map((p) => p.n));
      const at = (n) => pages.get(n) || (res.template ? res.template.replace("{n}", n) : "");
      if (!next) next = best.v.find((x) => x.kind === "next")?.url || (res.current < res.last ? at(res.current + 1) : "");
      if (!prev) prev = best.v.find((x) => x.kind === "prev")?.url || (res.current > 1 ? at(res.current - 1) : "");
    } else {
      // sin números: solo flechas sueltas
      for (const l of linksOf(doc, base)) {
        if (!sameSite(l.url, base) || l.url === base) continue;
        const t = (text(l.el, 20) || attr(l.el, "aria-label") || attr(l.el, "title")).trim();
        if (!next && ARROW_NEXT.test(t) && !inNav(l.el)) next = l.url;
        if (!prev && ARROW_PREV.test(t) && !inNav(l.el)) prev = l.url;
      }
    }
    res.next = next && next !== base ? next : ""; res.prev = prev && prev !== base ? prev : "";
    // botón "cargar más" sin dirección (lo resuelve el navegador de la nube)
    res.loadMore = !res.next && !![...doc.querySelectorAll("button, a, div, span")].find((n) => !n.children.length && /^(cargar|ver|mostrar|load|show)\s+(más|mas|more)\b/i.test(text(n, 30)));
    return res;
  }

  // =========================================================================================================
  // DetailPageAnalyzer + SourceDetector — opciones de reproducción en el orden del DOM, con su nombre del DOM
  // =========================================================================================================
  const PLAYERISH = "iframe, video, embed, object";
  const EMBEDISH = /\/(embed|e|v|player|play|watch|video|stream|reproductor|iframe)\b/i;
  // avances/tráileres: se marcan (no son la obra), nunca se descartan ni se cambian de lugar
  const TRAILER = /(tr[aá]iler|teaser|avance|preview)/i;
  const SERVERISH = /(server|servidor|option|opcion|mirror|player|embed|onlinelink|online-link|link-?online|reproductor|enlace)/i;
  const SERVER_NAMES = /\b(filemoon|streamwish|swdyu|voe|dood(stream)?|streamtape|mixdrop|vidhide|lulu(stream)?|upstream|ok\.?ru|uqload|netu|hqq|waaw|vidguard|streamlare|byse|vidmoly|vidoza|powvideo|mega|fembed|vidsrc|streamsb|filelions|earnvids|voesx|bigwarp)\b/i;
  // elementos "accionables": se tocan para cambiar de fuente
  function actionable(el) {
    const t = tagOf(el);
    if (SKIP_TAGS.has(t) || /^(HTML|BODY|HEAD|IFRAME|VIDEO|IMG|INPUT|TEXTAREA|SELECT|FORM|SOURCE|SVG|PATH|USE|LINK|META)$/.test(t)) return false;
    if (attr(el, "onclick") || /^(tab|button|option|menuitem|radio)$/i.test(attr(el, "role"))) return true;
    if (t === "BUTTON") return true;
    if (t === "OPTION") return /^(https?:)?\/\/|^[A-Za-z0-9+/=_-]{16,}$/.test(attr(el, "value").trim());
    if (t === "A") {
      const h = attr(el, "href").trim();
      if (!h || h === "#" || /^javascript:/i.test(h) || Object.keys(dataAttrs(el)).length > 0) return true;
      // enlace a un servidor de video (…/e/…, /embed/…) o con nombre/clase de servidor (Filemoon, «onlinelink», «server»…):
      // muchos sitios lo abren en su reproductor con JavaScript al tocarlo, aunque tenga un href normal
      return /^(https?:)?\/\//i.test(h) && (EMBEDISH.test(h.replace(/^(https?:)?\/\/[^/]+/i, "")) || SERVERISH.test(attr(el, "class") + " " + attr(el.parentElement, "class")) || SERVER_NAMES.test(text(el, 60)));
    }
    return Object.keys(dataAttrs(el)).length > 0;
  }
  const attrSig = (el) => tagOf(el) + "{" + Object.keys(dataAttrs(el)).sort().join(",") + (attr(el, "onclick") ? ",onclick" : "") + (attr(el, "role") ? ",role=" + attr(el, "role") : "") + "}";
  function nameOf(el) {
    let t = text(el, 80);
    if (!t) t = attr(el, "title") || attr(el, "aria-label") || attr(el, "data-name") || attr(el, "data-title") || attr(el, "data-label");
    if (!t) { const im = el.querySelector && el.querySelector("img[alt]"); if (im) t = attr(im, "alt"); }
    return t.replace(/\s+/g, " ").trim().slice(0, 60);
  }
  // un elemento cuyos atributos traen la dirección de la fuente
  function urlOfOption(el, base) {
    const d = dataAttrs(el);
    for (const v of Object.values(d)) { const u = urlIn(v, base); if (u) return u; }
    const h = tagOf(el) === "A" ? attr(el, "href") : "";
    if (h && !/^(#|javascript:)/i.test(h.trim())) { const u = abs(h, base); if (u) return u; }
    const oc = attr(el, "onclick").match(/["'](https?:\/\/[^"']+|\/\/[^"']+)["']/i); if (oc) return abs(oc[1], base);
    for (const k of ["value", "src"]) { const u = urlIn(attr(el, k), base); if (u) return u; }
    return "";
  }
  // cómo es el elemento (para el informe): etiqueta, sus data-* y su texto
  function describe(el) {
    if (!el) return "";
    const d = Object.entries(dataAttrs(el)).slice(0, 4).map(([k, v]) => `[${k}="${String(v).slice(0, 40)}"]`).join("");
    const r = attr(el, "role") ? `[role="${attr(el, "role")}"]` : "", oc = attr(el, "onclick") ? "[onclick]" : "";
    const t = text(el, 40);
    return tagOf(el).toLowerCase() + r + d + oc + (t ? ` «${t}»` : "");
  }
  // la acción que activa la fuente, tal como está en la página
  function actionOf(el, url, base) {
    const t = tagOf(el);
    if (t === "OPTION") return "select";
    if (url) {
      if (Object.values(dataAttrs(el)).some((v) => urlIn(v, base) === url)) return "data-attribute";
      if (t === "A" && abs(attr(el, "href"), base) === url) return attr(el, "target") === "_blank" ? "href-new-tab" : "href";
      if (attr(el, "onclick")) return "onclick";
      return "attribute";
    }
    if (attr(el, "onclick")) return "onclick-js";
    if (/^tab$/i.test(attr(el, "role"))) return "tab";
    if (Object.keys(dataAttrs(el)).length) return "click-data";
    return "click";
  }
  function sources(doc, url, opts = {}) {
    const base = baseOf(doc, url);
    const body = doc.body || doc.documentElement;
    const players = [...doc.querySelectorAll(PLAYERISH)];
    // botones que solo navegan a otra página del sitio (menús hechos con data-href/onclick=location) no son fuentes
    const navBtn = (e) => { const v = attr(e, "data-href") || attr(e, "data-url") || attr(e, "data-link") || (attr(e, "onclick").match(/location(?:\.href)?\s*=\s*["']([^"']+)/i) || [])[1] || "";
      const u = v ? abs(v, base) : ""; return !!u && sameSite(u, base) && !EMBEDISH.test(u); };
    const cands = [...body.querySelectorAll("*")].filter(actionable).filter((e) => !inNav(e) && !inFooter(e) && !navBtn(e));
    // grupos de hermanos parecidos: mismo padre + misma firma de atributos
    const groups = new Map();
    for (const e of cands) {
      const key = e.parentElement;
      const sig = attrSig(e);
      if (!groups.has(key)) groups.set(key, new Map());
      const m = groups.get(key); if (!m.has(sig)) m.set(sig, []); m.get(sig).push(e);
    }
    const scored = [];
    for (const [parent, bySig] of groups) for (const [, els] of bySig) {
      const n = els.length;
      const urls = els.map((e) => urlOfOption(e, base));
      const withUrl = urls.filter(Boolean).length;
      const names = els.map(nameOf);
      let sc = 0;
      if (withUrl) sc += 4 * (withUrl / n);
      const idish = els.filter((e) => Object.values(dataAttrs(e)).some((v) => /^[\w.:-]{1,40}$/.test(v))).length / n;
      sc += 2 * idish;
      if (els.some((e) => attr(e, "onclick"))) sc += 2;
      if (els.some((e) => /^tab$/i.test(attr(e, "role")))) sc += 1.5;
      if (n >= 2 && n <= 40) sc += 1.5; else if (n > 40) sc -= 3;
      // cerca del reproductor (comparten un ancestro cercano con un iframe/video o un recuadro vacío)
      let near = false;
      for (let p = parent, i = 0; p && i < 4 && !near; p = p.parentElement, i++) near = !!(p.querySelector && p.querySelector(PLAYERISH)) || [...(p.children || [])].some((c) => c !== parent && !c.contains(parent) && !text(c, 5) && !c.querySelector("img,a") && c.children.length <= 2);
      if (near) sc += 2;
      if (names.every((t) => t && t.length <= 40)) sc += 1;
      if (names.filter((t) => !t).length > n / 2) sc -= 1;
      // fichas de otros contenidos (carátula + título) o links a otras páginas del sitio: no son fuentes
      if (els.filter((e) => hasImage(e) && e.querySelector("h1,h2,h3,h4,h5,h6")).length > n / 2) sc -= 4;
      if (urls.filter((u) => u && sameSite(u, base) && contentSlug(u) && !EMBEDISH.test(u)).length > n / 2) sc -= 3;
      if (els.some((e) => UTILITY.test(" " + nameOf(e).toLowerCase() + " ")) && !withUrl) sc -= 2;
      // links de compartir y redes: todos a dominios distintos sin nada que reproducir y sin datos
      if (sc >= 4) scored.push({ parent, els, urls, names, sc });
    }
    // un grupo que contiene a otro (pestañas de idioma que encierran servidores): se queda el de adentro
    const keep = scored.filter((g) => !scored.some((h) => h !== g && g.els.some((e) => h.els.some((x) => e !== x && e.contains(x)))));
    const flat = [];
    for (const g of keep) g.els.forEach((e, i) => flat.push({ el: e, url: g.urls[i], name: g.names[i], sc: g.sc }));
    flat.sort((a, b) => docOrder(a.el, b.el));
    const out = [], seenU = new Set();
    for (const f of flat) {
      if (f.url && seenU.has(f.url)) continue;
      if (f.url) seenU.add(f.url);
      out.push({ name: f.name, url: f.url || "", kind: f.url ? "url" : "click", data: dataAttrs(f.el), el: f.el, score: +f.sc.toFixed(1), element: describe(f.el), action: actionOf(f.el, f.url, base), href: f.url || "" });
    }
    // reproductores que ya están en la página (iframe / video) y no corresponden a ninguna opción
    players.forEach((p, i) => {
      let u = "";
      if (tagOf(p) === "VIDEO") u = abs(attr(p, "src"), base) || abs(attr(p.querySelector("source[src]"), "src"), base);
      else u = abs(attr(p, "src") || attr(p, "data-src") || attr(p, "data-lazy-src") || attr(p, "data") || attr(p, "data-litespeed-src"), base);
      if (!u || seenU.has(u) || /^about:/.test(u)) return;
      const w = +attr(p, "width"), h = +attr(p, "height");
      if ((w && w < 120) || (h && h < 80)) return; // píxeles y botones sociales, no reproductores
      seenU.add(u);
      out.push({ name: tagOf(p) === "VIDEO" ? "Video de la página" : `Reproductor ${i + 1}`, url: u, kind: tagOf(p) === "VIDEO" ? "video" : "iframe", data: {}, el: p, score: 3, element: describe(p), action: tagOf(p) === "VIDEO" ? "video" : "iframe", href: u });
    });
    // iframes escritos como texto (aparecen al tocar la opción): <iframe ...> en atributos o en el HTML escapado
    if (opts.html) for (const m of String(opts.html).matchAll(/&lt;iframe[^&]*?src=(?:&quot;|["'])([^"'&]+)/gi)) { const u = abs(m[1], base); if (u && !seenU.has(u)) { seenU.add(u); out.push({ name: `Reproductor ${out.length + 1}`, url: u, kind: "iframe", data: {}, el: null, score: 3, element: "iframe escrito como texto", action: "iframe-text", href: u }); } }
    // el orden es EXACTAMENTE el de la página; los avances solo se marcan
    for (const o of out) if (TRAILER.test(o.name + " " + Object.values(o.data || {}).join(" "))) o.trailer = true;
    // nombres repetidos ("Ver", "Play") → se numeran; vacíos → "Opción N"
    const cnt = new Map(); out.forEach((o) => cnt.set(o.name, (cnt.get(o.name) || 0) + 1));
    const idx = new Map();
    out.forEach((o, i) => {
      if (!o.name) o.name = `Opción ${i + 1}`;
      else if (cnt.get(o.name) > 1) { idx.set(o.name, (idx.get(o.name) || 0) + 1); o.name = `${o.name} ${idx.get(o.name)}`; }
      o.host = o.url ? hostOf(o.url).replace(/^www\./, "") : "";
      o.i = i;
    });
    return out;
  }

  // =========================================================================================================
  // PlayerDetector — estado de los reproductores de un documento (dentro del navegador de la nube)
  // =========================================================================================================
  const ERR_TXT = /(error|not found|no encontrado|no disponible|unavailable|deleted|eliminado|removed|has been removed|file was deleted|video not found|no existe|expired|caducado|copyright|blocked|bloqueado)/i;
  function playerState(doc) {
    const vids = [...doc.querySelectorAll("video")].map((v) => ({ src: v.currentSrc || v.src || "", ready: v.readyState, t: +v.currentTime || 0, paused: v.paused, err: v.error ? v.error.code : 0, w: v.videoWidth || 0, h: v.videoHeight || 0 }));
    const frames = [...doc.querySelectorAll("iframe")].map((f) => ({ src: f.src || attr(f, "data-src") || "", w: f.clientWidth || +attr(f, "width") || 0, h: f.clientHeight || +attr(f, "height") || 0 })).filter((f) => f.src && !/^about:/.test(f.src));
    const t = text(doc.body, 3000);
    return { vids, frames, errText: (t.length < 1500 && ERR_TXT.test(t)) ? (t.match(ERR_TXT) || [""])[0] : "" };
  }
  // marca cada opción con data-x4o="i" (el navegador de la nube la toca por ese número)
  function markSources(doc, url) {
    const s = sources(doc, url, { html: doc.documentElement ? doc.documentElement.outerHTML.slice(0, 2e6) : "" });
    for (const o of s) if (o.el && o.el.setAttribute) o.el.setAttribute("data-x4o", String(o.i));
    return s.map(({ el, ...o }) => o);
  }

  // ---------------------------------------------------------------- entrada para la página (HTML → todo)
  function parse(html, url) {
    const P = root.DOMParser ? new root.DOMParser() : null; if (!P) return null;
    return P.parseFromString(String(html || ""), "text/html");
  }
  function analyzeList(html, url, opts = {}) {
    const doc = typeof html === "string" ? parse(html, url) : html; if (!doc) return { categories: [], contents: [], pagination: {} };
    const items = contents(doc, url, opts);
    return { contents: items, categories: categories(doc, url, { contentUrls: new Set(items.map((x) => x.url)) }), pagination: pagination(doc, url) };
  }
  function analyzeDetail(html, url) {
    const doc = typeof html === "string" ? parse(html, url) : html; if (!doc) return { sources: [] };
    return { sources: sources(doc, url, { html }).map(({ el, ...o }) => o) };
  }

  root.X4 = { v: 1, categories, contents, pagination, sources, markSources, playerState, analyzeList, analyzeDetail, parse, util: { abs, text, sameSite, regDomain, urlIn, imageOf, contentSlug } };
})(typeof window !== "undefined" ? window : globalThis);
