// Gate 0 stress: restore cost, other-LP liquidity multiplier, IVL/adaptive range. Deterministic.
import fs from 'fs';
import { computeIVL } from '../../../third_city/skills/ivl/scripts/ivl-core.mjs';
const pools = JSON.parse(fs.readFileSync(new URL('./data/pools.json', import.meta.url)));
const ADDR = { NVDAB: '0x8fb4243b553ac29ba088acf00b9b7da24bd6690c', TSLAB: '0xb0f5e5400e8f0f7c242f2b7740c004f020579c41' };
const H = 3600, GAS = 0.6, RIVER_PCT = 0.10, RIVER_FIXED = 0.25, RESTORE_COST = 0.0025 + 0.001; // pool fee + impact on swapped value
const HOLIDAYS = ['2026-06-19', '2026-07-03', '2026-09-07'];
const day = t => new Date(t * 1000).toISOString().slice(0, 10);
function profile(p, mult) { const net = Object.entries(p.net).map(([t, n]) => [+t, BigInt(n)]).sort((a, b) => a[0] - b[0]); const L0 = BigInt(p.liquidity);
  return tick => { let L = L0; if (tick >= p.tick) { for (const [t, n] of net) if (t > p.tick && t <= tick) L += n; } else { for (let i = net.length - 1; i >= 0; i--) { const [t, n] = net[i]; if (t <= p.tick && t > tick) L -= n; } } return Number(L < 0n ? 0n : L) * mult; }; }
const mk = p => { const s0 = p.sym0 !== 'USDT'; const toP = s => s0 ? s : 1 / s; return { stock0: s0, toP, toTick: s => Math.floor(Math.log(toP(s)) / Math.log(1.0001)), fee: p.fee / 1e6 }; };
function position(S, s0, lo, hi, m) { const [a, b] = [m.toP(lo), m.toP(hi)].sort((x, y) => x - y); const sp = Math.sqrt(m.toP(s0)), sa = Math.sqrt(a), sb = Math.sqrt(b);
  const a0 = 1 / sp - 1 / sb, a1 = sp - sa; const L = S / (m.stock0 ? a0 * s0 + a1 : a0 + a1 * s0);
  return { L, amounts: s => { const c = Math.min(Math.max(Math.sqrt(m.toP(s)), sa), sb); const x0 = L * (1 / c - 1 / sb), x1 = L * (c - sa); return m.stock0 ? { stock: x0, usd: x1 } : { stock: x1, usd: x0 }; } }; }
function hourly(name) { const c = JSON.parse(fs.readFileSync(new URL(`./data/ohlcv_${name}.json`, import.meta.url))); const out = new Map();
  for (let t = c[0][0], i = 0, last = c[0][4]; t <= c.at(-1)[0]; t += H) { if (i < c.length && c[i][0] === t) { out.set(t, { ts: t, o: c[i][1], h: c[i][2], l: c[i][3], c: c[i][4], vol: c[i][5] }); last = c[i][4]; i++; } else out.set(t, { ts: t, o: last, h: last, l: last, c: last, vol: 0 }); } return out; }
function windows(ser, kind) { const ts = [...ser.keys()]; const w = [];
  for (let t = Math.ceil(ts[0] / 86400) * 86400; t <= ts.at(-1); t += 86400) { const dow = new Date(t * 1000).getUTCDay();
    if (kind === 'weekend' && dow === 6) { let a = t, b = t + 2 * 86400; if (HOLIDAYS.includes(day(t - 86400))) a -= 86400; if (HOLIDAYS.includes(day(t + 2 * 86400))) b += 86400; w.push([a + H, b - 2 * H]); }
    if (kind === 'weekday' && dow === 2) w.push([t + H, t + 2 * 86400 - 2 * H]); }
  return w.filter(([a, b]) => ser.has(a) && ser.has(b)); }
function halfWidth(mode, ser, a, prevWins) {
  if (typeof mode === 'number') return mode;
  if (mode === 'ivl') { // IVL on the 120h before entry (1h primary + 4h)
    const h1 = []; for (let t = a - 120 * H; t < a; t += H) if (ser.has(t)) h1.push(ser.get(t));
    const h4 = []; for (let i = 0; i + 4 <= h1.length; i += 4) { const g = h1.slice(i, i + 4); h4.push({ ts: g[0].ts, o: g[0].o, h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)), c: g[3].c, vol: g.reduce((s, x) => s + x.vol, 0) }); }
    const r = computeIVL({ '1h': h1.filter(k => k.vol > 0), '4h': h4 });
    if (!r.ok) return 0.03; const s0 = ser.get(a).c; return Math.max(0.005, (r.lpRange.upper - r.lpRange.lower) / 2 / s0);
  }
  if (mode === 'adaptive') { // p80 of the |max excursion| of the previous 4 weekends (from their own entry), +20% buffer; fallback 3%
    const prev = prevWins.slice(-4); if (prev.length < 2) return 0.03;
    const ex = prev.map(([x, y]) => { const s = ser.get(x).c; let m = 0; for (let t = x; t <= y; t += H) m = Math.max(m, Math.abs(ser.get(t).h / s - 1), Math.abs(ser.get(t).l / s - 1)); return m; }).sort((p, q) => p - q);
    return Math.max(0.005, ex[Math.floor(0.8 * (ex.length - 1))] * 1.2);
  }
}
function run(name, S, mode, kind, mult = 1, restore = true) {
  const p = pools[ADDR[name]], m = mk(p), Lo = profile(p, mult), ser = hourly(name), W = windows(ser, kind), rows = [];
  W.forEach(([a, b], i) => {
    const s0 = ser.get(a).c, hw = halfWidth(mode, ser, a, W.slice(0, i)), lo = s0 * (1 - hw), hi = s0 * (1 + hw);
    const pos = position(S, s0, lo, hi, m), x0 = pos.amounts(s0); let fees = 0, inR = 0, n = 0;
    for (let t = a + H; t <= b; t += H) { const k = ser.get(t); n++; if (k.c < lo || k.c > hi) continue; inR++; const Lu = pos.L * 1e18; fees += k.vol * m.fee * Lu / (Lu + Lo(m.toTick(k.c))); }
    const s1 = ser.get(b).c, x1 = pos.amounts(s1), il = (x0.stock * s1 + x0.usd) - (x1.stock * s1 + x1.usd);
    const restoreCost = restore ? Math.abs(x1.stock - x0.stock) * s1 * RESTORE_COST : 0;
    const river = fees * RIVER_PCT + RIVER_FIXED, net = fees - il - GAS - river - restoreCost;
    rows.push({ start: day(a), hw: hw * 100, drift: (s1 / s0 - 1) * 100, fees, il, restoreCost, river, net, netPct: net / S * 100, inR: inR / n * 100, dShares: (x1.stock / x0.stock - 1) * 100 });
  });
  return rows;
}
const avg = (a, f) => a.reduce((x, y) => x + f(y), 0) / a.length;
const z = r => ({ apr: avg(r, x => x.netPct) * 52, win: r.filter(x => x.net > 0).length / r.length * 100, worst: Math.min(...r.map(x => x.netPct)) });
const fmt = r => { const q = z(r); return `${q.apr.toFixed(1).padStart(6)}% w${q.win.toFixed(0).padStart(3)} worst${q.worst.toFixed(2).padStart(6)}%`; };
for (const name of Object.keys(ADDR)) {
  console.log(`\n### ${name} — net APR (after gas, River 10%+$0.25, RESTORE to same shares), S=$10k / $50k`);
  for (const kind of ['weekend', 'weekday']) for (const mode of [0.02, 0.03, 'ivl', 'adaptive']) for (const mult of [1, 2, 4])
    console.log(`${kind.padEnd(8)} ${String(mode).padEnd(8)} otherLPx${mult}  S10k:${fmt(run(name, 10000, mode, kind, mult))}   S50k:${fmt(run(name, 50000, mode, kind, mult))}`);
}
console.log('\n### NVDAB weekend, adaptive range, S=$10k, others x1 — per window');
console.table(run('NVDAB', 10000, 'adaptive', 'weekend').map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(2) : v]))));
console.log('\n### TSLAB weekend, adaptive, S=$10k — per window');
console.table(run('TSLAB', 10000, 'adaptive', 'weekend').map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(2) : v]))));
