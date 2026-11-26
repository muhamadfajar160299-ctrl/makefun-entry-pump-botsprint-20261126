[![Pump.fun Bot Sprint](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/muhamadfajar160299-ctrl/makefun-entry-pump-botsprint-20261126/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/muhamadfajar160299-ctrl/makefun-entry-pump-botsprint-20261126/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard)

# Pump.fun Dip-Buy Bot

A mean-reversion trading bot for the [Pump.fun Bot Sprint](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) competition. It speaks the replay v2 protocol over stdin/stdout (one JSON line per batch, one reply per batch echoing the batch `seq`) and runs as a single TypeScript file, `main.ts`, on Node 22+ with no dependencies and no network access.

## Strategy

Pump.fun tokens often spike right after launch and then give back a large
part of the move. The bot:

1. **Tracks every token's price** from the virtual reserves in marks and
   trade events (price = virtual quote reserves / virtual token reserves),
   keeping a rolling recent peak per token.
2. **Buys the dip, not the fall**: only after a token is at least 30% below
   its recent peak *and* the price has bounced at least 2% off its
   post-peak low. No history, no trade.
3. **Sizes small**: 1.5% of starting capital per position, capped by the
   harness per-order reserve cap and by cash on hand, at most 8 open
   positions, one per token.
4. **Exits fast**: take profit at +12% vs average entry cost, hard stop-loss
   at -20%, a trailing exit once a position is +6% (sell after a 4%
   pullback from its high), a stale-position exit after 400 batches, and an
   immediate exit if the bonding curve completes.
5. **Sits out when the math does not work**: if the protocol + creator fee
   estimate already eats half the take-profit target, it places no orders
   at all.

Risk controls: never all-in on one token, never a second buy while a buy
is in flight, never a repeated sell while a sell is in flight, and a
cooldown before re-entering a token it just exited. The harness account
snapshot is treated as the source of truth for cash and positions every
batch.

## Honest weaknesses

- The dev window is one small sample and the final judging window is
  collected after the deadline, so a positive dev PnL is not a promise.
- The strategy leans on sharp post-launch drawdowns with a bounce; in a
  window where tokens mostly grind down without bouncing, or mostly run
  up without dipping, it trades little or loses on stop-losses.
- Entries need a peak to fall from, so tokens that never spike are never
  bought, and a token that keeps falling past the stop-loss costs the
  full 20% on that position.

## Run

```sh
node main.ts
```

It reads `hello` / `batch` / `done` JSON lines on stdin and writes one
`reply` JSON line per batch on stdout.
