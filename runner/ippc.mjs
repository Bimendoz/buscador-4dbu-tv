// +4dBu TV · lector del catálogo de IPPC en GitHub (Mas4dBu Developers)
// GitHub (no tu PC) corre esto cada noche: pide su tarea al puente, lee TODO el catálogo del portal
// y se lo entrega al puente. El código del portal lo manda el puente por el canal de la tarea (nunca
// queda publicado en el repositorio). Aquí no hay secretos tuyos: solo el número de la tarea.
import fs from "node:fs";
const TV = (process.env.TV_URL || "").replace(/\/+$/, ""), ID = process.env.JOB_ID, T = process.env.JOB_T;
if (!TV || !ID || !T) { console.error("faltan TV_URL / JOB_ID / JOB_T"); process.exit(1); }
const avance = (status, step) => fetch(`${TV}/ippc/avance?id=${ID}&t=${T}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status, step }) }).catch(() => {});

const job = await (await fetch(`${TV}/ippc/job?id=${ID}&t=${T}`)).json().catch(() => ({}));
if (!job?.src) { console.error("el puente no entregó el código del portal:", job?.error || ""); process.exit(1); }
fs.writeFileSync("ippc-portal.mjs", job.src); // efímero: vive solo mientras corre esta tarea
const { Portal, exportarCatalogo } = await import("./ippc-portal.mjs");

let ultimo = 0;
const P = new Portal({ hosts: process.env.IPPC_HOSTS ? process.env.IPPC_HOSTS.split(",").map((s) => s.trim()).filter(Boolean) : undefined, seeds: job.seeds || [],
  log: (...a) => { const s = a.join(" "); console.log(s); if (Date.now() - ultimo > 4000) { ultimo = Date.now(); avance("running", s.slice(0, 200)); } } });
await avance("running", "Leyendo el catálogo del portal…");
let catalog, report;
try { ({ catalog, report } = await exportarCatalogo(P, { log: (...a) => P.log(...a) })); }
catch (e) { await avance("error", "No se pudo leer el portal: " + (e?.message || e)); console.error(e); process.exit(1); }

await avance("running", "Enviando el catálogo al puente…");
const r = await fetch(`${TV}/ippc/catalogo?id=${ID}&t=${T}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ catalog, report }) });
const d = await r.json().catch(() => ({}));
if (!r.ok || !d.ok) { console.error("el puente no aceptó el catálogo:", r.status, d); process.exit(1); }
console.log("Listo:", JSON.stringify(d.counts));
