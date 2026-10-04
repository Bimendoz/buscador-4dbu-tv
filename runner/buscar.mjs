// +4dBu TV · Buscador en GitHub
// Abre un Chrome con TU extensión (la carpeta «extension», copia exacta de «version 3», sin tocarle nada)
// y corre su propio buscador (runSearch). Va contando el avance a tu página para que lo veas en vivo.
import { chromium } from "playwright";
import path from "node:path";

const EXT = path.resolve(process.env.EXT_DIR || "extension");
const PAGE = (process.env.TV_URL || "").replace(/\/+$/, "");
const ID = process.env.JOB_ID || "local", T = process.env.JOB_T || "";
const job = JSON.parse(Buffer.from(process.env.JOB || "e30=", "base64").toString("utf8") || "{}");
const MAX_MIN = +(process.env.MAX_MIN || 55);

let cancel = false;
const send = async (data) => {
  if (!PAGE) return console.log("[avance]", JSON.stringify(data).slice(0, 400));
  try {
    const r = await fetch(`${PAGE}/gh/avance?${new URLSearchParams({ id: ID, t: T })}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    const d = await r.json().catch(() => ({}));
    if (d.cancel) cancel = true;
  } catch (e) { console.log("no pude avisar a la página:", e.message); }
};

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
      const web = await webResults(langQuery(query, mode, countries), "", Number.isFinite(N) ? Math.max(30, N * 3) : 100).catch(() => []);
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
