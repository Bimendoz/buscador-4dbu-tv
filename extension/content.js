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
