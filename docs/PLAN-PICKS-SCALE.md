# Pick advisor above 400 pickable territories: research notes (#476)

Status: measurement done for option 1 and a first look at option 2; no planner change. The hooks and the script that
produced these numbers are in the tree (`PlanPicksInput.largeAbove`, `scale`, `evaluate`; `scripts/picks-scale-research.mjs`,
local only, never in CI).

## Method

`largeAbove: 0` forces the large-map path on maps the exact planner still finishes. The large path's primary group is
then scored on the exact model (`evaluate`, a full-ctx opening simulation) and divided by the exact planner's own primary
score: **1.00 = as good as exact, in the opening simulation's terms**. Maps are synthetic (seeded region-grown bonuses on
a grid with a few random links, 4% wastelands), 300–1,036 territories (about 75–250 bonuses), 2/3/6/12 players,
ordered and shuffled territory ids, 3–6 seeds per cell; 192 comparison runs for the ablation and 96 for the pool curve.

## Findings

1. **All of the loss is the candidate pruning.** Switching off the sampled centrality (`centralitySamples: Infinity`) or the
   hop bound (`hopDepth: Infinity`) gave identical results on every run. With pruning off the large path equals the exact
   plan (ratio 1.00 in all 48 runs) and takes about as long (4.1 s mean against 4.8 s exact at 600–1,000 territories).
   So the speed-up is the pruning too, and the other two approximations can stay as they are.
2. **Shipped path (top 50 bonuses):** mean 0.96–0.97, worst 0.83, below 0.9 in 7 of 48 runs (2 of 24 at 1,000 territories).
3. **Pool size curve at 1,036 territories (large ms, exact 2.6–9.4 s):**

   | bonuses ranked | territories ranked | mean ratio | worst | runs below 0.9 | large ms |
   |---|---|---|---|---|---|
   | 25 | 50–74 | 0.91 | 0.80 | 11 of 24 | 390 |
   | 50 (shipped) | ~120 | 0.97 | 0.83 | 2 of 24 | 740 |
   | 100 | ~250 | 0.98 | 0.93 | 0 | 1,420 |
   | 150 | ~430 | 0.99 | 0.93 | 0 | 2,190 |

   Time grows about linearly with the pool, quality saturates around 100 bonuses. There is no cliff at 400 pickables in
   the shipped path's quality; the cliff is that the pool is fixed at 50 whatever the map or the budget.
4. **Territory ids matter a little.** Shuffled ids read 0.96 against 0.98 ordered at 600–1,000 territories (3–6 seeds, so
   noisy); the ablation shows it is not the centrality sampling, so it is the candidate tie-breaking by id.
5. **The groups are not the same groups.** Primary Jaccard against the exact plan is only 0.15–0.8: many groups score
   within a few percent of each other. The score ratio is the honest measure; overlap is not.

## Caveats

- Synthetic maps: bonus value grows with bonus size by construction, so "value per member" is a good ranking here by
  design. A real map where the best start is a small cheap bonus behind a chokepoint would hurt the shipped ranking more.
  This is the main thing the numbers do not show.
- The score is the joint opening simulation. Contestedness, defensibility and the award judgement are not in it.
- 1,036 territories is the largest size the exact planner finishes in a reasonable time; the 3,066-territory case has no
  exact answer to compare with. The curve is extrapolation there.

## What this suggests (not decided; owner questions in #476)

- **Scale the pool with the budget, not a constant** (anytime, option 5): start at the best 25, add bonuses in value order
  while time remains (the pool-100 cost at 3,000 territories needs measuring), keep the best group found. The curve says
  the first 50 buy most of the quality and 100 almost all of it.
- **Rank candidates with something closer to the real score** (option 2): the pruning is where all the loss is, so
  ranking is the lever. Candidate signals already computed: value, members, entry points, wasteland cost, distance to
  the nearest probable foreign start.
- **Test on real maps.** The data directory's stored maps (`maps/`) and a finished-games record would give real bonus
  structure; the script takes a synthetic map only because no real map ships with the repo.
- Regions (option 3) and landmark distances (option 4) look unneeded for quality: the distance approximations cost
  nothing measured. Region decomposition would only matter if the pool, not the distances, has to grow past a few hundred
  bonuses.
