// Read Pancake v3 pool state + liquidity profile via public BSC RPC (eth_call only).
import fs from 'fs';
const RPC = process.env.RPC || 'https://bsc-rpc.publicnode.com';
let id = 0;
async function rpc(batch) {
  const body = batch.map(([method, params]) => ({ jsonrpc: '2.0', id: ++id, method, params }));
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); j.sort((a, b) => a.id - b.id);
  return j.map(x => { if (x.error) throw new Error(JSON.stringify(x.error)); return x.result; });
}
const call = (to, data) => ['eth_call', [{ to, data }, 'latest']];
const word = (h, i) => h.slice(2 + 64 * i, 2 + 64 * (i + 1));
const toInt = (w, bits) => { let v = BigInt('0x' + w); const m = 1n << 256n; if (v >= m / 2n) v -= m; return v; };
const enc24 = t => (BigInt(t) & ((1n << 256n) - 1n)).toString(16).padStart(64, '0');

export async function readPool(addr) {
  const [s0, liq, ts, fee, t0, t1] = await rpc([
    call(addr, '0x3850c7bd'), call(addr, '0x1a686502'), call(addr, '0xd0c93a7c'),
    call(addr, '0xddca3f43'), call(addr, '0x0dfe1681'), call(addr, '0xd21220a7')]);
  const token0 = '0x' + word(t0, 0).slice(24), token1 = '0x' + word(t1, 0).slice(24);
  const [d0, d1, sy0, sy1] = await rpc([call(token0, '0x313ce567'), call(token1, '0x313ce567'), call(token0, '0x95d89b41'), call(token1, '0x95d89b41')]);
  const sym = h => Buffer.from(word(h, 2), 'hex').toString().replace(/\0/g, '');
  const sqrtP = BigInt('0x' + word(s0, 0)); const tick = Number(toInt(word(s0, 1)));
  const spacing = Number(toInt(word(ts, 0))); const L = BigInt(liq);
  // walk initialized ticks +-8% around current
  const span = Math.ceil(Math.log(1.08) / Math.log(1.0001) / spacing) * spacing;
  const base = Math.floor(tick / spacing) * spacing;
  const idx = []; for (let t = base - span; t <= base + span; t += spacing) idx.push(t);
  const net = {};
  for (let i = 0; i < idx.length; i += 50) {
    const res = await rpc(idx.slice(i, i + 50).map(t => call(addr, '0xf30dba93' + enc24(t))));
    res.forEach((h, k) => { const ln = toInt(word(h, 1)); if (ln !== 0n) net[idx[i + k]] = ln.toString(); });
  }
  return { addr, token0, token1, sym0: sym(sy0), sym1: sym(sy1), dec0: Number(BigInt(d0)), dec1: Number(BigInt(d1)),
    fee: Number(BigInt(fee)), spacing, tick, sqrtPriceX96: sqrtP.toString(), liquidity: L.toString(), net };
}
if (process.argv[2]) {
  const out = {};
  for (const a of process.argv.slice(2)) { out[a] = await readPool(a); const p = out[a];
    console.log(a, p.sym0 + '/' + p.sym1, 'fee', p.fee, 'spacing', p.spacing, 'tick', p.tick, 'L', p.liquidity, 'initTicks', Object.keys(p.net).length); }
  fs.writeFileSync(new URL('./data/pools.json', import.meta.url), JSON.stringify(out, null, 1));
}
