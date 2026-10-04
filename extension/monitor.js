// Monitor en vivo: vista previa (hls.js) + salud del directo + alertas.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SRC = params.get("u") || "";
const REF = params.get("r") || "";
const NAME = params.get("n") || hostOf(SRC) || "Flujo";
const KIND = params.get("k") || detectKind(SRC) || "hls";
const FILE = KIND === "file"; // video completo (.mp4/.webm): se reproduce sin hls.js

let settings = { ...DEFAULT_SETTINGS };
let tabId = null;
let hls = null;
let levels = [];

const m = {
  status: "CONECTANDO", live: null, target: null,
  lastSN: null, lastSNChange: null, lastFragAt: null, fatalAt: null, lastStallAt: null,
  onlineSince: null, badSince: null, drops: 0, stalls: 0, errors: 0,
  samples: [], retryTimer: null
};

// ---------- registro ----------
function log(text, cls = "") {
  const ul = $("log");
  const top = ul.firstElementChild;
  if (top && top.dataset.text === text) { // mensaje repetido: contar en vez de llenar el registro
    top.dataset.n = +top.dataset.n + 1;
    top.lastChild.textContent = `${text} (×${top.dataset.n})`;
    top.firstChild.textContent = new Date().toLocaleTimeString();
    return;
  }
  const li = document.createElement("li");
  li.dataset.text = text; li.dataset.n = 1;
  li.className = cls;
  const t = document.createElement("time");
  t.textContent = new Date().toLocaleTimeString();
  li.append(t, document.createTextNode(text));
  ul.prepend(li);
  while (ul.children.length > 200) ul.lastChild.remove();
}

// ---------- alertas ----------
let audioCtx = null;
function beep(bad) {
  if (!settings.alertSound) return;
  try {
    audioCtx = audioCtx || new AudioContext();
    audioCtx.resume();
    const tones = bad ? [880, 660, 880, 660] : [660, 990];
    tones.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = "square";
      g.gain.value = 0.08;
      o.connect(g).connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + i * 0.22;
      o.start(t0); o.stop(t0 + 0.18);
    });
  } catch {}
}
function notify(title, message, bad) {
  if (settings.alertNotify && tabId != null) {
    chrome.notifications.create(`mon:${tabId}:${Date.now()}`, {
      type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 2, requireInteraction: bad
    });
  }
  beep(bad);
}

// ---------- Referer: algunos servidores solo entregan el video si viene "desde" su página ----------
// Nombres de error de hls.js en español
const HLS_ERR = { manifestLoadError: "no se pudo cargar la lista", manifestLoadTimeOut: "la lista tardó demasiado", manifestParsingError: "la lista no es válida",
  levelLoadError: "no se pudo cargar la calidad", levelLoadTimeOut: "la calidad tardó demasiado", fragLoadError: "un segmento no descargó",
  fragLoadTimeOut: "un segmento tardó demasiado", fragParsingError: "un segmento llegó en un formato ilegible", bufferAppendError: "el navegador no pudo agregar el video al buffer",
  keyLoadError: "la llave de cifrado no descargó", bufferNudgeOnStall: "reajuste del buffer", fragGap: "falta un segmento en la lista" };
const hlsErr = (d) => HLS_ERR[d] || d;

// ---------- historial de caídas y alertas remotas (modo producción) ----------
let incident = null;
async function saveIncident(inc) {
  const { incidents = [] } = await chrome.storage.local.get("incidents");
  const i = incidents.findIndex((x) => x.id === inc.id);
  if (i >= 0) incidents[i] = inc; else incidents.push(inc);
  while (incidents.length > 1000) incidents.shift();
  await chrome.storage.local.set({ incidents });
}
// Telegram / WhatsApp si están configurados en Opciones (si no, no hace nada)
const remote = (text) => chrome.runtime.sendMessage({ action: "remoteAlert", text }).catch(() => {});

async function setupReferer() {
  const tab = await chrome.tabs.getCurrent();
  tabId = tab?.id ?? null;
  if (!REF || tabId == null) return;
  let origin = "";
  try { origin = new URL(REF).origin; } catch {}
  const requestHeaders = [{ header: "referer", operation: "set", value: REF }];
  if (origin) requestHeaders.push({ header: "origin", operation: "set", value: origin });
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [tabId],
      addRules: [{ id: tabId, priority: 1, action: { type: "modifyHeaders", requestHeaders },
        condition: { tabIds: [tabId], resourceTypes: ["xmlhttprequest", "media", "other"] } }]
    });
  } catch (e) { console.warn("Referer", e); }
}

// ---------- reproducción ----------
function start(reason) {
  clearTimeout(m.retryTimer);
  m.retryTimer = null;
  if (hls) hls.destroy();
  // m.fatalAt se conserva: solo un segmento nuevo confirma que el directo volvió
  if (reason) log(reason, "warn");
  const video = $("video");
  if (FILE) { video.src = SRC; video.load(); video.play().catch(() => {}); return; }

  hls = new Hls({
    enableWorker: false, // la política de seguridad de extensiones no permite workers "blob:"
    lowLatencyMode: true, liveDurationInfinity: true, backBufferLength: 30,
    manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 3, fragLoadingMaxRetry: 3,
    xhrSetup: (xhr) => { xhr.withCredentials = true; }
  });
  hls.loadSource(SRC);
  hls.attachMedia(video);

  hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
    levels = data.levels || [];
    const sel = $("quality");
    const keep = sel.value;
    sel.replaceChildren(new Option("Automática", "-1"));
    levels.forEach((l, i) => sel.append(new Option(levelLabel(l) || `Calidad ${i + 1}`, String(i))));
    if ([...sel.options].some((o) => o.value === keep)) { sel.value = keep; hls.currentLevel = +keep; }
    log(`Lista cargada: ${levels.length} calidad${levels.length === 1 ? "" : "es"}`);
    video.play().catch(() => {});
  });

  hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
    const d = data.details;
    const first = m.live === null;
    m.live = d.live; m.target = d.targetduration;
    if (first) log(d.live ? `Directo detectado · segmentos de ${d.targetduration} s` : `Video grabado (VOD) · ${fmtDuration(d.totalduration)}`);
    if (d.endSN !== m.lastSN) { m.lastSN = d.endSN; m.lastSNChange = Date.now(); }
  });

  hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
    const st = data.frag.stats;
    const ms = Math.max(1, (st.loading.end || 0) - (st.loading.start || 0));
    const bytes = st.loaded || st.total || 0;
    const dur = data.frag.duration || m.target || 1;
    m.samples.push({ mbps: (bytes * 8) / ms / 1000, ratio: ms / 1000 / dur, nominal: (levels[data.frag.level]?.bitrate || 0) / 1e6 });
    if (m.samples.length > 90) m.samples.shift();
    m.lastFragAt = Date.now();
    drawChart();
  });

  hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
    const l = levels[data.level];
    if (l) log(`Calidad: ${levelLabel(l)}`);
  });

  hls.on(Hls.Events.ERROR, (_e, data) => {
    m.errors++;
    if (data.details === "bufferStalledError") { m.stalls++; m.lastStallAt = Date.now(); log("Corte: el video se quedó sin buffer", "warn"); return; }
    if (!data.fatal) { log(`Aviso: ${hlsErr(data.details)}${data.response?.code ? " (HTTP " + data.response.code + ")" : ""}`, "warn"); return; }
    const now = Date.now();
    m.fatalAt = now;
    if (/Codec/i.test(data.details)) log("Este navegador no puede decodificar el códec del flujo", "bad");
    else log(`Error grave: ${hlsErr(data.details)}${data.response?.code ? " (HTTP " + data.response.code + ")" : ""}`, "bad");
    // Error de video: un intento de recuperación rápida; si se repite, reinicio completo
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && (!m.lastMediaRecover || now - m.lastMediaRecover > 5000)) {
      m.lastMediaRecover = now;
      hls.recoverMediaError();
      return;
    }
    hls.destroy(); hls = null;
    scheduleRetry(5000);
  });
}

function scheduleRetry(ms) {
  clearTimeout(m.retryTimer);
  if (!$("optKeep").checked) return;
  m.retryTimer = setTimeout(() => { m.retryTimer = null; start("Reintentando conexión…"); }, ms);
}

function levelLabel(l) {
  if (!l) return "";
  return [l.height ? l.height + "p" : "", l.frameRate ? Math.round(l.frameRate) + "fps" : "", l.bitrate ? fmtMbps(l.bitrate) : ""].filter(Boolean).join(" · ");
}

// ---------- estado de salud ----------
function computeStatus() {
  const now = Date.now();
  if (m.fatalAt && (!m.lastFragAt || m.lastFragAt < m.fatalAt)) return "CAÍDO";
  if (FILE) return m.lastFragAt ? "ARCHIVO" : "CONECTANDO";
  if (m.live === false) return "VOD";
  if (m.live && m.lastSNChange && now - m.lastSNChange > Math.max(3 * (m.target || 6), 15) * 1000) return "CONGELADO";
  if (!m.lastFragAt) return "CONECTANDO";
  const recent = m.samples.slice(-5);
  const avgRatio = recent.reduce((a, s) => a + s.ratio, 0) / (recent.length || 1);
  if ((m.lastStallAt && now - m.lastStallAt < 30000) || avgRatio > 0.8) return "INESTABLE";
  return "EN VIVO";
}
const isBad = (s) => s === "CAÍDO" || s === "CONGELADO";

function tick() {
  const now = Date.now();
  const prev = m.status;
  const s = computeStatus();
  m.status = s;

  if (s !== prev) {
    if (isBad(s) && !isBad(prev)) {
      m.drops++; m.badSince = now; m.onlineSince = null;
      const why = s === "CONGELADO" ? "El servidor dejó de publicar segmentos nuevos." : "No se puede cargar el flujo.";
      log(`${s}: ${why}`, "bad");
      notify(`⚠ Directo ${s.toLowerCase()}: ${NAME}`, why, true);
      incident = { id: String(now), name: NAME, url: SRC, event: settings.eventName || "", type: s, why, start: now, end: null, duration: 0 };
      saveIncident(incident);
      remote(`⚠ ${NAME}: directo ${s.toLowerCase()}. ${why}`);
      if (s === "CONGELADO") scheduleRetry(8000);
    } else if (!isBad(s) && isBad(prev) && (s === "EN VIVO" || s === "INESTABLE" || s === "ARCHIVO")) {
      const down = fmtDuration((now - (m.badSince || now)) / 1000);
      log(`Recuperado tras ${down} sin señal`, "ok");
      notify(`✅ Directo recuperado: ${NAME}`, `Estuvo ${down} sin señal.`, false);
      if (incident) {
        incident.end = now; incident.duration = Math.round((now - incident.start) / 1000);
        saveIncident(incident); incident = null;
      }
      remote(`✅ ${NAME}: recuperado tras ${down} sin señal.`);
      m.badSince = null;
    } else if (s === "INESTABLE") log("Inestable: descargas lentas o cortes recientes", "warn");
    if ((s === "EN VIVO" || s === "INESTABLE" || s === "ARCHIVO") && !m.onlineSince) m.onlineSince = now;
  }
  // si sigue caído, reintentar periódicamente
  if (isBad(s) && !m.retryTimer && $("optKeep").checked) scheduleRetry(15000);
  if (!isBad(s) && m.retryTimer) { clearTimeout(m.retryTimer); m.retryTimer = null; }

  renderStats(now);
}

// ---------- vista ----------
function setTile(id, text, cls = "") { const e = $(id); e.textContent = text; e.className = "v " + cls; }

function renderStats(now) {
  const s = m.status;
  const st = $("status");
  st.textContent = s;
  st.className = isBad(s) ? "bad" : s === "INESTABLE" ? "warn" : s === "EN VIVO" || s === "VOD" || s === "ARCHIVO" ? "ok" : "";
  document.title = (isBad(s) ? "⚠ " : s === "EN VIVO" ? "● " : "") + `${s} · ${NAME}`;

  setTile("tUptime", m.onlineSince ? fmtDuration((now - m.onlineSince) / 1000) : isBad(s) ? "sin señal" : "—", isBad(s) ? "bad" : "");
  $("hUptime").textContent = m.badSince ? `caído hace ${fmtDuration((now - m.badSince) / 1000)}` : m.drops ? `${m.drops} caída${m.drops > 1 ? "s" : ""} en esta sesión` : " ";

  const lvl = hls ? levels[hls.currentLevel] : null;
  const vid = $("video");
  if (FILE) {
    setTile("tLevel", vid.videoHeight ? vid.videoHeight + "p" : "—");
    $("hLevel").textContent = vid.videoWidth ? `${vid.videoWidth}×${vid.videoHeight}` + (Number.isFinite(vid.duration) ? ` · ${fmtDuration(vid.duration)}` : "") : "\u00a0";
  } else setTile("tLevel", lvl ? (lvl.height ? lvl.height + "p" : "—") : "—");
  if (!FILE) $("hLevel").textContent = lvl ? [lvl.frameRate ? Math.round(lvl.frameRate) + " fps" : "", lvl.bitrate ? fmtMbps(lvl.bitrate) : "", lvl.videoCodec || ""].filter(Boolean).join(" · ") || " " : " ";

  const recent = m.samples.slice(-5);
  if (recent.length) {
    const sp = recent.reduce((a, x) => a + x.mbps, 0) / recent.length;
    const ratio = recent.reduce((a, x) => a + x.ratio, 0) / recent.length;
    setTile("tSpeed", sp.toFixed(1) + " Mbps");
    setTile("tRatio", Math.round(ratio * 100) + "%", ratio < 0.6 ? "ok" : ratio < 0.9 ? "warn" : "bad");
  }

  const lat = hls?.latency;
  if (m.live && Number.isFinite(lat) && lat > 0) {
    setTile("tLatency", lat.toFixed(1) + " s", lat < 10 ? "ok" : lat < 30 ? "warn" : "bad");
    $("hLatency").textContent = hls.targetLatency ? `objetivo ${hls.targetLatency.toFixed(1)} s` : " ";
  } else setTile("tLatency", m.live === false ? "VOD" : "—");

  const v = $("video");
  let buf = 0;
  for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) >= v.currentTime) buf = v.buffered.end(i) - v.currentTime;
  setTile("tBuffer", buf.toFixed(1) + " s", buf < 2 && m.lastFragAt ? "warn" : "");

  if (m.live && m.lastSNChange) {
    const ago = (now - m.lastSNChange) / 1000;
    const lim = Math.max(3 * (m.target || 6), 15);
    setTile("tFresh", `hace ${Math.round(ago)} s`, ago < (m.target || 6) * 2 ? "ok" : ago < lim ? "warn" : "bad");
    $("hFresh").textContent = `segmento #${m.lastSN} · cada ${m.target} s`;
  } else setTile("tFresh", m.live === false ? "VOD" : "—");

  setTile("tIncidents", `${m.drops} · ${m.stalls} · ${m.errors}`, m.drops ? "bad" : m.stalls ? "warn" : "");

  const exp = tokenExpiry(SRC);
  if (exp) {
    const left = exp - now, chip = $("exp");
    chip.hidden = false;
    chip.textContent = left <= 0 ? "Token vencido" : "Token: " + fmtRemaining(left);
    chip.className = "chip " + (left <= 0 ? "expired" : left < 3600e3 ? "soon" : "");
    chip.title = new Date(exp).toLocaleString();
    if (left <= 0 && left > -1000) log("El token del link venció: el servidor puede cortar el flujo", "bad");
  }
}

function drawChart() {
  const c = $("chart");
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  const data = m.samples;
  if (!data.length) return;
  const max = Math.max(1, ...data.map((d) => Math.max(d.mbps, d.nominal))) * 1.15;
  const pad = 26, bw = (w - pad) / 90;

  ctx.fillStyle = col("--muted"); ctx.font = "10px system-ui";
  ctx.strokeStyle = col("--line"); ctx.lineWidth = 1;
  [0, 0.5, 1].forEach((f) => {
    const y = h - 14 - f * (h - 24);
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.fillText((max * f).toFixed(0), 2, y + 3);
  });
  data.forEach((d, i) => {
    const x = pad + i * bw, bh = (d.mbps / max) * (h - 24);
    ctx.fillStyle = d.ratio > 1 ? col("--bad") : col("--info");
    ctx.fillRect(x + 1, h - 14 - bh, Math.max(1, bw - 2), bh);
  });
  ctx.strokeStyle = col("--muted"); ctx.setLineDash([4, 3]); ctx.beginPath();
  data.forEach((d, i) => { const x = pad + i * bw + bw / 2, y = h - 14 - (d.nominal / max) * (h - 24); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = col("--muted"); ctx.textAlign = "right"; ctx.fillText("Mbps", w - 4, 10); ctx.textAlign = "left";
}

// ---------- inicio ----------
document.addEventListener("DOMContentLoaded", async () => {
  hydrateIcons();
  $("name").textContent = NAME;
  $("src").textContent = SRC;
  $("src").title = SRC;
  if (!SRC) { document.querySelector(".wrap").innerHTML = '<div class="msg">No se indicó ningún flujo.</div>'; return; }
  const lock = networkLock(SRC);
  if (lock) log("Red: " + lockText(lock), "warn");

  const { settings: s } = await chrome.storage.local.get("settings");
  settings = { ...DEFAULT_SETTINGS, ...(s || {}) };
  const syncBtns = () => { $("btnNotify").classList.toggle("on", settings.alertNotify); $("btnSound").classList.toggle("on", settings.alertSound); };
  syncBtns();
  $("btnNotify").onclick = () => { settings.alertNotify = !settings.alertNotify; chrome.storage.local.set({ settings }); syncBtns(); };
  $("btnSound").onclick = () => { settings.alertSound = !settings.alertSound; chrome.storage.local.set({ settings }); syncBtns(); if (settings.alertSound) beep(false); };
  $("btnCopy").onclick = async (e) => {
    const b = e.currentTarget;
    await navigator.clipboard.writeText(SRC).catch(() => {});
    const old = [...b.childNodes];
    b.classList.add("done"); b.replaceChildren(icon("check"), "Copiado");
    setTimeout(() => { b.classList.remove("done"); b.replaceChildren(...old); }, 1300);
  };
  $("btnReconnect").onclick = () => start("Reconexión manual");
  $("quality").onchange = (e) => { if (hls) hls.currentLevel = +e.target.value; };
  document.addEventListener("click", () => { if (audioCtx) audioCtx.resume(); }, { once: true });
  window.addEventListener("resize", drawChart);

  if (FILE) {
    const v = $("video");
    document.getElementById("chart").closest(".panel").hidden = true;
    $("quality").disabled = true;
    v.addEventListener("loadedmetadata", () => { m.lastFragAt = Date.now(); log(`Video: ${v.videoWidth}×${v.videoHeight} · ${fmtDuration(v.duration)}`); });
    v.addEventListener("playing", () => { m.lastFragAt = Date.now(); });
    v.addEventListener("waiting", () => { if (m.lastFragAt) { m.stalls++; m.lastStallAt = Date.now(); } });
    v.addEventListener("error", () => {
      m.errors++; m.fatalAt = Date.now();
      log(`No se pudo cargar el video (código ${v.error?.code || "?"}): el link pudo vencer o el servidor lo bloquea`, "bad");
      scheduleRetry(8000);
    });
    await setupReferer();
    log(REF ? `Reproduciendo video con Referer ${REF}` : "Reproduciendo video");
    start();
    setInterval(tick, 1000);
    return;
  }
  if (!window.Hls || !Hls.isSupported()) {
    log("Este navegador no soporta reproducción HLS con Media Source Extensions", "bad");
    return;
  }
  if (detectKind(SRC) === "dash") log("Es un flujo DASH: el monitor solo reproduce HLS", "warn");

  await setupReferer();
  log(REF ? `Monitoreando con Referer ${REF}` : "Monitoreando");
  start();
  setInterval(tick, 1000);
});

window.addEventListener("beforeunload", () => {
  if (tabId != null) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] });
});
