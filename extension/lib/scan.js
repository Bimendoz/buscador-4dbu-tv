// Escaneo global (lo carga background.js con importScripts, después de lang.js y search.js).
// Recorre el directorio público de canales gratuitos (iptv-org) con los filtros elegidos — idioma, país y
// categoría —, prueba cada link como CarTV y entrega todos los que funcionan para que elijas cuáles guardar.
// Los resultados salen SIEMPRE en el orden de la lista (español latino primero, luego por país y nombre),
// aunque se prueben varios a la vez para que no tarde horas.
// El progreso queda en storage.session "scan" (o se entrega por opts.onSave en los encargos del iPhone).
let scanCtl = null;
const SCAN_PARALLEL = 3;

async function scanList(f) {
  const mode = langMode(f.langMode);
  const [channels, streams] = await Promise.all([dirJson("channels"), dirJson("streams")]);
  let feeds = [], countries = [], logos = [], blocked = new Set();
  try { [feeds, countries] = await Promise.all([dirJson("feeds"), dirJson("countries")]); } catch {}
  try { logos = await dirJson("logos"); } catch {}
  try { blocked = new Set((await dirJson("blocklist")).map((b) => b.channel)); } catch {}
  const idx = buildLangIndex(feeds, countries);
  const byId = new Map(channels.map((c) => [c.id, c]));
  const logoBy = new Map();
  for (const l of logos) if (!logoBy.has(l.channel)) logoBy.set(l.channel, l.url);
  const want = cleanCountries(f.countries);
  const order = SPANISH_COUNTRIES.map(([c]) => c);
  const seen = new Set(), out = [];
  for (const s of streams) {
    if (!s.url || !/\.m3u8(\?|$)/i.test(s.url)) continue;
    const ch = byId.get(s.channel);
    if (!ch || ch.closed || ch.is_nsfw || blocked.has(ch.id)) continue;
    if (f.category && !(ch.categories || []).includes(f.category)) continue;
    if (!countryOk(ch.country, streamAreas(s, idx), want)) continue;
    const lang = streamLang(s, ch, idx);
    if (!langOk(lang, mode)) continue;
    const k = keyOf(s.url);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ url: s.url, referer: s.referrer || "", ua: s.user_agent || "", name: s.title || ch.name, logo: logoBy.get(ch.id) || "",
      tvgId: ch.id, website: ch.website || "", country: ch.country || "", categories: ch.categories || [], lang, label: s.label || "" });
  }
  const oi = (c) => { const i = order.indexOf(c); return i < 0 ? 99 : i; };
  out.sort((a, b) => (mode === "any" ? 0 : langRank(a.lang) - langRank(b.lang)) || oi(a.country) - oi(b.country)
    || String(a.country).localeCompare(String(b.country)) || String(a.name).localeCompare(String(b.name), "es"));
  return out;
}

async function runScan(filters = {}, opts = {}) {
  const f = { langMode: langMode(filters.langMode), countries: cleanCountries(filters.countries), category: filters.category || "",
    max: Math.max(0, Math.round(+filters.max) || 0), portableOnly: filters.portableOnly };
  const own = !opts.ctl;
  if (own && scanCtl) scanCtl.cancelled = true;
  const ctl = opts.ctl || (scanCtl = { cancelled: false, tabs: new Set() });
  const job = { kind: "scan", filters: f, status: "running", step: "Leyendo el directorio de canales…", tried: 0, total: 0, goal: 0,
    found: [], failed: [], startedAt: Date.now(), updatedAt: Date.now() };
  let lastSave = 0;
  const save = async (force) => {
    if (!force && Date.now() - lastSave < 1500) return;
    lastSave = Date.now(); job.updatedAt = Date.now();
    if (opts.onSave) return opts.onSave(job);
    if (scanCtl === ctl) await chrome.storage.session.set({ scan: job });
  };
  await save(true);
  try {
    const list = await scanList(f);
    job.total = list.length;
    const todo = f.max ? list.slice(0, f.max) : list;
    job.goal = todo.length;
    job.step = todo.length ? `Probando ${todo.length} link(s) de ${list.length} que cumplen los filtros…` : "Ningún canal del directorio cumple esos filtros.";
    await save(true);
    const slots = new Array(todo.length);
    let next = 0, doneCount = 0;
    const one = async (i) => {
      const c = todo[i];
      let v, needs = "";
      try {
        try { v = await verifyHls(c.url, { mode: "player", ua: c.ua }, ctl); }
        catch (e) { if (!c.referer) throw e; v = await verifyHls(c.url, { mode: "player", referer: c.referer, ua: c.ua }, ctl); needs = "referer"; }
        if (!audioOk(v.audio, f.langMode)) throw new Error(`el audio está en ${v.audio.map((l) => LANG_NAMES[l] || l).join(", ")}, no en español`);
        const pi = f.portableOnly !== false ? portableIssue(c.url, !!c.website) : "";
        if (pi) throw new Error(pi);
        const si = sourceInfo(c.url, { website: c.website });
        slots[i] = { ok: true, item: {
          tier: si.tier, tierWhy: si.why, car: carFrom(needs ? "referer" : "ok"), key: keyOf(c.url), url: c.url, kind: "hls", referer: c.referer || "",
          name: c.name, thumb: c.logo, live: v.live, pageUrl: c.website, source: "escaneo", res: v.res, bw: v.bw, variants: v.variants, lock: !!v.lock,
          verifiedAt: Date.now(), needs, tvgId: c.tvgId, ua: c.ua || "", lang: c.lang.label, audio: v.audio || [], country: c.country, categories: c.categories,
          geo: /geo-?block/i.test(c.label) } };
      } catch (e) {
        slots[i] = { ok: false, fail: { host: hostOf(c.url), name: c.name, why: e.name === "AbortError" ? "no respondió a tiempo" : String(e.message || e) } };
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_PARALLEL, todo.length) }, async () => {
      while (next < todo.length && !ctl.cancelled) {
        const i = next++;
        await one(i);
        doneCount++;
        job.tried = doneCount;
        // en el orden de la lista, sin saltos
        job.found = slots.filter((x) => x?.ok).map((x) => x.item);
        job.failed = slots.filter((x) => x && !x.ok).map((x) => x.fail).slice(-30);
        job.step = `Probados ${doneCount} de ${todo.length} · ${job.found.length} funcionan`;
        await save();
      }
    }));
    job.found = slots.filter((x) => x?.ok).map((x) => x.item);
    job.status = ctl.cancelled ? "cancelled" : "done";
    job.step = ctl.cancelled ? `Escaneo detenido: ${job.found.length} funcionan de ${job.tried} probado(s).`
      : todo.length ? `Listo: ${job.found.length} funcionan de ${job.tried} probado(s)${list.length > todo.length ? ` (había ${list.length}; sube la cantidad para probar más)` : ""}.`
      : job.step;
  } catch (e) {
    job.status = "error";
    job.step = "Error: " + (e.message || e);
  } finally {
    job.finishedAt = Date.now();
    await save(true);
    if (own && scanCtl === ctl) scanCtl = null;
  }
  return job;
}
function cancelScan() { if (scanCtl) scanCtl.cancelled = true; }
