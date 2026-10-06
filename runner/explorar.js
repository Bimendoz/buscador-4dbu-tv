// +4dBu TV · EXPLORADOR AUTOMÁTICO — lo que hace el navegador de la nube con UNA fuente
// ---------------------------------------------------------------------------------------------------------
// Etapas (cada una queda anotada con su tiempo):
//   OPENING       abre la página del título y ejecuta la ACCIÓN real de la fuente (clic, evento JS, lista desplegable)
//   PLAYER_FOUND  apareció un reproductor: <video>, un iframe nuevo, una pestaña nueva con reproductor o video en la red
//   PLAY_ATTEMPT  le da play (en la página, en sus iframes y en la pestaña nueva)
//   VERIFYING     mira si el tiempo del video avanza con datos suficientes y sin error
// Resultado: playing (reproduce de verdad) · player_no_play · no_player · source_error. La página de +4dBu TV vuelve
// a comprobarlo reproduciendo el link en su propio reproductor antes de marcar la fuente como FUNCIONANDO.
// No inventa direcciones, no salta captchas, inicios de sesión, DRM ni verificaciones anti-robots.
// Sirve con cualquier página tipo Puppeteer/Playwright (page.on, page.goto, page.evaluate, page.frames…).

const MEDIA_URL = /\.(m3u8|mpd|mp4|m4v|webm|mov|mkv|ts|m4s)(\?|#|$)/i;
const MANIFEST_URL = /\.(m3u8|mpd)(\?|#|$)/i;
const MEDIA_CT = /(mpegurl|dash\+xml|^video\/|^audio\/mp4)/i;
const NOISE = /\.(png|jpe?g|gif|webp|svg|ico|css|woff2?|ttf)(\?|$)/i;
const ERR_TXT = /(error|not found|no encontrado|no disponible|unavailable|deleted|eliminado|removed|no existe|expired|caducado|blocked|bloqueado)/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

// play en cualquier reproductor de un documento (silenciado): los <video> y el botón de play más visible
const AUTOPLAY = `(() => {
  let n = 0;
  for (const v of document.querySelectorAll("video")) { try { v.muted = true; const p = v.play(); p && p.catch(() => {}); n++; } catch {} }
  if ([...document.querySelectorAll("video")].some((v) => !v.paused && v.readyState > 2)) return n;
  const b = [...document.querySelectorAll("button, [role=button], div, span, a")].find((e) => {
    const r = e.getBoundingClientRect(); if (r.width < 30 || r.height < 30 || r.width > innerWidth * 0.9) return false;
    const t = (e.getAttribute("aria-label") || e.getAttribute("title") || e.textContent || "").trim().toLowerCase();
    return /^(play|reproducir|ver|watch|▶|►)$/.test(t) || /play|reproducir/.test(e.getAttribute("aria-label") || "");
  });
  if (b) { b.click(); n++; }
  return n;
})()`;

// Monitor de red: documentos, iframes, fetch, xhr, media y manifiestos (con estado HTTP, frame y momento)
export function networkMonitor(page, t0 = Date.now(), tag = "") {
  const log = [], media = new Map(), byReq = new Map();
  let gateT = 0, mediaT = 0; // cuándo pidió el servidor su desafío (portero) · cuándo llegó el último video/lista nuevo
  const frameOf = (r) => { try { const f = r.frame(); return f ? f.url() : ""; } catch { return ""; } };
  const isMedia = (url, type, ct) => !NOISE.test(url) && (MEDIA_URL.test(url) || type === "media" || MEDIA_CT.test(ct || ""));
  const onReq = (r) => {
    try {
      const url = r.url(), type = r.resourceType();
      if (!/^https?:/i.test(url)) return;
      if (!gateT && /^(xhr|fetch)$/.test(type) && GATE_URL.test(url)) gateT = Date.now();
      if (!/^(document|xhr|fetch|media|other|manifest)$/.test(type) && !MEDIA_URL.test(url)) return;
      const e = { t: Date.now() - t0, method: r.method(), type, url: url.slice(0, 500), frame: (tag ? tag + " " : "") + frameOf(r).slice(0, 300), status: 0, media: isMedia(url, type, "") };
      if (log.length < 250 || e.media) log.push(e);
      byReq.set(r, e);
      if (e.media && !media.has(url)) mediaT = Date.now(), media.set(url, { url, type: MANIFEST_URL.test(url) ? "manifest" : "media", status: 0, referer: (r.headers() || {}).referer || "", frame: frameOf(r), t: e.t });
    } catch {}
  };
  const onRes = async (res) => {
    try {
      const r = res.request(), url = res.url(), ct = (res.headers() || {})["content-type"] || "";
      const e = byReq.get(r); if (e) { e.status = res.status(); e.ct = ct.split(";")[0]; }
      if (isMedia(url, r.resourceType(), ct)) {
        if (!media.has(url)) mediaT = Date.now();
        const m = media.get(url) || { url, type: MANIFEST_URL.test(url) || /mpegurl|dash/i.test(ct) ? "manifest" : "media", referer: (r.headers() || {}).referer || "", frame: frameOf(r), t: Date.now() - t0 };
        m.status = res.status(); m.ct = ct.split(";")[0]; media.set(url, m);
        if (e) e.media = true;
      }
      const rt = r.resourceType();
      if ((rt === "xhr" || rt === "fetch") && /json|javascript|text|xml/i.test(ct) && res.status() < 400) { // APIs de reproductores
        const body = await res.text().catch(() => "");
        if (body.length < 2e6) for (const m of body.matchAll(/https?:(?:\\?\/){2}[^\s"'<>`]+?\.(?:m3u8|mpd|mp4)(?:[^\s"'<>`]*)?/gi)) {
          const u = m[0].replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/&amp;/g, "&").replace(/[\\'"),;]+$/, "");
          if (!media.has(u)) media.set(u, { url: u, type: MANIFEST_URL.test(u) ? "manifest" : "media", status: 0, referer: url, frame: frameOf(r), t: Date.now() - t0, from: "respuesta" });
        }
      }
    } catch {}
  };
  const onFail = (r) => { const e = byReq.get(r); if (e) { e.status = -1; try { e.err = r.failure()?.errorText || "falló"; } catch {} } };
  page.on("request", onReq); page.on("response", onRes); page.on("requestfailed", onFail);
  return {
    log, media,
    since: (t) => [...media.values()].filter((m) => m.t >= t),
    gate: () => gateT,
    mediaAt: () => mediaT,
    stop: () => { try { page.off("request", onReq); page.off("response", onRes); page.off("requestfailed", onFail); } catch {} },
  };
}

// PlayerDetector: los reproductores de una página y de TODOS sus iframes accesibles
async function players(page) {
  const out = { vids: [], frames: [], errText: "" };
  for (const f of page.frames()) {
    try {
      const s = await f.evaluate(() => ({
        v: [...document.querySelectorAll("video")].map((x) => ({ src: x.currentSrc || x.src || "", ready: x.readyState, t: +x.currentTime || 0, paused: x.paused, err: x.error ? x.error.code : 0, w: x.videoWidth || 0, h: x.videoHeight || 0 })),
        fr: [...document.querySelectorAll("iframe")].map((x) => x.src || "").filter((s) => /^https?:/.test(s)),
        t: (document.body ? document.body.innerText : "").slice(0, 1500),
      }));
      out.vids.push(...s.v.map((x) => ({ ...x, frame: f.url().slice(0, 300) })));
      out.frames.push(...s.fr);
      if (f !== page.mainFrame() && s.t.length < 600 && ERR_TXT.test(s.t)) out.errText ||= s.t.trim().slice(0, 120);
    } catch {}
  }
  out.frames = [...new Set(out.frames)];
  return out;
}

async function options(page, url, code) {
  await page.evaluate(code).catch(() => {});
  return page.evaluate((u) => (window.X4 ? window.X4.markSources(document, u) : []), url).catch(() => []);
}

// ============================================================
// DETECTOR REAL DE REPRODUCCIÓN (diseño de Mas4dBu)
// Una fuente FUNCIONA solo si su video avanza de verdad: progress ≥ progressMin en verifyMs,
// sin pausa, sin terminar y con datos (readyState ≥ 2). Abrir una página no cuenta.
// Adaptado de Playwright a Puppeteer (el navegador de Cloudflare): mismo flujo, mismos tiempos y códigos.
// ============================================================
// LIMITS (los del programador): acción de la fuente, detección del reproductor, verificación y total por fuente
export const LIMITS = { sourceAction: 8000, playerDetection: 4000, playbackVerification: 3000, totalSource: 10000 };
// PORTERO: servidores como Filemoon/Byse ponen un botón «Reproducir vídeo» que pide un desafío (challenge → attest →
// captcha → prueba de trabajo de ~10 s en un PC, más en GitHub → verify → playback) antes de entregar la lista .m3u8.
// Mientras ese portero esté trabajando no se corta la fuente por tiempo: se espera hasta GATE_MS desde que apareció.
export const GATE_MS = 60000;
// (solo porteros automáticos que el propio sitio resuelve en el navegador; nunca se resuelven captchas de una persona)
export const GATE_URL = /\/(api\/)?[\w\/-]*(captcha|challenge|attest|pow)\b/i;
export const SOURCE_TEST = { timeoutMs: LIMITS.totalSource, loadTimeoutMs: 3500, playerTimeoutMs: LIMITS.playerDetection, playTimeoutMs: 2000, verifyMs: 1200, progressMin: 0.2, retryMs: 700 };
// ¿error de infraestructura (navegador de la nube) y no de la fuente?
export function isBrowserInfrastructureError(error) {
  const text = String(error?.message || error?.reason || error?.code || error || "").toLowerCase();
  return text.includes("browser_quota_exhausted") || text.includes("quota exhausted") || text.includes("browser_unavailable") || text.includes("browser unavailable") ||
    text.includes("cloud browser") || text.includes("browser timeout") ||
    // el navegador se cayó a mitad de la prueba: ya no se puede usar
    /target closed|session closed|browser has disconnected|connection closed|protocol error|websocket is not open/.test(text);
}
// tope general por fuente
export async function runSourceWithTimeout(task, timeout, budget = null) {
  let timer;
  const end = Date.now() + timeout;
  if (budget) budget.until = Math.max(budget.until || 0, end);
  try {
    return await Promise.race([task(), new Promise((_, reject) => {
      const tick = () => { // el plazo lo puede alargar la prueba (portero trabajando): se revisa cada 250 ms
        const g = budget?.gate?.() || 0;
        if (Date.now() >= (budget ? Math.max(budget.until, g ? g + GATE_MS + 10000 : 0) : end)) { const e = new Error("SOURCE_TIMEOUT"); e.code = "SOURCE_TIMEOUT"; reject(e); }
        else timer = setTimeout(tick, 250);
      };
      timer = setTimeout(tick, 250);
    })]);
  } finally { clearTimeout(timer); }
}
// selectores de botón Play (los tuyos) + cualquier botón que diga play/reproducir
const PLAY_SELECTORS = ['button[aria-label*="Play" i]', 'button[title*="Play" i]', '[aria-label*="Play" i]', '[title*="Play" i]', ".play", ".play-button", ".vjs-play-control", ".vjs-big-play-button",
  'button[aria-label*="reproducir" i]', '[aria-label*="reproducir" i]', 'button[title*="reproducir" i]', '[class*="captcha" i] button', '[class*="gate" i] button', 'button[class*="play" i]',
  ".jw-icon-playback", ".jw-display-icon-container", '.plyr__control[data-plyr="play"]', '[class*="play-button" i]', '[class*="play_button" i]', '[class*="playButton" i]'];

// el <video> del reproductor en TODAS las frames (primero el visible; si no, el primero que haya)
export async function findVideo(page) {
  let fallback = null;
  for (const frame of page.frames()) {
    try {
      const r = await frame.evaluate(() => {
        const vs = [...document.querySelectorAll("video")];
        const vis = vs.findIndex((v) => { const b = v.getBoundingClientRect(), st = getComputedStyle(v); return b.width > 40 && b.height > 30 && st.visibility !== "hidden" && st.display !== "none"; });
        return { n: vs.length, vis };
      });
      if (r.n) { if (r.vis >= 0) return { frame, idx: r.vis }; fallback ||= { frame, idx: 0 }; }
    } catch {}
  }
  return fallback;
}
// el botón Play visible en todas las frames (queda marcado para tocarlo)
export async function findPlayButton(page, prefer = null) {
  const frames = page.frames();
  for (const frame of prefer ? [prefer, ...frames.filter((f) => f !== prefer)] : frames) {
    try {
      const ok = await frame.evaluate((sels) => {
        const visible = (e) => { const b = e.getBoundingClientRect(), st = getComputedStyle(e); return b.width > 8 && b.height > 8 && st.visibility !== "hidden" && st.display !== "none" && +st.opacity !== 0; };
        let el = null;
        for (const s of sels) { try { el = [...document.querySelectorAll(s)].find(visible); } catch {} if (el) break; }
        if (!el) el = [...document.querySelectorAll("button, [role=button]")].find((e) => visible(e) && /^(play|reproducir|reproducir v[ií]deo|ver|ver v[ií]deo|ver ahora|watch|▶|►)$/i.test((e.getAttribute("aria-label") || e.textContent || "").trim()));
        if (!el) return false;
        document.querySelectorAll("[data-x4play]").forEach((x) => x.removeAttribute("data-x4play"));
        el.setAttribute("data-x4play", "1"); return true;
      }, PLAY_SELECTORS);
      if (ok) return { frame };
    } catch {}
  }
  return null;
}
async function clickPlay(btn, ms = SOURCE_TEST.playTimeoutMs) {
  try {
    const h = await btn.frame.$("[data-x4play]");
    if (!h) return false;
    const ok = await Promise.race([h.click().then(() => true, () => false), sleep(ms).then(() => false)]);
    if (!ok) await h.evaluate((e) => e.click());
    return true;
  } catch { return false; }
}
// ------------------------------------------------------------
// CLIC HUMANO: como lo hace una persona — un clic real del mouse en el centro del reproductor (video, iframe o la
// portada que lo tapa). Si ese clic abre publicidad en otra pestaña, se cierra y se vuelve a dar clic.
// ------------------------------------------------------------
async function playerBox(page) {
  return page.mainFrame().evaluate(() => {
    const box = (e) => { const b = e.getBoundingClientRect(), st = getComputedStyle(e); return b.width >= 200 && b.height >= 112 && st.visibility !== "hidden" && st.display !== "none" && +st.opacity > 0.05 ? b : null; };
    let best = null, area = 0;
    for (const e of document.querySelectorAll("video, iframe, embed, object, canvas")) { const b = box(e); if (b && b.width * b.height > area) { area = b.width * b.height; best = e; } }
    if (!best) { // portada sin video todavía: lo que esté en el centro de la pantalla
      const e = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      if (e && e !== document.body && e !== document.documentElement) best = e;
    }
    if (!best) return null;
    best.scrollIntoView({ block: "center", inline: "center" });
    const b = best.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), tag: best.tagName.toLowerCase(), w: Math.round(b.width), h: Math.round(b.height) };
  }).catch(() => null);
}
// hasta `tries` clics reales en el centro; entre clic y clic se cierran las pestañas de publicidad y se mira si el video avanza
export async function humanPlay(page, tabs = [], log = () => {}, tries = 3, signal = null) {
  let last = null;
  for (let k = 0; k < tries && !signal?.aborted; k++) {
    const before = tabs.length;
    const box = await playerBox(page);
    if (!box) break;
    try { await page.mouse.click(box.x, box.y); } catch { break; }
    log(`clic ${k + 1} en el centro del reproductor (${box.tag} ${box.w}×${box.h})`);
    await sleep(800);
    for (const t of tabs.slice(before)) { // pestaña nueva por el clic: si no trae video, era publicidad
      const p = t.page || t;
      if (!(await findVideo(p).catch(() => null))) { try { await p.close(); } catch {} t.closed = true; log("cerré una ventana de publicidad"); }
    }
    const v = await findVideo(page);
    if (v) { const r = await verifyPlayback(v); last = { v, r }; if (r.working) return last; }
  }
  return last;
}

// estado del video
export async function getVideoState(v) {
  try {
    return await v.frame.evaluate((i) => {
      const x = document.querySelectorAll("video")[i]; if (!x) return null;
      return { currentTime: Number(x.currentTime || 0), paused: !!x.paused, ended: !!x.ended, readyState: Number(x.readyState || 0), duration: Number(x.duration || 0),
        w: x.videoWidth || 0, h: x.videoHeight || 0, src: x.currentSrc || x.src || "", error: x.error ? { code: x.error.code, message: x.error.message || "" } : null };
    }, v.idx);
  } catch { return null; }
}
// confirmar que el video REALMENTE avanza
export async function verifyPlayback(v, verifyMs = SOURCE_TEST.verifyMs, minProgress = SOURCE_TEST.progressMin) {
  const before = await getVideoState(v);
  if (!before) return { working: false, reason: "VIDEO_STATE_UNAVAILABLE" };
  await sleep(verifyMs);
  const after = await getVideoState(v);
  if (!after) return { working: false, reason: "VIDEO_STATE_UNAVAILABLE" };
  const progress = +(after.currentTime - before.currentTime).toFixed(2);
  if (progress >= minProgress && !after.paused && !after.ended && after.readyState >= 2)
    return { working: true, reason: "PLAYBACK_CONFIRMED", progress, w: after.w, h: after.h, src: after.src };
  return { working: false, reason: after.error ? "PLAYBACK_ERROR" : "PLAYBACK_NOT_CONFIRMED", progress, paused: after.paused, readyState: after.readyState, error: after.error };
}
// intentar reproducir: ¿ya avanza? → botón Play → play() silenciado (sin sonido el navegador lo permite) → verificar
export async function attemptPlayback(page, v, onStage = () => {}, tabs = [], log = () => {}, signal = null) {
  onStage("verifying");
  let r = await verifyPlayback(v);
  if (r.working) return r;
  onStage("play_attempt");
  const btn = await findPlayButton(page, v.frame); // primero en el frame donde está el video
  if (!btn) onStage("play_button_not_found");
  if (btn) {
    if (!(await clickPlay(btn))) r = { working: false, reason: "PLAY_CLICK_FAILED" };
    else {
      await sleep(300);
      v = (await findVideo(page)) || v; // el botón pudo cambiar o crear el video
      onStage("verifying");
      r = await verifyPlayback(v);
      if (r.working) return r;
    }
  }
  // como una persona: clic en el centro del reproductor (la portada o el botón grande suelen estar ahí)
  onStage("play_attempt");
  if (signal?.aborted) return { working: false, reason: "SOURCE_TIMEOUT" };
  const hp = await humanPlay(page, tabs, log, 2, signal);
  if (hp?.r?.working) return hp.r;
  if (signal?.aborted) return { working: false, reason: "SOURCE_TIMEOUT" };
  if (hp?.v) v = hp.v;
  try { await v.frame.evaluate((i) => { const x = document.querySelectorAll("video")[i]; if (x) { x.muted = true; const p = x.play(); p && p.catch(() => {}); } }, v.idx); } catch {}
  await sleep(300);
  onStage("verifying");
  let r2 = await verifyPlayback(v);
  if (r2.working) return r2;
  // última comprobación: el reproductor pudo tardar un poco más en arrancar
  await sleep(SOURCE_TEST.retryMs);
  v = (await findVideo(page)) || v;
  r2 = await verifyPlayback(v);
  if (r2.working) return r2;
  return btn ? r2 : { ...r2, reason: r2.reason === "PLAYBACK_NOT_CONFIRMED" ? "NO_PLAY_BUTTON" : r2.reason };
}

// aviso del propio servidor en la página principal («File was deleted», «Video not found»…): página corta con el aviso
async function pageError(page) {
  try { const t = await page.evaluate(() => (document.body ? document.body.innerText : "").trim().slice(0, 800)); return t && t.length < 600 && ERR_TXT.test(t) ? t.slice(0, 120) : ""; } catch { return ""; }
}
// ------------------------------------------------------------
// ESPERAR AL PORTERO: el servidor pidió su desafío (lo resuelve su propia página, sola, como en tu Chrome).
// Se espera hasta GATE_MS a que aparezca el reproductor; si ya llegó la lista .m3u8 y el reproductor espera su
// Play (JW Player), se le da. Mientras tanto se alarga el plazo de la fuente (budget) para que no se corte.
// ------------------------------------------------------------
export async function waitGate(page, net, tabs = [], { budget = null, step = () => {}, signal = null } = {}) {
  const g0 = net.gate(); if (!g0) return null;
  step("el servidor pide un desafío antes de dar el video (portero): espero a que su página lo resuelva");
  const lim = g0 + GATE_MS;
  while (Date.now() < lim && !signal?.aborted) {
    if (budget) budget.until = Math.max(budget.until || 0, Date.now() + 9000);
    if (net.mediaAt() >= g0) { // el servidor ya entregó el video (o su lista .m3u8): ahora sí hay reproductor que probar
      for (const p of [page, ...tabs.map((t) => t.page || t)]) {
        if (p.isClosed?.()) continue;
        const v = await findVideo(p).catch(() => null);
        if (v) { step("el portero dejó pasar: llegó el video y está el reproductor"); return { v, page: p }; }
      }
    }
    await sleep(400);
  }
  if (!signal?.aborted) step("el portero no dejó pasar a tiempo");
  return null;
}

// ------------------------------------------------------------
// PROBAR LA URL DE UNA FUENTE (abrir el servidor directamente)
// ------------------------------------------------------------
export async function probarUrl(page, { url, ms = SOURCE_TEST.timeoutMs, signal = null, onStep = null, budget = null }) {
  const t0 = Date.now();
  const res = { url, status: "failed", reason: null, stage: "opening", steps: [], media: [], elapsedMs: 0 };
  const step = (s) => { res.steps.push({ t: Date.now() - t0, s }); try { onStep?.(s); } catch {} };
  const stage = (s) => { if (res.stage !== s) { res.stage = s; step(s.toUpperCase()); } };
  const net = networkMonitor(page, t0);
  if (budget) budget.gate = net.gate;
  const tabs = [];
  const onPopup = (p) => { tabs.push(p); step("se abrió una pestaña nueva"); };
  page.on("popup", onPopup);
  try {
    step("OPENING");
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: SOURCE_TEST.loadTimeoutMs }); }
    catch { const cur = page.url(); if (!cur || cur === "about:blank") { res.reason = "OPEN_FAILED"; return res; } } // algunas páginas de video nunca «terminan» de cargar
    step("ACTION_EXECUTED");
    // esperar brevemente el reproductor
    let v = null;
    const deadline = Date.now() + SOURCE_TEST.playerTimeoutMs; // no se espera de más: si no aparece, se le da clic como una persona
    let errText = "";
    while (Date.now() < deadline && Date.now() - t0 < ms && !signal?.aborted) {
      v = await findVideo(page); if (v) break;
      errText = await pageError(page); if (errText) break; // el servidor ya dijo que el video no está
      await sleep(150);
    }
    if (!v && !errText) { // sin video: el botón Play o un clic en la portada lo crean
      const btn = await findPlayButton(page);
      if (btn) { stage("player_found"); stage("play_attempt"); await clickPlay(btn); await sleep(500); for (let i = 0; i < 10 && !v; i++) { v = await findVideo(page); if (!v) await sleep(200); } }
      if (!v) {
        stage("play_attempt");
        const hp = await humanPlay(page, tabs, step, 3, signal);
        if (hp?.v) { stage("player_found"); v = hp.v; if (hp.r.working) { Object.assign(res, { status: "working", reason: "PLAYBACK_CONFIRMED", progress: hp.r.progress, video: { w: hp.r.w, h: hp.r.h, src: hp.r.src } }); stage("working"); return res; } }
      }
    }
    for (const p of tabs) { if (v) break; const tv = await findVideo(p).catch(() => null); if (tv) { v = tv; step("el reproductor está en la pestaña nueva"); } }
    if (!v && !errText && net.gate()) { const g = await waitGate(page, net, tabs, { budget, step, signal }); if (g) { v = g.v; stage("player_found"); } }
    if (!v) { res.errText = errText || (await pageError(page)) || (await players(page)).errText || ""; res.reason = res.errText ? "SOURCE_ERROR" : "NO_PLAYER"; return res; }
    stage("player_found");
    let pb = await attemptPlayback(v.frame.page ? v.frame.page() : page, v, stage, tabs, step, signal);
    if (!pb.working && net.gate() && !signal?.aborted) {
      const g = await waitGate(page, net, tabs, { budget, step, signal });
      if (g) pb = await attemptPlayback(g.page, g.v, stage, tabs, step, signal);
    }
    Object.assign(res, { progress: pb.progress, video: { w: pb.w, h: pb.h, src: pb.src } });
    if (pb.working) { res.status = "working"; res.reason = "PLAYBACK_CONFIRMED"; stage("working"); }
    else { res.reason = pb.reason; }
    return res;
  } catch (e) { res.reason = "TEST_ERROR"; res.error = String(e?.message || e); return res; }
  finally {
    net.stop(); try { page.off("popup", onPopup); } catch {}
    for (const p of tabs) p.close().catch(() => {});
    res.media = net.since(0); res.net = net.log.slice(-150); res.elapsedMs = Date.now() - t0;
  }
}

// ------------------------------------------------------------
// PROBAR UNA FUENTE QUE SE ACTIVA EN LA PÁGINA DEL TÍTULO (clic, evento JS, lista, pestaña nueva, iframe)
// ------------------------------------------------------------
export async function probarFuente(page, { url, i = 0, nm = "", ms = LIMITS.sourceAction, code, listOnly = false, settle = 1200, signal = null, onStep = null, budget = null }) {
  const t0 = Date.now();
  const net = networkMonitor(page, t0);
  const res = { url, ops: [], i, name: nm, stage: "opening", status: "failed", reason: null, media: [], frames: [], popups: [], steps: [] };
  if (budget) budget.gate = net.gate;
  const step = (s) => { res.steps.push({ t: Date.now() - t0, s }); try { onStep?.(s); } catch {} };
  const stage = (s) => { if (res.stage !== s) { res.stage = s; step(s.toUpperCase()); } };
  const tabs = [];
  const onPopup = (p) => { tabs.push({ page: p, at: Date.now(), net: networkMonitor(p, t0, "pestaña") }); res.popups.push(p.url ? p.url() : ""); step("se abrió una pestaña nueva"); };
  page.on("popup", onPopup);
  try {
    step("OPENING");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch((e) => step("la página tardó: " + String(e?.message || e).slice(0, 80)));
    await sleep(settle);
    res.title = await page.title().catch(() => "");
    res.ops = await options(page, url, code);
    step(`${res.ops.length} fuente(s) en la página`);
    if (listOnly) { res.status = "list"; return res; }
    let op = nm ? res.ops.find((o) => norm(o.name) === norm(nm)) : null;
    if (!op && !nm) op = res.ops[i];
    if (!op && nm) { // el elemento real con ese nombre, aunque el detector no lo haya listado igual
      const found = await page.evaluate((name) => {
        const n = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
        const want = n(name).replace(/\s+\d+$/, "");
        const els = [...document.querySelectorAll("button, a, li, span, div, option, label, td, [role=tab], [role=button], [onclick], [data-src], [data-video], [data-url]")]
          .filter((e) => { const t = n(e.innerText || e.textContent); return t === n(name) || t === want; })
          .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length); // el más chico (el botón, no su contenedor)
        const e = els[0]; if (!e) return null;
        e.setAttribute("data-x4o", "x");
        return { i: "x", name, kind: "click", element: e.tagName.toLowerCase() + " «" + (e.innerText || "").trim().slice(0, 40) + "»", action: e.tagName === "OPTION" ? "select" : "click" };
      }, nm).catch(() => null);
      if (found) { op = found; step("encontré la fuente por su nombre en la página"); }
    }
    if (!op) op = res.ops[i];
    if (!op) { res.reason = "NO_ACTION"; return res; }
    Object.assign(res, { i: op.i, name: op.name, element: op.element, action: op.action, href: op.href || "" });
    const before = await players(page);
    const preexisting = op.kind === "iframe" || op.kind === "video";
    const act = async () => {
      const h = await page.$(`[data-x4o="${op.i}"]`).catch(() => null);
      if (!h) return false;
      if ((await h.evaluate((e) => e.tagName).catch(() => "")) === "OPTION") {
        await h.evaluate((e) => { const s = e.closest("select"); if (s) { s.value = e.value; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); } }).catch(() => {});
        return true;
      }
      await h.evaluate((e) => e.scrollIntoView({ block: "center" })).catch(() => {});
      const ok = await Promise.race([h.click().then(() => true, () => false), sleep(3000).then(() => false)]);
      if (!ok) await h.evaluate((e) => e.click()).catch(() => {});
      return true;
    };
    if (!preexisting) { await act(); step(`acción: ${op.action || "clic"} en «${op.name}»`); }
    step("ACTION_EXECUTED");
    // buscar el reproductor que resultó de la acción: en la página, sus iframes o una pestaña nueva
    let target = page, v = null, retouched = false;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !signal?.aborted) {
      for (const tab of tabs) {
        if (tab.closed || tab.keep) continue;
        const tv = await findVideo(tab.page).catch(() => null), st = await players(tab.page).catch(() => ({ frames: [] }));
        if (tv || st.frames.length || tab.net.since(0).length) { tab.keep = true; step("la pestaña nueva tiene reproductor: sigo ahí"); }
        else if (Date.now() - tab.at > 2500) { tab.closed = true; tab.page.close().catch(() => {}); if (!retouched && !preexisting) { retouched = true; await act(); step("cerré una pestaña sin reproductor y repetí la acción"); } }
      }
      const kept = tabs.find((x) => x.keep && !x.closed);
      if (kept) { target = kept.page; v = await findVideo(target); }
      if (!v) { target = page; v = await findVideo(page); }
      if (v) break;
      const st = await players(page);
      if (st.errText) { res.errText = st.errText; break; }
      // un iframe nuevo sin <video> todavía: puede necesitar su botón Play
      if (st.frames.some((f) => !before.frames.includes(f)) && !res.humanTried) {
        await sleep(600); // que el reproductor termine de dibujar su portada
        v = await findVideo(page); if (v) break;
        const btn = await findPlayButton(page); if (btn) { stage("player_found"); stage("play_attempt"); await clickPlay(btn); await sleep(400); v = await findVideo(page); if (v) break; }
        res.humanTried = true; stage("player_found"); stage("play_attempt");
        const hp = await humanPlay(page, tabs, step, 3, signal);
        if (hp?.v) { v = hp.v; if (hp.r.working) { Object.assign(res, { status: "working", reason: "PLAYBACK_CONFIRMED", progress: hp.r.progress }); stage("working"); res.frames = (await players(page)).frames.filter((f) => !before.frames.includes(f)); return res; } break; }
      }
      if (Date.now() - t0 > settle + Math.min(ms, 6000) && !tabs.length && !net.since(0).length && !st.frames.some((f) => !before.frames.includes(f))) break; // la acción no abrió nada
      await sleep(200);
    }
    if (!v && !res.errText && net.gate()) { // el servidor puso su portero (botón «Reproducir vídeo» + desafío): se espera
      const g = await waitGate(page, net, tabs, { budget, step, signal });
      if (g) { v = g.v; target = g.page; }
    }
    const after = await players(page);
    res.frames = after.frames.filter((f) => !before.frames.includes(f));
    res.tab = tabs.find((x) => x.keep)?.page?.url?.() || "";
    if (!v) {
      res.reason = res.errText ? "SOURCE_ERROR" : res.frames.length || res.tab ? "PLAYBACK_NOT_CONFIRMED" : "NO_PLAYER";
      if (res.frames.length || res.tab) stage("player_found");
      return res;
    }
    stage("player_found");
    let pb = await attemptPlayback(target, v, stage, tabs, step, signal);
    if (!pb.working && net.gate() && !signal?.aborted) { // se tocó el portero: cuando entregue el video, otra vez Play
      const g = await waitGate(page, net, tabs, { budget, step, signal });
      if (g) pb = await attemptPlayback(g.page, g.v, stage, tabs, step, signal);
    }
    Object.assign(res, { progress: pb.progress, video: { w: pb.w, h: pb.h, src: pb.src } });
    if (pb.working) { res.status = "working"; res.reason = "PLAYBACK_CONFIRMED"; stage("working"); }
    else res.reason = pb.reason;
    return res;
  } catch (e) { res.reason = "TEST_ERROR"; res.error = String(e?.message || e).slice(0, 200); return res; }
  finally {
    net.stop(); try { page.off("popup", onPopup); } catch {}
    res.media = [...net.since(0), ...tabs.flatMap((x) => x.net.since(0))];
    for (const t of tabs) { t.net.stop(); t.page.close().catch(() => {}); }
    res.net = [...net.log, ...tabs.flatMap((x) => x.net.log)].sort((a, b) => a.t - b.t).slice(-150);
    res.elapsedMs = res.ms = Date.now() - t0;
  }
}

// ============================================================
// PRUEBA DE UN TÍTULO EN UNA SOLA SESIÓN (lo que pidió el programador)
// Mismo navegador y misma página para todas las fuentes, en orden. Se detiene en la primera PLAYBACK_CONFIRMED.
// Si el navegador se cae o se queda sin cuota: browser_error / BROWSER_UNAVAILABLE y no se sigue con las demás.
// emit(obj) manda cada avance a la página en el momento (una línea JSON por evento).
// ============================================================
const REASON = (r) => (!r ? null : r === "PLAYBACK_CONFIRMED" ? null
  : /^(PLAYBACK_NOT_CONFIRMED|PLAYBACK_ERROR|NO_PLAY_BUTTON|PLAY_CLICK_FAILED|VIDEO_STATE_UNAVAILABLE)$/.test(r) ? "PLAYBACK_NOT_CONFIRMED"
  : /^(NO_ACTION|OPEN_FAILED|TEST_ERROR|SOURCE_ERROR)$/.test(r) ? "SOURCE_ERROR" : r);
export async function probarTitulo(page, { url, sources = [], code, totalMs = LIMITS.totalSource, emit = () => {} }) {
  const results = [];
  const alive = async () => { try { return (await page.evaluate(() => 1)) === 1; } catch { return false; } };
  for (const src of sources) {
    const n = src.n, t0 = Date.now();
    const out = { index: n, name: src.name, status: "testing", reason: null, detail: "", sourceTested: false, stages: [] };
    emit({ type: "source", n, status: "testing", stage: "opening" });
    const signal = { aborted: false }, budget = { until: 0 };
    const onStep = (st) => emit({ type: "stage", n, stage: st });    let res;
    try {
      out.sourceTested = true;
      const task = async () => {
        let r = null;
        // la acción REAL de la fuente en la página del título (clic, evento, lista, pestaña nueva, iframe)
        if (src.op != null) r = await probarFuente(page, { url, i: src.op, nm: src.name, code, signal, ms: LIMITS.sourceAction, onStep, budget });
        // sin acción que tocar en la página: su enlace directo (nunca uno inventado)
        if (src.href && !signal.aborted && (!r || (r.status !== "working" && /^(NO_ACTION)$/.test(r.reason || "")))) r = await probarUrl(page, { url: src.href, signal, ms: totalMs, onStep, budget });
        return r;
      };
      const p = task();
      res = await runSourceWithTimeout(() => p, totalMs, budget).catch(async (e) => {
        if (e?.code === "SOURCE_TIMEOUT") { signal.aborted = true; await Promise.race([p.catch(() => null), new Promise((r) => setTimeout(r, 4000))]); return { status: "failed", reason: "SOURCE_TIMEOUT", steps: [] }; }
        throw e;
      });
    } catch (e) {
      if (isBrowserInfrastructureError(e)) res = { status: "browser_error", reason: "BROWSER_UNAVAILABLE", error: String(e?.message || e) };
      else res = { status: "failed", reason: "SOURCE_ERROR", error: String(e?.message || e) };
    }
    // ¿el navegador sigue vivo? un error de la prueba puede ser que se cayó
    if (res.status !== "working" && (isBrowserInfrastructureError(res.error) || !(await alive()))) res = { ...res, status: "browser_error", reason: "BROWSER_UNAVAILABLE" };
    Object.assign(out, {
      status: res.status === "working" ? "working" : res.status === "browser_error" ? "browser_error" : "failed",
      reason: res.status === "working" ? null : res.status === "browser_error" ? "BROWSER_UNAVAILABLE" : REASON(res.reason) || "NO_PLAYER",
      detail: res.status === "working" ? "PLAYBACK_CONFIRMED" : res.errText || res.reason || "", progress: res.progress ?? null, ms: Date.now() - t0,
      stages: (res.steps || []).map((x) => ({ ms: x.t, stage: x.s })), media: res.media || [], frames: res.frames || [], tab: res.tab || "", href: res.href || src.href || "", element: res.element || "", action: res.action || "",
    });
    if (out.status === "browser_error") out.sourceTested = false;
    if (out.status === "working") out.stages.push({ ms: out.ms, stage: "PLAYBACK_CONFIRMED" });
    results.push(out);
    emit({ type: "result", ...out, net: (res.net || []).filter((e) => e.media || /^(document|xhr|fetch)$/.test(e.type)).slice(-40) });
    if (out.status === "working") return { status: "working", reason: null, selected_source: { name: out.name, index: n }, results };
    if (out.status === "browser_error") return { status: "browser_error", reason: "BROWSER_UNAVAILABLE", selected_source: null, sourceTested: false, results };
  }
  return { status: "failed", reason: "NO_WORKING_SOURCE", selected_source: null, results };
}
