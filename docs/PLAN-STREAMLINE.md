# Streamlining the planner's rules (#603)

We have not won a game. The research behind this note had four parts:

- the decision logs of the lost games;
- the calibration of the income estimates;
- the lessons store;
- a self-play arena, which plays the planner against other bots on synthetic maps and resolves each turn with the turn simulator.

## What loses games

The openings are fine. Income tracks the opponent's to about turn 10–12, and then expansion stalls:

- the plans make 0–2 captures a turn;
- the planner sits on more armies than the opponent shows;
- its income falls while the opponent keeps spreading with cheap captures.

The arena reproduces this shape. Against a plain greedy spreader, today's planner wins 10 of 20 fogged games. Its income peaks around turn 15 and then declines.

The cause is a pile-up of defensive rules. Each one sizes a border for the opponent's whole deploy on its own:

| Rule | What it does | What it assumes |
|---|---|---|
| #420 one border per opponent | sizes the non-primary borders at stacks + largest top-up ever seen | the top-up is a maximum: after one dump of the whole income, every border is sized for nearly the whole deploy |
| #297 gate budget | stops a capture when the gates' summed needs exceed the next income | sums each gate's need, counting the one floating deploy once per gate |
| #432 short gates | cuts every capture's payback test from 10 to 5 turns when the gates are short | the same sum; in one lost 1v1 it read "short" from turn 3, and Central America (+3 for ~17 lost) failed the 5-turn test |
| rule 4d frontier veto | stops a capture when the frontier's hold cost exceeds the next income | sums the per-border needs; each new border is sized for the whole deploy |
| #421 strike share | holds 25% of a flat income out of captures for a strike stack | a flat income is exactly when the captures are needed |
| #382 siege (auto) | holds every attack but bonus breaks until a trigger fires | in a traced game it held 177 armies against 99 in view for 12 turns |

The rules contradict each other. #420 says one deploy lands on one border. The gate budget, the short horizon and the frontier veto each assume it lands on every border.

## Measured (arena, fog, seats swapped)

| Pairing | Games | Result |
|---|---|---|
| today's planner vs spreader | 20 | 10–10 |
| stacks-alone sizing (#603) vs spreader | 20 | 19–1 |
| stacks-alone vs today's planner | 30 | 22–8 |
| stacks-alone vs today's planner, no fog | 20 | 10–10 |
| stacks-alone vs spreader, no fog | 20 | 18–2 (today's planner: 12–8) |

On top of the stacks-alone sizing, each rule below was switched off, playing today's planner over 20 games:

| Switched off | Wins of 20 |
|---|---|
| nothing (stacks alone) | 12 |
| deploy counted once in the frontier and gates | 11 |
| #432 short gates | 12 |
| #297 gate budget | 12 |
| rule 4d frontier veto | 13 |
| #421 strike share | 11 |
| #420 hold cap | 12 |
| #382 siege auto-pick | 13 |
| short gates, gate budget, strike share and siege together | 13 |

Over 40 more games:

| Pairing | Result |
|---|---|
| stacks alone vs "lean" (short gates, gate budget, strike share and siege off) | 19–21 |
| stacks alone vs "leaner" (lean plus the frontier veto and hold cap off) | 19–21 |
| spreader vs lean | 4–36 |
| spreader vs leaner | 4–36 |

## Proposal

1. **Done in this PR (#603):** size each border other than the most valuable one at the stacks beside it alone. A quiet neighbour keeps its top-up. This is the one change the arena shows wins games.
2. **Owner decision, then a follow-up PR: remove the rules the arena shows add nothing.** These are the #297 gate budget, the #432 short-gates horizon, the #421 strike share and the #382 siege auto-pick (an explicit `goal: 'siege'` stays). Together they are several hundred lines and one more veto per capture. Six rules in that table become one principle:

   > Hold each border against the stacks beside it; hold the most valuable border against the whole deploy; spend the rest.

3. **Keep, made consistent:** rule 4d's frontier veto and the #420 hold cap cost nothing in the arena, but they guard FFAs and Local Deployment, which the arena does not play. Where they sum borders' needs, count the floating deploy once. This is the `deploy-once` switch: neutral in the arena, consistent with #420.

## Limits

- The arena plays 1v1 only.
- The arena has no cards, no commanders, no Local Deployment and no luck.
- Its maps are grids, and its opponents are the spreader and the planner itself.

The win rates are directional. Twenty games carry about ±3 of noise, so only the stacks-alone result (22–8 over 30, 19–1 against the spreader) is clearly real. The removals are "no measurable loss", not "a gain".

Run it locally:

```
npm run build && node scripts/arena.mjs --games 10 --fog --pairs planner:spreader
```
