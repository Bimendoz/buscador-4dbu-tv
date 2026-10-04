// Revisión automática de Guardados, página para el celular y alertas remotas (lo carga background.js).

// ---------- 1. revisión automática ----------
// Prueba cada guardado con la misma verificación del buscador. Los caídos o por vencer que tengan
// página se renuevan solos (se abre la página en una pestaña de fondo y background.js toma el token nuevo).
const RENEW_BEFORE = 60 * 60e3; // renovar si al token le quedan menos de 60 min
const RENEW_MAX = Infinity;     // se renuevan TODOS los caídos o por vencer que tengan página (antes solo 3 por revisión)
let healthRunning = false;

async function checkOne(f) {
  const kind = f.kind || detectKind(f.url) || "hls";
  if (kind === "youtube") return { ok: null, why: "YouTube: no se revisa" };
  try {
    if (kind === "hls") {
      // como la pedirá la app IPTV: sin cookies ni Origin, con el Referer de la lista
      const v = await verifyHls(f.url, { mode: "player", referer: f.referer, ua: f.ua });
      return { ok: true, live: v.live, why: "" };
    }
    const r = await withHeaders({ mode: "player", referer: f.referer }, (get) => get(f.url, 10000, { headers: { Range: "bytes=0-1023" } }));
    if (!r.ok) throw new Error(`el servidor respondió ${r.status}`);
    return { ok: true, why: "" };
  } catch (e) {
    const m = String(e.message || e);
    return { ok: false, why: e.name === "AbortError" ? "no respondió a tiempo" : /Failed to fetch|NetworkError/i.test(m) ? "no se pudo conectar con el servidor" : m };
  }
}

async function runHealth(reason = "auto") {
  if (healthRunning) return { busy: true };
  healthRunning = true;
  try {
    const { favorites = [], health = {}, settings: st } = await chrome.storage.local.get(["favorites", "health", "settings"]);
    const settings = { ...DEFAULT_SETTINGS, ...(st || {}) };
    await chrome.storage.local.set({ healthMeta: { running: true, startedAt: Date.now(), reason } });
    const results = { ...health };
    const q = favorites.filter((f) => f.kind !== "youtube");
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (q.length) {
        const f = q.shift();
        results[f.key] = { ...(await checkOne(f)), at: Date.now() };
      }
    }));

    // renovar: caídos o por vencer, con página conocida
    const renewed = [];
    if (settings.healthRenew) {
      const now = Date.now();
      const todo = favorites.filter((f) => {
        if (!f.pageUrl || f.kind === "youtube") return false;
        const exp = tokenExpiry(f.url);
        return results[f.key]?.ok === false || (exp && exp - now < RENEW_BEFORE);
      }).slice(0, RENEW_MAX);
      const ctl = { cancelled: false, tabs: new Set() };
      for (const f of todo) {
        await captureFromPage(f.pageUrl, ctl); // record() -> refreshFavorite() actualiza el link
        const { favorites: fresh = [] } = await chrome.storage.local.get("favorites");
        const nf = fresh.find((x) => x.key === f.key);
        if (nf && nf.url !== f.url) {
          results[f.key] = { ...(await checkOne(nf)), at: Date.now(), renewed: true };
          renewed.push(nf.name);
        }
      }
    }

    // avisar solo de los que se cayeron desde la revisión anterior
    const newlyDown = favorites.filter((f) => results[f.key]?.ok === false && health[f.key]?.ok !== false);
    for (const k of Object.keys(results)) if (!favorites.some((f) => f.key === k)) delete results[k];
    const meta = { running: false, lastRun: Date.now(), reason, total: favorites.length,
      ok: favorites.filter((f) => results[f.key]?.ok).length, down: favorites.filter((f) => results[f.key]?.ok === false).length, renewed: renewed.length };
    await chrome.storage.local.set({ health: results, healthMeta: meta });
    // marca «Apto CarTV» en cada canal (viaja al iPhone con la sincronización); solo se escribe si cambió
    const { favorites: cur = [] } = await chrome.storage.local.get("favorites");
    let touched = false;
    for (const f of cur) {
      const r = results[f.key];
      if (!r || r.ok === null) continue;
      if (!f.car || f.car.ok !== r.ok) { f.car = carFrom(r.ok ? (f.referer ? "referer" : "ok") : "down", r.why || ""); touched = true; }
    }
    if (touched) await chrome.storage.local.set({ favorites: cur });

    if (newlyDown.length) {
      const names = newlyDown.map((f) => f.name).slice(0, 5).join(", ") + (newlyDown.length > 5 ? "…" : "");
      chrome.notifications.create(`health:${Date.now()}`, { type: "basic", iconUrl: "icons/icon128.png", priority: 1,
        title: `⚠ ${newlyDown.length} canal(es) guardado(s) no funcionan`, message: names });
      sendRemoteAlert(`⚠ Revisión de canales: ${newlyDown.length} caído(s)\n${names}`).catch(() => {});
    }
    // la página del celular muestra el estado: republicar
    const { publish } = await chrome.storage.local.get("publish");
    if (publish?.token && publish.auto !== false) publishPlaylist().catch(() => {});
    return meta;
  } finally {
    healthRunning = false;
  }
}

async function scheduleHealth() {
  const { settings: st } = await chrome.storage.local.get("settings");
  const every = +({ ...DEFAULT_SETTINGS, ...(st || {}) }.healthEvery) || 0;
  const cur = await chrome.alarms.get("health");
  if (!every) { if (cur) await chrome.alarms.clear("health"); return; }
  if (!cur || cur.periodInMinutes !== every) await chrome.alarms.create("health", { delayInMinutes: Math.min(every, 5), periodInMinutes: every });
}

// ---------- 2. página para el celular ----------
// Se publica en el mismo Gist (canales.html) y se abre con gist.githack.com, que la sirve como página web.
function buildMobilePage(favorites, categories, health, settings, listLink) {
  const items = sortByCategory(favorites, categories);
  const groups = [];
  for (const f of items) {
    const g = groupFor(f);
    let sec = groups.find((x) => x.g === g);
    if (!sec) groups.push((sec = { g, items: [] }));
    sec.items.push(f);
  }
  const when = new Date().toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" });
  const dot = (h) => (h?.ok === true ? ["ok", "Funciona"] : h?.ok === false ? ["bad", "Caído · " + h.why] : ["unk", "Sin revisar"]);
  const intent = (u) => "intent:" + u + "#Intent;action=android.intent.action.VIEW;type=video/*;end";
  const card = (f) => {
    const u = effUrl(f), [cls, txt] = dot(health[f.key]);
    return `<div class="c ${cls}"><div class="t">${f.thumb ? `<img src="${escHtml(f.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="ph">${iconSvg("tv", 22)}</div>`}` +
      `<div class="i"><b>${escHtml(f.name)}</b><span class="s">${escHtml(txt)}</span></div></div>` +
      `<div class="a"><a class="p" href="${escHtml(f.kind === "youtube" ? u : intent(u))}">${iconSvg("play", 14)}Abrir</a>` +
      `<button data-u="${escHtml(u)}">${iconSvg("copy", 15)}Copiar link</button></div></div>`;
  };
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Mis canales</title><meta name="theme-color" content="#0b0d10"><style>
:root{--bg:#0b0d10;--p:#12151a;--p2:#181c22;--l:#242a33;--l2:#2f3640;--t:#e6e8eb;--m:#8a919c;--d:#5d6470;--ok:#2fd158;--bad:#ff3b30;--a:#3d8bfd;--mono:"SF Mono",ui-monospace,Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:15px/1.45 -apple-system,system-ui,"Segoe UI",sans-serif;padding:0 0 calc(32px + env(safe-area-inset-bottom));font-variant-numeric:tabular-nums}
.brand{display:flex;align-items:center;gap:8px;padding:calc(10px + env(safe-area-inset-top)) 16px 10px;background:#07080a;border-bottom:1px solid var(--l);font:600 10px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--m)}
.brand i{width:8px;height:8px;border-radius:50%;background:var(--bad);box-shadow:0 0 6px var(--bad)}.brand b{color:var(--t)}
main{padding:14px 16px;max-width:680px;margin:0 auto}
.sub{color:var(--d);font:11px var(--mono);letter-spacing:.04em;margin-bottom:12px}
svg{flex:0 0 auto}
.top button{width:100%}
h2{display:flex;align-items:center;gap:8px;font:700 10.5px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--m);margin:22px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--l)}
h2 span{color:var(--d)}
.c{background:var(--p);border:1px solid var(--l);border-left:3px solid var(--l2);border-radius:4px;padding:10px;margin-bottom:8px}
.c.ok{border-left-color:var(--ok)}.c.bad{border-left-color:var(--bad)}
.t{display:flex;gap:11px;align-items:center}.t img,.ph{width:46px;height:46px;border-radius:3px;object-fit:contain;background:var(--p2);flex:0 0 46px;display:grid;place-items:center;color:var(--d)}
.i{min-width:0}.i b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.s{font:700 10px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--d)}.ok .s{color:var(--ok)}.bad .s{color:var(--bad)}
.a{display:flex;gap:6px;margin-top:10px}.a>*{flex:1}
a.p,button{display:flex;align-items:center;justify-content:center;gap:7px;height:42px;border-radius:3px;font:600 14px/1 inherit;text-decoration:none;border:1px solid var(--l2);background:var(--p2);color:var(--t)}
a.p{background:var(--a);border-color:var(--a);color:#fff}button:active,a.p:active{opacity:.75}
</style></head><body>
<div class="brand"><i></i><b>Mis canales</b><span>· +4dBu</span></div>
<main><div class="sub">${favorites.length} canales · estado al ${escHtml(when)}</div>
<div class="top"><button data-u="${escHtml(listLink)}">${iconSvg("link", 15)}Copiar link de la lista M3U</button></div>
${groups.map((s) => `<h2>${escHtml(s.g)} <span>${s.items.length}</span></h2>${s.items.map(card).join("")}`).join("")}
</main>
<script>document.addEventListener("click",e=>{const b=e.target.closest("button[data-u]");if(!b)return;const done=()=>{const o=b.innerHTML;b.textContent="Copiado";setTimeout(()=>b.innerHTML=o,1200)};
if(navigator.clipboard)navigator.clipboard.writeText(b.dataset.u).then(done,()=>prompt("Copia el link:",b.dataset.u));else prompt("Copia el link:",b.dataset.u)})</script>
</body></html>`;
}

// ---------- 5. alertas remotas (modo producción) ----------
// Telegram (bot propio) y/o WhatsApp vía CallMeBot. Se configuran en Opciones.
async function sendRemoteAlert(text) {
  const { settings: st } = await chrome.storage.local.get("settings");
  const s = { ...DEFAULT_SETTINGS, ...(st || {}) };
  const msg = (s.eventName ? `[${s.eventName}] ` : "") + text;
  const jobs = [];
  if (s.tgToken && s.tgChat) jobs.push(fetchT(`https://api.telegram.org/bot${encodeURIComponent(s.tgToken)}/sendMessage`, 10000, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: s.tgChat, text: msg })
  }).then((r) => { if (!r.ok) throw new Error("Telegram respondió " + r.status); return "Telegram"; }));
  if (s.cmbPhone && s.cmbKey) jobs.push(fetchT(`https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(s.cmbPhone)}&text=${encodeURIComponent(msg)}&apikey=${encodeURIComponent(s.cmbKey)}`, 15000)
    .then((r) => { if (!r.ok) throw new Error("CallMeBot respondió " + r.status); return "WhatsApp"; }));
  if (!jobs.length) return { sent: [], errors: ["No hay Telegram ni WhatsApp configurado"] };
  const res = await Promise.allSettled(jobs);
  return { sent: res.filter((r) => r.status === "fulfilled").map((r) => r.value), errors: res.filter((r) => r.status === "rejected").map((r) => String(r.reason?.message || r.reason)) };
}
