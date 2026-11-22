// Barra flotante en claude.ai: muestra el uso, avisa al acercarse al límite y guarda historial.
// Depende de shared.js (CU).
(() => {
  const { KEYS, esc } = CU;
  let state = {
    lastLimit: null, lastRaw: null, lastHeaders: null, lastAt: null, lastValidAt: null,
    missing: 0, sentToday: 0, day: CU.today(), alerted: {},
  };
  let hist = [];
  let settings = CU.mergeSettings(null);
  let diag = false;
  let toolsOpen = false; // fila de herramientas (Diagnóstico, Copiar JSON) tras el botón ⋯
  let drag = null;

  const BASE = 'position:fixed;z-index:2147483647;box-sizing:border-box;font:12px/1.4 system-ui,sans-serif;' +
    'background:#1f1e1d;color:#eee;border:1px solid #444;box-shadow:0 2px 10px rgba(0,0,0,.35);user-select:none;';

  const box = document.createElement('div');

  // ---------- Posición y estilo ----------
  function applyBoxStyle() {
    const compact = settings.mode === 'compact';
    const pos = settings.pos
      ? `left:${Math.round(settings.pos.x)}px;top:${Math.round(settings.pos.y)}px;`
      : 'left:12px;bottom:12px;';
    box.style.cssText = BASE + pos +
      (compact ? 'padding:3px;border-radius:50%;' : 'padding:12px 14px;border-radius:12px;width:316px;');
  }

  function clampPos() {
    if (!settings.pos || !box.isConnected) return;
    const maxX = Math.max(0, window.innerWidth - box.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - box.offsetHeight);
    const x = Math.min(Math.max(0, settings.pos.x), maxX);
    const y = Math.min(Math.max(0, settings.pos.y), maxY);
    if (x !== settings.pos.x || y !== settings.pos.y) { settings.pos = { x, y }; applyBoxStyle(); }
  }

  function setPos(x, y) {
    settings.pos = { x, y };
    applyBoxStyle();
    clampPos();
  }

  // ---------- Almacenamiento y fondo ----------
  const saveState = () => { try { chrome.storage.local.set({ [KEYS.state]: state }); } catch (e) {} };
  const saveHist = () => { try { chrome.storage.local.set({ [KEYS.hist]: hist }); } catch (e) {} };
  const saveSettings = () => { try { chrome.storage.local.set({ [KEYS.settings]: settings }); } catch (e) {} };

  // El service worker programa el aviso "tu sesión ya se reinició"
  function notifyBackground(wins) {
    try {
      const p = chrome.runtime.sendMessage({
        type: 'sample', threshold: settings.threshold, notifyReset: settings.notifyReset, items: CU.resetItems(wins),
      });
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* extensión recargada: se ignora */ }
  }

  // ---------- Avisos en la página ----------
  function toast(msg, color, bg) {
    if (!document.body) return;
    const n = document.querySelectorAll('.cu-toast').length;
    const t = document.createElement('div');
    t.className = 'cu-toast';
    t.style.cssText = `position:fixed;right:16px;top:${16 + n * 64}px;z-index:2147483647;background:${bg || '#3a1f1f'};color:#fff;` +
      `border:1px solid ${color || '#e5484d'};border-radius:10px;padding:10px 14px;font:13px/1.4 system-ui,sans-serif;` +
      'box-shadow:0 4px 14px rgba(0,0,0,.4);cursor:pointer;max-width:320px';
    t.textContent = msg;
    t.onclick = () => t.remove();
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 12000);
  }

  function checkAlerts(wins, now) {
    if (!settings.threshold) return;
    state.alerted = state.alerted || {};
    for (const w of wins) {
      if (w.usedPct == null || w.usedPct < 0 || w.usedPct > 100) continue;
      const d = CU.toDate(w.reset);
      if (d && d < now) continue;
      const left = Math.max(0, 100 - w.usedPct);
      const key = w.name + '|' + CU.resetKey(d);
      if (left <= settings.threshold && !state.alerted[key]) {
        state.alerted[key] = now; // un aviso por ventana y por reinicio
        toast(`⚠️ ${w.name}: te queda ${left.toFixed(0)}%` + (d ? ' · ' + CU.fmtReset(w.reset, now) : ''));
      }
    }
    for (const k of Object.keys(state.alerted)) {
      if (now - state.alerted[k] > 8 * 86400e3) delete state.alerted[k];
    }
  }

  // Chat abierto ahora (por la URL /chat/<id>); en "chat nuevo" no hay id y se usan datos globales
  function currentConv() {
    const path = typeof location !== 'undefined' ? location.pathname : '';
    const m = /\/chat\/([0-9a-f-]{36})/i.exec(path);
    return m ? m[1] : null;
  }

  // Consejos después de cada mensaje: "no te alcanza", chat caro, ritmo semanal (un aviso por caso)
  function checkAdvice(now, evConv) {
    if (!settings.threshold) return;
    const s = CU.summary(state, now);
    if (!s.worst) return;
    const conv = currentConv() || evConv || null;
    const adv = CU.advice(hist, s, conv);
    state.alerted = state.alerted || {};
    const once = (key, fn) => { if (!state.alerted[key]) { state.alerted[key] = now; fn(); } };
    const ew = adv.estWin || s.worst;
    const rk = CU.resetKey(CU.toDate(ew.reset));
    if (adv.sf && adv.sf.level === 'out') once(`nofit|${ew.name}|${rk}`, () => toast('⚠️ ' + adv.sfText));
    if (adv.tip && conv) once(`chat|${conv}`, () => toast(adv.tipText, '#6e9bff', '#252a35'));
    if (adv.pace && adv.pace.status === 'fast' && adv.pace.elapsedMs >= 12 * 3600e3) {
      once(`pace|${adv.pace.resetMs}`, () => toast(adv.paceText, '#f5a524', '#3d2f12'));
    }
  }

  // ---------- Dibujo ----------
  function headline(s) {
    if (s.worst) {
      return {
        txt: `Claude: te queda ${s.left.toFixed(0)}% <span style="color:#aaa;font-weight:normal">(${esc(s.worst.name)})</span>`,
        col: s.color,
      };
    }
    if (s.resetPassed) return { txt: 'Claude: dato viejo, envía un mensaje', col: '#f5a524' };
    if (state.lastRaw) return { txt: 'Claude: datos recibidos (abre Diagnóstico)', col: '#eee' };
    return { txt: 'Claude: envía un mensaje para medir', col: '#eee' };
  }

  function circleHtml(s) {
    const warn = !!CU.formatWarning(state);
    const adv = CU.advice(hist, s, currentConv());
    const has = s.worst != null;
    const col = warn ? '#f5a524' : has ? s.color : '#666';
    const txt = warn ? '!' : has ? Math.round(s.left) + '%' : '—';
    const deg = has && !warn ? s.left : 0;
    const dim = s.stale || s.resetPassed ? 'opacity:.6;' : '';
    const tip = warn ? 'Claude: no recibo datos válidos. Clic para abrir.'
      : has ? `Claude: te queda ${txt} (${s.worst.name}).${adv.sfText ? ' ⚠️ ' + adv.sfText : ''} Clic para abrir.` : 'Claude: sin datos. Clic para abrir.';
    return `<div title="${esc(tip)}" style="${dim}width:48px;height:48px;border-radius:50%;background:conic-gradient(${col} ${deg}%, #444 0);` +
      `display:flex;align-items:center;justify-content:center;cursor:grab">` +
      `<div style="width:38px;height:38px;border-radius:50%;background:#1f1e1d;display:flex;align-items:center;justify-content:center;` +
      `font-weight:700;font-size:12px;color:${col}">${txt}</div></div>`;
  }

  // ---------- Piezas del panel ----------
  const MUTE = 'color:#9a9a9a';
  const SEP = '<div style="border-top:1px solid #3a3a3a;margin:10px 0 8px"></div>';
  const ICON = 'cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;' +
    'border-radius:6px;color:#bbb;font-size:13px;line-height:1';

  function badge(st) {
    const b = CU.statusLabel(st);
    return b ? `<span style="margin-left:6px;padding:1px 7px;border-radius:9px;font-size:10.5px;background:${b.bg};color:${b.fg};white-space:nowrap">${esc(b.txt)}</span>` : '';
  }

  // Barra de "% restante". `mark` (0-100) dibuja una muesca: dónde deberías ir con un ritmo parejo.
  function bar(left, col, h, mark) {
    return `<div style="position:relative;background:#3a3a3a;height:${h}px;border-radius:${h}px;margin-top:6px">` +
      `<div style="width:${Math.max(0, Math.min(100, left))}%;height:100%;border-radius:${h}px;background:${col}"></div>` +
      (mark != null ? `<div title="Ritmo parejo: aquí deberías ir ahora" style="position:absolute;left:calc(${Math.max(0, Math.min(100, mark))}% - 1px);top:-3px;width:2px;height:${h + 6}px;background:#e8e8e8;border-radius:1px"></div>` : '') +
      `</div>`;
  }

  // Etiqueta corta del ritmo semanal; la explicación completa va en el tooltip
  function paceShort(p) {
    if (!p) return '';
    const tip = `title="${esc(CU.paceText(p).replace(/^⚠️ /, ''))}" `;
    if (p.status === 'early') return `<span ${tip}style="${MUTE};cursor:help">Ritmo: pocos datos</span>`;
    if (p.status === 'fast') return `<span ${tip}style="color:#f5c26b;cursor:help">⚠️ Ritmo alto</span>`;
    return `<span ${tip}style="color:#7dd38a;cursor:help">Buen ritmo</span>`;
  }

  // "Te alcanza para ~12 mensajes"; el detalle (último cambio, costo típico) va en el tooltip
  function estimateLine(adv, s) {
    const e = adv.est;
    if (!e) return '';
    const parts = [];
    if (e.last != null) parts.push(`Último mensaje: ${e.last >= 0 ? '+' : ''}${CU.num(e.last)}%`);
    if (e.typical != null) parts.push(`Costo típico: +${CU.num(e.typical)}% por mensaje${e.scope === 'chat' ? ' en este chat' : ''}`);
    if (adv.estName && adv.estName !== s.worst.name) parts.push(`Calculado con: ${adv.estName}`);
    const tip = parts.join('\n');
    const info = tip ? ` <span title="${esc(tip)}" style="${MUTE};cursor:help">ⓘ</span>` : '';
    if (e.msgs == null) return `<div style="margin-top:4px;${MUTE}">Estimando mensajes restantes… (${e.n}/3)${info}</div>`;
    const n = e.msgs;
    return `<div style="margin-top:4px;color:#e6e6e6">Te alcanza para ~${n} mensaje${n === 1 ? '' : 's'}${info}</div>`;
  }

  function panelHtml(s, now) {
    const adv = CU.advice(hist, s, currentConv());
    const tools = settings.expanded
      ? `<a id="cu-tools" title="Herramientas: diagnóstico y JSON" style="${ICON}">⋯</a>` : '';
    let html = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:grab">` +
      `<span style="${MUTE};font-size:11.5px">Uso de Claude</span>` +
      `<span style="white-space:nowrap;display:flex;gap:2px">${tools}` +
      `<a id="cu-more" title="${settings.expanded ? 'Ocultar detalles' : 'Ver detalles e historial'}" style="${ICON}">${settings.expanded ? '▴' : '▾'}</a>` +
      `<a id="cu-min" title="Minimizar a círculo" style="${ICON}">–</a></span></div>`;

    const fw = CU.formatWarning(state);
    if (fw) {
      html += `<div style="margin-top:6px;padding:6px 8px;border-radius:6px;background:#3d2f12;color:#f5c26b;user-select:text">⚠️ ${esc(fw)}</div>`;
    }

    if (s.worst) {
      // Cifra principal: lo que queda en la ventana más ajustada
      const col = s.stale ? '#8a8a8a' : s.color;
      html += `<div style="margin-top:6px;display:flex;align-items:baseline;gap:8px">` +
        `<span style="font-size:32px;font-weight:600;line-height:1.05;color:${col}">${Math.round(s.left)}%</span>` +
        `<span style="${MUTE}">restante · ${esc(s.worst.name)}</span></div>`;
      html += bar(s.left, col, 7, null);
      html += `<div style="margin-top:6px;color:#cfcfcf">${CU.renewHtml(s.worst.reset, now)}</div>`;
      html += estimateLine(adv, s);
      if (adv.sf) {
        html += `<div style="margin-top:6px;padding:6px 8px;border-radius:6px;user-select:text;` +
          (adv.sf.level === 'out' ? 'background:#3a1f1f;color:#ff9a9a' : 'background:#3d2f12;color:#f5c26b') +
          `">⚠️ ${esc(adv.sfText)}</div>`;
      }
      if (adv.tip) html += `<div style="margin-top:6px;color:#8fb2ff;user-select:text">${esc(adv.tipText)}</div>`;
    } else {
      const h = headline(s);
      html += `<div style="margin-top:6px;font-weight:600;color:${h.col}">${h.txt}</div>`;
    }

    // Resto de ventanas (semanal, por modelo…), con la muesca de ritmo en la semanal
    const others = s.withPct.filter((w) => !s.worst || w.name !== s.worst.name);
    if (others.length) html += SEP;
    others.forEach((w, i) => {
      const mt = i ? 'margin-top:10px;' : '';
      if (s.isPassed(w)) {
        html += `<div style="${mt}display:flex;justify-content:space-between"><span>${esc(w.name)}</span><span style="${MUTE}">ya se renovó</span></div>`;
        return;
      }
      const left = Math.max(0, 100 - w.usedPct);
      const isWeek = s.weekly && w.name === s.weekly.name && s.pace;
      const mark = isWeek ? 100 - s.pace.elapsedPct : null;
      const d = CU.toDate(w.reset);
      const when = d ? d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      html += `<div style="${mt}display:flex;justify-content:space-between;align-items:center;gap:8px">` +
        `<span style="font-weight:600">${esc(w.name)}${badge(w.status)}</span><span>${Math.round(left)}% restante</span></div>`;
      html += bar(left, CU.windowColor(w), 5, mark);
      html += `<div style="margin-top:5px;display:flex;justify-content:space-between;gap:8px;font-size:11.5px">` +
        `${isWeek ? paceShort(s.pace) : '<span></span>'}<span style="${MUTE};white-space:nowrap">${when ? 'Se renueva ' + esc(when) : ''}</span></div>`;
    });
    if (s.worst && s.worst.status && !others.length) html += `<div style="margin-top:6px">${badge(s.worst.status)}</div>`;

    if (settings.expanded) {
      html += SEP;
      html += `<div style="${MUTE};margin-bottom:4px">Restante en la sesión · últimas 24 h</div>` + CU.stepChart(hist, 24, now);
      if (adv.chatLine) html += `<div style="margin-top:6px;${MUTE}">${esc(adv.chatLine)}</div>`;
      if (adv.pace) html += `<div style="margin-top:4px;${MUTE};font-size:11.5px;user-select:text">${esc(adv.paceText)}</div>`;
      for (const w of s.wins) {
        if (w.remaining == null && !w.sev) continue;
        html += `<div style="margin-top:4px;${MUTE};font-size:11.5px">${esc(w.name)}` +
          (w.remaining != null ? ` · quedan ${w.remaining}` : '') + (w.sev ? ` · severidad: ${esc(w.sev)}` : '') + `</div>`;
      }
      html += `<div style="margin-top:6px;color:#777;font-size:11px">Consumo por hora y ajustes: icono de la extensión.</div>`;
    }

    // Antigüedad del dato: los datos solo llegan cuando envías un mensaje
    if (state.lastAt) {
      html += `<div style="margin-top:8px;font-size:11.5px;color:${s.stale ? '#f5a524' : '#8a8a8a'}">` +
        `${s.stale ? '🕒 ' : ''}Actualizado ${CU.agoShortHtml(state.lastAt, now)}` +
        `${s.stale ? ' · envía un mensaje para refrescar' : ''}</div>`;
    }

    if (settings.expanded && toolsOpen) {
      html += `<div style="margin-top:8px;padding-top:6px;border-top:1px solid #3a3a3a;display:flex;gap:12px;flex-wrap:wrap;font-size:11.5px">` +
        `<a id="cu-diag" style="cursor:pointer;color:#bbb">${diag ? 'Ocultar diagnóstico' : 'Diagnóstico'}</a>` +
        `<a id="cu-copy" style="cursor:pointer;color:#bbb">Copiar JSON</a>` +
        `<span style="color:#777">Hoy: ${state.sentToday} mensaje${state.sentToday === 1 ? '' : 's'}</span></div>`;

      if (diag) {
        html += `<div id="cu-diagbox" style="margin-top:6px;border-top:1px solid #444;padding-top:6px;cursor:default;user-select:text">`;
        html += `<div style="color:#aaa">Mensajes seguidos sin datos válidos: ${state.missing || 0}` +
          (state.lastValidAt ? ` · último dato válido ${CU.fmtAgo(state.lastValidAt, now)}` : ' · aún no ha llegado ninguno') + `</div>`;
        html += `<div style="margin-top:4px;color:#aaa">Cómo se interpretó cada campo:</div>`;
        if (!s.wins.length) html += `<div>No se encontró ningún campo "utilization", "remaining" ni "percent".</div>`;
        for (const w of s.wins) {
          html += `<div style="margin-top:3px"><b>${esc(w.path)}</b><br><span style="color:#aaa">${esc(w.note)}${w.sev ? ' · severidad: ' + esc(w.sev) : ''}</span></div>`;
        }
        if (state.lastError) {
          html += `<div style="margin-top:6px;color:#aaa">Última respuesta con error (HTTP ${esc(state.lastError.status)}, ${CU.fmtAgo(state.lastError.at, now)}):</div>` +
            `<pre style="white-space:pre-wrap;word-break:break-all;margin:2px 0;max-height:80px;overflow:auto;user-select:text">${esc(JSON.stringify(state.lastError.body, null, 1))}</pre>`;
        }
        if (state.lastHeaders) {
          html += `<div style="margin-top:6px;color:#aaa">Cabeceras de límite detectadas:</div>` +
            `<pre style="white-space:pre-wrap;word-break:break-all;margin:2px 0;max-height:80px;overflow:auto;user-select:text">${esc(JSON.stringify(state.lastHeaders.headers, null, 1))}</pre>`;
        }
        html += `<div style="margin-top:6px;color:#aaa">JSON crudo del último aviso recibido:</div>` +
          `<pre style="white-space:pre-wrap;word-break:break-all;margin:2px 0;max-height:160px;overflow:auto;user-select:text">${esc(JSON.stringify(state.lastRaw || state.lastLimit, null, 1))}</pre></div>`;
      }
    }
    return html;
  }

  function rollDay() {
    if (state.day !== CU.today()) { state.day = CU.today(); state.sentToday = 0; return true; }
    return false;
  }

  function render() {
    if (!box.isConnected && document.body) document.body.appendChild(box);
    rollDay(); // el contador "enviados hoy" vuelve a 0 aunque no hayas enviado nada desde ayer
    const now = Date.now();
    const s = CU.summary(state, now);
    applyBoxStyle();
    box.innerHTML = settings.mode === 'compact' ? circleHtml(s) : panelHtml(s, now);

    const q = (id) => box.querySelector(id);
    const more = q('#cu-more');
    if (more) more.onclick = (e) => { e.stopPropagation(); settings.expanded = !settings.expanded; saveSettings(); render(); };
    const min = q('#cu-min');
    if (min) min.onclick = (e) => { e.stopPropagation(); settings.mode = 'compact'; saveSettings(); render(); };
    const tl = q('#cu-tools');
    if (tl) tl.onclick = (e) => { e.stopPropagation(); toolsOpen = !toolsOpen; if (!toolsOpen) diag = false; render(); };
    const dg = q('#cu-diag');
    if (dg) dg.onclick = (e) => { e.stopPropagation(); diag = !diag; render(); };
    const copy = q('#cu-copy');
    if (copy) copy.onclick = (e) => {
      e.stopPropagation();
      const json = JSON.stringify({ limit: state.lastRaw || state.lastLimit, headers: state.lastHeaders, error: state.lastError || null }, null, 2);
      Promise.resolve()
        .then(() => navigator.clipboard.writeText(json))
        .then(() => { copy.textContent = '¡Copiado!'; })
        .catch(() => { copy.textContent = 'No se pudo copiar (usa el Diagnóstico)'; });
    };
    clampPos();
  }

  // ---------- Arrastrar y minimizar ----------
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target.closest && e.target.closest('a,pre,#cu-diagbox'))) return;
    const r = box.getBoundingClientRect();
    drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
    try { box.setPointerCapture(e.pointerId); } catch (err) {}
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    setPos(drag.ox + dx, drag.oy + dy);
  });
  box.addEventListener('pointerup', () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved) saveSettings();
    else if (settings.mode === 'compact') { settings.mode = 'normal'; saveSettings(); render(); } // clic en el círculo: abrir
  });
  window.addEventListener('resize', clampPos);

  // ---------- Datos que llegan de la página ----------
  // Aviso con datos de uso válidos: actualiza estado, historial, avisos y el fondo.
  function acceptLimit(payload, conv, now) {
    const wins = CU.windowsOf({ lastLimit: payload });
    if (!CU.hasValid(wins)) return false;
    state.lastLimit = payload;
    state.lastAt = now;
    state.lastValidAt = now;
    state.missing = 0;
    if (conv) state.lastConv = conv;
    hist = CU.addSample(hist, wins, now, conv);
    checkAlerts(wins, now);
    checkAdvice(now, conv);
    notifyBackground(wins);
    saveHist();
    return true;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'claude-uso-ext') return;
    const { kind, payload, conv } = e.data;
    const now = Date.now();
    rollDay();

    if (kind === 'headers') {
      // Llegan con muchas llamadas a /api/: solo se guarda y redibuja si cambiaron
      const a = JSON.stringify(payload && payload.headers), b = JSON.stringify(state.lastHeaders && state.lastHeaders.headers);
      if (a === b) return;
      state.lastHeaders = payload;
      saveState();
      if (diag) render();
      return;
    }

    if (kind === 'sent') state.sentToday += 1;

    if (kind === 'limit') {
      state.lastRaw = payload;
      if (!acceptLimit(payload, conv, now)) {
        state.missing = (state.missing || 0) + 1; // llegó un aviso, pero no se pudo leer
        if (state.missing === CU.MISSING_MAX) toast('⚠️ Claude Uso: no logro leer los datos de uso. ¿Cambió el formato? Abre el Diagnóstico.', '#f5a524');
      }
    }

    // Respuesta con error (p. ej. 429 al llegar al límite). Si trae datos de uso, se usan;
    // si no, solo queda en el Diagnóstico y NO cuenta como "formato cambiado".
    if (kind === 'errorBody' && payload) {
      state.lastError = { status: payload.status, body: payload.body, at: now };
      acceptLimit(payload.body, conv, now);
    }

    if (kind === 'streamEnd' && payload && payload.sawLimit === false) {
      state.missing = (state.missing || 0) + 1; // la respuesta terminó sin aviso de límite
      if (state.missing === CU.MISSING_MAX) toast('⚠️ Claude Uso: las últimas respuestas no traen datos de uso. ¿Cambió el formato? Abre el Diagnóstico.', '#f5a524');
    }

    saveState();
    render();
  });

  // Cambios hechos desde el popup u otras pestañas. Los cambios que hizo esta misma pestaña
  // también llegan aquí: si no cambian nada, no se redibuja (evita el doble render por mensaje).
  const histSig = (h) => (h && h.length ? h.length + ':' + h[h.length - 1].t : '0');
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      let changed = false;
      if (ch[KEYS.settings] && ch[KEYS.settings].newValue) {
        const ns = CU.mergeSettings(ch[KEYS.settings].newValue);
        if (JSON.stringify(ns) !== JSON.stringify(settings)) { settings = ns; changed = true; }
      }
      if (ch[KEYS.hist]) {
        const nh = ch[KEYS.hist].newValue || [];
        if (histSig(nh) !== histSig(hist)) { hist = nh; changed = true; }
      }
      if (ch[KEYS.state] && ch[KEYS.state].newValue) {
        const merged = Object.assign({}, state, ch[KEYS.state].newValue);
        if (JSON.stringify(merged) !== JSON.stringify(state)) { state = merged; changed = true; }
      }
      if (changed) render();
    });
  } catch (e) {}

  try {
    chrome.storage.local.get([KEYS.state, KEYS.hist, KEYS.settings], (r) => {
      if (r && r[KEYS.state]) state = Object.assign(state, r[KEYS.state]);
      if (r && r[KEYS.hist]) hist = r[KEYS.hist];
      settings = CU.mergeSettings(r && r[KEYS.settings]);
      render();
    });
  } catch (e) {}

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();

  // Cada segundo: solo se actualizan los contadores (horas, minutos y segundos), sin redibujar.
  // Si React reemplazó el <body> y la barra se perdió, se vuelve a insertar enseguida.
  setInterval(() => {
    if (drag) return;
    if (!box.isConnected && document.body) { render(); return; }
    if (CU.tick(box, Date.now())) render(); // un contador llegó a 0
  }, 1000);

  // Cada 30 s: redibujo completo (colores, "desfasado", etc.)
  setInterval(() => {
    if (drag) return;
    if (diag && toolsOpen && settings.expanded && settings.mode === 'normal') return; // no borrar la selección de texto
    render();
  }, 30000);
})();
