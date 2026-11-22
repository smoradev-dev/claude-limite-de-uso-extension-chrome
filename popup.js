// Popup del icono: mismo resumen que la barra, más estimaciones, gráficas y ajustes.
(() => {
  const { KEYS, esc } = CU;
  const app = document.getElementById('app');
  let state = { lastLimit: null }, hist = [], settings = CU.mergeSettings(null);

  function load(cb) {
    chrome.storage.local.get([KEYS.state, KEYS.hist, KEYS.settings], (r) => {
      state = (r && r[KEYS.state]) || { lastLimit: null };
      hist = (r && r[KEYS.hist]) || [];
      settings = CU.mergeSettings(r && r[KEYS.settings]);
      cb();
    });
  }

  function saveSettings() {
    chrome.storage.local.set({ [KEYS.settings]: settings });
  }

  function render() {
    const now = Date.now();
    const s = CU.summary(state, now);
    const adv = CU.advice(hist, s, state.lastConv || null);
    let html = '';

    if (s.worst) {
      html += `<div style="font-size:22px;font-weight:700;color:${s.color}">Te queda ${s.left.toFixed(0)}%</div>` +
        `<div style="color:#aaa">Ventana más ajustada: ${esc(s.worst.name)}</div>`;
    } else if (s.resetPassed) {
      html += `<div style="font-size:16px;font-weight:700;color:#f5a524">Dato viejo: la ventana ya se reinició</div>` +
        `<div style="color:#aaa">Envía un mensaje en claude.ai para actualizar.</div>`;
    } else {
      html += `<div style="font-size:16px;font-weight:700">Sin datos todavía</div>` +
        `<div style="color:#aaa">Abre claude.ai y envía un mensaje para medir.</div>`;
    }

    const fw = CU.formatWarning(state);
    if (fw) html += `<div style="margin-top:8px;padding:6px 8px;border-radius:6px;background:#3d2f12;color:#f5c26b">⚠️ ${esc(fw)}</div>`;

    if (adv.sf) {
      html += `<div style="margin-top:8px;padding:6px 8px;border-radius:6px;` +
        (adv.sf.level === 'out' ? 'background:#3a1f1f;color:#ff9a9a' : 'background:#3d2f12;color:#f5c26b') +
        `">⚠️ ${esc(adv.sfText)}</div>`;
    }

    for (const w of s.withPct) {
      const passed = s.isPassed(w);
      html += `<div style="margin-top:8px;display:flex;justify-content:space-between"><span>${esc(w.name)}</span>` +
        `<span>${passed ? 'reiniciada' : w.usedPct.toFixed(0) + '% usado'}</span></div>`;
      if (!passed) {
        html += `<div style="background:#444;height:6px;border-radius:3px"><div style="width:${Math.min(100, w.usedPct)}%;height:6px;border-radius:3px;background:${CU.windowColor(w)}"></div></div>`;
      }
      html += `<div style="color:#aaa">${CU.resetHtml(w.reset, now)}</div>`;
    }

    if (state.lastAt) {
      html += `<div style="margin-top:8px;color:${s.stale ? '#f5a524' : '#aaa'}">Actualizado ${CU.agoHtml(state.lastAt, now)}` +
        `${s.stale ? ' · puede estar desfasado' : ''}</div>`;
    }
    html += `<div style="color:#888;font-size:11px">Los datos se actualizan cuando envías un mensaje en claude.ai.</div>`;

    if (s.worst) {
      html += `<h3>Estimación</h3><div>${CU.estimateHtml(adv.est, adv.estName && adv.estName !== s.worst.name ? esc(adv.estName) : '')}</div>` +
        `<div style="color:#888;font-size:11px">Basada en el cambio de % entre tus últimos mensajes; varía con el largo de cada chat. ` +
        `Si usas Claude en otro dispositivo, ese consumo también se cuenta.</div>`;
    }

    if (adv.chatLine || adv.tip) {
      html += `<h3>Este chat</h3>` +
        (adv.chatLine ? `<div>${esc(adv.chatLine)}</div>` : '') +
        (adv.tip ? `<div style="color:#8fb2ff;margin-top:3px">${esc(adv.tipText)}</div>` : '') +
        `<div style="color:#888;font-size:11px">Se refiere al último chat en el que enviaste un mensaje.</div>`;
    }

    if (adv.pace) {
      const pc = adv.pace;
      html += `<h3>Ritmo semanal</h3>` +
        `<div style="display:flex;justify-content:space-between"><span>Semana transcurrida</span><span>${Math.round(pc.elapsedPct)}%</span></div>` +
        `<div style="background:#444;height:6px;border-radius:3px"><div style="width:${Math.min(100, pc.elapsedPct)}%;height:6px;border-radius:3px;background:#6e9bff"></div></div>` +
        `<div style="display:flex;justify-content:space-between;margin-top:4px"><span>Uso semanal</span><span>${Math.round(pc.usedPct)}%</span></div>` +
        `<div style="background:#444;height:6px;border-radius:3px"><div style="width:${Math.min(100, pc.usedPct)}%;height:6px;border-radius:3px;background:${pc.status === 'fast' ? '#e5484d' : '#46a758'}"></div></div>` +
        `<div style="margin-top:4px;color:${pc.status === 'fast' ? '#f5c26b' : '#aaa'}">${esc(CU.paceText(pc))}</div>`;
    }

    html += `<h3>Últimas 24 horas</h3>${CU.sparkline(hist, 24, now)}`;
    html += `<h3>Consumo por hora del día (sesión 5 h)</h3>${CU.hourly(hist)}`;

    html += `<h3>Ajustes</h3>` +
      `<div class="row">Avisar cuando me quede menos de <input id="thr" type="number" min="0" max="90" value="${settings.threshold}" style="width:52px"> % <span style="color:#888">(0 = sin avisos)</span></div>` +
      `<div class="row"><label><input id="nr" type="checkbox"${settings.notifyReset ? ' checked' : ''}> Notificarme cuando se reinicie la sesión (si me quedé con poco)</label></div>` +
      `<div class="row">Barra en la página: <select id="mode"><option value="normal"${settings.mode === 'normal' ? ' selected' : ''}>Normal</option>` +
      `<option value="compact"${settings.mode === 'compact' ? ' selected' : ''}>Círculo</option></select></div>` +
      `<div class="row"><button id="resetpos">Restablecer posición</button> <button id="clearhist">Borrar historial</button> <button id="testnot">Probar notificación</button></div>`;

    app.innerHTML = html;

    const thr = app.querySelector('#thr');
    if (thr) thr.addEventListener('change', () => {
      settings = CU.mergeSettings(Object.assign({}, settings, { threshold: thr.value }));
      thr.value = settings.threshold;
      saveSettings();
    });
    const nr = app.querySelector('#nr');
    if (nr) nr.addEventListener('change', () => { settings.notifyReset = nr.checked; saveSettings(); });
    const mode = app.querySelector('#mode');
    if (mode) mode.addEventListener('change', () => { settings.mode = mode.value; saveSettings(); });
    const rp = app.querySelector('#resetpos');
    if (rp) rp.addEventListener('click', () => { settings.pos = null; saveSettings(); rp.textContent = 'Listo'; });
    const ch = app.querySelector('#clearhist');
    if (ch) ch.addEventListener('click', () => {
      hist = [];
      chrome.storage.local.set({ [KEYS.hist]: [] });
      render();
    });
    const tn = app.querySelector('#testnot');
    if (tn) tn.addEventListener('click', () => {
      try {
        const p = chrome.runtime.sendMessage({ type: 'test' });
        if (p && p.catch) p.catch(() => {});
      } catch (e) {}
      tn.textContent = 'Enviada (¿la ves?)';
    });
  }

  load(render);

  // Cada segundo: solo los contadores. Cada 30 s: se recargan los datos del almacenamiento.
  setInterval(() => { if (CU.tick(app, Date.now())) load(render); }, 1000);
  setInterval(() => {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) return;
    load(render);
  }, 30000);
})();
