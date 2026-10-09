import { bw3 } from './bw3.mjs';
const NVDAB = '0x02fca66c1d1afb4e2a7884261eb00f63598a7436';
const r = await bw3('POST', '/api/v1/defi/data/investment/list', { body: { investType: 'LiquidityPool', tokenAddressList: [NVDAB], binanceChainId: '56', sortField: 'tvl', sortDirection: 'DESC', size: 20 } });
console.log('status', r.status, r.code, r.msg);
for (const i of r.data?.list ?? r.data ?? []) console.log(i.defiProtocolId, '|', i.investmentName, '|', i.apyDisplay, '| tvl', i.tvl, '|', i.investmentId);
const first = (r.data?.list ?? r.data ?? []).find(i => /pancake/i.test(i.defiProtocolId + i.protocolName));
if (first) { const d = await bw3('POST', '/api/v1/defi/data/investment/detail', { body: { investmentId: first.investmentId } }); console.log(JSON.stringify(d.data, null, 1)); }
