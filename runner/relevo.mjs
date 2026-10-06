// +4dBu TV · RELEVO: el mismo Chrome de GitHub que encontró el video te lo pasa a tu reproductor.
// Muchos servidores (Voe, Filemoon…) amarran el link a la red y a la dirección de quien lo pidió (asn=…, i=…):
// abierto desde otra red responde 403. Aquí cada pedazo del video lo pide ESTE computador de GitHub (misma
// dirección, mismas cookies, mismo Referer) y lo entrega por un túnel gratis de Cloudflare (trycloudflare.com).
// Las listas .m3u8 se reescriben para que cada pedazo también pase por aquí. Solo responde con su llave (K).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execSync } from "node:child_process";
import { Readable } from "node:stream";

const CF_BIN = path.resolve("cloudflared");
const CF_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "range", "access-control-expose-headers": "content-length, content-range, accept-ranges" };
const EXT = /\.(m3u8|mpd|ts|m4s|mp4|m4v|aac|m4a|vtt|webvtt|key|webm|mp3)(?=[?#]|$)/i;

export async function startRelay({ ctx, referer = "", ua, log = () => {}, port = 8787 }) {
  const K = crypto.randomBytes(12).toString("hex");
  let base = "", last = Date.now(), served = 0;
  const enc = (u) => Buffer.from(u).toString("base64url"), dec = (s) => Buffer.from(s, "base64url").toString();
  const via = (u, b) => { const abs = new URL(u, b).href; return `${base}/h/${K}/${enc(abs)}.${(abs.match(EXT) || [, "bin"])[1].toLowerCase()}`; };
  const origin = (() => { try { return new URL(referer).origin; } catch { return ""; } })();
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    if (req.url === `/ping/${K}`) { last = Date.now(); res.writeHead(200, { ...CORS, "content-type": "text/plain" }); return res.end("ok"); }
    const m = req.url.match(/^\/h\/([a-f0-9]+)\/([\w-]+)\.\w+/);
    if (!m || m[1] !== K) { res.writeHead(404, CORS); return res.end(); }
    last = Date.now(); served++;
    let target; try { target = dec(m[2]); new URL(target); } catch { res.writeHead(400, CORS); return res.end(); }
    try {
      const cookies = (await ctx.cookies(target).catch(() => [])).map((c) => `${c.name}=${c.value}`).join("; ");
      const h = { "user-agent": ua, accept: "*/*", "accept-language": "es-CO,es;q=0.9,en;q=0.5" };
      if (referer) h.referer = referer;
      if (origin) h.origin = origin;
      if (cookies) h.cookie = cookies;
      if (req.headers.range) h.range = req.headers.range;
      const up = await fetch(target, { headers: h, redirect: "follow" });
      const ct = up.headers.get("content-type") || "";
      if (up.ok && req.method !== "HEAD" && (/mpegurl/i.test(ct) || /\.m3u8(\?|#|$)/i.test(target))) {
        const text = await up.text();
        if (text.replace(/^﻿/, "").trimStart().startsWith("#EXTM3U")) {
          const final = up.url || target;
          const out = text.split(/\r?\n/).map((line) => {
            const l = line.trim(); if (!l) return line;
            if (l.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_x, u) => `URI="${via(u, final)}"`);
            return via(l, final);
          }).join("\n");
          res.writeHead(200, { ...CORS, "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" });
          return res.end(out);
        }
        res.writeHead(up.status, { ...CORS, "content-type": ct || "text/plain" }); return res.end(text);
      }
      const hh = { ...CORS };
      for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) { const v = up.headers.get(k); if (v && !(k === "content-length" && up.headers.get("content-encoding"))) hh[k] = v; }
      res.writeHead(up.status, hh);
      if (!up.body || req.method === "HEAD") return res.end();
      Readable.fromWeb(up.body).on("error", () => res.destroy()).pipe(res);
    } catch (e) { if (!res.headersSent) res.writeHead(502, { ...CORS, "content-type": "text/plain" }); res.end(String(e?.message || e)); }
  });
  await new Promise((ok, ko) => server.once("error", ko).listen(port, "127.0.0.1", ok));
  if (process.env.RELAY_NO_TUNNEL) { base = `http://127.0.0.1:${port}`; return { base, K, url: (u) => via(u, u), local: (u) => via(u, u), idle: () => Date.now() - last, served: () => served, close: () => server.close() }; } // pruebas
  // túnel gratis de Cloudflare (sin cuenta): https://xxxx.trycloudflare.com → este computador
  if (!fs.existsSync(CF_BIN)) { log("descargando el túnel…"); execSync(`curl -sSL -o "${CF_BIN}" "${CF_URL}" && chmod +x "${CF_BIN}"`, { stdio: "ignore", timeout: 90000 }); }
  const cf = spawn(CF_BIN, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  base = await new Promise((ok, ko) => {
    const t = setTimeout(() => ko(new Error("el túnel no arrancó")), 60000);
    const read = (b) => { const m = String(b).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) { clearTimeout(t); ok(m[0]); } };
    cf.stdout.on("data", read); cf.stderr.on("data", read); cf.on("exit", () => ko(new Error("el túnel se cerró")));
  });
  // el nombre del túnel tarda unos segundos en existir en internet
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`${base}/ping/${K}`); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 1500)); }
  last = Date.now();
  return {
    base, K, url: (u) => via(u, u), local: (u) => via(u, u).replace(base, `http://127.0.0.1:${port}`),
    idle: () => Date.now() - last, served: () => served,
    close: () => { try { cf.kill(); } catch {} try { server.close(); } catch {} },
  };
}
