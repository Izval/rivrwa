import fs from 'fs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pools = { NVDAB: '0x8fb4243b553ac29ba088acf00b9b7da24bd6690c', TSLAB: '0xb0f5e5400e8f0f7c242f2b7740c004f020579c41', SPCXB: '0x977daffc095b33872e2741c19568925015c35b4d' };
for (const [name, a] of Object.entries(pools)) {
  const m = new Map(); let before = '';
  for (let i = 0; i < 6; i++) {
    const u = `https://api.geckoterminal.com/api/v2/networks/bsc/pools/${a}/ohlcv/hour?aggregate=1&limit=1000&currency=usd&token=base${before}`;
    let j; for (let k = 0; k < 4; k++) { const r = await fetch(u); if (r.ok) { j = await r.json(); break; } await sleep(15000); }
    const rows = j?.data?.attributes?.ohlcv_list || []; rows.forEach(r => m.set(r[0], r));
    if (rows.length < 1000) break; before = `&before_timestamp=${rows.at(-1)[0]}`; await sleep(2500);
  }
  const c = [...m.values()].sort((x, y) => x[0] - y[0]);
  fs.writeFileSync(new URL(`./data/ohlcv_${name}.json`, import.meta.url), JSON.stringify(c));
  console.log(name, c.length, new Date(c[0][0] * 1000).toISOString(), '→', new Date(c.at(-1)[0] * 1000).toISOString(), 'last close', c.at(-1)[4]);
  await sleep(2500);
}
