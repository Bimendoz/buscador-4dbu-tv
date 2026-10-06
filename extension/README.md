# HLS Stream Detector — versión 4 (v4.0.0)

Detecta los videos de cualquier página (directos HLS/DASH, videos .mp4/.webm y YouTube),
los analiza, los monitorea y los reúne en un solo link de lista M3U para VLC o apps IPTV como CarTV.

## Instalar
1. `chrome://extensions` → activa **Modo desarrollador**.
2. **Quita las versiones anteriores** para que no detecten dos veces.
3. **Cargar descomprimida** → selecciona esta carpeta `version 3`.

## Novedades de la versión 3
- **Videos de la página**: si una página tiene un video (.mp4, .webm, .mov…) en su reproductor, aparece como
  ARCHIVO con resolución, duración y tamaño. Se puede guardar, meter en la lista y ver en el monitor.
- **YouTube**: al abrir un video de YouTube (o una página con un YouTube incrustado) aparece como YOUTUBE,
  marcado EN VIVO o VIDEO. En los directos, la lista usa el **link del directo del canal**
  (`youtube.com/channel/…/live`), que siempre apunta a la transmisión actual y no caduca.
- **Listas para apps IPTV** (⚙ → Formato de la lista):
  - *VLC + apps IPTV* (recomendado): sirve en VLC, CarTV, TiviMate, IPTV Smarters y OTT Navigator.
  - *Solo apps IPTV*: añade el formato `url|User-Agent=…&Referer=…` que usan Kodi y otras apps (no sirve en VLC).
  - *Solo VLC*.
  Incluye grupos (En vivo / Grabados / Videos / YouTube) y logos.
- **Importar .m3u** entiende también listas en formato IPTV.

## Novedades de la versión 5.2 — No omite ningún link
- «Links a probar» en **0 / Todos** (por defecto): prueba TODO lo que aparezca, en orden: todos los links del directorio de todos los
  canales que coinciden → todos los sitios oficiales y todas sus páginas (código + reproductor en cada una) → todos los resultados de la web.
- Los canales cuyo idioma no dice el directorio ya no se omiten: salen como «Idioma sin confirmar».

## Novedades de la versión 5.0 — Idioma y escaneo global
- **Idioma** (selector en 🔎 Buscar): *Español latino* (por defecto), *Español (latino primero)*, *Español de España* o *Todos*.
  Usa el idioma y la zona que el directorio da a cada señal, y el audio que declara la lista HLS (si dice inglés, se descarta).
- **Países** (🔎 Buscar → «Países»): marca uno o varios países de habla hispana (o toda Latinoamérica). Se usan en la búsqueda por nombre y en el escaneo.
- **🌎 Escaneo global** (🔎 Buscar → Escaneo global): elige categoría y cuántos probar (los países, arriba).
  Prueba cada canal del directorio como CarTV y lista todos los que funcionan, en orden; marcas los que quieras y «Guardar».
  Canales pagos (Warner, HBO, ESPN…) no están en el directorio de canales gratuitos.

## Novedades de la versión 4.9 — Links a probar
- ⚙ → **Links a probar en cada búsqueda** (botón Guardar): la búsqueda prueba exactamente esa cantidad, uno por uno y en orden
  (directorio → sitio oficial → web), aunque alguno ya funcione. Tú eliges cuáles guardar. La app del iPhone usa el mismo ajuste.

## Novedades de la versión 4.2 — extraer de una página + puente con el iPhone
- **🔎 Buscar → «…o pega el link de la página donde está el video» → Extraer**: primero busca el link escrito
  en el código de la página; si no está, la abre por detrás (silenciada), le da play, captura el video y lo prueba como CarTV.
- **Puente con la app del iPhone** (Opciones → Puente): la app «Listas M3U» deja encargos (buscar un canal o
  extraer de una página) en un Gist secreto de tu GitHub; la extensión los atiende cada 30 s y le devuelve los
  links verificados. Usa el mismo GitHub de la lista publicada. Necesita el computador prendido con Chrome abierto.

## Novedades de la versión 4.0
Todo se configura en **⚙ Opciones** (popup → ⚙ → «Más opciones», o clic derecho en el ícono → Opciones).
1. **Revisión automática**: cada 30 min (ajustable) prueba todos tus guardados. Avisa de los que se caen
   (● CAÍDO en la tarjeta) y renueva solos los links vencidos o por vencer abriendo su página en segundo plano.
   Tu lista publicada se actualiza sola. En Guardados: «↻ Revisar todos».
2. **Página para el celular**: junto con tu lista se publica `canales.html` (se abre con gist.githack.com):
   tus canales por categoría, con logo, estado y un botón ▶ que abre CarTV/VLC en Android.
3. **Guía de programación (EPG)**: pega la dirección de una guía XMLTV y la lista la lleva (`url-tvg`).
   Cada canal usa su `tvg-id`: los de 🔎 Buscar ya lo traen; «Asignar identificador» busca el resto.
4. **Opciones completas**: ordenar categorías arrastrando, renombrarlas, mover o borrar varios canales a la vez,
   y copia de seguridad (.json, sin tokens ni claves) para restaurar o pasar a otro computador.
5. **Modo producción (+4dBu)**: nombre del evento, alertas por Telegram (bot propio) y/o WhatsApp (CallMeBot)
   cuando un monitor detecta una caída o recuperación, e historial de caídas con reporte .csv por evento.

## Novedades de la versión 3.2 — 🔎 Buscar canal
Escribe el nombre (p. ej. «Canal Capital») y la extensión lo busca sola, en segundo plano (puedes cerrar el popup):
1. En el directorio público de canales gratuitos de iptv-org (se guarda 24 h en caché).
2. Si ahí no hay uno que funcione, abre la página oficial del canal (o los primeros resultados de la web)
   en una pestaña de fondo silenciada y captura el directo.

Cada link se **prueba de verdad** antes de entregarlo: que la lista sea válida, que no tenga DRM, que un
segmento de video descargue y, si es en vivo, que el directo avance (no esté congelado). Solo aparecen los
✔ VERIFICADOS; los descartados muestran el motivo. Sin límite (v4.8.1): se prueban todos y tú eliges cuáles guardar.
Los resultados se guardan o se envían a una categoría con ☆ / 📁 como cualquier otro flujo.
Los links con 🔒 SOLO ESTA RED siguen dependiendo de la red donde se probaron.

## Novedades de la versión 3.1
- **Categorías propias**: en cada tarjeta, el selector 📁 guarda el link (o video) directo en una categoría,
  o lo mueve si ya estaba guardado. «+ Nueva categoría…» crea una al vuelo. En la lista M3U cada categoría
  es un grupo (`group-title`), así en CarTV/VLC no se mezclan. Las automáticas siguen: En vivo, Grabados, Videos, YouTube.
- **Guardados por secciones**: filtros por categoría, «Exportar» por categoría y 🗑 para borrar una categoría
  (sus links pasan a Automática, no se pierden).
- **+ Agregar link**: pega a mano un link de video o canal (.m3u8, .mp4, YouTube…) y elige su categoría.
- **Links que se renuevan solos**: si un guardado vuelve a aparecer con token nuevo (abres de nuevo la página),
  se actualiza en Guardados y en tu link de lista. El botón ↻ abre la página para renovarlo.
- La lista publicada y la exportada salen ordenadas por categoría. Importar un .m3u conserva sus categorías.

## Cómo usarlo en CarTV u otra app IPTV
1. En Guardados, conecta GitHub y copia tu link (ver versión 2).
2. En la app: agregar lista → «M3U por URL» / «Playlist URL» → pega el link.

## A tener en cuenta
- Los canales de YouTube se reproducen en VLC y Kodi, pero **no en apps IPTV** como CarTV:
  esas apps necesitan links de video directos y YouTube no los entrega de forma estable.
- Los links con token caducan (⏱): el link de la lista sigue, pero ese canal deja de reproducirse.
  También se reconoce el formato inicio + duración (`s=…&e=10800`).
- **🔒 SOLO ESTA RED** (v3.0.1): el link trae `asn=` o `ip=` y el servidor solo lo entrega a la misma conexión
  donde se capturó. En el celular con datos móviles u otro wifi no va a reproducir.
- Los flujos con DRM (RCN por web, Netflix…) no se pueden reproducir fuera de su sitio.
- Quien tenga el link de la lista puede verla.

## Grabar pasos (v5.6.0) — para enseñarle al Detector cómo lo haces tú
1. Abre la página del título en Chrome. En el popup toca el botón **●** (arriba, junto a Ajustes) → **Grabar esta pestaña**
   (o el atajo **Alt+Shift+R**). El ícono de la extensión muestra **REC** en las pestañas que se graban.
2. Haz a mano lo que harías para ver el video: tocar el servidor, cerrar la publicidad, darle play, cambiar de servidor…
   Con **Anotar** puedes dejar notas («este sí abrió», «aquí salió publicidad»).
3. **Detener y ver informe** (o Alt+Shift+R otra vez): se abre el informe paso a paso con tu dominio tapado
   («misitio.com»). **Copiar informe** y pegarlo en el chat.
- Se graba solo esa pestaña y las que se abran desde ella. Nada sale de tu computador; se guardan los últimos 8 informes.
- Si la página ya estaba abierta antes de instalar o actualizar la extensión, recárgala (F5) para que se graben los clics.
- Revisa el informe antes de pegarlo: el dominio se tapa en direcciones y títulos, pero un link codificado raro podría
  dejarlo a la vista. Puedes tapar más dominios tuyos en «Otros dominios a tapar».
