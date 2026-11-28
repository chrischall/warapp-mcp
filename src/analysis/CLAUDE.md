# src/analysis/ — warapp-mcp

What is true of the planner, the estimates, opponent tracking and profiles, picks, the turn simulator and the self-play arena. The repo-wide rules are in the root `CLAUDE.md`.

- **The plan stress test is `warapp_check_plan`** (read-only; it writes nothing but its verdict to the decision log
  (#437), not the board cache either). `src/analysis/turn-sim.ts` resolves one turn from every player's orders by the wiki's rules
  (`docs/STRATEGY.md` "Turn resolution" links each page: deploys first, then attacks and transfers
  in the zigzag, an order that moves no armies taking no slot; attack or transfer decided when the
  order runs; the guard army, which an arrived army can be and a commander cannot; each army
  moving once; mutual destruction leaves one defender; Order Priority makes its player the first
  mover for the turn; commanders as 7). What the wiki does not state is assumed and named in the
  result (an order sends what is left; an order from a territory captured first does nothing;
  losses fall on movable armies first; the mutual wipe with the guard off), and with luck or
  weighted rounding battles are resolved at their expectation (`exact: false`). A territory whose
  armies are hidden is unknown to it whoever holds it. `src/analysis/stress.ts` runs a list of
  orders against each opponent's single-deploy replies (attack from one stack with its commander,
  sit on a territory I attack, every stack at once, spread and concentrated; #593 5c: `gather`, the deploy on a
  territory I attack and every stack of its owner beside it moving in first — the bait — tried with it moving first
  only, never when I am known to move first, `movedIn` naming each stack and what arrived; #180: a struck stack
  dodging first, two opponents on one territory — teammates, or any two when I lead a free-for-all
  — and under Multi-Attack each stack's best chain; Local Deployment bounds each deploy as the planner does, #293), under both move
  orders unless `first_mover` is given, with the same per-opponent deploy estimates as the
  planner; the opponents are whoever holds a stack on the board, not only players GameFeed calls
  `Playing`. "Safe" means safe against those replies only: fog-hidden stacks (`blindBorders`,
  `unseenOpponents`), a deploy above the estimate, split deploys, other joint attacks, more than
  one chain per stack and cards are not tried, and `safe` is `null` when nothing could be tried. It also looks one turn ahead
  (`exposedNextTurn`, #156): a territory of mine that a stack two steps away could take next turn by
  first taking the territory in between (mine or neutral), with the armies it would need to hold, on
  the assumption that I add nothing next turn; this never changes `safe`. Both modules are pure and
  deterministic like the planner, and neither is called by it. The look-ahead itself lives in
  `src/analysis/lookahead.ts` (`twoStepReaches`), one computation shared with the planner's two-step
  hold (#172, applied wherever armies leave a guarded territory: attacks and their softeners,
  transfers, staging, top-ups — guarded: my commander's, a held bonus's member, or (#291) a territory whose loss opens
  held bonuses, so the gate behind a conceded border keeps a hold; #257's step into that conceded border cuts the reach
  through it and is not blocked): change it there, and `exposedNextTurn` and the planner move together.
- **Airlifts are first-class (owner request 2026-11-24).** `turn-sim.ts` takes `airlifts` (phase 43: after every
  deploy, before every move; what lands is marked moved), `stressPlan` and the look-ahead pass them through, and
  `warapp_check_plan` tries every reply on the board the Airlifts leave (no longer "ignored"). `warapp_submit_turn`
  refuses an Airlift that leaves no army behind while the guard is on (ours; the validator does not check the count),
  and after a `committed` read-back compares every Airlift sent with `LatestGameInfo`'s active orders
  (`src/tools/airlift-readback.ts`): missing or altered throws (nothing resent), else `airliftReadBack`. My card
  state (`src/card-state.ts`: whole cards by type, and `PlayerCards.Pieces` read by shape — UNVERIFIED live) is
  `cards` on `warapp_get_game` (one GetLatestGameInfo while played/picked with a card in play) and `begun`.
- **The Airlift plan (owner request 2026-11-24, `src/analysis/airlift-plan.ts`, pure).** Only with an Airlift in my
  hand (beyond `keep_cards` and any the plain plan uses), `warapp_plan_turn` adds `airliftPlan`: candidates (an interior
  stack's spare onto a border the plain plan concedes, a held bonus's member first; a conceded border's spare onto the
  most-pressed kept border) are applied to the board and planned by the UNCHANGED `planTurn`, kept only when nothing
  moves out of a destination beyond what stood there plus its deploys less the guard, and the best beats the plain plan
  on `scoreOf` (next income if conceded borders fall, next income, fewer concessions, more captures). The plain plan and
  its `orders` never change: golden byte-identical. Staging (owner decision 2026-11-24, DRAFT): airlifted armies cannot
  attack that turn, so `stagingCandidates` flies an interior stack beside a target the plain plan does not take whose
  capture next turn completes or breaks a bonus, sized by `armiesToTake` (an opponent's target plus `plan.enemyDeploy`);
  the planner plans without the staged armies, and `stagingGain` credits the bonus (× `STAGING_DISCOUNT` 0.8, the
  two-turn `PlanScore.twoTurn`, ranked first) only when the stack still makes the attack and holds against every enemy
  stack beside it plus the enemy deploy (luck-free). Reported as `staging`. A plan the submit's commander check would refuse is not offered.
- **The Bomb through the same pipeline (owner request 2026-11-24, part B).** The rule is read from the client bundle
  (`GameOrderPlayCardBombResult`): phase 30, after every deploy and before the Airlifts and moves, the target keeps
  round(armies / 2) with a half rounded down (i.e. floor), special units untouched; nothing on the bomber's own territory
  or hidden armies. `turn-sim.ts` takes `bombs`, `stressPlan`/look-ahead pass them, and `warapp_check_plan` carries a
  Bomb out instead of warning. `src/analysis/bomb-plan.ts` (pure): `bombPlan` beside the plain plan in
  `warapp_plan_turn` (only with a Bomb in hand; candidates an opponent's territory beside mine, a held bonus's member
  first, then the largest stacks, never a player at peace; the unchanged planner on the halved board; `scoreOf`). The
  submit reads a Bomb back (`checkTargeted`, `cardReadBack`) like the Airlifts. The play stays UNVERIFIED live: no
  played Bomb was found to read (in-progress games' history is not served; no finished game had it in play).
  `bombAdvice` (`card-threats.ts`) uses the same rule (`bombLeaves` in `combat.ts`; owner decision 2026-11-24 — it took
  the larger half for an enemy before), so the advice and `bombPlan` agree; two advice tests' boards changed target.
- **The walls through the same pipeline (owner request 2026-11-24, part B).** From the client bundle: an Emergency
  Blockade (`GameOrderPlayCardAbandonResult`, phase 37) and a Blockade (`…BlockadeResult`, phase 60, only while its
  player still holds the territory) turn it neutral at `roundHalfDown(armies × MultiplyAmount)` (`turn-sim.ts`), its
  special units lost. `turn-sim.ts` takes `abandons`/`blockades`, `stressPlan` excludes a walled territory from
  `mineAtStart` (given up, never "lost"), check_plan carries both out with the settings' multiplier (none: warned as not
  simulated), and the submit reads them back (`cardReadBack`). `src/analysis/blockade-plan.ts` (pure, DRAFT):
  `blockadePlan` (owner-approved 2026-11-24): with an Emergency Blockade, a conceded border of mine (not my commander's),
  denials first, planned walled; its worth is the bonus its fall would complete for an opponent with a stack beside it
  (`scoreOf(plan, denied)`, × 0.8), credited only when the wall holds this turn. With a Blockade (`planBlockade`): the
  plain orders plus the card on a territory of mine with that denial, only when `stressPlan` (each opponent beside me at
  the plan's enemy deploy, no look-ahead) keeps it mine through the attacks, charged any bonus of mine it gives up; the
  better of the two is offered. The Emergency Blockade play stays UNVERIFIED live.
- **Commander safety (#274, `src/analysis/commander-safety.ts`, pure).** One question of the stress test: of
  the single-deploy replies that strike my commander's territory after my orders (`stressPlan`'s `targets`,
  no look-ahead), which kill it, and the armies it needs there to survive them all (`needs`, searched by adding
  armies on its starting territory); plus the smallest deploy, the same for every opponent, that kills it
  (`killedBy`) and the moves to the nearest enemy or fog. `warapp_submit_turn` refuses, in a Commanders game,
  orders that leave it takeable with replies sized at max(each opponent's estimate, my income) — estimates from
  `src/tools/stress-opponents.ts` (shared with `warapp_check_plan`), the cached boards only, never a GameFeed
  request — unless `accept_commander_risk: true`, which the preview warns of first and the result records
  (`commanderRiskAccepted`); never refused without commanders or with the commander safe. One check serves all
  three tools (`commanderCheckOn`, `src/tools/commander-check.ts`; `stressOpponents` reads a static seat (#270) as
  neutral land, never a killer): the same opponents, teams, free-for-all lead — two opponents striking together
  when I lead — Order Priority and Airlifts, each reply at max(estimate, my income), `enemy_deploy` only raising
  it and so does an untrusted opponent's #275 figure (`untrusted`: max(implied, my income), the figure
  `warapp_check_plan`'s stress test tries; the submit reads the marks from the board cache, the plan passes its
  own), both move orders always (`first_mover` is not passed). `warapp_check_plan` reports `commander` (with
  `replyDeploy` and `sizing`) by that check, so its count and `needs` may differ from the stress test's
  `atRisk.commander`, which tries the estimates, and leads its summary with it when a reply kills it;
  `warapp_plan_turn` carries a `commander` block every turn (and a first warning when the plan's orders would be
  refused) by the same check, so it never calls safe what the submit refuses;
  its first warning names the submit's refusal only when the submit would make it (Commanders on, and the risk
  found without `enemy_deploy`). `killedBy` is one deploy made by every opponent at once, with `partner` when the
  killing reply is a joint strike. My Airlifts are simulated (`airlifts`: applied with my deploys before the moves,
  the commander moved with one that takes it); a Blockade or Gift of a territory the commander stands on before or
  after the orders is not simulated and is refused unless accepted. The submit skips the `killedBy` search.
- **The planner walks my commander to safety and holds it for the worst case (#274 items 2–3,
  `src/analysis/plan/commander.ts`, rule 1w).** Within `COMMANDER_CLEAR_MOVES` (3) moves of an enemy or
  fogged territory, with a territory of mine strictly farther from all of them reachable through my land
  (never onto one nearer an enemy than where it stands, nor onto one beside an enemy or the fog: taken
  first, the step would turn the transfer into an attack), it walks one step a turn: a transfer with
  `commander: true` (the #165 option, encoding UNVERIFIED live; `warapp_plan_turn`'s `orders` carry it, and its
  commander block and the submit's check follow the commander there) — the move to that step when the plan has
  one, else its own 0-army transfer; under No-Split the territory's one order, reserved before any pass, with
  the whole stack. The step is my commander's territory for rule 1k that turn; where it stood is held only for
  its own worth (its 7 not counted there), except that after the strikes and before triage it gets the deploys
  that survive what may land there before the walk (`commanderTransit`), after the step's own hold — even when I
  am known to move first, since the submit's commander check is not told who moves first and tries the opponent
  first too. Moving first, a walk that is not my first order runs after two of the opponent's orders (me1, opp1,
  opp2, me2), so the hold is sized for every enemy stack beside it attacking in turn, each player's deploy on one
  (review 2); when that does not fit, for each player's strongest attack only, and the walk is then my first
  order with no Order Priority advised (`ps.commanderWalkFirst`; a warning if a strike or kill still goes first);
  when neither fits, all that is left goes there, with a warning (`ps.commanderCaught`). The walk goes early; it is
  my first order (after a protected strike or kill) in those two cases or when the fog borders it, and Order
  Priority is advised for it only when caught; otherwise the first order is chosen as before. Every other move
  out of its territory waits for the walk (`scheduleMoves`' `beforeWalk`: only a strike that ends a player may
  go first). A walk carrying no armies never waits behind a move into its territory (one carrying armies does).
  Under No-Split the walk wins over a strike or kill from that territory; a commander kill that territory alone
  could send is a warning naming it (and that a 1v1 ends with it). The commander check (`targets`) also tries
  every stack beside its territory converging on it, the deploy on each in turn (the all-attack puts it on the
  largest stack, which may face elsewhere). A what-if `enemyDeploy` below my income sizes the plan's holds for
  the what-if while the check sizes replies at my income: such a plan can read unsafe (pinned by a test). The plan's first
  warning says it walks; with nowhere safer it stays, and a hold it cannot fund is the first warning. Rule 1k's
  threat is now the worst case: per opponent (a team together; the FFA leader's every opponent) its whole deploy,
  at least my income (a what-if `enemyDeploy` as given), plus the movable armies of every stack of its within two
  moves — under Multi-Attack even with no enemy beside it (a chain through my land). `PlanOptions.commanderWalks:
  false` keeps it where it is (the #61 tests use it). Golden: every commander board changed, no other.
- **The fog's attackers (mega-game part 5, `src/analysis/commander-fog.ts`, pure).** `PlanOptions.foggedAttackers`
  `{count, stack, starts?}` adds to rule 1k's threat on my commander's territory (`borderAt`; `visibleBorderAt` is the old
  one, which `commanderTransit`'s step reserve keeps, so the transit hold against what is in view comes first): every
  fogged territory beside it, or one step past a territory not mine whose armies show (less what taking that costs), may
  hide a player with a deploy of my income; the `count` strongest strike in turn (#201's arithmetic; `FOG_PLAYER` -1 when no
  visible opponent faces it). #529 (owner): it holds `stack` only as a likely holder — in `starts` (turn 1: the distribution
  mode's territories, else every territory but a picking-board wasteland), an opponent shown, or a player in `lastSeen` —
  else its usual estimate (vacated size, last sighting, picking-board neutral, else `neutralArmies`). `foggedAttackersFor`
  (`src/tools/turn.ts`, in `livePlanSetup`) turns it on with 2 only in a Commanders free-for-all of 8+ players playing under
  fog (`fogged_attackers` overrides), stack = `InitialPlayerArmiesPerTerritory`, else my largest stack. `foggedCommanderOn`
  reports it (plan_turn's `commander.fogged`, check_plan's `fogged_attackers` — the same default, `defaultFoggedCount` in
  `src/tools/commander-check.ts` (#531), a uniform stack); never a submit
  refusal. Golden 0 of 6253 (off by default); forced on as the tool sets it in all 252 commander boards: 34 plans changed,
  13 in orders, 9 with fewer captures, 3 with a lower next income.
- **The pick advisor `warapp_plan_picks` is read-only** and refuses outside `DistributingTerritories` or when the
  live board has nothing pickable. Its scorer (`src/analysis/picks.ts`) is pure and deterministic like the turn
  planner; neutral sizes come from the live board when shown (wastelands at their real size), else the settings.
  The territories per player (`pickTerritoryLimit`, #428): TerritoryLimit when set; under full distribution
  (DistributionMode 0, no limit) the client's no-cap share floor(pickable ÷ players), every territory being dealt; else
  the default 3 (each assumption a warning).
  Its opening simulation keeps armies where they stand (an attack is funded by its bordering source plus that
  turn's deploys, never by pooling another pick's armies — that made it promise first-turn bonuses `plan_turn`
  could not deliver, #47; at 0% luck, straight rounding and No-Split off, a neutral one order cannot pay for
  may be taken in two, the first only wearing it down, #166: `twoOrderCaptures`). A bonus's defensibility
  counts an entry point once per member it borders (a double border twice), and a completed bonus is credited
  by who can reach it (`THREAT_LOSS` × the chance an opponent starts on a pickable territory whose lone stack
  stands in or next to it by its completion turn; a pick of mine is no threat, #166). A group is compact,
  a 1v1 included (one cluster linked in steps of at most 2 hops
  on the route tool's graph), relaxed one hop at a time with a warning when no such group exists; a spread 1v1
  primary meant a frontier on every bonus from turn 1 (#73). In a two-player game with a primary of 2 to 4 picks
  the fallback is not a group: each pick is chosen for the award outcomes that grant it (my opening there less
  `OPPONENT_WEIGHT` × the opponent's from the picks lost, #166), and is chosen again when the award order
  reorders the primary; any other 1v1 fallback goes to another area when one scores as much. In a 1v1 entry
  points weigh twice as much. The old bounded 1v1 spread
  survives only behind `spread: true`. The rationale reports real hop
  distances and never calls a group compact unless it is one such cluster. The primary is the best-scoring
  group any of the best seeds grows, and the fallback is scored with the primary taken (it is granted only
  then); a first fallback tier of the primary's size that is one compact cluster and, scored alone, beats the
  primary becomes the primary (#289: the seeded greedy search missed it), and a fallback that still outscores it
  is warned about with the reason the primary stays first (an answering tier is granted whole only if every
  primary pick is lost; a spread one breaks the one-cluster rule); a list past twice the limit (the client allows players × territories per player,
  `clientPickLimits`, docs/WARAPP-API.md) runs in tiers of the primary's size. The list is judged by the award
  order (rounds in a reversing move order, each player getting their best free pick: `pickOutcomes`), reporting
  the worst set it can yield and the other players' starts that implies; the primary is reordered only when that
  raises the worst outcome. #429 (owner decision 2026-11-22): in a 1v1 with an answering fallback, a fragile list (the fallback
  outscores the primary, or the worst outcome is under `FRAGILE_WORST` (0.6) × the primary's score) has each primary pick 2…n
  scored in the outcomes that lose a pick above it; a compact replacement that scores more there stands only when the list's
  worst and mean award outcomes both rise and the primary keeps `PRIMARY_FLOOR` (0.8) of its original joint score (warning
  code `primary-answered`). #305 (owner decision 2026-11-20): `side` (`mapSides`, report only, never scored) is the positive
  bonus income on my side of the map — a bonus whose every member is strictly nearer (hops) the primary than any start that
  worst outcome implies for the others — against the contested rest; with no start implied it splits nothing and says so
  (`known: false`). With commanders on, the primary's safest pick (fewest other pickables within 2 hops)
  is listed first, since the first pick awarded carries the commander (#129).
  In a team game (C2) only players off my team are threats (a known start may be a teammate's: the worst case), the award is
  judged by both a reversing and a repeating order (`award.orders`, unverified), the duel rules stay two-player, the list stays
  starts × all players, and the award reading puts a start the first board shows as a teammate's in `teammateStarts`.
  With a teammate's list read (C2 coordination; `readTeammatePicks` in `src/tools/team.ts`: `TeammateOrders`, then
  `GetTerritoryPicks` — V6 verified live 2026-11-22; the `TeammateOrders` pick list still unverified) `planPicks` takes `team.lists`: each teammate's top (the territory limit) leaves my
  candidates and is `friendly` in the simulation (never captured, so a bonus with one never completes for me — a bonus pays one
  holder; no threat; a known teammate start); my list is shortened to my starts + the opponents' only when disjoint from every
  teammate list and each is as long as the client allows (a short one can run out, and war.app then grants from mine); `plan.team` reports `overlap`, `sharedBonuses` and `mirrored` (my primary and each top laid on the hands a
  reversing award gives, `splits` naming what a repeating order would split; its `submitPicks`, the shared top then my
  fallback, is capped at `maxPicks`). No list read, or only empty ones: byte-identical. #435: a teammate's list that cannot be read (`null`, unknown — not an empty one) gets a plan_picks warning to hold the submit, and `warapp_submit_picks` refuses in a team game while any playing teammate's list is unread (read the same way) unless `without_teammate_list: true`, which the preview then warns about. V6 refusals that never lift — 187 `CannotGetOpponentsPicks` (war.app calls the player an opponent: `refused: 'not-teammate'`, warned as a possible team misread) and 188 `CannotGetPicksInAutomaticDistribution` — read as an empty list with `refused`, never as unread, so they cannot hold every submit for good.
  Its `submitPicks` (ids in order) is what `warapp_submit_picks` takes; in a two-player game without `spread` it also offers a
  coverage-first `alternative` (a pair, then the picks that most raise `coverage` — the reasonable bonuses reached within 2 moves
  past no wasteland; `coverageModel`) with its own `submitPicks`, only when it covers more, the primary unchanged (#166). `docs/STRATEGY.md` states the community
  heuristics in our own words with source links (cite, never copy) and marks which are encoded.
- **The pick advisor on a very large map (2026-11-22).** `warapp_plan_picks` on a 3,066-territory, 25-player manual-pick game
  took ~22 s and ~530 MB (an all-pairs distance cache, an all-pickable assessment per fallback tier) and the host answered
  "could not be served". Above `LARGE_PICKABLE` (400) pickable territories `planCore` scores every pickable alone (its own
  opening, the first view's measure) and ranks only the best `largePool(budgetMs)` of them: `LARGE_POOL` (400) at the default
  20 s budget, in proportion to the budget otherwise, never under `LARGE_POOL_MIN` (150) nor `maxPicks × 4` (`candidates` in the
  plan says how many; every pickable still counts as a start in the threat model). #476 (2026-11-22): the earlier ranking — the
  territories of the best 50 bonuses by value per member — missed the best start on most real maps (a hub outside every bonus,
  overlapping bonuses, 463 negative bonuses on one map): 0.83 of the exact score on 12 stored real maps, worst negative, against
  1.00 (worst 0.99) now; measurements in docs/PLAN-PICKS-SCALE.md. The pool is sized by the budget, not grown against the clock,
  so one input plans the same on any machine. It reads contestedness from `CENTRALITY_SAMPLES` (48) sources and searches hops to `SCALE_HOP_DEPTH`
  (8); at or below the limit nothing changes. `PlanPicksInput.budgetMs` (the tool passes `WARAPP_PICKS_BUDGET_MS`, default
  20 s, 0 or less none; `clock` is injectable) makes an expired search finish by score (`partial: true`, a warning, a valid
  list); an exception inside the advisor is a `McpToolError` naming the game, map size and players. The compact view caps reasons
  (`COMPACT_REASONS`, first `COMPACT_DETAILED_PICKS` picks only), threats, bonuses, coverage and warning/rationale lines, counting
  what it cut (`…Omitted`); `submitPicks` is never cut. 3,102 territories / 25 players: 22.5 s → 1.8 s, 529 → 37 MB heap.
  The budget is checked inside each greedy group step (every 64 candidates), between hop limits and across the fallback seeds,
  and `spreadOf`'s minimax spanning tree is Prim with each pick's nearest tree member kept (n², not n³): a full distribution
  (live game 45660414: 25 players × 122 picks, 3,050 listed) took 272 s and now stops at the budget (~21 s at 20 s, `partial`).
  Owner 2026-11-22: under a full distribution (DistributionMode 0, no territory limit — `pickTerritoryLimit` returns
  `fullDeal`) every territory is dealt, so `PlanPicksInput.fullDeal` skips the compact group search: each group and the
  fallback are the best picks by score (a warning says so). The live case plans in ~5 s, whole, not `partial`.
  `planTurn` and `stressPlan` on the same map take under 1 s (pure; the live read was not measured).
- **Single-pick starts on a huge map (mega-game spec part 2, 2026-11-23, `src/analysis/single-pick.ts`).** `singlePickMode`:
  `PlanPicksInput.overridden` (the tool sets it when the game overrides any bonus), territory limit 1, no team, not a full
  deal, 3+ players, a map of `HUGE_MAP_TERRITORIES` (1,000)+ and more pickables than `SINGLE_PICK_SHOWN` (25). Then
  `rankSingleStarts` scores each pickable alone — a `SINGLE_HORIZON` (5) turn flood opening at the game's values (pooled
  armies, another pickable never taken, members of paying bonuses first), the income above the base over 6 turns, each
  completed bonus discounted by `SINGLE_THREAT_LOSS` × the chance a rival starts within reach, less a safety charge in
  starting armies (rivals within `RIVAL_RADIUS` 3, open approaches, 2-hop pocket entries, shielding wastelands credited;
  ×2 with Commanders) — simulating at most `SINGLE_POOL` (600) by a quick score, the rest after; cached per graph
  (4 inputs), never when `partial`. The plan's `single` (tool: `startRanking`, `page`) details 25 per page;
  `submitPicks` is the ranking cut at `maxPicks`. Game 45736172's map (2,841 territories, 346 pickable, 97 players):
  1.1 s → 65 ms (27 ms cached); all 2,841 pickable 1.35 s → 110 ms. Picks golden: 163 of 165 real-map plans
  byte-identical, the 2 changed are the overridden limit-1 ones; planner golden untouched.
- **The award of picks is read once, from my own list (#166).** The list war.app read back
  (`warapp_submit_picks`, or `warapp_get_my_picks` during distribution for the signed-in account) is kept at
  `<dataDir>/picks/<gameId>.json` (`src/pick-list.ts`, territory ids only). On turn 1 `loadAward`
  (`src/tools/award.ts`) reads it against the territories I hold (`readAward`, `src/analysis/award.ts`: with two
  players every award that fits is enumerated and only what holds in all of them is kept) and stores the result;
  later turns reuse it, and a list that cannot explain the start gives nothing. `warapp_plan_turn` and
  `warapp_check_plan` report it as `award` and, in a two-player game, plan on the opponent's proven starts while
  they are fogged (owner, plus the starting armies on turn 1); the board cache and opponent tracking keep the
  board war.app showed. The move order (`award.firstMover`, `Cycle` only: under `NoLuckCycle` play speed sets
  the first order, not the award) and the commander start are the wiki's rules, not verified live: never used
  to narrow the stress test, to place a commander or to size a hold (#215); `warapp_plan_turn` defaults its first mover to it.
- **The planner reads teammate orders (C3.4–C3.7) only when `board.teammateOrders` carries them** (none in the
  golden corpus: those plans are byte-identical). `teamFocusOf` (`src/analysis/plan/team.ts`, `PlanCtx.teamFocus`)
  is a tie-break only: a capture of a player a teammate attacks ranks above an otherwise equal one (balanced greedy
  after the score; rule 4e before its last keys), with a "Team focus" rationale line. `team.support` (a teammate's
  border that falls given their entered deploys and orders out, where my idle armies beside it — `avail` beyond
  `keepFor`/two-step/cover keeps — make it hold; each idle army allotted once, fewest-needed border first, G3) and `team.jointCaptures` (neither takes it alone; the turn
  simulator with only those attacks, both orders, also against the owner's deploy; `mustGoFirst` under a cyclic
  `game.moveOrder`) are advisory: a move onto a teammate is V7, so neither is ever in `orders`. Cards
  (`src/team-cards.ts`): a card a teammate entered a play or discard of leaves my hand before `chooseCardPlays`, and
  plan_turn's `cards.team.roles` says who plays each card (V5 verified before commit, 2026-11-22); `warapp_submit_turn` and
  `warapp_check_plan` warn when my orders use such a card (`claimedCardUses`), and a card named by type resolves to
  an unclaimed one first (`unclaimedFirst`).
- **The planner honours a truce (B2, `src/analysis/plan/relations.ts`).** `warapp_plan_turn` resolves
  the ledger with `planRelationsFrom` (`src/analysis/relations.ts`: covered territories on both sides
  on this turn's board, `breachWatch` over my cached boards, `trust`; an unambiguous `broken` flag makes
  it `broken`, T8) into `PlanInput.relations`; the plan reports `relations`, `advice` (`give-notice`) and
  the tool `tacit`. Only in a free-for-all (teams or two players: ignored, a warning — but T1 still holds there), while `active` or
  in `notice` before `endsTurn`: a covered partner territory is never a target (T1: `pc.truce.noTarget`,
  checked at every attack source — targets, tryCapture, the strikes, lead strikes, guard-off breaks,
  rule 4e); a covered border facing only the partner is sized for its stacks with no deploy (T2, in
  `forceAt`) unless my commander stands there, it protects more than 0.25 × income, or trust is `watch`
  (T3); the partner is no front for rule 0p.2 or rule 6, and a territory beside a covered one keeps its
  hold (T4); a border cap (T5) is never overfilled by my own withdrawals, staging or rule 6 transfers
  (`capRoom` / `capStepRoom` at those call sites), and after rule 6 any excess is deployed one step back,
  trimmed off a transfer in, or moved back — a warning names this plan's own deploy when that exceeds it
  (deploy less, or give notice and ask the owner: never a silent break), and one that the cap leaves
  short of its hold against another opponent beside it, or of my commander's full hold; the report's #69
  line, #167 cover odds and #201 gamble leave out a T2-relaxed border (`relaxedFor`); `enforced` (T9) makes the
  player no foe — `planRelationsFrom` never sets it (the ledger's field is ignored until a decoder-backed,
  turn-bounded source exists). `armiesFreed` counts a relaxed border only where the full hold would have
  been funded (not conceded, not refused by rule 1a or my income), capped at what the plan's orders leave
  that border short of the full hold. **No
  relations, no change:** every hook is false or absent then, and the golden corpus must stay
  byte-identical. **T6:** after the orders are final, `truceBreakLosses` carries out, per binding unenforced
  truce, the partner's whole deploy estimate on any territory of its beside a covered one of mine (covered or
  not: T2 relaxes against every stack there) and an attack with everything there, against the plan's orders on `turn-sim.ts` (both move orders unless the
  first mover is known and verified; no other player moves), and reports the costliest as `lossIfBroken`
  (my commander, then income, territories, armies); it changes no order. `warapp_check_plan` reads the same
  truces (`truceRelations`, `src/tools/turn.ts`), keeps every partner among the opponents (`safe` is safe
  against a break), marks a reply that attacks a covered territory `breaksTruce`, and adds `safeIfTruceHolds`
  over the rest (`stressPlan`'s `truces`; a mixed all-attack is dropped whole). #376: such replies rank after every
  reply that keeps the truces (so `worst` is a real threat), and an `exposedNextTurn` entry whose partner reaches it
  through a covered territory (or takes a covered one) is `breaksTruce` too, listed last and counted apart in the summary. **`warapp_submit_turn` refuses
  an order that attacks a territory an active or in-notice agreement covers** (`truceBreaksIn`, the ledger and
  the live board only) unless `break_agreement: true`; then the preview names the agreement, and once the
  outcome is `confirmed` the ledger records `broken-by-me` and the player record updates
  (`agreementsBroken`; otherwise it says to record it by hand). That is final: `warapp_uncommit_turn`
  does not undo it, and says so (`agreementsStillBroken`, the agreements broken-by-me on that turn). **Partner-approved
  exceptions** (`Agreement.exceptions`, additive: `{id, direction: mine|theirs, territories, fromTurn, toTurn, recordedTurn,
  note?}`, turns inclusive, the note the owner's words with names scrubbed, `scrubNames`) are no break and no status change:
  `exceptedOn` drops them from `truceBreaksIn` (mine), `breachWatch` (theirs: no `broken`) and the plan's covered sets
  (`PlanRelation.exceptions`); `warapp_record_agreement` `exceptions` adds them in any status, `warapp_submit_turn`
  `partner_approved` records a one-turn `mine` one once committed (`recordPartnerApproved`; with `break_agreement`: refused);
  the player record counts them apart (`exceptionsMine` / `exceptionsTheirs`, absent in older tallies = 0). **Coordination
  notes** (`RelationsLedger.coordination`, `src/analysis/coordination.ts`: `{id k<n>, with, target, mine, theirs, turn?,
  recordedTurn, doneTurn?, note?}`, ≤50 per game) are report only: `warapp_record_agreement` `coordination` /
  `coordination_done` (no agreement needed), listed by `warapp_get_relations`, told by `warapp_plan_turn` as a rationale line
  appended in the tool layer when `coordinationDue` — the planner never sees them. **Territory caps**
  (`Agreement.caps`, additive: `{territory, max, addedTurn, note?}`, ≤20, `withCaps`) amend a non-terminal agreement without
  touching `terms`: `PlanRelation.territoryCaps` feeds `capsOf` beside the border cap (`promised` names the line), check_plan's
  `territoryCapOverruns` warns, `capSelfCheck` adds a `cap-exceeded` flag `by: 'me'` that `trust` never sees, and the player
  record keeps only `terms.caps` (a count). Not yet: writing `broken-by-them` to the
  ledger itself (the plan's T8 warning says to record it with `warapp_record_agreement` before submitting).
- **A coalition before a surrender (#445; owner answers of 2026-11-23; advice only).** `coalitionAdvice` (`src/analysis/coalition.ts`, pure): in a free-for-all (`plan.profile.format === 'ffa'`, the line against a player, not a team) with 3+ seats still playing, once the #436 surrender line is crossed and I am not the side it judges against, `warapp_plan_turn` reports `coalition`. The leader is the surrender line's side (the strongest anywhere, #530) and every income is the outlook's calibrated estimate (#419): the crossed line carries `opponents` (every opponent near or far, latest turn; `incomeOf` in `gameOutlook`, the same per-player figure the side sums). Viable partner = borders the leader on this board, not at war with me (`atWarWith`: the latest agreement with it broken by either side, or a `will-attack` commitment since it), and not a truce breaker on the cross-game record (`tallies.brokenByThem` > 0; record off/unreadable/empty leaves nobody out); others go in `leftOut` (`broke-a-truce`, `at-war`, `not-bordering-leader`). `viableBy`: `now` when my income plus the partners' is strictly above the leader's estimate, else `after-break` when it is above the leader's estimate less the largest bonus it holds in full (every member visibly its own) that a partner or I border (`leaderBonuses`: per player its weakest bordered member, visible defenders, armies beside). Partners are ranked by the largest leader bonus each borders, then income, then id; the top `OUTREACH_DRAFTS` (2) get a #415 `propose` draft (`[[b:id]]`/`[[t:id]]` links, the bonus value — public — and no figure of mine; `reasons`, `priceWith: warapp_advise_diplomacy`, the coalition notes) — never sent; with WARAPP_CHAT_AUTOMATION on a draft carries `send` (warapp_send_chat's arguments, `automated: true`, confirm-gated). The grace window (`COALITION_GRACE_TURNS`, 2): `graceTurn` = the turns under the line − `SURRENDER_TURNS` + 1 (the crossing turn is 1), counted from the outlook log (`surrenderStreak`, the outlook's own `underSurrenderLine` test on the logged incomes; an earlier turn where a bonus in reach held the crossing back still counts, so the window can only end early). `inForce` = viable, `graceTurn` ≤ 2 and the leader's lead over me (its estimate − my income) not above the lead logged on the crossing turn. In force, its advice leads the warnings INSTEAD of the surrender line's; otherwise the surrender advice leads, then the coalition's line saying why (lapsed, lead grew, not viable). The surrender line's own maths is unchanged; 1v1, team games and two left: no `coalition`.
- **Commanders in the planner (#61).** A commander fights as 7 armies (bundle: attack and
  defence `+7`, dies last, no partial damage), counted in every capture cost and threat.
  My commander's territory is must-hold (never conceded; all deploys go there when the hold
  does not fit); an adjacent enemy commander is attacked before anything else spends the
  income (finishing off, triage, holds, expansion; only my commander's own hold is reserved
  first), sized for its armies + 7 + its owner's full deploy. **No vanishing:** war.app
  interleaves both players' attacks, so a strike never removes its owner's other stacks from
  this turn's threats. R3 never vetoes a strike; when what stays on my commander's territory
  after the plan's orders falls to the stacks next to it (the struck one included), `cardAdvice`
  is Order Priority when I hold one. Planned moves carry the commander only on its walk to safety (#274).
- **A player out with no AI on its seat is static (#270, `src/analysis/static-seats.ts`).** Out means
  `SurrenderAccepted`, `Booted`, `Eliminated` or `EndedByVote`; an AI plays the seat when
  `humanTurnedIntoAI`, or the game's `surrenderedTurnIntoAI` / `bootedTurnIntoAI` covers that ending,
  and then it stays an opponent. A static seat's territories stay on the board (seen live), but it
  deploys and attacks nothing, so the planner (`planTurn`'s first step, `planningInput`),
  `planEnemyEstimates`, `warapp_check_plan`'s board and replies, the border guess, the tracker and the
  outlook (`TrackGame.staticSeats`, `staticSeatsFor`) read them as neutrals — targets priced like a
  wasteland, no hold beside them, never the standing or the strike stack's direction. Never me or a
  teammate. The board cache keeps what war.app showed. #281: the planner keeps which neutrals a seat
  left (`PlanInput.vacated` → `BoardCtx.vacated`, set by `planTurn`); one costing at most
  `VACATED_MAX_COST` (3; #417 raised it from 2 to what `VACATED_FOG_ARMIES` (2) defenders cost) beside a live stack that can take it with what stands there
  (`denialOf`, `src/analysis/plan/vacated.ts`) comes either way, so rule 4d never refuses it on its hold
  cost alone, pass 3 ranks it without that hold need and credits the denial (1 + payback × the bonus
  progress it gives that opponent: it can outrank every plain capture, and a member of my uneconomic
  bonus stays eligible), and a "Take … (#281)" line says so (the live stack takes it "free" at 0, else
  "for N"). It still spends only the armies above its source's hold (#121) and is sized at its capture
  cost. The denials are judged once per plan (`denialsOf` → `Targets.denials`). **The owner's extension
  (2026-11-16):** with One Army Must Stand Guard off (not under No-Split; `balanced`/`defend`), a live
  opponent's own territory beside mine at 0 (no special unit), breaking none of its bonuses (#165) and
  not mine last turn (#276's retake) — `emptyEnemiesOf` → `Targets.emptyEnemies` — is cheap expansion:
  pass 3 tries it sized for its owner's deploy there (#120), else at its bare cost with #120's warning
  (`tryEmptyEnemy`), ranked at that size plus its frontier; rule 4d does not undo it when its new border
  faces only enemy (or hidden) territories my borders beside it already face (`sameFront`, a "Take … no
  new exposure (#281)" line), while a border to a new stack is judged as before. Never a truce's covered
  territory, a #240 repulsed one or one lowering income; the #276 second line's shortfall is kept out of
  its deploy; with the guard on nothing changes. Rule 4d's same-front exemption (and the denial's) is in
  its check (`outgrows`), so rule 4e's non-contact fallback applies it too. No #281 capture (a denial or
  an empty enemy territory) is sourced from the territory my commander walks from (#282: all that stands
  there is its transit hold, `commanderTransitFrom` / `notFromTransit`); a commander that stays keeps its
  worst-case hold through `keepOf`, as from any capture. #417: `vacated` also takes the territories fogged
  now that a seat held when last seen (`foggedLastSeen` over my whole board history, `PlanInput.foggedLastSeen` set
  in `livePlanSetup`: the newest earlier sighting; `previousBoard` only as the fallback), and in "N armies to finish" a fogged member a seat left
  counts at `VACATED_FOG_ARMIES` defenders, never above the costliest member in view (not at the seat's
  border stack), with a "… was player N's (out, no AI) … (#417)" line. Golden: 22 of 2000 synthetic plans
  changed (rationale), 3 plans' orders: +4 captures, none lost, next income and concessions unchanged.
  **The breach force (#417, owner decision of 2026-11-20):** a vacated territory beside mine whose armies the fog
  hides (`fogVacated`: owner hidden, or the seat's own shown without armies; never one the fog shows a live player
  holding) is a target at `VACATED_FOG_ARMIES` defenders (`defenceAt` reads it so, a "… is fogged and was player N's …
  (#417)" line) instead of the fog's "no attack is planned"; pass 3 takes vacated land outside a negative bonus even
  as a member of an uneconomic bonus (`plainEligible`); and rule 6 (and #125's staging) keeps every idle army on a
  territory beside vacated land still untaken and cheap (`breachOf`: fogged, or costing at most `VACATED_MAX_COST`;
  a "Keep … the breach force beside … (#417)" line) until it is taken. Golden: 10 of 6253 plans changed, 2 in their
  orders (a move's reason only); captures, next income and concessions unchanged.
- **A held bonus's hub is worth more than its +V (#593, item 1; `hubsAt` in `src/analysis/plan/orders.ts`).** A member of
  a positive bonus I hold in full with at least `HUB_MIN_MEMBERS` (4) members that borders at least `HUB_DEGREE` (0.75) of
  the other members protects `HUB_WEIGHT` (0.6) × the bonus's value on top of the bonus (`protectedValue`): on 16 lost 1v1s'
  history boards such a member's fall took 78% of the rest by the next turn (the whole bonus 6 of 9; every hub bordering
  all), a member bordering < 50% took 20% (never the whole bonus), and no lost member was ever retaken (0 of 48); 0.6 is
  that excess (owner, 2026-11-27). Rule 1h's unit worth (and #235's FFA joint-sizing judge) adds it once per bonus whatever
  number of its hubs are threatened (`hubWorthOf`); a conceded unit's members lose it with the bonus (`residual`); a
  rationale line names it ("… borders N of bonus …'s M other members: its fall takes the rest … (#593)"). Never
  double-counted: #235's cut counts bonuses wholly cut off and #275's breach and #291's opens bonuses not containing the
  territory, so none counts its own bonus. It lifts a hold only in the band rule 1a's `CONCEDE_FACTOR` × worth decides (the
  Brazil case: needs 15 on an income of 17, protects +4 → +6.4): a hold above the income stays conceded. Owner decisions of
  2026-11-27: a unit that pays only for its hub share is funded first like any other, even when that postpones a larger
  completion (rule 1h.3's starve check unchanged: on the replay one turn's next income fell 19 → 15, accepted); a bonus
  completed this turn has hubs too once rule 1c counts the captures. A unit that pays only for its hub share (`hubOnly`:
  without it the CONCEDE_FACTOR test would make it contested) gets #118's floor before the captures like a contested one,
  and is floored and kept, never conceded with nothing deployed, when it then cannot be held whole (owner, 2026-11-27:
  on the replay one such turn was conceded where main floored it). #602 (owner, 2026-11-27): rule 1h.3's starve check no longer counts a
  `hubOnly` unit already floored (it keeps its floor either way, so a completion cannot starve it): the completions it
  held back go ahead. Golden: 0 of 6253 plans changed; on #600's game-12 shape swept over bonus values, incomes and
  deploys, 35 plans changed, each completing more (next income +2 to +9), none conceding more. #122's garrison of a completed bonus is unchanged.
  Golden: 55 of 6253 plans changed, 4 in their orders (the leftover or a held unit's deploys moved to a hub), captures,
  next income and concessions unchanged on all.
- **Rule 6 behind conceded borders (owner, 2026-11-22).** With no front and no territory not mine reachable without
  crossing a border the plan concedes (the last neutral taken, the enemy past those borders: golden s246, the gap #426
  exposed), rule 6 had no target and its idle stacks stood deep inside. `distBehind` (`plan/transfers.ts`) now walks
  them up behind the conceded borders on the way to the enemy (`distEnemyThrough`) — never into one, never into a
  territory an attack leaves from this turn or one beside a rival at the start of the turn (golden s1405: a step into
  the source of the strike that ends a player took its first-order slot) — and a stack beside one waits there (#367),
  with a "… walk up behind X, past which lies Y …" reason. Golden: 142 of 6253 plans gain 475 interior transfers; no
  attack, deploy or capture changes.
- **No-loss neutral captures (#426, owner decisions of 2026-11-22).** A neutral in view whose
  defenders kill none of my attackers (`noLossNeutral`, `plan/after-leftover.ts`: 0 armies at the usual 70%; never a
  negative bonus's member) costs only the armies that land on it — the owner's definition of a free capture. (1) Pass 3
  (and rule 5b) take one even as a member of a bonus too costly to finish (`plainEligible`; the reason says "a no-loss
  capture … (#426)"), so it is planned before the leftover's comfort margins. (2) Rule 4d's `outgrows` lets one through,
  outside a 1v1, when only the fog faces its new border (no foe territory beside it shown with its armies;
  `fogOnlyFaces`) and the hold it adds next turn is at most 1× the next income (the owner's cap; over it 4d decides as
  before), with a "Take … (#426)" line. (3) A warning (`warnIdleBesideFree`, `plan/free-capture.ts`, report only) names
  a stack of mine, not my commander's, idle last turn and again this plan beside such a neutral its own movable armies
  take. Not done (owner): "the leftover rides the widest capture". Follow-up: rule 6 has no step when the only enemy
  front lies past a conceded border and the last neutral is taken (golden s246: its interior transfers vanish).
  Golden: 16 of 6253 plans changed — 6 in their orders, 2 in a move's reason only, 8 by the warning only.
- **The bait note (#593 item 5c, `baitNote` in `src/analysis/plan/report.ts`).** A "Not attacking" reason that says a
  neighbour of mine could spare enough for an enemy territory (the cheap-looking ones) adds what that territory's owner's
  stacks beside it can move in before an attack lands (each less its guard, in view only) and what taking it costs
  then: "; its stacks beside it can move K in before an attack lands (…): N to take it then (#593)". Rationale only:
  golden 99 of 6253 plans changed, none in deploys, moves or warnings. The same bait is `warapp_check_plan`'s `gather`
  reply and the submit preview's "Possible bait" warning (`src/tools/bait.ts`).
- **No advance into a bonus the plan concedes (#593 item 4, `src/analysis/plan/dead-advance.ts`).** An expansion capture
  (`tryExpand` in `plan/captures.ts`: pass 2's advances, the `balanced` greedy's advance slots, pass 3, #439's stage,
  rule 5b) is refused (`deadAdvanceOf`) when every positive bonus its territory is in has another member I hold that
  this plan concedes and the capture completes none of them; its armies and deploy stay for the next candidate, with a
  "Do not take X toward bonus B: this plan concedes its member Y … (#593)" line. Exempt: a focused territory, a no-loss
  capture (#426), land a static seat left, a step of a bonus this turn's captures could complete (every missing member a
  target: #214's step order must not block the completion), and a capture every attack on which leaves a conceded
  border with no deploy (armies given up anyway). Concessions come during the greedy too (#215's pending holds), so the
  finished plan is checked (`ps.expanded`): a kept capture into such a bonus, or a completable one left incomplete,
  makes `planTurn` plan again with those bonuses carried (`PlanInput.deadAdvance`, `planAlive`, at most `DEAD_PASSES`
  (3)), refused from the start whatever the replan concedes. Rule 4e's never-stand-still fallback and #272's attack out
  of a conceded border are not bound. Item 4's wasteland half needed no change: a wasteland in view, or fogged and
  costed by its last sighting (#428) or the picking board (#201), already counts at its full cost in "N armies to
  finish", the economy test (its loss, #125) and rule 4f; only a fogged member never seen counts at the neutral size
  plus #167's expected surcharge. **The owner's exception (2026-11-27):** an advance that breaks the bonus for the foe
  attacking a conceded member is allowed (`breaksForAttacker`): the capture takes that attacker's own member of the
  bonus, or a neutral that is the one member he would still lack once my conceded members fall. Golden (with the
  exception): 48 of 6253 plans changed against main, 45 in their orders, next income unchanged on all (as built without
  it: 69 plans, captures +3/−58; the exception restores 22 attacks in 22 plans). A replay of 16 lost 1v1s (271 turns): advances with a conceded sibling 38 → 3
  (all from conceded sources), 17 → 0 on truly-behind turns; next income unchanged on every turn.
- **#433/#427 (partial, 2026-11-20).** Local Deployment's free income floors at the game's own base income (`gameBase` in `plan/threats.ts`), not 5; the profile's standing reads my income without my own Reinforcement card (`plan/estimates.ts`), as it already did opponents'. Golden: 159 of 2000 synthetic plans and 4 suite plans re-hashed (the rest of #427 is open). **#433's gate budget (2026-11-22, DRAFT for owner approval):** under Local Deployment the 1v1 gate budget (#297) is pool-aware — a gate's shortfall is paid only by the free income and the pools of the bonuses it is in (`poolShortfall` in `src/analysis/local-deploy.ts`, over `chargeDeploys`; next turn's pools from `keptHeld`, the territories `keptIncome` counts), in `gateStop` (`plan/captures.ts`; rule 4d's `outgrows` lets it stop a capture even when the frontier's hold cost is under the whole next income) and in the reported `gates` (`short`, plus `deployable`: the income that can land on the gates; LD only). Without Local Deployment nothing changes. Golden: 506 of 6253 plans re-hashed (467 only `gates.deployable` added, 37 a gate-budget warning too, 2 in their orders: one capture each stopped, next income and concessions unchanged). Still open from #433: `reviveConceded` counting idle neighbours when a withdrawal is planned (an owner decision: cancelling a withdrawal once the deploys are sized).
- **#427 (parts 1–2 merged in #491; part 3 2026-11-22).** (1) Bug: the tracker reads every deploy as income, so an opponent's
  Reinforcement play it saw set its tracked figure (max observed, then carried) while the clock added the next card
  on top: one card counted twice, every turn. `enemyDeployEstimates` now reads the figure again with each counted
  play's card armies out when only card plays set it (`EnemyDeployEstimate.cardInTrack`, a "… counts the
  Reinforcement card it played on turn N: M without it (#427)" warning; `hiddenPool` uses the same figure). Golden: 0
  of 4653 plans changed. (2) Rule: `opponentReinforcement` runs the opponents' clock at the expected weighted rate
  (minimum plus the weighted share of the random pieces), not the fastest; identical wherever no piece is drawn at
  random. (3) Seen plays: in a game with `CardPlayingsFogged` false (`reinforcementPlaysShown`), the LatestGameInfo's
  last `GameTurn` (the turn just resolved) shows every Reinforcement play, whoever made it — **VERIFIED live
  2026-11-22** (read-only GetLatestGameInfo on three games in progress with card plays unfogged): the GameTurn is
  { null, the order list, int32 turn 0-based (one less than the turns completed), a date }; a play there is
  `GameOrderPlayCardReinforcement` { card GUID, player (in-game id), its result (pointing back at the order), null },
  no armies; an opponent's play showed with none of its deploys in view (docs/WEB-PROTOCOL.md "The last turn's
  orders"). `readTurnReinforcementPlays` (src/cards.ts) reads it, `lastTurnPlays` (card-advice.ts) takes it only
  for turn − 1, by GameFeed id; warapp_plan_turn keeps each turn's plays beside the boards (`seenPlays`,
  `writeSeenPlays`, src/trend.ts; an empty list = read, no play), and `PlanGameContext.reinforcementPlays` carries
  them (`seenReinforcementPlays`) to `enemyDeployEstimates`: a seen play always counts and restarts that player's
  clock (the next card due its capturing turns after it; never again where only one card comes), a read turn with
  no play is no play whatever its deploy looked like (in the clock and in `cardInTrack`), and the plan says the
  play was seen (`cardSeen`). With card plays fogged nothing is read or kept. Golden: 0 of 6253 plans changed (no
  corpus input carries seen plays).
- **Threat model.** Enemy income is unseen, so the planner estimates each opponent's deploy
  separately: base income + the bonuses it visibly holds in full, never below the game's base
  income (at least 5) (`enemyDeploy` / `enemy_deploy` overrides all of them). Its stack next to
  me is no part of the estimate: a stack says what can move, not what can be deployed (capping
  the figure at 0.75 × a small stack read a visible +10 holder as 5; guessing 0.75 × a 15-stack
  on the opening board read every base-income opponent as ~11). On the opening board (every visible
  player territory holds the same count; neutrals aside, and only on the first turn: no previous
  board and the turn unknown or 1, #128) every opponent gets that floor.
  The threat at a border (#128, `forceAt`) is the larger of one attack of a player's stacks plus
  its deploy and the single attack equal to its stacks attacking separately (each rounds on its
  own); opponents on one team combine, FFA players do not (a warning when two together could take
  a border; when I lead an FFA (#201) every adjacent opponent combines, but only while that hold pays —
  a border whose joint hold fails rule 1a's tests while its hold against the strongest single opponent
  passes is sized for that opponent, never conceded on the two together, #235; a held bonus is judged whole: its
  members are sized so when its joint unit costs more than the income and its single-opponent unit pays, and a
  bonus funded neither so nor whole up front leaves each member the per-border test on its value without that
  bonus — the judgement it gets with no bonus); teammates are never a threat or a target; under Local Deployment (#293, `enemyDeployReaching` in
  `src/analysis/local-deploy.ts`, one bound for the planner's `deployReaching` and `warapp_check_plan`'s
  replies) a border faces the opponent's free income (base, never below the floor, plus a Reinforcement
  card: `freeIncome`) plus the pools of the bonuses it could hold (`couldHoldBonusPools`: no member shown
  with another owner, fogged ones included) that contain its stacks there, never above the estimate: a
  tracked total or prior above that never lands on one border; the same bounds an untrusted figure (#275).
  Only with per-territory income (`BonusArmyPer`; check_plan's `perTerritoryIncome`) does what the estimate
  holds beyond every bonus it could hold together count as free too (per-territory income in the fog may
  land anywhere), and a warning says so whenever that slack is used. A next-turn judgement (`nextTurnAt`: R3's defensibility, rule 4d's frontier
  cost, `exposure`) also adds its visible stacks one step behind its front (beside a stack next to the
  border, not next to it), which can walk up this turn, and their pools. In the observed deploy
  (`ObserveContext.localFree`, planner and tracker alike: `localFreeOn`, base plus a Reinforcement card the
  clock lets it hold on the turn read — the planner's game clock, else `PlannerSettings.opponentReinforcement`,
  a fixed card from `plannerSettings`), growth beside the fog on a territory in no bonus it could hold on the
  earlier board is a walk only as far as a neighbour in view's shrink is left once the captures and the other
  grown stacks have claimed theirs (one claim pass: a shrink never offsets a capture and a walk both), and
  deploy only up to its free income (shared), the rest a move out of the fog (`localCut`, named in the
  rationale). A warning
  states each estimate and its basis. With a previous board, each opponent's deploy is also
  *observed* (`observedDeploy`, #57): the *net* change of its armies on territories visible
  both times (shrinks included — a transfer between its own territories is not deploy; counting
  only growth once read a 30-army back-line move as +35 and conceded a bonus), where a territory
  it captured from a player or a visible neutral counts its armies now plus the previous owner's
  armies there, floored at 0 (losses in an attack it did not win are not counted — the
  defender's own orders hide them). **A fog reveal is not income (#69):** a territory counts
  only when last turn's board showed both its owner and its armies (`visibleState`: not owner
  `unknown`, not `null` armies, not fog level `Fogged`/`OwnerOnly`/`3`/`4`) — live, fog lifting
  over existing stacks read as +119 and conceded six held-bonus borders. The observed figure is
  capped at base + every bonus none of whose territories someone else visibly holds (a warning
  says when; #226: with per-territory income the base counts every territory it could hold — its
  visible ones and every one whose owner is hidden — and a reveal whose armies exceed its estimate
  is named in a warning, still not income), and a rationale line names the turns compared and the
  reveals skipped. #226: given my orders on the previous turn (`PlanInput.previousOrders`, from the
  cached orders), the defenders my failed attack killed on a territory that stayed its count back
  into its growth there (`failedAttackKills`, shared with `measureOrders`; within #123's bound
  beside the fog). The
  estimate is max(visible-bonus figure, observed)
  and the warning names the source ("observed +N/turn" vs "base + visible bonuses"). **The fog
  prior (#119):** in a 1v1 or (#226) a free-for-all that started even (no teams; #368: a player out
  whose seat no AI plays no longer turns it off — its share of what the board hides is split among the
  opponents still playing, `EnemyIncomePrior.out`, and the warning names it; `PlanGameContext.symmetricStart`, set by
  `warapp_plan_turn` from `symmetricStart(settings)`: any distribution but a custom scenario —
  DistributionMode -3 or a `CustomScenario` setting; #235: a map's "scenario" distribution only says
  where each player starts, and the client gives every player the same count at the same armies),
  every opponent bordering the fog is estimated at least at my own income (card armies out) — or, on
  turns 1–4 when the award of picks proved all its starts, at the income the pick advisor's opening
  simulation gives it from them when that is larger (`openingIncome`, `PlanGameContext.opening`, #166) — capped
  at what it could earn on the board (#235: in a free-for-all at an even share, 1 of its opponents, of
  the territories the board hides and of the bonuses it could still hold, its own in full), and the
  warning calls it a prior — every observed figure is
  a lower bound under fog, and without it a finished game's true deploys read 2–3× low. #235: the
  prior shrinks with evidence: with a usable track it keeps `PRIOR_EVIDENCE_TURNS` (4) / (4 + the sum,
  over its consecutive observed turns up to the newest board — a run that stopped earlier counts none —,
  of each turn's frontier coverage, #294) of its lead over the tracked figure (or the visible one, when
  larger; `priorBlend`; the warning names both figures; a turn built by hand without a coverage counts the
  visible share of its edge on this board). This applies in a 1v1 too,
  pulling #119's prior back toward the tracked figures #119 found 2–3× low (8 turns with the whole
  frontier read keep a third of the gap): `PRIOR_EVIDENCE_TURNS` is unmeasured, not yet checked
  against a finished 1v1. #420 (`priorOnlyHold`, `plan/holds.ts`): a single-border hold under `balanced` that
  only the prior makes needed (no usable track; the border holds against its one opponent's stacks plus
  base + visible bonuses / an observed deploy / a clock card; plain borders only) ranks after every capture
  in rule 4a's greedy step, with a "(#420)" line when it passed one; held-bonus units and evidence-sized holds keep their rank. **The total hold cap (#420, owner decision of 2026-11-20, `holdCapOf` in `plan/holds.ts`):** plain holds take at
  most `HOLD_CAP_EVEN` (50%) of my income when even or ahead, `HOLD_CAP_BEHIND` (70%) when the profile reads me behind
  (rounded down); a held bonus's own gate (rule 1h's units, `hold(m, true)`) and my commander's hold are funded first,
  outside it, and count nothing. A plain hold past it (rule 1a's `defend` triage, rule 4a's greedy hold, `singleNow` /
  `singleLate`, a deferred hold) is conceded with "… cannot be held within the hold cap (#420: …): conceded"; rule 4a's
  hold-and-break runs before the check, as a capture, and counts toward it. The leftover's revival ("Hold … after
  all") can still hold a capped border with what the captures leave; a strike stack takes it instead when the leftover
  builds one. Off under a `defend` goal the caller gave and with `PlanOptions.holdCap: false` (the tests of earlier hold
  rules use it). Golden: 67 of 6253 plans, 47 in their orders: captures +25/−3, next income up on 7 and lower on none,
  45 more concessions and 1 fewer. **Frontier coverage (#294).** Each observed turn carries `coverage`
  (`frontierCoverage`, pure, in `src/analysis/plan/shared.ts`): its territories in view with a neighbour
  not its own, plus every territory beside them whose owner is hidden (it could hold it: the "~M"), read
  when in view with armies on both boards, and the positive bonuses it could hold with a hidden member;
  the track (`OpponentTrack.coverage`, `trackCoverage` over the income window: Σ read ÷ Σ frontier) and
  the estimate (`EnemyDeployEstimate.coverage`) carry it, warapp_track_opponents shows it, and the tracked
  warning says "read from N of ~M frontier territories (P%)". **Thin evidence (#368, `thinEvidence`; owner
  decision of 2026-11-19: on a hidden opponent choose the middle until we learn otherwise — it replaced
  #294's floor of tracked × 1.5):** with a usable track, while its
  coverage is under `LOW_COVERAGE` (0.5, unmeasured) the estimate is sized between a lower bound (the most of
  its visible income, the tracked figure and — when its tracked figure rose two turns running,
  `risingTracked`: the most it earned over a turn and the two before it, as of each of its last three
  consecutive observed turns — the trend's next step, the newest figure plus the mean rise of the two
  steps; #418: no step when my armies on the board are above its in view and my board income above its tracked figure, or — with `LEAD_ARMIES` × its armies in view — above what it earned before the newest rise, so an over-read tracked figure does not switch the gate off; that judgement with a bare army lead moved 3 of 4 changed calibration samples further below truth) and an upper bound (the fog prior whole, not `priorBlend`'s shrink, else the most it could earn):
  the midpoint (rounded up) with none of its frontier read, moving to what the evidence gives without thin
  evidence (`toward`: the track, or `priorBlend`) as the coverage nears `LOW_COVERAGE` — `toward` + (1 −
  coverage ÷ 0.5) × (midpoint − `toward`) — so it never jumps at 0.5; up or down, never the maximum. A
  rising track read from more of its frontier only raises the estimate to the lower bound. Its own warning
  names both bounds, the midpoint and `toward`; the source reads `prior` when a prior is in the range and
  the figure lies above the lower bound, else `tracked`; the tracker's coverage note says the planner sizes
  it toward the midpoint. **#419 (owner decision of 2026-11-20): the past winners' pace tops that range.** With
  the fog prior on, thin evidence's upper bound is the larger of the prior (my income) and the pace past winners
  set after the turns completed (`FogPace`, `PlanGameContext.mapPace` → `EnemyIncomePrior.winnerPace`; capped, scaled
  by #444 and only beside the fog as the prior is; it never moves the prior or `priorBlend`): `fogPaceFor`
  (`src/tools/past-games.ts`, in `livePlanSetup` and `stressOpponents`' callers, so check_plan and the commander
  check read it too) gives this map's median winner over its games of this format and settings (`mapPaceAt`,
  `MIN_PACE_GAMES` (3) or more), else my income × the median winner ÷ mine over every map's games of the format
  (`formatPaceAt`), else none; the warning names the basis (`thinEvidence.pace`). Measured leave-one-out on the
  calibration inputs (every record so far a loss): 27 of 164 plan estimates rose, 19 closer to truth, geoMean
  0.600 → 0.609, over-1.5 share unchanged; golden unchanged (no input carries a pace). **A known income (#368,
  `PlanInput.knownIncome`, warapp_plan_turn's and warapp_check_plan's `known_income`, by GameFeed id)**
  replaces that opponent's estimate (`applyKnown`, after Sanctions and the army price; a Reinforcement card
  the clock adds stays on top; `EnemyDeployEstimate.known`), with a warning; `enemy_deploy` wins over it,
  one for a player with nothing in view is named unused, the tripwire keeps the board's own estimates, and
  the commander check (plan block, check_plan's `commander`, the submit) keeps its sizing; check_plan's
  stress test tries it (`enemyDeploy` source `known_income`) before an untrusted mark. **Stated incomes
  scale the others (#444, `EnemyIncomePrior.stated`, `statedScale`):** the known incomes of players in view
  whose mean is below my income scale every other opponent's fog prior by that ratio (rounded up; never
  above the prior; the #123 bound keeps the unscaled one); a tracked one keeps its track as the floor
  (thin evidence's upper bound is the scaled prior), an untracked one is sized at #368's midpoint between
  its visible/observed figure and the scaled prior (`EnemyDeployEstimate.stated`); a warning names it;
  check_plan passes them through `stressOpponents`. #567 (reporting only): a warning in plan_turn and check_plan names every opponent a known income moved this way, with its estimate before and after (`statedShifts` / `statedShiftWarning`; `statedScaled` on check_plan's `enemyDeploy` and plan_turn's `enemyDeployDetail`), and a track whose income window holds a turn whose low end (at most its cap) is above the income held carries `observedLow` (`observedLowOf`; track_opponents' `income.observedLow`, the same entries) and a warning; neither changes an estimate (golden byte-identical). #567 (owner decision 2026-11-25): a known income carries `source` (`KnownIncome`): `board` (the default for an explicit `known_income`: a what-if or board evidence) replaces only that player's estimate; `chat` (warapp_record_intel's stored incomes, or `source: "chat"`) also feeds the scale, which now needs `MIN_STATED_PLAYERS` (2) chat-stated players in view and scales by `stated.scale` = (mean ÷ mine)^`STATED_DAMPING` (0.5; `stated.ratio` stays the plain ratio): offline, on 13 finished FFAs' true incomes, the full ratio set the others' prior far below their truth. Golden: 0 of 6253 changed. #568 (owner decision 2026-11-27: ship at 0.5 and keep collecting data): a usable track's tracked figure is divided by its frontier coverage band's past estimate ÷ truth (`trackCalibrationFor`: this format's own bands of #436's lessons, none in a 1v1 — a lost 1v1 of 2026-11-27, DRAFT for owner approval: there the fog prior already lifts the tracker, the plan's estimates ran 1.13× the truth over 52 logged 1v1 samples against ~0.5× in free-for-alls and team games, and the factor read one opponent at 26 against a true 17; `PlanGameContext.trackCalibration`, set by livePlanSetup, check_plan and the commander check; the outlook keeps `outlookCalibrationFor`) to `TRACK_CALIBRATION_DAMPING` (0.5) — `trackCalibrationFactor`: at least 5 samples, a band under 1× only — never above what it could earn, before priorBlend and thin evidence (`EnemyDeployEstimate.trackCalibration`, a warning; the #123 bound and the rationale keep the tracker's own figure). Golden: 0 of 6253 changed (no input carries it); with the 2026-11-24 baseline bands injected, 118 plans changed, 21 in their orders. Each observed
  deploy also carries `stacks` (`DeployObservation`): every stack of the opponent held in view on both
  boards that grew, its growth split into what a neighbour in view of its own visibly sent (each shrink
  claimed once, first by the stacks with no hidden neighbour, whose rest can only be deploy, then by those
  beside the fog, each in id order), then what could have come out of the fog (beside a hidden territory) or can
  only be deploy; the plan's rationale has one "growth by stack" line per opponent. A
  free-for-all with no teams that gets no prior says why (`PlanGameContext.unevenStart`; a player out is
  never listed among the opponents beside the fog). The newest observed turn
  never lifts a usable track (#235 1c): a stack walking in beside the fog is not income (#123 lesson
  5). When the track ends on this board and #123's bound (twice what it carried before that turn,
  `ObservedTurn.expected`; never the prior) cut armies beside the fog on its newest turn, a warning
  labels the cut reading — "reads up to +N if the armies that arrived beside the fog were deploys …;
  the estimate keeps ~T (tracked) because a stack walking in is not income" — and suggests
  `warapp_check_plan`'s `enemy_deploy` to test it (`EnemyDeployEstimate.newestCut`); the planner reads
  that turn with the track's own bound, so its observed line agrees with the track. **One border per
  opponent takes its whole deploy (#420, owner decision of 2026-11-20):** the opponent picks where to
  land, but deploys its income in one place, so only its single most valuable border of mine (protected
  value, then its movable armies beside it, then id) is sized for its whole deploy; each of its other
  borders of mine is sized at its stacks beside it plus its largest top-up seen — `OpponentTrack.topUp`, the
  most one of its stacks beside my land grew in one turn (`borderTopUp`, `ObservedTurn.topUp`; live boards
  only, never a GameFeed history board) — never above the whole deploy (`oneBorder` in `plan/threats.ts`,
  read by `forceAt`; a "Player N deploys its ~D in one place (#420)" line). Not without a top-up seen (no
  track: every border keeps the whole deploy), under `enemyDeploy`, on my commander's territory, for an
  untrusted estimate (#275) there, or for an opponent beside a single border of mine. Golden: 49 of 6253
  plans changed, 16 in their orders (captures +3/−7, next income unchanged on all, concessions 6 fewer
  and 3 more). **#603 (DRAFT, owner approval pending; the self-play arena):** the top-up is a maximum, so once an
  opponent had dumped its whole income on one stack every other border stayed sized for nearly its whole deploy
  and the holds took every army; now each border other than the most valuable one is sized at the stacks beside it
  alone (a quiet neighbour keeps its top-up on every border; `PlanOptions.experiments: ['legacy-topup']` restores
  the old sizing for research). Arena (fog): today's planner 10 of 20 against the spreader bot, this 19 of 20; this
  against today's planner 22 to 8 (30 games), 10 to 10 without fog. Golden: 147 of 6253 plans changed, 49 in
  their orders, attack targets +7/−3, concessions fewer in 18 plans and more in 2. **The full-deploy border is revived first** (review fix, `fullConceded` in `plan/leftover.ts`,
  read through `Threats.oneBorder`): a top-up of 0 sizes a guard-only stack's other borders at no threat, so
  no border was short of its margin, the leftover's revival ("Hold … after all") did not run and the leftover
  went to a border nothing threatens while the most valuable one stayed conceded. When an opponent's
  full-deploy border is conceded while a border of its takes only the top-up, the revival runs for that
  border alone (every conceded border, as before, when some border is short). Golden: 20 of 6253 plans
  changed, 19 in their orders: captures +1/−0, next income unchanged on all, concessions 14 fewer and 1 more
  (a border held by transfers after the leftover lost them to the revived full-deploy border).
  With a previous board (`previousBoard`), an adjacent enemy stack that grew raises that
  border's threat to movable + max(that opponent's deploy, growth). `warapp_plan_turn` gets it from
  `<dataDir>/boards/<gameId>.json` first — the verified live boards written after each plan or
  track (newest ten turns kept, so re-planning a turn keeps the trend and opponent tracking has a
  history) — and from GameFeed `GetHistory` (unverified in progress, parsed loosely in
  `src/trend.ts`) only for turns the cache lacks, not at all when the two previous turns are
  cached; it reports `trendSource`. A board the decoder refuses is never written there. Each
  write keeps the game's settings beside it (`<dataDir>/games/<gameId>.json`, see "Offline replay").
- **Surviving a wrong estimate (#275, pattern 1).** An estimate is a floor. `src/analysis/headroom.ts`
  (pure; `headroomTable`) gives, for every border of mine after my orders, the smallest single deploy on a
  neighbouring enemy stack that takes it (turn simulator, both move orders unless known; the attack is tried
  at every place in the zigzag the opponent can reach by holding it back behind filler orders — before my
  first order, between two, after my last — so a border my later orders drain is judged as drained; a commander walk of the plan's goes with its move, as
  in warapp_check_plan's table on the same orders; #618: in warapp_check_plan and the submit preview my Airlifts land
  before the moves, as the stress test carries them out, and the guard-off empty-border warning counts them too), the
  bonuses it breaks and the bonus income one step behind; `warapp_plan_turn` and `warapp_check_plan` return it as
  `headroom` (`headroomView`, `src/tools/survival.ts`; #306: each row flags `belowMyIncome` and, against that opponent's
  own deploy estimate, `belowOpponentEstimate` with `opponentEstimate` — for a leader my income flags every row; the
  compact view lists the rows that protect something first — a held bonus, bonus income behind, a breach's income,
  `protectsSomething` — each part weakest first, so bare 1-army tiles at 0 no longer crowd out the gates), and `warapp_submit_turn` warns (never refuses) when a held bonus's border falls to less than
  my income. A static seat (#270, `staticSeats`) gets no row: its territories are neutrals there, as the
  planner reads them (`HeadroomInput.staticSeats`; the hold diff below takes the same). Its figure is not
  #268's "falls to a deploy of less than ~D" line: that one is the planner's threat arithmetic on the
  deploys before any move (the border's take less the stacks beside it), this one carries out the whole
  turn, so the two may differ for one border, and the #268 line says so. `src/analysis/tripwire.ts` (pure) reads my two latest boards: a stack out of the fog, a capture,
  or an attack of mine held, needing `TRIP_RATIO` (1.5) × what the estimate allowed (and `TRIP_MIN_EXCESS`
  more), marks that opponent untrusted (a stack no board ever showed is credited its whole start, from the
  settings, and is not read when they do not give it or the start was not even — `symmetricStart`: a custom scenario sets each start by hand —; with the start known a stack out of the fog is credited its armies in view that
  left or shrank within reach since — a walk-in is not income, #123 lesson 5; every drop between two sightings
  of a territory counts, and the drop from the latest to now, each within reach from the earlier sighting — and
  is never below its whole stock (every start plus each turn's estimate) less its armies in
  view elsewhere now, so armies banked under the fog since early on do not trip it; with the start unknown a drop
  in view is net (a stack may walk in while another fills in behind it), so it is bounded by every army that could
  reach it (`reachBound`: from a board with every territory within reach in view, what stood there, its movable
  armies within reach and its estimates since, boards chained for the least), and not read when no such chain
  exists (a territory within reach hidden on the turn a stack passed it, or a board missing from the cache); with
  Gift in play a stack on a territory last seen another player's is not read, nor, with a third player in the game
  (`players`, from `readTripwires`), one on a territory no board showed its own (never seen, last seen neutral); the
  stock counts as known only when every turn's estimate was kept (`estimateKept`): a turn not kept stands in at the
  most the opponent was kept at or is now (`estimateAt`), which may still under-count one whose estimate a bonus
  break lowered, so then the stack is read as with the start unknown (a stack no board showed is not read); an opponent commander counts as 7 on
  the target of a held attack and on its stacks beside a capture or a held attack; a board from GameFeed history (`source: 'history'`) is no
  sighting and no previous board — the opponent-profile observer skips them too; a held attack is not read from a
  source another stack beside it could have hit first, or that ended below what my orders left it, nor from one
  that lost nothing (at or above that plus what the attack sent: a failed attack on a defender always costs
  attackers, so it never ran — a Diplomacy card, or orders withdrawn in the web client), counts only
  what the source had left after its earlier orders — an order sends what is left —, and is not read from a
  Transfer Only order or on a player a Diplomacy card in force keeps at peace, nor at all once anyone may have held
  a Diplomacy card on the turn it ran (the cards in effect now do not say what was in force then); my orders count as known only with
  `sent`, an older cache as unknown, and a Transfer Only, Attack Only or percentage order — in `sent`, left out
  of `moves` — out of my territory, into the neutral or out of my attack's source means that one is not read;
  and they count only when the board agrees they ran, `ordersLanded`, one check for the capture and the held
  attack: every territory of mine that stayed mine with only mine and neutrals in view beside it, no card play or
  order outside `moves` on it and only transfers out into territories that stayed mine ends at what it had plus my
  deploys less what went out plus what came in — up to what an order sends from a source that may have been hit
  first — and at least one such territory exists, and every territory of mine on both boards, borders included,
  ends at most at what it had plus my deploys there plus what my orders in could send, less what its transfers
  out into territories mine on both boards sent (none with an order out outside `moves`), every territory newly
  mine at most at what my orders in could send, and every neutral in view beside only mine at least at what it
  had less what my cached attacks into it could kill, so orders changed in the web client after the cache — a
  deploy that never landed, a transfer dropped or rerouted between borders, an attack added — read nothing; a
  capture of mine never counts a cached deploy on the territory lost (the board cannot confirm it), nor is read
  beside a neutral that shrank with no attack of mine cached into it (a failed attack added out of the lost
  territory into its taker's own territory is the one edit no board shows), and a held attack is not read when its source
  lost fewer than the defenders it needed kill — every attacker, or round(defensive kill rate × defenders) —
  since the attack that ran was smaller; a capture is read with no luck and straight rounding only, as a held attack is)
  for `UNTRUSTED_TURNS` (3).
  Under Multi-Attack, or when the settings do not say, a chain moves armies many hops in one turn: no capture
  or held attack is read, and a stack out of the fog credits armies that left view at any distance. Nothing is
  read once an opponent may hold an Airlift card (the card clock, `opponentCanHold`): armies it lands look like
  income; a Reinforcement card is already in the estimate (#164), one at most, so a capture or a held attack also
  allows every card the clock says an opponent can hold (at most `MaxCardsHold`) when that is more than one
  (`bankedReinforcement`: banked cards played at once), and neither is read when those cannot be counted
  (pieces a turn unstated, armies not fixed); so does a stack out of the fog with its start unknown (with it known,
  its stock credits a card every turn), likewise not read when they cannot be counted. No capture or held attack is read once one
  may hold a Bomb (it runs before the attacks and halves my source or the territory taken; a stack out of the fog
  still is). A territory my own Gift card gave it (`MyOrders.cards`) is no capture, and with my card plays not
  recorded (an older cache) no capture of mine is read when Gift is in play (`gift`: the settings list it, or
  are unread), nor a stack out of the fog on a territory last seen another player's (it may have been gifted
  with its stack). Another player's armies are never its: no held attack is read with any player but it beside the
  target (a teammate may have sent armies in), and no fog stack of a player with a teammate. A static seat
  (#270) is never read, nor a player with no estimate now (never compared against 0). Nothing is read either while `resolveTeams`
  says the teams are unknown (`known: false`): an opponent may be a teammate, and the stored marks are applied
  to nothing but kept unchanged (`TripwireRead.keep`: one such call never erases a running mark); `headroom` rows then carry
  `mayBeTeammate: true` and `warapp_submit_turn`'s headroom warning says so. The marks and each turn's per-opponent
  estimates live in the board cache file (`estimates`, `tripwires`, ids only; `readSurvival`/`writeSurvival`
  in `src/trend.ts`, kept by every cache writer; the newest `SURVIVAL_TURNS` (200) turns of estimates, not
  the boards' ten, since the stock reads every turn's), written by `warapp_plan_turn` only. While untrusted, the
  planner sizes borders of bonuses held in full at the start for max(estimate, the figure) where the figure
  is max(implied, my income) (`PlanInput.untrusted`, forceAt; not under `enemyDeploy`; under Local Deployment that
  figure is bounded like the estimate, by where the pools it could hold can land (#293, `deployReaching`), as
  `warapp_check_plan` bounds it; the guard-off breach price, `breachAt`, sizes the stack
  that would come through on the same figure; a held bonus contested on that sizing, #118, whose border faces it
  is held whole before any capture when what is left covers it, `settleContested('untrusted')`, so no expansion
  goes ahead of the gate — and one it cannot cover, or one triage conceded beside that opponent's stack, gets
  everything left to deploy before any capture and is not conceded (`fillUntrustedGates`, a warning names the deploy
  that still takes it) — unless the stacks beside it take it with no deploy at all and what is left cannot make it
  need some (`firstStand`): that one stays conceded and the armies stay behind it; the game profile compares it at its figure and never reads `even` while the mark runs),
  the border guess skips an untrusted opponent
  (`borderGuess`' `untrusted`, reason `untrusted`: a split drawn from the estimate would undo it), `warapp_check_plan`
  tries that figure by default (source `untrusted`), and both say so in the first warning (under `enemy_deploy`
  `warapp_check_plan` says nothing of it and `warapp_plan_turn`'s warning names the what-if figure it used).
- **Given orders against the default plan (#275, pattern 3).** `src/analysis/hold-diff.ts` (pure,
  `holdsBelowPlan`): for each border (mine at the start, beside an enemy stack in view, a teammate no enemy,
  not conceded by the plan; picked on the start-of-turn board, so one whose enemy stack the given orders
  capture still counts) what stands on it after the default plan's deploys and moves and after the given
  ones, on the turn simulator with no opponent order (my commander as 7, walking with the move that carries it on both sides — #274; card plays not carried out); a border
  the given orders leave lower is named with `planLeaves`, `left`, `short`, largest first (the tools only from
  `BELOW_PLAN_MIN_SHORT` (3) short: #306, one 1 or 2 short is the plan's surplus). `planLeaves` is
  everything the plan leaves there (leftover, margins, idle stacks), not the least that holds it, so a border
  named may still hold (the headroom table says what takes it). `bordersBelowPlan` (`src/tools/turn.ts`)
  makes the one extra plan per call as warapp_plan_turn makes it with no args: `livePlanSetup` with
  `award: 'read'` (the award of picks and the first mover read, nothing written), then `planTurn`;
  warapp_check_plan passes the history warapp_plan_turn reads, while the submit preview reads the board cache
  alone (`cacheOnly`, no GameFeed request added) and its warning names the recent turns the cache lacks
  (`historyGap`), where warapp_plan_turn's plan may differ. When the given deploys are
  that plan's border guess (`planBorderGuess`, shared with warapp_plan_turn, drawn with the kept salt read by
  `peekGuessSalt`, never created here) the guess is the reference (`against: 'guess'`), since the guess only
  moves the plan's deploys between borders. `warapp_check_plan` returns `belowPlan` and `belowPlanAgainst`
  (absent only when the plan could not be made; `belowPlanBasis` on full) and `warapp_submit_turn`'s preview
  warns (never refuses). Orders warapp_plan_turn made with options (goal, focus, reserve, enemy_deploy,
  first_mover) differ from the default plan by design. Report only: no plan reads it, so the golden corpus is
  unchanged.
  #505 (`src/analysis/bonus-delay.ts`): on turns 1–4 or while #319 fires, the same default plan also gives
  `bonusDelay` when the given orders drop a capture it makes toward rule 4f's nearest bonus and so finish it later
  (each finish turn is rule 4f's `turnsOf` on the next plan after each set of orders, read through `planCloseness`, a
  side table off the plan's JSON); check_plan and the submit preview warn, never refuse. Golden unchanged.
- **A hollow interior with the guard off (#275, pattern 2).** `src/analysis/breach.ts` (pure, `breachBehind`):
  a border's breach is my territories within two steps behind it (through my holdings) that face no enemy or
  fog, that no other front of mine reaches within two steps (so nothing is counted twice), and that are hollow
  (the caller's test), with the bonuses I hold in full that they are in, the border's own left out. Every
  `headroom` row carries `breach` (territories, income; hollow = none of mine beside it, itself included,
  holds the stack that takes the border at its headroom; no deploy takes it → empty), guard on or off. The
  planner, **guard off only**, adds `BREACH_WEIGHT` (0.5) × that income (plus its per-territory income; hollow
  = below the largest visible foe stack beside the border plus its owner's deploy; #235's cut not counted
  twice) to the border's protected value (`breachAt` in the deploy book), with a rationale line ("… alone
  shields …"). It brings no garrison of its own: the second line behind a border is #276's
  (`secondLineOf` / `fillSecondLine`, `plan/guard-off.ts`), and this rule only prices the hollow interior.
  Measured on the golden corpus against the planner without it (916 guard-off boards): plans changed on 59,
  orders on 7, no capture lost, next income never lower, 5 fewer concessions, never more warnings; no
  guard-on plan changes.
- **A hold that survives by a handful (#314, `finishPlan` in `src/analysis/plan/report.ts`, report only).** For each
  held border with a stack beside it and at least my income standing there, the plan carries out its threat (the
  stacks plus the owner's deploy, one luck-free attack); when that fails but the survivors of it alone take what is
  left of mine next turn, a warning names both figures ("holds by a handful … leaves N of mine against M"). No
  order changes; the golden hashes changed for the warning only. Sizing the hold for next turn is not done yet.
- **Opponent tracking (`src/analysis/opponents.ts`, `warapp_track_opponents`) reads that board
  history** with the same rules, consecutive turns only: per opponent the observed deploy each
  turn, income = the most of the last three observed turns (or its stock and flow when more),
  floored at base + visibly held bonuses — and never decaying (#119): an earlier figure is carried
  until a bonus it visibly held is visibly broken (less its value) or it could no longer earn it;
  #418: while I lead it on the board read (my armies in view ≥ `LEAD_ARMIES` (3) × its own and my income
  above the carry before the turn or that turn's visible income — never the reading being judged, which an
  over-read passes — `ObservedTurn.leadIncome`), a rise no turn read in full confirmed rises at most
  `RISE_CAP` (1.3) × the carry (or that turn's visible income) a turn, none on a turn read in full that observed
  less (`incomeMethod` `rise-capped`, `incomeRise`), so walk-ins read up to twice the carry no longer compound;
  measured on 167 calibration samples: 5 changed, mixed and small (ungated it lowered 45, mostly true rises);
  golden: 1 plan's rationale; judging the lead by the carry (review fix): calibration unchanged, golden 3
  synthetic plans (readings above my income held: one break attack the plan warned was 0% if reinforced
  dropped, one break target and two ranking incomes lower; next income unchanged);
  #418 (owner decisions of 2026-11-20): proof may always raise an estimate — a capture with every source
  army in view (`captureFloor`, `src/analysis/plan/shared.ts`, in `observeDeploy` too: the target a neutral
  or mine, every neighbour showing its owner and its own their armies, no other player beside it, no
  Multi-Attack, my orders known in full and untouched beside my land; what stands there plus the attacker the
  last defender surely killed, at least the fewest armies that kill every defender however split, beyond its
  stacks beside it less the guard; a possible Bomb halves the defenders) floors the turn's reading
  (`ObservedTurn.captureFloor`, `proven`), confirms a carry it reaches and is never held below by the rise cap
  (`incomeRise.proven`); the could-earn cap still applies. #567 (owner decision 2026-11-25): nor below
  the low end (at most its cap) of a turn in the window read from `RISE_LOW_COVERAGE` (0.6) or more of its
  frontier (`incomeRise.low`); calibration replay 0 of 166 tracker samples changed, golden 0 of 6253. Proof may lower one only on a turn with every army
  it could have deployed in view (`everyArmyInView` → `ObservedTurn.accounted`: its land shown with armies on
  both boards and nothing beside it hidden — a territory of its in deep fog beside none of its land is the
  one gap —, no third player beside it, no neutral beside it shrunk or taken, no territory of its lost, my
  orders known in full and no card of mine on its land when it borders me, a failed attack sure to kill, luck
  off under straight rounding when it captured, no army price): the over-read tripwire steps the carry down
  at most one `RISE_CAP` step a turn (⌈carry ÷ 1.3⌉) toward that turn's reading, never below it, and the
  readings it stepped down from count at most the stepped figure in later windows (`incomeMethod`
  `tripped`, `incomeTrip`). It steps the carry the window reads, not a #271 fog-capture `pattern`: a pattern
  above a stepped carry is restored on the next turn (`carryIncome`: `pattern.income > carry.income`), so the
  tripwire lowers a pattern-set reading for one turn only (the pattern is evidence no quiet turn disproves; it
  falls only with broken bonuses and the could-earn cap). Measured: calibration 167 samples unchanged (on the recorded games' final
  tracks 22 of 143 observed turns carry a capture floor, none above the reading it already had, and no
  turn is accounted); golden 5 synthetic plans' rationale and warnings (the planner's observed line raised
  by a capture floor), no order, capture, next income or concession changed;
  my own orders on a turn are measurements (`measureOrders`): `warapp_submit_turn` caches the
  deploys and moves it sent beside the boards, and `boardHistory` attaches them as
  `TurnBoard.orders` (orders sent from the web client stay unknown, which changes nothing;
  `warapp_uncommit_turn` drops the turn's cached orders once the withdrawal is confirmed; #271: a failed
  attack on a hold of mine — my loss there needs at least loss ÷ the offensive kill rate attackers, luck
  included, all from its stacks beside it at the start of the turn without Multi-Attack — bounds that
  turn's deploy from below when it is the only other player beside the hold and every neighbour was in
  view, `repelledFloor`, in the planner too given `previousOrders`; a hold counts only when every transfer
  of mine into it surely arrived whole — its source mine on both boards, showing exactly what my orders
  leave there, and either left more than the guard or beside no other player — never a hold an order
  `moves` does not carry touched (a Transfer Only, Attack Only or percentage order in `sent`, a card
  play in `cards`; orders cached before those were kept bound nothing), and on a turn an
  opponent may have played a Bomb (`PlannerSettings.bombFrom`, the card clock's fastest turn) half the
  hold before any move, rounded up, is taken out of the loss first),
  unexplained armies (earned since first seen − visible army change − visible losses − likely
  combat deaths) and inferred bonuses (combinations of up to three bonuses it could hold that
  best fit the income gap, within reach and affordable, none listed when too many fit — see the
  #123 rules below; candidates, never asserted). With 2+ observed turns the planner uses
  the tracked income in place of the single-turn observed figure (`PlanInput.tracks`) and says so
  in its rationale (a newest turn its bound cut is labelled, never counted: #235 1c, see the fog prior
  above); fewer, and the plan is exactly what it
  was without tracking. **An income set by one turn far above the turns before it is kept (#250):**
  more than `INCOME_JUMP_FACTOR` (2) × the most it was seen to earn on the (up to two) consecutive
  observed turns just before it is usually the first true reading after turns it deployed out of
  sight (a play session lowered a real +66 after +8 and +5 and lost). `incomeJump` weighs the boards
  and a track warning (so a `warapp_plan_turn` warning too; `income.jump` in the track tool) says
  why in numbers: its armies in view after the jump plus its losses seen (not the likely combat
  deaths, a guess that can read a transfer as a fight) against its armies in
  view before plus what it was seen to earn since, leaving out the armies that only came into view
  (on territories some board from the first of those turns to the jump did not show, or read as out
  of the fog — a capture from a neutral or player in view on every board is no reveal; what it had
  in view there on the first board is not counted twice; the jump turn's own #123 ambiguous armies —
  its reading less its low one, growth beside the fog or a capture's surplus read as deploy — count as
  come into view too, and the warning says the turn reads +low to +high);
  and, with its starting armies known, the whole game at the earlier rate (start + rate × turns, the
  rate the most it was seen to earn on ANY observed turn before the jump, not only the two just before),
  which no reveal of old armies can explain (the earlier readings are lower bounds too, so this one
  says some turn was higher than read, not the jump turn itself). Either beaten → believed; else it hedges (old armies
  revealed, or armies banked out of view). The armies standing on territory it took from me on the
  jump turn are named (`fromMe`, with the low–high reading when the capture is priced at the guard).
  No line when a later observed turn also reads more than the factor × that most: the income then
  rests on more than one turn. A carried figure cut below the jump since says so in the line.
  The line leads with its verdict in about a dozen words (#254: confirmed / kept / not confirmed, kept
  as a lower bound), then one short sentence of numbers; every figure is in `income.jump`.
  The figure never changes for it.
- **Opponent profiles (`docs/PLAN-PROFILES.md`, part A; owner decisions P1–P4 of 2026-11-15).** A habit is
  counts, never a story: events out of opportunities (`{ e, n }`) or a size (`{ n, sum, sq }`).
  `src/analysis/opponent-profile.ts` (pure) observes each pair of my consecutive boards with my cached orders
  (`observeTurn` → `TurnPrimitives` per opponent: contact, `attackedMe` — `null` when it cannot be told —,
  `iAttacked` — #442: also onto a territory not mine on T that is its on T+1, its fresh capture —, `reinforce` — measured only at 0% luck and straight rounding, with an exit for every case the
  arithmetic cannot read —, `stack`, `tookFromMe` / `lostToMe`; visibility through `visibleState` / `ownerShown`)
  and `habitsOf` recomputes the habits (reinforce, attack, firstStrike, stacking, retaliate, retake, jab — #361, capacityTopUp — #295) from the
  whole list, so re-deriving never double-counts. #295: `topUp` reads my biggest stack facing it on board T
  and its territories beside that stack: one takeable by the stack's movable armies plus my income (my deploys) on T and
  none on T + 1 is an event, one still takeable an opportunity without (orders unknown, an order or card of mine on
  one, a special unit or a territory not shown on both boards: no reading); the habit `capacityTopUp` and the label
  `tops-up` (≥ 0.6) with its counter line follow. Inform only (P1). A territory an order only `sent` holds (percentage, Attack
  Only, Transfer Only) or my Airlift touches is never read from armies; orders cached without their card plays
  (`MyOrders.cards`, cached since A1) read nothing from armies when the game may have Airlift, and when it
  may have Gift captures from me cannot be told (`tookFromMe: null`: no retake counted, no "did not attack";
  a gift of mine is no capture); a failure is read only when the armies back match the exact result; a border with a neighbour whose owner is hidden
  is not tested, and one a move of mine left without landing on a territory of mine (a failed attack, its survivors
  may come back), or entered from a territory I only took this turn (a Multi-Attack chain), reads only a drop, never
  a "did not attack"; under Multi-Attack (or when the settings do not say) a border is read only when every territory
  within two steps shows its owner and none is a third player's (it may have chained through the neighbour); boards from GameFeed history (`TurnBoard.source: 'history'`) are never observed.
  `src/profile-store.ts` keeps every observed turn at
  `<dataDir>/profiles/games/<gameId>-<myId>.json` (real ids, counts only; a turn observed again is
  overwritten; newest 200 files, none unwritten past the board cache's 60 days), written by `recordProfile` (`src/tools/profile-hook.ts`) right after
  `writeBoardCache` in warapp_plan_turn (never a what-if plan), warapp_track_opponents,
  warapp_locate_opponents and warapp_get_relations. `WARAPP_PLAYER_PROFILE=off`: nothing read or written.
  Known teammates are never profiled: nothing is kept while `resolveTeams` says a game of 3+ seats has teams it could not
  read (`known: false`; also when GameFeed gives some seats a team and others none), the tool then flags every other
  player `mayBeTeammate: true`, and each write drops what the file holds for a known teammate. Read-only `warapp_profile_opponents` reports each habit
  (B1) as this game's counts pooled with the player's faded counts from earlier finished games, shrunk by
  `PROFILE_PRIOR_WEIGHT` (4) toward a prior: the population pool for this format, then all players, once it has
  `POPULATION_MIN_OPPORTUNITIES` (10) for that habit (an AI seat: the AI pool), else the neutral default; with `n`,
  `confidence`, `basis` (whichever weighs most: `this-game`, `past-games`, `population`, `default`; the prior wins a
  tie), `seen.gamesMet`, and labels with a counter-play line at confidence 0.5, beside `lastAttackTurn` (#264: the last
  observed turn it attacked me, `null` when none; `turtle` is withheld when that was within `TURTLE_QUIET_TURNS` (2)
  of the turn being played); `profile` is `kept`, `not-kept` (no data dir, or the teams unknown) or `off`.
  **Across games (B2, `src/profile-store.ts`)** two name-free stores: `profiles/players.json` keyed by the deal
  record's `playerKey` under the ONE shared salt (`playerSaltForWrite` in `src/player-record-store.ts` is the only
  "read or make"), each player with at most 30 per-game entries (keyed by an HMAC of my account and the game) and its
  faded totals by format, at most 1000 players by an update counter (no clock); `profiles/population.json` with the
  human totals per format, the pooled `ai` profile, a games count and its per-game entries (500). `foldGame` moves
  totals by the difference from the entry stored for the game (never double counts; `history` replaces `live`, never
  the reverse), and a game new to a player first fades its totals and entry weights by `PROFILE_DECAY` (0.9). AI
  seats reach the pool only; a human who became an AI is left out of the game. `foldFinishedGame` runs on the first
  read showing the game `Finished` (warapp_get_game, warapp_wait_for_turn's read; no request) and marks the per-game
  file `folded: 'live'`; the end-of-game pass (#312, part C) then folds the game's history over it and marks it
  `folded: 'history'`. Otherwise the file goes by the 60-day age rule, and one reaching it (or the
  200-file bound) unfolded is folded with every ending `unknown` from the seats it kept, then deleted. **Backfill
  (#264, `foldFinished` in `src/tools/profile-hook.ts`):** a finished game with no per-game file (finished before
  #263, or never planned on this build) is observed once from the boards and orders the board cache holds for it
  (the cached account: a game it played) and folded as `live`, the file marked `backfill` and given the board
  cache's mtime (so it ages out with it). No request: teams from GameFeed, two seats or the kept team record only
  (`keptTeams`), unknown teams fold nothing; never a teammate; never twice (a file already there, or the
  population holding the game's key, is `already-folded`). It runs from warapp_get_game (`profileFold`) and from
  warapp_profile_opponents, which given a finished game folds it (`fold`) instead of refusing; nothing to fold says
  "counts start with games played on this build", except a fold that failed (`failed`, retried on the next read)
  and no data directory (`no-data-dir`), which say so. warapp_wait_for_turn reads no map, so it folds files only. A store or salt
  that cannot be parsed is never overwritten (`pastGames: 'unreadable'`, folds fail). **Profiles inform only:** the planner reads none
  of it until part 0's measurement is reported and the owner approves each hook (P1). **The one hook approved (#420, P1
  amended by the owner on 2026-11-20): a quiet neighbour.** `quietNeighbour` (`src/analysis/opponent-profile.ts`, pure)
  walks this game's observed turns in order: a contact turn whose attack on me could be told counts; with
  `QUIET_CONTACT_TURNS` (10) or more at an attack rate of `QUIET_ATTACK_RATE` (0.1) or less it is quiet, until its first
  attack on me after that, which ends it for the game. `quietNeighbours` (`src/tools/profile-hook.ts`, in
  `livePlanSetup`, so every tool planning on the live board reads it) reads the kept turns with the turns the boards in
  hand show observed afresh over them (the board just read included: an attack last turn restores full sizing at once,
  before the hook keeps it); nothing with profiling off, no data dir or the teams unknown. `PlanInput.quiet` → each of its
  borders of mine, its most valuable included, is sized at its stacks beside it plus its largest top-up seen (the
  track's `topUp`, #420 below; none seen: full sizing), with a "has not attacked me in N contact turns (#420, P1
  amended …)" line. Every other habit stays inform-only. Golden unchanged (no input carries it); counterfactual with
  every tracked opponent quiet: 399 plans, 78 orders, captures +19/−11, next income up on 7 and down on 3, 37 fewer
  concessions and none more. **A quiet border (owner request 2026-11-28, DRAFT; the Italy case: a 24-army stack sat a
  whole turn guarding a bonus against a fog-prior ~44 from an opponent that had put 0 or 1 armies beside my land for
  three turns)** reaches the same sizing from deploys, not the profile: `quietBorder` (`plan/threats.ts`, pure) reads
  the opponent's last `QUIET_DEPLOY_TURNS` (3) observed turns, in a row and ending at its newest board, each with a
  top-up beside my land (`ObservedTurn.topUp`) of at most `QUIET_DEPLOY_MAX` (1); then every border facing it is sized
  at its stacks there plus its largest top-up seen, except its most valuable border, which still holds against
  `QUIET_DEPLOY_SHARE` (0.5) of its deploy (`quietFloor`; owner decision the same day: the Italy opponent's next turn
  put ~12 of a ~17 deploy beside that stack), and what stands above that goes to captures (a "a quiet border, owner
  request 2026-11-28" line). Not under `enemyDeploy`; a turn with no top-up read breaks the run. Its estimate is
  unchanged (past FFAs read low, never high: 79 samples, median 0.49 × the truth). Golden: 30 of 6253 plans changed,
  8 in their orders (19 by this rule, 11 by the note below), attack targets +2/−2, 1 fewer concession, next income
  lower on none where both plans state it. The lead step's "could spare" note (#203/#212) now says when the spare is
  what a held border keeps once the step's target is taken, and the size the step needed when short, so it no longer
  reads against "can spare 0".
  **Where the read is reported (part D, `src/tools/profile-reads.ts`, read-only, never throws):** one computation
  (`readOpponents`) serves `warapp_profile_opponents` and three reports, none of which any plan, price or verdict
  reads (the golden corpus is unchanged): `warapp_plan_turn`'s `reads` (each opponent in contact on the live board
  with a habit at the confidence bar or a label: its labels, those habits with `n` and `basis`, `gamesMet`; full adds
  the counter lines; a what-if plan reports it too and still keeps nothing; absent with profiling off or the teams
  unknown), `warapp_advise_diplomacy`'s per-neighbour `habits` (`retaliate` and `attack`, beside `record`; it keeps no
  turn) and `warapp_scout_player`'s `met` (`metRead`: games met and every habit from the cross-game record alone,
  shrunk toward the all-formats pool; only when the record holds the player).
- **Locating opponents (`src/analysis/whereabouts.ts`, pure; `warapp_locate_opponents` in
  `src/tools/where.ts`, read-only)** reads the same board history and tracks, plus the starts the
  award proves (`loadAward`), the pickable territories kept in the pick record (`pickable` in
  `src/pick-list.ts`, written by `warapp_plan_picks` and the `warapp_submit_picks` preview; a record
  may now hold `pickable` without a `list`, which gives no award) — else, in a game whose settings say
  `AutomaticTerritoryDistribution` "Automatic" with a `DistributionMode` that is a mode of the map
  (`dealtMode`, `src/tools/map-details.ts`), that mode's territories (#328, `modeStarts` over
  `withModeTerritories`: read once per map per process from `GetMapDetails`, kept with the map; source
  `distribution-mode`, weighed exactly as pickable ones; unknown — a failed read, none listed — is a
  `warnings` line and no candidates, never `[]`) — and, only when `statsGate` is on
  (`WARAPP_STATS=1`, never hosted), the finished games already cached for the map
  (`cachedRecords` in `src/stats.ts`: the cache alone, never a request) as start candidates and
  prior. `seen` is the only fact in its output; everything else is a `likelihood` from a simple
  model, with its `basis`. The planner does not use it yet, and nothing else reads start candidates in an
  automatic game (the award, the pick advisor and the map notes' opening are manual-pick only), so the
  planner is unchanged. It writes the board cache like `warapp_track_opponents`.
- **The turn planner (`src/analysis/planner.ts`) is pure and deterministic** (ties on
  ascending id, no I/O; its header comment is the full rule list) and judges every hold and
  capture with the exact combat model (`armiesToTake`, `captureCost`). Its rules, learnt from
  a lost game (`tests/analysis/lessons.test.ts` replays each lesson in miniature):
  - **Triage by protected value.** A threatened border's protected value is my complete
    bonuses containing it, plus its share (value × members
    held ÷ size) of a bonus I am building (#425: a bonus it is my only way into gets that share too —
    it used to get the whole value — and nothing when an enemy holds or roams a member; owner decision of 2026-11-22:
    a member the fog hides keeps the share, and only the members in view are priced on the economy tests) — every missing member a visible neutral, finishing it
    economic (#122), or (#298) an enemy stack beside it that arrived since the previous board (took a member from me, or grew there) roams inside it, its other missing members visible neutrals or foe territories, on the same economy tests — plus per-territory income, plus (#235) the income of what its loss cuts off
    from the rest of my holdings (every part but the largest when it is a cut vertex; named in the rationale
    only with income or at least `PAYBACK_TURNS` armies), plus (#291, guard on or off) `OPENS_WEIGHT` (0.5) of the held
    bonuses its loss OPENS — my territories every route from an enemy or the fog reaches only through it
    (`opensBehind`, `src/analysis/opens.ts`; none containing it, none its cut or breach counts; an "… is the only way
    in to …" line); its
    **worth** adds the armies a hold saves as income (armies / `PAYBACK_TURNS`), those cut off
    included, so a big stack is topped up rather than abandoned. Holds go in order of worth per army of hold cost. A
    border is **conceded** when holding costs more than `CONCEDE_FACTOR` (3) × its worth or than the income left
    (a warning either way; in the opening, never on worth when the hold costs no more than the
    armies already there, #122): triage deploys nothing there (unless every territory I hold is
    conceded), it attacks out only with the armies already on it, and idle armies never move
    into it. It can still get deploys as a finish-off source (rule 1e runs first) and, under Local
    Deployment, from its held bonus's own pool (which lands only inside that bonus).
  - **Held bonuses first (#51)** (under `balanced`/`defend`): a bonus I hold in full is one
    unit — all its threatened borders are held or none (a border shared by two held bonuses is
    paid once). A unit whose summed hold cost ≤ `PAYBACK_TURNS` × its value (and, like any
    border, ≤ `CONCEDE_FACTOR` × its worth) is funded before any capture that completes no bonus
    (advances, breaks, other expansion); completions still compete on score but never starve a
    unit unless their bonus earns more — and (#122) never one that would then be conceded
    unless one turn of the completion beats `PAYBACK_TURNS` × what is lost, while one left only
    a near miss yields to a completion that pays for itself within a turn — and finishing off
    keeps its place. One that does not
    pay is not conceded yet (#118): the captures go first, and it is held whole from what they
    leave when that covers it. One a deploy must choose among (its every threatened border
    faces a player with two or more of my threatened borders) is **floored** when it cannot be
    held whole — every border first beats the armies already next to it — and kept: the rest
    is spread over its borders against the one shared enemy deploy, never conceded or withdrawn
    from; a warning per opponent says what its one deploy can still break at once ("+V at
    risk"), which may be all of them. Otherwise, one that does not pay or that the income left cannot cover is conceded
    whole ("conceding bonus …") and its borders are judged alone without that bonus.
    `expand` is unchanged but warns.
  - **Withdraw** (under `balanced`/`defend`): a conceded border's movable armies go first to
    the neighbour nearest a border that holds — except from a bonus I hold in full (#118),
    whose garrison stays unless it makes that neighbour, a valued enemy-facing border, hold
    this turn — and is my first order, because a withdrawal only executes while the border is
    still mine. Before it withdraws (#272), a conceded border attacks out with its own armies into a
    neighbour holding at most 2 whose capture completes or advances a bonus (R3 waived; a completed
    bonus keeps the border; under No-Split a completion only). #431 (owner decision 2026-11-22): a conceded border with
    nowhere to withdraw to (a neighbour rule 1c keeps counts as somewhere) whose stack the expected attack takes is doomed, and
    `doomedConcededOut` (`plan/doomed-out.ts`, after #272, before rule 1c) weighs standing against the exchange model's
    options — a capture its whole movable stack makes against the owner's estimated deploy, or a merge into a neighbouring
    pocket stack of mine that then holds — by my armies left plus enemy armies killed, and takes the best when it beats
    standing; the order goes first, like a withdrawal. The border it left (`ps.doomedOut`) gets no deploy after: not the
    leftover (not `open`; the every-territory-conceded fallback picks another territory, and when that border is my only one
    the leftover deployed there leaves with its move out), and a Local Deployment pool goes to any other member of its bonus
    first. Non-capturing attacks and a check that the landing territory holds are left out (owner). Golden: 43 of 6253 plans changed. Order Priority moves only that first order ahead of the opponent's first, so the
    plan sets `cardAdvice: 'order-priority'` only when I hold one (`holdsOrderPriority`), I am
    not known to move first (`movesFirst`), and the order it protects carries at least
    `ORDER_PRIORITY_MIN_ARMIES` (#127; waived by `orderPriorityForced`, when the hand is over the
    limit and the card is played anyway). The protected order is checked against the schedule:
    if a move it depends on runs first, that move is my first order and the card is judged for
    it; a strike is protected only when rule 1s advised the card for it (my commander
    threatened), never because a withdrawal did. The planner never plays cards itself;
    `warapp_plan_turn` adds the Order Priority I hold to `orders` when `cardAdvice` asks for it.
  - **Move order (#127).** Orders zigzag (the first mover's 1st, the other's 1st and 2nd, …), so
    the plan's `moves` are scheduled last (`src/analysis/schedule.ts`): the protected order, then
    withdrawals and transfers into enemy-facing borders, attacks that land even if the owner
    deploys there first, filler (uncontested neutrals, interior transfers), and last the attacks
    into a stack that can fight back (attacking second fights survivors) and contested neutrals
    whose survivors would not hold — softeners before finishers, moves into a territory before
    moves out of it; early moves largest first. With one opponent in view a "Move position" line
    gives each move put last its place in the zigzag (`opponentOrdersBefore` / `indexAfterAll`;
    known, Order Priority, or both cases). Deploys are listed next to a visible enemy first.
  - **The game profile (`src/analysis/profile.ts`, S1)** is on every plan (`profile`): format
    (players' teams — the shared `carriesTeam` test in `src/teams.ts` — and who is still
    playing), phase, standing (my income vs the strongest opponent's estimate; the armies on
    the board overrule it — never `ahead` while my visible armies are below 0.8 × an opponent's
    in view, and `behind` when below half, fog or not, since what it shows is the least it has;
    in a team game both incomes and armies are summed by team, PLAN-TEAMS C3, as is the outlook;
    an enemy still playing with no estimate is named and forbids `ahead`, which reads `unknown`; #275: an
    opponent whose estimate a tripwire broke, `PlanInput.untrusted`, is compared at the larger of its estimate and
    its untrusted figure, and the standing is never `even` while one runs: it reads `behind`, not under `enemyDeploy`;
    #287, the owner's choice of 2026-11-19, 1v1 only: `ahead` or `even` reads `behind` when the opponent's armies in view
    are at least `OUTNUMBERED_RATIO` (1.25) × mine — never in a free-for-all, where a clear leader above me (#167:
    strength ≥ 1.25 × the next) would always read `behind` and the profile defend instead of combining against it; the
    goal line then says "behind on the board, not on income" rather than naming incomes that are not why)
    and the strategy settings. `warapp_plan_turn` passes `adapt: true`: with no `goal` the profile picks
    it (behind → `defend`, else `balanced`) and its rules fire (1v1 in contact: advances rank
    below holds and breaks; FFA with 2+ opponents: no second front; behind: no pressure margin;
    ahead in a 1v1: pressure at `AHEAD_PRESSURE_FACTOR`). An explicit `goal` overrides it, and the plan warns that the format rules are off (a script that always passed `goal: balanced` played two 1v1s without them).
    GameFeed's player `team` is read when sent but unverified.
  - **`balanced` is the default goal**: holds, completing/advancing bonuses and breaking a
    fully visible single-enemy bonus (`BREAK_WEIGHT` / opponents × value / cost) compete by
    income per army; `MIN_EXPANSION_SHARE` (30%) of income goes to expansion before holds that
    protect less than it. A threatened border whose only visible threat is a breakable member
    attacks it on top of its hold (hold + capture deployed there, so it still holds if the
    member is reinforced and the attack fails); unable to afford both, it just holds — never
    a capture instead of the hold. `defend` holds first, `expand` never attacks players.
  - **`siege` (#382, `src/analysis/plan/siege.ts`; explicit, or picked by the profile when it fits)** plans as
    `balanced` (`pc.goal` reads `balanced`; `pc.siege` carries the rest; the plan reports `goal: 'siege'`)
    against one opponent (`siegeTarget`, else the strongest in contact): its breaks score `SIEGE_BREAK_WEIGHT`
    (3) × a 1v1 break and never count as a second front; until the trigger its territories outside its
    breakable bonuses join `truce.noTarget` (`siegeHeld`, the #375 path); rule 0p.3c builds the strike stack
    facing it in any format. Trigger: its income ≤ `SIEGE_INCOME_DROP` (0.6) × its baseline (the most the
    tracker saw it deploy over its window, or its income on the siege's first turn when larger; neither, no such
    trigger), mine ≥ `SIEGE_INCOME_LEAD` (1.8) ×
    its, or a stack of mine at the start of the turn takes a member of a bonus it visibly holds against its
    defenders plus its whole deploy. **Memory (`src/siege-store.ts`, `<dataDir>/siege/<gameId>-<myId>.json`, ids and
    numbers only):** warapp_plan_turn keeps each siege turn (target, its income, mine, the bonuses the plan broke — as
    planned) and passes it back as `PlanInput.siegeMemory`; `priorSiegeTurns` keeps only the same target's turns before
    this one, none when the newest is more than `SIEGE_MEMORY_GAP` (3) turns back; re-planning a turn replaces it; an
    `enemy_deploy` what-if writes nothing. `siege.memory` reports `startedTurn`, `turns`, `startIncome`,
    `opponentIncomeTrend`, `broken` (per bonus, its turns) and `rebroken`. `TurnPlan.siege` reports it.
    **The profile no longer picks the siege (#603):** `siegeFit` and `PlanOptions.siegeAuto` are gone; the siege plays only on
    an explicit `goal: 'siege'` (the self-play arena measured no gain from the auto-pick, 13 of 20 with it off).
  - **Single-army jabs (#361, `src/analysis/plan/jabs.ts`), at 0% luck under straight rounding only**, where one
    army kills round(1 × the offensive rate) ≥ 1 and dies: a one-for-one trade (seen live: 75 → 74, 19 → 18). On
    under `siege` (`PlanOptions.jabs` / plan_turn's `jabs`: `true` on, `false` off; off otherwise). After the #226
    margin, armies still idle beyond a source's hold (`spareBeyondHold`, never a step's saving source or rule 5's
    kept leftover; never below what holds it against two opponents together, #128, or so thin #314 would warn; the
    strike stack only into the siege target's break members) jab enemy stacks of 2 or more, one army each, at most
    one per stack, never one another order attacks, a `noTarget`, a #240 repulsed one or a special unit's: the
    siege's break members cheapest break first, then members of a bonus a foe holds in full, then any stack of an
    opponent I out-earn or out-army. `TurnPlan.jabs` reports them (`winChance` 0, never in `captures`); a 1-army
    failed attack is no #240 evidence. Measured on the golden corpus with `jabs: true` (6253 plans): jabs on 242,
    279 in all; no other order, capture, next income or warning changed. Golden unchanged (off by default).
    An opponent's own jabs are tracked in its profile (#361): the primitive `jabs` (my borders read for
    `attackedMe` that dropped by exactly what one army kills, exact combat only, else `null`), the habit `jab`
    (contact turns it jabbed ÷ those read) and the label `jabber` (≥ 0.5 at the confidence bar) with a counter
    line in the reads. Inform only (P1): the planner does not size refills on it.
  - **One owner per bonus (PLAN-TEAMS C3.3, `src/analysis/plan/team.ts`).** A bonus with a member a
    teammate visibly holds is never scored, completed or advanced (a focus on it is ignored with a
    warning); its other members are plain expansion. #435 (owner decision 2026-11-22): only with the Gift card in play
    (`PlanGameContext.cardsInPlay`, from the settings' card rules; absent or no Gift: skipped as before), one I alone hold the
    most members of (`nearer`; a tie is nobody's) is mine to work — its other members are scored and advanced,
    the teammate's are theirs to hand over (a Gift), never captured or costed, and it is never `completable`
    while they stand (no income claimed); one that is then uneconomic stays skipped as before, its members
    never marked uneconomic. `team.sharedBonuses` (advisory) lists each bonus
    we both hold members of and who holds the most (`nearer`), from the start-of-turn board; a fogged
    teammate territory is unknown (team vision unverified). Absent outside a team game.
  - **Commit to the closest bonus (#101, rule 4f).** While no bonus is held, and in the opening
    and expansion phases, completions and advances go to the bonus fewest turns from completion
    first; equally close ones by the income per army (on the score's cost) of every bonus the capture
    completes (#438: a pair bonus on top of a single-territory one adds up; a "complete together" line
    when another bonus as close competes), then a bonus advanced last turn, then the score. Golden: 14 of
    6253 plans' orders changed, captures, next income and warnings unchanged. "N armies to finish" counts a
    fogged member a static seat left at its #417 price first; else (#428) at its last sighting on my boards
    (`options.lastSeen`, unless the fog shows another owner now), else its picking-board size (#201), else — its
    owner hidden too — the game's neutral size (`settings.neutralArmies`: the larger of the two neutral sizes the
    settings give), and only without any of those at the bonus's costliest visible missing member (65
    finished-game plans counted every one at 208). The sightings are one source with #417's: `fogSightings`
    (plan/vacated.ts) over my board history gives each fogged territory's newest sighting (owner, and armies when
    shown — never from a GameFeed history board, unverified in play: those give the owner only); `foggedLastSeen` is its owners, `lastSeen` its counts. Golden: unchanged (no corpus input carries either); with a neutral size of 2 on every input 1017 of 6253 plans, 722
    orders, captures +21/−2, next income lower on 1; with sightings from each input's previous board, 51 plans, 34 orders,
    captures +1. #416 (merged in #484): turns to finish count the armies already standing beside a
    bonus — each territory of mine next to a missing member, once, beyond the guard and what holds it (`keepFor`) —
    before the income (the rationale's "(N standing beside it)"). Golden: 603 of 6253 plans, 19 in their orders. Ties
    at the same turns and income per army (#438) then go to fewer armies to finish, then fewer fogged members, before
    "advanced last turn" (ahead of #438 they broke negative-bonuses (c): a cheap +3 over lifting a −8). Golden: 1 plan. A
    bonus held in full ends the commitment (and #319's warning) only when worth `HOLDS_BONUS_MIN_VALUE` (2) or more: a
    +1 is "no bonus worth more than +1". Golden: 79 plans, 6 in their orders (captures unchanged). #319: on turns 2–`SPREAD_LAST_TURN` (6), with at least `SPREAD_TERRITORIES` (10)
    territories, no bonus held and my income at most `SPREAD_INCOME_SLACK` (3) above base, a warning says the captures
    are spread and names this rule's nearest bonus with its armies and turns. **#319 binds (#416, owner 2026-11-22,
    `plan/spread-bind.ts`):** while it fires, pass-3 plain expansion and advances into other bonuses may not spend
    deploys, or armies on a territory beside the nearest bonus's missing members, until that bonus's reachable steps
    are funded; holds keep their places. Reachable steps: its missing members that are capture targets beside a
    territory of mine; funded: captured by this plan, then the rest flows as before (a step refused for another reason
    — rule 4d, R3, income — keeps the bind for the turn, and the leftover saves toward it). A stack beside two bonuses'
    missing members is the nearest bonus's. Bound: other bonuses' advances (pass 2, `balanced`'s advance slots, #439's
    stage), pass 3 and rule 5b's leftover expansion; never its own members, a focused bonus, completions, holds, breaks,
    counters, strikes, the 1v1 race, rule 4e, 4g or 4h; my other territories' own armies still attack. A "#319 binds
    the deploys (#416)" line names the steps and stacks. Golden: 0 of 6253 plans changed (#319 fires on 2, both
    completing the nearest bonus first); every corpus input on turns 2–6: 75 fire, 5 bind, 0 orders changed. An FFA lead step into it (an enemy member, #203) is sized to land
    even if its owner deploys there first; when the turn cannot fund that for the closest bonus or
    a completion, it is taken at the bare cost that ranking used (#214), after every sibling's
    sure try, with #120's warning — only while rule 4f commits to the closest bonus, and never
    with the armies a hold gets: `planTurn` plans again without bare steps and keeps that plan
    (saying so) when the bare one leaves a border it holds without its hold.
  - **A big single-territory bonus two moves away is a two-turn completion (#439, `plan/two-move.ts`).** A bonus of
    one territory worth at least `TWO_MOVE_MIN_VALUE` (5), two moves from mine through a visible neutral target (the
    territory a visible neutral, or fogged and costed at its picking-board size), costs that neutral plus the territory
    (cheapest neutral in between; every bonus the two complete counts; kept only when it repays within the payback
    turns). Under `balanced` the neutral in between is a greedy candidate (`stage`) scored net ÷ both costs, treated
    as an advance (after units, below holds in a 1v1); other goals take it after completions and before advances; a
    "Stage toward …" line names both steps. Not when this turn already takes or borders the territory. Golden: no
    plan changed (6253; the corpus has no such bonus).
  - **The economy test charges armies lost (#125).** A capture costs the economy the armies its
    attackers lose plus the one left on it (waived when an idle stack beside it, facing no enemy,
    takes it), not the armies sent; a bonus's worth adds its members' per-territory income; plain
    expansion (pass 3) repays its losses with the income it adds within `PAYBACK_TURNS`, or loses
    at most `PLAIN_EXPANSION_LOSS` (2) for +0. Turns to finish are never fewer than a bonus's depth.
    A capture rule 4e/4f names but cannot afford gets the leftover on its source, and idle stacks
    facing no enemy stage one step toward it; "cannot afford" counts what holds that source's border
    once the step is taken (#218 comment: a source that grew enough to pay for the step by size alone
    stopped saving, under any goal).
  - **One surplus per territory (#121).** A border that holds at the start of the turn keeps
    what holds it, as my commander's territory does: a capture from it spends only the armies
    above that (plus deploys), so a capture never leaves a safe border takeable. Idle armies
    transfer toward the enemy front first (the nearest non-held territory only when no enemy is
    reachable, and never a teammate's: PLAN-TEAMS C3), a capture of a player's territory sized without a reserve does not make the
    garrison beside it idle, and my commander's stack beside a conceded border stays. #367: a step toward an
    enemy front (not a #260 step, not toward a neutral edge) must also bring the stack strictly nearer it
    measured through conceded borders too (`distEnemyThrough`): a stack behind a conceded border waits there,
    where the front will be once it falls, with a "Keep the N idle armies on X … (#367)" line — live, a 649
    stack walked away from one and straight back the next turn. One board, no memory of last turn.
  - **Attacks on a player are sized for its owner's deploy (#120).** When the armies beyond what
    holds the source cover it, an attack on a player's territory (break, counter-attack, strike,
    rule 4e capture) is sized for its defenders plus the owner's deploy estimate (or its growth
    there, when larger), and counts as landing; otherwise its "assumes its owner does not
    reinforce" warning gives the win chance against the reinforced target. The 1v1 strike stack
    goes to the border with the most to spare after its best such strike (most armies only when
    none can strike), and fog pressure paid outright from idle armies is not priced against
    expansion (`PRESSURE_FACTOR`). #226: once the transfers have run, such an attack (not a
    combined capture, not under No-Split) also takes the armies still idle on its source beyond
    what holds it — even if the attacks on players beside it fail (#128), the owner's other stacks
    beside each target having moved in first — as a margin over an
    estimate that is only a floor (never from a source rule 5's leftover went to for a comfortable
    margin, a hold or saving toward a step: those armies are not idle); a "Margin on the attack on …" line says what deploy it covers.
    **Repeated failure is evidence (#240):** `warapp_plan_turn` reads my cached orders over the board
    history (`repulsedAttacks`, `PlanInput.repulsed`): a territory my attacks failed on, on two or more
    of the last three turns, its owner reinforcing it each time (its armies after plus my kills above
    its armies before; still that player's now), is attacked only at that sure size — its defenders plus
    the owner's deploy, or (#272) plus the most it reinforced it on those turns when that is less: live, an
    owner that had put 4 and 3 there was sized for its ~29 deploy and not attacked (every pass: targets, rule 4e's fallback, the 1v1 strike stack, finishing off and
    fog pressure, which never press it with a share of the deploy; the guard-off one-army break skips it
    and says so) — or not at all, never retried at its bare cost (#214); a rationale line names the failed
    turns. It still ranks on its plain cost (the sure size only decides what fits, `sizeOf`, and what is
    sent; rule 4e's contact trial and its survivors read it as the plain plan does): ranked on the sure
    size, targets that fitted dropped behind worse ones. One the turn cannot fund at capture time, but its
    source and the whole budget could reach, is taken pending at its plain size and dropped after the
    #226 margin if still short ("Drop the attack on …"), since the plain plan pays the sure size from
    the leftover. A size below the deploy estimate (#272) is no worst case: the attack keeps #120's
    "assumes" warning, #120 still sizes it up to the whole deploy when its source has the armies, and rule 6
    does not count the target as held (`repulsed`'s `sure`, #272 review) — so where the source has the
    armies the attack is as large as without the evidence, and it never sends less. Rule 5 judges its source's
    comfort (and whether to revive a conceded border) as the plan without it would, with the surplus over the
    plain size still on it, and the leftover there is not kept from the #226 margin (`repulsedSurplus`,
    `plan/leftover.ts`); the strike stack's attack on one is reported as sized for the deploy, no "assumes" (only when that size is
    the whole deploy estimate).
    **All-in or drop a contested bonus (#298, `src/analysis/plan/bonus-attempts.ts`; owner defaults of 2026-11-20).** An
    attempt is a turn whose plan expected to complete (`expected.bonusesCompleted`) a bonus with a member another player
    held; it failed when the next turn's board does not show the bonus all mine. The memory is
    `<dataDir>/bonus-attempts/<gameId>-<myId>.json` (`src/bonus-attempt-store.ts`, the siege store's pattern: ids and
    numbers only, 0600, atomic, path-locked; read in `livePlanSetup`, written by warapp_plan_turn on a plan that is not a
    what-if). After `FAILED_ATTEMPTS` (2) failed attempts on consecutive turns the bonus is pushed all-in once (focused,
    every missing member in view and beside mine, each one a player holds sized for its defenders plus its owner's deploy
    — #368's middle figure — taken at that size or not at all, as #240's sure size; the whole at most
    `ALL_IN_VALUE_TURNS` (2) × its value and my income) when that plan takes every missing member; otherwise, and after
    an all-in that failed, it is dropped for `DROP_TURNS` (3) turns, this one included: not scored, and rule 4e's
    contact fallback, #203's lead steps and #272's attack out of a conceded border never go into its missing members.
    warapp_plan_turn reports `bonusPush`, and a rationale line names the failed turns. No memory, no change (golden).
  - **A fogged opponent bonus is a probable break in a 1v1 (#593 items 2 and 5a, `plan/fogged-break.ts`; owner decisions of
    2026-11-27: the split-over-fronts share, the opening denial kept, a line per candidate, the strike stack's size).** `breakableBonuses` breaks only a bonus with every member in view (or #72's inference): on 16
    finished 1v1s that left 184 of 187 opponent-turns holding a bonus beside mine unbroken. Under `balanced` in a 1v1
    (`profile.format`), `foggedBreakables` adds a positive bonus no member of which is shown with another owner (the
    `couldHoldBonusPools` reading), with a member fogged (owner or armies hidden) and a member in view the opponent's,
    armies shown, beside my land — "Player P probably holds bonus B … (#593)" — and, on turns `OPENING_STRIKE_FIRST`–
    `OPENING_STRIKE_LAST` (2–4, item 5a), one with exactly one member shown neutral (a denial, "one territory short",
    worth `ONE_SHORT_WEIGHT` (0.5) × the bonus). Its members in view are break targets (`foggedMember`); rule 4a scores
    the cheapest as a break and sizes it for its defenders plus `partialDeploy` — the opponent's deploy estimate on it
    split over its territories in view beside my land, rounded up (one such territory: the whole estimate) — its score
    paying that size; a combined capture is sized the same (`worstCase` while tried). Sent at the whole deploy or more
    it is a worst case; else #120 may still size it up from idle armies, and its "assumes" warning says "(sized for a
    partial deploy of N (#593))" with the win chance against the whole deploy. #240's sure size and the hold's keep
    (#121) apply as to any capture; #298's dropped members are never tried. A break (visible, the FFA
    leader's sized one, or a fogged one) may also go out of a conceded border, not my commander's, funded by a deploy
    there sized for the attack alone (item 2's second ask, `ps.breakTarget` / `breakConceded` in `plan/captures.ts`;
    a "… is conceded, but the deploy there leaves with the attack …" line); a plain capture from a conceded border
    still spends only the armies there. Golden with it: 22 of 6253 plans changed, 20 in their orders, attack targets
    +15/−6, concessions fewer in 2 and more in none. Golden: 91 of
    6253 plans changed (48 synthetic, 43 suite), 15 in their orders, captures +5/−1, next income up on 1 and down on 1
    (a +1 completion displaced by a probable +2 break), concessions unchanged; 21 plans carry a #593 attack (7 new, 7
    resized, 7 relabelled). Replay of 16 finished 1v1s (271 turns, adapting): 18 turns attack a fogged bonus (13 → 21
    of 190 opponent-turns holding a bonus beside mine); 19 of 20 targets were in a bonus truly held, 8 of 19 still
    beatable by the armies sent after his turn; 187 of 220 "probably holds" lines named a bonus truly held.
  - **Retake a lost held-bonus member (#430, `retakeMembers` in `plan/targets.ts`; owner decision of 2026-11-22).**
    Under `balanced` an opponent's territory was only a break or counter target, so a bonus I held in full on
    `previousBoard` that lost a member to a player was retaken only by the 1v1 strike stack. Now each such member is a
    bonus target in every format when the retake completes the bonus this turn (every missing member in view, beside
    mine, no special unit, not #298-dropped), the capture costs together are at most `RETAKE_VALUE_TURNS` (5) × its value (the owner tightened the draft's 10×), and the
    profile does not read me behind; a "Retake … (#430)" line names it. It then ranks as a completion (rule 4a), so a
    hold scoring higher funds first, and R3 still refuses one that cannot be held; #298's attempt memory bounds retries.
    Golden: 1 of 6253 plans changed (rationale only).
  - **One deploy reinforces one target (#277, `src/analysis/plan/second-sizing.ts`).** Once every attack is sized
    (after the #226 margin and #240's drops; not under No-Split or Local Deployment), when two or more attacks on one
    player's territories are each sized for its whole deploy, the one sending the most keeps its size and the others
    may give up what they send beyond their bare size, and beyond their source's deploy, which moves with it. A held
    bonus (rule 1h's unit) no order leaves, whose threatened borders together lack at most that and `PAYBACK_TURNS` ×
    its value, gets those deploys and is held, no longer conceded ("Fund held bonus … (#277)"). Golden unchanged.
  - **A hold is sized for the worse move order (#215).** Armies withdrawn into a border land by my
    own order, after the opponent's first attack when it moves first: unless `movesFirst` is true,
    the leftover makes each open border that falls without them hold on its own (when it can
    afford the whole hold; the armies the border's own orders send out still stand then, since the
    opponent's first order precedes all of mine, so it leaves out only the withdrawal less those,
    `lateNet`; never from what another open border needs to hold whoever moves first: moving
    first, only my first order lands before the opponent's first, so a border another withdrawal
    goes into needs its worse-order hold either way, and it is kept back from the one my first
    order goes into; two such borders go most at stake first, neither reserving for the other) — after #121 has held a conceded border after all when the leftover would
    buy comfort margins (a conceded border falls whoever moves first; that one falls only if the
    opponent does), and #121 may then take back a withdrawal the border it went to needs, paying the
    deploy that holds that border without it (spent either way) — what a border keeps from captures and
    top-ups (`keepFor`) leaves them out, and a border that still holds only with them is warned
    "holds only if I move first" (naming why no deploy was made only when that was the reason).
    Known to move first, they count as before (#127). Known means the user said so (`first_mover`,
    now or on a remembered turn): a first move only the award of picks gives (the wiki's rule, not
    verified live) still orders the moves and decides card advice, but holds treat it as unknown
    (`movesFirstUnverified`) and the warning names the award; so do they when an opponent may hold
    an Order Priority card (`opponentsMayHoldOrderPriority`: played, its first order runs before mine). Idle armies rule 6 transfers into a
    border never count toward its hold; when the border holds only with them the same warning says
    so (moving first, only my first order lands before the opponent's first: it names the one transfer
    that must be that order; known to move first, "holds only if my first order is …").
  - **A contested held bonus comes before an advance in a 1v1 in contact (#215, rule 0p.1).** A held
    bonus whose hold pays back within `PAYBACK_TURNS` but costs more than `CONCEDE_FACTOR` × its
    worth is contested (#118: the captures go first). Under rule 0p.1 an advance ranks below every
    hold, so before the first advance it is held whole when what is left covers it (best worth per
    army first, never weighed against spreading); otherwise it stays contested as before. Live, a +4
    bonus's one border was floored and spread on 9 armies while 15 went to an advance into a bonus
    47 armies from done, and fell to the 33 that could reach it whoever moved first.
    **A floored one too (a lost 1v1 of 2026-11-27, DRAFT for owner approval):** one that cannot be held whole
    (#118's floor) was spread over its borders only after the captures, so an advance still took the rest
    first (13 of 18 to far advances while a home bonus fell to one stack). Before the first advance or #439
    stage that completes nothing (not a focused one; a #417 race still goes first), `settleContested('floored')`
    spreads what is left over the floored units' borders (a "1v1 in contact: what is left goes to the borders
    of …" line); the other contested units wait for the call after the captures, as before. Golden: 3 of 6253
    plans changed, 1 in its orders (an advance 42 armies from done dropped; the break of the opponent's bonus
    then takes 11 of its ~14 deploy instead of 3).
  - **The 1v1 race for vacated land (#417, owner decision of 2026-11-20).** In a 1v1 in contact, while a static
    seat's (#270) land is still untaken, its capture targets costing at most `VACATED_MAX_COST` (neutral, or
    hidden at the 2-defender price; never a negative bonus's member: `raceTargets` in `plan/vacated.ts`) are
    `race` candidates of the greedy step that rank ahead of rule 0p.1's "expansion last": after the held-bonus
    units and my commander's hold (`raceTier`), before every other hold, break, completion and advance; the
    contested units are settled before the first race, as before the first advance. A "1v1 race for vacated
    land (#417)" line names them. Golden: unchanged (no corpus plan is a 1v1 in contact with such land).
  - **The army cap prices idle armies (#253, rule 4h, `src/analysis/plan/cap-spend.ts`).** When my
    armies after this turn plus next income exceed the cap, the income above it is lost, so captures of
    neutrals and of foe territories holding at most 1 army (no truce, teammate or commander) are taken
    from idle armies while each one's expected loss is below the income the cap would eat, every hold
    kept. Once one of a player's territories is captured this turn, its other territories beside mine are
    candidates too whatever they hold (#272: a fork its one deploy must split to save them all; the line says
    it cannot only when the deploys each attack needs to fail, summed, exceed its estimate), under the same loss
    test. It runs whatever else the plan captures (rule 4e's army-cap fallback, #104, runs only when the
    plan captures nothing: live, a plan that completed a bonus parked 54 armies beside enemy territories
    of 0 and 1). The rationale names the cap's arithmetic, the "Not attacking" line says when rule 4h
    tried a territory and why it did not take it, and a warning names what idle armies still cost.
    `sinceLastTurn` names a cut ("the army cap took N of M", `armyCapCut` in `full`), so a shortfall the
    cap explains is not read as a border lost.
  - **Leftover** goes to the held border with the most at stake still short of a comfortable
    margin (with several, each is brought to its margin first, and a conceded border the leftover
    can make hold is held after all before any margin, #121; #257: so is one an idle interior stack
    beside it makes hold by transferring in, rule 6's first step, the border the plan attacks from
    first; #260: when none does and the enemy front lies only past a conceded border the plan attacks
    an enemy from (#272: or strictly nearer past it than by any other way, a capture this turn included), rule 6 still steps the stack into that border rather than to a neutral edge no
    nearer, never into another conceded border or one a withdrawal leaves, and only from a stack
    no visible enemy borders at the start of the turn — one interior only once a strike lands keeps
    its armies for that strike's #226 margin, which is sized after rule 6; when several such steps
    together make the border hold, it is held after all, not reported conceded), else the top expansion's stack — never to a conceded border (the old "most enemies
    next to it" rule picked the hopeless border). #218: once every short border has its margin, the
    rest goes to the source of the step the leftover would save toward (#125) when that source is a
    border of equal defensive value (same player, threat, enemy territories, protected value and
    bonuses), and counts toward the step; with no enemy territory in view the leftover stays on the
    territory central to what I hold (fewest hops through my land to my farthest border) rather than
    ride an expansion stack more than `CENTRE_SLACK` hops farther out whose attacks land without it.
    #424 (`partnerFront`): when that is only because a Diplomacy card in force (T9) makes the sole opponent
    beside me no foe, the leftover goes instead to my border facing its stacks (most at stake, then its
    biggest stack beside it, then id), once the expansion's attacks land without it: the card's end reopens it.
    #288 (`joinsOf`, `plan/leftover.ts`): an expansion stack facing no threat and holding no commander of mine
    that has nothing left to attack once this turn's captures land (every neighbour mine or captured) sends the
    leftover with its attacks on neutrals whose targets have a step onward (equal shares, most steps onward
    first; not under No-Split or into a combined capture), so the armies that land fund the next step without a
    deploy ("… and send it with the attack on … (#288)"). Golden: 466 of 6,253 plans changed (462 in their
    orders), no capture lost, next income and concessions unchanged, the frontier's hold cost lower on 96 and
    never higher. The extra is sized to the next step (#288's second half, the rule chosen for the owner): each
    attack first gets what the capture of the cheapest visible neutral beyond its target needs next turn beyond
    the armies that land movable, only when the leftover covers it whole (one attack per step); the rest is
    offered to another capture this turn (`otherCapture`: a neutral passing pass 3's tests beside another open
    territory of mine with no order, no commander and no attack on a player, short by no more than the rest;
    not under Local Deployment or `complete-bonus`), deployed there for rule 5b, and sent back with the attacks
    (`LeftoverOffer.revert`, from planPass) when rule 5b takes nothing there; what is left rides them an army at
    a time to the attack with the least extra (#402's even split whenever no need exceeds its share). Golden: 105
    of 6,253 plans changed, 5 in their orders (the rest only the rationale's named step), no capture lost or
    added, next income, concessions, warnings and the frontier's hold cost unchanged; no corpus board takes the
    offer (4 of 40,000 further synthetic seeds do).
    #268: otherwise the rest, once every short border has its margin, is spread over the open borders
    facing that border's opponent alone (no other opponent's stack beside them, no attack leaving
    them; one protecting nothing only when the first protects nothing too), an army at a time to the
    one that breaks at the smallest deploy, ties to the most at stake, so the smallest deploy that
    breaks any of them is as large as it can be (live: the rest on the border protecting the most left
    two others to fall at ~1.5× the estimate). One such border, my commander's, or an attack's source
    keeps the old rule; the pools of Local Deployment are respected. Its "~D" is the threat arithmetic on
    the deploys before any move, not #275's `headroom` (the whole turn carried out), and its line says so.
    #290 (owner decision 2026-11-19, `fundGrown`): before that spread, each open border (no attack out) beside a
    stack of its opponent that grew since the previous board (the two boards, `Threats.previousBoard`) is topped up,
    highest protected value first and as far as the leftover goes, to hold against that stack's movable armies plus
    the opponent's whole observed deploy: the largest of its estimate, `observedRaw`, this turn's high reading
    (`observation.high`, growth beside the fog read as deploy) and the track's cut reading (`newestCut`) — a jump
    kept as a lower bound counts in full. A "(#290)" line names each; the spread itself is unchanged.
    #440 (`deterrentGuard`): before the leftover tops up a border that already holds (or one a truce relaxes, T2), the
    territory of mine carrying a single-territory bonus of at least `DETERRENT_MIN_VALUE` (5) with the most protected
    value (open, no order, not one of those borders) gets a deterrent guard when it protects `DETERRENT_VALUE_RATIO` (2)
    × the most any of them protects and an opponent stands within two steps: armies until taking it needs more than
    `COMFORT_MARGIN` × the largest deploy estimate of those opponents (its threat, when a border), never from what the
    borders that would fall need to hold; it is then `locked` (rule 6 moves nothing out) — also when it already needs
    more than that to take and gets no deploy (a "keeps its N armies" line), else a capital that started stronger
    ended weaker than a topped-up one (review fix: 3 suite golden plans keep a +5 territory's idle armies). Live: a +8 hub of nine pair
    bonuses ended on 3 while 15 armies topped up low-value borders. Any held bonus's member was tried first: 4 golden
    plans changed, one shaving a front's armies into a #226 margin, so it is gated to the single-territory case.
    Golden: synthetic unchanged; 3 suite plans (100-102) each drop one idle transfer out of a +5 single-territory
    bonus behind borders that already hold; deploys, captures and income unchanged.
    #218 (rule 5b, `src/analysis/plan/after-leftover.ts`): once it is placed, a territory the leftover
    reached takes a neutral beside it from what stands above its hold (pass 3's economy test and
    sizing; the hold as if its attacks on players failed, without withdrawals unless I move first,
    and against two opponents together when it holds that now; never the strike stack, a saving
    source, a source attacking a player, under No-Split or `complete-bonus`).
  - **A flat income saves toward a reachable bonus (#303).** `warapp_plan_turn` passes my income on each cached
    earlier board (`incomeDetail`, as this turn's: after the army cap, cards aside; none in a commerce game) as
    `PlanInput.incomeHistory`; the plan reports `incomeTrend` (`src/analysis/income-trend.ts`, pure: the last
    `TREND_POINTS` (5) turns, this one last, a least-squares slope, and `flat` by #312's rule — `FLAT_TURNS` and
    `FLAT_TOLERANCE` now live there, `game-lessons.ts` re-exports them). When it is flat and rule 5's saving step is
    in a positive bonus whose every missing member is a visible neutral or an opponent earning less than me, the
    leftover saves on the step's source before any comfort margin (`flatSave`, `plan/leftover.ts`: the holds keep
    their exact armies, idle stacks stage toward the step, a "(#303)" clause on the leftover line), only where the
    leftover can land there. Without a history every plan is byte-identical (the golden corpus has none); with a
    flat history on every plan of turn ≥ 5 it fired on 25 of 6,253 and changed orders on 7, no capture lost, next
    income never lower, no concession added. A completion that takes an opponent's member only reaches it where
    rule 5 already saves toward such a step.
  - **A stockpile on a flat income is spent (#421).** Outside a 1v1 (no siege, adapting, not `defend`, not
    No-Split), when `incomeTrend` is flat and my armies in view are at least `STOCKPILE_TURNS` (4) turns of income,
    rule 0p.3c builds the strike stack facing the opponent beside me whose visible armies mine outnumber
    `STOCKPILE_LEAD` (2)× (fewest first; visible armies only, never an income estimate; never on my commander's
    territory): the leftover goes to it ahead of comfort margins and #102 spends it as in a 1v1, with a
    "Stockpile (#421)" rationale line (`chooseStrikeStack`, `stackFacing`, `plan/strike.ts`). The golden corpus
    carries no income history, so it is byte-identical; with a flat history injected on its 1,839 plans of turn
    ≥ 5, 7 changed orders: 2 captures gained, none lost, next income never lower, no concession, warnings 1 added
    and 1 removed. The rule lives in `plan/stockpile.ts` (`pileOf`, `stockpileOf`; pure, shared by
    the estimates and strike phases). **The strike share (#421) is gone (#603):** holding 25% of a flat income out of captures measured no gain in the
    self-play arena (11 of 20 with it off), so `STRIKE_SHARE`, `planShare` and `PlanOptions.strikeShare` are removed. **The break spend (#421, owner decision of 2026-11-20):** on the pile (`pileOf`:
    adapting, not `defend` or No-Split, flat, my armies in view ≥ `STOCKPILE_TURNS` × income; `PlanCtx.pile`, any
    format) rule 4a's greedy runs the break of the strongest opponent's (highest income estimate, then id)
    cheapest visible bonus (every member in view, never a probable one; its cheapest member, then value, then id)
    before every other capture (`Candidate.spend`, moved ahead of the first capture; holds keep their places, and
    the held-bonus units still fund first at it) and never skips it as a second front, with a "Stockpile spend
    (#421)" line and the attack's reason naming it. Golden byte-identical; with the flat history injected, 12 plans
    changed (the line), none in their orders. **The all-in completion (#421, same decision):** on the pile, each
    contested bonus (`contestedBonuses`: positive, a member mine, every missing member in view beside mine, one an
    opponent's, none a teammate's) the plan does not complete, and #298 neither pushes nor drops, is planned all-in
    (`planPushed` → `planAttempts` with `PlanInput.stockpileAllIn`: #298's push, focused, its missing members bonus
    targets under `balanced` — an opponent's included — each an opponent holds sized for its owner's deploy, the push
    capped at the payback horizon × its value, not at my income: the armies already stand on the board). One the plan
    does not take whole is left out without a drop or a `bonusPush` entry (no failed attempt), and the pushes are not
    made when they would change a #298 verdict's outcome. A "Stockpile all-in (#421)" line names each. Golden
    byte-identical; with the flat history injected, 11 plans had a candidate and none was taken whole (8 over the
    cap, 4 not taken): no plan changed.
  - **One main front (#218).** The planner's front outlook (rule 2f) and the game outlook's front
    forecast use one pair (`mainFront`, `src/analysis/exchange.ts`: the biggest enemy stack next to me
    against my biggest beside it). The plan reports `front` (that forecast with my whole income and
    the opponent's estimate; both sides every turn's income, so a Reinforcement card played this
    turn is left out of mine, as it is of theirs), and `warapp_plan_turn` feeds it to the outlook for the turn being played,
    so the two read the same; the plan's line says how the whole-income outcome differs from the
    income-less-the-share one, and the outlook's `basis` names the front and the incomes it assumed.
  - **Trend:** with `previousBoard`, growth of a visible adjacent enemy stack projects into
    the threat (see the threat model above), and warns "is building" — less what a visible
    neighbour of the same owner sent (unless it shrank beside another player's shrinking stack:
    a fight, not a transfer), and at most its observed deploy with every ambiguous army
    read as deploy (`high`; #123: a transfer is a one-off, a stack walking in beside the fog is
    still massing — lesson 5).
  - **One-off movements are not income (#123, `observeDeploy`).** Growth on its territory next
    to the fog and the surplus of a capture whose visible attacker shrank are ambiguous: both read
    as deploy up to one bound, `HIDDEN_INCOME_FACTOR` (2) × what it was expected to deploy
    (visible income, plus the tracked/carried income, or the fog prior in the planner when no track is
    usable — so a steady hidden
    bonus is still seen; a carry only bound-cut readings reached ends at a later turn read in full
    that observed less) and at most what it could earn; beyond it, a stack out of the fog. A capture from me is
    priced at the guard unless my cached orders say what stood there. #271: a capture of a neutral in view
    beside the fog needs `fewestAttackersToTake` attackers; what stands there beyond what its stacks in view
    sent is ambiguous the same way (`unseenAttackers`), and captures like it on `FOG_CAPTURE_MIN` (3) of the
    last `FOG_CAPTURE_TURNS` (6) turns are income in the tracker (`fogCaptures`: their attackers spread over
    the turns, a carry no quiet turn disproves); its stacks in view beside a capture, hidden the turn after,
    may have moved in (`arrivals`: never deploy, out of the stock and flow) — a known under-read: such a
    stack is claimed whether or not it emptied, and it is often hidden only because the capture took my
    territory and my sight with it, so a real deploy-then-capture beside it counts its surplus in `high` only. Each observed turn has a low–high range for the ambiguity. The
    tracker's `unexplained` armies leave out likely combat deaths (its stack and a neighbour of
    another player both shrank), and inferred bonuses must lie within `INFER_REACH` hops and be
    affordable — none listed when more than `MAX_LISTED_COMBINATIONS` fit.
  - **Lessons from three more lost games** (`tests/analysis/lessons-defensibility.test.ts`):
    - **Border value after captures (#18).** Triage runs before captures are known, so after
      the capture passes a conceded border in a bonus this turn's captures complete is kept —
      never withdrawn from, garrisoned from the leftover, warned when that still cannot hold.
      Since #122 a member of a bonus completed this turn that faces an enemy is garrisoned right
      after the completion, before later captures, when the hold pays as a held bonus's would.
      #265 (`src/analysis/plan/completed.ts`): a member that still falls to the enemy beside it once
      the captures land gets the leftover's first call (rule 5, when it covers the hold whole —
      before the worse-order holds, the strike stack and any comfort margin), and a combined
      capture it is a source of is first rebalanced at the same kills to leave armies on it — no
      more than its hold needs, never spending what another source kept back when the capture was
      built (the #121 keep, the #172 two-step hold, the #179 cover).
    - **Defensibility (#19).** A capture that completes a bonus is checked against the frontier
      it leaves: when holding the members a visible enemy could take next turn needs more than
      the next income, `balanced`/`defend` refuse it ("… indefensible …: not completed") and
      keep the armies for defence; `expand`/`complete-bonus` complete it with a warning. A
      completion's score is discounted by that defence cost (`DEFENSE_DISCOUNT`). **#422 (draft, owner
      approval pending): the payback exemption.** A completion whose losses — attackers its captures into
      the bonus lose this turn plus the armies left on the members that would fall — are at most the bonus's
      value is made anyway ("Complete bonus … (#422)"): it pays that value next turn even if it then falls.
      Such a bonus (`ps.paybackBonuses`, read through `paybackLive`: live while its line stands) keeps no
      conceded border, gets no #122 garrison or #265 call, and #288's leftover never rides onto a member it
      may lose. Golden: 16 of 6253 plans changed, all gaining that completion.
    - **Combined attacks (#17).** A target no single source can afford may be taken by two or
      more of my start-of-turn stacks in a fixed order (the first attacks only wear it down),
      with exact arithmetic — only at 0% luck under straight rounding (else skipped with a
      warning), and only for a target the passes already chose. `warapp_plan_turn` lists them
      in `multiSourceCaptures`; one that leaves a weak member of a bonus it completes short is
      rebalanced at the same kills (#265, above). `warapp_submit_turn`'s preview (`attackSizes`, #250) judges
      attacks on one target the same way, in the order listed, each against what the earlier
      ones leave (`facing`, `softener`, and each leg's own `expectedKills`; with luck an approximation at the
      expectation, where the chance stops at the first leg likely to capture and the legs after it are transfers), and warns "cannot capture"
      only when the whole sequence falls short — never sized as one stack, which rounds once.
    - **Frontier cost (#71, rule 4d).** Every capture's score pays for the frontier it adds:
      `NEUTRAL_BORDER_COST` per border it opens (minus per border it closes), plus, under
      `balanced`/`defend`, what a new enemy-facing border needs next turn to hold (R3's
      arithmetic; a completion's own members are left to R3's defence cost, never counted
      twice). The plan reports `frontier` (borders, enemy-facing, hold cost, next income —
      conceded borders are not in the hold cost); under `balanced`/`defend` an expansion that
      adds an enemy border without completing a bonus is undone when the hold cost would then
      exceed the next income and the start-of-turn hold cost ("Frontier grows faster than income"),
      except cheap land a static seat left beside a live stack that would take it (#281), and, with
      the guard off, an empty enemy territory whose border faces only what mine beside it already face
      (the exemption lives in rule 4d's check itself, `outgrows`, so it holds in rule 4e's non-contact
      fallback too, where rule 4d is still a veto).
      Except in the contact/late no-capture fallback (rule 4e, #114), where it is a cost instead:
      the survivors a capture leaves on a border it cannot hold next turn count as armies at risk.
      In that fallback a capture that completes a bonus this turn is never ranked last for opening a
      second front (rule 0p.2), and one whose bonus repays its cost within the payback horizon goes
      first among the affordable candidates (#240); every other keeps the cost order.
      **The 1v1 gate budget is a report only (#603).** `gateStop` (#297's veto) and #432's short-gates horizon
      (`plan/horizon.ts`, `SHORT_GATES_PAYBACK_TURNS`) are removed: each summed every gate's need with the opponent's
      one floating deploy counted on every gate, and the self-play arena measured no gain from either. The plan still
      reports `gates` (1v1 only; each gate's `needs` and `armies`, `conceded` marked, `need`, `onGates`, `deficit`,
      `income`, `short`; under Local Deployment pool-aware, #433, with `deployable`), with no warning. Rule 4d's
      veto stays, but its total (`frontierOf`) now counts the floating deploy once per opponent, at the border it adds
      most to (`needStack` per border plus the largest `need − needStack`; `experiments: ['legacy-frontier']` restores
      the old sum); a capture's score still pays each border's full need (`frontierDelta`). Capture payback is always
      `pc.paybackTurns` (`capturePaybackTurns` keeps the name).
  - **Game rules** (`docs/PLAN-PLANNER-4.md`, `tests/analysis/lessons-game-rules.test.ts`; the
    full-rung `settings` echo shows each):
    - **Kill rates (#28).** Every combat computation uses the game's offensive/defensive kill
      rates; only settings without them fall back to 60/70, with a warning.
    - **Local Deployment (#29).** With `localDeployments`, a held bonus's value is a pool
      deployable only on its own territories and only the rest of the income goes anywhere
      (pool rules read from the client bundle 2026-11-23, not yet seen live: `docs/WARAPP-API.md`; a 0-value bonus has no
      pool, base income — MinimumArmyBonus or territories ÷ BonusArmyPer — is free); `warapp_submit_turn` refuses a broken split.
      A bonus's own pool defends it (#103): its hold cost is judged net of the pool, the pool
      goes to its most threatened border and stays there, and a conceded bonus's garrisons are
      withdrawn only when one of its borders needs more than its pools plus every free army.
    - **No-Split (#31, #124).** With `noSplit`, a territory issues at most one attack or transfer
      (its best; the rest are dropped with a warning), and it sends the whole stack — this turn's
      deploys there included, less the guard (verified live with the guard off; whether the guard
      stays is unverified). A territory that must hold issues no order; a strike stack's one order
      goes to the strike before a small expansion. `warapp_submit_turn` refuses a split and warns
      when an order sends less than the whole stack.
    - **One Army Must Stand Guard, on and off (#165, #276).** `guardCase` (`src/analysis/profile.ts`)
      names the case and what it means for interior defence. The analysis profile carries it (`guard`,
      and the first note) only when the guard is off, so a guard-on plan is byte-identical;
      `warapp_plan_turn` puts `guard` first in its `profile`, on or off (`stated` false: the default,
      on). Off, the two-step look-ahead counts a stack two steps away whole (each step a simulated
      turn under the game's settings; `tests/analysis/guard-arrives-whole-276.test.ts`), and
      `warapp_list_open_games` names `One army must stand guard is off` as a rule (no longer a planner
      gap). Off (and not under No-Split), `src/analysis/plan/guard-off.ts` adds three rules, none of which
      fires with the guard on: (1) a **second line** — an interior member of a held bonus (every neighbour
      mine or a teammate's, not my commander's) within two moves of a visible enemy stack of at least
      `SECOND_LINE_STACK_INCOMES` (1) × my income keeps `garrisonSize` (the fewest one army cannot take:
      1 at 60/70) through the deploy book's `guardAt`, the shortfall deployed before the leftover
      (`fillSecondLine`; a warning when the income cannot reach it); #275's breach cost is a separate
      rule beside it; (2) a **raid one step deeper** — an empty territory beside me is taken when the
      empty enemy territory behind it breaks its owner's bonus (no Multi-Attack chain: the far one is
      #165's break next turn); (3) a **free retake** — an enemy territory beside me at 0 that
      `previousBoard` showed mine is taken back. (2) and (3) run right after #165's breaks, from spare
      armies, else topped up with a deploy; on a player's territory each is sized for its owner's deploy
      there (#120, from the issue's evidence: the one raid tried in a lost guard-off game met a reinforced
      territory; the raid one army more), and goes at its bare size (`RAID_ARMIES` 2, or 1) with #120's
      "assumes" warning only when nothing covers that
      (`tests/analysis/guard-off-second-line-276.test.ts`).
- **The border guess (`src/analysis/guess.ts`, `warapp_plan_turn`'s `guess` / `guessOrders`)** is a
  randomized deploy split against an opponent who would read a fixed one: pure and deterministic like
  the planner (seeded by `guessSeed(game, turn, salt)`, mulberry32; the salt is a local secret at `<dataDir>/guess-salt`, `src/guess-salt.ts`, because the code is public), solved exactly as a small matrix game
  (allocations at threshold levels × the border the deploy lands beside, a simplex). Only when exactly
  one opponent has visible stacks next to 2–7 of my borders, combat is exact, Local Deployment is off,
  no fixed split holds them all and the mix beats it by `MIN_GUESS_GAIN` of the worth at stake. It
  redistributes only the plan's deploys on those borders and never changes the planner or the plan's
  `orders`; with no guess both fields are absent, and the skip reason is `guessSkipped` in `full` only.
  #274: the territory my commander stands on, and any a commander move of the plan walks it to, keeps the
  plan's deploy in every allocation (the planner's hold there is sized above this model's), and the draw goes
  through the submit's commander check: when it leaves the commander takeable where the plan's orders do not
  (`guessKeepsCommander`), the guess is dropped with a warning (`guessSkipped.reason: 'commander'`).
- **Options for the calling model (#606, `src/analysis/options.ts`, pure; DRAFT).** `warapp_plan_turn`'s `strategy: true`
  adds `strategy`: `options.captures` (`turnOptions`: each territory in view beside mine and not mine or a teammate's, its
  defenders, `needs` = `armiesToTake`, `needsIfReinforced` with its owner's whole deploy estimate landed, `from` — my
  territories beside it and their armies less the guard —, the bonuses it completes or advances, `incomeGain`, the new
  player-facing borders it opens; ranked by income per army, then the nearest advance, then cost; at most `MAX_OPTIONS`
  (15)), `options.holds` (each border facing a player: what to add against its stacks alone and against those plus one whole
  deploy, and what it protects), `alternatives` (`alternativePlans`: the default plan, then `planTurn` under
  `ALTERNATIVE_GOALS` (expand, defend), identical orders listed once, each with `stress` — `stressPlan` at the plan's own
  deploy estimates, no look-ahead, one reply per opponent: `safe`, `harmful`, `considered`, `worst`) and `STRATEGY_NOTE`.
  `available` (`FACTS_AVAILABLE`) names the facts the model can ask for, and `steps` (`OWN_PLAN_STEPS`) the tools to test and
  dig deeper with. **Facts on request (owner, 2026-11-27: the model should not always get all of it, but should know it
  can ask):** `facts` (any of `FACT_PARTS`) adds `facts`, only the parts named (`pickFacts` over `situation`,
  `src/analysis/situation.ts`, pure, report only): `me` (income, its history, land, armies, bonuses held), `territories`
  (every territory in view and each hidden one beside mine, nearest first: name, owner — `me`, `neutral`, `fog` or a
  GameFeed id —, armies, special units, bonuses, neighbours; at most `MAX_SITUATION_TERRITORIES` (400), the rest counted),
  `bonuses` (each positive bonus I touch or border or another player visibly holds whole: members by holder, `heldBy`,
  `missing`, `armiesToFinish` — `armiesToTake` summed, `null` with a hidden member —, `reachable`; at most
  `MAX_SITUATION_BONUSES` (60)), `opponents` (the plan's estimate with its source, visible and tracked figures, #368's
  range, frontier coverage, per-turn observed deploys; land and armies in view; bonuses held; stacks beside me), `changes`
  (against `previousBoard`: territories lost and gained, other players' stacks that changed) and `past` (the newest
  `SITUATION_PAST_TURNS` (10) boards `livePlanSetup` read — `pastBoards` — each side's land, armies and bonuses in view,
  and my orders that turn when kept). Every plan without `strategy` carries `more` (`MORE_ON_REQUEST`), one line naming
  both. The plan, its `orders` and every other field are unchanged (asserted); both off by default. An override is logged
  with its reason (#412), so the model's choices can be measured against the default.
- **The self-play arena (#603, `src/analysis/arena.ts`, `scripts/arena.mjs`, LOCAL research, never in CI).** Two bots play
  a whole 1v1 on a synthetic world-like map (`arenaMap`: a grid with some diagonals and cut links, bonuses of 2–6
  territories worth size − 1, neutrals of 2, a few wastelands of 10; three starts of 4; no luck, straight rounding,
  60/70, guard on, base 5, no cards), each turn resolved by `simulateTurn`, the first mover alternating; with `fog`
  each bot sees its own territories and their neighbours (`viewOf`). `plannerBot` calls `planTurn` as
  warapp_plan_turn does (adapting, its tracks and income history; an `onPlan` hook sees every plan), `spreaderBot`
  is a plain greedy expander. A game ends by elimination or at `maxTurns` on points (income, armies, territories).
  Pure and deterministic. `PlanOptions.experiments` names research-only rule switches (off by default, every plan
  byte-identical without them): `legacy-topup` (the #420 top-up on every non-primary border) and `legacy-frontier`
  (rule 4d's total sums every border's full need). Results and the smaller rule set: `docs/PLAN-STREAMLINE.md`.
