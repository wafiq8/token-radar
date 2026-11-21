# Token Radar

[![make.fun token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/c/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/wafiq8/token-radar/rank.svg)](https://make.fun/c/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/wafiq8/token-radar/reward.svg)](https://make.fun/c/token-radar-01)

A ranked board of the DeFi protocols that record no token yet — what each one
would be worth if it launched today, how likely a launch is, and the concrete
steps to farm it before it happens. Built for the make.fun
**token-radar-01** bounty from the sealed DefiLlama snapshot in the
competition kit (758 protocols, snapshot dated 2026-11-14).

**198 protocols ranked.** All 40 of the snapshot's watchlist protocols are on
the board, plus 158 more the radar finds below the watchlist's $50M floor.

## The model

Every number is derived from the snapshot's own figures. Nothing is hardcoded
per protocol.

```
implied value = TVL × category multiple × momentum × maturity × breadth × size dampener
```

- **Category multiple** — for each category, the median market-cap/TVL of the
  protocols in it whose token already trades (ratios winsorized to
  [0.02×, 3×]), blended toward the market-wide median (0.169×) in log space
  with weight n/(n+4): a category with eleven traded peers keeps its
  character; a category with one peer cannot outvote the market.
- **Momentum** — the 7-day TVL change, clamped to ±30 points, worth at most
  ±15%.
- **Maturity** — +5% for each year the protocol has run with no token, up to
  +20%. Years of tokenless operation is the strongest sign of a product a
  launch can be priced on.
- **Breadth** — +1% per chain beyond the first, up to +9%.
- **Size dampener** — above $1B of TVL the multiple compresses toward a floor
  of 0.55, because billion-dollar protocols do not launch at full category
  multiples.

The universe excludes wrapped, staked, bridged or versioned products of
tokens that already trade (a V2, a liquid-staking wrapper, an exchange
product) — their launch already happened under another name. "Records no
token" is DefiLlama's record, not a guarantee.

## Launch odds and expected value

Worth is only half the question; the other half is whether a launch happens
at all. Each row therefore also carries **launch odds**: among the
independent protocols in its category — those already trading a token plus
the candidates on this board — the share that has launched (market-wide:
68%), shrunk toward the market rate with the same n/(n+4) weight as the
multiples. **Expected value** = implied value × odds, and the dashboard can
sort by it: big-but-unlikely gives ground to likely. Odds are a base rate
from one snapshot, not a prophecy — a protocol can stay tokenless by choice.

## Evidence

The model grades itself, out of sample, on every run. The program re-fits
both models twice on one half of the protocols (split by a hash of the slug)
and predicts the other half, so every graded protocol was held out from its
own fit. On this snapshot: the value model's median held-out prediction
lands within ×4.6 of the real market cap across the 128 traded protocols
carrying a market cap above zero (Spearman ρ = 0.41) — the honest scatter of
pricing from TVL alone, published rather than hidden. The odds model's
Brier error is 0.185 against 0.221 for quoting the market-wide rate for
everyone: 16.2% better calibrated, out of sample. The dashboard's
methodology section prints these scores from the live run.

## Farm plans

Each row carries a five-step plan for its category, filled with the
protocol's own chains, its scale tier and the gas its main chain actually
costs: what to do, what it costs, and how long it takes. Open any protocol on
the dashboard to read its plan and the full arithmetic behind its value.

## Run it

Node 22, standard library only, no network:

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
```

Writes `board.json` (the ranked board), `data.js` (the dashboard's data),
`dashboard/` (a static page: sortable, filterable, with a detail view per
protocol), `screenshots/`, and `dossier.json` (written last, with the
vendored make.fun library, byte-identical to what the scorer rebuilds).
The program runs deterministically: two runs over the same snapshot produce
identical bytes.

## Layout

- `main.ts` — entry point: snapshot in, board + dashboard + dossier out
- `lib/model.ts` — the value model, the launch-odds model, the held-out
  evidence, the farm-plan playbooks, the board self-check
- `dashboard/` — `index.html`, `app.css`, `app.js` (renders from `data.js`)
- `screenshots/` — the board, a protocol detail view, a filtered board, the
  methodology and evidence section
- `vendor/makefun-board.ts` — the kit's dossier library, unchanged
