// Pruebas de la lógica de shared.js, sin navegador:  node tests/shared.test.js
// Chrome ignora esta carpeta al cargar la extensión.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared.js'), 'utf8') + ';this.CU = CU;', ctx);
const CU = ctx.CU;

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FALLA', name, '\n       ', e.message); }
}
const S5 = 'Sesión 5 h';
const sample = (t, pct, reset, c) => ({ t, w: { [S5]: pct }, r: { [S5]: reset }, c: c || null });

console.log('Nombres y duración de ventanas');
test('7d_opus no se llama igual que la semanal general', () => {
  const wins = CU.windowsOf({ lastLimit: { windows: {
    '5h': { utilization: 0.4, resets_at: 1 }, '7d': { utilization: 0.2, resets_at: 2 }, '7d_opus': { utilization: 0.9, resets_at: 3 },
  } } });
  const names = wins.map((w) => w.name);
  assert.strictEqual(new Set(names).size, names.length, 'nombres repetidos: ' + names.join(', '));
  assert.ok(names.includes('Semanal'));
  assert.ok(names.includes('Semanal · Opus'));
});
test('dos ventanas con el mismo nombre se distinguen por la ruta', () => {
  const wins = CU.windowsOf({ lastLimit: { a: { '5h': { utilization: 0.1 } }, b: { '5h': { utilization: 0.2 } } } });
  assert.strictEqual(new Set(wins.map((w) => w.name)).size, 2);
});
test('winLen reconoce 5h, 7d, 7d_opus, five_hour, seven_day', () => {
  assert.strictEqual(CU.winLen('5h'), 5 * 3600e3);
  assert.strictEqual(CU.winLen('7d'), 7 * 86400e3);
  assert.strictEqual(CU.winLen('7d_opus'), 7 * 86400e3);
  assert.strictEqual(CU.winLen('five_hour'), 5 * 3600e3);
  assert.strictEqual(CU.winLen('seven_day'), 7 * 86400e3);
  assert.strictEqual(CU.winLen('otra_cosa'), null);
});
test('ventana que solo llega por "percent" también tiene duración', () => {
  const wins = CU.windowsOf({ lastLimit: { resolved: { limit: { kind: 'seven_day', percent: 30 } } } });
  assert.strictEqual(wins[0].lenMs, 7 * 86400e3);
});
test('percent se prefiere sobre utilization', () => {
  const wins = CU.windowsOf({ lastLimit: { windows: { '5h': { utilization: 0.33 } }, limit: { kind: '5h', percent: 34 } } });
  assert.strictEqual(wins.length, 1);
  assert.strictEqual(wins[0].usedPct, 34);
});

console.log('Escala de utilization');
test('fracciones: 1 = 100 %', () => {
  const w = CU.windowsOf({ lastLimit: { '5h': { utilization: 1 }, '7d': { utilization: 0.5 } } });
  assert.strictEqual(JSON.stringify(w.map((x) => x.usedPct)), "[100,50]");
});
test('porcentajes: si algún valor > 1, 1 = 1 %', () => {
  const w = CU.windowsOf({ lastLimit: { '5h': { utilization: 1 }, '7d': { utilization: 40 } } });
  assert.strictEqual(JSON.stringify(w.map((x) => x.usedPct)), "[1,40]");
});

console.log('Costo por mensaje');
test('cuenta los mensajes que costaron 0 % (costo real 0,5 %)', () => {
  const h = [];
  for (let i = 0; i < 13; i++) h.push(sample(i * 60e3, Math.floor(i / 2), 1e12));
  const st = CU.costStats(h, S5);
  assert.ok(Math.abs(st.typical - 0.5) < 0.01, 'typical=' + st.typical);
});
test('tolera segundos de diferencia en la hora de reinicio', () => {
  const h = [];
  for (let i = 0; i < 6; i++) h.push(sample(i * 60e3, i * 2, 1e12 + i * 1000));
  const st = CU.costStats(h, S5);
  assert.strictEqual(st.n, 5);
  assert.strictEqual(st.typical, 2);
});
test('no mezcla ventanas distintas (reinicio horas después)', () => {
  const h = [sample(0, 80, 1e12), sample(60e3, 2, 1e12 + 5 * 3600e3)];
  assert.strictEqual(CU.costStats(h, S5).n, 0);
});
test('estimate usa el costo típico', () => {
  const h = [];
  for (let i = 0; i < 6; i++) h.push(sample(i * 60e3, i * 2, 1e12));
  const est = CU.estimate(h, { name: S5, usedPct: 10 }, null);
  assert.strictEqual(est.msgs, 45);
  assert.strictEqual(est.typical, 2);
});

console.log('Avisos');
test('resetKey es estable ante segundos de diferencia', () => {
  const base = Math.round(1e12 / 600e3) * 600e3; // justo en una marca de 10 min
  assert.strictEqual(CU.resetKey(new Date(base)), CU.resetKey(new Date(base + 30e3)));
});
test('shortfall avisa cuando no alcanza', () => {
  const sf = CU.shortfall({ msgs: 0, typical: 5, last: 6 }, { usedPct: 97 });
  assert.strictEqual(sf.level, 'out');
});

console.log('Rediseño de la barra (0.7.0)');
test('cuenta regresiva corta: sin segundos cuando falta más de 10 min', () => {
  assert.strictEqual(CU.fmtCountdownShort((2 * 3600 + 48 * 60 + 30) * 1000), '2 h 48 min');
  assert.strictEqual(CU.fmtCountdownShort(3 * 3600e3), '3 h');
  assert.strictEqual(CU.fmtCountdownShort((25 * 60 + 9) * 1000), '25 min');
  assert.strictEqual(CU.fmtCountdownShort((4 * 60 + 9) * 1000), '4 min 9 s');
});
test('"hace" corto: sin segundos pasado el minuto', () => {
  const now = 1e12;
  assert.strictEqual(CU.fmtAgoShort(now - (2 * 3600 + 5 * 60 + 12) * 1000, now), 'hace 2 h 5 min');
  assert.strictEqual(CU.fmtAgoShort(now - 7 * 60e3 - 40e3, now), 'hace 7 min');
});
test('within_limit se muestra como "Dentro del límite"', () => {
  assert.strictEqual(CU.statusLabel('within_limit').txt, 'Dentro del límite');
  assert.strictEqual(CU.statusLabel(''), null);
  assert.strictEqual(CU.statusLabel('algo_nuevo').txt, 'algo nuevo');
});
test('gráfica escalonada: sube a 100 % en la hora de reinicio', () => {
  const H = 3600e3, now = 1e12, reset = now - 3 * H;
  const hist = [sample(now - 5 * H, 40, reset), sample(now - 4 * H, 60, reset), sample(now - 1 * H, 10, now + 4 * H)];
  const { pts, resets } = JSON.parse(JSON.stringify(CU.stepSeries(hist, S5, now - 24 * H, now))); // arrays de otro contexto vm
  assert.deepStrictEqual(resets, [reset]);
  assert.ok(pts.some((p) => p[0] === reset && p[1] === 100), 'falta el salto a 100 en el reinicio');
  assert.ok(pts.some((p) => p[0] === reset && p[1] === 40), 'antes del reinicio debía mantenerse en 40 % restante');
  assert.deepStrictEqual(pts[pts.length - 1], [now, 90]);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i][0] >= pts[i - 1][0], 'puntos fuera de orden');
});
test('gráfica escalonada: si el reinicio ya pasó tras la última muestra, termina en 100 %', () => {
  const H = 3600e3, now = 1e12;
  const hist = [sample(now - 3 * H, 20, now - H), sample(now - 2 * H, 50, now - H)];
  const { pts, resets } = JSON.parse(JSON.stringify(CU.stepSeries(hist, S5, now - 24 * H, now))); // arrays de otro contexto vm
  assert.deepStrictEqual(pts[pts.length - 1], [now, 100]);
  assert.strictEqual(resets.length, 1);
});
test('stepChart devuelve un SVG con datos suficientes', () => {
  const H = 3600e3, now = 1e12;
  const svg = CU.stepChart([sample(now - 3 * H, 20, now + H), sample(now - 2 * H, 50, now + H)], 24, now);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('ahora'));
});

console.log(`\n${pass} correctas, ${fail} fallidas`);
process.exit(fail ? 1 : 0);
