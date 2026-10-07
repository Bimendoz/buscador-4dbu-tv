// +4dBu TV · Buscador en GitHub
// Abre un Chrome con TU extensión (la carpeta «extension», copia exacta de «version 3», sin tocarle nada)
// y corre su propio buscador (runSearch). Va contando el avance a tu página para que lo veas en vivo.
import { chromium } from "playwright";
import path from "node:path";

const EXT = path.resolve(process.env.EXT_DIR || "extension");
const PAGE = (process.env.TV_URL || "").replace(/\/+$/, "");
const ID = process.env.JOB_ID || "local", T = process.env.JOB_T || "";
// la búsqueda se recoge de tu página (una sola vez): nada tuyo queda escrito en GitHub
let job = {};
if (process.env.JOB) job = JSON.parse(Buffer.from(process.env.JOB, "base64").toString("utf8") || "{}");
else if (PAGE) {
  try { const r = await fetch(`${PAGE}/gh/job?${new URLSearchParams({ id: ID, t: T })}`); if (r.ok) job = await r.json(); else { console.log("no pude recoger la búsqueda (" + r.status + ")"); process.exit(0); } }
  catch { console.log("no pude recoger la búsqueda"); process.exit(0); }
}
// en un repositorio público nada de esto se imprime: sin direcciones, nombres ni claves en los registros
console.log = () => {}; console.error = () => {};
const MAX_MIN = +(process.env.MAX_MIN || 340); // GitHub deja hasta 6 horas por búsqueda

let cancel = false;
const send = async (data) => {
  if (!PAGE) return;
  try {
    const r = await fetch(`${PAGE}/gh/avance?${new URLSearchParams({ id: ID, t: T })}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    const d = await r.json().catch(() => ({}));
    if (d.cancel) cancel = true;
  } catch {}
};

// Google Chrome (el que trae GitHub) y no el Chromium de Playwright: Chromium no trae H.264/AAC, así que casi ningún
// video de película «avanza» en él aunque el servidor lo entregue bien. Si Chrome no estuviera, se usa Chromium.
let BROWSER_NAME = "chrome";
const launchChrome = async (opts) => {
  try { return await chromium.launch({ ...opts, channel: "chrome" }); }
  catch { BROWSER_NAME = "chromium"; return chromium.launch(opts); }
};

const START = Date.now();
// RELEVO (relevo.mjs): elige la lista del video que pidió el reproductor de la fuente ganadora, pausa el Chrome y
// abre el túnel. Avisa a tu página con {type:"relay", url} (o {ok:false, why} si no se pudo).
async function relayFor(r, ctx, page, UA, emit) {
  const win = (r.results || []).find((x) => x.status === "working");
  const media = (win?.media || []).filter((m) => !/\.(ts|m4s|aac|vtt|key)(\?|#|$)|\/init[^/?#]*\.mp4(\?|#|$)/i.test(m.url) && !(m.status >= 400));
  const lists = media.filter((m) => m.type === "manifest" && /\.m3u8|mpegurl/i.test(m.url + " " + (m.ct || "")));
  const pick = lists.find((m) => /master/i.test(m.url)) || lists[0] || media.find((m) => /\.(mp4|m4v|webm)(\?|#|$)/i.test(m.url) || /^video\//i.test(m.ct || ""));
  if (!pick) { emit({ type: "relay", ok: false, why: "no vi la lista del video de esa fuente" }); return null; }
  emit({ type: "relay-start" });
  for (const f of page.frames()) await f.evaluate(() => document.querySelectorAll("video").forEach((v) => { v.pause(); })).catch(() => {});
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

// ---------- MODO «SPA» (adaptador nuevo y aparte, spa.mjs): mira una página armada con JavaScript ----------
// Solo responde la arquitectura (MULTI_SOURCE / DIRECT_PLAYER / PLAYER_PENDING) o la página ya armada. No toca los demás modos.
if (job.mode === "spa") {
  try { const { run } = await import("./spa.mjs"); await run(job, { send, launchChrome, isCancel: () => cancel, maxMs: MAX_MIN * 60e3 }); }
  catch (e) { await send({ status: "done", job: { status: "done", events: [{ type: "done", status: "browser_error", reason: "BROWSER_UNAVAILABLE", detail: String(e?.message || e).slice(0, 160) }] } }); }
  process.exit(0);
}

// ---------- MODO «TÍTULO»: probar TODAS las fuentes de un título en UNA sola sesión, en orden ----------
// Es el navegador del explorador (ya no el de Cloudflare): mismo explorar.js que usa tu página. Abre el título,
// toca cada fuente (clic real), sigue iframe / pestaña nueva / navegación, da clic en el centro del reproductor y
// solo da por buena la fuente cuyo video AVANZA (PLAYBACK_CONFIRMED). Va contando cada paso a tu página.
if (job.mode === "titulo") {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
  const AD = /(^|\.)(imasdk\.googleapis\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|adnxs(-simple)?\.com|teads\.tv|outbrain(img)?\.com|taboola\.com|pubmatic\.com|adsrvr\.org|amazon-adsystem\.com|criteo\.(com|net)|rubiconproject\.com|scorecardresearch\.com|2mdn\.net)$/i;
  const events = [];
  let chain = Promise.resolve(), lastSend = 0, finished = false;
  const flush = (status = "running") => { chain = chain.then(() => send({ status, job: { status, events } })); return chain; };
  const emit = (e) => { events.push(e); if (e.type !== "stage" || Date.now() - lastSend > 1500) { lastSend = Date.now(); flush(); } if (cancel && !finished) { finished = true; flush("cancelled").then(() => process.exit(0)); } };
  try {
    const { probarTitulo } = await import("./explorar.js");
    const code = job.code || (PAGE ? await (await fetch(PAGE + "/explorador-dom.js")).text() : "");
    const browser = await launchChrome({ headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 720 }, locale: "es-CO", ignoreHTTPSErrors: true });
    await ctx.route("**/*", (r) => { // sin publicidad ni imágenes: más rápido (igual que antes en Cloudflare)
      const t = r.request().resourceType(); let h = ""; try { h = new URL(r.request().url()).hostname; } catch {}
      return t === "image" || t === "font" || AD.test(h) ? r.abort().catch(() => {}) : r.continue().catch(() => {});
    });
    const page = await ctx.newPage();
    emit({ type: "preflight", ok: true, browser: "github-" + BROWSER_NAME });
    const r = await probarTitulo(page, { url: job.url, sources: job.sources || [], code, totalMs: job.ms || 10000, emit });
    // RELEVO: la fuente que funcionó se le pasa a tu reproductor desde ESTE computador (su link va amarrado a esta red)
    const relay = job.relay && r.status === "working" ? await relayFor(r, ctx, page, UA, emit) : null;
    emit({ type: "done", ...r, results: undefined });
    finished = true; await flush("done");
    if (relay) { // sigue encendido mientras lo ves; se apaga solo tras 30 min sin pedidos (o si lo cancelas)
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 30000));
        await flush("done");
        if (cancel || relay.idle() > 30 * 60e3 || Date.now() - START > MAX_MIN * 60e3) break;
      }
      relay.close();
    }
    await browser.close().catch(() => {});
  } catch (e) {
    emit({ type: "done", status: "browser_error", reason: "BROWSER_UNAVAILABLE", sourceTested: false, selected_source: null, detail: String(e?.message || e).slice(0, 160) });
    finished = true; await flush("done");
  }
  process.exit(0);
}

// ---------- MODO «TU FUENTE»: entra a TU sitio, usa su buscador interno con tu nombre y saca los videos ----------
// (sin límite de minutos: es el Chrome de GitHub, no el navegador de Cloudflare)
if (job.mode === "fuente") {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
  const browser = await launchChrome({ headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 720 }, locale: "es-CO", ignoreHTTPSErrors: true });
  const out = { status: "running", step: "Chrome de GitHub listo: entrando a tu fuente…", found: [], pages: [], tried: 0 };
  const seen = new Set();
  const isVid = (u) => /\.(m3u8|mp4|m4v|webm|mov|mkv)(\?|#|$)/i.test(u);
  const add = (u, ref, page, src) => {
    if (!/^https?:/i.test(u) || seen.has(u) || /\.(ts|m4s|aac|vtt|srt)(\?|#|$)/i.test(u) || /blob:/i.test(u)) return;
    if (/(doubleclick|googlesyndication|imasdk|adservice|adsystem|\/ads?\/|preroll|vast)/i.test(u)) return;
    seen.add(u); out.found.push({ url: u, referer: ref || page, page, fuente: src });
  };
  const watch = (pg, src) => {
    pg.on("request", (r) => { const u = r.url(); if (isVid(u) || r.resourceType() === "media") add(u, r.headers().referer || pg.url(), pg.url(), src); });
    pg.on("response", (r) => { if (/mpegurl/i.test(r.headers()["content-type"] || "")) add(r.url(), pg.url(), pg.url(), src); });
  };
  const norm = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const STOP = new Set(["the", "a", "an", "of", "el", "la", "los", "las", "de", "del", "y", "and", "en", "un", "una"]);
  const step = async (t) => { out.step = t; await send({ status: "running", job: out }); };
  const autoplay = async (pg) => { for (const f of pg.frames()) await f.evaluate(() => {
    for (const v of document.querySelectorAll("video")) { v.muted = true; v.play().catch(() => {}); }
    const b = document.querySelector(".vjs-big-play-button, .jw-display-icon-display, .plyr__control--overlaid, .fp-play, .play-button, button[aria-label*='play' i], button[title*='play' i], button[aria-label*='reproducir' i], [class*=captcha i] button, button[class*=gate__ i]");
    if (b && [...document.querySelectorAll("video")].every((v) => v.paused)) b.click();
  }).catch(() => {}); };
  const domVideos = async (pg, src) => { for (const f of pg.frames()) { const vs = await f.evaluate(() => [...document.querySelectorAll("video, video source, source")].map((v) => v.currentSrc || v.src).filter(Boolean)).catch(() => []); for (const v of vs) add(v, pg.url(), pg.url(), src); } };
  // abrir una página de video: darle play y anotar lo que pide el reproductor
  // los servidores del video: iframes y botones «Servidor 1, 2…» (data-src, data-video…), en CUALQUIER dominio
  const AD = /(doubleclick|googlesyndication|imasdk|adservice|adsystem|googletagmanager|google-analytics|youtube\.com|facebook\.com|twitter\.com)/i;
  const servers = async (pg) => {
    const urls = new Set();
    for (const f of pg.frames()) {
      const xs = await f.evaluate(() => [...document.querySelectorAll("iframe[src], [data-src], [data-video], [data-url], [data-embed], [data-link], [data-player], [data-server], [data-iframe], [data-file], [data-stream]")]
        .map((e) => e.tagName === "IFRAME" ? e.getAttribute("src") : (e.dataset.src || e.dataset.video || e.dataset.url || e.dataset.embed || e.dataset.link || e.dataset.player || e.dataset.server || e.dataset.iframe || e.dataset.file || e.dataset.stream))).catch(() => []);
      for (let x of xs) {
        if (!x) continue;
        if (!/^(https?:)?\/\/|^\//i.test(x) && /^[A-Za-z0-9+/=]{16,}$/.test(x)) { try { const d = Buffer.from(x, "base64").toString("utf8"); if (/^https?:\/\//i.test(d)) x = d; } catch {} }
        try { const u = new URL(x, f.url()); if (/^https?:$/.test(u.protocol) && !AD.test(u.href) && !/\.(jpe?g|png|gif|svg|webp|css|js)(\?|$)/i.test(u.pathname)) urls.add(u.href); } catch {}
      }
    }
    return [...urls];
  };
  // botones de servidor que solo cambian el reproductor al tocarlos
  const clickServers = async (pg, src) => {
    const btns = pg.locator("li, button, a, span, div").filter({ hasText: /^\s*(filemoon|streamwish|swdyu|voe|dood|streamtape|mixdrop|vidhide|lulu|upstream|okru|ok\.ru|uqload|netu|hqq|waaw|vidguard|streamlare|byse|vidmoly|vidoza|powvideo|mega|servidor|server|opci[oó]n|option|reproductor|player|mirror|enlace)\b.{0,25}$/i });
    const n = await btns.count().catch(() => 0);
    for (let i = 0; i < n && !cancel; i++) { await btns.nth(i).click({ timeout: 3000 }).catch(() => {}); await pg.waitForTimeout(2500); await autoplay(pg); await domVideos(pg, src); }
  };
  const opened = new Set();
  const openVideo = async (u, src, label, depth = 0) => {
    if (cancel || opened.has(u)) return; opened.add(u);
    await step(label);
    const p2 = await ctx.newPage(); watch(p2, src);
    let gateAt = 0; // el servidor pidió su desafío (portero): se le da tiempo a su página para resolverlo
    p2.on("request", (r) => { if (!gateAt && /\/(api\/)?[\w\/-]*(captcha|challenge|attest|pow)\b/i.test(r.url())) { gateAt = Date.now(); step(label + " · el servidor pide un desafío: espero a que lo resuelva…"); } });
    const before = out.found.length, t0 = Date.now();
    let more = [];
    try {
      await p2.goto(u, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
      while (Date.now() - t0 < (gateAt ? Math.max(16000, gateAt - t0 + 60000) : 16000) && !cancel) {
        await p2.waitForTimeout(1500); await autoplay(p2); await domVideos(p2, src);
        if (out.found.length > before && Date.now() - t0 > 6000) break;
      }
      if (out.found.length === before) await clickServers(p2, src);
      if (out.found.length === before && depth < 3) more = await servers(p2);
    } catch {}
    out.tried++; out.pages.push({ url: u, found: out.found.length - before });
    await p2.close().catch(() => {});
    // nada todavía: se abre cada servidor por separado (iframes que no arrancan dentro de la página)
    for (const [i, s] of more.entries()) { if (cancel || out.found.length > before) break; await openVideo(s, src, `${label} · servidor ${i + 1} de ${more.length}: ${new URL(s).host}`, depth + 1); }
  };
  const sameDom = (u, dom) => { try { const h = new URL(u).hostname.toLowerCase(); return !dom || h === dom || h.endsWith("." + dom); } catch { return false; } };
  try {
    // páginas sueltas (el ▶ de un resultado): solo abrir y capturar
    for (const [i, u] of (job.pages || []).entries()) await openVideo(u, job.fuenteName || "", `Abriendo la página ${i + 1} de ${job.pages.length} en el Chrome de GitHub…`);
    for (const f of job.fuentes || []) for (const q of job.names || []) {
      if (cancel) break;
      await step(`★ ${f.name}: buscando «${q}» con el buscador de tu sitio…`);
      const pg = await ctx.newPage(); watch(pg, f.name);
      try {
        if (f.tpl) await pg.goto(f.tpl.replace("{q}", encodeURIComponent(q)), { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        else { // sin dirección de búsqueda: se escribe en el buscador del sitio, como lo harías tú
          await pg.goto(f.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
          await pg.waitForTimeout(2500);
          const sel = "input[type=search], input[name=s], input[name=q], input[name*=search i], input[name*=buscar i], input[name*=query i], input[placeholder*=usca i], input[placeholder*=earch i], input[aria-label*=usca i], input[aria-label*=earch i]";
          let box = pg.locator(sel).first();
          if (!(await box.count())) { // buscador escondido tras una lupa
            const lupa = pg.locator("[class*=search i] button, button[aria-label*=search i], button[aria-label*=buscar i], a[href*=search i], [class*=search-toggle i], [class*=lupa i]").first();
            if (await lupa.count()) { await lupa.click({ timeout: 4000 }).catch(() => {}); await pg.waitForTimeout(1200); box = pg.locator(sel).first(); }
          }
          if (await box.count()) { await box.click({ timeout: 4000 }).catch(() => {}); await box.fill(q).catch(() => {}); await box.press("Enter").catch(() => {}); }
          else { out.pages.push({ url: f.url, q, err: "no encontré el buscador de tu sitio" }); }
        }
        await pg.waitForLoadState("domcontentloaded").catch(() => {});
        await pg.waitForTimeout(5000);
        await domVideos(pg, f.name);
        const links = [];
        for (const fr of pg.frames()) links.push(...await fr.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => ({ u: a.href, t: (a.innerText || "") + " " + (a.title || "") + " " + (a.querySelector("img")?.alt || "") }))).catch(() => []));
        for (const l of links) if (isVid(l.u)) add(l.u, pg.url(), pg.url(), f.name);
        const qw = norm(q).split(" ").filter((w) => w && !STOP.has(w));
        const here = pg.url().split("#")[0];
        const cand = [...new Map(links.filter((l) => /^https?:/i.test(l.u) && !isVid(l.u) && !AD.test(l.u) && l.u.split("#")[0] !== here /* cualquier servidor, no solo el de tu sitio */
            && !/\/(tag|tags|category|categoria|genero|genre|page|pagina|login|register|registro|account|cuenta|contact|contacto|privacy|feed)(\/|$)/i.test(new URL(l.u).pathname))
          .map((l) => { const txt = " " + norm(l.t + " " + decodeURIComponent(new URL(l.u).pathname)) + " "; return { ...l, hits: qw.filter((w) => txt.includes(" " + w + " ")).length }; })
          .filter((l) => l.hits).sort((a, b) => b.hits - a.hits).map((l) => [l.u.split("#")[0], l])).values()].slice(0, +job.max > 0 ? +job.max : Infinity); // 0 = todos los resultados de tu sitio
        out.pages.push({ url: pg.url(), q, results: cand.length });
        await pg.close().catch(() => {});
        for (const [i, c] of cand.entries()) await openVideo(c.u, f.name, `★ ${f.name}: «${q}» · abriendo resultado ${i + 1} de ${cand.length}: ${c.t.trim().slice(0, 60) || c.u.slice(0, 60)}`);
      } catch (e) { out.pages.push({ url: f.url, q, err: String(e?.message || e) }); await pg.close().catch(() => {}); }
    }
    out.status = cancel ? "cancelled" : "done";
    out.step = out.found.length ? `★ Tu fuente: ${out.found.length} video(s) encontrados (Chrome de GitHub).` : `★ Tu fuente: no salió video (revisé ${out.pages.length} página(s) en el Chrome de GitHub).`;
  } catch (e) { out.status = "error"; out.step = "Error en el Chrome de GitHub: " + (e?.message || e); }
  await send({ status: out.status, job: out });
  await browser.close().catch(() => {});
  console.log("listo (fuente)");
  process.exit(0);
}

await send({ status: "running", step: "Chrome abierto en GitHub: cargando tu extensión…" });
const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium", headless: process.env.HEADLESS !== "0",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required", "--mute-audio"]
});
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));
// la clave de Brave (si pusiste una en la página) va a los ajustes de la extensión, como en tu computador
if (job.braveKey) await sw.evaluate(async (k) => { const { settings = {} } = await chrome.storage.local.get("settings"); await chrome.storage.local.set({ settings: { ...settings, braveKey: k } }); }, job.braveKey);
// tu buscador, con los ajustes que elegiste en la página
await sw.evaluate((j) => {
  self.__tvJob = null; self.__tvDone = false; self.__tvCtl = { cancelled: false, tabs: new Set() };
  const ctl = self.__tvCtl;
  const opts = { ctl, onSave: (x) => { self.__tvJob = JSON.parse(JSON.stringify(x)); } };
  for (const k of ["pageUrl", "skipDirTests", "langMode", "countries", "searchCount", "portableOnly"]) if (j[k] != null && j[k] !== "") opts[k] = j[k];
  const finish = (x) => { self.__tvJob = JSON.parse(JSON.stringify(x)); self.__tvDone = true; };
  const boom = (e) => finish({ ...(self.__tvJob || {}), status: "error", step: "Error: " + (e?.message || e) });
  if (j.pageUrl || j.order !== "web") return runSearch(j.query || "", opts).then(finish, boom);

  // ORDEN «primero la web»: los resultados de la web, uno por uno y en su orden (sin saltarse ninguno);
  // después los sitios oficiales página por página. Cada página la revisa TU extensión (runSearch con esa página:
  // lee su código y la abre en Chrome para capturar el video). El directorio lo prueba tu página al final.
  (async () => {
    const query = j.query || "";
    const mode = langMode(j.langMode), countries = cleanCountries(j.countries || []);
    const sc = +(j.searchCount ?? 0), N = sc > 0 ? sc : Infinity;
    const agg = { query, status: "running", step: "Buscando en la web…", tried: 0, found: [], failed: [], pages: [], goal: Number.isFinite(N) ? N : 0, startedAt: Date.now() };
    const keys = new Set();
    const pub = (x) => { self.__tvJob = JSON.parse(JSON.stringify(x)); };
    const enough = () => ctl.cancelled || agg.tried >= N;
    const lleva = () => (Number.isFinite(N) ? `Llevo ${agg.tried} de ${N}` : `Llevo ${agg.tried} probado(s)`);
    const take = (f, extra) => {
      if (keys.has(f.key)) return null;
      if (!audioOk(f.audio || [], mode)) { agg.failed.push({ host: hostOf(f.url), why: `el audio está en ${(f.audio || []).join(", ")}, no en español` }); return null; }
      const g = { ...f };
      if (extra) { const si = sourceInfo(g.url, extra); g.tier = si.tier; g.tierWhy = si.why; }
      if (needsPlayerSession(g.url)) g.weak = true;
      return g;
    };
    const onePage = async (site, label, extra) => {
      const base = agg.tried, before = agg.found.length;
      const r = await runSearch(query, { pageUrl: site, ctl, portableOnly: opts.portableOnly, onSave: (x) => {
        pub({ ...agg, step: `${label} · ${x.step || ""}`, tried: base + (x.tried || 0), found: [...agg.found, ...(x.found || []).filter((f) => !keys.has(f.key))], failed: [...agg.failed, ...(x.failed || [])] });
      } }).catch((e) => ({ tried: 0, found: [], failed: [{ host: hostOf(site), why: String(e?.message || e) }] }));
      for (const f of r.found || []) { const g = take(f, extra); if (g) { keys.add(g.key); agg.found.push(g); } }
      agg.failed.push(...(r.failed || []));
      agg.tried = base + (r.tried || 0);
      agg.pages.push({ url: site, found: agg.found.length - before });
      pub(agg);
    };
    try {
      const walked = new Set();
      // 1) la web, en su orden
      pub({ ...agg, step: "Buscando el canal en la web…" });
      const web = await webResults(langQuery(query, mode, countries), "", Number.isFinite(N) ? Math.max(30, N * 3) : 1000).catch(() => []);
      agg.web = { got: web.length };
      for (const [i, site] of web.entries()) {
        if (enough()) break;
        if (walked.has(site)) continue; walked.add(site);
        await onePage(site, `${lleva()} · página web ${i + 1} de ${web.length}: ${hostOf(site)}`, null);
      }
      // 2) sitios oficiales, página por página
      if (!enough()) {
        pub({ ...agg, step: `${lleva()}: sigo con los sitios oficiales…` });
        let dir = { websites: [], best: null };
        try { dir = await directoryCandidates(query, mode, countries); } catch {}
        const guess = await guessOfficialSite(query).catch(() => "");
        const officials = [...(dir.websites || []), guess].filter((u, i, a) => u && a.findIndex((x) => baseDomain(hostOf(x)) === baseDomain(hostOf(u))) === i);
        for (const [oi, official] of officials.entries()) {
          if (enough()) break;
          const pages = await officialLivePages(official, query).catch(() => [official]);
          for (const [i, page] of pages.entries()) {
            if (enough()) break;
            if (walked.has(page)) continue; walked.add(page);
            await onePage(page, `${lleva()} · sitio oficial ${oi + 1} de ${officials.length}, página ${i + 1} de ${pages.length}: ${page.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)}`,
              { website: official, pageUrl: page, fromOfficialPage: true });
          }
        }
      }
      const nOff = agg.found.filter((f) => f.tier === "official" || f.tier === "cdn").length;
      agg.status = ctl.cancelled ? "cancelled" : "done";
      agg.step = ctl.cancelled ? "Búsqueda cancelada." : agg.found.length ? `${agg.found.length} funcionan de ${agg.tried} probado(s) · ${nOff} oficial(es) o de plataforma.`
        : agg.tried ? `Probé ${agg.tried} link(s) y ninguno funcionó.` : `No encontré links de ese canal en la web ni en los sitios oficiales (revisé ${agg.pages.length} página(s)).`;
      agg.finishedAt = Date.now();
      finish(agg);
    } catch (e) { boom(e); }
  })();
}, job);

const t0 = Date.now();
let last = "", lastSent = 0;
for (;;) {
  await new Promise((r) => setTimeout(r, 2500));
  let st;
  try { st = await sw.evaluate(() => ({ job: self.__tvJob, done: self.__tvDone })); }
  catch { sw = ctx.serviceWorkers()[0] || sw; continue; }
  const s = JSON.stringify(st.job || {});
  if (s !== last || Date.now() - lastSent > 20000) { last = s; lastSent = Date.now(); await send({ status: st.done ? (st.job?.status || "done") : "running", job: st.job }); }
  if (st.done) break;
  if (cancel || Date.now() - t0 > MAX_MIN * 60e3) await sw.evaluate(() => { self.__tvCtl.cancelled = true; }).catch(() => {});
}
await ctx.close();
console.log("listo");
