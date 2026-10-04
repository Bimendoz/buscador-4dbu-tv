// Sincroniza «Guardados» (y sus categorías) con la app del iPhone, a través del Gist del puente.
// Se ejecuta al cambiar los guardados (con pausa de 3 s) y cada 30 s junto con el puente.
let syncBusy = false, syncAgain = false, syncTimer = null;

async function syncNow(reason = "auto") {
  if (syncBusy) { syncAgain = true; return; }
  const { publish = {}, settings: st, favorites = [], categories = [], syncBase } = await chrome.storage.local.get(["publish", "settings", "favorites", "categories", "syncBase"]);
  const s = { ...DEFAULT_SETTINGS, ...(st || {}) };
  if (!publish.token || !s.syncOn) return;
  syncBusy = true;
  try {
    const token = publish.token;
    const id = await relayGistId(token);
    const g = await ghApi(`/gists/${id}`, token);
    const f = g.files[SYNC_FILE];
    let remote = {};
    if (f) { try { remote = JSON.parse(f.truncated ? await (await fetchT(f.raw_url)).text() : f.content); } catch {} }
    const m = syncMerge(favorites, categories, syncBase, remote);
    // link publicado de la extensión: la app lo actualiza cuando el computador está apagado
    const pub = publish.gistId && publish.owner ? { gistId: publish.gistId, owner: publish.owner, file: "lista.m3u" } : remote.pub;
    const next = { v: 1, items: m.items, tomb: m.tomb, categories: m.categories, catU: m.catU, pub };
    const same = (a, b) => JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 });
    if (!same(next, { v: remote.v, items: remote.items, tomb: remote.tomb, categories: remote.categories, catU: remote.catU, pub: remote.pub })) {
      await ghApi(`/gists/${id}`, token, { method: "PATCH", body: JSON.stringify({ files: { [SYNC_FILE]: { content: JSON.stringify({ ...next, at: Date.now() }) } } }) });
    }
    const newFavs = syncApply(favorites, m.items);
    const changedLocal = JSON.stringify(newFavs) !== JSON.stringify(favorites) || JSON.stringify(m.categories) !== JSON.stringify(categories);
    const toSet = { syncBase: m.base, syncMeta: { lastSync: Date.now(), count: m.items.length, error: "", reason } };
    if (changedLocal) Object.assign(toSet, { favorites: newFavs, categories: m.categories, syncApplying: Date.now() });
    await chrome.storage.local.set(toSet);
  } catch (e) {
    const { syncMeta = {} } = await chrome.storage.local.get("syncMeta");
    await chrome.storage.local.set({ syncMeta: { ...syncMeta, error: String(e.message || e), lastTry: Date.now() } });
  } finally {
    syncBusy = false;
    if (syncAgain) { syncAgain = false; setTimeout(() => syncNow("repetir"), 500); }
  }
}
function syncSoon() { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow("cambio"), 3000); }
