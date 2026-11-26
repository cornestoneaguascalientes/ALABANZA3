/**
 * PROY-REMOTE.JS - Control remoto de la proyección desde el celular
 *
 * Cómo funciona:
 *  - La computadora (consola del operador) y el celular (control.html) se mandan mensajes por un servicio público
 *    de mensajería (ntfy.sh por defecto; se puede cambiar por uno propio en «Avanzado»).
 *  - El emparejamiento es un código secreto al azar (128 bits) que viaja en el QR. Los "buzones" se llaman como el código,
 *    así que solo quien tenga el QR/enlace puede controlar. «Nuevo código» invalida el anterior.
 *  - El celular manda órdenes (siguiente, anterior, negro, versículo…); la computadora responde con lo que se proyecta.
 *  - El QR se dibuja aquí mismo (sin servicios externos), para que el código secreto nunca salga de la computadora.
 *
 * Lo usan: la consola (host + ventana del QR) y control.html (solo Relay).
 */
(function (root) {
  'use strict';

  const Proy = root.Proy = root.Proy || {};
  const STORE = 'alabanza.remote.v1';
  const DEFAULT_SERVER = 'https://ntfy.sh';
  const utf8 = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const byteLen = (s) => (utf8 ? utf8.encode(s).length : s.length);
  const clip = (s, n) => { s = String(s == null ? '' : s).replace(/[ \t]+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  function newToken() {
    const a = new Uint8Array(16);
    (root.crypto || root.msCrypto).getRandomValues(a);
    let s = ''; a.forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const topics = (token) => ({ cmd: 'alab-' + token + '-c', st: 'alab-' + token + '-s' });

  // ============================================================
  // Relay: cliente mínimo de ntfy (publicar con POST, escuchar con SSE)
  // ============================================================
  const Relay = {
    base: (server) => String(server || DEFAULT_SERVER).replace(/\/+$/, ''),
    publish(server, topic, obj) {
      return fetch(Relay.base(server) + '/' + topic, { method: 'POST', body: JSON.stringify(obj) })
        .then((r) => { if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; e.retryAfter = Number(r.headers.get('Retry-After')) || 0; throw e; } return true; });
    },
    /** since: '' (solo lo nuevo) | 'latest' (el último guardado + lo nuevo). onMsg(cuerpo, mensajeNtfy). onStatus(true|false) */
    subscribe(server, topic, since, onMsg, onStatus) {
      let es = null, dead = false, retry = null;
      const url = Relay.base(server) + '/' + topic + '/sse' + (since ? '?since=' + since : '');
      function open() {
        if (dead) return;
        es = new EventSource(url);
        es.onopen = () => { if (onStatus) onStatus(true); };
        es.onerror = () => {
          if (onStatus) onStatus(false);
          if (es.readyState === 2) { clearTimeout(retry); retry = setTimeout(open, 3000); }   // cerrada del todo: reabrir
        };
        es.onmessage = (ev) => {                       // los "open" y "keepalive" llegan con otro tipo de evento y no pasan por aquí
          let m, body;
          try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.event && m.event !== 'message') return;
          try { body = JSON.parse(m.message); } catch (e) { return; }
          onMsg(body, m);
        };
      }
      open();
      return { close() { dead = true; clearTimeout(retry); if (es) es.close(); } };
    }
  };

  // ============================================================
  // QR (modo bytes, corrección M, versiones 1 a 12). Sin dependencias.
  // ============================================================
  const QR = (function () {
    const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22];        // nivel M, por versión
    const NUM_BLOCKS = [0, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 5, 8];

    const bit = (x, i) => ((x >>> i) & 1) !== 0;
    function rawModules(ver) {
      let r = (16 * ver + 128) * ver + 64;
      if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
      return r;
    }
    const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

    function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z; }
    function rsDivisor(deg) {
      const res = []; for (let i = 0; i < deg - 1; i++) res.push(0); res.push(1);
      let rt = 1;
      for (let i = 0; i < deg; i++) {
        for (let j = 0; j < res.length; j++) { res[j] = gfMul(res[j], rt); if (j + 1 < res.length) res[j] ^= res[j + 1]; }
        rt = gfMul(rt, 0x02);
      }
      return res;
    }
    function rsRemainder(data, div) {
      const res = div.map(() => 0);
      data.forEach((b) => {
        const f = b ^ res.shift(); res.push(0);
        div.forEach((c, i) => { res[i] ^= gfMul(c, f); });
      });
      return res;
    }
    function alignPos(ver) {
      if (ver === 1) return [];
      const n = Math.floor(ver / 7) + 2, step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2, res = [6];
      for (let pos = ver * 4 + 10; res.length < n; pos -= step) res.splice(1, 0, pos);
      return res;
    }

    function encode(text) {
      const data = Array.from(utf8 ? utf8.encode(text) : text).map((c) => (typeof c === 'number' ? c : c.charCodeAt(0)));
      let ver = 1;
      for (; ver <= 12; ver++) {
        const cap = dataCodewords(ver) * 8, need = 4 + (ver < 10 ? 8 : 16) + data.length * 8;
        if (need <= cap) break;
      }
      if (ver > 12) throw new Error('Texto demasiado largo para el QR');
      // bits de datos
      const bits = [];
      const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
      put(0x4, 4); put(data.length, ver < 10 ? 8 : 16); data.forEach((b) => put(b, 8));
      const capBits = dataCodewords(ver) * 8;
      put(0, Math.min(4, capBits - bits.length));
      put(0, (8 - bits.length % 8) % 8);
      for (let pad = 0xEC; bits.length < capBits; pad ^= 0xEC ^ 0x11) put(pad, 8);
      const cw = [];
      for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; cw.push(v); }

      // bloques + corrección de errores
      const nb = NUM_BLOCKS[ver], eccLen = ECC_PER_BLOCK[ver], raw = Math.floor(rawModules(ver) / 8);
      const nShort = nb - raw % nb, shortLen = Math.floor(raw / nb), div = rsDivisor(eccLen), blocks = [];
      for (let i = 0, k = 0; i < nb; i++) {
        const dat = cw.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1)); k += dat.length;
        const ecc = rsRemainder(dat, div);
        if (i < nShort) dat.push(0);
        blocks.push(dat.concat(ecc));
      }
      const all = [];
      for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) all.push(b[i]); });

      // matriz
      const size = ver * 4 + 17;
      const mod = [], fn = [];
      for (let y = 0; y < size; y++) { mod.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
      const setFn = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
      for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
      [[3, 3], [size - 4, 3], [3, size - 4]].forEach(([cx, cy]) => {
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
        }
      });
      const ap = alignPos(ver), last = ap.length - 1;
      ap.forEach((ax, i) => ap.forEach((ay, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }));
      function formatBits(mask) {
        const d = (0 << 3) | mask;                      // nivel M = 0
        let rem = d; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const b = ((d << 10) | rem) ^ 0x5412;
        for (let i = 0; i <= 5; i++) setFn(8, i, bit(b, i));
        setFn(8, 7, bit(b, 6)); setFn(8, 8, bit(b, 7)); setFn(7, 8, bit(b, 8));
        for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(b, i));
        for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(b, i));
        for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(b, i));
        setFn(8, size - 8, true);
      }
      formatBits(0);
      if (ver >= 7) {
        let rem = ver; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
        const b = (ver << 12) | rem;
        for (let i = 0; i < 18; i++) { const c = bit(b, i), a = size - 11 + i % 3, bb = Math.floor(i / 3); setFn(a, bb, c); setFn(bb, a, c); }
      }
      // datos en zigzag
      for (let i = 0, right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
          const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
          if (!fn[y][x] && i < all.length * 8) { mod[y][x] = bit(all[i >>> 3], 7 - (i & 7)); i++; }
        }
      }
      // máscara: se prueba cada una y se queda la de menor penalización
      const flip = (m) => {
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          let inv;
          switch (m) {
            case 0: inv = (x + y) % 2 === 0; break;
            case 1: inv = y % 2 === 0; break;
            case 2: inv = x % 3 === 0; break;
            case 3: inv = (x + y) % 3 === 0; break;
            case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
            case 5: inv = x * y % 2 + x * y % 3 === 0; break;
            case 6: inv = (x * y % 2 + x * y % 3) % 2 === 0; break;
            default: inv = ((x + y) % 2 + x * y % 3) % 2 === 0;
          }
          if (!fn[y][x] && inv) mod[y][x] = !mod[y][x];
        }
      };
      function penalty() {
        let p = 0;
        for (let y = 0; y < size; y++) {                       // rachas de 5+ iguales (filas y columnas)
          for (const dir of [0, 1]) {
            let run = 1;
            for (let i = 1; i < size; i++) {
              const a = dir ? mod[i][y] : mod[y][i], b = dir ? mod[i - 1][y] : mod[y][i - 1];
              if (a === b) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
            }
          }
        }
        for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = mod[y][x]; if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3; }
        let dark = 0; mod.forEach((row) => row.forEach((c) => { if (c) dark++; }));
        p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
        return p;
      }
      let best = 0, bestP = Infinity;
      for (let m = 0; m < 8; m++) {
        flip(m); formatBits(m);
        const p = penalty();
        if (p < bestP) { bestP = p; best = m; }
        flip(m);                                               // deshace
      }
      flip(best); formatBits(best);
      return { size, version: ver, get: (x, y) => mod[y][x] };
    }

    /** Dibuja el QR en un canvas (fondo blanco con margen, aunque la página sea oscura) */
    function draw(canvas, text, px) {
      const q = encode(text), s = px || 6, quiet = 4, n = q.size + quiet * 2;
      canvas.width = canvas.height = n * s;
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
      g.fillStyle = '#000';
      for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.get(x, y)) g.fillRect((x + quiet) * s, (y + quiet) * s, s, s);
      return q;
    }
    return { encode, draw };
  })();

  // ============================================================
  // Configuración guardada (código secreto, servidor, si está activado)
  // ============================================================
  function loadCfg() {
    try { const c = JSON.parse(localStorage.getItem(STORE)); if (c && c.token) return Object.assign({ server: DEFAULT_SERVER, enabled: false }, c); } catch (e) { /* noop */ }
    return { token: newToken(), server: DEFAULT_SERVER, enabled: false };
  }
  function saveCfg(c) { try { localStorage.setItem(STORE, JSON.stringify(c)); } catch (e) { /* noop */ } }


  // ============================================================
  // Música: Secuencia (multitrack.js), Pad (pads.js) y Metrónomo (metronome.js). Se leen/controlan si existen en la página.
  // ============================================================
  const Music = {
    state() {
      const out = { t: 'm', v: 1 };
      try { if (root.Multitrack && root.Multitrack.remote) out.mt = root.Multitrack.remote.state(); } catch (e) { /* noop */ }
      try { if (root.Pads) out.pad = { on: root.Pads.isPlaying() ? 1 : 0, tone: root.Pads.getCurrentTone(), vol: Math.round(root.Pads.getVolume() * 100) }; } catch (e) { /* noop */ }
      try {
        if (root.Metronome) {
          const m = root.Metronome.getMeter();
          out.met = { on: root.Metronome.isPlaying() ? 1 : 0, bpm: root.Metronome.getBPM(), n: m.beats, d: m.den, vol: Math.round(root.Metronome.getVolume() * 100) };
        }
      } catch (e) { /* noop */ }
      if (out.mt) {                                    // límite de ~4 KB por mensaje
        out.mt.list = out.mt.list.map((x) => [x[0], clip(x[1], 28)]);
        out.mt.title = clip(out.mt.title, 40); out.mt.msg = clip(out.mt.msg, 80); out.mt.badge = clip(out.mt.badge, 40);
        if (byteLen(JSON.stringify(out)) > 3700) out.mt.list = out.mt.list.slice(0, 30);
        if (byteLen(JSON.stringify(out)) > 3700) out.mt.list = out.mt.list.slice(0, 12);
      }
      return out;
    },
    /** Ejecuta una orden del celular. Devuelve true si era de música. */
    cmd(m) {
      const a = String(m.a || ''), M = root.Multitrack && root.Multitrack.remote;
      const num = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
      switch (a) {
        case 'mt.play': if (M) M.play(); return true;
        case 'mt.pause': if (M) M.pause(); return true;
        case 'mt.stop': if (M) M.stop(); return true;
        case 'mt.seek': if (M) M.seekFraction(num(m.f, 0, 1)); return true;
        case 'mt.load': if (M) M.load(String(m.id)); return true;
        case 'mt.vol': if (M) M.vol(String(m.id), num(m.v, 0, 100) / 100); return true;
        case 'mt.mute': if (M) M.mute(String(m.id)); return true;
        case 'mt.solo': if (M) M.solo(String(m.id)); return true;
        case 'mt.pitch': if (M) M.pitch(num(m.d, -1, 1) < 0 ? -1 : 1); return true;
        case 'mt.mode': if (M) M.mode(m.mode === 'split' ? 'split' : 'stereo'); return true;
        case 'pad.toggle': if (root.Pads) root.Pads.toggle(); return true;
        case 'pad.tone': if (root.Pads) root.Pads.changeTone(String(m.tone || '')); return true;
        case 'pad.vol': if (root.Pads) root.Pads.setVolume(num(m.v, 0, 100) / 100); return true;
        case 'met.toggle': if (root.Metronome) root.Metronome.toggle(); return true;
        case 'met.bpm': if (root.Metronome) root.Metronome.setBPM(num(m.v, 40, 240)); return true;
        case 'met.tap': if (root.Metronome) root.Metronome.tapTempo(); return true;
        case 'met.vol': if (root.Metronome) root.Metronome.setVolume(num(m.v, 0, 100) / 100); return true;
        case 'm.sync': return true;
        default: return false;
      }
    }
  };

  // ============================================================
  // Host: vive en la consola. Escucha órdenes del celular y le manda el estado.
  // api: { C: controlador, bible(q, modo), bibleMore(), staged(), outputs() }
  // ============================================================
  function createHost(api) {
    const C = api.C;
    let cfg = loadCfg(), sub = null, offChange = null, hb = null, trail = null, lastPush = 0, phoneAt = 0, relayOk = false;
    let musicWantAt = 0, musicKey = '', musicTrail = null, musicLast = 0, musicTimer = null, musicQuietUntil = 0, sKey = '', retryT = null;
    const seen = new Set(), listeners = new Set();
    const T = () => topics(cfg.token);

    const status = () => ({ enabled: cfg.enabled, relay: relayOk, phone: Date.now() - phoneAt < 150000, server: cfg.server });
    const emitStatus = () => listeners.forEach((fn) => { try { fn(status()); } catch (e) { /* noop */ } });
    const send = (obj) => Relay.publish(cfg.server, T().st, obj).catch((e) => {
      if (e && e.status === 429) {                                         // servicio ocupado: se vuelve a mandar el estado más reciente después
        clearTimeout(retryT);
        retryT = setTimeout(() => { sKey = ''; musicKey = ''; push(true, true); pushMusic(true, true); }, Math.max(4000, (e.retryAfter || 0) * 1000));
        return;
      }
      relayOk = false; emitStatus();
    });

    const plain = (s) => {
      if (!s) return '';
      if (s.kind === 'bible' && s.versions && s.versions[0]) return s.versions[0].text + '\n— ' + s.versions[0].ref;
      if (s.text) return s.text;
      return s.kind === 'media' ? '[imagen o video]' : s.kind === 'countdown' ? '[cuenta regresiva]' : '';
    };
    const typeCode = (it) => ({ song: 's', bible: 'b', text: 't', media: 'm', countdown: 'c' }[it.type] || 't');

    function buildState() {
      const items = C.list(), cur = C.cursor, serv = C.service.items;
      const it = cur ? items[cur.item] : null;
      const slide = C.current();
      let nx = C.nextOf(cur, items);
      if (C.settings.stopAtItemEnd && nx && cur && nx.item !== cur.item) nx = null;
      const nxSlide = nx ? C.slidesOf(items[nx.item])[nx.slide] : null;
      const sm = C.mode === 'service';
      const st = {
        t: 's', v: 1, mode: C.mode,
        live: slide ? { l: slide.label || '', p: slide.part || '', c: slide.color || '', x: clip(plain(slide), 240).replace(/\n/g, '\n') } : null,
        nx: nxSlide ? clip(plain(nxSlide), 120) : '',
        it: it ? clip(it.title, 40) : '',
        pos: cur ? [cur.item + 1, items.length, cur.slide + 1, C.slidesOf(it).length] : null,
        f: [C.flags.black ? 1 : 0, C.flags.clear ? 1 : 0, C.flags.logo ? 1 : 0],
        cd: C.countdown ? { r: Math.max(0, C.countdown.endAt - Date.now()), l: clip(C.countdown.label, 30) } : null,
        sm: C.stageMsg || '',
        ok: api.outputs ? api.outputs() : 0,
        st: null,
        list: serv.slice(0, 40).map((x) => [clip(x.title, 28), typeCode(x), C.slidesOf(x).length]),
        cur: sm && cur ? [cur.item, cur.slide] : null,
        sl: sm && it ? C.slidesOf(it).slice(0, 30).map((s) => clip(plain(s).replace(/\n/g, ' '), 18)) : []
      };
      const sg = api.staged && api.staged();
      if (sg) st.st = { t: clip(sg.title, 40), x: clip(sg.text, 220), n: sg.n };
      // el mensaje de ntfy admite ~4 KB: si no cabe, se recorta lo accesorio
      if (byteLen(JSON.stringify(st)) > 3700) st.sl = [];
      if (byteLen(JSON.stringify(st)) > 3700) st.list = st.list.slice(0, 20);
      if (byteLen(JSON.stringify(st)) > 3700) st.list = [];
      return st;
    }

    /** skipThrottle: no esperar el intervalo mínimo. always: mandarlo aunque no haya cambiado (saludo / latido) */
    function push(skipThrottle, always) {
      if (!cfg.enabled) return;
      const now = Date.now();
      clearTimeout(trail);
      const wait = 1200 - (now - lastPush);               // máximo un estado cada ~1.2 s
      if (!skipThrottle && wait > 0) { trail = setTimeout(() => push(true, always), wait); return; }
      const st = buildState();
      const key = JSON.stringify(st, (k, v) => (k === 'r' ? undefined : v));     // lo que falta de la cuenta cambia siempre: no cuenta
      if (!always && key === sKey) return;                // nada cambió: no se gasta un mensaje
      sKey = key; lastPush = now;
      send(st);
    }

    // Música: se publica solo mientras el celular tiene abierta la pestaña Música (avisa con m:1 en cada ping)
    const wantsMusic = () => Date.now() - musicWantAt < 150000;
    function pushMusic(skipThrottle, always) {
      if (!cfg.enabled || !wantsMusic()) return;
      clearTimeout(musicTrail);
      if (!always && Date.now() < musicQuietUntil) return;          // mientras mueves volúmenes no se contesta cada paso; el siguiente cambio lo manda
      const st = Music.state();
      const key = JSON.stringify(st, (k, v) => (k === 'pos' ? undefined : v));       // la posición cambia siempre: no cuenta como "cambio"
      if (!always && key === musicKey) return;
      const wait = 1000 - (Date.now() - musicLast);
      if (!skipThrottle && wait > 0) { musicTrail = setTimeout(() => pushMusic(true, always), wait); return; }
      musicKey = key; musicLast = Date.now();
      send(st);
    }
    const note = (text, err) => { if (cfg.enabled) send({ t: 'n', text: String(text || ''), err: !!err }); };

    function onCmd(m, raw) {
      if (!m || m.t !== 'c' || !cfg.enabled) return;
      const id = raw && raw.id;
      if (id) { if (seen.has(id)) return; seen.add(id); if (seen.size > 300) seen.delete(seen.values().next().value); }
      if (raw && raw.time && Date.now() / 1000 - raw.time > 30) return;     // orden vieja (p. ej. al reconectar)
      phoneAt = Date.now(); relayOk = true; emitStatus();
      if (m.m) musicWantAt = Date.now();                       // el celular está viendo la pestaña Música
      try {
        if (typeof m.a === 'string' && /^(mt|pad|met|m)\./.test(m.a)) {
          Music.cmd(m);
          if (/^(mt\.vol|pad\.vol|met\.vol|met\.bpm)$/.test(m.a)) musicQuietUntil = Date.now() + 2500; else pushMusic(true, m.a === 'm.sync');
          return;
        }
        switch (m.a) {
          case 'hello': push(true, true); pushMusic(true, true); break;
          case 'next': C.next(); break;
          case 'prev': C.prev(); break;
          case 'nextItem': C.jumpItem(1); break;
          case 'prevItem': C.jumpItem(-1); break;
          case 'black': case 'clear': case 'logo': C.toggleFlag(m.a); break;
          case 'go': C.go(Math.max(0, m.i | 0), Math.max(0, m.j | 0)); break;
          case 'cdStart': C.startCountdown(Math.min(600, Math.max(0, Number(m.min) || 0)), clip(m.label, 40) || undefined); break;
          case 'cdStop': C.stopCountdown(); break;
          case 'stage': C.setStageMsg(clip(m.text, 200)); break;
          case 'bible': { const r = api.bible(String(m.q || ''), m.mode === 'project' ? 'project' : 'stage'); if (r && r.error) note(r.error, true); else push(true); break; }
          case 'bibleMore': api.bibleMore(); break;
          default: break;
        }
      } catch (e) { note('Error en la computadora: ' + (e && e.message), true); }
    }

    function start() {
      stop();
      if (!cfg.enabled) { emitStatus(); return; }
      sub = Relay.subscribe(cfg.server, T().cmd, '', onCmd, (ok) => { relayOk = ok; emitStatus(); });
      offChange = C.onChange(() => push());
      hb = setInterval(() => { if (Date.now() - phoneAt < 300000) { push(true, true); pushMusic(true, true); } emitStatus(); }, 60000);   // latido cada minuto, solo si hay un celular
      musicTimer = setInterval(() => pushMusic(false), 1000);       // detecta cambios de música hechos en la computadora
      push(true, true);
      emitStatus();
    }
    function stop() {
      if (sub) { sub.close(); sub = null; }
      if (offChange) { offChange(); offChange = null; }
      clearInterval(hb); clearInterval(musicTimer); clearTimeout(trail); clearTimeout(musicTrail); clearTimeout(retryT); relayOk = false;
    }

    const host = {
      cfg: () => cfg, status, push, note, start, stop,
      onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      setEnabled(on) { cfg.enabled = !!on; saveCfg(cfg); if (cfg.enabled) start(); else { stop(); emitStatus(); } },
      rotate() { cfg.token = newToken(); saveCfg(cfg); phoneAt = 0; if (cfg.enabled) start(); emitStatus(); },
      setServer(s) { cfg.server = Relay.base(s || DEFAULT_SERVER); saveCfg(cfg); if (cfg.enabled) start(); emitStatus(); },
      url() {
        const u = new URL('control.html', root.location.href);
        u.hash = 't=' + cfg.token + (cfg.server !== DEFAULT_SERVER ? '&s=' + encodeURIComponent(cfg.server) : '');
        return u.href;
      }
    };
    return host;
  }

  // ============================================================
  // Ventana de emparejamiento (QR) en la consola
  // ============================================================
  function openDialog(host) {
    if (typeof document === 'undefined') return;
    if (!host.cfg().enabled) host.setEnabled(true);            // al abrir el panel por primera vez se activa
    const dlg = document.createElement('dialog');
    dlg.className = 'pj-dlg';
    dlg.innerHTML =
      '<h3 style="margin:0 0 8px">📱 Control remoto desde el celular</h3>' +
      '<p class="pj-help" style="margin-top:0">Abre la cámara del celular, apunta a este código y toca el enlace. Los dos (computadora y celular) necesitan internet. No hace falta que estén en la misma red.</p>' +
      '<div style="display:flex;justify-content:center;margin:10px 0"><canvas id="rm-qr" style="width:240px;height:240px;border-radius:8px;image-rendering:pixelated;max-width:100%"></canvas></div>' +
      '<div class="pj-row"><input class="pj-in" id="rm-url" readonly><button class="pj-btn sm" id="rm-copy" type="button">Copiar enlace</button></div>' +
      '<p class="pj-help" id="rm-status" style="font-weight:600"></p>' +
      '<label class="pj-chk"><input type="checkbox" id="rm-on"> Control remoto activado</label>' +
      '<p class="pj-help">⚠️ Quien tenga este código puede controlar tu proyección. No lo compartas. Si se filtra, toca «Nuevo código» y el anterior deja de funcionar.</p>' +
      '<details class="pj-add"><summary>Avanzado</summary>' +
      '<label class="pj-fld">Servidor de mensajes (ntfy)<input class="pj-in" id="rm-server" placeholder="https://ntfy.sh"></label>' +
      '<div class="pj-row"><button class="pj-btn sm" id="rm-save" type="button">Guardar servidor</button><button class="pj-btn sm danger" id="rm-new" type="button">Nuevo código</button></div></details>' +
      '<div class="pj-row" style="justify-content:flex-end"><button class="pj-btn primary" id="rm-close" type="button">Cerrar</button></div>';
    document.body.appendChild(dlg);
    const $ = (id) => dlg.querySelector('#' + id);
    let off = null;

    function paint() {
      const url = host.url();
      $('rm-url').value = url;
      try { QR.draw($('rm-qr'), url, 6); } catch (e) { $('rm-qr').getContext('2d').clearRect(0, 0, 10, 10); $('rm-status').textContent = 'No se pudo dibujar el QR: usa el enlace.'; }
      $('rm-on').checked = host.cfg().enabled;
      $('rm-server').value = host.cfg().server;
      paintStatus(host.status());
    }
    function paintStatus(s) {
      const el = $('rm-status');
      if (!s.enabled) { el.textContent = '⏸ Desactivado'; el.style.color = ''; return; }
      if (!s.relay) { el.textContent = '🔴 Sin conexión con el servicio de mensajes (revisa el internet de la computadora)'; el.style.color = '#ff6b6b'; return; }
      el.textContent = s.phone ? '🟢 Celular conectado' : '🟡 Listo. Esperando que el celular escanee el código…';
      el.style.color = s.phone ? '#3fb950' : '';
    }
    off = host.onStatus((s) => { if (dlg.open) paintStatus(s); });
    $('rm-copy').onclick = () => { $('rm-url').select(); try { navigator.clipboard.writeText($('rm-url').value); $('rm-copy').textContent = '¡Copiado!'; setTimeout(() => { $('rm-copy').textContent = 'Copiar enlace'; }, 1500); } catch (e) { document.execCommand('copy'); } };
    $('rm-on').onchange = (e) => { host.setEnabled(e.target.checked); paint(); };
    $('rm-save').onclick = () => { host.setServer($('rm-server').value.trim()); paint(); };
    $('rm-new').onclick = () => { if (confirm('Se crea un código nuevo y el celular conectado tendrá que escanear otra vez. ¿Continuar?')) { host.rotate(); paint(); } };
    $('rm-close').onclick = () => dlg.close();
    dlg.addEventListener('close', () => { if (off) off(); dlg.remove(); });
    paint();
    dlg.showModal();
  }

  Proy.Remote = { Relay, QR, Music, createHost, openDialog, loadCfg, saveCfg, topics, newToken, DEFAULT_SERVER, clip };
  if (typeof module !== 'undefined' && module.exports) module.exports = Proy.Remote;
})(typeof window !== 'undefined' ? window : globalThis);
