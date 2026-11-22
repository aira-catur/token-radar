# Token Radar — pre-token launch radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/aira-catur/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/aira-catur/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

An entry for the [token-radar-01 bounty on make.fun](https://make.fun/bounty/token-radar-01).

Token Radar reads a sealed DefiLlama snapshot (758 protocols with at least $5M
TVL, 40 of them on the official watchlist: TVL at or above $50M with no token
recorded) and ranks every pre-token protocol by what a token launch would be
worth, with a concrete farm plan for each row.

## The model

implied value = TVL × category multiple × growth factor × maturity factor × chain factor

- **Category multiple** — the median market-cap/TVL ratio of the tokenized
  protocols in the same snapshot category. Each ratio is winsorized into
  [0.02, 2.50] so one absurd print cannot poison a category, and a category
  needs at least 5 tokenized peers before its own median is used at all;
  thinner categories are priced by the global winsorized median instead. The
  result is clamped to [0.05, 1.50].
- **Growth factor** — 1 + clamp(7-day TVL change, −40%, +80%) × 0.60.
- **Maturity factor** — 0.78 + min(age in days, 1825)/1825 × 0.44, so years
  survived with no token count for something, but never dominate.
- **Chain factor** — 1 + min(chains − 1, 5) × 0.03 for multi-chain reach.

No protocol name is special-cased anywhere: one function scores every row,
each row stores its own factor breakdown, and the dashboard recomputes every
row in the page and shows it is identical to board.json. Wrapped, staked and
canonical-bridge products of tokens that already trade are kept off the
ranked board (the same exclusion the snapshot's own watchlist rule uses);
tokenized protocols sit in a separate, unranked live reference.

## Output

- `board.json` — 197 ranked pre-token rows: all 40 watchlist protocols plus
  the strongest early protocols below the $50M floor, each with its model
  breakdown and a 7–8 step farm plan (wallet setup, funding, the core action
  for its category and chain, a second position, weekly checks, a hold rule
  and an exit rule, with per-chain gas costs: Ethereum L1 is priced nothing
  like an L2 or Solana).
- A static dashboard (`dashboard/`) with sortable columns, category / chain /
  TVL-band filters, search, a pre-token vs live-token tab, a per-protocol
  detail view and a model panel showing the live calibration table.
- Three screenshots and a `dossier.json` built with the kit's vendor code.

## Run

```
MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

Node 22, standard library only, no network. The run is deterministic: the
same snapshot produces byte-identical output.
