// Gate 0 — weekend-only concentrated LP vs holding the same tokens. Deterministic, no randomness.
import fs from 'fs';
const pools = JSON.parse(fs.readFileSync(new URL('./data/pools.json', import.meta.url)));
const ADDR = { NVDAB: '0x8fb4243b553ac29ba088acf00b9b7da24bd6690c', TSLAB: '0xb0f5e5400e8f0f7c242f2b7740c004f020579c41', SPCXB: '0x977daffc095b33872e2741c19568925015c35b4d' };
const CFG = { gasUsd: +(process.env.GAS ?? 0.6), riverPct: +(process.env.RIVER_PCT ?? 0.10), riverFixed: +(process.env.RIVER_FIXED ?? 0.25) };
const H = 3600;
const HOLIDAYS = ['2026-06-19', '2026-07-03', '2026-09-07']; // NYSE closed (EDT all period)

// ---- liquidity profile of OTHER LPs, as function of pool tick (static snapshot of today) ----
function profile(p) {
  const net = Object.entries(p.net).map(([t, n]) => [+t, BigInt(n)]).sort((a, b) => a[0] - b[0]);
  const L0 = BigInt(p.liquidity);
  return tick => { // walk from current tick
    let L = L0;
    if (tick >= p.tick) { for (const [t, n] of net) if (t > p.tick && t <= tick) L += n; }
    else { for (let i = net.length - 1; i >= 0; i--) { const [t, n] = net[i]; if (t <= p.tick && t > tick) L -= n; } }
    return Number(L < 0n ? 0n : L);
  };
}
// stock USD price -> pool price (token1 per token0, raw units; decimals equal=18 here)
const mk = p => { const stock0 = p.sym0 !== 'USDT' && p.sym0 !== 'WBNB';
  const toP = s => stock0 ? s : 1 / s; const toTick = s => Math.floor(Math.log(toP(s)) / Math.log(1.0001));
  return { stock0, toP, toTick, fee: p.fee / 1e6 }; };

// v3 math in "whole token" units (dec 18 both -> raw L = whole L * 1e18)
function position(S, s0, lo, hi, m) { // value S USD at stock price s0, range [lo,hi] in stock USD price
  const [a, b] = [m.toP(lo), m.toP(hi)].sort((x, y) => x - y); const P = m.toP(s0);
  const sa = Math.sqrt(a), sb = Math.sqrt(b), sp = Math.sqrt(P);
  // per unit L: amount0 = (1/sp - 1/sb), amount1 = (sp - sa)
  const a0 = 1 / sp - 1 / sb, a1 = sp - sa;
  const val = (x0, x1) => m.stock0 ? x0 * s0 + x1 : x0 + x1 * s0; // USD
  const L = S / val(a0, a1);
  return { L, sa, sb, amounts: s => { const q = Math.sqrt(m.toP(s)); const c = Math.min(Math.max(q, sa), sb);
      const x0 = L * (1 / c - 1 / sb), x1 = L * (c - sa); return m.stock0 ? { stock: x0, usd: x1 } : { stock: x1, usd: x0 }; } };
}

function hourly(name) { // fill missing hours: price carry-forward, vol 0
  const c = JSON.parse(fs.readFileSync(new URL(`./data/ohlcv_${name}.json`, import.meta.url))); const out = new Map();
  for (let t = c[0][0], i = 0, last = c[0][4]; t <= c.at(-1)[0]; t += H) {
    if (i < c.length && c[i][0] === t) { out.set(t, { o: c[i][1], h: c[i][2], l: c[i][3], c: c[i][4], v: c[i][5] }); last = c[i][4]; i++; }
    else out.set(t, { o: last, h: last, l: last, c: last, v: 0 });
  }
  return out;
}
const day = t => new Date(t * 1000).toISOString().slice(0, 10);
function windows(series, kind) { // returns [entryTs, exitTs]
  const ts = [...series.keys()]; const t0 = ts[0], t1 = ts.at(-1); const w = [];
  for (let t = Math.ceil(t0 / 86400) * 86400; t <= t1; t += 86400) {
    const d = new Date(t * 1000), dow = d.getUTCDay();
    if (kind === 'weekend' && dow === 6) { // Sat 00:00 UTC = Fri 20:00 ET
      let start = t, end = t + 2 * 86400; // Mon 00:00 UTC = Sun 20:00 ET
      if (HOLIDAYS.includes(day(t - 86400))) start -= 86400;   // Fri holiday -> starts Fri 00:00 UTC
      if (HOLIDAYS.includes(day(t + 2 * 86400))) end += 86400;  // Mon holiday
      w.push([start + 1 * H, end - 2 * H]); // settle 1h, exit 2h before reopen
    }
    if (kind === 'weekday' && dow === 2) w.push([t + 1 * H, t + 2 * 86400 - 2 * H]); // Tue->Thu same length
  }
  return w.filter(([a, b]) => series.has(a) && series.has(b));
}

function run(name, S, halfW, kind) {
  const p = pools[ADDR[name]]; const m = mk(p); const Lo = profile(p); const ser = hourly(name);
  const rows = [];
  for (const [a, b] of windows(ser, kind)) {
    const s0 = ser.get(a).c, lo = s0 * (1 - halfW), hi = s0 * (1 + halfW);
    const pos = position(S, s0, lo, hi, m); const x0 = pos.amounts(s0);
    let fees = 0, inRange = 0, n = 0;
    for (let t = a + H; t <= b; t += H) { const k = ser.get(t); if (!k) continue; n++;
      const s = k.c; if (s < lo || s > hi) continue; inRange++;
      const Lus = pos.L * 1e18, Lother = Lo(m.toTick(s));
      fees += k.v * m.fee * Lus / (Lus + Lother);
    }
    const s1 = ser.get(b).c, x1 = pos.amounts(s1);
    const hodl = x0.stock * s1 + x0.usd, lpv = x1.stock * s1 + x1.usd, il = hodl - lpv;
    const river = fees * CFG.riverPct + CFG.riverFixed;
    const net = fees - il - CFG.gasUsd - river;
    rows.push({ start: day(a), drift: (s1 / s0 - 1) * 100, fees, il, net, netPct: net / S * 100, inRangePct: inRange / n * 100, shareDelta: (x1.stock / x0.stock - 1) * 100, river });
  }
  return rows;
}
const sum = (a, f) => a.reduce((x, y) => x + f(y), 0), med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function summarize(rows) {
  const n = rows.length, perYear = 52;
  return { n, winRate: rows.filter(r => r.net > 0).length / n * 100, avgNetPct: sum(rows, r => r.netPct) / n,
    apr: sum(rows, r => r.netPct) / n * perYear, medAbsShareDelta: med(rows.map(r => Math.abs(r.shareDelta))), inRange: sum(rows, r => r.inRangePct) / n,
    riverTotal: sum(rows, r => r.river) };
}
export { run, summarize, windows, hourly };
if (process.argv[1].endsWith('sim.mjs')) {
  const sizes = [1000, 10000, 50000, 200000], widths = [0.005, 0.01, 0.015, 0.02, 0.03, 0.05];
  for (const name of Object.keys(ADDR)) for (const kind of ['weekend', 'weekday']) {
    console.log(`\n== ${name} ${kind}  (net APR% on committed capital, after gas $${CFG.gasUsd} + River ${CFG.riverPct * 100}%+$${CFG.riverFixed})`);
    console.log('halfW   ' + sizes.map(s => ('S=' + s).padStart(22)).join(''));
    for (const w of widths) {
      const cells = sizes.map(S => { const z = summarize(run(name, S, w, kind)); return `${z.apr.toFixed(1)}% w${z.winRate.toFixed(0)} Δ${z.medAbsShareDelta.toFixed(1)}`.padStart(22); });
      console.log(('±' + (w * 100).toFixed(1) + '%').padEnd(8) + cells.join(''));
    }
    console.log('windows:', run(name, 10000, 0.02, kind).length);
  }
}
