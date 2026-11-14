// Turn planner: deploys and moves for one turn, from one player's view of a
// board. Pure and deterministic (every choice tie-breaks on ascending id); no
// I/O. Advisory only — it never submits orders.
//
// Where each rule lives. `planPass` (below) runs the phases in order; each phase is a module
// under src/analysis/plan/ taking `(ctx, state)`:
//   constants, types, 3. capture cost (#126), fog, deploy estimates .. plan/shared.ts
//   estimates, the enemy estimates and the plan context ........ plan/estimates.ts
//   the deploy book (budget, guard, deploys, pools) ............. plan/orders.ts
//   1. defence, 1t. trend ....................................... plan/threats.ts
//   1a. triage, 1k. my commander, 1h, 1b, 1c, 1g / #122, #172 .. plan/holds.ts
//   2. targets, 4. bonus scoring, 4d. frontier cost, 4f / #101 .. plan/targets.ts
//   R3 / 4b, No-Split, 3a. combined, 3b / #121, passes 1 and 2 .. plan/captures.ts
//   1e, 1s, #165, 0p.3c strike stack, #102 spend, #167 lead ..... plan/strike.ts
//   4e. never stand still ...................................... plan/stand-still.ts
//   5. the leftover deploy, 3b's short borders (#121) ........... plan/leftover.ts
//   6. transfers, #125 staging ................................. plan/transfers.ts
//   7. move order, rule 1s's Order Priority ..................... plan/move-order.ts
//   7r. reports, the offence report, 1i (#109), the final plan .. plan/report.ts
// Rule 1k's commander reserve is read by every phase that spends armies: captures, strike and
// stand-still keep what holds my commander's territory. `byNum` and `pct` live in plan/util.ts.
// plan/shared.ts is a leaf (it imports no phase and not planner.ts), and the phases import one
// another for types only, so the import graph has no cycle.
// Still inline in planPass (ordering dependencies on the shared state): rules 0p.1 / 0p.2 and
// 4a's `balanced` greedy, pass 3, 4g card pieces, rule 4c's guard, No-Split's whole-stack carry
// (#124), and S2's efficient sizes with their #120 warnings.
//
// Rules, in decision order:
//  0p. Game profile (`gameProfile`, src/analysis/profile.ts), computed on every plan and
//     returned as `profile`: format (1v1 / ffa / teams), phase (opening / expansion /
//     contact / late; in an FFA, contact only when an enemy stack as it stands can take a
//     territory of mine or most of my borders face enemies, #132), standing (my income against the strongest opponent's estimate:
//     ahead ≥ AHEAD_RATIO×, behind ≤ BEHIND_RATIO×, unknown when fog hides most of the
//     board) and the settings that shape strategy. Only with `options.adapt` and no `goal`
//     does it change the plan (each rule a rationale line when it fires):
//       1. 1v1 in contact: a break is weighted like a completion of equal value (weight 1),
//          and an advance (expansion that completes no bonus) ranks below every hold, unit,
//          break and completion, and never defers a hold for the expansion share.
//       2. FFA with two or more opponents left: no second front — a break (also from a held
//          border, rule 4a) against a player that can take no member of a bonus I hold next
//          turn and loses nothing to this turn's strike / finishing off is skipped when a
//          neutral bonus capture scores at least SECOND_FRONT_SIMILAR × its score per army.
//          Finishing off (rule 1e) and strikes (rule 1s) are untouched.
//          #167, scaled by my army lead (my visible armies and special units over the largest
//          opponent's in view): the neutral needs SECOND_FRONT_SIMILAR × the lead (at least 1×, at
//          most SECOND_FRONT_LEAD×) of the break's score; above SECOND_FRONT_LEAD× the rule is off,
//          here and in rule 4e. Visible armies only, so the lead counts only when I also lead the
//          profile's FFA ranking on strength (fog can hide a strong player behind one small stack).
//          A clear leader that is not me (the profile's FFA ranking: strength = armies +
//          STRENGTH_INCOME_TURNS × income, at least AHEAD_RATIO × the next player's) is never
//          a second front: the others combine against it. Lead strikes: above the lead, under
//          `balanced`, every enemy territory next to mine (no special unit, never one lowering income)
//          is attacked after the leftover deploy from the neighbour with the most armies beyond what
//          holds it once the target falls (#172's two-step keep too; never a hold, a conceded border,
//          my commander's territory or the strike stack; not under No-Split), when that covers an
//          attack sized for its defenders plus its owner's deploy there (rule 3's #120 sizing):
//          breaks first, then a step into a positive bonus, then cheapest, then id ("army lead: …").
//          #203: before that, such a territory in a positive bonus is a step into the bonus in the
//          bonus passes (rules 4, 4a, 4f) with the same sure sizing, funded from this turn's deploy
//          in rule 4f's order — the closest bonus's enemy member gets the deploy before a farther
//          bonus does ("… player P's member, taken on my army lead", whichever pass takes it). #212:
//          its source may be a border held under `balanced` (never my commander's territory): the
//          border keeps what holds it once the step is taken, the deploy covers the attack and the
//          hold together, and the hold is then funded ("T keeps N to hold its border …"). #214: or a
//          conceded border (never my commander's territory): this turn's deploy funds the attack
//          alone and its hold stays conceded unless rule 1c keeps it for a bonus completed this
//          turn ("T is conceded, but the deploy there leaves with the attack …"). Pass 2 takes such
//          a step alone only when the bonus cannot be completed whole with it last: taken first, it
//          could make rule 1c's guard refuse its sibling's completion (or leave the sibling to rule
//          4d), sinking the deploy into a conceded border for half a bonus. When it cannot, the step
//          is taken before or after the bonus's other steps, whichever plans more captures (a tie:
//          whichever leaves more of the deploy; a tie again: after), so it never crowds out a
//          sibling a held border funds for less. One those passes do not take is an ordinary enemy
//          territory again for every later rule
//          (rule 4e's fallback, 4g's card pieces, the lead strikes): its plain size, no sure sizing;
//          its "Not attacking" line still ends with why its bonus's step failed (the hold it had to
//          keep, the deploy that could reach it, or why no neighbour could attack).
//       2f. Front outlook (#167; adapting, contact and late phases): rule 4a's expansion share stands
//          only when the main front (the biggest enemy stack next to me against my biggest stack
//          beside it) is no worse than a stand-off with the income less the share deployed there each
//          turn (`forecastBorder`, src/analysis/exchange.ts: both owners deploy on the stacks every
//          turn, simulated with `simulateTurn`; "press" — I attack every turn — and "pressed"); ground
//          down so, the share is 0 this turn and holds come first. A front my stack breaks only if
//          pressed counts as one only when the orders already take that stack; otherwise the share
//          also goes when the border pins more than the income less the share (pressed, I am ground
//          down). A rationale line gives the outcome, the turn and the income the border pins.
//       3. Behind on income: pressure (rule 1e) is sized with no margin. Outside a 1v1 the goal
//          is `defend`; in a 1v1 (#72) it stays `balanced` — strike: rule 1's ordering puts
//          breaks before expansion that completes nothing, and held-bonus units that pay for
//          themselves still come first (rule 1h). Behind on armies in a 1v1 (my visible armies
//          and special units below BEHIND_RATIO × the strongest opponent's): no trade below even —
//          a combined capture of a player's territory whose attacks lose more armies than they
//          kill (its softeners each attack a stack larger than they can take) is not made.
//          Ahead in a 1v1: pressure is allowed up to AHEAD_PRESSURE_FACTOR typical
//          expansions (instead of PRESSURE_FACTOR).
//       3c. Concentrate (#72; adapting in a 1v1, facing the opponent): the leftover deploy (rule 5) goes
//          to one strike stack — an open border next to the strongest opponent (highest income
//          estimate, tracked when trusted), chosen by what it can take (#120): each border's best
//          strike this turn with the whole leftover on it (an adjacent target of that opponent sized
//          for its defenders plus what it may deploy there first, rule 3; never one that lowers
//          income) and the armies it then has to spare once it still holds; the border with the most
//          to spare wins (ties: more armies, then id), and a rationale line names it and the
//          bigger border passed over. With no border able to strike (and always under No-Split), the
//          border holding the most armies, as before — before any comfort margin;
//          the rationale names it and `offence` reports it as a strike. Holds still come first:
//          a border kept for a bonus this turn completes (rule 1c) is first topped up to a
//          comfortable margin, and any other open border that would fall to just hold. Only in a
//          1v1: in an FFA or team game (several fronts) the comfort margins keep the leftover.
//          Spend it (#102): every turn the stack attacks each adjacent enemy territory it can take
//          at the plan's win chance (ordinary capture sizing; never one that lowers income, re-checked
//          against the strike's own captures, which can complete a negative bonus only together),
//          breaking or retaking a bonus first (one the opponent holds in full, or one I held in full
//          on `previousBoard`; only the first member of a bonus to fall this turn breaks it, and a
//          retake that cannot finish this turn is "toward retaking"), then by that bonus's value,
//          then cheapest, then id — while what
//          stays on it holds against the threat left after those attacks (rule 1's arithmetic,
//          the captured territories gone), never below the opponent's deploy alone (orders
//          interleave: it may land on a target first; the target's survivors striking back after a
//          failed attack are not added — an approximation). No S2 top-up draws on that hold, and
//          the transfer step never moves it (its captures can leave it interior). Then (#120) each of
//          the stack's attacks on a player (its earlier breaks and counter-attacks first, then the
//          strikes in order) is sized for its defenders plus what the owner may deploy there first,
//          as rule 3 sizes one, while what stays still holds. Each attack
//          is a rationale line and an `offence` strike entry (target, armies, win chance, what it
//          breaks or retakes); a target not attacked is a strike entry with `taken: false` and why.
//          It only grows (deploy, no attack) when nothing in reach is worth taking: a rationale line
//          ("Grow the strike stack …") names each target and why. The stack's own entry is
//          `taken` only when it attacks this turn — also when it got no deploys (Local Deployment,
//          no room, or holds and captures took the whole income: the stack is chosen the same way
//          with no leftover, and a rationale line says none reached it): a strike stack, once
//          built, is spent.
//          #201: with no border able to strike this turn (not under No-Split), the multi-turn border
//          forecast (`forecastBorder`) chooses: the border whose stack, with the leftover and then the
//          income every turn, breaks the opponent's biggest stack beside it soonest (its owner
//          deploying there every turn), when that is not the border holding the most armies and
//          breaks sooner than it ("Strike stack on … (#201): no border can strike this turn; …").
//       3d. Decided (#201): given `options.outlook` (#178) reporting winning or losing, the game is
//          decided, and every payback test (PAYBACK_TURNS everywhere it appears in these rules)
//          counts the turns it has left instead: the loser's strength over the winner's income a
//          turn (winning: the strongest opponent's, its high when bounded — #208: its likely high,
//          called an estimate, when only that showed the win — over my income; losing:
//          mine over its income estimate), at least DECIDED_PAYBACK_MIN, at most PAYBACK_TURNS; a
//          rationale line ("Outlook (#201): …") says so. The strike stack's forecast uses it too.
//       4. An explicit `goal` always wins: none of the above, and the rationale says the
//          profile was overridden.
//  1. Defence. A visible enemy next to my territory T threatens it when
//     `armiesToTake(armies(T)) ≤ E + enemyDeploy`, where E is that player's
//     movable armies (minus the guard) summed over its territories bordering T.
//     #128: that one attack is not the whole threat. Separate stacks attack separately and
//     each rounds on its own (a 1-army softener kills 1 at 60%), so the threat is the single
//     attack equivalent to the most the stacks take sent one after another: Σ kills of the
//     softeners + what the last (the deploy on it) takes, best last stack (`forceAt`).
//     Opponents on one team attack together (their stacks and deploys combine); two FFA
//     players are judged alone, and a border that holds against each but not against both in
//     one turn gets a warning — except (#201) when I lead an FFA on strength (adapting, two or more
//     opponents left): the others may combine against the leader, so every adjacent opponent's
//     stacks and deploys count together, like a team's, and a rationale line names each border held
//     so ("I lead this free-for-all …"). Teammates (the game's team list) are never a threat, an
//     estimate or a target. Under Local Deployment an opponent's visibly held bonus pays
//     only into its own territories: what reaches T is its estimate less its visible pools
//     plus the pools that contain one of its stacks next to T. An enemy commander counts in
//     the expected attack too (rule 1h's near miss, kept garrisons).
//     enemyDeploy is estimated per opponent (`enemyDeployEstimates`): base
//     income (the larger of MinimumArmyBonus and, with BonusArmyPer on, its
//     visible territories / BonusArmyPer) plus the bonuses that player
//     visibly holds in full, never below max(MIN_ENEMY_DEPLOY, base income).
//     Its stack next to me is no part of it: a stack says how much can *move*,
//     never how much can be deployed (live, a 0.75 × 15 guess on an all-15
//     opening board made every base-income opponent look like ~11; and capping
//     the estimate at 0.75 × a small stack hid income held in plain view — a
//     +10 holder with a 2-stack on my border read as 5). On the opening board (every
//     visible player territory still holds the same count; neutrals aside, and only on the first
//     turn — no previous board, the turn unknown or 1, #128) every opponent gets the
//     floor. Given `previousBoard`, each estimate is at least the deploy observed since
//     then (`observeDeploy`, issue #57: the net change of its armies visible on both
//     boards — shrinks included, so a transfer between its own territories is not deploy —
//     plus, on each territory it captured from a visibly held or neutral territory, the
//     attackers the previous defenders killed at the game's kill rates, and its armies there
//     only up to what its visible-both-turns neighbours sent away (their shrink, each claimed
//     once, ascending id); the rest, when a neighbour was hidden, counts as deployed on the
//     visible stack that attacked when one did shrink into it (deploy-then-capture, #123, up to
//     what it could earn), else arrived from the fog (a move and a threat, never income, issue
//     #86), or counts as deploy when every neighbour was in view). One-off movements (#123):
//     growth on a territory it held both times next to a hidden one, beyond what it was expected
//     to deploy (its visible income, or the fog prior), is a stack walking in from the fog, not
//     income; a capture from me is priced at what the guard I may have left kills, never my
//     stack last turn (I may have attacked out of it). Each observation carries the low and the
//     high reading of those ambiguous armies, and a rationale line names them. A territory hidden last turn
//     (fogged, or under a fog level that hid its armies) is a fog reveal, never growth or a
//     capture (issue #69). The observed figure is capped
//     at what the opponent could earn on this board: its base income plus every bonus none of
//     whose territories someone else visibly holds, owner-only included (a warning says when). A rationale line names
//     the turns compared and the territories counted vs skipped as reveals; the warning
//     names which source won. Given `tracks` (`trackOpponents` over my board history, S3), an
//     opponent observed over at least TRACKED_MIN_TURNS turns gets its tracked income (the
//     larger of the most it was observed to deploy over its last three observed turns — each a
//     lower bound — and its visible army growth plus losses per turn less fog arrivals, capped at what it could
//     earn, floored at base + visible bonuses; #99, `trackedIncome` — and never decaying: an
//     earlier window's figure is carried until a bonus it visibly held is visibly broken, less
//     that bonus's value, and never above what it could earn; my own orders, when known, are
//     measurements; #119) in place of the
//     single-turn observed figure, and a rationale line says so; fewer turns change nothing.
//     The fog prior (#119, `EnemyIncomePrior`): when `game.symmetricStart` says every player
//     started even and it is a 1v1 (two players in the game, no teams; an FFA down to two is
//     not: a survivor may have absorbed the others), an opponent
//     bordering the fog (a territory next to one of its own shows no owner) is estimated at
//     least at my own income (card armies out), capped at what it could earn on this board —
//     every observed figure is a lower bound under fog, and the estimates read 2–3× low
//     against a finished game's true deploys without it. When the award of picks proved all its
//     starts (`game.opening`, #166), the prior is the larger of my income and the income the pick
//     advisor's opening simulation (`openingIncome`) gives it this turn from those starts. It only raises an
//     estimate; the warning calls it a prior, not an observation, and says which.
//     #164, exact income: under a fog setting that shows every owner (`OWNERS_SHOWN_FOG`: No, Light
//     and Dense fog, matched by name, never by the engine's order) on a board that shows every
//     territory's owner, an opponent's estimate is its base plus the bonuses it holds, exactly
//     (`source` 'exact', no MIN_ENEMY_DEPLOY floor; the opening board keeps its floor): observed,
//     tracked and prior figures are reported, not used — a deploy above it was a card or a misread.
//     Only the army cap, Sanctions and a Reinforcement card are unknown. #164, Reinforcement card
//     (`game.reinforcement`, the card clock): from the first turn one can be in a hand, its armies
//     are added to every opponent's estimate until a deployment above its income is seen (its low
//     reading over the exact income; under other fog, a jump of the card's armies over its visible
//     income), then again from the turn the next card can be due (the first turn plus a card's
//     capturing turns per card played, never before the turn after the play); a warning names it.
//     It is coarse both ways, and the warnings say so: one card at most is counted, though more may
//     be in hand after a long time due; and under fog, income the fog hides can read as a play, so
//     the card is dropped and the estimate errs low (a warning names the play it took, under exact
//     income too: armies that came into view or were misread can read as one).
//     #164, hidden stacks: an opponent's territory next to mine whose owner shows and whose armies
//     the fog hides (Dense / Heavy fog) is one of its stacks in rule 1's threat, of its unaccounted
//     armies (the tracker's `unexplained`, at most HIDDEN_POOL_INCOMES turns of its income, a
//     Reinforcement card left out; the guard alone without a track) — never unseen land and never a target (a warning says the win
//     chance is unknown). The pool is one: its first hidden stack next to a territory of mine
//     carries it, any other there the guard alone (movable 0).
//     A large stack that left view (the tracker's `lostStacks`, for LOST_STACK_TURNS turns after it
//     was seen: a stack whose territory the fog hid, or, under Normal fog, one that walked off a
//     territory still in view into the fog) is, from the turn it can stand on a territory the fog
//     hides next to mine (one move a turn since it was seen, never through my land), a separate
//     stack of its owner there in that border's threat (its armies less the guard; the larger of
//     the two when that territory is also a hidden stack of its owner; its armies are part of the
//     pool, so the pool's carrier on that border keeps only what the lost stacks elsewhere leave
//     of it, and at least a lost stack that can stand on the carrier itself), and
//     a rationale line names it. Under Normal fog every territory next to mine shows, so it never
//     stands there unseen: where it can stand beside a border of mine by next turn, a warning says
//     so a turn ahead (not counted in this turn's holds). #201: a capture of mine out of the fog fixes
//     where it is (the tracker counts it from the territory it took, on that turn). Arrivals assume one move a turn; with
//     Multi-attack on it can come sooner, and the lines say so.
//     #199: under Multi-Attack an attack's survivors carry on, so a visible enemy stack's chain
//     (chains.ts, shared with check_plan's stress test: its deploy that reaches it, less the
//     guard, luck-free, at most CHAIN_MAX_STEPS attacks deep) that takes one territory or more not
//     mine and then attacks a territory of mine — or one the plan captures (not the chain's own
//     player's: its stacks next to it already count) — is a threat there, the armies it lands; a
//     border's threat is the larger of that and its stacks next to it, and a territory no stack
//     touches can be a border by a chain alone. A chain through a territory the plan captures does
//     not count. The floor tier (#118) counts a chain of the stack's armies alone, no deploy, as
//     armies already next to a border. A warning names each chain that sets a border's threat
//     ("Multi-Attack chain: …"), and its player's deploy estimate is explained like a stack's.
//     `options.enemyDeploy` overrides all of them. Always a warning.
//  1t. Trend. Given `previousBoard` (my view one turn earlier), each visible
//     enemy territory next to me that was visible then (owner and armies, #69) under the same owner and
//     has grown is "building" at growth = armies now − armies then per turn, less what a visible
//     neighbour of the same owner sent (its shrink, claimed once: a transfer is a one-off, not a
//     trend; a neighbour that shrank beside another player's shrinking stack fought and sent
//     nothing) and at most its owner's observed deploy with every ambiguous army read as deploy
//     (#123, `high`: a stack that walked in beside the fog is massing all the same) (a
//     warning naming my most exposed neighbour and the armies it needs to hold
//     next turn and the turn after). A border's threat becomes movable +
//     max(enemyDeploy, the owner's fastest growth next to it), so its hold cost
//     and the leftover margin both use the projection (a rationale line says so).
//  1e. Finish off (under `balanced` and `defend`, before triage; issue #45). For
//     each visible opponent whose every territory is visible (none borders the fog)
//     and borders mine — fewest territories, then fewest armies, then id — size
//     attacks on its territories against its best response: its deploy estimate D is
//     ONE budget, split (in whole armies) over its territories to save as many as it
//     can. An attack that takes up to c defenders is saved by c − armies + 1 deploys
//     there; saving the cheapest first is optimal, so the sure falls are exact
//     (`guaranteedFalls`). Every sizing is searched: each territory attacked as if
//     0..D of the deploy lands there, or not attacked (all of them while there are at
//     most 1024 sizings, else evenly spaced shares, always including D), with the
//     usual capture rules (single and combined attacks, kill rates, luck, R3);
//     a softener in a combined capture never kills the defenders there now either.
//     Every opponent in reach is tried, not only weak ones. A sizing succeeds when every
//     territory falls for sure (elimination, so each attack is sized for all of D), or
//     when the sure falls leave it at most one territory or take at least half of it,
//     no attacking border faces a territory left unattacked, and every hold worth
//     paying for against those is funded. The best success wins: elimination, then
//     more sure falls, then fewer attacking armies, then a dearer cheapest save, then
//     fewer deploys. Holds that pass rule 1a's CONCEDE_FACTOR test against other
//     players (and against what a retry leaves unattacked) come first: an attacking
//     source keeps what holds it; on a border that attacks nothing, each hold, best
//     worth per army first, is deployed there while the attacks are sized when it fits
//     what is left (one that does not is left to triage), then released for triage to
//     deploy. When the best sizing fails only on an unfunded hold, the search runs once
//     more with those holds reserved and those territories left unattacked, and its
//     best is kept if it beats the first search's. With no success, nothing changes.
//     #179: under Local Deployment each territory is sized for the deploy that can reach it
//     (`deployReaching`: its bonus pools pay only into their own territories), and a target whose
//     save needs more than that falls for sure (`guaranteedFallsReaching`). Unless I am known to
//     move first, an elimination is first tried covering its exits onto my land: each territory
//     of mine next to it holds against its stacks there plus that deploy (as if halved by a Bomb
//     first when an opponent may hold one, #163; a source keeps it and
//     what its attack would lose defending; a border that attacks nothing is deployed to), and
//     keeps it through the later passes (`coverKeep`); unaffordable, it is planned uncovered with
//     the move-order caveat ("Cover player …'s exits"). In an FFA (two or more opponents) an
//     elimination is priced first: the players its land makes me border and the frontier cost
//     before and after (`frontierDelta`, its threat gone); a buffer whose removal costs more than
//     a turn of my income and more than PAYBACK_TURNS × the income its land adds is left standing
//     ("Not finishing off player …"), and no pass takes its territories this turn.
//     #201 (adapting, an FFA with two or more opponents and a leader on strength that is not me): a
//     player smaller than me, not the leader, is finished off or pressed only when its income added
//     to mine reaches the leader's ("Absorb player …"); otherwise it is left standing the same way
//     ("Not finishing off player … (#201)"), no pass takes its territories, and its "Not attacking"
//     reason says so: the armies are better spent with the others against the leader.
//     An opponent bordering the fog is never eliminated (issue #60): it is pressured
//     instead — every visible territory attacked, each sized for its full deploy plus
//     pressureMargin (an attack sized for exactly the estimate failed live), and
//     only when all of them fall for sure ("Pressure player …: take all N of its visible
//     territories …, so this is not an elimination", with a warning that it may hold more
//     in the fog) — when each of those margin-sized captures costs at most PRESSURE_FACTOR × a typical
//     expansion capture (the median capture cost of the visible neutrals next to me; with
//     none, any cost), or (#120) is paid outright from the armies already on one of my
//     territories next to it beyond what holds it (no deploys; each source pays once; never under
//     No-Split, where it takes that source's one order): it then displaces no expansion, and a
//     rationale line names the source ("… is paid from idle armies on …"). Otherwise it is not attempted (a warning says so when its visible
//     territories could all be taken); with fog anywhere else, the
//     elimination is hedged ("if it holds nothing in the fog") and a warning says it
//     may hold unseen territories. When it can save some attacked territories, a
//     warning says it chooses which. Borders next to the attacks are then re-judged
//     without the territories attacked, and triage judges each border by the armies
//     that stay on it. A border held last turn (per `previousBoard`) by a weak opponent
//     (fully visible, fewer territories than mine, deploy below my income) that
//     threatens it now is never conceded economically (the rationale says so once its
//     hold is deployed); under `balanced` its hold goes first.
//  1a. Triage (every goal). Each threatened border's protected value is the sum
//     of my complete bonuses containing it, plus incomplete bonuses containing it
//     that I would lose all access to without it, plus (#122) its share of every other
//     incomplete bonus containing it that I am building — value × the members I hold ÷ its
//     size, one decimal, when every missing member is a visible neutral and finishing it passes
//     rule 4's economy tests (PAYBACK_TURNS, WASTELAND_FACTOR) — plus the per-territory
//     income it carries (each bonus counted once). Its worth adds the armies a
//     hold saves, in income terms (armies / PAYBACK_TURNS): a top-up that keeps a
//     big stack is worth paying even for a small bonus (live, a 60-army border
//     protecting +4 needed 20 and held against 105). Its hold cost is the fewest
//     deploys making `armiesToTake(armies + d) > threat`. Every border facing one
//     opponent is sized for that opponent's whole deploy (#69): it picks where to land
//     after I commit, so that is each border's worst case, and a sure hold of several
//     needs each sized for it (a rationale line says so when two or more are held
//     against one player); a held bonus whose borders cannot all be sized so is floored and
//     kept rather than conceded (rule 1h's floor tier, #118). Borders are taken in
//     order of worth per army of hold cost (ties: lower hold cost, then id); a
//     border is conceded when its hold cost exceeds the budget left or
//     CONCEDE_FACTOR × its worth (so a thin border protecting nothing is
//     conceded) — but never on worth in the opening phase when the hold costs no more than
//     the armies already there (#122: a start facing an enemy start was stripped for want of
//     2 armies). Under `goal: 'defend'` the plan deploys each hold, and a held
//     border then makes no moves.
//     #201, holds by the standing (adapting, the profile's standing): ahead, every held bonus is held
//     for the worst case — its units (rule 1h) run before any capture in rule 4a's greedy step,
//     completions included ("Ahead (#201): …"); behind, each border is sized for the expected attack
//     (#59: the movable armies next to it plus the whole deploy estimate, the largest over every
//     adjacent player), not the worst case the growth trend projects — the deploy still counts in
//     full on every border, so no border is short of one deploy landing there; separate attacks,
//     chains, Bomb sizing, my commander's territory and an `enemyDeploy` override keep the worst case —
//     and a warning names the gamble ("Behind (#201): …"), and a border's "could be taken" warning is
//     restated against its worst case. Even keeps the rules above. The behind gamble is only the
//     growth trend above the deploy: with no trend above it, behind sizes each border as `defend`
//     does. A border sized below the whole deploy (the movable stacks alone) was tried and dropped:
//     it broke #118, and one stack beside two such borders splits its deploy to take both.
//     Expected-case holds below the whole deploy (cover odds k ≤ 1) remain open on #201.
//     Scope of "protected value", deliberately narrow: only bonuses containing T
//     count (not a bonus T merely borders; a negative bonus I hold in full that contains T
//     counts against it, #128 — losing T lifts it — floored at 0), and an incomplete one counts in full
//     when T is my only foothold, however much of it the enemy holds, else by its share
//     while I am building it (above). So with no complete bonus, no bonus being built and
//     no per-territory income (`bonusArmyPer` off, or its armies still below the base income
//     they replace), a threatened border protects +0 and is conceded: early in a game
//     `defend` holds nothing and withdraws from every threatened border, keeping armies for
//     expansion.
//     Triage deploys nothing to a conceded border (unless every territory I hold is
//     conceded): it may still attack out with the armies already on it, since they
//     are lost anyway if they stay, but no capture is funded there. A conceded border
//     can still get deploys three ways: as a finish-off source (rule 1e runs before
//     triage, and its attacks keep the deploys they were sized with), under Local
//     Deployment, from its held bonus's own pool, which lands only inside that bonus (rule 1b),
//     and (#214) as the source of a lead step (#203, rule 0p.2), sized for the attack alone.
//     Under `balanced` a hold is not deployed here: it competes in the greedy
//     step (rule 4a), and a threatened border it might hold makes no attacks. #215: one whose
//     hold costs more than the whole deploy left is conceded here as under every other goal (the
//     greedy step could never fund it; left pending, a border just taken from a weak opponent —
//     exempt from the economic test — kept its armies home beside a 2-army member of an enemy
//     bonus), and a pending hold the greedy step concedes may attack out in the passes after it.
//     The "Not attacking" line gives a conceded neighbour's armies left once its orders leave
//     ("has left for it … conceded"), never "spare once it holds its border".
//  1h. Held bonuses (under `balanced` and `defend`; issue #51). Every bonus I hold in
//     full with a threatened border is one unit: its threatened borders are all held
//     or none (holding some while conceding another breaks it anyway). Its hold cost
//     is the sum of its borders' (a border shared by two held bonuses counts in both
//     units' feasibility, and is paid for once). A unit pays for itself when that cost
//     ≤ PAYBACK_TURNS × its value and, as rule 1a asks of every border, ≤ CONCEDE_FACTOR
//     × its worth (waived when a member was just taken from a weak opponent); one that
//     does not is not conceded yet (#118): those tests concede only when the armies have a
//     better use. It is floored (below) and waits for the captures; once they are planned
//     (before rule 1c, and under `defend` after passes 1–2), it is held whole if what is left
//     covers it (rationale "… (more than …), and nothing else this turn uses those armies"),
//     else spread (below) when floored, else conceded whole as before. Under Local Deployment (#103) those tests (and its score)
//     use the cost net of the bonus's own pool, max(0, cost − pool): the pool can be
//     deployed nowhere else. A unit that pays is funded before any capture that
//     completes no bonus (advances, breaks, other expansion, unless focused): under `defend` with the
//     other holds, by worth per army (worth = value + the armies its holds save /
//     PAYBACK_TURNS); under `balanced` it competes on that score with holds and
//     completions, and at the first advance or break every pending unit runs first
//     (with the completions outscoring the weakest of them). A completion that runs
//     before a pending unit and would leave too little to fund it (under Local Deployment,
//     a unit counts as fundable only when its own pool and the free armies cover it) waits
//     until they are funded unless (#122): when a starved unit would be conceded (not even
//     kept as a near miss or floored on what is left), its one turn of value beats
//     PAYBACK_TURNS × the bonuses conceded — waiting costs the completion one turn, losing a
//     held bonus costs it every turn until retaken; when every starved unit is only left
//     short, its bonus earns more than they do, or each stays a near miss and the completion
//     pays for itself within a turn (cost ≤ value). It waits for
//     rule 4a's expansion share only until then. Finishing off (rule 1e) keeps its place before
//     it. A unit the armies left cannot cover is first tried as a near miss (issue #59):
//     each border not yet held gets what may still be deployed there, up to its hold
//     cost (pools respected), and the unit is kept — deploys stay, nothing withdrawn,
//     a warning "… is held though short …; X may fall" — when the total is short by at
//     most nearMissMargin(need) = max(NEAR_MISS_ARMIES, NEAR_MISS × need), or when every
//     short border still holds against the expected attack (movable + deploy estimate,
//     no trend projection). Otherwise it is floored (below) and kept, or, when no floor is
//     funded, conceded whole ("conceding bonus …:
//     holding all N threatened borders needs X, more than …"; a one-border unit keeps
//     rule 1a's warnings).
//     Floor tier and one shared deploy (#118). One enemy deploy lands on one target, and
//     sizing each border for all of it (rule 1a) conceded every bonus once the deploy outgrew
//     them though the stacks next to them could take none. So a unit about to be conceded
//     (either test above, or the armies left cannot cover it) whose every threatened border
//     faces a player with two or more threatened borders of mine to aim at gets its floor
//     first: the deploys making each border beat the armies already next to it (the most
//     movable armies one player has there, its commander included; at most its hold cost),
//     all of the unit's floor or none, by value per army. Against a player with one target
//     its whole deploy lands there, so a floor alone saves nothing and the unit goes the old
//     way. A floored unit is kept ("contested"): never conceded or withdrawn from, its borders
//     make no attacks. After the captures, what is left first holds contested units whole (best
//     worth per army first) — unless spreading it over the floored units instead loses less
//     bonus value to the opponents' best response (each player's one deploy split to break the
//     most value, a knapsack over its cheapest break per unit; both simulated, Local Deployment
//     off; a rationale line says so) — then is spread over the borders still short one army at a time, to
//     the one the opponent's deploy breaks most cheaply (armies to take it less the armies next
//     to it; ties: the higher bonus value, then id), each up to its full hold — the way
//     `guaranteedFalls` sizes the opponent's single budget on offence (rule 1e). A warning names
//     a bonus left short ("… is not safe against the whole enemy deploy …, but it is not
//     conceded: … it falls only to armies deployed against it", then one line per opponent:
//     "Player P's ~D deploy can still break … (N of it needed): +V at risk this turn"). Idle armies next to a border
//     are not counted as hold funding: a transfer runs in move order, interleaved with the
//     opponent's attacks, so it may arrive after the attack it was meant to stop.
//     Each border of a conceded unit is then judged alone by rule
//     1a with its protected value less that bonus (other bonuses, per-territory income,
//     the stack it saves), and held only when that justifies it. Under `expand`
//     nothing changes, but a warning names each held bonus whose holds would pay back;
//     `complete-bonus` is unchanged.
//  1k. My commander (every goal; #61). A territory where my own commander stands is
//     must-hold: when threatened it is held before any other hold or capture (only a
//     commander strike, rule 1s, comes first, and it reserves this hold), never
//     conceded, and it makes no attack or transfer except that strike. When the hold
//     does not fit, all that may still be deployed there goes there, with a warning.
//     Unthreatened, any attack from it keeps what holds it against the visible enemies
//     next to it; next to an enemy at the start of the turn, or to a border the plan concedes
//     (#121: the enemy takes that next), it never transfers out (a capture that makes it
//     interior can still fail). A held bonus containing it leaves
//     its hold, once fully funded here, out of the bonus's cost and payback test (rule 1h):
//     neither its hold cost nor the stack it saves counts for the unit. The
//     commander itself never moves: planned moves carry armies only (the order encoder
//     sends no special units).
//  1s. Commander strike (every goal, before finishing off, triage and any expansion; #61).
//     A visible enemy commander next to a territory I held at the start of the turn is
//     attacked first — killing it eliminates its owner — sized for its armies + the
//     commander's 7 + its owner's full deploy estimate (#179: under Local Deployment, what can
//     reach it). In an FFA a rationale line says who borders the land it leaves neutral; a
//     commander strike is never gated. Nothing is conceded yet, so a thin
//     border next to it may strike with deploys. No vanishing: war.app interleaves both
//     players' attacks, so only the struck territory stops threatening; the owner's other
//     stacks still count in every threat this turn (elimination changes next turn). My
//     commander's must-hold reserve is funded first: the deploys its territory needs against
//     those threats (all that may be deployed there when the hold does not fit). The strike
//     is funded from what is left plus each source's movable armies beyond its keep (what
//     holds it); a source other than my commander's whose hold is hopeless even with the
//     deploys left keeps nothing (its armies are lost anyway). R3 never vetoes a strike (the
//     bonus side-effect is irrelevant). A source that already issues an order (No-Split) does
//     not strike (strikes run before every other pass, so no source is locked or conceded
//     yet). With no source able to send that many, and no finishing off taking it, a warning
//     names what held it back — a source's keep (only when that source could send enough
//     without it and the reserve), the reserve (only when it binds: a source could send
//     enough with its keep but for the reserve, or dropping the keep alone would not do),
//     No-Split, or "unaffordable" — and nothing is attacked.
//     When a strike is planned and, once every deploy and move is planned, what stays on my
//     commander's territory falls to the visible stacks next to it — the struck one included
//     (attacks interleave, so it may attack before the strike lands; a strike from my
//     commander's territory thins it) — `cardAdvice` is Order Priority if I hold one
//     (`holdsOrderPriority`: my attacks resolve first), with a rationale line; without one, a
//     warning says the attacks interleave. Its owner is not also finished off (rule 1e).
//  1c. Reconsider (every goal, after the capture passes, and again before the leftover for
//     captures made later, #122). Triage runs before captures are known, so a border in a
//     bonus this turn's captures complete may have been conceded. Protected value is then
//     re-judged against my holdings plus this turn's captures: a conceded border in a bonus
//     completed this turn (not already withdrawn from) is kept (its concession warning
//     dropped, a rationale line added), never withdrawn from, and garrisoned from the leftover
//     (rule 5); a warning says so when the leftover still cannot make it hold. A conceded
//     border may fund (be deployed to for) a capture that completes a bonus it is in — with the
//     members already taken, or (#214) with the sibling steps the same completion (pass 1, all or
//     nothing: undone whole if one fails) plans this turn.
//  1g. Garrison a completion (under `balanced` and `defend`; #122). Once a capture completes a
//     bonus, its members I held at the start that face an enemy and would fall are held whole
//     right away, before any later capture — a held bonus's unit tests (cost ≤ PAYBACK_TURNS ×
//     value and ≤ CONCEDE_FACTOR × worth), and its members' deploys must fit together what may
//     still be deployed (under Local Deployment, the pools checked for all of them at once);
//     otherwise they get the leftover as in rule 1c. A rationale line "Garrison … completed this
//     turn" names each; the leftover then tops them up to a comfortable margin as it does a
//     border rule 1c keeps. Captured members are not garrisoned (next turn's deploys land first).
//  1b. Withdraw (under `defend` and `balanced`, after 1c). A conceded border's movable armies move first
//     to the adjacent territory of mine nearest a border that holds (then the
//     one protecting the most value, then id); the largest is my first order, and the plan
//     advises Order Priority (`cardAdvice`) under rule 7's test, because a withdrawal only
//     executes while the border is mine.
//     A conceded border of a bonus I hold in full whose armies staying still hold
//     against the expected attack (movable + deploy estimate) is never withdrawn from
//     (issue #59): its garrison stays, and under Local Deployment its bonus's leftover
//     pool may go there as if it were not conceded. Nor is any other conceded border of a bonus
//     I hold in full (#118; Local Deployment off) unless its armies make the territory they
//     would go to — a border facing an enemy, protecting value, not conceded — hold this turn
//     when it would not without them: where they stand they kill attackers ("Keep the N
//     movable armies on … (not withdrawn): it is a border of held bonus …"). Under Local Deployment (#103) a border
//     of a conceded held bonus also keeps its garrison unless the bonus truly cannot be held
//     (one of its threatened borders needs more than the pools containing it plus every free
//     army): withdrawing turns "might lose it" into "certainly loses it". A warning says which
//     case applied ("… is conceded but might still hold" / "… cannot be held"); a kept border
//     may also take the leftover deploy.
//  1i. Income at risk (#109). `expected.nextIncome` is next turn's income if every territory
//     the plan keeps and captures is held — the borders it concedes included, withdrawn from
//     or not. A conceded border is not kept, so the plan also reports
//     `expected.nextIncomeIfConcededFall` — the one income rule (`incomeAfter`, negative and
//     overlapping bonuses and per-territory armies included) over the holdings after the plan
//     less every conceded border — and `expected.bonusesAtRisk`: each positive bonus complete
//     after the plan (held at the start or completed this turn) with a conceded member. Both are
//     present only when the figures differ or a bonus is at risk. When the at-risk figure is
//     lower a warning names both ("This plan concedes bonus …: next income A if they hold, B if
//     the conceded borders fall."), and the frontier rationale's next income names both.
//  2. Targets: visible neutrals adjacent to a territory I held at the start of
//     the turn (plus visible enemy territories under `goal: 'complete-bonus'`, and
//     under `balanced` only enemy territories in a breakable bonus — one whose
//     every territory is visible and held by a single enemy, or (#72) a probable one: the
//     opponent's track over at least TRACKED_MIN_TURNS turns lists it in every combination
//     fitting its income gap (none unlisted) or in its single best fit (fewer bonuses than the
//     next), and every member is that opponent's or
//     hidden — and counter-attack targets: an enemy stack next to me visible on both boards
//     that shrank fighting me (every neighbour visible on both, one of them mine on both, every
//     neighbour neither mine nor its owner's unchanged in owner and armies, the shrink not
//     absorbed by its own neighbours' growth) and is now cheaper to take than it
//     was; never under `expand`/`defend`). Fogged or unknown neighbours are never attacked — they
//     produce a warning.
//  3. Capture cost (#126): the fewest armies whose exact `winChance` reaches the capture's
//     chance — certain (chance 1) means every roll and rounding takes it: `armiesToTake` at 0%
//     luck under straight rounding, one army more where weighted-random rounding could round a
//     kill down, the kills the luck-free share guarantees with luck. An ordinary capture's
//     chance is `minWinChance` (default 1 with no luck, LUCK_WIN_CHANCE = 0.95 with luck on,
//     where certainty costs several times a likely win), taken to the power 1/k for a
//     territory in a positive bonus with k members not mine, so the captures a bonus still
//     needs reach it together; the plan states each completion's joint chance when below 1.
//     Worst-case sizings (finishing a player off, fog pressure, commander strikes) stay
//     certain. Holds (#126): with luck or weighted rounding a stack "needs N to take" where N
//     is the fewest attackers winning more than HOLD_FALL_CHANCE (5%), so a hold above the
//     threat falls to it at most that often (exact `armiesToTake` otherwise); every attack carries its
//     `winChance`; after the leftover deploy an attack on a player's territory (not already
//     sized for a worst case) is sized for its defenders plus what its owner may deploy there
//     first (its deploy estimate, or its growth there per turn when larger; #120) when the
//     armies on its source beyond what holds it (never a hold, a conceded border or the strike
//     stack) cover the difference — the plain "assumes its owner does not reinforce it" warning
//     is then dropped, and the attack counts as landing for sure (rule 6). Otherwise an attack
//     is topped up to its next kill breakpoint from idle armies on its source (never a hold, a
//     conceded border, my commander's territory or a source still facing an enemy) when its
//     target is a player's or it is not certain, else an attack between breakpoints is named;
//     and an attack on a player's still sized below that deploy keeps the warning, which then
//     gives its win chance against the reinforced target and the size that would be sure.
//  3a. Combined (multi-source) captures (R4). When no single source can afford a
//     target (its movable armies plus the deploys left), two or more of my
//     sources held at the start of the turn (not locked, not conceded) attack it
//     in sequence: sources by most movable armies, then id; the first is the
//     finisher, the others ("softeners", in id order) each attack first with their
//     movable armies (capped so they never kill the last defender), killing
//     round(off × armies) defenders each, cumulatively; their survivors stay home.
//     The finisher then sends armiesToTake(defenders left), deploying its
//     shortfall. Fewest sources first. Exact only under straight rounding at 0%
//     luck: otherwise it is skipped with a warning. It is a fallback inside every
//     pass, so it only ever takes a target the passes already chose (economic by
//     the same scoring), and only when no single source suffices. The plan lists
//     such targets in `multiSourceCaptures`.
//  4. Bonuses (value > 0) are scored by value / remaining capture cost, ties by
//     fewest external borders, then id; focused bonuses come first. The economy test charges
//     what a capture costs, not what it sends (#125): the armies its attackers lose (the
//     defenders' kills at the defensive rate) plus the one army left on it, that army waived
//     when a territory of mine beside it facing no visible enemy already has idle armies enough
//     to take it. A bonus whose remaining members lose over PAYBACK_TURNS × value, or with one
//     remaining territory losing over WASTELAND_FACTOR × value, is uneconomic and its
//     territories are not planned (unless focused or also in an economic bonus); the "Skip
//     bonus" line names both the armies to finish and the armies lost. Rule 1a's "being built"
//     share uses the same test. With Extra Armies for Territories (`bonusArmyPer`), a bonus's net
//     worth adds the per-territory income its missing members bring (1/per a territory once past
//     the base income, #125), and plain expansion counts that share as each capture's income, so
//     a member of an uneconomic bonus is still a territory worth taking (never a negative
//     bonus's member).
//     A negative-value bonus is always uneconomic unless focused, so the plan
//     never captures into it (completing one would cut income). A positive bonus is
//     scored by its net worth (rule 4c), not its value, in every test above.
//  4c. Net income (#70). Maps with overlapping bonuses (each sea tile a single-territory
//     −4 bonus and a member of a +22 group) are scored by every capture's effect on
//     income: `incomeGain` — the one income rule's (`boardIncome`, #85) total after the
//     captures less its total now (every bonus whose completion changes, per-territory
//     armies, the 0 floor), the one computation `expected.nextIncome` and R3 use. A positive bonus's
//     net worth is its value plus the (negative) values of the other negative bonuses its
//     missing members complete (= value on a map without negative bonuses); net ≤ 0 is
//     uneconomic unless focused. Completing it is all or nothing (pass 1), refused when it
//     would lower income. A capture that lowers income this turn (it completes a negative
//     bonus) is taken only when (a) it is part of completing a positive bonus this turn,
//     (b) it is in a focused bonus, or (c) it stages a bonus: with k = ceil(the capture
//     cost of the bonus's other missing members / the income left after this step) turns
//     to finish (≥ 1; unknown under fog, or no income left: refused), k ≤ PAYBACK_TURNS and k × every penalty its missing
//     members carry ≤ PAYBACK_TURNS × its net worth; the reason then says "stages", never
//     "advances". Pass 3 never takes one. Guard: after the capture passes, while next income
//     is below this turn's, the latest capture that completes a negative bonus is dropped
//     (its attacks taken back, its deploys left where they are) unless focused, staging,
//     a commander strike or finishing off; whatever remains is a warning with the numbers.
//     Pass 1 completes bonuses that can be finished this turn (all or nothing);
//     pass 2 advances bonuses one capture at a time, cheapest first; pass 3
//     (not under `complete-bonus`) takes any other affordable target (never an
//     enemy one under `balanced`) that passes its own economy test (#125): a member of an
//     economic bonus is judged by that bonus; any other capture's armies lost (the defenders'
//     kills) must be repaid by the income it adds within PAYBACK_TURNS, and one that adds no
//     income may lose at most PLAIN_EXPANSION_LOSS (a rationale line "Do not expand into …"
//     names an affordable one refused). The leftover's expansion stack (rule 5) is a capture's
//     finisher, never a combined capture's softener.
//  4a. Balanced (the default goal). Instead of passes 1–2, every candidate is
//     scored as income per army and taken greedily (focus first, then score, then
//     cheaper, fewer bonus borders, id): a hold (protected value / hold cost),
//     completing or advancing a bonus (value / remaining cost), breaking an enemy
//     bonus (#72: sized to land, not to survive — aimed at its cheapest visible member, worth
//     BREAK_WEIGHT / opponents × (its value + the armies retaking it costs, at least
//     armiesToTake(my survivors), / PAYBACK_TURNS) over its capture cost plus the frontier it
//     changes without its own hold need, warning when it can be retaken; #201: when I lead an FFA,
//     sized to land for certain against its owner's one deploy there, as rule 1e sizes a target, and
//     its reason says so), or a counter-attack
//     (scored like a break worth no bonus). Every break and counter-attack considered is
//     reported in `offence` with whether it was made and why (a bonus broken through another
//     member, by any path, counts as made). A threatened border whose only
//     visible threat is a member of a breakable bonus also attacks it, once per
//     bonus: it deploys its hold plus the capture, so what stays still holds if
//     the enemy reinforces that member first and the attack fails; when it cannot
//     afford both it just holds (a held border otherwise makes no attacks). While expansion candidates
//     remain, a hold protecting less than the best expansion's value may not dip
//     into the first MIN_EXPANSION_SHARE of income not yet spent on expansion; it
//     is deferred and funded afterwards if the budget allows, else conceded — but (#128) a
//     capture that completes nothing never starves it: when one would leave too little for a
//     deferred hold, it is undone, the hold funded first, and it runs on what is left.
//  4b. Defensibility (R3). A capture that completes a bonus is checked against the
//     frontier it leaves: each member a visible enemy could take next turn (threat as
//     in rule 1, armies staying after this turn's moves; a fresh capture holds its
//     attack's survivors) needs holdArmies(threat) − armies more. When the total
//     exceeds my next income (#128: the income the plan keeps — without the borders it concedes
//     or a held bonus it has not yet decided to hold whole; rule 4d and `frontier.income` use the
//     same figure) (plus this turn's leftover, for members I held at the
//     start) the bonus would fall at once. #128: a member I held at the start that is exposed
//     either way (its armies before any attack leaves it, against the threat without this turn's
//     captures) counts only the need the completion adds — refusing would not save it — and the
//     bonuses this turn's earlier captures completed share the same next income (their added
//     needs count too). Then: under `balanced`/`defend` the capture is
//     refused (warning "… indefensible …: not completed"); under `expand` and
//     `complete-bonus` it is made with a warning. Under `balanced`/`defend` a bonus's
//     score is value / (capture cost + DEFENSE_DISCOUNT × that defence cost).
//  4d. Frontier cost (#71). Every capture pays for the frontier it adds, in armies: for each
//     territory it touches (the capture and its held neighbours), its border cost after minus
//     before. A border (a territory of mine next to one I do not hold) costs
//     NEUTRAL_BORDER_COST, plus, when it faces a visible enemy and the goal is guarded, the
//     deploys it needs next turn to hold (R3's arithmetic; a capture holds its survivors).
//     A capture that closes a gap lowers it, one that opens fronts raises it. A bonus's score
//     is net / (cost + DEFENSE_DISCOUNT × defence cost + frontier) — its missing members' own
//     hold need left out when R3 judged it, never counted twice — at least 1 army; advances,
//     plain expansion (pass 3) order by capture cost + frontier; breaks and counter-attacks by
//     capture cost + frontier without the captured territory's own hold need (#72: a break
//     only has to land; the frontier change of my borders around it stays). Budget: the plan
//     reports `frontier` (borders, enemy-facing borders, their hold cost — conceded borders
//     excluded — and the next income). Under a guarded goal, a capture that adds an enemy-
//     facing border without completing a bonus (not focused) is undone when the hold cost
//     would then exceed the next income and the start-of-turn hold cost (in rule 4e's
//     contact/late fallback it is a cost instead, #114); a warning ("Frontier grows faster than
//     income") names it, and also fires when the plan's frontier ends so.
//  4e. Never stand still (#104, #107; every goal but `complete-bonus`, after pass 3). A plan that
//     makes no capture at all (no expansion, break, finishing off or strike) in the opening or
//     expansion phase takes one neutral capture toward a positive bonus (net > 0, never a negative
//     one), uneconomic or not, never one that lowers income. Its candidate steps (#107) are ranked
//     by what this turn can afford first — each step's shortfall: its cost less the armies that can
//     reach it (its best usable source's movable armies plus what may still be deployed there,
//     after every hold; a conceded border counts with the armies rule 1b withdrew and with deploys:
//     rather than withdraw, it attacks out, its deploys leaving with the attack, and the rationale
//     says so) — then by its bonus's armies to finish (ties: higher value, then id), then
//     pass 2's order; the first that fits is taken (usual sizing). So a cheap neutral next to my
//     stack beats a far step toward a bonus with fewer armies to finish; the reason says "the
//     fewest of any bonus in reach" or "… with a capture affordable this turn", and the rationale
//     names the closer bonus and why it was passed over. Rule 4d may stop a step, except in the
//     contact/late fallback (a cost there, below, #114) and in the opening: when 4d refused every
//     step that fits, the first of them is taken anyway (one capture that grows the frontier beats
//     none; the rationale says 4d is waived for it, and 4d still judges every other capture). In
//     every phase, and under the waiver too, every source of the capture must still hold its border
//     once the attack leaves (a softener of a combined capture included; a conceded source
//     excepted): a source left short gets the deploys still available there that make it hold, and
//     a capture they cannot cover is not made — standing still beats trading a held territory and
//     its armies for a neutral that pays nothing (live, an 8-player opening sent a 15-stack's every
//     army at a 15-neutral from beside two enemy 15-stacks). The rationale says nothing passed the economy test and standing
//     still is worse than the cheapest expansion; when nothing is taken, a warning names the
//     top-ranked step and the actual reason: rule 4d's frontier stop, R3 (it completes a bonus
//     that falls next turn), No-Split, no neighbour able to attack (each named as holding its
//     border or already ordered), the holds (it would fit without what they took), or its size
//     (its cost against the movable armies and deploys that can reach it). Army cap (`armyCap`, × income): when my
//     armies after deploy exceed cap × income, armies above it are wasted, so the same fallback
//     fires in any phase, and the rationale says so. The cap's cut to income is not modelled.
//     Contact and late phases (#107): a plan with no capture at all falls back too — unless the
//     caller chose `defend` (a `defend` that adapt picked, rule 0p.3 behind outside a 1v1, still
//     falls back: its holds come first), or the 1v1 strike stack (rule 0p.3c) spends itself this
//     turn. Its candidates are the neutral steps above and (unless the caller chose `expand`) every visible
//     enemy territory next to mine without an enemy commander (rule 1s's) whose capture does not
//     lower income, sized like any capture at the plan's win chance. A capture of a player's
//     territory must trade at least even (defenders killed ≥ attackers lost; a single capture
//     always does, a combined one whose softeners lose more is refused with a warning, "… a trade
//     below even"), and every source must still hold its border once the attack leaves: a source
//     left short gets the deploys still available there that make it hold (a rationale line says
//     so), and a capture they cannot cover is refused (a conceded source excepted; a warning names
//     an enemy capture refused so, with what would stay and the deploys left). Here rule 4d's
//     frontier stop is a cost, not a veto (#114): each candidate is tried (and undone) to find its
//     armies at risk — the survivors its capture leaves on a border that cannot hold next turn at
//     the expected enemy deploy (4d's and R3's arithmetic; 0 when it holds or faces no enemy).
//     Order (#112, #114): affordable first, then its cost — the armies the capture is expected to
//     lose (the defenders' kills on its attackers at the game's rates; for a combined capture, the
//     total over its attacks) plus its armies at risk — then the armies it sends, then one that
//     breaks a bonus (its owner holds it in full) or advances one of mine (a tie-break only), then
//     (neutral steps) the order above, then id; the reason names both parts ("loses ~3 armies, and
//     its 5 survivors may fall next turn", "loses no armies"). So an enemy 4 taken for ~3 lost, or
//     an empty one for none, beats a 15-neutral taken for ~11 toward a big bonus, even when 4d
//     would refuse their new border. After the capture taken, every other candidate that loses no
//     armies is taken too (by armies sent, then id), when every hold stays covered and income does
//     not fall, never attacking out of a conceded border; 4d does not stop one either (its
//     survivors at risk never exceed the armies it sends); a rationale line says "Also take …: it
//     costs nothing" (with "; its S survivors may fall next turn …" when its border is exposed,
//     and, for one that opens a second front, "… taken only because it costs nothing"). Every
//     candidate considered and not taken is named in one rationale line, "Other candidates not
//     taken: …", with its reason (refused, does not fit, ranked after the capture taken and at
//     what cost, or — rule 0p.2 — tried only after every other); an enemy capture refused as a
//     trade or for a hold is left to its own warning, and when nothing is taken the top one is in
//     the stand-still warning instead. In an FFA with two or more opponents (rule 0p.2's setting,
//     applied here whether or not the plan adapts), a capture against a player that cannot
//     currently attack me (it could take no territory of mine next turn) opens a second front and
//     is tried only after every other; the rationale says which ("can already attack me …: opens
//     no new front" / "cannot attack me now: … opens a second front (no second front in an FFA),
//     taken only because no neutral capture fits"), and the trade ("kills K for L lost"). Outside
//     the contact/late fallback (passes 1–3, the opening/expansion and army-cap fallback) rule 4d
//     keeps its veto. An enemy capture carries the usual warning that it assumes the owner does
//     not reinforce first, unless rule 3 sizes it for that deploy (#120).
//  4g. A capture worth a card piece (#127; every goal but `complete-bonus`, after rule 4e, not while
//     the 1v1 strike stack, rule 0p.3c, is contact's answer). Any capture this turn earns the turn's
//     card pieces; `cardPieceValue` is what they are worth in armies (the Reinforcement pieces a
//     capturing turn brings × its armies over its pieces: src/strategy/card-clock.ts
//     `capturePieceValue`; the other cards are not valued). With no capture planned, the target
//     whose capture loses the fewest armies (the defenders' kills on its attackers) is taken when
//     that loss is at most the value — neutrals before players' territories, then the cheapest, then
//     id — with the usual sizing (tryCapture: each source keeps what holds it), never one lowering
//     income. Absent (no Reinforcement card, or a progressive one and none in hand): off.
//  4f. Commit to the closest bonus (#101; every goal). While no positive bonus is held in full, in
//     the opening and expansion phases, and in an FFA while a neutral borders a territory of mine
//     (#132: one front leaves the rest of the map to expand into; the rationale says "neutrals in
//     reach"), completions and advances keep the slots their scores give them (rules 4, 4a) but
//     fill them closest to completion first: fewest turns to finish at
//     this income (armies to finish, counting the members I hold, over the income — and never
//     fewer than its depth, #125: the farthest missing member's distance from what I hold, since
//     a capture's armies attack no further this turn; "N turns (N layers deep)"), so a farther
//     bonus gets only armies the closer ones cannot use; bonuses as close as each other keep the
//     score order. Given `previousBoard`, a bonus advanced last turn (a member captured since) keeps
//     priority unless another is strictly closer; the rationale lists the order and says which
//     kept or gave way. Armies to finish count every missing member: a fogged one at its bonus's
//     costliest visible missing member (counted as free before, the figure jumped when it came into
//     view), named in every "N armies to finish".
//  3b. One surplus per territory (#121). A border that holds at the start of the turn (its armies
//     beat its visible threat, rule 1) and is not conceded keeps what holds it, as my commander's
//     territory does (rule 1k): a capture from it spends only its armies above that, plus deploys
//     (a rationale line names those that keep it holding), so it never ends the turn takeable
//     after starting safe. The threat counts its captured neighbours as gone. A target no source
//     affords on its surplus may still fall to a combined capture (rule 3a), whose softeners and
//     finisher keep what holds a safe border too; in rule 4e a step
//     that fails only because of a keep is reported as the hold it would leave short.
//  5. Deploys cover only the shortfall of a chosen capture; leftover income never
//     goes to a conceded border: it goes to the held border with the highest
//     protected value still short of COMFORT_MARGIN × its threat (counting armies
//     withdrawn into it) — but first (#121), when it would go to such margins (no strike stack),
//     a conceded border the leftover can make hold is held after all, from what is left once
//     every held border that would fall as it stands has its hold (best worth per army; its
//     withdrawal taken back unless the territory it went to needs it to hold; never one that
//     attacks out or whose garrison already stays); with two or more such borders, each is first brought to that
//     margin in the same order (#121: two symmetric borders at an exact hold ended as 16 and 7),
//     the rest to the first — else (#125) it saves toward a capture this turn cannot afford:
//     rule 4e's top-ranked step when it stood still for want of armies, else (rule 4f committing)
//     the closest bonus's cheapest missing member in reach when this turn made no capture into
//     that bonus, and only when its armies free plus what may still be deployed there fall short
//     of it (a step refused for another reason — R3, rule 4c or 4d — is no reason to save); it
//     goes to my territory beside that member with the most armies free (open, not a softener, no
//     order under No-Split; "save toward …, the next step of bonus …") — else the
//     source of the top expansion (a capture's finisher; it then makes no transfer), else the
//     border with the most fogged neighbours, else my biggest stack.
//  6. Idle armies on interior territories transfer one step toward the front,
//     only into territories held at the start of the turn and never into, or
//     measured through, a conceded border
//     (only when transfer-only orders are allowed). The front is the territories a visible
//     enemy holds; only a stack no enemy can be reached from heads for the nearest territory
//     not mine (neutral or fog) instead (#121: idle armies walked toward a worthless neutral
//     while the enemy front was short, and a stack beside one never moved). This turn's
//     captures count as mine only when they land for sure — a neutral, or an attack on a player
//     sized for its owner's whole deploy (rule 1e, 1s, or rule 3's #120 sizing): an exact-sized attack on a player fails
//     if the owner reinforces, and the garrison beside it is not idle. Even a sure one may fail
//     (#128): a territory interior only once an attack on a player beside it lands keeps what
//     holds it against the threat there as the board stands (its neighbours' owners' stacks and
//     deploy) and transfers only the rest. A leftover deploy (rule 5)
//     to a border short of its margin is never transferred away.
//     Two steps away (#172): a territory interior now can be a border next turn when an enemy
//     stack takes the territory in between this turn — the look-ahead warapp_check_plan reports
//     as `exposedNextTurn`, one computation (`twoStepReaches`, lookahead.ts). Wherever armies leave
//     a territory of mine that protects something — a member of a bonus I hold in full, or my
//     commander's — it keeps what it needs against the strongest such reach: these transfers,
//     staging, an attack from it (rule 3b's keep, softeners included) and rule 3's top-ups. Never
//     added to a one-step hold or the hold above (the larger binds), never against a reach whose
//     stack or territory in between this plan takes — by any order, a later one included: when a
//     two-step hold binds, the plan is made again with those reaches cut (the captures of the plan
//     and of one whose attacks ignore the hold, narrowed to those the re-made plan still takes,
//     at most TWO_STEP_PASSES times; else the plan that cuts nothing) — nor through a territory of
//     mine the plan holds (its own hold covers that): one the plan ends keeping (not conceded)
//     with enough on it after the final orders to hold its border. That is judged against how the
//     plan ends, never mid-way (triage concedes a border this turn's captures then keep, rule 1c):
//     a plan that decided a territory otherwise than it ends is made again with the end's answer,
//     at most VIA_PASSES times, else with no territory in between counted held — one answer every
//     order shares, so no "kept N" is stated and then transferred away. And never when even what
//     is there now and what next turn can deploy there (the whole income; under Local Deployment
//     its bonuses' pools and the free rest) could not make it hold (keeping them home saves
//     nothing). What it needs
//     is measured as a one-step hold is (holdArmies: under luck or weighted-random rounding, it
//     falls at most HOLD_FALL_CHANCE of the time), never below check_plan's luck-free `needs`. A
//     territory protecting nothing is not held so: its armies serve the front. The rationale says
//     "Hold X against a stack two steps away (kept N on X: player P can reach it next turn from Y
//     via Z …)" once, at the end, with the stay the plan ends on (an order that keeps it names it
//     without numbers); kept short of what it needs (next turn's deploy makes up the rest), it
//     adds "bring K more next turn". When the one-step hold (or #128's) already needs at least as
//     much, the line claims no "kept N" (#192): it says "already held against the adjacent stack
//     (~T; it needs M to hold)" and what the two-step reach needs.
//     Under No-Split a transfer that must keep some (this hold, or #128's) is not made: it would
//     send the whole stack.
//     Staging (#125): when the leftover saved toward a step (rule 5), idle armies on my other
//     territories facing no visible enemy (a border beside neutrals included; never one that
//     attacks, a conceded border, my commander's, or one beside the step itself) walk one step
//     toward its source first, when it is no farther than the enemy front ("Move N from … to …:
//     stages toward …"): live, a stack two steps from the one neutral its bonus lacked stood
//     still for five turns.
//  7r. Reports (#167; every goal, around rule 7). Exchange: every attack on a
//     player's territory is judged by `classifyExchange` (src/analysis/exchange.ts) — kills, losses
//     and capture against its defenders now, plus its owner's estimated deploy there, plus its whole
//     income, labelled certain first strike / favourable exchange / strike last / stand — in
//     `exchanges` and one rationale line. Cover odds: against a player facing two or more of my kept
//     borders, those holding against its stacks alone but not with its whole deploy on them are a
//     gamble on where that one deploy lands; a rationale line names them and the chance each (and
//     all) hold if it picks at random. A deploy can be split: those whose shortfall it funds
//     together with another's are no gamble — the line says how many (k) the split takes at once and
//     gives each 0% when there are k of them or fewer; with m > k (#201), it picks k of the m, so
//     each holds with (m − k) ÷ m and all of them with 0%. Left alone: every visible enemy territory next to mine that no
//     order attacks is named in one line, "Not attacking … next to mine", with its first reason: a
//     special unit, the offence report's reason (a second front, unaffordable, a trade below even), a
//     capture lowering income, its size against the most a neighbour can spare, a lead strike's sure
//     size against what a neighbour can spare for it (#203: and why its bonus's step failed when
//     that pass tried it — the source it tried, what that source could spare and what of the deploy
//     could still reach it then; or R3, a trade below even, rule 4d's frontier budget), or that it
//     is no target of the plan's (rule 2;
//     under another goal, naming the player's territories other rules do attack). The first
//     NOT_ATTACKING_REASONS (by id) get a reason, the rest are named.
//     Retaliation (#201; an FFA with two or more opponents): a capture that breaks a positive bonus
//     a player held in full, while that player keeps a visible territory or one beside the fog, is a
//     warning ("Breaking player … without eliminating it invites retaliation"): what it has left is
//     likeliest aimed at whoever broke it. In a 1v1 it attacks me anyway, so no warning there.
//     Wastelands (#167, `settings.wastelands`): a fogged missing member of a bonus is costed at the
//     costliest visible missing member plus the expected surcharge of being a wasteland
//     (ceil(count ÷ the map's territories × (a wasteland's capture cost − that))), with a rationale line.
//     #201: given `options.rememberedNeutrals` (the picking board's neutrals, which warapp_plan_picks
//     and warapp_submit_picks' preview keep per game), a fogged missing member the picking board showed
//     as a neutral (and whose owner the fog does not show as a player now) is costed at that size
//     instead, never attacked, with a rationale line ("… fogged now, was a neutral of N on the picking
//     board (#201)").
//  7. Move order (#127; every goal, last). Orders zigzag — the first mover's 1st, the other's
//     1st and 2nd, the first mover's 2nd and 3rd, … — so `moves` is scheduled
//     (`scheduleMoves`, src/analysis/schedule.ts), earliest first: the one order Order Priority
//     protects (the strike, when rule 1s advised the card for it; else the move out of a conceded
//     border carrying the most armies, which is my first order whether or not the card is
//     advised — and if a move it depends on must run before it, that move is my first order
//     instead, and the card is judged for it); withdrawals, attacks
//     out of a conceded border and transfers into a territory facing a visible enemy at the start
//     of the turn; attacks on a player sized for its owner's whole deploy (rules 1e, 1s, 3's #120
//     sizing) and neutral captures another player can reach whose survivors (sent less the
//     defenders' kills) need more to take than its own capture of that neutral (its capture
//     cost, at most its stacks next to it plus its deploy: a 2-neutral taken with 4 leaves 3,
//     which need 5; with 3 it leaves 2, which 3 retake); filler
//     (uncontested neutral captures, interior transfers); last, attacks into a player's stack
//     not sized for its deploy (a defender kills 70% per army, an attacker 60%: attacking second
//     fights its survivors — 24 against 28 loses attacking first and wins attacking second) and
//     contested neutrals whose survivors would fall (taken last, they meet what is left there).
//     Within a slot, early moves go largest first (one grouped early transfer beats several
//     small ones); other ties keep decision order. Dependencies hold: attacks on one target keep their order
//     (softeners before the finisher), a move out of a territory stays after any earlier move
//     into it, and a transfer into a territory captured this turn after the capture. A rationale
//     line "Move order (#127): …" names the protected order and each move put last, and why.
//     With one opponent in view, a line "Move position (#127): …" gives each move put last its
//     place in the zigzag (`opponentOrdersBefore`: moving first, my k-th order runs after
//     2·floor(k/2) of the opponent's; moving second, after 2·ceil(k/2) − 1; both when the order is
//     not known, first when Order Priority is advised) and, against the opponent's territories in
//     view with armies to move (one order each, at least), the index from which it runs after
//     them all (`indexAfterAll`) and how many more orders above it that takes. It adds no fillers.
//     Deploys are listed next to a visible enemy first, in the back after (ascending id within
//     each): they interleave too, and their order shows the opponent my income and the move order.
//     Order Priority (`cardAdvice`) moves only my FIRST order ahead of the opponent's first: for a
//     move out of a conceded border it is advised only when I hold one (`holdsOrderPriority`), I
//     am not known to move first (`movesFirst`), and that order carries at least
//     ORDER_PRIORITY_MIN_ARMIES; its warning then says so, and the other such moves' warnings say
//     they are listed early but may come too late. Under `movesFirst` the strike's card advice is
//     dropped too, unless `opponentsMayHoldOrderPriority` (two cards cancel, so mine keeps it
//     first; #179). The strike that eliminates a finished-off player (#179: the attack on its
//     largest stack, by armies plus special units) is my first order after a commander strike, and
//     Order Priority is advised for it on the same terms (no minimum armies). With no finish-off and
//     no strike the threat to my commander advised the card for, a commander strike (rule 1s) that
//     eliminates a player is that first order instead, on the same terms: its commander could
//     walk away before it lands. When a combined
//     capture (rule 3a) takes that stack, its first attack only wears it down: no card is advised
//     for it, and a warning says the card cannot secure the kill. Finishing a player off (rule 1e)
//     assumes my attacks land before its own orders: unless `movesFirst`, a warning says it can move between its territories or take my
//     borders next to it that its stacks plus the deploy that can reach them can take (named), and
//     survive. Rule 1e's cover (#179) holds those borders when it can afford to, so the warning then
//     names none; it names those left exposed when the cover was unaffordable.
// Local Deployment (`localDeployments`): a held bonus's value is a pool deployable
// only on that bonus's territories (a superbonus's on all of its territories, beside
// its member bonuses' pools); the rest of the income (base, per-territory, card
// armies) may go anywhere. Every affordability check above uses the armies
// deployable at that territory; leftover bonus pools are still deployed inside their
// bonus, on its most threatened member: a border next to an enemy always before an
// interior member (#103), then not withdrawn from, then most threatened, then id. A
// pool deployed on a border is never moved out the same turn. A rationale line names
// each pool. Off (the default), plans are unchanged.
// No-Split (`noSplit`): a territory issues at most one order (attack or transfer)
// this turn, and the order sends its whole stack (#124; the wiki, and a live turn with the
// guard off that left every source at 0): every army there, this turn's deploys included,
// less the guard (whether the guard stays behind under No-Split is unverified; a warning says
// so). Orders are planned in decision order, so a territory's first order is its best by the
// scoring above; any later attack, withdrawal or transfer from it is not planned (a warning
// names it), and another source may take that target instead. Nothing is kept back on a
// source (no keep for a hold, rule 1e's or rule 1k's): a territory that must hold issues no
// order — one that protects something (a bonus, income, my commander), is not conceded, and
// would fall to the visible threat left once this turn's captures land with only the guard
// (and armies withdrawn into it) on it; the target counts as gone only when the whole stack
// takes it even if its owner deploys there first (a warning names the attack not planned).
// Combined captures (rule 3a) use only sources with no order yet that need not hold, a
// softener only when its whole stack leaves the last defender alive; each still issues one.
// A deploy that reaches a source after its order was planned (the leftover, a pool) leaves
// with it, a rationale line says so; the leftover never goes to a softener, nor a hold top-up
// to a territory with an order. The strike stack (rule 0p.3c) attacks one target with the
// whole stack, only when it need not hold; its one order goes to the strike before a small
// expansion (an attack on a neutral that completes no bonus this turn: taken back, its armies
// rejoin the stack). Efficient sizes (S2) do not apply. Off (the default), plans are unchanged.
// Bomb (#163; `opponentsMayHoldBomb`: the card clock's fastest turn lets an opponent hold one by
// now; whether hands are hidden is not checked, since the plan never sees an opponent's hand). A bomb halves one territory of mine next to the bomber after the deploys and before any
// move (my stack keeps the smaller half; a commander is unharmed), so every threat to my territory
// (rule 1's `forceAt`) becomes the attack that twice the armies just hold against: every hold, near
// miss, keep and comfort margin sized against that threat is sized as if halved first (one bomb,
// but it may land on any border, so each is sized for it, as each is for the whole deploy), and so
// is #179's cover of a finished-off player's exits (`bombSized`). Not
// bomb-adjusted: #172's two-step holds (`twoStepHold`) and #118's floor tier (`floorOf`, against
// the armies already next to a border). The threat warning names the
// bombed take. And the leftover deploy (rule 5), when it goes to a border facing an enemy, gives
// half to a second open border facing an enemy (the same opponent first, then the bigger stack,
// then id): one bomb halves only one of two stacks. Not a strike, saving or expansion stack: each
// concentrates for one attack, which a split would halve for certain. Off (the default), plans are unchanged.
// Guard off (#165; `oneArmyStandsGuard: false`, not under No-Split): every army may move, but an
// empty territory falls to any single army, so each territory of mine next to a visible enemy at the
// start of the turn keeps one army all the same (never my commander's: it is not empty; a rationale
// line names them) — every pass, withdrawals from a conceded border included, counts it as staying.
// And after the holds, before any other capture (every goal), an enemy territory next to mine at 0
// armies (no special unit) whose owner holds a positive bonus it is in is attacked with one army —
// it breaks the bonus — from the neighbour with the most to spare beyond what holds it once the
// target falls, else one deployed on a neighbour not conceded; never one lowering income. Sized for
// the board as it stands: if the owner deploys there first, the one army is lost.
// Special units: a commander fights as COMMANDER_STRENGTH (7) armies, attacking and
// defending, and takes no partial damage (armies die first; it falls to 7 damage left
// over), so a stack of d armies plus a commander defends exactly as d + 7: every capture
// cost, worst case, survivor count and hold above counts it, and an enemy commander next
// to my border adds 7 to that player's threat. A target with a special unit is never a
// combined capture. Bosses and custom units are not counted (the board carries no strength for
// them): #128, a territory holding one is never attacked (a warning says so), and an enemy one
// next to me is named as left out of the threat.
// Kill rates: every combat computation above (capture cost, threats and holds,
// survivors, R3's frontier, R4's kills) uses the game's offensive/defensive kill
// rates; only when the settings carry none does it assume 60/70, with a warning.
// Every combination of these rules is planned and then checked by
// warapp_submit_turn's validator (`validateTurn`) in the lessons suite: the planner
// never proposes a turn the validator refuses.
// Accounting: a territory's outgoing armies never exceed its armies after deploy
// minus the guard. Armies never move twice and captured armies never attack, so
// the plan is valid with or without multi-attack.

import { analyzeBonus, bonusTerritories } from './bonuses.js';
import {
  guaranteedKills,
  nextBreakpoint,
  straightKills,
} from './combat.js';
import { neighborsOf } from './graph.js';
import { forecastBorder } from './exchange.js';
import { byNum, pct } from './plan/util.js';
import {
  BREAK_WEIGHT,
  MIN_EXPANSION_SHARE,
  PLAIN_EXPANSION_LOSS,
  type PlanInput,
  SECOND_FRONT_LEAD,
  SECOND_FRONT_SIMILAR,
  type TurnPlan,
  type TwoStepPass,
  type TwoStepShared,
  captureCost,
} from './plan/shared.js';
import { emptyPlan, noteEstimates, planContext } from './plan/estimates.js';
import { deployBook } from './plan/orders.js';
import { holdsPhase, type Threatened, type Unit } from './plan/holds.js';
import { threatsPhase } from './plan/threats.js';
import { targetsPhase, type Breakable } from './plan/targets.js';
import { capturesPhase } from './plan/captures.js';
import { chooseStrikeStack, leadStrikes, spendStrikeStack, strikesPhase } from './plan/strike.js';
import { leftoverDeploy } from './plan/leftover.js';
import { neverStandStill } from './plan/stand-still.js';
import { transfers } from './plan/transfers.js';
import { scheduleOrders, strikeOrderPriority } from './plan/move-order.js';
import { finishPlan, reportExpected, reportOffence } from './plan/report.js';
import { newPlanState } from './plan/state.js';

export * from './plan/shared.js';
export { alliesOf, planEnemyEstimates } from './plan/estimates.js';

/** Passes that refine the cut set (#172) before falling back to the plan that cuts nothing. */
const TWO_STEP_PASSES = 3;
/** Passes that learn which territories in between end held (#172) before none is counted held. */
const VIA_PASSES = 3;

const twoStepPass = (
  shared: TwoStepShared,
  cut: ReadonlySet<number>,
  relaxAttacks: boolean,
  viaHeld: ReadonlyMap<number, boolean> = new Map(),
  viaNever = false,
): TwoStepPass => ({ cut, relaxAttacks, used: false, viaHeld, viaNever, viaSeen: new Map(), viaMixed: false, viaFinal: new Map(), shared });

/**
 * One plan whose "through a territory of mine the plan holds" cut (#172) agrees with how the plan
 * ends: triage can concede a border that this turn's captures make worth keeping (rule 1c), or
 * keep one its stay does not hold, so a decision taken while attacks are sized may not stand at
 * the end. A pass that decided some territory otherwise than it ends is made again with the
 * end's answer (at most VIA_PASSES times), else with none counted held — a decision every order
 * shares, so no rationale states a hold the orders then drop.
 */
function settledPass(
  input: PlanInput,
  shared: TwoStepShared,
  cut: ReadonlySet<number>,
  relaxAttacks: boolean,
): { plan: TurnPlan; used: boolean } {
  let learned = new Map<number, boolean>();
  for (let i = 0; i < VIA_PASSES; i++) {
    const pass = twoStepPass(shared, cut, relaxAttacks, learned);
    const plan = planPass(input, pass);
    if (!pass.viaMixed && [...pass.viaSeen].every(([v, d]) => pass.viaFinal.get(v) === d)) return { plan, used: pass.used };
    learned = new Map([...learned, ...pass.viaFinal]);
  }
  const pass = twoStepPass(shared, cut, relaxAttacks, learned, true);
  return { plan: planPass(input, pass), used: pass.used };
}

/**
 * Plan one turn (see the header). #172: when a two-step hold binds anywhere, the plan is made
 * again with the reaches cut whose stack or territory in between the plan takes, wherever in the
 * plan that order lands: first the captures of the plan as made and of one sized without the
 * hold, then only those the re-made plan still takes, until it takes every territory it cut
 * (a fixed point, so no cut reach is still there); without one, the plan that cuts nothing.
 */
export function planTurn(input: PlanInput): TurnPlan {
  const shared: TwoStepShared = {};
  const { plan, used } = settledPass(input, shared, new Set(), false);
  if (!used) return plan;
  const free = settledPass(input, shared, new Set(), true).plan;
  let cut = new Set([...plan.expected.captures, ...free.expected.captures]);
  for (let i = 0; i < TWO_STEP_PASSES && cut.size > 0; i++) {
    const p = settledPass(input, shared, cut, false).plan;
    const taken = new Set(p.expected.captures);
    const still = new Set([...cut].filter((t) => taken.has(t)));
    if (still.size === cut.size) return p;
    cut = still;
  }
  return plan;
}

function planPass(input: PlanInput, pass: TwoStepPass): TurnPlan {
  // ---- estimates (plan/estimates.ts) ----
  const pc = planContext(input);
  const ps = newPlanState();
  noteEstimates(pc, ps);
  const {
    g, board, s, opts, income, foe, profile, auto, goal, balanced,
    reserve, enemyDeploy, deployOf, incomeOfPlayer, paybackTurns,
  } = pc;
  const {
    territories: state, label, bonusName, mine, mineSet, incomeGain, nextIncomeWith, armiesOf, unitsAt, defenceAt,
    bonusTs, completedBy, territoryShare, plainWorth, inFocus,
  } = pc;
  const {
    guard, rates, chanceOf, chanceAt, costAt, toTake, luck, noSplit,
  } = pc;
  const { armyLead, leadLever, clearLeader, ffaLeader, holdPasses, leadText, myCommanders } = pc;
  const {
    warnings, rationale, avail, locked, spared, captured, combined, moves, survivorsAt, captureOrder, captureUndo,
    staged, incoming,
  } = ps;

  if (!mine.length) return emptyPlan(pc, ps);

  // ---- the deploy book (plan/orders.ts): budget, guard, deploys, pools, protected value ----
  const book = deployBook(pc, ps);
  const {
    guardAt, coverOf, heldNow, gainWith, orderOf, deploy, pools, roomAt, spareAt,
  } = book;
  // As the deploy book reads it, restated here so TypeScript narrows `pools` wherever it is tested.
  const local = pools !== null && pools.bonuses.length > 0;

  // ---- 1t. threat trend, 1. defence (plan/threats.ts) ----
  const threats = threatsPhase(pc, ps, input);
  const { growthOf, reinforcementAt, borders, facing, borderAt } = threats;

  // ---- 1. holds, #172, 1h, 1b, 1c, #122 garrisons (plan/holds.ts) ----
  const hd = holdsPhase(pc, ps, book, threats, pass);
  const {
    acting, conceded, concedeUnaffordable, floorOrConcede, fundNearMiss, fundUnit, garrisonCompleted, heldBorders,
    heldStack, hold, holds, keepFor, kept, keptShort, leftFor, mayHold, noteRecent, reconsider, settleContested,
    twoStepBound, twoStepKeep, uneconomic, units, withdraw,
  } = hd;

  // ---- 2. targets, 4d. frontier cost, bonus scoring, #101 (plan/targets.ts) ----
  const tgt = targetsPhase(pc, ps, input, threats, hd);
  const {
    breakable, counterAt, targets, leadSteps, targetScoreCost, landScoreCost, offence, skipOffence, plans,
    economicMember, uneconomicMember, negativeMember, ratio, committing, byCloseness, retakeChecks, retakeWarning,
  } = tgt;

  // ---- R3, No-Split, capture helper, 3a. combined, passes 1 and 2 (plan/captures.ts) ----
  const caps = capturesPhase(pc, ps, pass, book, threats, hd, tgt);
  const { strikes, worstCase, defendersAt, tryCapture, snapshot, complete, tryExpand, advance } = caps;

  // ---- 1e. finish off an opponent, 1s. strike an enemy commander, #165 guard-off breaks (plan/strike.ts) ----
  const { struck } = strikesPhase(pc, ps, book, threats, hd, tgt, caps);

  if (balanced) {
    // ---- balanced: greedy by income per army ----
    const opponents = Math.max(
      1,
      Math.floor(
        opts.opponents ??
          new Set(
            board.territories.flatMap((t) =>
              t.owner.kind === 'player' && foe(t.owner.playerId) ? [t.owner.playerId] : [],
            ),
          ).size,
      ),
    );
    // Rule 0p.1: in a 1v1 in contact, a break is a completion of equal value (the opponent
    // loses that income), and expansion that completes nothing ranks below holds and breaks.
    const oneVsOne = auto && profile.format === '1v1' && facing.size > 0;
    // Rule 0p.2: in an FFA with two or more opponents left, no second front.
    const ffa = auto && profile.format === 'ffa' && profile.opponents >= 2;
    if (oneVsOne)
      rationale.push(
        '1v1 in contact: breaking an enemy bonus counts like completing one of equal value (the opponent loses that income), and expansion that completes no bonus this turn ranks below holding, breaking and completing.',
      );
    const weight = oneVsOne ? 1 : BREAK_WEIGHT / opponents;
    /** Bonuses I hold in full (value > 0). */
    const heldBonusMembers = g.map.bonuses
      .filter((b) => b.value > 0)
      .map((b) => bonusTerritories(g, b.id))
      .filter((ts) => ts.length > 0 && ts.every((t) => mineSet.has(t)));
    /** Player `p` could take a member of a bonus I hold next turn (its stacks next to it plus its deploy). */
    const threatensMyBonus = (p: number) =>
      heldBonusMembers.some((ts) =>
        ts.some((m) => {
          let movable = 0;
          let growth = 0;
          let next = false;
          for (const n of neighborsOf(g, m)) {
            const st = state.get(n);
            if (st?.owner.kind !== 'player' || st.owner.playerId !== p || st.armies === null) continue;
            next = true;
            movable += Math.max(0, st.armies - guard) + unitsAt(n);
            growth = Math.max(growth, growthOf.get(n)?.growth ?? 0);
          }
          const take = toTake(defenceAt(m));
          return next && take !== null && take <= movable + Math.max(deployOf(p), growth);
        }),
      );
    /** Player `p` loses a territory to this turn's earlier passes (a strike, finishing off, pressure). */
    const beingFinished = (p: number) =>
      [...captured].some((t) => {
        const o = state.get(t)?.owner;
        return o?.kind === 'player' && o.playerId === p;
      });
    /** The best neutral bonus capture per army (complete or advance), 0 with none. */
    const bestNeutral = Math.max(0, ...plans.map(ratio));
    /**
     * Rule 0p.2: breaking `b` would open a second front (said once per bonus; the general rule
     * is said with the first break it skips). Call it only for a break the plan could afford.
     */
    const secondFrontSaid = new Set<number>();
    /** #167: the neutral's share of a break's score that skips it, scaled by my army lead (at least 1×). */
    const similar = SECOND_FRONT_SIMILAR * Math.max(1, Math.min(SECOND_FRONT_LEAD, armyLead.ratio));
    const opensSecondFront = (b: Breakable, score: number): boolean =>
      ffa &&
      !leadLever &&
      b.player !== clearLeader &&
      !threatensMyBonus(b.player) &&
      !beingFinished(b.player) &&
      bestNeutral >= similar * score;
    const secondFront = (b: Breakable, score: number): boolean => {
      if (!opensSecondFront(b, score)) return false;
      if (!secondFrontSaid.has(b.bonusId)) {
        if (!secondFrontSaid.size)
          rationale.push(
            `FFA with ${profile.opponents} opponents left: no second front — a player that threatens no bonus of mine and is not being finished off is not attacked while a neutral capture of similar value exists.`,
          );
        secondFrontSaid.add(b.bonusId);
        rationale.push(
          `Not breaking ${bonusName(b.bonusId)} (+${b.value} from player ${b.player}): no second front in an FFA — player ${b.player} threatens no bonus of mine and is not being finished off, and a neutral capture earns ${bestNeutral.toFixed(2)} per army against ${score.toFixed(2)}${
            similar > SECOND_FRONT_SIMILAR ? ` (it needs ${similar.toFixed(2)}× of it, scaled by my army lead of ${leadText()})` : ''
          }.`,
        );
      }
      return true;
    };
    // Enemy armies that could hit `t` next turn once it is mine (its own armies excluded).
    const counterThreat = (t: number) => {
      const byPlayer = new Map<number, number>();
      for (const n of neighborsOf(g, t)) {
        const st = state.get(n);
        if (st?.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) continue;
        byPlayer.set(st.owner.playerId, (byPlayer.get(st.owner.playerId) ?? 0) + Math.max(0, st.armies - guard) + unitsAt(n));
      }
      // Each opponent's movable armies plus its own deploy estimate; with none next to it, the reported estimate.
      if (!byPlayer.size) return enemyDeploy;
      return Math.max(...[...byPlayer].map(([p, movable]) => movable + deployOf(p)));
    };
    interface Candidate {
      kind: 'hold' | 'unit' | 'complete' | 'advance' | 'break' | 'counter';
      score: number;
      cost: number;
      id: number;
      value: number;
      focus: boolean;
      /** External borders of the bonus (fewer is easier to keep); 0 for holds. */
      borders: number;
      run: () => void;
    }
    const rank = { unit: 0, hold: 0, complete: 1, advance: 2, break: 3, counter: 3 } as const;
    const candidates: Candidate[] = [];
    const deferred: Threatened[] = [];
    /**
     * #215: a pending hold (locked by triage until this step decides) conceded here is unlocked: as
     * any conceded border, it may still attack out with the armies on it (rule 1a).
     */
    const concedePending = (t: Threatened, room: number) => {
      concedeUnaffordable(t, room);
      if (!heldBorders.has(t.id)) locked.delete(t.id);
    };
    let expansionLeft = 0;
    let expansionSpent = 0;
    let topValue = 0;
    const spend = (f: () => void) => () => {
      const before = ps.budget;
      f();
      expansionSpent += before - ps.budget;
      expansionLeft--;
    };
    /** A bonus's worth as the rationale states it: "+22, net +6" when its members carry penalties. */
    const worthOf = new Map<number, string>();
    for (const p of plans) {
      const score = ratio(p);
      // Rule 4c: a completion competes with holds at its net worth (`value` feeds topValue and
      // rule 1h.3's starve check), never its gross value.
      worthOf.set(p.bonusId, p.net === p.value ? `+${p.value}` : `+${p.value}, net +${p.net}`);
      if (p.completable)
        candidates.push({ kind: 'complete', score, cost: p.cost, id: p.bonusId, value: p.net, focus: p.focus, borders: p.borders, run: spend(() => complete(p)) });
      candidates.push({ kind: 'advance', score, cost: p.cost, id: p.bonusId, value: p.net, focus: p.focus, borders: p.borders, run: spend(() => advance(p)) });
    }
    // Capturing a member of a breakable bonus: what survives it, and whether that holds next turn.
    // A break is sized to land (#72): its score leaves out what holding it would need.
    const breakOption = (t: number) => {
      // #201: the FFA leader's break is sized to land for certain against its owner's one deploy.
      const landing = ffaLeader ? defenceAt(t) + reinforcementAt(t) : undefined;
      const cost = (landing !== undefined ? captureCost(landing, s) : null) ?? targets.get(t)!.cost;
      const survivors = cost - straightKills(defenceAt(t), rates.defensiveKillRate);
      const counter = counterThreat(t);
      const take = toTake(survivors);
      return { t, cost, survivors, counter, take, survives: take === null || take > counter, scoreCost: landScoreCost(t) };
    };
    type BreakOption = ReturnType<typeof breakOption>;
    /**
     * What a strike is worth (#72), in income terms like a hold's worth: the income the opponent
     * loses this turn plus the armies it must spend to retake the territory (at least what my
     * survivors need to be taken) over PAYBACK_TURNS, weighted as breaks are.
     */
    const strikeWorth = (lost: number, o: BreakOption) => weight * (lost + (o.take ?? o.survivors) / paybackTurns);
    const round2 = (v: number) => Math.round(v * 100) / 100;
    /**
     * At most what a capture of `t` could draw on now: every source free to attack plus the
     * deployable budget. Below its cost the capture cannot be planned this turn.
     */
    const affordable = (t: number) => {
      const tg = targets.get(t)!;
      const free = tg.sources.filter((x) => !locked.has(x) && !orderOf(x)).reduce((n, x) => n + Math.max(0, avail.get(x)!), 0);
      return free + Math.max(0, ps.budget - reserve) >= tg.cost;
    };
    const broken = (b: Breakable) => bonusTerritories(g, b.bonusId).some((x) => captured.has(x));
    const breakReason = (b: Breakable) =>
      b.probable
        ? `breaks probable enemy bonus ${bonusName(b.bonusId)} (+${b.value} from player ${b.player}; ${b.probable})`
        : `breaks enemy bonus ${bonusName(b.bonusId)} (+${b.value} from player ${b.player})`;
    const warnRetake = (b: Breakable, o: BreakOption) => {
      const warning = retakeWarning(o.t, b.bonusId, o.survivors, o.counter);
      retakeChecks.set(o.t, { bonusId: b.bonusId, survivors: o.survivors, counter: o.counter, warning });
      if (warning) warnings.push(warning);
    };
    const breakOf = new Map<number, Breakable>();
    for (const b of breakable) for (const t of bonusTerritories(g, b.bonusId)) breakOf.set(t, b);
    // A threatened border whose only visible threat is a member of a breakable enemy
    // bonus also attacks it: the capture removes the threat and breaks the bonus. It
    // attacks on top of its hold, never instead of it: the threat assumes the enemy
    // reinforces that member first, so the capture can fail, and what stays on the
    // border must still hold. When the hold plus the capture is unaffordable, it just
    // holds. (A held border otherwise makes no attacks.)
    const holdAndBreak = (t: Threatened, rest = 0): boolean => {
      const threats = neighborsOf(g, t.id).filter((n) => {
        const st = state.get(n);
        return st?.owner.kind === 'player' && foe(st.owner.playerId) && st.armies !== null;
      });
      if (threats.length !== 1) return false;
      const n = threats[0]!;
      const b = breakOf.get(n);
      if (!b || !targets.has(n) || broken(b) || orderOf(t.id)) return false;
      const o = breakOption(n);
      if (t.holdCost + o.cost > spareAt(t.id) - rest) return false;
      // Scored as the break candidates are: landing armies plus the frontier it adds (#71, #72).
      if (secondFront(b, strikeWorth(b.value, o) / Math.max(1, o.scoreCost))) return false;
      const before = ps.budget;
      noteRecent(t);
      deploy(t.id, t.holdCost);
      if (!tryCapture(n, breakReason(b), { from: t.id, keep: avail.get(t.id)! })) {
        // Refused (R3: it would complete a bonus I cannot hold next turn): just hold.
        rationale.push(
          `Deploy ${t.holdCost} to ${label(t.id)} so it holds (protects +${t.value}): ${heldStack(t)} need ${toTake(t.have + t.units + t.holdCost)} to take, above the ~${t.threat} threat.`,
        );
        return true;
      }
      expansionSpent += before - ps.budget - t.holdCost;
      ps.anchor ??= moves[moves.length - 1]!.from;
      rationale.push(
        `${label(n)} is the only visible threat to ${label(t.id)}: capturing it removes that threat and breaks the bonus.`,
        noSplit
          ? `Deploy ${t.holdCost} to ${label(t.id)}: under No-Split its whole stack attacks ${label(n)} and nothing stays behind, so ${label(t.id)} (protects +${t.value}) is safe only once ${label(n)} falls.`
          : `Deploy ${t.holdCost} to ${label(t.id)} so it still holds (protects +${t.value}) after attacking ${label(n)}: ${heldStack(t)} stay, needing ${toTake(t.have + t.units + t.holdCost)} to take, above the ~${t.threat} threat if the attack fails.`,
      );
      warnRetake(b, o);
      // Its own offence entry (#72): the break option may be another member, which never runs.
      offence.set(`break:${b.bonusId}`, {
        bonusId: b.bonusId,
        target: n,
        kind: 'break',
        cost: o.cost,
        value: round2(strikeWorth(b.value, o)),
        taken: true,
        why: `${breakReason(b)}, removing the only visible threat to ${label(t.id)}`,
      });
      return true;
    };
    for (const b of breakable) {
      // Its cheapest visible member (#72: a break only has to land), then the least frontier, then id.
      const options = bonusTerritories(g, b.bonusId)
        .filter((t) => targets.has(t))
        .map(breakOption)
        .sort((a, b) => a.cost - b.cost || a.scoreCost - b.scoreCost || a.t - b.t);
      const o = options[0];
      if (!o) continue;
      const worth = strikeWorth(b.value, o);
      const score = worth / Math.max(1, o.scoreCost);
      offence.set(`break:${b.bonusId}`, {
        bonusId: b.bonusId,
        target: o.t,
        kind: 'break',
        cost: o.cost,
        value: round2(worth),
        taken: false,
        why: breakReason(b),
      });
      // An FFA skips a second-front break, but only one the plan could pay for is named as
      // skipped: an unaffordable one is dropped quietly (it could not run either way).
      if (opensSecondFront(b, score) && !affordable(o.t)) {
        skipOffence(o.t, 'not affordable this turn');
        continue;
      }
      if (secondFront(b, score)) {
        skipOffence(o.t, `no second front in an FFA: player ${b.player} threatens no bonus of mine`);
        continue;
      }
      candidates.push({
        kind: 'break',
        score,
        cost: o.cost,
        id: b.bonusId,
        value: b.value,
        focus: false,
        borders: analyzeBonus(g, b.bonusId)!.borderTerritoryIds.length,
        run: spend(() => {
          // Already broken (by a border attacking its only threat): one capture is enough.
          if (broken(b)) return;
          if (ffaLeader && o.cost > targets.get(o.t)!.cost) {
            const tg = targets.get(o.t)!;
            const was = worstCase.get(o.t);
            targets.set(o.t, { ...tg, cost: o.cost });
            worstCase.set(o.t, defenceAt(o.t) + reinforcementAt(o.t));
            if (!tryCapture(o.t, `${breakReason(b)}, sized to land against player ${b.player}'s ~${reinforcementAt(o.t)} deploy (#201: I lead this free-for-all)`)) {
              targets.set(o.t, tg);
              if (was === undefined) worstCase.delete(o.t);
              else worstCase.set(o.t, was);
              return;
            }
          } else if (!tryCapture(o.t, breakReason(b))) return;
          ps.anchor ??= moves[moves.length - 1]!.from;
          warnRetake(b, o);
        }),
      });
    }
    // Counter-attacks (#72): a stack that shrank fighting me, scored like a break that breaks no
    // bonus (the armies its owner must spend to retake it). It is already fighting me (it
    // attacked me, or held off my attack), so it is never a second front.
    for (const [t, c] of counterAt) {
      if (!targets.has(t)) continue;
      const o = breakOption(t);
      const worth = strikeWorth(0, o);
      const reason = `counter-attacks player ${c.player}'s ${label(t)}, which shrank from ${c.from} to ${c.to} fighting me last turn (attacking me, or holding off an attack of mine) (${c.costNow} to take now, ${c.costThen} before)`;
      offence.set(`counter:${t}`, { target: t, kind: 'counter', cost: o.cost, value: round2(worth), taken: false, why: reason });
      candidates.push({
        kind: 'counter',
        score: worth / Math.max(1, o.scoreCost),
        cost: o.cost,
        id: t,
        value: worth,
        focus: false,
        borders: 0,
        run: spend(() => {
          if (captured.has(t)) return;
          if (!tryCapture(t, reason)) return;
          ps.anchor ??= moves[moves.length - 1]!.from;
        }),
      });
    }
    expansionLeft = candidates.length;
    // Under rule 0p.1 an advance never outranks a hold, so it never defers one either.
    topValue = Math.max(0, ...candidates.filter((c) => !(oneVsOne && c.kind === 'advance')).map((c) => c.value));
    let floor = expansionLeft ? Math.ceil(MIN_EXPANSION_SHARE * income) : 0;
    // #167: a multi-turn view of the main front. Adapting in contact, the expansion share stands only
    // when the front is no worse than a stand-off without those armies: my biggest stack facing the
    // opponent with the biggest stack next to me, deploying the income less the share every turn
    // against that stack on the opponent's whole deploy (`forecastBorder`). Ground down so, the share
    // is dropped this turn and holds come first.
    if (floor > 0 && auto && (profile.phase === 'contact' || profile.phase === 'late')) {
      let front: { theirs: number; at: number; player: number; mine: number; from: number } | undefined;
      for (const [id, st] of [...state].sort((a, b) => a[0] - b[0])) {
        if (st.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) continue;
        const mineNext = neighborsOf(g, id).filter((n) => mineSet.has(n));
        if (!mineNext.length) continue;
        const from = [...mineNext].sort((x, y) => armiesOf(y) - armiesOf(x) || x - y)[0]!;
        const theirs = st.armies + unitsAt(id);
        if (!front || theirs > front.theirs)
          front = { theirs, at: id, player: st.owner.playerId, mine: armiesOf(from) + unitsAt(from), from };
      }
      if (front) {
        const f = forecastBorder({
          mine: front.mine,
          theirs: front.theirs,
          myIncome: income,
          // Every turn's income, not this turn's deploy: a card is played once (#164).
          theirIncome: incomeOfPlayer(front.player),
          myDeploy: income - floor,
          settings: { offensiveKillRate: rates.offensiveKillRate, defensiveKillRate: rates.defensiveKillRate, oneArmyStandsGuard: guard === 1 },
        });
        const pair = `my ${front.mine} on ${label(front.from)} against player ${front.player}'s ${front.theirs} on ${label(front.at)}, each deploying there every turn`;
        // `breaks` means pressing captures before being pressed grinds me down; the plan commits to
        // pressing only when its orders already take that stack. Otherwise being pressed with the
        // income less the share decides: the border pins more than that, so the share goes.
        const pressedGrinds = f.pinned > income - floor;
        const pressing = captured.has(front.at);
        if (f.outcome === 'ground-down') {
          rationale.push(
            `Front outlook (#167): ${pair}, with ${income - floor} a turn (the income less the ${floor} expansion share) I am ground down on turn ${f.turn} — the border pins ${f.pinned} of my ${income} income. Holds come before the expansion share this turn.`,
          );
          floor = 0;
        } else if (f.outcome === 'breaks' && pressedGrinds && !pressing) {
          rationale.push(
            `Front outlook (#167): ${pair}, my stack breaks it on turn ${f.turn} only if the plan presses it, and it does not; pressed, with ${income - floor} a turn (the income less the ${floor} expansion share) I am ground down — the border pins ${f.pinned} of my ${income} income. Holds come before the expansion share this turn.`,
          );
          floor = 0;
        } else if (f.outcome === 'breaks' && pressedGrinds)
          rationale.push(
            `Front outlook (#167): ${pair}, my stack breaks it on turn ${f.turn}, and the plan presses it this turn (pressed instead, the border pins ${f.pinned} of my ${income} income): the expansion share stands.`,
          );
        else
          rationale.push(
            `Front outlook (#167): ${pair}, ${f.outcome === 'breaks' ? `my stack breaks it on turn ${f.turn}` : 'it is a stand-off'} even with ${floor} of income going to expansion (the border pins ${f.pinned}): the expansion share stands.`,
          );
      }
    }
    for (const t of holds)
      candidates.push({
        kind: 'hold',
        // A border just taken from a weak opponent is held first: conceding it hands it back.
        score: t.recentFrom !== undefined ? Infinity : t.worth / t.holdCost,
        cost: t.holdCost,
        id: t.id,
        value: t.value,
        focus: false,
        borders: 0,
        run: () => {
          // Already garrisoned for a bonus this turn completed (#122).
          if (heldBorders.has(t.id)) return;
          if (holdAndBreak(t)) return;
          const pending =
            expansionLeft > 0 && t.worth < topValue && t.recentFrom === undefined ? Math.max(0, floor - expansionSpent) : 0;
          const room = roomAt(t.id);
          // #215: conceded, its armies may attack out (rule 1a) in the passes still to run.
          if (t.holdCost > room) return concedePending(t, room);
          if (t.holdCost > room - pending) {
            deferred.push(t);
            rationale.push(
              `Hold ${label(t.id)} later (needs ${t.holdCost}, protects +${t.value}): at least ${floor} of income (${MIN_EXPANSION_SHARE * 100}%) goes to expansion first, worth up to +${topValue}.`,
            );
            return;
          }
          hold(t);
        },
      });
    // A conceded unit's members, judged on their own now (rule 1a, against what is left).
    const singleNow = (t: Threatened, quiet: boolean) => {
      if (t.critical) return;
      if (uneconomic(t)) {
        conceded.add(t.id);
        if (!quiet)
          warnings.push(`${label(t.id)} cannot be held economically (needs ${t.holdCost}, protects +${t.value}): conceded`);
        return;
      }
      const room = roomAt(t.id);
      if (t.holdCost > room) {
        if (quiet) conceded.add(t.id);
        else concedeUnaffordable(t, room);
        return;
      }
      hold(t);
      heldBorders.add(t.id);
    };
    /** Units waiting for the expansion share (rule 4a's MIN_EXPANSION_SHARE), funded before any advance or break. */
    const waiting: Unit[] = [];
    const fundOrConcede = (u: Unit) => {
      if (u.conceded) return;
      if (!fundUnit(u, holdAndBreak) && !fundNearMiss(u)) floorOrConcede(u, leftFor(u), singleNow);
    };
    let unitsDue = false;
    const unitOf = new Map<Candidate, Unit>();
    for (const u of units) {
      if (u.conceded || u.contested) continue;
      const c: Candidate = {
        kind: 'unit',
        score: u.members.some((m) => m.recentFrom !== undefined) ? Infinity : u.worth / u.net,
        cost: u.cost,
        id: u.members[0]!.id,
        value: u.value,
        focus: false,
        borders: 0,
        run: () => {
          if (u.conceded) return;
          const recent = u.members.some((m) => m.recentFrom !== undefined);
          // #201, ahead: held for the worst case before any capture, completions included — no
          // waiting behind the expansion share.
          const pending =
            holdPasses !== 'worst' && !unitsDue && expansionLeft > 0 && u.worth < topValue && !recent ? Math.max(0, floor - expansionSpent) : 0;
          const cost = u.members.filter((m) => !heldBorders.has(m.id)).reduce((n, m) => n + m.holdCost, 0);
          if (cost <= ps.budget && cost > ps.budget - pending) {
            waiting.push(u);
            rationale.push(
              `Hold ${u.members.map((m) => label(m.id)).join(', ')} after this turn's bonus completions (needs ${cost}, protects +${u.value}): a completion worth up to +${topValue} may go first, but the hold is funded before any capture that completes nothing.`,
            );
            return;
          }
          fundOrConcede(u);
        },
      };
      candidates.push(c);
      unitOf.set(c, u);
    }
    candidates.sort(
      (a, b) =>
        Number(b.focus) - Number(a.focus) ||
        // #201: ahead, every held bonus is held for the worst case before any capture (said below).
        (holdPasses === 'worst' ? Number(b.kind === 'unit') - Number(a.kind === 'unit') : 0) ||
        (oneVsOne ? Number(a.kind === 'advance') - Number(b.kind === 'advance') : 0) ||
        b.score - a.score ||
        a.cost - b.cost ||
        a.borders - b.borders ||
        rank[a.kind] - rank[b.kind] ||
        a.id - b.id,
    );
    if (holdPasses === 'worst' && candidates.some((c) => c.kind === 'unit'))
      rationale.push(
        `Ahead (#201): every held bonus is held for the worst case (each threatened border against the whole deploy) before any capture, completions included — the leader takes the option that still works when the opponent guesses right.`,
      );
    // #101: completions and advances keep the slots their scores give them, but fill them
    // closest to completion first.
    if (committing) {
      const order = new Map(byCloseness.map((p, i) => [p.bonusId, i]));
      for (const kind of ['complete', 'advance'] as const) {
        const slots = candidates.flatMap((c, i) => (c.kind === kind ? [i] : []));
        const sorted = slots.map((i) => candidates[i]!).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
        slots.forEach((i, k) => (candidates[i] = sorted[k]!));
      }
    }
    // A held-bonus unit that pays for itself is funded before any capture that completes
    // no bonus (an advance or a break, unless focused): at the first such capture, every
    // unit still pending runs first, with the completions that outscore the weakest of them.
    const done = new Set<Candidate>();
    // Rule 1h.3: a completion that outscores a pending unit per army still must not starve
    // it. When completing it first leaves too little to fund units it could have, it runs
    // only if its bonus earns more than those units; otherwise it waits until they are funded.
    const postponed: Candidate[] = [];
    const unitNeed = (u: Unit) => u.members.filter((m) => !heldBorders.has(m.id)).reduce((n, m) => n + m.holdCost, 0);
    /** The units `b` armies fund, taken in order (a unit that does not fit is skipped). */
    const fundable = (us: Unit[], b: number) =>
      us.filter((u) => {
        const need = unitNeed(u);
        // Under Local Deployment (#122) only what may be deployed on its borders counts (its own
        // pool and the free armies): a unit that is a near miss already is not starved by a capture.
        if (need > b || (local && need > leftFor(u))) return false;
        b -= need;
        return true;
      });
    const run = (c: Candidate) => {
      done.add(c);
      const pending =
        c.kind === 'complete' && !c.focus
          ? [...waiting, ...candidates.filter((d) => d.kind === 'unit' && !done.has(d)).map((d) => unitOf.get(d)!)].filter(
              (u) => !u.conceded,
            )
          : [];
      if (!pending.length) return c.run();
      const before = fundable(pending, ps.budget);
      const restore = snapshot();
      const spent = expansionSpent;
      const left = expansionLeft;
      c.run();
      const after = new Set(fundable(pending, ps.budget));
      const starved = before.filter((u) => !after.has(u));
      const lost = starved.reduce((n, u) => n + u.value, 0);
      // #122: a starved unit that cannot even be kept short (near miss, floor) is conceded. Waiting
      // costs the completion one turn of its value; conceding a held bonus loses its value every
      // turn until it is retaken — counted over PAYBACK_TURNS, the horizon every payback test
      // uses. So the completion goes first only when its one turn earns more than that.
      // Under Local Deployment only what may be deployed on its borders counts (pools respected).
      const kept = starved.map((u) => keptShort(u, local ? Math.min(ps.budget, leftFor(u)) : ps.budget));
      const conceding = starved.filter((_, i) => !kept[i]).reduce((n, u) => n + u.value, 0);
      // Units only left short (a near miss, a floor) still stand: the completion goes first when it
      // earns more than they are worth, or — when each stays a near miss — pays for itself within a
      // turn (#122: a +3 for 3 armies was deferred so a near miss could be topped up to sure).
      const first =
        conceding > 0
          ? c.value > paybackTurns * conceding
          : c.value > lost || (kept.every((k) => k === 'near') && c.cost <= c.value);
      if (!starved.length || first) return;
      restore();
      expansionSpent = spent;
      expansionLeft = left;
      postponed.push(c);
      rationale.push(
        `Complete bonus ${bonusName(c.id)} (${worthOf.get(c.id) ?? `+${c.value}`}) only after holding ${starved.map((u) => `${bonusName(u.bonusId)} (+${u.value})`).join(', ')}: completing it first would leave too little to hold ${starved.length === 1 ? 'it' : 'them'}, ${conceding > 0 ? `and waiting a turn costs +${c.value} once while losing ${starved.length === 1 ? 'it' : 'them'} costs +${conceding} every turn until retaken` : 'and it earns no more'}.`,
      );
    };
    const runPostponed = () => {
      for (const c of postponed.splice(0)) c.run();
    };
    candidates.forEach((c, i) => {
      if (done.has(c)) return;
      if ((c.kind === 'advance' || c.kind === 'break' || c.kind === 'counter') && !c.focus && !unitsDue) {
        unitsDue = true;
        // Those waiting for the expansion share outscore everything still to run.
        for (const u of waiting.splice(0)) fundOrConcede(u);
        const pending = candidates.filter((d) => d.kind === 'unit' && !done.has(d));
        if (pending.length) {
          const bar = Math.min(...pending.map((d) => d.score));
          for (const d of candidates.slice(i + 1))
            if (!done.has(d) && (d.kind === 'unit' || (d.kind === 'complete' && d.score > bar))) run(d);
        }
        runPostponed();
        garrisonCompleted();
      }
      // #128: a hold deferred for the expansion share is not then starved by a capture that
      // completes nothing: when this one leaves too little for a hold still waiting, it is undone,
      // the waiting holds are funded first, and it runs again on what is left (if it still fits).
      const owed = deferred.filter((t) => !heldBorders.has(t.id) && !conceded.has(t.id));
      if ((c.kind === 'advance' || c.kind === 'break' || c.kind === 'counter') && !c.focus && owed.length) {
        const restore = snapshot();
        const spent = expansionSpent;
        const left = expansionLeft;
        run(c);
        // Every owed hold must fit what is left together, not each on its own: two holds of 4
        // with 5 left both pass alone, and the second would be conceded later.
        if (owed.every((t) => t.holdCost <= roomAt(t.id)) && owed.reduce((n, t) => n + t.holdCost, 0) <= ps.budget)
          return garrisonCompleted();
        restore();
        expansionSpent = spent;
        expansionLeft = left;
        for (const t of owed)
          if (t.holdCost <= roomAt(t.id)) {
            rationale.push(
              `Hold ${label(t.id)} now after all: the capture that would have gone first completes no bonus and would leave too little to hold it later.`,
            );
            hold(t);
            heldBorders.add(t.id);
          }
      }
      run(c);
      garrisonCompleted();
    });
    unitsDue = true;
    for (const u of waiting.splice(0)) fundOrConcede(u);
    runPostponed();
    garrisonCompleted();
    for (const t of deferred) {
      if (heldBorders.has(t.id)) continue;
      const room = roomAt(t.id);
      if (t.holdCost > room) concedePending(t, room);
      else hold(t);
    }
    settleContested();
    reconsider();
    withdraw();
  } else {
    for (const p of byCloseness) {
      complete(p);
      garrisonCompleted();
    }
    for (const p of byCloseness) {
      advance(p);
      garrisonCompleted();
    }
    settleContested();
    reconsider();
    if (acting) withdraw();
  }

  // #203: a lead step the bonus passes did not take is an ordinary enemy territory again: out of
  // the targets (rule 4e's fallback, the card-piece pass and the lead strikes size it their own
  // way), its sure cost and sizing gone with it.
  for (const t of [...leadSteps.keys()])
    if (!captured.has(t)) {
      targets.delete(t);
      leadSteps.delete(t);
    }

  // ---- pass 3: other expansion ----
  if (goal !== 'complete-bonus') {
    const rest = [...targets.values()]
      .filter(
        (t) =>
          !captured.has(t.id) &&
          !(balanced && t.enemy) &&
          // #125: a member of an uneconomic bonus is still a territory worth its per-territory income.
          (economicMember.has(t.id) ||
            !uneconomicMember.has(t.id) ||
            (territoryShare(1) > 0 && !negativeMember.has(t.id))),
      )
      .sort((a, b) => targetScoreCost(a.id) - targetScoreCost(b.id) || a.cost - b.cost || a.id - b.id);
    // Rule 4c: plain expansion never lowers income (a capture completing a negative bonus).
    for (const t of rest) {
      const gain = gainWith([t.id]);
      if (gain < 0 && !inFocus(t.id)) continue;
      // #125: its own economy test. A member of an economic bonus is judged by that bonus; any
      // other capture pays for the armies it loses with the income it adds within PAYBACK_TURNS,
      // and one that adds none may lose at most PLAIN_EXPANSION_LOSS.
      if (!inFocus(t.id) && !economicMember.has(t.id)) {
        const lost = straightKills(defenceAt(t.id), rates.defensiveKillRate);
        const worth = plainWorth(t.id, gain);
        if (worth > 0 ? lost > paybackTurns * worth : lost > PLAIN_EXPANSION_LOSS) {
          const reach = Math.max(...neighborsOf(g, t.id).filter((x) => avail.has(x)).map((x) => (avail.get(x) ?? 0) + roomAt(x)));
          if (reach >= t.cost)
            rationale.push(
              worth > 0
                ? `Do not expand into ${label(t.id)}: it adds +${worth} a turn and loses ~${lost} armies, more than ${paybackTurns} turns of it pay back.`
                : `Do not expand into ${label(t.id)}: it adds no income and loses ~${lost} armies (more than ${PLAIN_EXPANSION_LOSS}), in no bonus worth completing.`,
            );
          continue;
        }
      }
      tryExpand(t.id, 'expands territory');
    }
  }

  // ---- 4e. never stand still (#104, #107), the contact fallback (plan/stand-still.ts) ----
  const { saveStep } = neverStandStill(pc, ps, book, threats, hd, tgt, caps);

  // ---- 4g. a capture worth a card piece (#127) ----
  // Any capture this turn earns the turn's card pieces. With none planned (every goal but
  // `complete-bonus`; not while the 1v1 strike stack, rule 0p.3c, is contact's answer), the capture
  // losing the fewest armies (the defenders' kills on its attackers) is taken when that loss is no
  // more than the pieces are worth (`cardPieceValue`) — neutrals before players' territories, then
  // the cheapest, then id — with the usual sizing, every source keeping what holds it, never one
  // lowering income.
  const pieceValue = opts.cardPieceValue ?? 0;
  if (pieceValue > 0 && goal !== 'complete-bonus' && captured.size === 0 && !(auto && profile.format === '1v1' && goal !== 'defend' && facing.size > 0)) {
    const loss = (t: number) => straightKills(defendersAt(t), rates.defensiveKillRate);
    const candidates = [...targets.values()]
      .filter((tg) => !captured.has(tg.id) && !spared.has(tg.id) && loss(tg.id) <= pieceValue && gainWith([tg.id]) >= 0)
      .sort((a, b) => loss(a.id) - loss(b.id) || Number(a.enemy) - Number(b.enemy) || a.cost - b.cost || a.id - b.id);
    for (const tg of candidates) {
      const reason = `a capture earns this turn's card pieces, worth ~${pieceValue} armies, and this one loses ~${loss(tg.id)} (#127)`;
      if (tryCapture(tg.id, reason)) break;
    }
  }

  // ---- rule 4c's guard: planned captures never lower next income (#70) ----
  // Known limit: dropping a capture rewinds its attacks, `avail`, `captured`, `survivorsAt` and
  // its own move/rationale/warning lines, but decisions made while it was assumed are not
  // re-checked: an earlier R3 `defensible()` may have counted its survivors, `anchor` may still
  // name its source, and a "Keep X (not conceded): this turn's captures complete ..." line may
  // cite a completion that no longer happens. Only maps with overlapping negative bonuses reach
  // this path (elsewhere no capture lowers income).
  {
    const order = captureOrder.filter((t, i) => captured.has(t) && captureOrder.lastIndexOf(t) === i);
    /** The negative bonuses `t` helps complete in the plan as it stands, as "name value". */
    const negativesOf = (t: number) =>
      completedBy(heldNow())
        .filter((id) => g.bonusById.get(id)!.value < 0 && bonusTs.get(id)!.includes(t))
        .map((id) => `${bonusName(id)} ${g.bonusById.get(id)!.value}`);
    let gain = incomeGain(heldNow());
    for (const t of [...order].reverse()) {
      if (gain >= 0) break;
      const after = incomeGain(new Set([...mine, ...captured].filter((x) => x !== t)));
      if (after <= gain) continue;
      // Kept: a focused bonus, a staging step (rule c), a commander strike, finishing off.
      if (inFocus(t) || staged.has(t) || strikes.has(t) || worstCase.has(t)) continue;
      const negatives = negativesOf(t);
      captureUndo.get(t)!();
      captured.delete(t);
      survivorsAt.delete(t);
      combined.delete(t);
      for (let i = moves.length - 1; i >= 0; i--) if (moves[i]!.kind === 'attack' && moves[i]!.to === t) moves.splice(i, 1);
      const attack = `Attack ${label(t)} `;
      for (let i = rationale.length - 1; i >= 0; i--) if (rationale[i]!.startsWith(attack)) rationale.splice(i, 1);
      for (let i = warnings.length - 1; i >= 0; i--)
        if (
          warnings[i]!.startsWith(`Attack on enemy ${label(t)} `) ||
          warnings[i]!.startsWith(`${label(t)} can be retaken `) ||
          warnings[i]!.startsWith(`The capture of ${label(t)} combines `)
        )
          warnings.splice(i, 1);
      rationale.push(
        `Drop the attack on ${label(t)}: it completes ${negatives.join(', ')}, and next income would fall below the ${nextIncomeWith(0)} it is without these captures (next income ${nextIncomeWith(gain)} → ${nextIncomeWith(after)} without it); its armies stay where they are.`,
      );
      gain = after;
    }
    if (gain < 0) {
      const kept = order.flatMap((t) => {
        const negs = captured.has(t) ? negativesOf(t) : [];
        if (!negs.length) return [];
        // Dropping it would not raise income: it also completes a positive bonus (rule 4c(a)).
        const positives = completedBy(heldNow()).filter(
          (id) => g.bonusById.get(id)!.value > 0 && bonusTs.get(id)!.includes(t),
        );
        const why = inFocus(t)
          ? 'focused'
          : staged.has(t)
            ? `stages bonus ${bonusName(staged.get(t)!)}`
            : strikes.has(t)
              ? 'a commander strike'
              : worstCase.has(t)
                ? 'finishing off a player'
                : positives.length
                  ? `completes bonus ${positives.map(bonusName).join(', ')}`
                  : 'dropping it would not raise income';
        return [`${label(t)} (${negs.join(', ')}; ${why})`];
      });
      warnings.push(
        `This plan lowers next income from ${nextIncomeWith(0)} to ${nextIncomeWith(gain)}: its captures complete negative bonuses — ${kept.join('; ')}.`,
      );
    }
  }

  // Rule 1c again (#122): a capture made after the first reconsideration (pass 3, rule 4e's
  // fallback) may complete a bonus too, and its conceded borders are kept the same way.
  reconsider();

  /** Territories locked before the leftover deploy: holds, kept and standing borders, withdrawals. */
  const holdLocked = new Set(locked);
  /** A territory the plan has not given up (or gave up but whose garrison may still hold it). */
  const open = (id: number) => !conceded.has(id) || mayHold.has(id);
  /** Armies that stay on a border after its deploys, outgoing moves and incoming withdrawals. */
  const stays = (id: number) => avail.get(id)! + guardAt(id) + (incoming.get(id) ?? 0);
  // ---- concentrate (#72, rule 0p.3c): the 1v1 strike stack's border (plan/strike.ts) ----
  const { stack, smallExpansion } = chooseStrikeStack(pc, ps, book, threats, open, stays);
  // ---- 5. the leftover deploy (plan/leftover.ts) ----
  const leftover = leftoverDeploy(pc, ps, book, threats, hd, tgt, saveStep, stack, open, stays);
  let { strikeStack } = leftover;
  const { poolDeployed, staging } = leftover;

  // The stack exists whether or not a leftover reached it (#102): holds and captures may take the
  // whole income, and an 80-stack must not stand idle for want of one spare army.
  if (stack && !strikeStack) strikeStack = { ...stack, deployed: 0 };

  // ---- spend the strike stack (#102) (plan/strike.ts) ----
  spendStrikeStack(pc, ps, input, book, threats, tgt, caps, strikeStack, poolDeployed, holdLocked, smallExpansion);

  // A kept border the leftover could not make safe: the completed bonus can fall with it.
  for (const t of [...kept].sort(byNum)) {
    const b = borders.get(t)!;
    const stays = avail.get(t)! + guardAt(t) + (incoming.get(t) ?? 0);
    const take = toTake(stays + unitsAt(t));
    if (take !== null && take <= b.threat)
      warnings.push(
        `${label(t)} is kept for the bonus this turn completes, but its ${stays} armies need only ${take} to take against the ~${b.threat} threat: the bonus can fall next turn.`,
      );
  }

  // ---- No-Split: every order carries the whole stack (#124) ----
  // An order already sends everything on its source when it is planned; a deploy that reached the
  // source afterwards (the leftover, a Local Deployment pool) leaves with it too.
  if (noSplit)
    for (const m of moves) {
      const extra = avail.get(m.from)!;
      if (extra <= 0) continue;
      const was = m.armies;
      avail.set(m.from, 0);
      m.armies += extra;
      const at = moves.filter((o) => o.kind === 'attack' && o.to === m.to);
      if (m.kind === 'transfer') incoming.set(m.to, (incoming.get(m.to) ?? 0) + extra);
      else if (at[at.length - 1] === m) {
        // The attack that moves in: more survivors, against what the attacks before it leave.
        const before = at.slice(0, -1).reduce((n, o) => n + straightKills(o.armies, rates.offensiveKillRate), 0);
        if (survivorsAt.has(m.to)) survivorsAt.set(m.to, survivorsAt.get(m.to)! + extra);
        m.winChance = chanceOf(m.armies, Math.max(0, defenceAt(m.to) - before));
      } else {
        // A softener: its survivors come home.
        incoming.set(m.from, (incoming.get(m.from) ?? 0) + extra);
        const before = at.slice(0, at.indexOf(m)).reduce((n, o) => n + straightKills(o.armies, rates.offensiveKillRate), 0);
        if (straightKills(m.armies, rates.offensiveKillRate) >= defenceAt(m.to) - before)
          warnings.push(
            `No-Split: ${label(m.from)}'s deploys leave with its softening attack on ${label(m.to)}, which may then take it alone; the attacks after it would then move in as transfers.`,
          );
      }
      // Its rationale line names the new size.
      const heads = (n: number) => [
        `Attack ${label(m.to)} from ${label(m.from)} with ${n}`,
        `Attack ${label(m.to)} from the strike stack ${label(m.from)} with ${n}`,
        `Withdraw ${n} from ${label(m.from)} to ${label(m.to)}`,
      ];
      const old = heads(was);
      const r = rationale.findIndex((l) => old.some((h) => l.startsWith(h) && /^[:,( ]/.test(l.slice(h.length))));
      if (r >= 0) {
        const i = old.findIndex((h) => rationale[r]!.startsWith(h) && /^[:,( ]/.test(rationale[r]!.slice(h.length)));
        rationale[r] = `${heads(m.armies)[i]}${rationale[r]!.slice(old[i]!.length)}`;
      }
      rationale.push(
        `No-Split: the ${extra} deployed on ${label(m.from)} after its order was planned leave with it (${m.kind === 'attack' ? 'attacking' : 'moving to'} ${label(m.to)} with ${m.armies}, the whole stack).`,
      );
    }

  // ---- #167: lead strikes (plan/strike.ts) ----
  const { leadSpareFor } = leadStrikes(pc, ps, book, threats, hd, tgt, caps, holdLocked, strikeStack);

  // ---- efficient sizes (S2) ----
  // An attack below its next kill breakpoint is topped up to it from armies that would sit
  // idle on its source — never from a hold, a conceded border, my commander's territory, or
  // a source still facing an enemy after this turn's captures — when the extra kill can matter:
  // the target is a player's (its owner may reinforce it) or the attack is not certain.
  // Otherwise an attack between breakpoints is named as wasting armies.
  const rounding = s.roundingMode ?? 'StraightRound';
  const killsBy = (n: number) => guaranteedKills(n, rates.offensiveKillRate, luck, rounding);
  /**
   * Armies on `src` that would sit idle: none on a hold, a conceded border, my commander's
   * territory, or a border still facing an enemy once this turn's captures land (what stays
   * there defends it).
   */
  const idleAt = (src: number): number => {
    if (!mineSet.has(src) || holdLocked.has(src) || conceded.has(src) || myCommanders.has(src)) return 0;
    if (borderAt(src, (x) => captured.has(x))) return 0;
    // #172: nor what a stack two steps away needs it to keep.
    const far = twoStepKeep(src);
    if (far > 0) twoStepBound.add(src);
    // #179: nor what covers a finished-off player's exit.
    return Math.max(0, avail.get(src)! - Math.max(far, coverOf(src)));
  };
  /**
   * #120: armies on `src` beyond what holds it once this turn's captures land — none on a hold, a
   * conceded border or the strike stack; on my commander's territory, or a border that cannot hold
   * on what it has, none either (keepFor keeps everything there).
   */
  const spareBeyondHold = (src: number): number => {
    if (!mineSet.has(src) || holdLocked.has(src) || conceded.has(src)) return 0;
    // #172: the larger of its one-step hold and what a stack two steps away needs it to keep.
    const near = keepFor(src, () => false);
    const far = twoStepKeep(src);
    if (far > near) twoStepBound.add(src);
    return Math.max(0, avail.get(src)! - Math.max(near, far));
  };
  /** The plain "assumes its owner does not reinforce" warning on an attack on `t`. */
  const assumes = (t: number) => `Attack on enemy ${label(t)} assumes its owner does not reinforce it first.`;
  // No-Split (#124): every attack already sends its whole stack; there is nothing to top up or trim.
  for (const m of noSplit ? [] : moves) {
    if (m.kind !== 'attack' || combined.has(m.to)) continue;
    // Sized for a worst case already (finishing a player off, fog pressure, a commander strike).
    const worst = worstCase.has(m.to) || strikes.has(m.to);
    const d = defenceAt(m.to);
    const chance = m.winChance ?? chanceOf(m.armies, d);
    const enemyTarget = state.get(m.to)?.owner.kind === 'player';
    // #120: an attack on a player's territory is sized for its defenders plus what its owner may
    // deploy there first, when armies beyond what holds the source cover it.
    const extra = enemyTarget && !worst ? reinforcementAt(m.to) : 0;
    const full = extra > 0 ? costAt(m.to, d + extra) : null;
    if (full !== null && full > m.armies && full - m.armies <= spareBeyondHold(m.from)) {
      const before = m.armies;
      const add = full - before;
      avail.set(m.from, avail.get(m.from)! - add);
      m.armies = full;
      m.winChance = chanceOf(full, d);
      worstCase.set(m.to, d + extra);
      if (survivorsAt.has(m.to)) survivorsAt.set(m.to, survivorsAt.get(m.to)! + add);
      const check = retakeChecks.get(m.to);
      const at = check?.warning === undefined ? -1 : warnings.indexOf(check.warning);
      if (check && at >= 0) {
        check.survivors += add;
        check.warning = retakeWarning(m.to, check.bonusId, check.survivors, check.counter);
        if (check.warning) warnings[at] = check.warning;
        else warnings.splice(at, 1);
      }
      const w = warnings.indexOf(assumes(m.to));
      if (w >= 0) warnings.splice(w, 1);
      const owner = (state.get(m.to)!.owner as { playerId: number }).playerId;
      rationale.push(
        `Size the attack on ${label(m.to)} from ${label(m.from)} up from ${before} to ${full} with ${add} idle armies there: ${full} take it even if player ${owner} deploys its ~${extra} there first (${d} + ${extra} defenders), and ${label(m.from)} still holds.`,
      );
      continue;
    }
    const next = nextBreakpoint(m.armies, rates.offensiveKillRate, luck, rounding);
    const add = next === null ? 0 : next - m.armies;
    if (next !== null && add > 0 && !worst && (enemyTarget || chance < 1) && add <= idleAt(m.from)) {
      const before = m.armies;
      avail.set(m.from, avail.get(m.from)! - add);
      m.armies = next;
      m.winChance = chanceOf(next, d);
      if (survivorsAt.has(m.to)) survivorsAt.set(m.to, survivorsAt.get(m.to)! + add);
      // A break's retake warning was judged on the survivors before the top-up: re-judge it.
      const check = retakeChecks.get(m.to);
      const at = check?.warning === undefined ? -1 : warnings.indexOf(check.warning);
      if (check && at >= 0) {
        check.survivors += add;
        check.warning = retakeWarning(m.to, check.bonusId, check.survivors, check.counter);
        if (check.warning) warnings[at] = check.warning;
        else warnings.splice(at, 1);
      }
      const why = enemyTarget ? 'its owner may reinforce it' : `the win chance rises from ${pct(chance)} to ${pct(m.winChance)}`;
      rationale.push(
        `Top up the attack on ${label(m.to)} from ${label(m.from)} from ${before} to ${next} with ${add} idle armies there: ${next} is the next efficient size, killing ${killsBy(next)} for sure instead of ${killsBy(before)} (${why}).`,
      );
      continue;
    }
    const kills = killsBy(m.armies);
    if (kills <= 0 || killsBy(m.armies - 1) < kills) continue;
    let b = m.armies - 1;
    while (b > 1 && killsBy(b - 1) === kills) b--;
    if (chanceOf(b, d) < chance) continue;
    rationale.push(
      `The attack on ${label(m.to)} from ${label(m.from)} sends ${m.armies}, but ${b} already kill ${kills} for sure: the other ${m.armies - b} add no kill (only survivors)${next !== null ? `; the next kill needs ${next}` : ''}.`,
    );
  }
  // #120: an attack on a player's territory still sized below its owner's deploy says what it
  // faces if that deploy lands there first.
  for (const m of moves) {
    if (m.kind !== 'attack' || combined.has(m.to) || worstCase.has(m.to) || strikes.has(m.to)) continue;
    const w = warnings.indexOf(assumes(m.to));
    const extra = reinforcementAt(m.to);
    if (w < 0 || extra <= 0) continue;
    const st = state.get(m.to)!;
    if (st.owner.kind !== 'player') continue;
    const d = defenceAt(m.to);
    const full = costAt(m.to, d + extra);
    const aim = chanceAt(m.to);
    warnings[w] = `Attack on enemy ${label(m.to)} assumes its owner does not reinforce it first: if player ${st.owner.playerId} deploys its ~${extra} there, ${m.armies} attack ${d + extra} (win chance ${pct(chanceOf(m.armies, d + extra))})${full !== null ? `; ${full} would ${aim >= 1 ? 'be sure' : `reach ${pct(aim)}`}` : ''}.`;
  }

  // ---- 6. transfers, #125 staging (plan/transfers.ts) ----
  transfers(pc, ps, book, threats, hd, caps, staging);

  // ---- Order Priority for a strike (rule 1s) (plan/move-order.ts) ----
  const { strikeCard, strikeWho } = strikeOrderPriority(pc, ps, threats, hd, struck);

  // ---- expected, frontier, two-step holds, gambled and shared borders (plan/report.ts) ----
  const expected = reportExpected(pc, ps, book, threats, hd, tgt, caps);
  // ---- offence report (#72), the warnings after the deploys, "Not attacking" (#167) (plan/report.ts) ----
  const { sentAt } = reportOffence(pc, ps, book, threats, hd, tgt, holdLocked, leadSpareFor);
  // ---- 7. schedule the moves (#127), the exits (#179), Order Priority (plan/move-order.ts) ----
  const { slotOf, facesEnemy, exits } = scheduleOrders(pc, ps, threats, hd, caps, struck, strikeCard, strikeWho);

  // ---- the plan: offence list, #172's final check, #201 retaliation, #167 exchanges, #179 ETAs (plan/report.ts) ----
  return finishPlan(pc, ps, pass, threats, hd, tgt, expected, sentAt, slotOf, facesEnemy, exits);
}
