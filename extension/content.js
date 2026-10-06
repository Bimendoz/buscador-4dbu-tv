// Revisa los reproductores <video> de la página (y de sus iframes) y avisa de los videos con link directo.
(() => {
  const sent = new Map(); // src -> ya se enviaron los metadatos (duración/resolución)
  function scan() {
    for (const v of document.querySelectorAll("video")) {
      const srcs = new Set([v.currentSrc, v.src, ...[...v.querySelectorAll("source")].map((s) => s.src)]);
      const hasMeta = Number.isFinite(v.duration) && v.duration > 0;
      for (const src of srcs) {
        if (!src || !/^https?:/i.test(src)) continue; // blob: = streaming (ya lo detecta la red)
        if (sent.has(src) && (sent.get(src) || !hasMeta)) continue;
        sent.set(src, hasMeta);
        chrome.runtime.sendMessage({
          action: "foundVideo", url: src,
          duration: hasMeta ? v.duration : 0, width: v.videoWidth || 0, height: v.videoHeight || 0, poster: v.poster || ""
        }).catch(() => {});
      }
    }
  }
  // Búsqueda de canal: la extensión abre la página en una pestaña de fondo y pide darle play
  // (silenciado) para que el reproductor cargue el directo aunque la página no tenga autoplay.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action !== "autoplay") return;
    for (const v of document.querySelectorAll("video")) { v.muted = true; v.play().catch(() => {}); }
    const btn = document.querySelector(".vjs-big-play-button, .jw-display-icon-display, .jw-icon-display, .plyr__control--overlaid, .fp-play, .play-button, button[aria-label*='play' i], button[title*='play' i], button[aria-label*='reproducir' i]");
    if (btn && ![...document.querySelectorAll("video")].some((v) => !v.paused)) btn.click();
  });
  scan();
  const timer = setInterval(scan, 3000);
  document.addEventListener("loadedmetadata", scan, true);
  window.addEventListener("pagehide", () => clearInterval(timer));
})();

// ---------- GRABADOR DE PASOS (apagado salvo que lo enciendas en el popup: botón ● «Grabar pasos») ----------
// Anota lo que TÚ haces (clics, listas, búsquedas, formularios) y lo que hace el reproductor (arranca, el video
// AVANZA, errores), en la página y en cada iframe. Mientras no grabes solo lee una marca y no hace nada más.
(() => {
  const TOP = window === window.top;
  let on = false, wired = false;
  const short = (s, n = 80) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const send = (e) => {
    if (!on) return;
    try { chrome.runtime.sendMessage({ action: "recEv", e: { ...e, at: location.href.slice(0, 600), top: TOP } }).catch(() => {}); } catch { on = false; }
  };
  const LONG = /^(href|src|action|onclick|value|formaction|data-.*)$/i;
  // la etiqueta tal como está en el código de la página (sin style), p. ej. <li class="option" data-post="12" data-nume="2">
  const tagOf = (e) => {
    if (!e?.tagName) return "";
    const a = [...e.attributes].filter((x) => x.name !== "style").slice(0, 16)
      .map((x) => (x.value === "" ? x.name : `${x.name}="${short(x.value, LONG.test(x.name) ? 220 : 70)}"`));
    return `<${e.tagName.toLowerCase()}${a.length ? " " + a.join(" ") : ""}>`;
  };
  const pathOf = (e) => {
    const p = [];
    for (let x = e; x && x.nodeType === 1 && p.length < 6 && x !== document.body && x !== document.documentElement; x = x.parentElement) {
      let s = x.tagName.toLowerCase();
      if (x.id) s += "#" + x.id; else if (x.classList.length) s += "." + [...x.classList].slice(0, 2).join(".");
      p.unshift(s);
    }
    return p.join(" > ");
  };
  const CLICKABLE = "a,button,[role=button],[role=tab],[role=option],[role=menuitem],li,option,label,summary,[onclick],[data-src],[data-video],[data-url],[data-embed],[data-link],[data-player],[data-server],[data-id],[data-post],[data-nume],[data-type],[data-tab],input,select,video,iframe";
  const rectOf = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
  const labelOf = (x) => short(x.innerText || x.textContent || x.getAttribute("title") || x.getAttribute("aria-label") || x.getAttribute("alt") || "", 90);
  // ¿es una opción dentro de un grupo? (Servidor 1, 2, 3… / Latino, Subtitulado… / temporadas)
  const siblingsOf = (e) => {
    const p = e.parentElement; if (!p) return null;
    const same = [...p.children].filter((x) => x.tagName === e.tagName);
    if (same.length < 2 || same.length > 60) return null;
    return { n: same.length, i: same.indexOf(e) + 1, list: same.slice(0, 15).map((x) => labelOf(x).slice(0, 40) || "(sin texto)") };
  };
  // los padres que tienen atributos (el <a> que envuelve un <li>, el contenedor de servidores…)
  const upOf = (e) => { const o = []; for (let x = e.parentElement; x && o.length < 3 && x !== document.body; x = x.parentElement) if (x.attributes.length) o.push(tagOf(x)); return o; };
  // el código del bloque donde está la opción (sin scripts ni estilos), para ver cómo están armados los servidores
  const blockOf = (e, sib) => {
    let b = sib ? e.parentElement : e.parentElement?.parentElement || e.parentElement;
    if (b && b.outerHTML.length < 300 && b.parentElement && b.parentElement !== document.body) b = b.parentElement;
    if (!b || b === document.body) return "";
    const c = b.cloneNode(true); c.querySelectorAll("script,style,svg,noscript").forEach((x) => x.remove());
    return c.outerHTML.replace(/\s+/g, " ").slice(0, 2500);
  };
  function onClick(ev) {
    if (!on || !ev.isTrusted) return;
    const t = ev.target instanceof Element ? ev.target : ev.target?.parentElement; if (!t) return;
    const c = t.closest(CLICKABLE) || t;
    const r = rectOf(c), vw = innerWidth, vh = innerHeight;
    send({ k: "click", el: tagOf(c), hit: c !== t ? tagOf(t) : "", text: labelOf(c), path: pathOf(c),
      href: c.href ? String(c.href).slice(0, 600) : "", target: c.getAttribute("target") || "",
      x: Math.round(ev.clientX), y: Math.round(ev.clientY), box: r, vw, vh, cover: r.w * r.h > vw * vh * 0.6,
      sib: siblingsOf(c), up: upOf(c), block: blockOf(c, siblingsOf(c)), nv: document.querySelectorAll("video").length, nf: document.querySelectorAll("iframe").length });
  }
  function onChange(ev) {
    if (!on || !ev.isTrusted || !(ev.target instanceof HTMLSelectElement)) return;
    const s = ev.target, o = s.options[s.selectedIndex];
    send({ k: "select", el: tagOf(s), path: pathOf(s), text: short(o?.text, 80), value: short(o?.value, 300), opts: [...s.options].slice(0, 20).map((x) => short(x.text, 40)) });
  }
  function onSubmit(ev) {
    if (!on || !(ev.target instanceof HTMLFormElement)) return;
    const f = ev.target;
    const fields = [...f.elements].filter((x) => x.name && !/^(password|file)$/i.test(x.type || "")).slice(0, 15).map((x) => `${x.name}=${short(x.value, 120)}`);
    send({ k: "submit", el: tagOf(f), action: f.action ? String(f.action).slice(0, 500) : "", method: String(f.method || "get").toUpperCase(), fields });
  }
  function onKey(ev) {
    if (!on || !ev.isTrusted || ev.key !== "Enter" || !(ev.target instanceof HTMLInputElement) || ev.target.type === "password") return;
    send({ k: "enter", el: tagOf(ev.target), path: pathOf(ev.target), value: short(ev.target.value, 150) });
  }
  // el reproductor: arranca, AVANZA de verdad (1 s de video), o da error
  const vst = new WeakMap();
  const vInfo = (v) => ({ src: String(v.currentSrc || v.src || "").slice(0, 500), w: v.videoWidth || 0, h: v.videoHeight || 0,
    dur: v.duration === Infinity ? -1 : Number.isFinite(v.duration) ? Math.round(v.duration) : 0, muted: !!v.muted, el: tagOf(v), path: pathOf(v) });
  function onVideo(ev) {
    if (!on || !(ev.target instanceof HTMLMediaElement)) return;
    const v = ev.target;
    if (ev.type === "loadstart") { vst.delete(v); return; } // cambió de video (publicidad → película, otro servidor)
    let s = vst.get(v); if (!s) vst.set(v, (s = {}));
    if (ev.type === "playing" && !s.play) { s.play = true; s.t0 = v.currentTime; send({ k: "v-play", ...vInfo(v) }); }
    else if (ev.type === "timeupdate" && s.play && !s.ok && !v.paused && v.currentTime - s.t0 >= 1) { s.ok = true; send({ k: "v-ok", progress: +(v.currentTime - s.t0).toFixed(1), pos: Math.round(v.currentTime), ...vInfo(v) }); }
    else if (ev.type === "error" && !s.err) { s.err = true; send({ k: "v-err", code: v.error?.code || 0, msg: short(v.error?.message, 140), ...vInfo(v) }); }
  }
  const wire = () => {
    if (wired) return; wired = true;
    addEventListener("click", onClick, true); addEventListener("change", onChange, true);
    addEventListener("submit", onSubmit, true); addEventListener("keydown", onKey, true);
    for (const t of ["loadstart", "playing", "timeupdate", "error"]) document.addEventListener(t, onVideo, true);
  };
  const hello = () => {
    try {
      chrome.runtime.sendMessage({ action: "recHello", info: { url: location.href.slice(0, 700), top: TOP, title: short(document.title, 140),
        nv: document.querySelectorAll("video").length, nf: document.querySelectorAll("iframe").length, ref: short(document.referrer, 300),
        ifr: [...document.querySelectorAll("iframe")].map((f) => String(f.src || "").slice(0, 300)).filter(Boolean).slice(0, 12) } })
        .then((r) => { on = !!r?.on; if (on) wire(); }, () => {});
    } catch {}
  };
  const check = () => { try { chrome.storage.local.get("recActive").then((o) => { if (o.recActive?.on) hello(); else on = false; }, () => {}); } catch {} };
  try { chrome.storage.onChanged.addListener((c, a) => { if (a === "local" && c.recActive) check(); }); } catch {}
  chrome.runtime.onMessage.addListener((m, _s, reply) => { if (m?.action === "recPing") reply(true); });
  check();
})();
