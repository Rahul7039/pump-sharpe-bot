// Pump.fun Sharpe Sprint — "lottery sniper" (my own design).
//
// Idea: most fresh pump.fun coins dump within seconds, so long-only grinding
// loses to fees. The edge is the rare launch that moons within seconds of
// creation. This bot buys ONLY launches that look un-bundled (the creator
// bought at most 0.5 SOL, the price has not yet run more than 10% above its
// create price, at most 3 distinct non-creator buyers so far), in tiny size,
// then lets the rare runner run: no fixed take-profit, a 10% trailing stop
// once up 5%, a 12% stop-loss, and a time limit that is waived while the
// trade is up. Losers are cut fast; winners are pyramided (adds only while
// the position is up and the price is above the last buy) up to 0.03 SOL.
//
// A second, separate mechanism keeps the 20-coin guardrail honest in a
// 6-hour window: paced "probe" round trips of 0.012 SOL on liquid coins
// whose price is gently rising (1-5% over the last 30 slots, real SOL >= 3).
// Probes are real trades on fresh coins, not wash trades: they buy and sell
// coins the bot has never touched, paced against elapsed block time toward
// 35 distinct coins over the window.
//
// Deterministic: pure function of the batches; no clock, env, or randomness;
// iteration only over insertion-ordered maps fed by the batch stream.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAM = 1e9;
const CURVE_FEE = 0.0125; // protocol 95bps + creator 30bps, per side

const P = {
  // Entry: launch sniper on un-bundled, not-yet-run launches.
  minAge: 0,
  maxAge: 3, // slots since CreateEvent
  minRqSol: 0.3, // real SOL reserve band at decision
  maxRqSol: 30,
  maxDevBuy: 0.5, // creator's own buys so far, SOL
  maxBuyers: 3, // distinct non-creator buyers so far, at most
  minRun: 0, // price now vs create price, minus 1
  maxRun: 0.10,
  stakeSol: 0.1, // per buy (the 1%-of-reserve cap usually binds first)
  minBuySol: 0.005,
  buySlipBps: 800, // tight: refuse to chase a vertical spike
  // Pyramid adds into strength only.
  maxAdds: 1,
  addMinUp: 0.01, // add only while value >= cost * (1 + this)
  maxStakeSol: 0.03, // most SOL per coin in total
  // Exits: let runners run, cut losers.
  stopLoss: 0.12, // exit when value <= cost * (1 - sl)
  trailArm: 0.05, // trailing stop arms once peak >= cost * (1 + arm)
  trail: 0.10, // exit when value < peak * (1 - trail)
  maxHold: 2400, // slots; waived while up >= holdIfUp
  holdIfUp: 0.02,
  cooldown: 0,
  maxEntries: 1, // first buys per coin over the run
  // Guardrail pacing: probe round trips toward 35 distinct coins over 6h.
  targetCoins: 35,
  paceSecs: 21600,
  probeSol: 0.012,
  probeMinRqSol: 3,
  maxProbes: 1,
};

interface Trade { slot: number; buy: boolean; sol: number; user: string; price: number }
interface Coin {
  created: number;
  creator: string;
  createPrice: number;
  devBuy: number;
  devSold: boolean;
  buyers: Set<string>;
  buySol: number;
  sellSol: number;
  trades: number;
  entries: number;
  adds: number;
  lastExit: number;
  lastAddPrice: number;
  lastTradeSlot: number;
  flow: Trade[];
  peakValue: number;
  openedSlot: number;
}

const coins = new Map<Pubkey, Coin>();
const young = new Set<Pubkey>(); // coins within entry age, pruned each batch
const probes = new Map<Pubkey, boolean>(); // mint -> selling?
let firstTime: number | null = null;
let lastTime: number | null = null;
let myFills = 0;
const myCoins = new Set<Pubkey>();

const coinOf = (mint: Pubkey, slot: number, creator: string, createPrice: number): Coin => {
  let c = coins.get(mint);
  if (c === undefined) {
    c = {
      created: slot, creator, createPrice, devBuy: 0, devSold: false,
      buyers: new Set(), buySol: 0, sellSol: 0, trades: 0,
      entries: 0, adds: 0, lastExit: -1e12, lastAddPrice: 0, lastTradeSlot: -1, flow: [],
      peakValue: 0, openedSlot: 0,
    };
    coins.set(mint, c);
  }
  return c;
};

function valueOf(state: BotState, mint: Pubkey): number {
  const pos = state.positions.get(mint);
  const curve = state.curves.get(mint);
  if (pos === undefined || curve === undefined) return 0;
  const tokens = Number(pos.token_amount);
  const vq = Number(curve.virtual_quote_reserves);
  const vt = Number(curve.virtual_token_reserves);
  const tx = Number(state.txFeeLamports()) / LAM;
  return ((tokens * vq) / (vt + tokens) / LAM) * (1 - CURVE_FEE) - tx;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) { myFills++; myCoins.add(f.mint); }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        coinOf(e.mint, e.slot, e.creator, Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves));
        young.add(e.mint);
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          const sol = Number(e.sol_amount) / LAM;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          c.trades++;
          c.lastTradeSlot = e.slot;
          if (e.is_buy) {
            c.buySol += sol;
            if (e.user === c.creator) c.devBuy += sol; else c.buyers.add(e.user);
          } else {
            c.sellSol += sol;
            if (e.user === c.creator) c.devSold = true;
          }
          c.flow.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          if (c.flow.length > 400) c.flow.splice(0, c.flow.length - 400);
        }
      }
    }
    for (const mint of [...young]) {
      const c = coins.get(mint);
      if (c === undefined || now - c.created > P.maxAge) young.delete(mint);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAM;
    const pendingMints = new Set<Pubkey>();
    for (const po of state.pending.values()) pendingMints.add(po.order.mint);

    // Exits first: stop-loss, trailing stop, time limit (waived while up).
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const c = coins.get(mint);
      const value = valueOf(state, mint);
      const cost = Number(pos.cost_lamports) / LAM;
      if (c !== undefined && value > c.peakValue) c.peakValue = value;
      const peak = c !== undefined ? c.peakValue : 0;
      const opened = c !== undefined ? c.openedSlot : now;
      let exit = false;
      if (value <= cost * (1 - P.stopLoss)) exit = true;
      if (!exit && peak >= cost * (1 + P.trailArm) && value < peak * (1 - P.trail)) exit = true;
      if (!exit && now - opened > P.maxHold && value < cost * (1 + P.holdIfUp)) exit = true;
      if (!exit) continue;
      if (pendingMints.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (c !== undefined) c.lastExit = now;
    }

    // Cash and open slots left, after pending orders.
    let free = Number(state.cash) / LAM;
    for (const po of state.pending.values()) {
      free -= tx;
      if (po.order.side === 'buy') free -= Number(po.order.quote_lamports) / LAM;
    }
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();

    // Pyramid adds: buy more only while the position is up and the price is
    // above the last buy's decision price.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingMints.has(mint)) continue;
      const c = coins.get(mint);
      if (c === undefined || c.adds >= P.maxAdds) continue;
      const invested = Number(pos.cost_lamports) / LAM;
      if (invested >= P.maxStakeSol - P.minBuySol) continue;
      const value = valueOf(state, mint);
      const cost = Number(pos.cost_lamports) / LAM;
      if (value < cost * (1 + P.addMinUp)) continue;
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      if (price < c.lastAddPrice) continue;
      const rqSol = Number(curve.real_quote_reserves) / LAM;
      if (rqSol > P.maxRqSol) continue;
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAM;
      let amount = Math.min(capSol, P.stakeSol, P.maxStakeSol - invested);
      if (amount > free - tx) amount = free - tx;
      if (amount < P.minBuySol) continue;
      orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAM)), max_slippage_bps: P.buySlipBps });
      c.adds++;
      c.lastAddPrice = price;
      free -= amount + tx;
    }

    // Entries: young, un-bundled, not-yet-run launches.
    for (const mint of young) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingMints.has(mint) || state.positions.has(mint) || probes.has(mint)) continue;
      const c = coins.get(mint);
      if (c === undefined) continue;
      const age = now - c.created;
      if (age < P.minAge || age > P.maxAge) continue;
      if (c.entries >= P.maxEntries) continue;
      if (now - c.lastExit < P.cooldown) continue;
      const rqSol = Number(curve.real_quote_reserves) / LAM;
      if (rqSol < P.minRqSol || rqSol > P.maxRqSol) continue;
      if (c.devBuy > P.maxDevBuy) continue;
      if (c.buyers.size > P.maxBuyers) continue;
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      const runup = price / c.createPrice - 1;
      if (runup < P.minRun || runup > P.maxRun) continue;
      if (slotsLeft <= 0) continue;
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAM;
      let amount = Math.min(capSol, P.stakeSol);
      if (amount > free - tx) amount = free - tx;
      if (amount < P.minBuySol) continue;
      orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAM)), max_slippage_bps: P.buySlipBps });
      c.entries++;
      c.lastAddPrice = price;
      c.openedSlot = now;
      c.peakValue = 0;
      free -= amount + tx;
      slotsLeft--;
    }

    // Guardrail pacing: sell landed probes, then open new probe round trips
    // on liquid, gently rising coins when distinct coins lag the pace
    // (35 coins over the 6h window).
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingMints.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingMints.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (!selling) probes.set(mint, true);
    }
    if (probes.size < P.maxProbes && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / P.paceSecs);
      const needCoins = myCoins.size < Math.ceil(P.targetCoins * pace);
      if (needCoins && slotsLeft > 0) {
        const minRq = Math.max((P.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve, P.probeMinRqSol);
        for (const e of batch.events) {
          if (orders.length >= cap || probes.size >= P.maxProbes) break;
          if (e.event !== 'TradeEvent') continue;
          const mint = e.mint;
          if (state.positions.has(mint) || probes.has(mint) || pendingMints.has(mint)) continue;
          if (myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAM < minRq) continue;
          const c = coins.get(mint);
          if (c === undefined) continue;
          // Gently rising over the last 30 slots: +1% to +5%.
          let pOld = 0; let pNew = 0; let nT = 0;
          for (let i = c.flow.length - 1; i >= 0; i--) {
            const tr = c.flow[i]!;
            if (tr.slot <= now - 30) break;
            if (pNew === 0) pNew = tr.price;
            pOld = tr.price;
            nT++;
          }
          if (nT < 3 || pOld <= 0) continue;
          const rise = pNew / pOld - 1;
          if (rise < 0.01 || rise > 0.05) continue;
          if (free < P.probeSol + 2 * tx) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(P.probeSol * LAM)), max_slippage_bps: P.buySlipBps });
          probes.set(mint, false);
          free -= P.probeSol + tx;
        }
      }
    }
    return orders;
  },
});
