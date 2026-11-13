# Strategy notes

What this server believes about playing war.app, written in our own words: first territory picks
(the pick advisor, `warapp_plan_picks`, scorer in `src/analysis/picks.ts`), then the rest of the
game (the strategy notes served by `warapp_strategy`, data in `src/strategy/notes.ts`). The community guides below
were the research for `docs/PLAN-PICKS.md`; they are linked, never quoted or copied. Each
heuristic says whether it is **encoded** (the scorer acts on it) or **not encoded** (advice for
the person reviewing the list).

## Sources

- 1v1 ladder picking guide — <https://war.app/Forum/434535-1v1-ladder-strategic-picking-guide>
- General strategy guidelines — <https://war.app/Forum/811395-general-strategy-guidelines>
- Good 1v1 strategies — <https://war.app/Forum/99097-good-1v1-strategies>
- FFA strategy — <https://war.app/Forum/621189-ffa-strategy>
- Combat basics (kill rates, how many armies a capture needs) — <https://war.app/wiki/Combat_Basics>
- Luck modifier — <https://war.app/wiki/Luck_Modifier>
- Cards (how card pieces are earned) — <https://war.app/wiki/Cards>
- Move order (the zigzag within a turn; random, cyclic and no-luck cyclic) — <https://war.app/wiki/Move_order>
- Manual distribution (how picks are awarded) — <https://war.app/wiki/Manual_distribution>
- Turn phases (the fixed order of cards, deployments and attacks) — <https://war.app/wiki/Turn_phases>
- Order Priority card — <https://war.app/wiki/Order_priority_card>
- Order Delay card — <https://war.app/wiki/Order_delay_card>
- Blockade and Emergency Blockade cards — <https://war.app/wiki/Blockade_and_Emergency_Blockade_Cards>
- Army cap — <https://war.app/wiki/Army_cap>
- No-Split mode — <https://war.app/wiki/No-split_mode>
- Multi-Attack — <https://war.app/wiki/Multi-attack>

A second pass on 2026-11-13 read several hundred more pages: the wiki's pages on every card, fog,
commanders, the guard, distribution, income, team games and commerce; forum threads on each topic; and
three community guides the wiki links to (a clan's strategy guide at <https://warlight.nghood.com/>, a beginner's guide
and a Small Earth guide published as documents). Each note below names the one page that states its idea
most directly; `src/strategy/notes.ts` (`STRATEGY_SOURCES`) lists them all.

# Turn resolution — `warapp_check_plan`

`src/analysis/turn-sim.ts` carries one turn out from every player's orders, and
`src/analysis/stress.ts` runs a proposed list of orders against the replies an opponent could
make with one deploy (`warapp_check_plan`). The rules are the wiki's, read on 2026-11-13 and
restated here in our own words; each is pinned by a test in `tests/analysis/turn-sim.test.ts`.

- **A battle** — the attackers kill the offensive kill rate × their number, the defenders the
  defensive kill rate × theirs, both at once, rounded to nearest. The territory is taken when
  every defender dies and an attacker lives, and all survivors move in; otherwise the survivors
  stay where they started. When both sides are wiped out the attack fails and one defender
  stands again. <https://war.app/wiki/Basic_combat>
- **The guard, and one move per army** — one army stays on every territory unless the game
  turns that off (an army that arrived this turn can be that guard), and each army attacks or
  transfers once a turn, so armies that arrived cannot be ordered on.
  <https://war.app/wiki/Gameplay_Basics>, <https://war.app/wiki/One_Army_Must_Stand_Guard>
- **Attack or transfer** — decided when the order runs, by who then holds the target: yours or a
  teammate's is a transfer, anything else an attack. Attack-only does nothing on a friendly
  target, transfer-only nothing on any other. <https://war.app/wiki/Transfer_Only>,
  <https://war.app/wiki/Team_Games>
- **The order of orders** — deployments first, then attacks and transfers interleaved in a
  zigzag over the turn's move order (1 2 … n, n … 2 1, 1 2 … n). An order that moves no armies
  takes no slot. <https://war.app/wiki/Move_Order>, <https://war.app/wiki/Turn_phases>
- **Order Priority** — its player moves first that turn: its first order runs before the
  others' first, and the rest of the turn is the usual zigzag from there. Two players who both
  play one cancel out. <https://war.app/wiki/Order_priority_card>
- **Multi-Attack** — armies may attack any number of times in a turn; armies that transferred
  are done. <https://war.app/wiki/Multi-attack>
- **Commanders** — a commander fights as 7 armies, takes damage only after the armies with it,
  cannot be partly damaged (7 in one battle kills it), and its death eliminates its owner: all
  it held turns neutral. It moves only when an order takes it along, never onto a teammate's
  territory, and it is not the army that stands guard (the developer's 2022 update note: to
  attack out of a commander's territory that holds no armies, deploy two).
  <https://war.app/wiki/Commanders>,
  <https://war.app/blog/index.php/2022/10/update-5-21-tanks-mod-improvements-commander-improvements/>

**Assumed, because the wiki does not say** (the result names each one it relied on): an order
sends what its territory can still move when that is fewer than ordered; an order from a
territory captured earlier in the turn does nothing; losses on a territory that is attacked
fall first on the armies that could still move; with the guard off, two sides wiped out in one
battle still leave one defender. **Not exact** with luck or weighted-random rounding: each
battle is then resolved at its luck-free, straight-rounded expectation and the result says so.
**Not modelled:** the Limited Attacks mod (a cap on orders per turn).

**What the stress test tries**, per opponent, with its whole estimated deploy in one place: an
attack from each stack (its commander with it) on each territory of mine it touches (now, or
after my own orders); sitting on a territory I attack; and every stack attacking at once, both
spread over different targets and concentrated on the most valuable. Each is run with me moving
first and with the opponent moving first unless the first mover is given. The opponents are
whoever holds a stack on the board, whatever GameFeed says of the player. **Not tried:** stacks
hidden by fog (armies included), a deploy above the estimate, a split deploy, opponents acting
together, a chain of attacks under Multi-Attack, and cards other than my own Order Priority —
so "safe" only ever means safe against these, and when no reply could be tried the answer is
"nothing tested" (`safe: null`), never "safe".

**One turn ahead (`exposedNextTurn`, #156).** A territory no enemy stack touches today can be a
border tomorrow. For each stack, each territory beside it that it can take this turn (mine or
neutral) and each territory of mine beyond that one, both turns are carried out: the stack takes
the one in between with its deploy, then attacks on with the survivors and its next deploy, while
I add nothing. A territory that falls is listed with the armies it would need to hold and the
bonuses that go with it, the costliest first; when two paths reach it, the one that brings the
most armies is shown. It does not change this turn's `safe`.

# Territory picks

## How picks are granted

A game allows twice its territory limit in picks, but grants only the territory limit, in list
order, skipping territories another player was granted first. The grant goes round by round in
move order, the order reversing each round (a zigzag): each player in turn receives their
highest-ranked territory still free, and a list that runs out is filled at random (Manual
distribution, in Sources). The wiki states no maximum list length; the "twice the limit" cap
is this server's reading and fits a two-player game. So the list is two plans: the
first `TerritoryLimit` picks are the plan you want, the rest a fallback that still makes sense
when some of the first ones are lost. **Encoded:** the primary group is exactly the territory
limit and the fallback is disjoint from it, each group built by the same rule on its own: compact,
a 1v1 included, relaxed one hop at a time, with a warning, when the remaining picks allow nothing
tighter. The fallback is what covers a counter-pick — when the primary picks are taken, the next
ones are granted in order from it — so in a 1v1 it goes to a different area: among equally scored
compact fallbacks, the one farthest from the primary wins (never at the cost of its own
compactness). A fallback that outscores the primary is warned about.

## Heuristics

1. **Safety and room to grow before greed.** A pick set should not lose outright to one bad
   draw, and every pick should have neutral territory to expand into. **Encoded in part:** each
   group is compact by default, in a 1v1 as with more players (one cluster whose picks link up in
   steps of at most two hops, measured on the map graph `warapp_plan_route` uses) so its armies
   can support each other and the start has one front; when no compact group of the territory
   limit exists the limit relaxes one hop at a time, with a warning. A 1v1 primary spread over
   several bonuses against a counter-pick meant a frontier on each of them from turn 1, broken one
   at a time (#73); the fallback group is the counter-pick insurance instead. A pick is
   only worth what its own armies can capture next to it. **Not encoded:** judging whether a
   specific opponent's likely picks would trap yours (counter-picking needs their history).
2. **Income by turn.** Early income compounds: a bonus finished on turn 1 (a first-turn bonus,
   using the pick's starting armies plus base income) pays every turn after, and a pick that
   finishes a second bonus soon after is better still. A single-territory bonus pays at once.
   **Encoded:** a three-turn opening simulation credits each bonus by the turns it pays out,
   flags first-turn bonuses and single-territory bonuses in the reasons. Armies attack only from
   a territory held at the start of the turn that borders the target, plus that turn's deploys;
   armies on another pick never help, and captured armies wait a turn. Each pick's first reason
   names the bonus it anchors and when it completes (or how much of it is held by turn 3).
3. **Efficient bonuses.** Prefer bonuses that give the most income for the armies it takes to
   finish them, and that have few territories outside them to watch (entry points) — they are
   cheaper to hold. **Encoded:** captures are costed exactly at the game's kill rates against the
   neutrals' real sizes, and a bonus's worth is discounted per entry point — ×1/(1 + 0.05 ×
   entry points × hardness), twice as steep in a 1v1 (0.1 per entry point: the one opponent finds
   every way in), so there a bonus with few entry points wins ties against a wide one.
4. **Settings change the arithmetic.** Small neutrals make every neighbour cheap, so a pick
   bordering many small bonuses is strong; a wasteland inside a bonus makes it slow or not worth
   taking; harsh kill rates (e.g. 30% offence / 75% defence) make attacking players expensive, so a
   defensible bonus beats a contested one; luck adds a margin to every capture; base income and
   per-territory bonuses set the pace (with per-territory income on, the base is a floor:
   income is the larger of the two, plus bonuses). **Encoded:** all of these feed the simulation (neutral sizes
   from the live board when shown, else the settings), and assumed settings are stated as warnings.
   **Not encoded:** local deployments are modelled as pooled income (a warning says so).
5. **Many players: stay off the middle.** In a free-for-all the central, high-value bonuses draw
   several neighbours at once; a compact cluster on the edge of the map tends to survive and grow.
   **Encoded:** a pick's score drops with its centrality among the pickable territories, by more
   the more players there are (no penalty in a 1v1).
6. **1v1: do not put everything in one basket — but do not split the start either.** Ladder
   guides for small 1v1 templates spread picks over adjacent bonuses so one counter-pick cannot
   wipe the plan; on a large multi-continent map that leaves a frontier on every continent from
   turn 1. **Encoded:** by default a 1v1 primary is compact like any other, and the fallback, in
   another area, is the insurance (see "How picks are granted"). Only `spread: true` on
   `warapp_plan_picks` restores the old rule — usually worse on large maps: a pick may join the
   primary group by anchoring a bonus no other pick anchors, even when it is not within two hops,
   but only within four, unless a group spread farther scores at least 1.5× as much (or no bounded
   group exists), which is warned about. Either way the rationale states the group's real spread
   (the hops between its two farthest picks and the longest step linking them) and calls it
   compact only when it is.
7. **Read the opponent.** Strong picks depend on what the other player is likely to pick and
   where they will start. **Not encoded** — a later strategy phase (it needs their history).

## What the award shows

The award follows fixed rules, so the territories I start on, read against my own list, say things
about the other players before a single order runs (Manual distribution, Move order and Commanders,
in Sources). **Encoded** (`src/analysis/award.ts`; `warapp_plan_turn` and `warapp_check_plan` report
it as `award`):

- **Their starts.** A territory I ranked above a pick I was granted, and did not get, had been
  taken: it is another player's start. With two players it is the opponent's, and when my last
  granted pick is as far down the list as the award can reach, every start it has is known.
- **Who was awarded first.** With two players the award runs first, second, second, first, and so
  on. Some sets can only be granted to the first awarded and others only to the second; the rest
  say nothing. Every award that fits the start is enumerated, and only what holds in all of them is
  reported.
- **Who moves first.** Under a cyclic move order the award counts as turn 0, so the first awarded
  moves second on turn 1 and the order alternates after that. Reported as `award.firstMover`;
  `warapp_check_plan` still tries both orders unless told, because this rule is the wiki's and has
  not been checked against a live game.
- **Their commander.** A commander starts on its owner's first awarded territory. When every award
  that fits gives the opponent the same first territory of my list (always the case when my own
  first pick was refused), that is where it started. Reported, not acted on.

In a two-player game the proven starts that are still fogged are planned on as the opponent's
territory: with the starting armies on turn 1, when nobody has deployed, and with unknown armies
afterwards. The list is the one war.app read back (`warapp_submit_picks`, or `warapp_get_my_picks`
during distribution), kept at `<dataDir>/picks/<gameId>.json`; the award is read once, on the first
board, and nothing is inferred when the list cannot explain the start.

# The rest of the game — `warapp_strategy`

`warapp_strategy(game_id?, map_id?, topic?)` serves the notes below. With a game it picks the
notes whose condition fits the game's profile (`feedProfile`: format, settings and phase from
GameFeed alone — the standing needs the board, so notes for ahead and behind both apply until
`warapp_plan_turn` judges it) and adds map notes; with only a map it gives the map notes; with
neither, every note. The general notes are also the MCP resource `warapp://strategy`, and a map
this process has loaded is `warapp://strategy/map/{mapId}`.

Each note is marked **encoded** (where the server acts on it) or **advice only**, and with its
basis: *source* — the linked page states the idea; *derived* — our reasoning from the rule or
advice the linked page gives. A note is offered only in games where it applies: its condition
(`NoteCondition` in `src/strategy/notes.ts`) tests the format, the phase, the standing, the fog
level, the move order, the distribution, the kill rates, the guard, and which cards are in play.
Where a note describes something `warapp_submit_turn` cannot send — an attack-only or
transfer-only order, an order by percentage, an order that carries the commander or treats a
teammate as an enemy, an Order Delay above other orders — its text says so and points to the game
client. After they were drafted, the notes were checked a second time against the research by the
agents that did it, and 46 were reworded or given a narrower condition.
The pages were read on 2026-11-13; nothing is quoted. A second pass the same day checked the
rules of move order, pick awarding, turn phases, the Order Priority, Order Delay and Blockade
cards, the army cap, No-Split and Multi-Attack against their own wiki pages, and corrected
three notes that had them wrong (Order Priority moves only the first order; Order Delay only
delays the orders listed after it; under No-Split the whole stack moves).

## Map notes (computed, no extra traffic)

- **Bonuses by value per army** — each positive bonus's value over the armies it takes to capture
  every territory from neutral at the game's kill rates, luck and neutral size, with its entry
  points (the territories outside it that touch it). **Encoded:** `src/strategy/map-notes.ts`.
  Wastelands and picked territories are not known from the map, so every territory is costed as
  a neutral of the settings' size (an assumption the notes state).
- **Chokepoints** — articulation points, bridges between bonus clusters and narrow connectors
  (`findChokepoints`, as `warapp_get_map`). **Encoded.**
- **Income targets by turn** — while picks are open, the pick advisor's opening simulation run
  over the territories GameFeed's standing lists as pickable (its primary group only): the base
  income plus the bonuses that group completes, turn by turn. **Encoded**, as a pace to aim for.
  With no pickables listed there are no targets (#132: a simulation over every territory paced a
  start nobody could pick); `warapp_plan_picks` reads the live pickables.

## Format

- `1v1-break-bonuses` — at contact, cut income by taking a territory in each enemy bonus
  rather than trading armies. **Advice only.** Source: Good 1v1 strategies.
- `1v1-contact-ground` — foresee where you will meet; a bonus behind a narrow front is worth some
  income. **Advice only** (the map notes list the bottlenecks). Source: Good 1v1 strategies.
- `ffa-strike-last` — let rivals fight each other and move in after. **Advice only.** Source: FFA strategy.
- `ffa-pick-fights` — avoid a war on two borders at once. **Advice only**, derived. Source: FFA strategy.
- `ffa-diplomacy` — a truce frees armies; without chat a quiet border is often answered in kind; with chat fix
  the terms; guard against betrayal. **Advice only.** Source: FFA strategy.
- `ffa-big-stack` — fill behind a giant stack, wall it, or wait in the fog. **Advice only.** Source: FFA strategy.
- `teams-focus` — teammates attack the same opponent so its one income covers two fronts: the weaker
  opponent first, then the stronger. **Advice only.** Source:
  <https://war.app/Forum/394357-2-v-2-ladder-tutorial-final-earth>
- `ffa-leader-only` — With a clear leader who is not you, the smaller players lose by fighting
  each other. Attack a smaller neighbour only if its income added to yours would match the
  leader's; otherwise hold that border and attack the leader only where the exchange favours
  you. With three left, hitting the weakest hands the leader the game. **Advice only.** Derived.
  Source: <https://war.app/Forum/169693-keeping-players-game-longer>
- `ffa-hide-strength` — The armies neighbours see you deploy are what they count. Where fog
  hides it, deploy out of their sight and move up when you can spare the turn; everywhere, keep
  border stacks no larger than the hold needs: where every owner is visible, the largest player
  is the one the others combine against. **Advice only.** Source:
  <https://war.app/wiki/Advanced_Strategy>
- `ffa-peaceful-stacker` — The player at peace with both of its neighbours while they fight is
  the real leader. Rank opponents by the armies they have built as well as by income, and expect
  it to turn on the weaker neighbour when that fight ends. **Advice only.** Derived. Source:
  <https://war.app/Forum/4723-best-way-quality-ffa-games>
- `ffa-finish-or-spare` — A player you have broken but not eliminated has nothing left to lose
  and may throw every army at you. Either take its last territories, or do not cripple it and
  leave it able to fight someone else. **Advice only.** Derived. Source:
  <https://war.app/Forum/699119-kingmaking-reportableagainst-rules>
- `ffa-neighbour-leaves` — When a neighbour surrenders or is booted, its land turns neutral or
  passes to an AI, by the game's settings; any truce with it is gone. Neutral, it keeps its
  armies: lightly held bonuses there are cheap for whoever moves first, big stacks are not. An
  AI keeps fighting, and goes for nearby neutral bonuses first. **Advice only.** Derived.
  Source: <https://war.app/wiki/Surrender>
- `teams-score-team` — Judge your turn by what the team gains. Tying down two opponents while a
  teammate takes bonuses is a good trade even if you stay on base income all game; expanding for
  yourself instead of fighting there is the usual mistake. **Advice only.** Source:
  <https://warlight.nghood.com/>
- `teams-one-owner-per-bonus` — A bonus pays only when one player holds every territory in it.
  Settle who owns each bonus; the other teammate moves out all but one army, then the owner
  takes the territory with an order set to treat teammates as enemies (no card piece). Enter it
  in the game client: a plain order there is a transfer. **Advice only.** Source:
  <https://war.app/wiki/Team_Games>
- `teams-transfer-not-deploy` — You may transfer armies onto a teammate's territory but never
  deploy there. Pass idle armies across a shared border to the teammate nearer the fight: they
  are the teammate's from then on, and can be used from the next turn. **Advice only.** Derived.
  Source: <https://war.app/wiki/Team_Games>
- `teams-shared-hand` — A team holds one hand of cards between its players, with one limit on
  how many it may keep. Before you play a card, check which teammate's turn gains most from it
  and that it has not been played already: played by whoever commits first, it is gone for the
  teammate in the fight that decides the game. **Advice only.** Source:
  <https://war.app/wiki/Team_Games>
- `teams-reinforce-capture` — To strengthen a teammate's capture in the same turn, it captures
  with its first order and you transfer in at least one order later, marked Transfer Only so a
  failed capture leaves your armies home. Enter it in the game client: warapp_submit_turn sends
  plain orders, which would attack and take the territory. **Advice only.** Source:
  <https://war.app/Forum/139981-team-strategy-question>
- `teams-ai-teammate` — A teammate replaced by an AI plays no cards while a human is on the
  team, and may attack teammates to finish a bonus the team holds between them or one it is
  expanding into. Armies you transfer to it become the AI's: defend from your own territories
  behind its borders, and keep spare armies where it could attack you. **Advice only.** Derived.
  Source: <https://war.app/wiki/AI>

## Settings

- `settings-efficient-sizes` — attack at the breakpoint; with exact results armies between breakpoints
  are wasted (with luck or weighted rounding they buy a better chance).
  **Encoded:** the planner sizes attacks at their breakpoints (`src/analysis/combat.ts`). Source: Combat basics.
- `settings-defend-with-three` — three defenders cost an attacker five, two only three (offered only at kill rates where those breakpoints hold, e.g. the default 60/70, and only with no luck and straight rounding).
  **Advice only.** Source: General strategy guidelines.
- `settings-poke` — a one-army attack can break an exact-size attack (offered only where one
  attacker kills one defender for sure: a kill rate of 50% or more, no luck, straight rounding); with
  the guard on it is wasted on a territory holding a single army. **Advice only.** Source: General
  strategy guidelines.
- `settings-move-order` — sort orders into three groups: certain strikes and reinforcements first,
  answerable attacks last, the rest in between as the delay. **Advice only.** Source: General strategy
  guidelines.
- `settings-move-order-zigzag` — each round every player runs one order and the order of players
  reverses from round to round (two players: first, second, second, first, first, …), separately in
  each phase, deployments included; cyclic and no-luck cycle reverse the players each turn. The planner schedules its moves by it (#127), lists
  deploys next to the enemy first, and reports where a move put last lands; it adds no fillers. Source: Move order.
- `settings-attack-second` — against a comparable stack, attack second (a defender kills more
  per army): if you attack, list it last, and know that you lose the exchange if the stack has not
  attacked by then; attack first only as the first order on a turn you move first, and only if it
  beats the owner's whole income. Offered only where the defensive kill rate is the
  higher. **Advice only**, derived. Source: Combat basics.
- `settings-contested-neutral` — a 2-army neutral the opponent can also reach: capture it last
  with three, or early with four (offered at the 60/70 breakpoints with exact results).
  **Advice only**, derived. Source: Combat basics.
- `settings-army-cap` — at most income × cap armies; at the cap nothing arrives, a Reinforcement
  card still pays; spend rather than bank. **Advice only** (the income model does not compute the
  cap; `warapp_submit_turn` only warns), derived. Source: Army cap.
- `settings-multi-attack` — armies chain captures, so a threat is any stack that can reach, not
  only an adjacent one. **Advice only** (the planner's threats are adjacent stacks), derived.
  Source: Multi-Attack.
- `settings-no-luck-exact` — with no luck and straight rounding, results are exact. **Encoded:** `armiesToTake`. Source: Luck modifier.
- `settings-luck-guaranteed` — with luck, count only the kills the roll cannot remove and add a
  margin. **Encoded:** `winChance`, `guaranteedKills`, `min_win_chance`. Derived. Source: Luck modifier.
- `settings-weighted-rounding` — weighted rounding makes breakpoints uncertain. **Encoded:**
  `winChance` models it. Derived. Source: Luck modifier.
- `settings-local-deployments` — each bonus pays only inside itself; base income, territory income
  and Reinforcement cards go anywhere; a cut in income is shared evenly by the pools. **Encoded:**
  deploy pools (`src/analysis/local-deploy.ts`). Source: <https://war.app/wiki/Local_deployments>
- `settings-no-split` — a territory that moves sends everything, once a turn; stage armies
  ahead and do not move a territory that must hold. **Encoded:** one move per source, each sending
  the whole stack, and no move from a territory that must hold (#124). Source: No-Split mode.
- `settings-commander-protect` — Losing your Commander eliminates you and turns everything you
  hold neutral. Each turn, first check that no stack beside it could kill every army with it and
  deal 7 more in one attack; if one could, deploy on its territory. Orders sent here never carry
  the Commander, so do not move its armies away. Never Blockade its territory. **Encoded:** the
  planner holds its commander's territory before anything else and never carries the commander.
  Source: <https://war.app/wiki/Commanders>
- `settings-commander-strike` — An enemy Commander dies only to a single attack that kills every
  army with it and then deals 7 more; damage short of that leaves it unharmed. Killing it
  removes that player from the game, so when one stack can cover its armies, its 7 and what its
  owner may deploy there, make that strike first. **Encoded:** the planner strikes an adjacent
  enemy commander first, sized for its armies, its 7 and its owner's deploy. Derived. Source:
  <https://war.app/wiki/Commanders>
- `settings-commander-free-captures` — A Commander attacking alone fights as 7 armies and is
  unharmed by less than 7 damage, so it can take small neutrals at no cost. Orders sent through
  this server never include the Commander: an order from its territory sends only armies and
  thins its guard. Do this only when playing in the war.app client. **Advice only.** Source:
  <https://war.app/Forum/223845-commander-template-challenge>
- `settings-guard-off-taps` — With no army required to stay behind, a territory can be left
  empty, and any single army then captures it; against one defender a single attacker only
  trades. Send one army at empty enemy border territories to break bonuses, and keep armies on
  every border territory of a bonus you hold. **Advice only.** Derived. Source:
  <https://war.app/wiki/One_Army_Must_Stand_Guard>
- `settings-territory-income-threshold` — Income from territories replaces the base income only
  when it is the larger of the two, so more territories pay nothing until your count divided by
  the setting exceeds the base. Past that point each further group of territories is one army a
  turn, and cheap neutrals are worth taking for themselves. **Encoded:** the income model
  (`boardIncome`) takes the larger of the base and the territory income. Source:
  <https://war.app/wiki/Extra_armies_for_territories>
- `settings-negative-bonus` — A bonus worth less than zero cuts your income while you hold all
  of it, unless other bonuses on the same territories pay more than it costs, and you cannot
  give a territory up at will. Stop one territory short of completing it; if you hold it, a
  Blockade or Gift on one of its territories is the way out. **Advice only.** Source:
  <https://war.app/wiki/Negative_bonuses>
- `settings-commerce-army-price` — Unless the game sets a flat price, armies bought in one turn
  get dearer in steps, so the same gold buys more armies spread over several turns than saved
  and spent at once. Buy steadily, and save only for a turn that needs a bigger stack than one
  turn's gold can raise. **Advice only.** Derived. Source: <https://war.app/wiki/Commerce>
- `settings-commerce-cities` — Where the game sells cities: a city pays gold every turn to
  whoever holds its territory and is never destroyed, so a captured city pays the captor. Build
  far from any enemy, spread them (by default each further city on one territory costs more),
  and buy armies instead when an attack is near. **Advice only.** Derived. Source:
  <https://war.app/wiki/Cities_(commerce)>

## Cards

- `cards-piece-each-turn` — a turn with a capture of an enemy or neutral territory earns the turn's
  pieces (the settings say how many); more captures earn nothing, a teammate's territory does not
  count; take it when the pieces are worth more than it costs. **Advice only.** Source: Cards.
- `cards-order-delay` — delays only the orders listed after it; at the end of the list it does
  nothing; put it above every order that is not urgent. `warapp_submit_turn` writes the card after
  all the moves, where it has no effect (#127), so the note says to play it in the game client.
  Offered when Order Delay is in play. **Advice only.** Source: Order Delay card.
- `cards-order-priority` — only your first order runs before the opponent's first: withdraw
  from a doomed territory or strike a stack with that one order; wasted if you would move first
  anyway. Offered when Order Priority is in play. **Encoded:** the planner's `cardAdvice`
  (`warapp_plan_turn`). Source: Order Priority card.
- `cards-blockade-own-bonus` — when weaker, blockade a territory in front of a bonus (not a
  member) to wall it; it resolves after the attacks, is lost with the territory and multiplies armies
  moved in that turn. **Advice only**, derived; shown with a blockade card in play, when behind or the
  standing is unknown. Source: Blockade and Emergency Blockade cards.
- `cards-turn-order` — the fixed order of card plays around deployments and attacks (Spy-type
  cards before Reinforcement; Bomb, Emergency Blockade, Airlift, Gift in that order before any attack);
  offered when a card other than Reinforcement is in play.
  **Encoded:** `writeSendOrdersParams` sends card plays in turn-phase order. Source: Turn phases.
- `cards-count-arrival` — Count when each card arrives: it needs its pieces minus the starting
  pieces, earned at the per-turn rate only on turns with a capture, and is playable the next
  turn. With minimums equal to the pieces per turn this is exact per player; a team shares one
  hand and each capturing teammate is said to add pieces, so it fills faster. **Encoded:**
  warapp_strategy lists each card's clock for a game (`cardClock`, src/strategy/card-clock.ts).
  Derived. Source: <https://war.app/wiki/Card_minimums>
- `cards-opponent-reinforcement-due` — From the first turn an opponent can hold a Reinforcement
  card, add its armies to what they can deploy against you, every turn until you have seen the
  extra armies land. A card they have not played is still in their hand. **Advice only.**
  Derived. Source: <https://warlight.nghood.com/>
- `cards-reinforcement-play-or-hold` — Once you are in contact, play a Reinforcement card the
  turn you get it: armies left in the card do nothing. Holding it is right only for a reason -
  no enemy in sight and nothing worth spending it on, or to make the opponent undercount what
  you can deploy next turn. **Encoded:** the planner plays every Reinforcement card it holds.
  Source: <https://warlight.nghood.com/>
- `cards-delay-keep-threat` — An unplayed Order Delay is a threat in itself: once the opponent
  has spent theirs and you still hold one, no number of filler moves makes their late attack
  safe, so they must hold armies back. Play it on the turn it decides a fight, not on the first
  turn you can. **Advice only.** Source:
  <https://war.app/Forum/804335-keep-play-order-delay-card>
- `cards-delay-opponent-holds` — When an opponent may hold an Order Delay and you do not, do not
  attack lightly on every border: their delayed counter-attacks then hit your weakened stacks.
  Make one heavy attack, or defend and let their late stacks break on your defence. **Advice
  only.** Source: <https://war.app/Forum/412763-delay-card>
- `cards-bomb-hold` — Do not bomb just because you can. The card kills half of whatever stands
  there, so it is worth more the more the enemy stacks, and while you still hold it they cannot
  safely build one big stack. Spend it on the turn it wins a fight or saves a border. **Advice
  only.** Source: <https://war.app/Forum/148237-strategy-bomb-cards>
- `cards-bomb-target` — A bomb can only hit a territory next to one of yours. It lands after
  deployment and before every attack, so it also halves what the enemy deploys there that turn.
  Aim it at the stack you are about to attack or that is about to attack you, where halving it
  changes who wins. **Advice only.** Derived. Source: <https://war.app/wiki/Bomb_Card>
- `cards-bomb-split-stacks` — While an opponent may hold a Bomb, do not keep everything in one
  stack beside them: spread it over two or three territories. Deploying one step back and moving
  up also dodges the bomb (it strikes after deployment, before any move), but only when your
  move lands before their attack: you move first, or you play Order Priority. **Advice only.**
  Source: <https://war.app/wiki/Bomb_Card>
- `cards-bomb-commander` — A bomb is reported to halve only the ordinary armies and leave a
  commander unharmed (players and the developer say so; the wiki does not cover it). So a bomb
  on a commander's guard, then one attack big enough for what is left plus the commander, is a
  cheap kill - against yours as well. **Advice only.** Derived. Source:
  <https://war.app/Forum/152187-bombing-territory-commander>
- `cards-emergency-blockade-trap` — An Emergency Blockade can destroy an attack you could not
  survive: deploy on the territory the big stack must hit and play the card there, and the
  attackers meet your armies times the multiplier. If they do not attack, you have given away
  the armies and the territory for nothing. **Advice only.** Source:
  <https://war.app/wiki/Blockade_and_Emergency_Blockade_Cards>
- `cards-emergency-blockade-opponent` — When an opponent may hold an Emergency Blockade, size
  the wall before a big attack: their armies on the target plus all they can deploy, times the
  multiplier. Send a large stack only where even that cannot stop it. **Advice only.** Derived.
  Source: <https://war.app/Forum/721296-makes-template-strategic?Offset=120>
- `cards-blockade-spoil-bonus` — A bonus you cannot hold is worth ruining. Blockade one of your
  territories inside it that the enemy cannot take this turn: the big neutral left there denies
  them the bonus until they pay to clear it. **Advice only.** Source:
  <https://war.app/Forum/141245-ais-use-blockadegiftdiplomacybomb>
- `cards-blockade-size` — Size a blockade against what the enemy can bring. The wall is your
  armies there times the multiplier; unless breaking it costs more than their stack beside it
  plus a turn of their income, you have only given the territory away. A low multiplier rarely
  passes that test. **Advice only.** Derived. Source:
  <https://war.app/Forum/1125-proposal-blockade-card>
- `cards-blockade-commander` — Never play a Blockade or Emergency Blockade on the territory your
  commander stands on: special units count for nothing on a blockaded territory, so treat it as
  losing the commander, and with it the game. **Advice only.** Derived. Source:
  <https://war.app/wiki/Special_unit>
- `cards-airlift-defend` — An airlift lands before any attack, so its strongest use is defence:
  fly a stack onto the territory the enemy is about to hit and their attack runs into it. The
  flown armies cannot move or attack again that turn, so it does not set up an attack this turn.
  **Advice only.** Source: <https://war.app/wiki/Airlift_Card>
- `cards-airlift-opponent` — While an opponent may hold an Airlift, any territory you attack can
  be reinforced from anywhere before your attack lands. Count their largest stack you have seen
  as a possible defender, and attack where you would still win, or not at all. **Advice only.**
  Derived. Source: <https://war.app/Forum/721296-makes-template-strategic?Offset=120>
- `cards-diplomacy-starts-next-turn` — A Diplomacy card starts the turn after it is played. If
  you play one, your attacks on that player in the same turn still happen. Once you see one
  played on you it is already in force: attacks on that player do nothing, so take them out of
  your orders and plan for the turn it ends. **Advice only.** Derived. Source:
  <https://war.app/wiki/Diplomacy_Card>
- `cards-diplomacy-target` — Diplomacy pays only with two or more enemies. Play it on the one
  attacking you hardest, not on a strong neighbour who is leaving you alone, and not when you
  are the one winning the fights; use the quiet turns for something that border would not have
  allowed. **Advice only.** Source:
  <https://war.app/Forum/141245-ais-use-blockadegiftdiplomacybomb>
- `cards-sanctions-sign-and-timing` — Read the Sanctions percentage first: a negative one raises
  the target's income, so that card goes on yourself or a teammate. A normal one resolves at the
  end of the turn and cuts the target's income from their next turn; Reinforcement cards are
  added after it and still pay in full. **Advice only.** Derived. Source:
  <https://war.app/wiki/Sanctions_Card>
- `cards-gift-enemy-teammate` — In a team game a territory about to fall can be gifted to the
  attacker's teammate: by default the attack becomes a transfer and the bonus is not completed
  that turn. If the other team may hold a Gift card, a bonus-completing capture needs the option
  to treat teammates as enemies (set in the game client; this server cannot). **Advice only.**
  Source: <https://warlight.nghood.com/>
- `cards-spy-turn-ahead` — A Spy, Reconnaissance or Surveillance card shows its view next turn,
  so play it the turn before the decision it should inform: Surveillance to learn whether a
  bonus is held, Spy for one opponent's whole position, Reconnaissance for what stands behind a
  border you mean to attack or defend. **Advice only.** Derived. Source:
  <https://war.app/wiki/Spy,_Reconnaissance,_and_Surveillance_Cards>

## Reading the game

- `reading-count-armies` — the armies an opponent gains beyond losses are its income.
  **Encoded:** per-opponent deploy estimates, the tracked income's stock-and-flow term (visible
  army growth plus losses per turn, stacks out of the fog left out, #99) and the profile's standing. Source: Good 1v1 strategies.
- `reading-infer-bonuses` — deploys minus base income are the bonuses held (offered under normal
  fog, where deploys next to you show and owners elsewhere do not). **Advice only**, derived. Source: Good 1v1 strategies.
- `reading-unseen-opponent` — under fog that hides owners (not Light or Dense fog), assume an
  opponent out of sight earns about what you earn, and read its first big stack as saved income. **Advice only** (the planner's estimate is
  base + visible bonuses, or what it observed), derived; from the lost games of 2026-11-12/13,
  where the estimate ran 2–3× low. Source: Good 1v1 strategies.
- `reading-who-moves-first` — whose deployment or order runs first shows the first mover; under
  a cyclic (not random) order it alternates, and whoever was awarded first moves second on turn 1;
  under fog, the parity of your own deployments (or moves) before its first visible one of the same
  kind. **Advice only.** Source: Move order.
- `reading-pick-zigzag` — picks are awarded in a zigzag in move order, so a territory ranked
  above your last granted pick that you did not get is another player's start, and in a two-player
  game list number 2 × your starts shows them all (opening and expansion, not with automatic distribution).
  **Advice only**, derived. Source: Manual distribution.
- `reading-border-neutrals` — hold off on neutrals next to an enemy. **Advice only.** Source:
  General strategy guidelines.
- `reading-idle-armies` — walk backline armies to the front. **Advice only.** Source: FFA strategy.
- `reading-ahead` — ahead, trade and keep pressure. **Encoded:** 1v1 pressure when ahead (profile
  rule 0p). Derived. Source: Good 1v1 strategies.
- `reading-behind` — behind, avoid even trades and defend. **Encoded, revised by #72:** minimal
  sizes when behind on income; the defend goal only outside a 1v1. In a 1v1, behind on income
  means strike (break their bonuses before expansion that completes nothing — the owner's losses
  argued against passivity), and behind on armies means no trade below even (profile rule 0p).
  Derived. Source: Good 1v1 strategies; owner retrospective (#72).
- `reading-fog-owners-shown` — This fog level shows the owner of every territory, so an
  opponent's income is not a guess: add the bonuses it holds in full to its base or territory
  income. Only army counts are hidden, so follow what it earns and loses each turn to judge how
  large its unseen stacks can be. **Advice only.** Derived. Source: <https://war.app/wiki/Fog>
- `reading-fog-border-armies-hidden` — At this fog level even the territories next to yours show
  only their owner, never their armies. Do not size a hold or an attack from the board: reckon
  what the opponent can have there from its income and its losses, and keep a margin for what
  you cannot see. **Advice only.** Derived. Source: <https://war.app/wiki/Fog>
- `reading-fog-attacks-reveal` — Every attack on your own territory shows where it came from,
  whose it was and how many armies were sent, even out of the fog. One onto another player's
  territory shows its size only if it captured, and only where you can see that territory's
  armies. Note each with its turn: it fixes a stack you cannot otherwise see. **Advice only.**
  Source: <https://war.app/wiki/Fog>
- `reading-stack-arrival` — When a stack you saw goes out of view, count the turns it needs to
  walk to each of your borders and expect it from that turn on. Do not advance toward where it
  must be unless you are sure to move first; and when a deployment drops with no fight to
  explain it, add the missing armies to that stack. **Advice only.** Source:
  <https://war.app/Forum/140529-help-improving-gameplay>
- `reading-deploy-order-leak` — Deployments alternate like orders. When more of yours run before
  an opponent's first visible deployment than the move order allows, it has deployed somewhere
  out of your sight first, so its income is larger than what arrives at your border. **Advice
  only.** Source: <https://warlight.nghood.com/>
- `reading-pick-move-order` — Under a cyclic move order the pick award is turn 0: whoever was
  awarded first moves second on turn 1 and first on turn 2. If your k-th granted pick was number
  2k on your list you know which: k odd, you were awarded second and move first on turn 1; k
  even, the reverse. **Advice only.** Source:
  <https://war.app/Forum/427054-maximize-intel-before-t1>
- `reading-unpicked-starts` — A pickable territory nobody was granted turns into a neutral of
  the in-distribution size. When you see one still neutral at that size, cross it off the list
  of possible enemy starts; plan captures through it at that size, which is often more than an
  ordinary neutral. **Advice only.** Derived. Source: <https://war.app/wiki/Strategic_1_v_1>
- `reading-opponent-opening-pace` — Before you can see the opponent, price their best start:
  from the pickable territories you were not granted, work out which bonuses fall on turn 1 or 2
  and the income that gives by turn 3. Size your first borders against that pace, not against
  base income. **Advice only.** Derived. Source:
  <https://war.app/Forum/434535-1v1-ladder-strategic-picking-guide>
- `reading-commander-first-award` — A commander starts on the first territory its player was
  awarded. In a two-player game, if you did not get your first pick, the opponent was awarded it
  first and their commander is on it. If you got your first and third picks but not your second,
  their commander is on your second for certain only if you were awarded second. **Advice
  only.** Derived. Source: <https://war.app/wiki/Commanders>

## The opening

- `opening-pick-guarantees` — With two or more starts each in a two-player game you cannot lose
  both your first and second listed picks, nor both your first and third; losing the first gives
  you the second and third. So an area you must be in is secured by ranking two of its
  territories 1 and 2, or 1 and 3. **Advice only.** Source:
  <https://war.app/Forum/429801-pick-order-issue-1vs1>
- `opening-safe-with-neighbour` — A bonus is only as safe as the pickable territories that can
  reach it before it pays. If one neighbouring pick threatens the bonus you mean to take first,
  rank that pick among your top picks too: granted both, expand there freely; refused it,
  another player starts there. Ranked below your last granted pick, it tells you nothing.
  **Advice only.** Source: <https://war.app/Forum/42216-safe-picking-play>
- `opening-pair-order` — When two picks only pay off together and the opponent may want the same
  two, expect one each. Rank first the one that does better alone against the other: the one
  whose bonus is harder to break, or that reaches the other's bonus first. That is not always
  the bonus you are after. **Advice only.** Source:
  <https://war.app/Forum/434535-1v1-ladder-strategic-picking-guide>
- `opening-counter-stands-alone` — Pick a territory to break a bonus you expect the opponent to
  take only if its own bonus is worth finishing. If they are not there you must be able to carry
  on and take it yourself; a pick that is useless unless the guess is right leaves you one start
  short. **Advice only.** Source: <https://war.app/Forum/719814-alexclusives-clues>
- `opening-commit-speed` — Under no-luck cycle the pick order goes to the faster player: by one
  guide's account the clock runs from pressing Begin to committing, so committing early in the
  day is not what counts. The faster gets the first award and the first move on turn 2; the
  slower the award or two after it and the first move on turn 1. **Advice only.** Source:
  <https://war.app/Forum/664334-skill-evaluation-phakh-gokhn>
- `opening-wastelands` — A wasteland much larger than the ordinary neutrals makes its bonus
  slow: do not start in it or expand into it first, as its cost comes back only after several
  turns of that bonus's income. It is also a wall: between an enemy start and your bonus it
  protects; on your own way out it strands armies. A small one is just a neutral. **Advice
  only.** Source: <https://war.app/wiki/Medium_Earth_Traditional>
- `opening-automatic-no-intel` — With automatic distribution no pick list shows where the others
  are or who moves first, but the deal narrows it: where each bonus holds one start, theirs are
  in bonuses you did not get. Plan against the most dangerous of those until scouting rules it
  out, read the move order from first orders, and do not resign over the deal. **Advice only.**
  Source: <https://war.app/Forum/621318-favorite-cw-template-sead-analysis>
- `opening-first-turn-bonus-second-mover` — Finishing a bonus on turn 1 can cost it on turn 2:
  an enemy start one move from its border can arrive with its stack and a full deploy, and if
  they move first on turn 2 you cannot answer in time. Unless you know you move first on turn 2,
  with such a start possible finish a turn later or hold the approach first. **Advice only.**
  Source: <https://war.app/Forum/551071-small-earth-series-nauzhror-vs-sanmu-shamu>
- `opening-one-bonus-at-a-time` — Do not split a turn's income between two unfinished bonuses:
  both then finish later. Put it all into the bonus that completes soonest, and split only when
  each share finishes something this turn or one share is needed to hold a border. **Encoded:**
  the planner commits to the bonus closest to completion until one is held (rule 4f). Source:
  <https://docs.google.com/document/d/e/2PACX-1vS5eO54w3LgnkcwbLqM3DhynuQGoChrPn313QXIMm0QZ3ApILPuvcunEdmG_nZflHKcfRwCpZfvHA8L/pub>
- `opening-capture-survivors` — Smallest sure captures and what moves in: 3 armies take a 2 and
  2 move in; 5 take a 3 (3 move in); 6 take a 4 (3); 8 take a 5 (4); 16 take a 10 (9). One army
  more adds a survivor, not a kill, so send it only when that survivor has a job next turn.
  **Advice only.** Derived. Source: <https://war.app/wiki/Combat_Basics>
- `opening-chain-captures` — Plan a route, not single captures: the survivors of one capture
  launch the next. Size the last capture at its minimum and each earlier one to deliver what the
  next needs, plus the army that must stay behind where one must, so a single deployment carries
  down the whole chain. **Advice only.** Source:
  <https://war.app/Forum/664334-skill-evaluation-phakh-gokhn>
- `opening-tap-then-capture` — Two orders can take what one cannot afford: a 1-army attack first
  kills one defender, so the capture behind it needs fewer armies (a 3 falls to 1 then 3 instead
  of 5; a 5 to 1 then 6 instead of 8). Losses are the same; it costs an extra order and one
  survivor fewer. **Advice only.** Source:
  <https://war.app/Forum/664334-skill-evaluation-phakh-gokhn>
- `opening-hide-expansion` — Where the opponent sees only territory next to their own, they
  learn your income from what you deploy and capture in their sight. Finish bonuses out of view,
  take the territory that touches them as late as the plan allows, and deploy out of sight when
  the armies can walk up in time. **Advice only.** Source:
  <https://docs.google.com/document/d/18vq7hPEy3WORXujZJiQVgRPCdaQ-iys9RmFNv7_yq7U>

## Timing: the order of orders within a turn

- `timing-first-order-certain` — On a turn you move first, your first attack or transfer runs
  before any of the opponent's, unless it plays Order Priority. Give it to the order that must
  not be answered: a strike that beats the defenders plus their owner's whole income and any
  card armies, a stack leaving a lost territory, or a reinforcement that must arrive. **Advice
  only.** Source:
  <https://docs.google.com/document/d/e/2PACX-1vS5eO54w3LgnkcwbLqM3DhynuQGoChrPn313QXIMm0QZ3ApILPuvcunEdmG_nZflHKcfRwCpZfvHA8L/pub>
- `timing-reinforce-first` — List reinforcing transfers at the top of the turn, the largest or
  the one to the weakest territory first, and as one order rather than several small ones: every
  enemy order that runs before they arrive is a chance to hit that territory without them.
  **Advice only.** Source: <https://war.app/wiki/Advanced_Strategy>
- `timing-dummy-must-move` — A dummy order pushes your later orders back only if armies actually
  move. A Transfer Only that cannot transfer, or an order from a territory with nothing left to
  send, delays nothing: pad a late attack with real transfers of spare armies or cheap captures.
  **Advice only.** Source: <https://war.app/wiki/Move_order>
- `timing-delay-pairs` — Orders run in pairs: moving first, your 2nd and 3rd run back to back
  (then 4th and 5th); moving second, your 1st and 2nd. So one more dummy order helps only every
  other time. Count the orders the opponent can make, pad a late attack just past that (one
  extra if unsure who is first), and keep the other armies at the front. **Advice only.**
  Derived. Source: <https://war.app/wiki/Move_order>
- `timing-deploy-border-first` — Deployments are dealt out in turn like orders, so their order
  is information. Deploy next to the opponent first and in the back afterwards: a deployment out
  of its sight that lands before your border one tells it you had income to spare, and lets it
  count how much. **Advice only.** Source: <https://warlight.nghood.com/>
- `timing-transfer-only-reinforce` — When you move armies into a territory of yours that the
  enemy could take first this turn, make the order Transfer Only: if it has fallen, the armies
  stay put instead of attacking the stack that took it. Set this in the game client:
  warapp_submit_turn sends plain attack/transfer orders, which would attack. **Advice only.**
  Source: <https://war.app/wiki/Attack_Only_and_Transfer_Only>
- `timing-attack-only-retake` — To answer an attack you only suspect, give a late Attack Only
  order onto your own threatened territory from a neighbouring stack big enough to beat what
  would survive taking it: it strikes only if the territory fell. Enter it in the game client:
  sent by warapp_submit_turn it is a plain transfer. **Advice only.** Source:
  <https://war.app/Forum/4440-usefulness-attacktransfer-orders>
- `timing-percentage-remainder` — A percentage order is worked out when it runs, from the armies
  still able to move, so an enemy attack that lands first shrinks what it sends, not the share
  that stays. Use one when the armies left behind matter more. Enter it in the game client:
  warapp_submit_turn sends fixed army counts. **Advice only.** Source:
  <https://war.app/wiki/Percentage_attacks>

## Fighting: stacks in contact, ahead and behind

- `fighting-trade-zones` — Size an attack on a stack against its armies after its owner's
  deployment. Below roughly seven sixths of that number you lose more than you kill; from there
  to about five thirds you kill more without capturing, still a good exchange; above that you
  capture (small stacks a little sooner: three take two). **Advice only.** Derived. Source:
  <https://war.app/wiki/Combat_Basics>
- `fighting-ahead-worst-case` — Ahead, pick the plan that still works when the opponent guesses
  right: holds that survive its whole income, attacks sized for its full deployment, and no more
  armies than each objective needs. Time is on your side, so the gambles belong to the player
  who is behind. **Encoded:** warapp_check_plan runs a list of orders against the opponent's
  single-deploy replies. Derived. Source:
  <https://docs.google.com/document/d/18vq7hPEy3WORXujZJiQVgRPCdaQ-iys9RmFNv7_yq7U>
- `fighting-doomed-stack` — A stack that is wiped out on defence kills fewer armies than it
  loses. If the attackers in reach can take it even after your deployment, do not reinforce it:
  move it back to where it can be joined, and spend the income on a break where the opponent is
  weak. **Encoded:** the planner concedes a border it cannot hold and withdraws from it. Source:
  <https://war.app/Forum/2557-need-battle-tactics>
- `fighting-pin` — Where, counting both sides' deployments, each exchange leaves your stack
  larger relative to theirs, keep attacking even at a small loss: a defender that is only just
  holding cannot deploy one army elsewhere without losing the territory a few turns later. Stop
  the turn the ratio stops improving. **Advice only.** Source:
  <https://war.app/Forum/664334-skill-evaluation-phakh-gokhn>
- `fighting-cover-valuable-attack-cheap` — When you can cover only one of two threatened points,
  cover the more valuable one most turns but not every turn; when you can hit only one of two,
  go for the less valuable one more often. Always guarding the big bonus, or always striking at
  it, is a pattern the other side can plan around. **Advice only.** Source:
  <https://warlight.nghood.com/>
- `fighting-standoff-grow-elsewhere` — Once two big stacks face each other and neither can break
  through, more armies on that border change nothing. Put the surplus into a bonus the opponent
  cannot see or reach, provided everything you hold still survives its full deployment. **Advice
  only.** Source:
  <https://docs.google.com/document/d/1YAoH8zzh7uk9-jQwuYzwGll0hsPukq1u8P2lHrTMoqo>
- `fighting-go-round` — Stuck at a walled border, look for the other way in: a wasteland beside
  a blockade is often the cheaper obstacle, and a neighbour that touches the enemy bonus in two
  places makes the defender guess. Do not spend the main stack breaking a large blockade when
  another route or bonus pays sooner. **Advice only.** Source:
  <https://docs.google.com/document/d/18vq7hPEy3WORXujZJiQVgRPCdaQ-iys9RmFNv7_yq7U>
- `fighting-hidden-stack` — A transfer between two territories the opponent cannot see is
  invisible to it. Build a stack one step behind the front and, on a turn you are sure to move
  first, transfer it with your first order into the territory its stack is about to take, enough
  to make that attack fail. If it falls first, the transfer is an attack. **Advice only.**
  Source: <https://war.app/Forum/664334-skill-evaluation-phakh-gokhn>
- `fighting-trade-bonus-up` — If the stack attacking your bonus stands on a territory of a
  richer bonus of its own, hold a stack back, pad your list, and take that territory with your
  last order once its armies have left: you lose the smaller bonus, it loses the bigger. It
  works only if the stack attacks; send no more than you can afford to lose if it stays.
  **Advice only.** Source: <https://war.app/Forum/664334-skill-evaluation-phakh-gokhn>

## Map (general)

- `map-defensible-bonuses` — weigh a bonus by the cost to take and to keep it. **Encoded:** the
  map notes' ranking and entry points; the pick advisor's entry-point discount. Source: Good 1v1 strategies.
- `map-chokepoints` — hold the bottlenecks in front of your bonuses. **Encoded:** chokepoints in
  the map notes and `warapp_get_map`. Source: Good 1v1 strategies.
