// Gate 0-B: can the Binance DeFi API build (not sign/send) an lp-add on the NVDAB/USDT 0.25% pool
// with a custom IVL-style tick range, and does it accept a contract (smart-account) `address`?
import { bw3 } from './bw3.mjs';
const INV = '9c97dee13d719c679a1d91e22612ee3520eca470004c907c22d405de7ec7f79d';
const NVDAB = '0x02fca66c1d1afb4e2a7884261eb00f63598a7436', USDT = '0x55d398326f99059ff775485246999027b3197955';
const EOA = '0x000000000000000000000000000000000000dEaD';
const CONTRACT = '0x8fb4243b553ac29ba088acf00b9b7da24bd6690c'; // any contract address, to test smart-account style `address`
const range = { tickLower: '54200', tickUpper: '54600' }; // ~±2% custom range, tickSpacing 50
const show = (k, r) => console.log(`\n## ${k}: http ${r.status} code ${r.code} ${r.msg ?? ''}\n` + String(JSON.stringify(r, null, 1)).slice(0, 2500));
show('calculate custom ticks', await bw3('POST', '/api/v1/defi/transaction/lp-add/calculate', { body: { address: EOA, investmentId: INV, inputToken: { tokenAddress: NVDAB, amount: '1' }, ...range } }));
show('lp-add custom ticks (EOA, simulate)', await bw3('POST', '/api/v1/defi/transaction/lp-add', { body: { address: EOA, investmentId: INV, tokenList: [{ tokenAddress: NVDAB, amount: '1' }, { tokenAddress: USDT, amount: '230' }], ...range, slippageBps: '50', simulate: true } }));
show('lp-add (contract address)', await bw3('POST', '/api/v1/defi/transaction/lp-add', { body: { address: CONTRACT, investmentId: INV, tokenList: [{ tokenAddress: NVDAB, amount: '1' }, { tokenAddress: USDT, amount: '230' }], ...range, slippageBps: '50', simulate: false } }));
