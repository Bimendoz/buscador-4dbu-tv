// Grabador de pasos (popup): botón ● de la barra de arriba. Lo que se graba lo hace el service worker
// (lib/recorder.js) y la página (content.js); aquí solo se enciende, se apaga, se anotan notas y se abre el informe.
(() => {
  const btn = document.getElementById("btnRec"), box = document.getElementById("recBox");
  let st = { on: false }, open = false, warn = "", nRecs = 0, myTab = null, stale = false;
  const ask = (m) => chrome.runtime.sendMessage(m).catch((e) => ({ ok: false, error: e.message }));
  const clock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const report = (id) => chrome.tabs.create({ url: chrome.runtime.getURL("informe.html" + (id ? "#" + id : "")) });
  const mk = (tag, props, ...kids) => el(tag, props, ...kids);
  const bt = (cls, ic, txt, fn) => { const b = mk("button", { className: "b " + cls }); setLabel(b, [ic, txt]); b.onclick = fn; return b; };
  let tm = null, cnt = null;
  function render() {
    btn.classList.toggle("on", !!st.on);
    btn.title = st.on ? "Grabando pasos… (toca para ver)" : "Grabar pasos: haz a mano lo que harías y sale un informe paso a paso (Alt+Shift+R)";
    box.hidden = !(open || st.on);
    if (box.hidden) return;
    if (st.on) {
      tm = mk("span", { className: "tm" }); cnt = mk("span");
      const here = myTab != null && st.tabs?.includes(myTab);
      const note = mk("input", { type: "text", placeholder: "Nota (p. ej.: «este servidor sí abrió», «aquí salió publicidad»)", maxLength: 600 });
      const addNote = async () => { const t = note.value.trim(); if (!t) return; const r = await ask({ action: "recNote", text: t }); if (r?.ok) { note.value = ""; flash(nb, "Anotada"); } };
      note.onkeydown = (e) => { if (e.key === "Enter") addNote(); };
      const nb = bt("mini", "edit", "Anotar", addNote);
      box.replaceChildren(
        mk("div", { className: "rh" }, icon("dot", 12), mk("span", { textContent: "Grabando pasos" }), tm),
        mk("p", { className: warn ? "warn" : "" , textContent: warn || (here ? "Haz a mano lo que harías para ver el video: entra al título, toca el servidor, cierra la publicidad, dale play… Todo queda anotado." : "Se está grabando en otra pestaña (y en las que se abran desde ella).") }),
        mk("div", { className: "row" }, note, nb),
        mk("div", { className: "row" }, bt("rec", "x", "Detener y ver informe", async () => { const r = await ask({ action: "recStop" }); st = { on: false }; open = false; warn = ""; render(); report(r?.id); })),
        cnt);
      cnt.className = "rc"; tick();
    } else {
      box.replaceChildren(
        mk("div", { className: "rh" }, icon("dot", 12), mk("span", { textContent: "Grabar pasos" })),
        mk("p", { textContent: "Para enseñarle al Detector cómo lo haces tú: enciende la grabación en esta pestaña y haz a mano lo que harías para ver un video. Se anotan tus clics, las páginas, iframes y pestañas que se abren, lo que pide el reproductor y si el video avanza. Al terminar sale un informe con tu dominio tapado, listo para copiar." }),
        stale ? mk("p", { className: "warn", textContent: "Chrome sigue usando la versión anterior de la extensión (sin el grabador). Toca «Actualizar la extensión»: se recarga sola en un segundo y vuelves a abrir este popup." }) : warn ? mk("p", { className: "warn", textContent: warn }) : null,
        stale ? mk("div", { className: "row" }, bt("rec", "refresh", "Actualizar la extensión", () => chrome.runtime.reload())) : null,
        mk("div", { className: "row" },
          bt("rec", "dot", "Grabar esta pestaña", async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const r = tab ? await ask({ action: "recStart", tabId: tab.id }) : { ok: false, error: "No hay pestaña" };
            if (!r) { stale = true; return render(); }
            if (!r.ok) { warn = r.error || "No se pudo empezar a grabar."; return render(); }
            warn = r.ready ? "" : "Esta página se abrió antes de instalar o actualizar la extensión: recárgala (F5) para que se graben tus clics. Lo de la red sí se está grabando.";
            await refresh();
          }),
          bt("", "file", nRecs ? `Informes (${nRecs})` : "Informes", () => report(""))));
    }
  }
  function tick() { if (st.on && tm) { tm.textContent = clock(Date.now() - st.startedAt); cnt.textContent = `${st.n} eventos anotados${st.full ? " · se llenó (detén y graba otra vez)" : ""}`; } }
  async function refresh() {
    const was = st.on;
    st = (await ask({ action: "recStatus" })) || { on: false };
    if (st.on !== was) render(); else tick();
  }
  btn.onclick = () => { open = !open || st.on; render(); };
  (async () => {
    try { [{ id: myTab } = {}] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch {}
    nRecs = ((await chrome.storage.local.get("recordings")).recordings || []).length;
    const s0 = await ask({ action: "recStatus" });
    if (!s0) stale = true; // el service worker viejo no conoce el grabador
    st = s0 || { on: false };
    render();
    setInterval(refresh, 1000);
  })();
})();
