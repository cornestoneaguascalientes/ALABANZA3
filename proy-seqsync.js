/**
 * PROY-SEQSYNC.JS - Las diapositivas de la letra siguen a la secuencia (multitrack)
 *
 * Idea: se graban UNA vez los tiempos de cada canción (en qué segundo cambia cada diapositiva) y después,
 * al darle play a la secuencia, la proyección cambia sola en esos segundos.
 *
 *  - Grabar: se activa «Grabar tiempos», se le da play a la secuencia y se pasan las diapositivas como siempre
 *    (flechas, clic, botón del celular…). Cada cambio de diapositiva anota el segundo de la secuencia.
 *    Se puede regresar a una diapositiva (coros repetidos) y también se anota.
 *  - Seguir: con «Las diapositivas siguen a la secuencia» activado, cada tick (80 ms, en un Worker para que no se frene
 *    con la ventana en segundo plano) calcula la diapositiva que toca según la posición de la secuencia.
 *    Adelantar, regresar o pausar la secuencia se respeta. Un cambio manual se respeta hasta la siguiente marca.
 *  - Los tiempos se guardan en este navegador (localStorage), por canción de la biblioteca.
 *
 * api (la pone la consola): { C, itemFor(id), quickFor(id), toast(msg, tipo) }
 */
(function (root) {
  'use strict';

  const Proy = root.Proy = root.Proy || {};
  const KEY = 'alabanza.seqsync.v1';
  const r2 = (n) => Math.round(n * 100) / 100;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (s) => { s = Math.max(0, Number(s) || 0); const m = Math.floor(s / 60); return m + ':' + (s - m * 60).toFixed(1).padStart(4, '0'); };

  function loadCfg() {
    try { const c = JSON.parse(localStorage.getItem(KEY)); if (c && typeof c === 'object') return Object.assign({ follow: false, lead: 0.25, songs: {} }, c); } catch (e) { /* noop */ }
    return { follow: false, lead: 0.25, songs: {} };
  }
  function saveCfg(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) { /* noop */ } }

  /** Reloj en un Worker: no se frena aunque la ventana esté en segundo plano (igual que el metrónomo) */
  function ticker(fn, ms) {
    try {
      const src = 'let t=null;onmessage=e=>{if(e.data==="start"){clearInterval(t);t=setInterval(()=>postMessage(0),' + ms + ')}else{clearInterval(t)}}';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = fn;
      return { start: () => w.postMessage('start'), stop: () => { w.postMessage('stop'); w.terminate(); } };
    } catch (e) {
      let id = null;
      return { start: () => { id = setInterval(fn, ms); }, stop: () => clearInterval(id) };
    }
  }

  function create(api) {
    const C = api.C;
    let cfg = loadCfg(), rec = null, applied = null, offChange = null, tk = null, msg = '', msgAt = 0;
    const warned = {}, ncache = {}, listeners = new Set();
    const songKey = (id) => 'lib-' + id;
    const emit = () => listeners.forEach((fn) => { try { fn(); } catch (e) { /* noop */ } });
    const say = (text, type) => { msg = text; msgAt = Date.now(); if (api.toast) api.toast(text, type); emit(); };

    const seq = () => {
      try { return root.Multitrack && root.Multitrack.remote && root.Multitrack.remote.quick ? root.Multitrack.remote.quick() : null; } catch (e) { return null; }
    };

    /** Cuántas diapositivas tiene la canción (con la división actual). Se guarda en memoria 3 s para no rehacerla a cada rato */
    function slidesCount(id) {
      const hit = ncache[id];
      if (hit && Date.now() - hit.at < 3000) return hit.n;
      let n = 0;
      const idx = api.itemFor(id);
      if (idx >= 0) n = C.slidesOf(C.service.items[idx]).length;
      else {
        const q = C.mode === 'quick' && C.quick && C.quick.items[0];
        if (q && q.meta && q.meta.songId === songKey(id)) n = C.slidesOf(q).length;
        else { const it = api.quickFor(id); n = it ? C.slidesOf(it).length : 0; }
      }
      ncache[id] = { n, at: Date.now() };
      return n;
    }
    function slideLabels(id) {
      const idx = api.itemFor(id);
      const it = idx >= 0 ? C.service.items[idx] : api.quickFor(id);
      return it ? C.slidesOf(it).map((s) => (s.label || 'Diapositiva') + (s.part ? ' ' + s.part : '')) : [];
    }

    /** Muestra la diapositiva `slide` de la canción: en el orden si está, o como cita rápida desde la biblioteca */
    function show(id, slide) {
      const idx = api.itemFor(id);
      if (idx >= 0) {
        const cur = C.cursor;
        if (C.mode === 'service' && cur && cur.item === idx && cur.slide === slide) return true;
        C.go(idx, slide);
        return true;
      }
      const qi = C.mode === 'quick' && C.quick && C.quick.items[0];
      if (qi && qi.meta && qi.meta.songId === songKey(id)) {
        if (C.cursor && C.cursor.slide === slide) return true;
        C.goQuick(slide);
        return true;
      }
      const it = api.quickFor(id);
      if (!it) return false;
      C.projectQuick(it);
      if (slide) C.goQuick(slide);
      return true;
    }
    function currentSlide(id) {
      const cur = C.cursor, it = cur && C.list()[cur.item];
      return it && it.meta && it.meta.songId === songKey(id) ? cur.slide : null;
    }

    // ---------- Grabar ----------
    function startRec() {
      const q = seq();
      if (!q || !q.id) { say('Primero carga una canción en la secuencia (pestaña Herramientas).', 'error'); return false; }
      if (api.itemFor(q.id) < 0 && !api.quickFor(q.id)) { say('No encuentro esa canción en la biblioteca para proyectarla.', 'error'); return false; }
      show(q.id, 0);                                    // deja lista la diapositiva 1
      rec = { id: q.id, marks: [], lastKey: null, started: false };
      if (offChange) offChange();
      offChange = C.onChange(onProjection);
      say('Grabando tiempos: dale play a la secuencia y pasa las diapositivas como siempre.');
      return true;
    }
    function onProjection() {                           // cualquier cambio de diapositiva (teclado, clic, celular…) se anota
      if (!rec) return;
      const q = seq();
      if (!q || q.id !== rec.id || !q.playing) return;
      const s = currentSlide(rec.id);
      if (s == null || String(s) === rec.lastKey) return;
      rec.lastKey = String(s);
      rec.marks.push({ t: r2(q.pos), s });
      emit();
    }
    function cleanMarks(marks) {
      const sorted = marks.slice().sort((a, b) => a.t - b.t), out = [];
      sorted.forEach((m) => { if (!out.length || out[out.length - 1].s !== m.s) out.push({ t: r2(m.t), s: m.s }); });
      return out;
    }
    function stopRec(saveIt) {
      if (!rec) return false;
      if (offChange) { offChange(); offChange = null; }
      const r = rec; rec = null; applied = null;
      if (saveIt && r.marks.length) {
        cfg.songs[r.id] = { n: slidesCount(r.id), marks: cleanMarks(r.marks), at: Date.now() };
        saveCfg(cfg);
        say('Tiempos guardados (' + cfg.songs[r.id].marks.length + ' cambios). Activa «Las diapositivas siguen a la secuencia».');
      } else if (saveIt) say('No se anotó ningún cambio. Dale play a la secuencia y pasa las diapositivas mientras graba.', 'error');
      else say('Grabación cancelada.');
      emit();
      return true;
    }

    // ---------- Seguir ----------
    function followTick(q) {
      if (!q || !q.ready || !q.playing) { applied = null; return; }
      const d = cfg.songs[q.id];
      if (!d || !d.marks.length) return;
      const n = slidesCount(q.id);
      if (n && n !== d.n) {                             // las diapositivas se dividieron distinto desde que se grabó
        if (!warned[q.id]) { warned[q.id] = true; say('Los tiempos de esta canción se grabaron con ' + d.n + ' diapositivas y ahora tiene ' + n + '. Vuelve a grabarlos.', 'error'); }
        return;
      }
      const t = q.pos + cfg.lead;
      let target = null;
      for (let i = d.marks.length - 1; i >= 0; i--) if (d.marks[i].t <= t) { target = d.marks[i].s; break; }
      if (target == null) return;
      if (applied && applied.id === q.id && applied.slide === target) return;      // un cambio manual se respeta hasta la siguiente marca
      if (show(q.id, target)) applied = { id: q.id, slide: target };
    }
    function tick() {
      const q = seq();
      if (rec) {
        if (q && q.id !== rec.id) { stopRec(false); return; }                       // cambiaron de canción: se cancela
        if (q && q.playing && !rec.started) {                                        // al empezar a sonar se anota la diapositiva que está lista
          rec.started = true;
          const s = currentSlide(rec.id);
          if (s != null) { rec.marks.push({ t: r2(q.pos), s }); rec.lastKey = String(s); emit(); }
        }
        return;
      }
      if (cfg.follow) followTick(q);
    }
    tk = ticker(tick, 80); tk.start();

    // ---------- Estado, ajustes y edición ----------
    function status() {
      const q = seq(), d = q && q.id ? cfg.songs[q.id] : null;
      const n = q && q.id ? slidesCount(q.id) : 0;
      return {
        follow: !!cfg.follow, lead: cfg.lead, rec: rec ? { count: rec.marks.length, started: rec.started } : null,
        seq: q && q.id ? { id: q.id, title: q.title, playing: q.playing, pos: q.pos, ready: q.ready } : null,
        data: d || null, n, linked: n > 0, outdated: !!(d && n && d.n !== n)
      };
    }
    /** Resumen corto para el celular */
    function brief() {
      const s = status();
      return { f: s.follow ? 1 : 0, r: s.rec ? 1 : 0, c: s.rec ? s.rec.count : 0, m: s.data ? s.data.marks.length : 0, ok: s.data && !s.outdated ? 1 : 0, l: s.linked ? 1 : 0, msg: Date.now() - msgAt < 8000 ? msg.slice(0, 90) : '' };
    }
    function setFollow(on) {
      if (rec) stopRec(true);
      cfg.follow = !!on; applied = null; saveCfg(cfg);
      if (on) {
        const s = status();
        if (!s.seq) say('Activado. Carga una canción en la secuencia para que las diapositivas la sigan.');
        else if (!s.data) say('Esta canción todavía no tiene tiempos: usa «Grabar tiempos».', 'error');
      }
      emit();
    }
    function setLead(v) { cfg.lead = Math.max(0, Math.min(1.5, Number(v) || 0)); saveCfg(cfg); emit(); }
    function clearMarks(id) {
      id = id || (seq() && seq().id); if (!id) return;
      delete cfg.songs[id]; delete warned[id]; applied = null; saveCfg(cfg); emit();
    }
    function setMarkTime(id, i, t) {
      const d = cfg.songs[id]; if (!d || !d.marks[i]) return;
      d.marks[i].t = r2(Math.max(0, Number(t) || 0)); d.marks = cleanMarks(d.marks); saveCfg(cfg); applied = null; emit();
    }
    function delMark(id, i) {
      const d = cfg.songs[id]; if (!d) return;
      d.marks.splice(i, 1); if (!d.marks.length) delete cfg.songs[id]; saveCfg(cfg); applied = null; emit();
    }

    // ---------- Panel (pestaña «Secuencia» de la consola) ----------
    function mount(el) {
      el.innerHTML =
        '<p class="pj-help" id="sq-line" style="margin-top:0"></p>' +
        '<label class="pj-chk"><input type="checkbox" id="sq-follow"> Las diapositivas siguen a la secuencia</label>' +
        '<label class="pj-inl" style="margin-top:8px">Adelanto <input type="range" id="sq-lead" min="0" max="100" value="25"> <output id="sq-lead-v">0.25 s</output></label>' +
        '<p class="pj-help">El adelanto hace que la letra aparezca un poco antes del segundo marcado (aparece cuando empieza a cantarse, no después).</p>' +
        '<div class="pj-row"><button class="pj-btn sm primary" id="sq-rec" type="button">● Grabar tiempos</button>' +
        '<button class="pj-btn sm" id="sq-save" type="button" hidden>■ Terminar y guardar</button>' +
        '<button class="pj-btn sm" id="sq-cancel" type="button" hidden>Cancelar</button>' +
        '<button class="pj-btn sm danger" id="sq-clear" type="button">Borrar tiempos</button></div>' +
        '<p class="pj-help" id="sq-help"></p>' +
        '<div class="pj-h">Tiempos guardados de esta canción</div><ul class="pj-list" id="sq-marks" style="max-height:34vh"></ul>' +
        '<p class="pj-help">Funciona con canciones de la <b>biblioteca</b>. Los tiempos se guardan en este navegador. Si cambias las líneas por diapositiva en Ajustes, hay que grabarlos otra vez.</p>';
      const $ = (id) => el.querySelector('#' + id);
      $('sq-follow').onchange = (e) => setFollow(e.target.checked);
      $('sq-lead').oninput = (e) => setLead(Number(e.target.value) / 100);
      $('sq-rec').onclick = () => startRec();
      $('sq-save').onclick = () => stopRec(true);
      $('sq-cancel').onclick = () => stopRec(false);
      $('sq-clear').onclick = () => { if (confirm('¿Borrar los tiempos de esta canción?')) clearMarks(); };
      $('sq-marks').addEventListener('change', (e) => { const i = e.target.dataset.i; if (i != null && e.target.type === 'number') setMarkTime(status().seq.id, Number(i), e.target.value); });
      $('sq-marks').addEventListener('click', (e) => { const b = e.target.closest('[data-del]'); if (b) delMark(status().seq.id, Number(b.dataset.del)); });

      let lastSig = '';
      function paint() {
        const s = status(), line = $('sq-line');
        $('sq-follow').checked = s.follow;
        $('sq-lead').value = Math.round(s.lead * 100); $('sq-lead-v').textContent = s.lead.toFixed(2) + ' s';
        const recOn = !!s.rec;
        $('sq-rec').hidden = recOn; $('sq-save').hidden = !recOn; $('sq-cancel').hidden = !recOn;
        $('sq-clear').disabled = !s.data;
        if (!s.seq) line.textContent = '🎵 No hay ninguna canción cargada en la secuencia. Cárgala en Herramientas → Secuencia.';
        else line.textContent = '🎵 ' + (s.seq.title || 'Canción ' + s.seq.id) + (s.seq.playing ? ' · ▶ ' + fmt(s.seq.pos) : '') + ' · ' +
          (recOn ? '● grabando: ' + s.rec.count + ' cambios' : s.data ? (s.outdated ? '⚠ tiempos de otra división de diapositivas' : '✓ ' + s.data.marks.length + ' cambios guardados') : 'sin tiempos') +
          (s.seq && !s.linked ? ' · ⚠ no está en la biblioteca' : '');
        $('sq-help').textContent = recOn
          ? (s.rec.started ? 'Pasa las diapositivas (→ ↓ o el celular) justo cuando empieza cada parte. Al terminar, «Terminar y guardar».' : 'Listo: dale play a la secuencia (desde el principio) y empieza a pasar las diapositivas.')
          : 'Para grabar: carga la canción en la secuencia, toca «Grabar tiempos», dale play y pasa las diapositivas conforme se cantan.';
        // lista de tiempos: solo se redibuja si cambió, para no quitarte el cursor de un campo mientras lo editas
        const labels = s.seq ? slideLabels(s.seq.id) : [], sig = JSON.stringify([s.seq && s.seq.id, s.data && s.data.marks, labels.length]);
        if (sig !== lastSig && !(el.contains(document.activeElement) && document.activeElement.type === 'number')) {
          lastSig = sig;
          $('sq-marks').innerHTML = s.data ? s.data.marks.map((m, i) =>
            '<li class="pj-song"><span class="pj-song-t">' + esc(labels[m.s] || 'Diapositiva ' + (m.s + 1)) + '</span>' +
            '<input class="pj-in sm" type="number" step="0.1" min="0" data-i="' + i + '" value="' + m.t + '" aria-label="Segundo">' +
            '<span class="pj-song-b"><button type="button" data-del="' + i + '" aria-label="Quitar">✕</button></span></li>').join('') : '<li class="pj-empty">Aún no hay tiempos.</li>';
        }
      }
      paint();
      const iv = setInterval(() => { if (el.isConnected && el.offsetParent !== null) paint(); }, 500);
      listeners.add(paint);
      return { paint, destroy() { clearInterval(iv); listeners.delete(paint); } };
    }

    return {
      status, brief, setFollow, setLead, startRec, stopRec, clearMarks, setMarkTime, delMark, mount,
      isFollowing: () => !!cfg.follow, isRecording: () => !!rec, marksOf: (id) => (cfg.songs[id] ? cfg.songs[id].marks.slice() : []),
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      destroy() { if (tk) tk.stop(); if (offChange) offChange(); }
    };
  }

  Proy.SeqSync = { create, instance: null };
  if (typeof module !== 'undefined' && module.exports) module.exports = Proy.SeqSync;
})(typeof window !== 'undefined' ? window : globalThis);
