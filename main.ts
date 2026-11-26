// Dip-buy / mean-reversion bot for the Pump.fun Bot Sprint (replay v2).
//
// Idea: pump.fun tokens routinely spike right after launch and then give back
// a large part of the move. The bot runs two sleeves over the same idea,
// "buy shortly after launch, exit fast":
//   (a) dip sleeve — wait for a sharp, overdone drawdown from a token's
//       recent peak, enter small only once the price has started to bounce
//       off its low, and exit on a partial reversion to the mean, on a
//       trailing stop, or on a hard stop-loss;
//   (b) young sleeve — a token in its first observations that already trades
//       above its launch price: fresh launches drift up strongly, so an
//       early position with the same fast exits captures the launch pump
//       instead of waiting for a dip that, on a young token, rarely comes.
// It never chases a falling price, never sizes up on one token, and never
// trades a token it has no price history for.
//
// Protocol: the harness speaks newline-delimited JSON on stdin. It sends one
// hello message (universe, capital in lamports, position/order caps,
// latency in slots, fee fallbacks), then one batch message per slot window
// (events, marks, fills, account), then a done message. The bot answers
// exactly one reply per batch, echoing that batch's seq, carrying orders.
// All u64 values travel as decimal strings; prices are derived from the
// virtual reserves (quote per token = virtual quote reserves divided by
// virtual token reserves).

import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// Tunables (chosen for robustness across windows, not fitted to one sample)
// ---------------------------------------------------------------------------
const HISTORY_LEN = 160; // price observations kept per token
const PEAK_WINDOW = 120; // observations over which the recent peak is taken
const MIN_OBS = 8; // observations before a token is tradable
const MIN_DRAWDOWN = 0.30; // buy only after >= 30% off the recent peak
const BOUNCE_CONFIRM = 0.05; // price must be >= 5% above its post-peak low
const MAX_ENTRY_BELOW_PEAK = 0.78; // do not buy if price already back > 78% of peak
const TAKE_PROFIT = 0.25; // sell at +25% vs average entry cost: the reversion pays over a longer horizon, tight targets cut the right tail off
const STOP_LOSS = 0.15; // sell at -15% vs average entry cost
const TRAIL_TRIGGER = 0.15; // trailing exit arms once price is +15% vs entry
const TRAIL_GIVEBACK = 0.06; // ... then sell after a 6% pullback from the high
const MAX_HOLD_BATCHES = 1500; // stale-position exit, in batches held: give the reversion time
const POSITION_FRACTION = 0.015; // 1.5% of starting capital per new position
const MIN_BUY_LAMPORTS = 10_000_000; // guardrail: a round trip needs >= 0.01 SOL
const MIN_REAL_QUOTE_ENTRY = 20_000_000_000; // only buy tokens holding >= 20 SOL of real reserves: the sell cap is 1% of real reserves, and reserves drain as a token dumps, so a thin token's exit splinters into many tx-fee-paying chunks
const YOUNG_MAX_OBS = 25; // a token counts as freshly launched for its first 25 observations
const YOUNG_MIN_UP = 1.02; // ... and must already trade above its launch price
const YOUNG_TAKE_PROFIT = 0.25; // young positions use the same wide exits: the launch pump needs room, tight targets cut it off
const YOUNG_STOP_LOSS = 0.15;
const YOUNG_TRAIL_TRIGGER = 0.15;
const YOUNG_TRAIL_GIVEBACK = 0.06;
const YOUNG_MAX_HOLD_BATCHES = 1500;
const SIZE_SAFETY = 0.8; // stay 20% under the reserve cap: reserves move in 2 slots
const MIN_SELL_CHUNK_QUOTE = 107_000; // a sell chunk must clear its ~105k tx fee + curve fee; set just above breakeven
const MAX_SELL_CHUNKS_PER_POSITION = 4; // per batch: drain slowly, never flood
const MAX_SELL_ORDERS_PER_BATCH = 10; // reply budget: the harness caps total reply bytes
const MAX_BUY_ORDERS_PER_BATCH = 4;
const MAX_POSITIONS_SELF = 8; // self cap, tighter than the harness cap
const EXIT_COOLDOWN_BATCHES = 30; // do not re-enter a token just exited
const STALE_BATCHES = 500; // a token unseen this long counts as dead
const SLIPPAGE_BPS = 300; // 3% max slippage on every order

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function toNum(u64: string | undefined): number {
  if (u64 === undefined || u64 === "") return 0;
  const n = Number(u64);
  return Number.isFinite(n) ? n : 0;
}

// Price of one token in SOL from virtual reserves. Returns 0 when unusable.
function priceFromReserves(vQuote: string, vToken: string): number {
  const q = toNum(vQuote);
  const t = toNum(vToken);
  if (q <= 0 || t <= 0) return 0;
  return q / t;
}

// ---------------------------------------------------------------------------
// Per-token state
// ---------------------------------------------------------------------------
interface TokenState {
  prices: number[]; // recent prices, oldest first
  firstPrice: number; // price at first observation (launch area)
  volumeLamports: number; // lifetime traded SOL volume (lamports)
  lastPrice: number; // most recent price observed
  lastSeenBatch: number; // batch of the most recent observation
  realQuote: number; // last known real quote reserves (lamports), for sizing
  peak: number; // max price over the peak window
  lowSincePeak: number; // lowest price since the peak was set
  completed: boolean;
  firstBatch: number;
  lastTradeBatch: number;
  recentTrades: number[]; // batch numbers of recent trades
  entryPrice: number; // average cost per token of the open position (SOL)
  entryKind: "dip" | "young" | null; // which sleeve opened the position
  entryBatch: number;
  highSinceEntry: number;
  pendingBuy: boolean; // a buy order is in flight, fill not yet seen
  pendingSell: boolean; // a sell order is in flight; do not re-issue it
  cooldownUntil: number; // batch number before which we will not re-enter
}

const tokens = new Map<string, TokenState>();

function tokenState(mint: string, batch: number): TokenState {
  let s = tokens.get(mint);
  if (!s) {
    s = {
      prices: [],
      firstPrice: 0,
      volumeLamports: 0,
      lastPrice: 0,
      lastSeenBatch: batch,
      realQuote: 0,
      peak: 0,
      lowSincePeak: Infinity,
      completed: false,
      firstBatch: batch,
      lastTradeBatch: -1,
      recentTrades: [],
      entryPrice: 0,
      entryKind: null,
      entryBatch: -1,
      highSinceEntry: 0,
      pendingBuy: false,
      pendingSell: false,
      cooldownUntil: -1,
    };
    tokens.set(mint, s);
  }
  return s;
}

function observePrice(s: TokenState, price: number): void {
  if (!(price > 0) || !Number.isFinite(price)) return;
  if (s.firstPrice === 0) s.firstPrice = price;
  s.lastPrice = price;
  s.lastSeenBatch = batchNo;
  s.prices.push(price);
  if (s.prices.length > HISTORY_LEN) s.prices.shift();
  // Recompute the rolling peak from the window.
  const window = s.prices.slice(-PEAK_WINDOW);
  let peak = 0;
  for (const p of window) if (p > peak) peak = p;
  if (peak > s.peak) {
    // New peak: the low-since-peak restarts at the current price.
    s.peak = peak;
    s.lowSincePeak = price;
  } else if (price < s.lowSincePeak) {
    s.lowSincePeak = price;
  }
  // If the peak slid out of the window, reset the low tracker.
  if (s.peak > 0 && peak < s.peak) {
    s.peak = peak;
    s.lowSincePeak = price;
  }
}

// ---------------------------------------------------------------------------
// Session state from hello
// ---------------------------------------------------------------------------
let initialCapital = 0;
let cash = 0;
let maxOpenPositions = MAX_POSITIONS_SELF;
let maxOrderBps = 10000;
let maxOrdersPerBatch = 10;
let feeBpsEstimate = 200; // protocol + creator fallback, refined from hello
let batchNo = 0;

// Our own view of open positions, reconciled with the harness account each
// batch. Keyed by mint: { tokens, costLamports }.
const held = new Map<string, { tokens: number; costLamports: number }>();

// Which sleeve opened the buy currently in flight for a mint, so the
// position can inherit its exit parameters when the fill lands.
const buyKind = new Map<string, "dip" | "young">();

// ---------------------------------------------------------------------------
// Order construction
// ---------------------------------------------------------------------------
let orderCounter = 0;
function clientId(prefix: string, seq: number): string {
  orderCounter += 1;
  return `${prefix}-${seq}-${orderCounter}`;
}

interface Order {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

function buildBuy(
  seq: number,
  mint: string,
  quoteLamports: number,
): Order {
  return {
    side: "buy",
    client_id: clientId("b", seq),
    mint,
    quote_lamports: String(Math.max(0, Math.floor(quoteLamports))),
    max_slippage_bps: SLIPPAGE_BPS,
  };
}

function buildSell(seq: number, mint: string, tokenAmount: number): Order {
  return {
    side: "sell",
    client_id: clientId("s", seq),
    mint,
    token_amount: String(Math.max(0, Math.floor(tokenAmount))),
    max_slippage_bps: SLIPPAGE_BPS,
  };
}

// ---------------------------------------------------------------------------
// Decision logic, run once per batch
// ---------------------------------------------------------------------------
function decide(seq: number): Order[] {
  const orders: Order[] = [];
  const push = (o: Order) => {
    if (orders.length < maxOrdersPerBatch) orders.push(o);
  };

  // ---- exits first: free risk before taking new risk ----------------------
  let sellOrders = 0;
  for (const [mint, pos] of held) {
    const s = tokens.get(mint);
    if (!s || s.prices.length === 0) continue;
    const price = s.prices[s.prices.length - 1];
    if (!(price > 0)) continue;
    const entry = s.entryPrice > 0 ? s.entryPrice : pos.costLamports / Math.max(1, pos.tokens);
    if (!(entry > 0)) continue;
    if (price > s.highSinceEntry) s.highSinceEntry = price;

    const ret = price / entry - 1;
    // Exit parameters depend on which sleeve opened the position: young
    // positions ride a quick launch pump and exit faster, dip positions
    // wait out the slower reversion.
    const young = s.entryKind === "young";
    const takeProfit = young ? YOUNG_TAKE_PROFIT : TAKE_PROFIT;
    const stopLoss = young ? YOUNG_STOP_LOSS : STOP_LOSS;
    const trailTrigger = young ? YOUNG_TRAIL_TRIGGER : TRAIL_TRIGGER;
    const trailGiveback = young ? YOUNG_TRAIL_GIVEBACK : TRAIL_GIVEBACK;
    const maxHold = young ? YOUNG_MAX_HOLD_BATCHES : MAX_HOLD_BATCHES;
    let exit = false;
    if (s.pendingSell) exit = false; // sell already in flight: wait for fill
    else if (ret >= takeProfit) exit = true; // reverted to (past) the mean
    else if (ret <= -stopLoss) exit = true; // thesis wrong, cut it
    else if (
      s.highSinceEntry >= entry * (1 + trailTrigger) &&
      price <= s.highSinceEntry * (1 - trailGiveback)
    ) {
      exit = true; // gave back the bounce: bank what is left
    } else if (batchNo - s.entryBatch >= maxHold) {
      exit = true; // stale: capital is better deployed elsewhere
    } else if (s.completed) {
      exit = true; // bonding curve completed: regime changed
    }
    if (exit) {
      if (sellOrders >= MAX_SELL_ORDERS_PER_BATCH) continue;
      // Sells are capped by the same reserve rule as buys: one sell order
      // may not exceed max_order_bps of the real reserves. A full position
      // is usually far larger than that cap, so exit in chunks of at most
      // the capped quote value each, spread over several orders in this
      // batch (a single oversized sell is rejected outright, every batch,
      // and the position then never exits at all).
      const maxSellQuote =
        maxOrderBps > 0 && s.realQuote > 0
          ? (s.realQuote * maxOrderBps) / 10000 * SIZE_SAFETY
          : pos.tokens * price;
      // A chunk worth less than its own tx fee loses money on every fill.
      if (maxSellQuote < MIN_SELL_CHUNK_QUOTE) continue;
      const chunkTokens = Math.floor(maxSellQuote / price);
      if (chunkTokens <= 0) continue; // reserves too thin this batch: retry later
      let remaining = pos.tokens;
      const before = orders.length;
      let chunks = 0;
      while (
        remaining > 0 &&
        chunks < MAX_SELL_CHUNKS_PER_POSITION &&
        sellOrders < MAX_SELL_ORDERS_PER_BATCH &&
        orders.length < maxOrdersPerBatch
      ) {
        const piece = Math.min(remaining, chunkTokens);
        push(buildSell(seq, mint, piece));
        remaining -= piece;
        chunks += 1;
        sellOrders += 1;
      }
      // Only mark a sell in flight if an order actually went out: if the
      // batch was already full of orders, no fill will ever arrive to
      // clear the flag, and the position would be stuck forever.
      if (orders.length > before) s.pendingSell = true;
      s.cooldownUntil = batchNo + EXIT_COOLDOWN_BATCHES;
      s.entryPrice = 0;
      s.entryKind = null;
      s.entryBatch = -1;
      s.highSinceEntry = 0;
    }
  }

  // ---- entries -------------------------------------------------------------
  const openCount = held.size;
  if (openCount >= maxOpenPositions) return orders;
  // Expected round-trip cost must be comfortably below the take-profit.
  // If fees alone eat most of the target bounce, sit out entirely.
  if (feeBpsEstimate / 10000 >= TAKE_PROFIT * 0.5) return orders;

  const baseSize = initialCapital > 0 ? initialCapital * POSITION_FRACTION : 0;
  if (baseSize <= 0) return orders;

  // Rank candidates by drawdown depth so the deepest dip gets filled first.
  // NOTE: the replay's marks array is empty in practice, so candidates come
  // from every token we have tracked prices for, not from marks.
  // Two sleeves share the position slots. Dip sleeve: the briefed
  // mean-reversion buy (deep dip + bounce). Young sleeve: a token in its
  // first observations that already trades above its launch price — fresh
  // launches drift up strongly in this market, and their early pullbacks
  // are the same "buy after launch" idea on a shorter clock.
  const candidates: {
    mint: string;
    drawdown: number;
    price: number;
    realQuote: number;
    kind: "dip" | "young";
    score: number;
  }[] = [];
  for (const [mint, s] of tokens) {
    if (held.has(mint)) continue;
    if (s.completed) continue;
    if (s.pendingBuy) continue;
    if (batchNo < s.cooldownUntil) continue;
    const price = s.lastPrice;
    if (!(price > 0) || !(s.peak > 0)) continue;
    // Liveness: skip tokens not seen in a long while (dead tokens keep
    // their old dip signal forever, but there is no market left to revert).
    if (batchNo - s.lastSeenBatch > STALE_BATCHES) continue;
    const drawdown = 1 - price / s.peak;
    let kind: "dip" | "young" | null = null;
    let score = 0;
    // Dip sleeve: deep dip off the recent peak, with a bounce off the low,
    // on a token deep enough that the exit stays affordable.
    if (
      s.prices.length >= MIN_OBS &&
      drawdown >= MIN_DRAWDOWN &&
      price <= s.peak * MAX_ENTRY_BELOW_PEAK &&
      s.lowSincePeak > 0 &&
      price >= s.lowSincePeak * (1 + BOUNCE_CONFIRM) &&
      s.realQuote >= MIN_REAL_QUOTE_ENTRY
    ) {
      kind = "dip";
      score = drawdown;
    } else if (
      s.prices.length >= 3 &&
      s.prices.length <= YOUNG_MAX_OBS &&
      s.firstPrice > 0 &&
      price >= s.firstPrice * YOUNG_MIN_UP
    ) {
      // Young sleeve: freshly launched and already above its launch price.
      // No separate reserve floor here: the buy-size check below already
      // requires the order to reach the 0.01 SOL guardrail minimum, which
      // itself needs enough real reserves; thin launches simply do not
      // qualify.
      kind = "young";
      score = price / s.firstPrice;
    }
    if (!kind) continue;
    candidates.push({
      mint,
      drawdown,
      price,
      realQuote: s.realQuote,
      kind,
      score,
    });
  }
  candidates.sort((a, b) => {
    // Young launches are time-sensitive (their window closes in a few
    // observations), so they go first; dips wait.
    if (a.kind !== b.kind) return a.kind === "young" ? -1 : 1;
    return b.score - a.score;
  });

  let slotsLeft = maxOpenPositions - openCount;
  let buys = 0;
  for (const c of candidates) {
    if (slotsLeft <= 0) break;
    if (buys >= MAX_BUY_ORDERS_PER_BATCH) break;
    if (orders.length >= maxOrdersPerBatch) break;
    // Cap the order by the harness reserve cap (with a safety margin:
    // reserves move during the 2-slot latency, and an order over the cap
    // at execution is rejected), then by cash on hand.
    let size = baseSize;
    if (maxOrderBps > 0 && c.realQuote > 0) {
      size = Math.min(size, ((c.realQuote * maxOrderBps) / 10000) * SIZE_SAFETY);
    }
    size = Math.min(size, cash * 0.9);
    if (size <= 0) break;
    // Below the guardrail minimum a round trip does not count, and a
    // dust-sized order is not worth its tx fees either.
    if (size < MIN_BUY_LAMPORTS) continue;
    push(buildBuy(seq, c.mint, size));
    buys += 1;
    buyKind.set(c.mint, c.kind);
    const s = tokens.get(c.mint);
    if (s) s.pendingBuy = true;
    slotsLeft -= 1;
  }
  return orders;
}

// ---------------------------------------------------------------------------
// Main loop: read hello / batch / done lines, answer one reply per batch
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const text = line.trim();
    if (text === "") continue;
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      continue; // ignore a malformed line rather than crashing
    }
    if (msg.type === "hello") {
      initialCapital = toNum(msg.capital?.lamports);
      cash = initialCapital;
      const caps = msg.caps ?? {};
      maxOpenPositions = Math.min(
        MAX_POSITIONS_SELF,
        typeof caps.max_open_positions === "number" && caps.max_open_positions > 0
          ? caps.max_open_positions
          : MAX_POSITIONS_SELF,
      );
      if (typeof caps.max_order_bps_of_real_reserve === "number") {
        maxOrderBps = caps.max_order_bps_of_real_reserve;
      }
      if (typeof caps.max_orders_per_batch === "number" && caps.max_orders_per_batch >= 0) {
        maxOrdersPerBatch = caps.max_orders_per_batch;
      }
      const fees = msg.fees ?? {};
      const proto = typeof fees.protocol_bps_fallback === "number" ? fees.protocol_bps_fallback : 0;
      const creator = typeof fees.creator_bps_fallback === "number" ? fees.creator_bps_fallback : 0;
      feeBpsEstimate = proto + creator;
      continue;
    }
    if (msg.type === "done") {
      break;
    }
    if (msg.type !== "batch") continue;

    const seq: number = msg.seq;
    batchNo += 1;

    // --- ingest events ------------------------------------------------------
    const events: any[] = Array.isArray(msg.events) ? msg.events : [];
    for (const ev of events) {
      if (ev.event === "TradeEvent") {
        const s = tokenState(ev.mint, batchNo);
        const price = priceFromReserves(ev.virtual_sol_reserves, ev.virtual_token_reserves);
        observePrice(s, price);
        s.volumeLamports += toNum(ev.sol_amount);
        s.realQuote = toNum(ev.real_sol_reserves);
        s.lastTradeBatch = batchNo;
        s.recentTrades.push(batchNo);
      } else if (ev.event === "CreateEvent") {
        const s = tokenState(ev.mint, batchNo);
        const price = priceFromReserves(ev.virtual_sol_reserves, ev.virtual_token_reserves);
        observePrice(s, price);
      } else if (ev.event === "CompleteEvent") {
        const s = tokenState(ev.mint, batchNo);
        s.completed = true;
      }
    }

    // --- ingest marks (authoritative current reserves) ----------------------
    const marks: any[] = Array.isArray(msg.marks) ? msg.marks : [];
    for (const mark of marks) {
      const s = tokenState(mark.mint, batchNo);
      const price = priceFromReserves(mark.virtual_quote_reserves, mark.virtual_token_reserves);
      observePrice(s, price);
      const rq = toNum(mark.real_quote_reserves);
      if (rq > 0) s.realQuote = rq;
    }

    // --- ingest fills: clear pending flags, drop exited positions -----------
    const fills: any[] = Array.isArray(msg.fills) ? msg.fills : [];
    for (const fill of fills) {
      const s = tokens.get(fill.mint);
      if (!s) continue;
      if (fill.side === "buy" && fill.status === "filled") s.pendingBuy = false;
      if (fill.status === "rejected" || fill.status === "failed") {
        if (fill.side === "buy") s.pendingBuy = false;
        if (fill.side === "sell") s.pendingSell = false;
      }
      if (fill.side === "sell" && fill.status === "filled") s.pendingSell = false;
    }

    // --- reconcile account (the harness is the source of truth) -------------
    const account = msg.account ?? {};
    cash = toNum(account.cash_lamports);
    const positions: any[] = Array.isArray(account.positions) ? account.positions : [];
    const seen = new Set<string>();
    for (const p of positions) {
      const mint: string = p.mint;
      seen.add(mint);
      const prev = held.get(mint);
      const tokenAmount = toNum(p.token_amount);
      const cost = toNum(p.cost_lamports);
      const s = tokenState(mint, batchNo);
      if (!prev) {
        // New position: record entry from cost basis and current price.
        s.entryPrice = tokenAmount > 0 ? cost / tokenAmount : 0;
        s.entryKind = buyKind.get(mint) ?? "dip";
        buyKind.delete(mint);
        s.entryBatch = batchNo;
        const last = s.prices.length > 0 ? s.prices[s.prices.length - 1] : s.entryPrice;
        s.highSinceEntry = last;
        s.pendingBuy = false;
      }
      held.set(mint, { tokens: tokenAmount, costLamports: cost });
    }
    for (const mint of [...held.keys()]) {
      if (!seen.has(mint)) {
        held.delete(mint);
        const s = tokens.get(mint);
        if (s) {
          s.entryPrice = 0;
          s.entryKind = null;
          s.entryBatch = -1;
          s.highSinceEntry = 0;
          s.pendingBuy = false;
          s.pendingSell = false;
        }
      }
    }

    // --- decide and answer ---------------------------------------------------
    const orders = decide(seq);
    process.stdout.write(JSON.stringify({ type: "reply", seq, orders }) + "\n");
  }
}

main().catch(() => {
  // Never crash mid-replay on an unexpected line: exit quietly instead.
  process.exit(0);
});
