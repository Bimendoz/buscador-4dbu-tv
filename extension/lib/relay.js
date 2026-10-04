// Puente con la app del iPhone (PWA), a través de un Gist secreto de tu GitHub.
// La app deja un encargo como archivo  req-<id>.json  { query, pageUrl, at }.
// La extensión lo hace con su motor completo (abre la página por detrás, captura, prueba como CarTV)
// y responde en  res-<id>.json  { status, step, found, failed, tried }. Cada lado solo escribe sus archivos,
// así nunca se pisan. Necesita el computador prendido con Chrome abierto.
const RELAY_DESC = "HLS-M3U-RELAY · puente entre la extensión y la app del iPhone (no borrar)";
let relayBusy = false;

async function ghApi(path, token, init = {}) {
  const r = await fetchT("https://api.github.com" + path, 15000, { ...init, headers: {
    Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
    ...(init.body ? { "Content-Type": "application/json" } : {}) } });
  if (!r.ok) throw new Error(r.status === 401 ? "el token de GitHub no es válido" : r.status === 403 ? "GitHub rechazó el pedido (permiso «gist» o límite de uso)" : `GitHub respondió ${r.status}`);
  return r.status === 204 ? null : r.json();
}
// Busca (o crea) el Gist del puente. Si hubiera más de uno (los dos lados lo crearon a la vez), los dos
// eligen siempre el MÁS ANTIGUO, así nunca quedan hablando en archivos distintos. Se revisa cada 10 min.
async function findRelayGist(token) {
  const hits = [];
  for (let page = 1; page <= 3; page++) {
    const list = await ghApi(`/gists?per_page=100&page=${page}`, token);
    hits.push(...list.filter((g) => g.description === RELAY_DESC));
    if (list.length < 100) break;
  }
  hits.sort((x, y) => String(x.created_at || "").localeCompare(String(y.created_at || "")) || String(x.id).localeCompare(String(y.id)));
  return hits[0]?.id || "";
}
async function relayGistId(token) {
  const { relay = {} } = await chrome.storage.local.get("relay");
  if (relay.gistId && Date.now() - (relay.gistAt || 0) < 10 * 60e3) return relay.gistId;
  let id = await findRelayGist(token);
  if (!id) {
    await ghApi("/gists", token, { method: "POST", body: JSON.stringify({ description: RELAY_DESC, public: false,
      files: { "LEEME.md": { content: "Puente entre la extensión HLS Stream Detector y la app Listas M3U del iPhone. No lo borres." } } }) });
    id = await findRelayGist(token);
  }
  const cur = (await chrome.storage.local.get("relay")).relay || {};
  await chrome.storage.local.set({ relay: { ...cur, gistId: id, gistAt: Date.now() } });
  return id;
}
async function relayPatch(token, id, files) {
  return ghApi(`/gists/${id}`, token, { method: "PATCH", body: JSON.stringify({ files }) });
}

async function relayTick() {
  if (relayBusy) return;
  const { publish = {}, settings: st, relay = {} } = await chrome.storage.local.get(["publish", "settings", "relay"]);
  const s = { ...DEFAULT_SETTINGS, ...(st || {}) };
  if (!publish.token || !s.relayOn) return;
  relayBusy = true;
  const token = publish.token;
  try {
    let id = await relayGistId(token), g;
    try { g = await ghApi(`/gists/${id}`, token); }
    catch (e) { if (!/404/.test(e.message)) throw e; await chrome.storage.local.set({ relay: { ...relay, gistId: "", gistAt: 0 } }); id = await relayGistId(token); g = await ghApi(`/gists/${id}`, token); }
    const reqs = Object.keys(g.files).filter((n) => /^req-[\w-]{4,40}\.json$/.test(n));
    const cur0 = (await chrome.storage.local.get("relay")).relay || {};
    await chrome.storage.local.set({ relay: { ...cur0, gistId: id, lastCheck: Date.now(), pending: reqs.length, lastError: "" } });
    for (const name of reqs.slice(0, 2)) {
      const rid = name.slice(4, -5), resName = `res-${rid}.json`;
      let req = null;
      try { req = JSON.parse(g.files[name].truncated ? await (await fetchT(g.files[name].raw_url)).text() : g.files[name].content); } catch {}
      if (!req || (!req.query && !req.pageUrl && !req.checkUrl && !Array.isArray(req.checkUrls) && !req.scan) || [req.pageUrl, req.checkUrl].some((u) => u && !/^https?:\/\//i.test(u))) { await relayPatch(token, id, { [name]: null }); continue; }
      const write = (obj) => relayPatch(token, id, { [resName]: { content: JSON.stringify({ id: rid, at: Date.now(), ...obj }) } });
      if (Array.isArray(req.checkUrls)) { // varios resultados de búsqueda del iPhone: ¿cuáles sirven en CarTV?
        const list = req.checkUrls.filter((x) => x && /^https?:\/\//i.test(x.url));
        const checks = [];
        let last = 0;
        for (const [i, x] of list.entries()) {
          if (Date.now() - last > 8000) { last = Date.now(); await write({ status: "working", step: `Probando como CarTV ${i + 1} de ${list.length}…`, tried: i, found: [] }).catch(() => {}); }
          const r = await playerCheck(x.url, x.referer || "").catch((e) => ({ verdict: "down", why: e.message }));
          checks.push({ url: x.url, verdict: r.verdict, why: r.why || "", lock: r.lock || "", exp: r.exp || null });
        }
        await relayPatch(token, id, { [resName]: { content: JSON.stringify({ id: rid, at: Date.now(), status: "done", step: "Listo", checks }) }, [name]: null });
        continue;
      }
      if (req.checkUrl) { // «¿funciona en CarTV?» pedido desde el iPhone
        await write({ status: "working", step: "Tu computador está probando el link como CarTV…", tried: 0, found: [] });
        const check = await playerCheck(req.checkUrl, req.referer || "").catch((e) => ({ verdict: "down", why: e.message }));
        await relayPatch(token, id, { [resName]: { content: JSON.stringify({ id: rid, at: Date.now(), status: "done", step: "Listo", check }) }, [name]: null });
        continue;
      }
      if (req.scan && typeof req.scan === "object") { // escaneo global pedido desde el iPhone
        await write({ status: "working", step: "Tu computador empezó el escaneo…", tried: 0, found: [] });
        let lastS = 0;
        const sj = await runScan(req.scan, { ctl: { cancelled: false, tabs: new Set() }, onSave: async (j) => {
          if (Date.now() - lastS < 8000) return;
          lastS = Date.now();
          await write({ status: "working", step: j.step, tried: j.tried, goal: j.goal, found: [] }).catch(() => {});
        } });
        await relayPatch(token, id, { [resName]: { content: JSON.stringify({ id: rid, at: Date.now(), status: "done", step: sj.step, tried: sj.tried, goal: sj.goal, total: sj.total, found: sj.found, failed: sj.failed.slice(-15) }) }, [name]: null });
        continue;
      }
      await write({ status: "working", step: "Tu computador recibió el encargo…", tried: 0, found: [] });
      let last = 0;
      const ctl = { cancelled: false, tabs: new Set() };
      const job = await runSearch(req.query || "", { pageUrl: req.pageUrl || "", langMode: req.langMode ? langMode(req.langMode) : undefined,
        portableOnly: typeof req.portableOnly === "boolean" ? req.portableOnly : undefined,
        countries: Array.isArray(req.countries) ? cleanCountries(req.countries) : undefined,
        searchCount: req.searchCount != null && req.searchCount !== "" ? searchCountOf(req.searchCount) : undefined,
        skipDirTests: !!req.skipDirTests, ctl, onSave: async (j) => {
        if (Date.now() - last < 8000) return; // no más de un avance cada 8 s
        last = Date.now();
        await write({ status: "working", step: j.step, tried: j.tried, found: [], pages: j.pages || [] }).catch(() => {});
      } });
      await relayPatch(token, id, {
        [resName]: { content: JSON.stringify({ id: rid, at: Date.now(), status: "done", step: job.step, tried: job.tried, found: job.found, failed: job.failed.slice(-15), pages: job.pages || [], web: job.web || null }) },
        [name]: null
      });
      const done = await chrome.storage.local.get("relay");
      await chrome.storage.local.set({ relay: { ...done.relay, lastJob: { at: Date.now(), what: req.pageUrl ? hostOf(req.pageUrl) : req.query, found: job.found.length } } });
    }
  } catch (e) {
    const cur = (await chrome.storage.local.get("relay")).relay || {};
    await chrome.storage.local.set({ relay: { ...cur, lastCheck: Date.now(), lastError: String(e.message || e) } });
  } finally {
    relayBusy = false;
  }
}

async function scheduleRelay() {
  const { publish = {}, settings: st } = await chrome.storage.local.get(["publish", "settings"]);
  const cfg = { ...DEFAULT_SETTINGS, ...(st || {}) };
  const on = !!publish.token && (cfg.relayOn || cfg.syncOn);
  if (!on) return chrome.alarms.clear("relay");
  if (!(await chrome.alarms.get("relay"))) chrome.alarms.create("relay", { delayInMinutes: 0.1, periodInMinutes: 0.5 });
}
