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

# The rest of the game — `warapp_strategy`

`warapp_strategy(game_id?, map_id?, topic?)` serves the notes below. With a game it picks the
notes whose condition fits the game's profile (`feedProfile`: format, settings and phase from
GameFeed alone — the standing needs the board, so notes for ahead and behind both apply until
`warapp_plan_turn` judges it) and adds map notes; with only a map it gives the map notes; with
neither, every note. The general notes are also the MCP resource `warapp://strategy`, and a map
this process has loaded is `warapp://strategy/map/{mapId}`.

Each note is marked **encoded** (where the server acts on it) or **advice only**, and with its
basis: *source* — the linked page states the idea; *derived* — our reasoning from the rule or
advice the linked page gives (the listed pages do not cover Local Deployment, No-Split, team
play or the effect of each card, so those notes are reasoned from the game rules and say so).
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
- `ffa-diplomacy` — truces free armies; guard against betrayal. **Advice only.** Source: FFA strategy.
- `ffa-big-stack` — fill behind a giant stack, wall it, or wait in the fog. **Advice only.** Source: FFA strategy.
- `teams-focus` — teammates attack the same opponent so its one income covers two fronts.
  **Advice only**, derived from the combat rules. Source: Combat basics.

## Settings

- `settings-efficient-sizes` — attack at the breakpoint; armies between breakpoints are wasted.
  **Encoded:** the planner sizes attacks at their breakpoints (`src/analysis/combat.ts`). Source: Combat basics.
- `settings-defend-with-three` — three defenders cost an attacker five, two only three (offered only at kill rates where those breakpoints hold, e.g. the default 60/70, and only with no luck and straight rounding).
  **Advice only.** Source: General strategy guidelines.
- `settings-poke` — a one-army attack can break an exact-size attack (offered only where one
  attacker kills one defender for sure: a kill rate of 50% or more, no luck, straight rounding).
  **Advice only.** Source: General strategy guidelines.
- `settings-move-order` — learn the move order and sort orders by when they should land.
  **Advice only.** Source: General strategy guidelines.
- `settings-move-order-zigzag` — orders zigzag between the players (first mover's 1st, second
  mover's 1st and 2nd, first mover's 2nd and 3rd, …); cyclic order swaps the first mover each
  turn. **Advice only**: the planner lists moves in decision order and does not yet schedule
  them. Source: Move order.
- `settings-attack-second` — against a comparable stack, attack second (a defender kills more
  per army), so list that attack late; offered only where the defensive kill rate is the higher.
  **Advice only**, derived. Source: Combat basics.
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
- `settings-local-deployments` — each bonus pays only inside itself. **Encoded:** deploy pools
  (`src/analysis/local-deploy.ts`). Derived. Source: General strategy guidelines.
- `settings-no-split` — a territory that moves sends everything, once a turn; stage armies
  ahead and do not move a territory that must hold. **Encoded:** one move per source, each sending
  the whole stack, and no move from a territory that must hold (#124). Source: No-Split mode.

## Cards

- `cards-piece-each-turn` — one capture a turn earns the piece; more earn nothing. **Advice
  only.** Source: Cards.
- `cards-order-delay` — delays only the orders listed after it; at the end of the list it does
  nothing. **Advice only.** Source: Order Delay card.
- `cards-order-priority` — only your first order runs before the opponent's first: withdraw
  from a doomed territory or strike a stack with that one order. **Encoded:** the planner's
  `cardAdvice` (`warapp_plan_turn`). Source: Order Priority card.
- `cards-blockade-own-bonus` — when weaker, blockade a territory in front of a bonus (not a
  member) to wall it; it resolves after the attacks and is lost with the territory. **Advice
  only**, derived; shown when behind or the standing is unknown. Source: Blockade and Emergency Blockade cards.
- `cards-turn-order` — the fixed order of card plays around deployments and attacks.
  **Encoded:** `writeSendOrdersParams` sends card plays in turn-phase order. Source: Turn phases.

## Reading the game

- `reading-count-armies` — the armies an opponent gains beyond losses are its income.
  **Encoded:** per-opponent deploy estimates, the tracked income's stock-and-flow term (visible
  army growth plus losses per turn, stacks out of the fog left out, #99) and the profile's standing. Source: Good 1v1 strategies.
- `reading-infer-bonuses` — deploys minus base income are the bonuses held. **Advice only**,
  derived. Source: Good 1v1 strategies.
- `reading-unseen-opponent` — under fog, assume an opponent out of sight earns about what you
  earn, and read its first big stack as saved income. **Advice only** (the planner's estimate is
  base + visible bonuses, or what it observed), derived; from the lost games of 2026-11-12/13,
  where the estimate ran 2–3× low. Source: Good 1v1 strategies.
- `reading-who-moves-first` — whose deployment or order runs first shows the first mover; under
  cyclic order it alternates. **Advice only.** Source: Move order.
- `reading-pick-zigzag` — picks are awarded in a zigzag in move order, so a territory ranked
  above your last granted pick that you did not get is an opponent's start (opening only).
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

## Map (general)

- `map-defensible-bonuses` — weigh a bonus by the cost to take and to keep it. **Encoded:** the
  map notes' ranking and entry points; the pick advisor's entry-point discount. Source: Good 1v1 strategies.
- `map-chokepoints` — hold the bottlenecks in front of your bonuses. **Encoded:** chokepoints in
  the map notes and `warapp_get_map`. Source: Good 1v1 strategies.
