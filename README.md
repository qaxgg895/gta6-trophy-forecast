# gta6-trophy-forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/qaxgg895/gta6-trophy-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/qaxgg895/gta6-trophy-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts, for every Grand Theft Auto VI trophy, the percent of Exophase-tracked players who will have earned it one week after launch — as five quantiles (5%, 25%, 50%, 75%, 95%) per trophy. An entry for make.fun's `gta6-trophy-rarity-forecast-01` bounty, scored by pinball loss on the logit scale.

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, no dependencies) reads every `*.in` case in the input directory and writes one `/output/<id>.out` per case: `{"trophies": [{"id": n, "q": [q05, q25, q50, q75, q95]}]}`. It runs offline and deterministically — two runs on the same case write the same bytes.

## How it works

A trophy's earn rate is `earned / tracked`, and Exophase's tracked-player count grows as players sync, so each refresh dilutes the rates toward the broader population's earn rate. Instead of extrapolating the rate itself, the forecaster models the two counts that make it:

- **E(N):** a least-squares line of earned count on tracked players over the recent reads. Its slope is the marginal earn rate among newly tracked players.
- **N(t):** log tracked-players linear in time over the last 48 hours, slope capped, extrapolated to the target.
- **Trend:** logit(rate) linear in `ln(1 + hours since launch)` over the recent reads — a saturating curve, so a 4.5-day horizon cannot run away.
- The median blends the E(N) forecast and the trend in logit space, weighted by how much the tracked count varied; the spread combines the fit residual with a random-walk term that grows with the horizon.
- **Flat history** (launch night, no variation yet): the page is stale and a refresh may land before the target, so the forecast mixes a refresh scenario (tracked players jump, rates dilute) with a no-refresh scenario and takes the quantiles of that mixture.

---

<sub>Entered on [make.fun](https://make.fun/?ref=s9sfjdj8&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
