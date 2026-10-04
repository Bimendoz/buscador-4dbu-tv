// Documento invisible: el service worker no puede tocar el portapapeles directamente.
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.target !== "offscreen" || msg.action !== "copy") return;
  const t = document.getElementById("t");
  t.value = msg.text;
  t.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  sendResponse(ok);
});
