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
  const opts = { ctl: self.__tvCtl, onSave: (x) => { self.__tvJob = JSON.parse(JSON.stringify(x)); } };
  for (const k of ["pageUrl", "langMode", "countries", "searchCount", "portableOnly"]) if (j[k] != null && j[k] !== "") opts[k] = j[k];
  runSearch(j.query || "", opts).then(
    (x) => { self.__tvJob = JSON.parse(JSON.stringify(x)); self.__tvDone = true; },
    (e) => { self.__tvJob = { ...(self.__tvJob || {}), status: "error", step: "Error: " + (e?.message || e) }; self.__tvDone = true; });
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
