// Código compartido entre la barra de la página (content.js) y el popup del icono.
var CU = (() => {
  const KEYS = { state: 'claudeUsoState', hist: 'claudeUsoHistory', settings: 'claudeUsoSettings' };
  const DEFAULTS = { threshold: 20, mode: 'normal', expanded: false, pos: null, notifyReset: true };
  const MISSING_MAX = 3;  // mensajes seguidos sin datos válidos antes de avisar
  const STALE_MIN = 30;   // minutos tras los cuales el dato se marca como viejo
  const HIST_MAX = 1500;  // máximo de muestras guardadas
  const HIST_DAYS = 30;   // días de historial
  const C5 = '#d97757', C7 = '#6e9bff', MUTED = '#aaa';

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const today = () => new Date().toLocaleDateString('en-CA'); // fecha local AAAA-MM-DD

  function mergeSettings(s) {
    const out = Object.assign({}, DEFAULTS, s || {});
    const t = Number(out.threshold);
    out.threshold = isFinite(t) ? Math.min(90, Math.max(0, t)) : DEFAULTS.threshold;
    if (out.mode !== 'compact') out.mode = 'normal';
    out.notifyReset = out.notifyReset !== false;
    return out;
  }

  // ---------- Lectura de datos ----------
  function findWindows(obj, path, out) {
    if (!obj || typeof obj !== 'object') return out;
    const hasU = typeof obj.utilization === 'number';
    const hasR = typeof obj.remaining === 'number';
    if (hasU || hasR) {
      out.push({
        path: path || '(raíz)',
        utilization: hasU ? obj.utilization : null,
        remaining: hasR ? obj.remaining : null,
        status: obj.status || obj.type || '',
        reset: obj.resets_at ?? obj.resetsAt ?? obj.reset_at ?? null,
      });
    }
    for (const [k, v] of Object.entries(obj)) findWindows(v, path ? path + '.' + k : k, out);
    return out;
  }

  const RE_5H = /5\s*h|five|session|sesi/i;
  const RE_7D = /7\s*d|seven|week|seman/i;
  const RE_MODEL = /opus|sonnet|haiku|fable|mythos/i;

  // El modelo se revisa ANTES que el periodo: "7d_opus" no debe llamarse igual que la semanal general.
  function friendlyName(path) {
    const last = String(path).split('.').pop();
    const mm = RE_MODEL.exec(last);
    const model = mm ? mm[0][0].toUpperCase() + mm[0].slice(1).toLowerCase() : '';
    const period = RE_5H.test(last) ? 'Sesión 5 h' : RE_7D.test(last) ? 'Semanal' : '';
    if (model) return period ? `${period} · ${model}` : 'Modelo ' + model;
    return period || last;
  }

  // Duración de la ventana: "5h", "7d_opus", "five_hour", "seven_day"… o, si no, por el nombre amigable.
  function winLen(key, name) {
    const m = /^(\d+)\s*([dh])(?![a-z])/i.exec(key || '');
    if (m) return Number(m[1]) * (m[2].toLowerCase() === 'd' ? 86400e3 : 3600e3);
    const s = String(key || '') + ' ' + String(name || '');
    if (RE_5H.test(s)) return 5 * 3600e3;
    if (RE_7D.test(s)) return 7 * 86400e3;
    return null;
  }

  // La escala se decide una vez por aviso: si algún utilization > 1, todos son porcentajes; si no, fracciones.
  function utilScale(raw) {
    return raw.some((w) => w.utilization != null && w.utilization > 1) ? 'pct' : 'frac';
  }

  function interpret(w, scale) {
    let usedPct = null, note = '';
    if (w.utilization != null) {
      if (scale === 'pct') {
        usedPct = w.utilization;
        note = `utilization=${w.utilization} → porcentaje (algún valor del aviso es > 1)`;
      } else {
        usedPct = w.utilization * 100;
        note = `utilization=${w.utilization} → fracción → ${usedPct.toFixed(0)}% usado`;
      }
    } else if (w.remaining != null) {
      note = `remaining=${w.remaining} (sin total conocido, no se calcula %)`;
    }
    const key = w.path.split('.').pop();
    const name = friendlyName(w.path);
    return Object.assign({}, w, { name, key, lenMs: winLen(key, name), usedPct, note, sev: '' });
  }

  // Dos horas de reinicio se consideran la misma ventana si difieren menos de 2 min
  // (el servidor puede devolverlas con segundos de diferencia entre mensajes).
  const RESET_TOL = 2 * 60e3;
  function sameReset(a, b) {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return Math.abs(a - b) < RESET_TOL;
  }
  // Clave estable para "un aviso por reinicio" (redondeada a 10 min)
  const resetKey = (d) => (d ? String(Math.round(d.getTime() / 600e3)) : '');

  // Objetos tipo resolved.limit: { kind/group, percent (0-100), severity, resets_at, is_active }
  function findPercents(obj, path, out) {
    if (!obj || typeof obj !== 'object') return out;
    if (typeof obj.percent === 'number' && (obj.kind || obj.group) && obj.is_active !== false) {
      out.push({
        path: path || '(raíz)', kind: obj.kind || obj.group, percent: obj.percent,
        severity: obj.severity || '', reset: obj.resets_at ?? obj.resetsAt ?? null,
      });
    }
    for (const [k, v] of Object.entries(obj)) findPercents(v, path ? path + '.' + k : k, out);
    return out;
  }

  // Ventanas de uso. El porcentaje entero de "resolved.limit" tiene prioridad sobre
  // "utilization" (que parece venir truncado a 2 decimales).
  function windowsOf(state) {
    if (!state || !state.lastLimit) return [];
    const raw = findWindows(state.lastLimit, '', []);
    const scale = utilScale(raw);
    const wins = raw.map((w) => interpret(w, scale));
    // Nombres únicos: el historial se guarda por nombre y dos ventanas iguales mezclarían sus datos
    const seen = {};
    for (const w of wins) {
      if (seen[w.name]) w.name = `${w.name} (${w.path})`;
      seen[w.name] = true;
    }
    for (const p of findPercents(state.lastLimit, '', [])) {
      const name = friendlyName(String(p.kind));
      const w = wins.find((x) => x.name === name);
      if (w) {
        w.note = `percent=${p.percent} (${p.path}) preferido sobre utilization=${w.utilization} → ${p.percent}% usado`;
        w.usedPct = p.percent;
        w.sev = p.severity;
        if (w.reset == null && p.reset != null) w.reset = p.reset;
      } else {
        wins.push({
          path: p.path, utilization: null, remaining: null, status: '', reset: p.reset, name, key: '', lenMs: winLen(String(p.kind), name),
          usedPct: p.percent, note: `percent=${p.percent} (${p.path}) → ${p.percent}% usado`, sev: p.severity,
        });
      }
    }
    return wins;
  }

  function toDate(r) {
    if (r == null) return null;
    const d = typeof r === 'number' ? new Date(r > 1e12 ? r : r * 1000) : new Date(r);
    return isNaN(d) ? null : d;
  }

  // ---------- Cuenta regresiva y "hace X" con segundos ----------
  function fmtCountdown(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    if (h) return `${h} h ${m} min ${sec} s`;
    if (m) return `${m} min ${sec} s`;
    return `${sec} s`;
  }

  const clock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Texto plano (para avisos)
  function fmtReset(r, now) {
    const d = toDate(r);
    if (!d) return '';
    if (d - now <= 0) return `ya se reinició (${clock(d)})`;
    return `reinicia en ${fmtCountdown(d - now)} (${clock(d)})`;
  }

  // HTML con un <span data-cd> que tick() actualiza cada segundo
  function resetHtml(r, now) {
    const d = toDate(r);
    if (!d) return '';
    if (d - now <= 0) return `ya se reinició (${clock(d)})`;
    return `reinicia en <span data-cd="${d.getTime()}">${fmtCountdown(d - now)}</span> (${clock(d)})`;
  }

  function fmtAgo(ts, now) {
    if (!ts) return '';
    const t = Math.max(0, Math.floor((now - ts) / 1000));
    if (t < 5) return 'ahora mismo';
    if (t < 60) return `hace ${t} s`;
    const m = Math.floor(t / 60);
    if (m < 60) return `hace ${m} min ${t % 60} s`;
    return `hace ${Math.floor(m / 60)} h ${m % 60} min`;
  }

  function agoHtml(ts, now) {
    return ts ? `<span data-ago="${ts}">${fmtAgo(ts, now)}</span>` : '';
  }

  // Versiones cortas para la barra: los segundos solo aparecen cuando de verdad importan
  // (el dato puede tener horas de antigüedad, así que "30 s" sería precisión falsa).
  function fmtCountdownShort(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    if (h) return m ? `${h} h ${m} min` : `${h} h`;
    if (m >= 10) return `${m} min`;
    if (m) return `${m} min ${sec} s`;
    return `${sec} s`;
  }

  function fmtAgoShort(ts, now) {
    if (!ts) return '';
    const t = Math.max(0, Math.floor((now - ts) / 1000));
    if (t < 5) return 'ahora mismo';
    if (t < 60) return `hace ${t} s`;
    const m = Math.floor(t / 60);
    if (m < 60) return `hace ${m} min`;
    const h = Math.floor(m / 60);
    return m % 60 ? `hace ${h} h ${m % 60} min` : `hace ${h} h`;
  }

  // "Se renueva a las 22:30 · en 2 h 48 min" (con contador que tick() actualiza)
  function renewHtml(r, now) {
    const d = toDate(r);
    if (!d) return '';
    if (d - now <= 0) return `Se renovó a las ${clock(d)}`;
    return `Se renueva a las ${clock(d)} · en <span data-cds="${d.getTime()}">${fmtCountdownShort(d - now)}</span>`;
  }

  const agoShortHtml = (ts, now) => (ts ? `<span data-agos="${ts}">${fmtAgoShort(ts, now)}</span>` : '');

  // Estados que manda la API traducidos a algo legible (los desconocidos se muestran tal cual)
  function statusLabel(st) {
    const s = String(st || '').toLowerCase();
    if (!s) return null;
    if (/within|allowed|^ok$|normal/.test(s)) return { txt: 'Dentro del límite', fg: '#7dd38a', bg: '#1f3323' };
    if (/approach|warn|near/.test(s)) return { txt: 'Cerca del límite', fg: '#f5c26b', bg: '#3d2f12' };
    if (/exceed|reached|block|rejected|limited/.test(s)) return { txt: 'Límite alcanzado', fg: '#ff9a9a', bg: '#3a1f1f' };
    return { txt: String(st).replace(/_/g, ' '), fg: '#ccc', bg: '#333' };
  }

  // Actualiza solo los contadores (sin redibujar). Devuelve true si alguno llegó a 0.
  function tick(root, now) {
    let expired = false;
    root.querySelectorAll('[data-cd]').forEach((el) => {
      const ms = Number(el.getAttribute('data-cd')) - now;
      if (ms <= 0) expired = true;
      else el.textContent = fmtCountdown(ms);
    });
    root.querySelectorAll('[data-cds]').forEach((el) => {
      const ms = Number(el.getAttribute('data-cds')) - now;
      if (ms <= 0) expired = true;
      else el.textContent = fmtCountdownShort(ms);
    });
    root.querySelectorAll('[data-ago]').forEach((el) => {
      el.textContent = fmtAgo(Number(el.getAttribute('data-ago')), now);
    });
    root.querySelectorAll('[data-agos]').forEach((el) => {
      el.textContent = fmtAgoShort(Number(el.getAttribute('data-agos')), now);
    });
    return expired;
  }

  // Colores por nivel según lo que queda
  const levelColor = (left) => (left <= 15 ? '#e5484d' : left <= 40 ? '#f5a524' : '#46a758');
  const usedColor = (used) => levelColor(100 - used);
  // La severidad que informa Anthropic solo puede subir el color, nunca bajarlo.
  // Solo he visto "normal"; los demás valores son suposiciones por palabra clave.
  const RANK = { '#46a758': 0, '#f5a524': 1, '#e5484d': 2 };
  function sevColor(sev) {
    const s = String(sev || '').toLowerCase();
    if (!s || /^(normal|ok|low|none)$/.test(s)) return null;
    if (/crit|error|exceed|reach|block|danger|high|severe/.test(s)) return '#e5484d';
    if (/warn|elev|approach|medium|moderate/.test(s)) return '#f5a524';
    return null;
  }
  function windowColor(w) {
    const a = usedColor(w.usedPct), b = sevColor(w.sev);
    return b && RANK[b] > RANK[a] ? b : a;
  }

  // Resumen: la ventana activa más cercana al límite
  function summary(state, now) {
    const wins = windowsOf(state);
    const withPct = wins.filter((w) => w.usedPct != null && w.usedPct >= 0 && w.usedPct <= 100);
    const isPassed = (w) => { const d = toDate(w.reset); return !!(d && d < now); };
    const active = withPct.filter((w) => !isPassed(w));
    const worst = active.length ? active.reduce((a, b) => (b.usedPct > a.usedPct ? b : a)) : null;
    const left = worst ? Math.max(0, 100 - worst.usedPct) : null;
    const weekly = active.find((w) => w.lenMs && w.lenMs >= 24 * 3600e3) || null;
    const ageMs = state && state.lastAt ? now - state.lastAt : null;
    return {
      wins, withPct, worst, left, isPassed, color: worst ? windowColor(worst) : null, weekly, pace: pace(weekly, now),
      resetPassed: withPct.length > 0 && !worst,
      ageMs, stale: ageMs != null && ageMs > STALE_MIN * 60000,
    };
  }

  // ---------- Historial ----------
  function addSample(hist, wins, now, conv) {
    const w = {}, r = {};
    for (const x of wins) {
      if (x.usedPct == null) continue;
      w[x.name] = Math.round(x.usedPct * 10) / 10;
      const d = toDate(x.reset);
      r[x.name] = d ? d.getTime() : null;
    }
    if (!Object.keys(w).length) return hist || [];
    const out = (hist || []).filter((s) => s.t > now - HIST_DAYS * 86400e3);
    const last = out[out.length - 1];
    if (last && now - last.t < 3000) out.pop();
    out.push({ t: now, w, r, c: conv || null });
    return out.slice(-HIST_MAX);
  }

  // Gráfica de líneas (% usado) de las últimas `hours` horas
  function sparkline(hist, hours, now) {
    const W = 300, H = 64, P = 4;
    const t0 = now - hours * 3600e3;
    const pts = (hist || []).filter((s) => s.t >= t0);
    if (pts.length < 2) {
      return `<div style="color:${MUTED}">Aún no hay suficientes datos (se llena con cada mensaje que envías).</div>`;
    }
    const X = (t) => P + ((t - t0) / (now - t0)) * (W - 2 * P);
    const Y = (v) => H - P - (Math.min(100, Math.max(0, v)) / 100) * (H - 2 * P);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block;background:#2a2928;border-radius:6px">` +
      `<line x1="${P}" x2="${W - P}" y1="${Y(50)}" y2="${Y(50)}" stroke="#444" stroke-dasharray="3 3"/>` +
      `<text x="6" y="11" fill="#888" font-size="9">100%</text><text x="6" y="${H - 6}" fill="#888" font-size="9">0%</text>`;
    let legend = '';
    for (const [name, col] of [['Sesión 5 h', C5], ['Semanal', C7]]) {
      const s = pts.filter((p) => p.w && p.w[name] != null);
      if (!s.length) continue;
      if (s.length > 1) {
        svg += `<polyline points="${s.map((p) => X(p.t).toFixed(1) + ',' + Y(p.w[name]).toFixed(1)).join(' ')}" fill="none" stroke="${col}" stroke-width="2"/>`;
      }
      const l = s[s.length - 1];
      svg += `<circle cx="${X(l.t).toFixed(1)}" cy="${Y(l.w[name]).toFixed(1)}" r="2.5" fill="${col}"/>`;
      legend += `<span style="margin-right:10px"><span style="display:inline-block;width:8px;height:8px;background:${col};border-radius:2px;margin-right:3px"></span>${name}</span>`;
    }
    return svg + '</svg>' + `<div style="margin-top:2px;color:${MUTED}">${legend}</div>`;
  }

  // Puntos de una gráfica escalonada de "% restante": el valor se mantiene hasta la siguiente muestra
  // y, si entre dos muestras pasó la hora de reinicio, sube a 100 % justo en ese momento.
  // Devuelve { pts: [[t, restante]], resets: [t] } recortado a [t0, now].
  function stepSeries(hist, name, t0, now) {
    const h = (hist || []).filter((s) => s.w && s.w[name] != null);
    const pts = [], resets = [];
    let prev = null;
    for (const s of h) {
      const v = Math.max(0, Math.min(100, 100 - s.w[name]));
      if (prev) {
        const rt = prev.r && prev.r[name];
        pts.push([s.t, prev.v]);
        if (rt && rt > prev.t && rt <= s.t) {
          // Reinicio entre muestras: horizontal hasta el reinicio, salto a 100, horizontal hasta la muestra
          pts.splice(pts.length - 1, 1, [rt, prev.v], [rt, 100], [s.t, 100]);
          resets.push(rt);
        } else if (v > prev.v + 0.5 && !sameReset(rt, s.r && s.r[name])) {
          resets.push(s.t); // cambió de ventana sin hora de reinicio conocida
        }
      }
      pts.push([s.t, v]);
      prev = { t: s.t, v, r: s.r };
    }
    if (prev) {
      const rt = prev.r && prev.r[name];
      if (rt && rt > prev.t && rt <= now) { pts.push([rt, prev.v], [rt, 100], [now, 100]); resets.push(rt); }
      else pts.push([now, prev.v]);
    }
    // Recorte a la ventana visible: el primer punto visible arranca en t0 con el valor vigente
    const out = [];
    let before = null;
    for (const p of pts) {
      if (p[0] < t0) { before = p; continue; }
      if (!out.length && before) out.push([t0, before[1]]);
      out.push(p);
    }
    return { pts: out, resets: resets.filter((t) => t >= t0 && t <= now) };
  }

  // Gráfica escalonada del % restante en la sesión, con reinicios marcados y horas en el eje X
  function stepChart(hist, hours, now, name) {
    name = name || 'Sesión 5 h';
    const t0 = now - hours * 3600e3;
    const { pts, resets } = stepSeries(hist, name, t0, now);
    if (pts.length < 2) {
      return `<div style="color:${MUTED}">Aún no hay suficientes datos (se llena con cada mensaje que envías).</div>`;
    }
    const W = 300, H = 76, L = 4, R = 4, T = 6, B = 16;
    const X = (t) => L + ((t - t0) / (now - t0)) * (W - L - R);
    const Y = (v) => T + (1 - v / 100) * (H - T - B);
    const line = pts.map((p) => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ');
    const area = `${X(pts[0][0]).toFixed(1)},${Y(0).toFixed(1)} ${line} ${X(now).toFixed(1)},${Y(0).toFixed(1)}`;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block">` +
      `<line x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}" stroke="#444"/>` +
      `<line x1="${L}" x2="${W - R}" y1="${Y(50)}" y2="${Y(50)}" stroke="#3a3a3a" stroke-dasharray="3 3"/>` +
      `<text x="${L + 2}" y="${Y(50) - 3}" fill="#777" font-size="9">50%</text>` +
      `<polygon points="${area}" fill="${C7}" fill-opacity=".12"/>` +
      `<polyline points="${line}" fill="none" stroke="${C7}" stroke-width="1.75" stroke-linejoin="round"/>`;
    resets.forEach((t, i) => {
      const x = X(t).toFixed(1);
      svg += `<line x1="${x}" x2="${x}" y1="${T}" y2="${Y(0)}" stroke="#777" stroke-dasharray="2 2"/>`;
      if (i === resets.length - 1) {
        const right = +x > W - 50; // cerca del borde derecho: la etiqueta va a la izquierda de la línea
        svg += `<text x="${(+x + (right ? -3 : 3)).toFixed(1)}" y="${T + 8}" fill="#888" font-size="9" text-anchor="${right ? 'end' : 'start'}">reinicio</text>`;
      }
    });
    const last = pts[pts.length - 1];
    svg += `<circle cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="2.5" fill="${C7}"/>`;
    for (let i = 0; i <= 4; i++) {
      const t = t0 + (i / 4) * (now - t0);
      const anchor = i === 0 ? 'start' : i === 4 ? 'end' : 'middle';
      const lbl = i === 4 ? 'ahora' : clock(new Date(t));
      svg += `<text x="${X(t).toFixed(1)}" y="${H - 3}" fill="#888" font-size="9" text-anchor="${anchor}">${lbl}</text>`;
    }
    return svg + '</svg>';
  }

  // Barras: cuánto de la sesión de 5 h se gasta en cada hora del día
  function hourly(hist, name) {
    name = name || 'Sesión 5 h';
    const bins = new Array(24).fill(0);
    const h = hist || [];
    for (let i = 1; i < h.length; i++) {
      const a = h[i - 1], b = h[i];
      if (!a.w || !b.w || a.w[name] == null || b.w[name] == null) continue;
      if (!a.r || !b.r || !sameReset(a.r[name], b.r[name])) continue; // cambió de ventana
      const dv = b.w[name] - a.w[name];
      if (dv > 0 && b.t - a.t < 6 * 3600e3) bins[new Date(b.t).getHours()] += dv;
    }
    const max = Math.max.apply(null, bins);
    if (max <= 0) return `<div style="color:${MUTED}">Sin datos de consumo por hora todavía.</div>`;
    const W = 300, H = 70, P = 4, base = H - 14;
    const bw = (W - 2 * P) / 24;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block;background:#2a2928;border-radius:6px">`;
    bins.forEach((v, i) => {
      const bh = (v / max) * (base - 6);
      svg += `<rect x="${(P + i * bw + 1).toFixed(1)}" y="${(base - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" fill="${C5}" rx="1"/>`;
    });
    [0, 6, 12, 18, 23].forEach((hr) => {
      svg += `<text x="${(P + hr * bw + bw / 2).toFixed(1)}" y="${H - 3}" fill="#888" font-size="9" text-anchor="middle">${hr}</text>`;
    });
    svg += '</svg>';
    const top = bins.indexOf(max);
    return svg + `<div style="margin-top:2px;color:${MUTED}">Hora con más consumo: ${top}:00 · eje: hora del día</div>`;
  }

  // ---------- Detector de formato, avisos de reinicio y estimaciones ----------
  const hasValid = (wins) => wins.some((w) => w.usedPct != null && w.usedPct >= 0 && w.usedPct <= 100);

  function formatWarning(state) {
    const n = (state && state.missing) || 0;
    if (n < MISSING_MAX) return '';
    return `No recibo datos de uso válidos desde hace ${n} mensajes seguidos. Es posible que claude.ai haya cambiado el formato: abre el Diagnóstico y pega el JSON en el chat para ajustar la extensión.`;
  }

  // Ventanas a las que el fondo (background.js) puede programar un aviso de reinicio
  function resetItems(wins) {
    const out = [];
    for (const w of wins) {
      if (w.usedPct == null || w.usedPct < 0 || w.usedPct > 100) continue;
      const d = toDate(w.reset);
      if (!d) continue;
      out.push({ name: w.name, resetAt: d.getTime(), left: Math.max(0, 100 - w.usedPct) });
    }
    return out;
  }

  // Dos muestras consecutivas comparables: misma ventana (con tolerancia) y menos de 6 h entre ellas
  const pairOk = (a, b, name) =>
    !!(a && b && a.w && b.w && a.w[name] != null && b.w[name] != null && a.r && b.r &&
      sameReset(a.r[name], b.r[name]) && b.t - a.t < 6 * 3600e3);

  // Costo típico de un mensaje = subida total de % ÷ mensajes, en las últimas COST_N parejas comparables.
  // Incluye los mensajes que "costaron 0 %": el % llega entero, así que ignorarlos inflaría el costo.
  // Ojo: si usas Claude en otro dispositivo, ese consumo también aparece aquí.
  const COST_N = 12;
  function costStats(hist, name) {
    const h = hist || [];
    const deltas = [];
    for (let i = 1; i < h.length; i++) {
      if (!pairOk(h[i - 1], h[i], name)) continue;
      const dv = h[i].w[name] - h[i - 1].w[name];
      if (dv >= 0) deltas.push(dv);
    }
    const recent = deltas.slice(-COST_N);
    const typical = recent.length ? recent.reduce((x, y) => x + y, 0) / recent.length : null;
    let last = null;
    if (h.length >= 2 && pairOk(h[h.length - 2], h[h.length - 1], name)) {
      last = Math.max(0, h[h.length - 1].w[name] - h[h.length - 2].w[name]);
    }
    return { last, typical, n: recent.length };
  }

  // ---------- Costo por chat, "no te alcanza" y ritmo semanal ----------

  // Cambios de % entre mensajes consecutivos DEL MISMO chat (incluye ceros: el % es entero)
  function chatStats(hist, name, conv) {
    const h = hist || [];
    const deltas = [];
    let count = 0;
    for (let i = 0; i < h.length; i++) {
      if (h[i].c !== conv) continue;
      count++;
      const a = h[i - 1];
      if (a && a.c === conv && pairOk(a, h[i], name)) {
        const dv = h[i].w[name] - a.w[name];
        if (dv >= 0) deltas.push(dv);
      }
    }
    const recent = deltas.slice(-6);
    const typical = recent.length ? recent.reduce((x, y) => x + y, 0) / recent.length : null;
    return { n: deltas.length, typical, last: deltas.length ? deltas[deltas.length - 1] : null, count };
  }

  // Lo que cuestan los primeros mensajes de tus otros chats (el 2.º muestreo de cada chat)
  function newChatBaseline(hist, name, except) {
    const h = hist || [];
    const seen = {};
    for (let i = 0; i < h.length; i++) {
      const b = h[i];
      if (!b.c) continue;
      const info = seen[b.c] || (seen[b.c] = { count: 0, first: null });
      const a = h[i - 1];
      if (info.count === 1 && a && a.c === b.c && pairOk(a, b, name)) {
        const dv = b.w[name] - a.w[name];
        if (dv >= 0) info.first = dv;
      }
      info.count++;
    }
    const firsts = [];
    for (const c of Object.keys(seen)) if (c !== except && seen[c].first != null) firsts.push(seen[c].first);
    if (!firsts.length) return null;
    return { mean: firsts.reduce((x, y) => x + y, 0) / firsts.length, chats: firsts.length };
  }

  // ¿Este chat ya gasta bastante más que uno nuevo?
  function chatAdvice(hist, w, conv) {
    if (!w || !conv) return null;
    const cs = chatStats(hist, w.name, conv);
    if (cs.n < 3 || cs.typical == null) return null;
    const base = newChatBaseline(hist, w.name, conv);
    if (!base || base.chats < 2) return null;
    if (cs.typical >= Math.max(2, base.mean * 2)) return { typical: cs.typical, baseline: base.mean, msgs: cs.count, chats: base.chats };
    return null;
  }

  function estimate(hist, w, conv) {
    if (!w) return null;
    const left = Math.max(0, 100 - w.usedPct);
    const cs = conv ? chatStats(hist, w.name, conv) : null;
    if (cs && cs.n >= 2 && cs.typical > 0) {
      return { msgs: Math.floor(left / cs.typical), typical: cs.typical, n: cs.n, last: cs.last, scope: 'chat' };
    }
    const st = costStats(hist, w.name);
    if (st.n >= 3 && st.typical > 0) {
      return { msgs: Math.floor(left / st.typical), typical: st.typical, n: st.n, last: st.last, scope: 'global' };
    }
    return { msgs: null, typical: null, n: st.n, last: st.last, scope: 'global' };
  }

  const num = (x) => String(Number(x.toFixed(1)));
  function estimateHtml(est, label) {
    if (!est) return '';
    const parts = [];
    if (est.last != null) parts.push(`Último cambio: ${est.last >= 0 ? '+' : ''}${num(est.last)}%`);
    if (est.msgs != null) parts.push(`≈ ${est.msgs} mensajes más (típico +${num(est.typical)}% c/u${est.scope === 'chat' ? ' en este chat' : ''})`);
    else parts.push(`estimando mensajes… (${est.n}/3)`);
    if (label) parts.push(label);
    return parts.join(' · ');
  }

  // ¿Alcanza para otro mensaje como los últimos? (usa el costo más alto entre el típico y el último)
  function shortfall(est, w) {
    if (!est || est.msgs == null || !w) return null;
    const left = Math.max(0, 100 - w.usedPct);
    const cost = Math.max(est.typical, est.last || 0);
    if (!(cost > 0)) return null;
    if (left < cost) return { level: 'out', left, cost };
    if (left < 2 * cost) return { level: 'low', left, cost };
    return null;
  }

  function shortfallText(sf, name) {
    return (name ? name + ': t' : 'T') + `e queda ${num(sf.left)}% y los últimos mensajes cuestan ≈ +${num(sf.cost)}%: ` +
      (sf.level === 'out' ? 'el próximo podría dejarte sin uso.' : 'te alcanza para ~1 mensaje más.');
  }

  // Ritmo de una ventana larga (semanal): % usado frente a % de tiempo transcurrido
  function pace(w, now) {
    if (!w || !w.lenMs || w.lenMs < 24 * 3600e3 || w.usedPct == null) return null;
    const d = toDate(w.reset);
    if (!d) return null;
    const remain = d - now;
    if (remain <= 0 || remain > w.lenMs) return null;
    const elapsed = w.lenMs - remain;
    const out = { usedPct: w.usedPct, elapsedPct: (elapsed / w.lenMs) * 100, elapsedMs: elapsed, remainMs: remain, resetMs: d.getTime() };
    if (elapsed < 6 * 3600e3 || w.usedPct < 1) { out.status = 'early'; return out; }
    out.projected = w.usedPct / (elapsed / w.lenMs);
    if (out.projected > 100) {
      out.status = 'fast';
      out.msToLimit = (100 - w.usedPct) / (w.usedPct / elapsed);
    } else {
      out.status = 'ok';
    }
    return out;
  }

  const fmtSpan = (ms) => (ms >= 36 * 3600e3 ? `${(ms / 86400e3).toFixed(1)} días` : `${Math.max(1, Math.round(ms / 3600e3))} h`);

  function paceText(p) {
    const u = Math.round(p.usedPct), e = Math.round(p.elapsedPct);
    if (p.status === 'early') return `Ritmo semanal: ${u}% usado y ${e}% de la semana transcurrida (aún pocos datos para proyectar).`;
    if (p.status === 'fast') return `⚠️ Ritmo semanal alto: ${u}% usado en el ${e}% de la semana. A este ritmo se agotará en ~${fmtSpan(p.msToLimit)}, antes del reinicio.`;
    return `Ritmo semanal: ${u}% usado en el ${e}% de la semana. A este ritmo cerrarás la semana en ~${Math.round(p.projected)}%.`;
  }

  // Todo lo anterior junto, para la barra y el popup.
  // Se evalúa la ventana que se agotaría primero (la de menos mensajes restantes), que no siempre es la más usada.
  function advice(hist, s, conv) {
    const out = { est: null, estName: '', estWin: null, sf: null, sfText: '', tip: null, tipText: '', chatLine: '', pace: s.pace || null, paceText: '' };
    let bw = null, best = null;
    for (const w of s.withPct) {
      if (s.isPassed(w)) continue;
      const e = estimate(hist, w, conv);
      if (e && e.msgs != null && (best == null || e.msgs < best.msgs)) { bw = w; best = e; }
    }
    if (!bw && s.worst) { bw = s.worst; best = estimate(hist, s.worst, conv); }
    if (bw) {
      out.est = best;
      out.estName = bw.name;
      out.estWin = bw;
      out.sf = shortfall(best, bw);
      if (out.sf) out.sfText = shortfallText(out.sf, bw.name);
      const t = chatAdvice(hist, bw, conv);
      if (t) {
        out.tip = t;
        out.tipText = `💡 Este chat ya cuesta ≈ +${num(t.typical)}% por mensaje; tus chats nuevos empiezan en ≈ +${num(t.baseline)}%. Abrir uno nuevo gastaría menos.`;
      }
      if (conv) {
        const cs = chatStats(hist, bw.name, conv);
        if (cs.typical != null) out.chatLine = `Este chat: ≈ +${num(cs.typical)}% por mensaje (${cs.count} mensajes vistos)`;
      }
    }
    if (s.pace) out.paceText = paceText(s.pace);
    return out;
  }

  return {
    KEYS, DEFAULTS, MISSING_MAX, esc, today, mergeSettings, findWindows, interpret, windowsOf, toDate,
    friendlyName, winLen, sameReset, resetKey,
    fmtCountdown, fmtReset, resetHtml, fmtAgo, agoHtml, tick,
    fmtCountdownShort, fmtAgoShort, renewHtml, agoShortHtml, statusLabel, stepSeries, stepChart, num,
    levelColor, usedColor, windowColor, summary, addSample, sparkline, hourly,
    hasValid, formatWarning, resetItems, costStats, chatStats, newChatBaseline, chatAdvice, estimate, estimateHtml,
    shortfall, shortfallText, pace, paceText, advice,
  };
})();
