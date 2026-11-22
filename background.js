// Service worker: programa y muestra el aviso "tu sesión ya se reinició".
const PKEY = 'claudeUsoPending';
const ICON = 'icons/icon128.png';

function notify(id, title, message) {
  try {
    chrome.notifications.create(id, { type: 'basic', iconUrl: ICON, title, message, priority: 2 });
  } catch (e) {}
}
const getPending = (cb) => chrome.storage.local.get(PKEY, (r) => cb((r && r[PKEY]) || {}));
const setPending = (p) => chrome.storage.local.set({ [PKEY]: p });

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'test') {
    notify('cu-test-' + Date.now(), 'Claude Uso Restante', 'Las notificaciones funcionan ✅');
  } else if (msg.type === 'sample') {
    handleSample(msg);
  }
});

// Cada muestra decide si hay que avisar al reiniciarse: solo si te quedaste con poco.
function handleSample(msg) {
  getPending((p) => {
    const now = Date.now();
    for (const it of msg.items || []) {
      const alarm = 'reset|' + it.name;
      const wants = msg.notifyReset && msg.threshold > 0 && it.resetAt > now && it.left <= msg.threshold;
      if (wants) {
        p[it.name] = { resetAt: it.resetAt, left: it.left };
        chrome.alarms.create(alarm, { when: it.resetAt });
      } else {
        delete p[it.name];
        chrome.alarms.clear(alarm);
      }
    }
    setPending(p);
  });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (!a.name || !a.name.startsWith('reset|')) return;
  const name = a.name.slice(6);
  getPending((p) => {
    if (!p[name]) return;
    notify('cu-reset-' + Date.now(), `✅ ${name} reiniciada`, 'Ya tienes uso disponible otra vez en claude.ai.');
    delete p[name];
    setPending(p);
  });
});

// Las alarmas pueden perderse al cerrar el navegador: se recrean al abrirlo.
function rebuild() {
  getPending((p) => {
    const now = Date.now();
    let changed = false;
    for (const [name, v] of Object.entries(p)) {
      if (v.resetAt > now) {
        chrome.alarms.create('reset|' + name, { when: v.resetAt });
      } else {
        const mins = Math.round((now - v.resetAt) / 60000);
        if (mins < 24 * 60) notify('cu-late-' + Date.now(), `✅ ${name} reiniciada`, `Se reinició hace ${mins} min. Ya tienes uso disponible.`);
        delete p[name];
        changed = true;
      }
    }
    if (changed) setPending(p);
  });
}
chrome.runtime.onStartup.addListener(rebuild);
chrome.runtime.onInstalled.addListener(rebuild);
