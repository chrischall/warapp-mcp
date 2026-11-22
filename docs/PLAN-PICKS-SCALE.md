# Pick advisor above 400 pickable territories: research notes (#476)

Status (2026-11-22): measured on real maps; the candidate ranking and pool size changed (see "Real maps" below). The
first round's synthetic-only notes follow it unchanged, for the record.

## Real maps (2026-11-22)

`scripts/picks-scale-research.mjs --maps <ids>` loads stored maps from the data directory (`maps/<id>.json`, every
territory pickable, plus each distribution mode of 40+ territories); it prints a map only by its territory count. Twelve
stored maps of 319–1,300 territories (62–712 bonuses), 2/3/6/12 players: 75 comparison runs per variant. The exact
planner finishes on all of them (mean 0.9–1.6 s).

### What the shipped ranking did on real maps

The top-50-bonuses-by-value-per-member pool scored **0.83** of the exact plan on average, worst **−1.31**, below 0.9 in
29 of 75 runs (0.72 mean at 300–700 territories). Growing the pool did not fix it: 100 or 150 bonuses still gave 0.85
(worst −0.78). Switching the pruning off gave 0.98, so the loss was again the pool, but not its size: it was **which
territories the ranking let in**. Diagnosed on single maps:

- **The best start is often in no bonus at all.** On a 347-territory map 47 territories belong to no bonus, and the
  exact primary held one or two of them (a hub touching several bonuses advances them all). A pool built from bonus
  members can never offer them, however many bonuses it takes (0.72–0.75 there with every bonus in the pool).
- **Negative bonuses.** One 561-territory map has 463 negative bonuses: value per member of the positive bonus says
  nothing about the penalties its members carry; the shipped primary scored negative (−0.28 to −1.31 of exact).
- **Overlap and reach.** On maps whose territories are all in positive bonuses (500, 665, 761, 1,300 territories) the
  shipped path still lost 10–40%: a large bonus with a low value per member, or a territory in two bonuses, ranks low
  per member and high in the real score.

The synthetic maps hid all three: bonus value grew with bonus size there, every territory was in exactly one bonus,
and there were no penalties.

### The change: rank every pickable by its own opening

Above `LARGE_PICKABLE` every pickable is scored alone with the first view's own measure (`assess`: the single-pick
opening simulation and its contest factor), and the pool is the best `largePool(budgetMs)` of them: `LARGE_POOL` (400)
at the default 20 s budget, in proportion otherwise (`LARGE_POOL × budgetMs / 20 s`), never under `LARGE_POOL_MIN`
(150) nor `maxPicks × 4`. The pool grows with the budget but is sized from it, not grown against the clock, so one input
plans the same on any machine (an anytime loop that doubled the pool while time was left made the plan depend on CPU
speed; a deterministic work count — opening simulations — tracked time badly, because 1v1 passes are cheap in
simulations and dear in hop searches).

| variant (pool) | real maps: mean | worst | runs < 0.98 | synthetic (96 runs): mean / worst |
|---|---|---|---|---|
| shipped before (top 50 bonuses) | 0.83 | −1.31 | 46 of 75 | 0.96–0.97 / 0.83 |
| best 150 by own score | 0.99 | 0.76 | 15 | 1.00 / 1.00 |
| best 200 | 0.99 | 0.76 | 14 | — |
| **best 400 (the default now)** | **1.00** | **0.99** | **0** | 1.00 / 1.00 |
| best 800 (a 40 s budget) | 1.00 | 1.00 | 0 | — |

Measured loss against exact at the default: mean 1.000, worst 0.99 (one run), none below 0.98. Just above the limit there
is no cliff: a 420-territory map's pool holds 400 of its 420 territories and its primary is the exact planner's (a test).

### Time and memory on the maps the exact planner cannot finish

`planPicks` at the default budget, 3 picks each, measured alone (`/usr/bin/time -l`, one process per call):

| territories | players | before: ms | now: ms | now: peak RSS / heap | now vs before: primary score |
|---|---|---|---|---|---|
| 1,494 | 2 / 25 | 317 / 769 | 1,710 / 1,437 | 176 / 60 MB, 214 / 82 MB | 1.47× / 1.07× |
| 1,812 | 2 / 25 | 910 / 1,273 | 4,232 / 2,541 | 196 / 61, 257 / 149 | 1.72× / 1.12× |
| 2,253 | 2 / 25 | 920 / 1,348 | 3,293 / 2,212 | 185 / 76, 249 / 144 | 1.00× / 1.00× |
| 2,770 | 2 / 25 | 1,083 / 848 | 2,030 / 1,560 | 178 / 55, 205 / 85 | 1.00× / 1.00× |
| 3,066 | 2 / 25 | 1,348 / 1,198 | 1,606 / 1,365 | 170 / 45, 188 / 72 | 1.34× / 1.36× |

Every call stays under ~5 s and never runs out of budget; scoring every pickable alone costs about a second at 3,000
territories. Heap stays under ~150 MB; the ~100 MB target holds on most maps but not all.

### The live 3,066-territory game (45660414), read-only

`warapp_plan_picks` on the live game took **272 s and 333 MB** (twice, 272.6 and 273.6 s) and returned `partial`. The game
is a full distribution with a territory limit of 122: 25 players × 122 = 3,050 picks, so `maxPicks × 4` made the pool
every territory and the 20 s budget was overrun by four minutes. Two causes, both fixed here:

- `spreadOf`, which describes each group, built its minimax spanning tree in O(n³) hop reads: 70 s of `describe` and
  `groupOf` on the 3,050-pick list. It is now Prim with each pick's nearest tree member kept (n²); the link it returns is
  the same (the bottleneck of a minimum spanning tree does not depend on tie-breaking).
- The budget was checked only between greedy steps; one step of a 122-pick group is thousands of openings, and once the
  budget ran out the hop relaxation still tried every seed at every hop limit. It is now checked every 64 candidates in a
  step, between hop limits and across the fallback seeds.

Replayed offline on the stored map with the same settings: 282.6 s → 21.3 s at the 20 s budget (3.3 s at 2 s), `partial`,
a valid 3,050-pick list. With a 3-pick limit the same map plans in 1.4–1.6 s. A full distribution deals every territory,
so a 122-pick compact group search is spent on a question the game does not ask; whether to skip it there is a planner
rule for the owner, not made here.

## First round (synthetic maps only) The hooks and the script that
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

## What the first round suggested (superseded by "Real maps" above)

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
