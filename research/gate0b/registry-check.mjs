import { bw3 } from './bw3.mjs';
const t = await bw3('GET', '/api/v1/dex/market/rwa/tokens', { query: { binanceChainId: '56', platformId: 'bstock' } });
const want = ['NVDAB', 'TSLAB', 'SPCXB'];
const toks = t.data.filter(x => want.includes(x.tokenSymbol));
for (const x of toks) {
  const r = await bw3('POST', '/api/v1/defi/data/investment/list', { body: { investType: 'LiquidityPool', tokenAddressList: [x.tokenContractAddress], binanceChainId: '56', sortField: 'tvl', sortDirection: 'DESC', size: 5 } });
  const top = (r.data?.list ?? r.data ?? []).find(i => i.defiProtocolId === 'pancakeswap3' && /USDT/.test(i.investmentName));
  const d = top && (await bw3('POST', '/api/v1/defi/data/investment/detail', { body: { investmentId: top.investmentId } })).data;
  console.log(JSON.stringify({ symbol: x.tokenSymbol, token: x.tokenContractAddress, decimals: x.decimals, underlying: x.underlyingTicker, assetType: x.assetType, investmentId: top?.investmentId, pool: d?.poolAddress, feeRate: d?.feeRate, tvl: d?.tvl }));
}
