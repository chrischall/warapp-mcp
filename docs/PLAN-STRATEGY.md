# warapp-mcp — phase 10 plan: strategy (S1–S3, S5, S6) and the fog-reveal income bug (#69)

The owner picked every remaining item of the strategy roadmap (S4, the pick advisor, shipped as #46).
The research behind it — community guides, bots, data sources — is summarised in `docs/STRATEGY.md`
and in the sections below; every heuristic is written **in our own words with a source link, never
copied text**.

Hard rules for every task: **no live network in tests or agents (never call war.app; a read-only
fetch of a public war.app wiki page is allowed where a task says so), synthetic fixtures only
(made-up maps, ids, names, `test@example.com`), never the real account email, a real game id, a real
player name or a real map's territory names in code, tests or docs; never read
`~/.config/warapp-mcp/session.json` or `.env`.** The cached client bundle
(`~/.config/warapp-mcp/bundle/*.js`) may be read to learn rules, never copied into the repo. The
planner and every analysis module stay **pure and deterministic** (ties on ascending id, no I/O).
TDD. Green = `npm run build` then `npm test` (typecheck + vitest). Strict surface lint 0 warnings
(recipe in `docs/PLAN-TURN.md` T4) whenever a tool surface changes. Each task commits on its own
branch with a conventional subject; never push, never switch another worktree's branch.

Existing tests change only where a behaviour change is intended; list each changed expectation and
why in the commit message.

## Tracks and branches

| Track | Worktree | Branch | Tasks | PR |
|---|---|---|---|---|
| F | `~/git/warapp-mcp-fog69` | `fix/enemy-growth-fog` (off main) | F1 | `fix(planner): …` Closes #69 |
| O | `~/git/warapp-mcp-opp` | `feat/opponent-tracking` (stacked on F) | S3 | `feat: …` |
| P | `~/git/warapp-mcp-strategy` | `feat/game-profile` (off main) | S1 → S2 | `feat(planner): …` |
| N | `~/git/warapp-mcp-notes` | `feat/strategy-notes` (stacked on P) | S5 | `feat: …` |
| D | `~/git/warapp-mcp-stats` | `feat/map-stats` (off main) | S6 | `feat: …` |

F → S3, S1 → S2 → S5 and S6 are three independent chains.

## F1 — fog reveals are not enemy income (#69)

Read `gh issue view 69`. `observedDeploy` and the per-territory `growthOf` trend in
`src/analysis/planner.ts` read a territory as "grew" or "captured" when last turn's board showed it
fogged or as something it was not. Live: a 1v1 opponent's visible armies went 78 → 159 mostly
because my border advanced and lifted fog over stacks that already existed; the estimate became 119
and the planner conceded six held-bonus borders (≈ −29 income). With 30 it held them.

- First find exactly how a fogged territory looks on the previous board for both trend sources
  (`boardFromHistory` and the board cache in `src/tools/turn.ts`, and the live-board parser): owner
  `unknown`? armies `null`? a neutral? Write it down in the commit and in `docs/WARAPP-API.md`.
- Growth counts only territories **visible on both boards with the same owner both times**.
  A territory fogged last turn contributes nothing, whoever holds it now.
- A capture counts (armies now + armies the previous owner held) only when last turn showed that
  territory **visible** and owned by someone else (or a visible neutral). A territory that appears
  owned by the opponent and was fogged last turn is a reveal, not a capture.
- Plausibility cap: the observed figure never exceeds what the opponent could earn — its base
  income for its visible territory count plus the value of every bonus it could possibly hold (each
  bonus with no territory visibly held by someone else) — and a warning says when the cap cut it.
- The rationale line for an observed estimate names the turns compared and how many territories
  were counted vs skipped as fog reveals.
- **The second point of #69** ("every border defended as if the opponent's whole deploy lands
  there"): per border this *is* the worst case — the opponent chooses where to land — so do not
  weaken a guaranteed hold. Check instead whether the hold costs double-count anything beyond that
  (e.g. one enemy stack's armies charged in full to two borders it cannot both hit with No-Split,
  or the deploy added twice). Fix any real double count; otherwise add a rationale line explaining
  why each border needs the full deploy, and reply on the PR body with that reasoning (the issue
  author asked).
- **Tests:** #69's shape as a synthetic 1v1 (fog lifts over three existing enemy stacks; observed
  stays at the true small deploy; held-bonus borders kept); a real capture from a visible
  territory still counted; a territory fogged last turn and owned now not counted; the cap; the
  rationale text.

## S1 — game profile (track P)

New pure module `src/analysis/profile.ts`: `gameProfile({ graph, board, me, players, settings,
turn, estimates })` →
`{ format: '1v1' | 'ffa' | 'teams', opponents: number, settings: { luck, rounding, cards,
localDeployments, noSplit, commanders, fog }, phase: 'opening' | 'expansion' | 'contact' | 'late',
standing: 'ahead' | 'even' | 'behind' | 'unknown', notes: string[] }`.

- **format** from the players' teams (the same team checks the open-games/join code uses) and the
  number of players still playing.
- **phase:** `opening` = turns 1–2 (or the picking stage); `expansion` = no territory of mine
  borders an enemy; `contact` = some border touches an enemy; `late` = one opponent left in a game
  that started with three or more, or one side holds over half the map's territories.
- **standing:** my income vs the strongest opponent's estimated income (the planner's per-opponent
  estimate): ahead when ≥ 1.25×, behind when ≤ 0.8×, else even; `unknown` when fog leaves the
  opponent's income mostly unseen (say so in `notes`).
- The planner (`planTurn`) computes the profile and returns it on the plan (`profile`). With no
  `goal` given, `warapp_plan_turn` picks a default from it and says why in the rationale, keeping
  `balanced` as the base. Encode these profile rules (each a rationale line when it fires):
  1. **1v1 in contact:** breaking an enemy bonus is valued like completing one of equal value (the
     opponent loses that income), and new neutral expansion that completes nothing ranks below
     holding and breaking.
  2. **FFA with two or more opponents left:** don't open a second front — never attack a player
     who neither borders a bonus of mine with a threat nor is being finished off, when a neutral
     capture of similar value exists; prefer neutrals. Finishing a weak opponent (#45's check) is
     still allowed.
  3. **Behind:** defend first (the `defend` ordering) and size attacks at the minimum (no extra
     margin beyond what the rules require). **Ahead in a 1v1:** keep attacking — do not let a lead
     sit (pressure plans allowed at a higher cost factor; state the factor).
  4. Explicit `goal` always wins over the profile; the plan says the profile was overridden.
- The `full` view echoes the profile; the compact view shows `format`, `phase` and `standing`.
  Tool description updated.
- **Tests:** classification table (1v1, 3-player FFA, 2v2 teams, one opponent left of four,
  no contact yet, opening turn, ahead/behind/unknown); each planner rule fires on a synthetic board
  built for it and not on one that isn't; explicit goal overrides; existing plans unchanged except
  where a rule's condition holds (list them).

## S2 — combat: efficient sizes and exact win chances (track P, after S1)

`src/analysis/combat.ts` today is straight rounding at 0% luck. Add an exact model:

- **Verify the combat rule first** from the bundle (or `https://war.app/wiki/Luck_Modifier` and
  `https://war.app/wiki/Combat_Basics`, read-only): with luck L, how kills combine the expected
  share `(1 − L) × n × rate` and the random share (each of the n armies kills with probability
  `rate`, scaled by L), and how straight vs weighted-random rounding applies. Record the rule and
  its source in `docs/WARAPP-API.md` as verified-from-bundle/wiki (not live).
- `winChance(attackers, defenders, { offensiveKillRate, defensiveKillRate, luck, rounding })`:
  the exact probability the attack captures (every defender dies and at least one attacker
  survives), by summing the binomial distributions — no simulation, no randomness. Also
  `guaranteedKills(n, rate, luck)` (the kills the expected share alone guarantees).
- Planner: every planned attack carries `winChance` (1 when the arithmetic is exact and certain).
  New `min_win_chance` parameter on `warapp_plan_turn` (0.5–1, default 1 = today's guaranteed
  margin, so default plans are unchanged); below 1 the planner sizes each capture at the fewest
  armies reaching that chance and says so. Under weighted-random rounding the chance is computed,
  not just warned about.
- **Efficient sizes:** a helper giving the next attack size that kills one more defender at the
  game's rate (e.g. 3, 5, 6, 8, 10, 11, 13 at 60%). When an attack has spare armies on its source
  that would otherwise sit idle and the next breakpoint is within reach, top it up to that size
  and say why; never take armies from a hold. Also the rationale names when an attack's size wastes
  armies (below the next breakpoint with nothing gained).
- **Tests:** win chances against hand-computed values in the test comments (small n, luck 0 / 0.16
  / 0.5, straight and weighted rounding); the guaranteed-margin size has chance 1 at luck > 0;
  `min_win_chance: 0.9` sizes smaller than the default; breakpoints at 60% and 50%; top-up only from
  idle armies; default plans unchanged.

## S3 — opponent tracking (track O, stacked on F)

Builds on F1's fixed estimate. The planner sees one previous board; this keeps a history.

- Per-game board history in the data dir (the existing board cache, one file per turn I planned
  or read; extend it if it keeps only one). Pure `trackOpponents(graph, boards[], me, settings)` →
  per opponent: per-turn observed deploy (F1's rules), its income estimate (median of the last
  three observed turns, floored by the visible-bonus estimate), **unaccounted armies** (income
  earned since first seen minus visible army change and visible losses: armies that must be in the
  fog), and **inferred bonuses** — bonuses it could hold (no territory visibly held by another
  player) whose values best explain the income gap; when several combinations fit, list them all
  as candidates, never assert one.
- New read-only tool `warapp_track_opponents(game_id, view?)`: the per-opponent report with names,
  turns used and confidence notes. The planner uses the tracked income (when ≥ 2 turns of history)
  in place of the single-turn observed figure, and its rationale says so.
- Register the tool everywhere tools are listed (README, skill, manifest, CLAUDE.md, packaging /
  annotation / server-boot tests).
- **Tests:** synthetic three-turn histories: a steady +5/turn opponent; a fog-hidden bonus (income
  gap 4 explained by the one +4 bonus that fits; two candidates when two fit); unaccounted armies;
  fog reveals not counted (F1); fewer than 2 turns → today's behaviour.

## S5 — strategy notes (track N, stacked on P)

- `src/strategy/notes.ts`: the heuristics as data — `{ id, topic: 'format' | 'settings' | 'cards'
  | 'reading' | 'map', when: (profile) => boolean, text, source }` — our own words, each with a
  link. Topics from the research: format (1v1 contact rules, FFA second fronts, teams ganging up),
  settings (efficient sizes, luck's guaranteed kills, Local Deployment, No-Split), cards (Order
  Delay for big attacks, Order Priority to retreat or strike, Blockade on your own bonus when
  weaker, take a card piece each turn), reading the game (count enemy armies, infer bonuses from
  deploys, ahead/behind play).
- Map notes computed from the map itself (no extra traffic): bonuses ranked by efficiency
  (value per army to take at the game's settings), entry points, chokepoints, and income targets
  by turn from the pick advisor's opening simulation when it applies.
- Read-only tool `warapp_strategy(game_id?, map_id?, topic?)`: with a game, the notes whose `when`
  matches its profile plus the map notes; with only a map, the map notes; with neither, every
  general note. Also an MCP resource `warapp://strategy` (general notes as markdown) and
  `warapp://strategy/map/{mapId}` if resources fit the server's registration pattern cleanly.
- `docs/STRATEGY.md` gains the non-pick sections, marking each heuristic **encoded** (and where)
  or **advice only**. Sources: war.app/Forum/811395-general-strategy-guidelines,
  war.app/Forum/99097-good-1v1-strategies, war.app/Forum/621189-ffa-strategy,
  war.app/wiki/Combat_Basics, war.app/wiki/Luck_Modifier, war.app/wiki/Cards.
- **Tests:** note selection per profile; every note has a source URL; map notes on a synthetic
  map; tool registration and surface lint.

## S6 — opt-in per-map statistics (track D)

Learn from finished games, never by default.

- **Opt-in:** off unless `WARAPP_STATS=1`; always off when hosted (detect the hosted environment
  the way the server already does, or a `MCP_HOSTED`-style flag — find it; if none exists, `mint.yaml`
  must not set `WARAPP_STATS`). The tool says how to enable it when off.
- **Source (verify, mark unverified in `docs/WARAPP-API.md`):** war.app's game-ID feed API for
  ladder/tournament games (read the public wiki page on the API, read-only), then GameFeed with
  `GetHistory=true` for each finished game, through `WarappClient` only.
- **Throttle and cache:** at most N new games per call (default 10, max 50), at least 1 s between
  requests, finished games cached forever under `<dataDir>/stats/<mapId>/<gameId>.json` (a cache
  hit costs no request). Errors per game are skipped and counted, never fatal.
- Pure `mapStats(games[])`: per map — most-picked starting territories, win rate by starting bonus
  (the bonus a winner's picks anchored), the turn of each player's first bonus completion, and the
  sample size. Never report a rate on fewer than 5 games without saying so.
- Read-only tool `warapp_map_stats(map_id, ladder_id?, max_new_games?)`; registered everywhere.
- **Tests:** fake client: opt-in off → refusal with instructions, no request; throttling (the fake
  clock sees ≥ 1 s gaps); cache hits make no request; stats on synthetic finished games; a failing
  game skipped and counted; hosted → off.

## Not in scope

Search-based planning (MCTS), counter-picking from opponents' histories, changing write tools.
