// Minimal Binance Web3 API client (HMAC-SHA256, X-OC-* headers). Reads keys from rivrwa/.env.local.
import crypto from 'crypto';
import fs from 'fs';
const env = Object.fromEntries(fs.readFileSync(new URL('../../.env.local', import.meta.url), 'utf8')
  .split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const BASE = 'https://web3.binance.com', PREFIX = '/build';
export async function bw3(method, path, { query, body } = {}) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const requestPath = PREFIX + path + qs, raw = body ? JSON.stringify(body) : '';
  const ts = new Date().toISOString();
  const sign = crypto.createHmac('sha256', env.BINANCE_WEB3_SECRET_KEY).update(ts + method + requestPath + raw, 'utf8').digest('base64');
  const r = await fetch(BASE + requestPath, { method, body: raw || undefined, headers: {
    'X-OC-APIKEY': env.BINANCE_WEB3_API_KEY, 'X-OC-TIMESTAMP': ts, 'X-OC-SIGN': sign, 'content-type': 'application/json' } });
  const text = await r.text(); try { return { status: r.status, ...JSON.parse(text) }; } catch { return { status: r.status, text: text.slice(0, 500) }; }
}
if (process.argv[1].endsWith('bw3.mjs')) {
  const [m, p, q] = process.argv.slice(2);
  console.log(JSON.stringify(await bw3(m, p, { query: q ? Object.fromEntries(new URLSearchParams(q)) : undefined }), null, 1).slice(0, +(process.env.MAX ?? 3000)));
}
