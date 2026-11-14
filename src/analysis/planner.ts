// Turn planner: deploys and moves for one turn, from one player's view of a
// board. Pure and deterministic (every choice tie-breaks on ascending id); no
// I/O. Advisory only — it never submits orders.
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
//          bonus does ("… player P's member, taken on my army lead", whichever pass takes it). One
//          those passes do not take is an ordinary enemy territory again for every later rule (rule
//          4e's fallback, 4g's card pieces, the lead strikes): its plain size, no sure sizing.
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
//          turn (winning: the strongest opponent's, its high when bounded, over my income; losing:
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
//     can still get deploys two ways: as a finish-off source (rule 1e runs before
//     triage, and its attacks keep the deploys they were sized with), and, under Local
//     Deployment, from its held bonus's own pool, which lands only inside that bonus (rule 1b).
//     Under `balanced` a hold is not deployed here: it competes in the greedy
//     step (rule 4a), and a threatened border it might hold makes no attacks.
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
//     border may fund (be deployed to for) a capture that completes a bonus it is in.
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

import type { BoardState, TerritoryState } from '../board.js';
import type { OpponentTrack } from './opponents.js';
import type { GameSettings } from '../normalize.js';
import { analyzeBonus, bonusTerritories } from './bonuses.js';
import {
  armiesForChance,
  armiesToTake,
  DEFAULT_DEFENSIVE_KILL_RATE,
  DEFAULT_OFFENSIVE_KILL_RATE,
  guaranteedKills,
  luckFraction,
  nextBreakpoint,
  straightKills,
  winChance,
  type CombatSettings,
  type KillRates,
} from './combat.js';
import { neighborsOf, type MapGraph } from './graph.js';
import type { GameOutlook } from './outlook.js';
import { classifyExchange, forecastBorder, type Exchange, type ExchangeCase } from './exchange.js';
import type { TwoStepReach } from './lookahead.js';
import { indexAfterAll, MoveSlot, opponentOrdersBefore, scheduleMoves, type MoverPosition } from './schedule.js';
import { boardIncome, DEFAULT_BASE_INCOME, incomeRules, territoryIncome } from './player.js';
import type { GameProfile, ProfilePlayer } from './profile.js';
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
import { newPlanState } from './plan/state.js';

/** A bonus is uneconomic when its remaining capture cost exceeds this many turns of its value… */
export const PAYBACK_TURNS = 10;
/** #201: the shortest payback horizon once the game is decided. */
export const DECIDED_PAYBACK_MIN = 3;
/** …or when one remaining territory alone costs more than this many times its value (a wasteland). */
export const WASTELAND_FACTOR = 5;
/**
 * Plain expansion (pass 3, #125): a capture that adds no income and is in no bonus worth
 * completing is made only when it loses at most this many armies (a 2- or 3-army neutral at the
 * default rates): a cheap step still widens my reach, a 10-army one throws 7 armies away.
 */
export const PLAIN_EXPANSION_LOSS = 2;
/**
 * The fewest armies an order out of a conceded border must carry before the plan spends an Order
 * Priority card on it (#127): a base income's worth (war.app's default MinimumArmyBonus). A
 * 1-army withdrawal from a +0 border is not worth a card.
 */
export const ORDER_PRIORITY_MIN_ARMIES = DEFAULT_BASE_INCOME;
/** Floor of the default enemy deploy estimate (a player's base income). */
export const MIN_ENEMY_DEPLOY = DEFAULT_BASE_INCOME;

/**
 * Observed turns an opponent track needs before the planner uses its income in place of the
 * single-turn observed figure (S3).
 */
export const TRACKED_MIN_TURNS = 2;

/** Fog reveals named in the observed-deploy rationale before "and N more". */
export const MAX_NAMED_REVEALS = 6;
/**
 * #164: a stack the fog hides (Dense / Heavy fog) moves at most this many turns of its owner's
 * income beyond the guard, however many armies the tracker cannot account for: those are spread
 * over its hidden territories, and its income under fog that shows every owner is exact. A larger
 * bank on one border is possible and the fog cannot show it; the cap is a judgement, said in the
 * warning.
 */
export const HIDDEN_POOL_INCOMES = 2;
/** A border is conceded when holding it costs more than this many times the income it protects. */
export const CONCEDE_FACTOR = 3;
/** A held border is comfortable once taking it needs more than this many times its threat. */
export const COMFORT_MARGIN = 1.25;
/**
 * A held bonus whose threatened borders are short of a sure hold by at most this share of
 * the hold they need (or {@link NEAR_MISS_ARMIES}, whichever is larger) is a near miss:
 * funded with everything available rather than conceded (issue #59).
 */
export const NEAR_MISS = 0.15;
/** The near-miss margin is never below this many armies. */
export const NEAR_MISS_ARMIES = 2;
/** The most a held bonus's hold `need` may be short and still be a near miss. */
export function nearMissMargin(need: number): number {
  return Math.max(NEAR_MISS_ARMIES, NEAR_MISS * need);
}

/**
 * An opponent next to the fog (it may hold unseen territories) is still pressured — all its
 * visible territories attacked, each sized for its full estimated deploy plus
 * {@link pressureMargin} — when each of those margin-sized captures costs at most this many
 * times a typical expansion capture (the median capture cost of the visible neutrals next to
 * me; issue #60), or is paid outright from idle armies next to it (#120: it then displaces no
 * expansion). All or nothing: one visible territory over it blocks the pressure on all.
 * Not tuned to admit #60: at ~6 its 0-army territory costs 15 with the margin, five 2-army
 * neutrals — "more than the expansion it displaces" (the owner's live calibration) — so it is
 * not attempted; at ~4 it costs 10 and is.
 */
export const PRESSURE_FACTOR = 4;
/**
 * A pressure attack is sized for its target's armies + the full estimated deploy + this share
 * of that deploy (at least {@link PRESSURE_MARGIN_ARMIES}): the opponent's income is unseen
 * under fog, and live (#60) an attack sized for exactly its ~6 deploy failed.
 */
export const PRESSURE_MARGIN = 0.5;
/** The pressure margin is never below this many armies. */
export const PRESSURE_MARGIN_ARMIES = 2;
/** The extra defenders a pressure attack is sized for, over an estimated `deploy`. */
export function pressureMargin(deploy: number): number {
  return Math.max(PRESSURE_MARGIN_ARMIES, Math.ceil(PRESSURE_MARGIN * deploy));
}

/**
 * Ahead in a 1v1 under the game profile (rule 0p): pressure on an opponent next to the fog is
 * allowed when each margin-sized capture costs at most this many typical expansion captures
 * (instead of {@link PRESSURE_FACTOR}) — a lead is pressed, not left to sit.
 */
export const AHEAD_PRESSURE_FACTOR = 8;
/**
 * FFA with two or more opponents left (rule 0p): a break against a player that threatens no
 * bonus of mine is skipped when a neutral capture scores at least this share of it per army.
 */
export const SECOND_FRONT_SIMILAR = 0.5;
/**
 * #167: rule 0p.2 scales with my army lead — my visible armies over the largest opponent's in view
 * (special units included). Up to this many times, the neutral needs SECOND_FRONT_SIMILAR × the lead
 * (at least 1×) of a break's score to skip it; above it the rule is off: idle stacks beside weak
 * enemy territories are a lever, not a risk, and (adapting) they attack them (the lead strikes).
 */
export const SECOND_FRONT_LEAD = 3;

/** Denying +V to the opponent is worth this many times gaining +V yourself (per opponent: divided among them). */
export const BREAK_WEIGHT = 1.0;
/** Under `balanced`, at least this share of income goes to expansion/breaking before holds protecting less than it. */
export const MIN_EXPANSION_SHARE = 0.3;
/** #167: how many enemy territories the "Not attacking … next to mine" line gives a reason for; the rest are named. */
export const NOT_ATTACKING_REASONS = 6;
/**
 * Under `balanced`/`defend` a bonus's score is value / (capture cost + this × the
 * deploys its frontier needs next turn to hold), so a defensible smaller bonus can
 * beat an indefensible big one.
 */
export const DEFENSE_DISCOUNT = 1;
/**
 * Every capture pays for the frontier it adds (#71): each border it opens costs this many armies
 * in its score (one it closes saves as much), plus, when the border faces a visible enemy, the
 * deploys it needs next turn to hold. Small, so borders facing only neutrals barely matter.
 */
export const NEUTRAL_BORDER_COST = 0.25;

export type PlanGoal = 'balanced' | 'expand' | 'complete-bonus' | 'defend';

export interface PlannerSettings {
  offensiveKillRate?: number;
  defensiveKillRate?: number;
  /** Fraction (0.16) or percent (16). */
  luckModifier?: number;
  roundingMode?: string;
  /** Default `true`. */
  oneArmyStandsGuard?: boolean;
  multiAttack?: boolean;
  /** Default `true`: idle interior armies may transfer. */
  allowTransferOnly?: boolean;
  /** One army of income per this many territories held (0 or absent: off). */
  bonusArmyPer?: number;
  /** Every player's base income (the game's MinimumArmyBonus; default {@link DEFAULT_BASE_INCOME}). */
  baseIncome?: number;
  /** Local Deployment: a held bonus's armies are deployed only inside that bonus. Default `false`. */
  localDeployments?: boolean;
  /** No-Split: a territory issues at most one attack or transfer this turn. Default `false`. */
  noSplit?: boolean;
  /**
   * Army cap (the game's ArmyCap, × income): armies above it are wasted, so spending them is
   * free (rule 4e). `null` / absent: no cap.
   */
  armyCap?: number | null;
  /**
   * #167: automatic Wastelands — `count` neutrals started at `size` armies. A fogged missing member of
   * a bonus (its size unknown) is then costed with the expected surcharge of being one.
   */
  wastelands?: { count: number; size: number };
}

export interface PlanOptions {
  /** Default `balanced`. */
  goal?: PlanGoal;
  /**
   * #201: the outlook (#178, `gameOutlook`) from my boards over the last turns. Once it reports the
   * game decided (winning or losing), payback tests count the turns the game has left and the
   * forecasts below read it; adapting only.
   */
  outlook?: Pick<GameOutlook, 'state' | 'turns'>;
  /**
   * #201: the neutrals the picking board showed, territory → armies (`warapp_plan_picks` keeps them).
   * A missing bonus member the fog hides now is costed at its remembered size, never attacked.
   */
  rememberedNeutrals?: ReadonlyMap<number, number>;
  /** Bonuses to work on first, even when uneconomic. */
  focusBonusIds?: number[];
  /** Income held back from captures (still deployed, as leftover). */
  reserve?: number;
  /** Assumed enemy deploy next turn when judging threats (default {@link defaultEnemyDeploy}). */
  enemyDeploy?: number;
  /**
   * Other players still in the game (divides {@link BREAK_WEIGHT}); default the
   * number of enemy players visible on the board, at least 1.
   */
  opponents?: number;
  /**
   * I hold an Order Priority card I could play this turn: when a commander strike is planned
   * and my commander's territory is threatened, `cardAdvice` says to play it (rule 1s); for a
   * move out of a conceded border worth a card, too (rule 7, #127). Without it no card is advised.
   */
  holdsOrderPriority?: boolean;
  /**
   * The Order Priority I hold is played this turn anyway (the hand is over the card limit and it
   * must go): it costs nothing, so rule 7 advises it for a move out of a conceded border however
   * few armies that saves (ORDER_PRIORITY_MIN_ARMIES does not apply).
   */
  orderPriorityForced?: boolean;
  /**
   * I move first this turn (#127): the caller knows it (Cycle and No-Luck Cycle swap the first
   * mover every turn). My first order then already runs before the opponent's first, so
   * Order Priority is never advised, and finishing a player off needs no caveat. Default unknown.
   */
  movesFirst?: boolean;
  /**
   * An opponent may hold an Order Priority card this turn (#179): the card clock says one can
   * exist by now and its hand is hidden. Two played cards cancel, so even moving first, mine is
   * what keeps the killing strike (rule 1e) or the commander strike (rule 1s) first. Default false.
   */
  opponentsMayHoldOrderPriority?: boolean;
  /**
   * An opponent may hold a Bomb card this turn (#163): the card clock's fastest turn says one can
   * exist by now (whether hands are hidden is not checked: the plan never sees an opponent's hand). A bomb halves one territory of mine next to the bomber after the deploys and
   * before any move, so every hold is sized as if its stack were halved first (the commander
   * unharmed), and the leftover goes to two stacks rather than one (not a strike, saving or
   * expansion stack, which concentrate for one attack). Default false.
   */
  opponentsMayHoldBomb?: boolean;
  /**
   * #127: the armies a turn with a capture earns in card pieces (`capturePieceValue`: the
   * Reinforcement pieces it brings × that card's armies over its pieces). With no capture planned,
   * the cheapest capture that loses no more armies than this is taken (rule 4g). Absent or 0: off.
   */
  cardPieceValue?: number;
  /**
   * Adapt to the game profile (rule 0p): with no `goal`, pick it from the profile (behind:
   * `defend`, else `balanced`) and apply the profile's rules. An explicit `goal` always wins
   * (the plan says the profile was overridden). Default `false`: the plan ignores the profile.
   */
  adapt?: boolean;
  /**
   * The least win chance an ordinary capture is sized for, 0.5–1. Default (#126): 1 with no
   * luck, {@link LUCK_WIN_CHANCE} with luck on. Below 1, each capture of a neutral or an enemy
   * territory sized for its current armies gets the fewest armies whose {@link winChance}
   * reaches it — a bonus's missing captures together (each at the chance^(1/k)). Worst-case
   * sizings (finishing a player off, fog pressure, commander strikes) stay certain.
   */
  minWinChance?: number;
}

/** What the game profile needs beyond the board (rule 0p); every field optional. */
export interface PlanGameContext {
  /** Every player of the game (GameFeed ids, like the board's); default the players in sight. */
  players?: ProfilePlayer[];
  /** The turn being played. */
  turn?: number | null;
  /** Territories are still being picked. */
  picking?: boolean;
  /** GameFeed's `Fog` setting. */
  fog?: string;
  commanders?: boolean;
  /** Any card is in play. */
  cards?: boolean;
  /**
   * Every player started with the same territories and armies (not a map scenario that sets its
   * own starts): in a 1v1 it turns the fog prior on (#119, {@link EnemyIncomePrior}).
   */
  symmetricStart?: boolean;
  /**
   * #166: per opponent, its income this turn simulated from the starts the award of picks proved
   * (`openingIncome`); with the fog prior on, that opponent's prior is the larger of it and my income.
   */
  opening?: ReadonlyMap<number, number>;
  /** #178: the end-of-game settings the profile reads (`Game.endRules`): who the game ends with. */
  endRules?: { aisSurrenderWhenOneHumanRemains?: boolean };
  /**
   * #164: when an opponent's Reinforcement card can first be in hand (the card clock), and what it
   * adds; absent when no Reinforcement card is in play or its armies are unknown.
   */
  reinforcement?: ReinforcementClock;
}

/**
 * #164: an opponent's Reinforcement card, from the card clock (`src/strategy/card-clock.ts`): the first
 * turn one can be in a hand (a player capturing every turn), the armies it adds, and the capturing
 * turns each further card takes (`null`: no further card, or unknown).
 */
export interface ReinforcementClock {
  firstTurn: number;
  armies: number;
  turnsPerCard: number | null;
}

/** #164: GameFeed fog levels that show every territory's owner (No, Light and Dense fog): income is exact. */
export const OWNERS_SHOWN_FOG: ReadonlySet<string> = new Set(['NoFog', 'LightFog', 'ModerateFog']);

export interface PlanInput {
  graph: MapGraph;
  board: BoardState;
  /** My player id. */
  me: number;
  /** Armies to deploy this turn (see {@link incomeFor}), card armies included. */
  income: number;
  /**
   * The part of `income` that comes from this turn's card plays (Reinforcement): it is not
   * earned again next turn, so `expected.nextIncome` leaves it out. Default 0.
   */
  cardArmies?: number;
  /**
   * The same player's view one turn earlier, when known: enemy stacks next to me
   * that grew since then project their growth into next turn's threat.
   */
  previousBoard?: BoardState;
  /**
   * The turn being planned, when known: `previousBoard` is then turn − 1's board, and the
   * observed-deploy rationale names the two turns.
   */
  turn?: number;
  /**
   * Opponent tracks over my board history ({@link trackOpponents}, ending on `board`): an
   * opponent observed over at least {@link TRACKED_MIN_TURNS} turns gets its tracked income in
   * place of the single-turn observed figure.
   */
  tracks?: readonly OpponentTrack[];
  settings?: PlannerSettings;
  options?: PlanOptions;
  /** The game around the board, for the profile (rule 0p). */
  game?: PlanGameContext;
}

export interface PlannedDeploy {
  territoryId: number;
  armies: number;
}

export interface PlannedMove {
  from: number;
  to: number;
  armies: number;
  kind: 'attack' | 'transfer';
  reason: string;
  /**
   * Attacks only: the exact probability this attack captures its target as the board stands
   * (every defender dies, an attacker survives) at the game's kill rates, luck and rounding.
   * 1 when certain. A softener of a combined capture fails by design (0).
   */
  winChance?: number;
}

/** A card the submission should play for the plan to work (the planner itself never plays cards). */
export type CardAdvice = 'order-priority';

export interface TurnPlan {
  /** The goal planned for: the explicit one, else (adapting) the profile's, else `balanced`. */
  goal: PlanGoal;
  /** The game profile (rule 0p), computed on every plan. */
  profile: GameProfile;
  /** Sorted by territory id; sums to the income whenever I own a territory. */
  deploys: PlannedDeploy[];
  /** In the order to send them (rule 7, #127): the protected order, early, sure, filler, last. */
  moves: PlannedMove[];
  expected: {
    captures: number[];
    bonusesCompleted: number[];
    /**
     * Next turn's income if every territory the plan keeps and captures is held — conceded
     * borders included (#109: see `nextIncomeIfConcededFall`). One income rule ({@link boardIncome}).
     */
    nextIncome: number;
    /**
     * Next turn's income if every border the plan concedes falls (#109): the same income rule
     * over the holdings after the plan less `conceded`. Present only when it differs from
     * `nextIncome` or a bonus is at risk.
     */
    nextIncomeIfConcededFall?: number;
    /**
     * The positive bonuses complete after the plan (held at the start or completed this turn)
     * with at least one member it concedes, by bonus id; `conceded` lists those members.
     * Present together with `nextIncomeIfConcededFall`.
     */
    bonusesAtRisk?: BonusAtRisk[];
  };
  warnings: string[];
  rationale: string[];
  /**
   * The enemy deploy the threat checks assumed: the caller's override, else the
   * largest per-opponent estimate among the players next to me (at least
   * {@link MIN_ENEMY_DEPLOY}).
   */
  enemyDeploy: number;
  /** Threatened borders not worth (or not affordable) holding this turn, sorted. */
  conceded: number[];
  /**
   * `'order-priority'` when a withdrawal is planned (it must run before the border falls), or
   * when a commander strike is planned, my commander's territory is threatened and I hold the card
   * (my attacks then resolve first).
   */
  cardAdvice: CardAdvice | null;
  /**
   * Captures made by a combined (multi-source) attack sequence (rule 3a), sorted:
   * their attacks must run in the planned order, and only at 0% luck.
   */
  multiSourceCaptures: number[];
  /**
   * The frontier this plan leaves (rule 4d, #71): my territories (captures included) next to one
   * I do not hold, those next to a visible enemy, the deploys those need next turn to hold at the
   * expected enemy deploy, and the next income that pays for them.
   */
  frontier: FrontierBudget;
  /**
   * The offensive options this plan considered (#72): each bonus break (its cheapest visible
   * member, "probable" when the opponent tracker inferred the bonus), each counter-attack on a
   * stack that shrank fighting me, the strike stack the spare deploys built and each attack from it
   * (#102). `kind` is `strike` for the stack itself and `strike-attack` for each attack from it. `cost` is the capture's armies (what the final orders send when made; the strike
   * stack itself: the armies deployed), `value` its worth in income terms (the strike stack: the
   * strongest opponent's income; a strike attack: the bonus it breaks or retakes, else 0), `taken`
   * whether the plan makes it (a break: whether any member of the bonus falls this turn, `target`
   * then being that member; the strike stack: whether it attacks this turn), `why` the reason.
   */
  offence: OffenceEntry[];
  /**
   * Each move's place in the schedule (#127), parallel to `moves`: `protected` (the one order
   * Order Priority protects), `early` (withdrawals, transfers into a border the enemy can break),
   * `sure`, `filler`, and `last` (an attack the opponent can answer first: its stack can attack
   * before mine lands, or it can reach a contested neutral). Read by the card advice (#163: Order
   * Delay goes above every order that is not urgent when a `last` attack is planned).
   */
  moveSlots?: MoveSlotName[];
  /**
   * #167: each attack on a player's territory judged by its exchange (`classifyExchange`): kills,
   * losses and capture against its defenders as they stand, after its owner's estimated deploy
   * there, and after its owner's whole income, with a label. Absent when no attack hits a player.
   */
  exchanges?: ExchangeView[];
  /**
   * #179: estimated turns to eliminate each visible opponent, by player id (absent with none in
   * view). Present for every opponent with a visible territory my land can reach.
   */
  eta?: { eliminate: Record<number, EliminateEta> };
  /**
   * #179: the exits of each visible opponent down to {@link FEW_TERRITORIES} or fewer — none
   * whose land borders the fog (it may hold more there) unless it is being finished off.
   */
  exits?: OpponentExits[];
}

/**
 * Turns to eliminate one opponent (#179): at least the steps from my land to its farthest visible
 * territory (a multi-source search), and enough turns that what its territories need — each one's
 * capture cost now, plus its deploy for that many turns — fits my movable armies plus my income for
 * as many turns. `turns` is null when that is not within {@link ETA_HORIZON} turns (its deploy grows
 * faster than my income can pay). `atLeast` when its land borders the fog (it may hold more there).
 */
export interface EliminateEta {
  turns: number | null;
  atLeast: boolean;
  /** Steps from my nearest territory to its farthest visible one. */
  distance: number;
  /**
   * The armies that takes, at `turns` (at `distance` when `turns` is null); null when no attack
   * can take what its deploy piles up by then (no finite capture cost).
   */
  armies: number | null;
}

/** An opponent with at most this many visible territories has its exits listed (#179). */
export const FEW_TERRITORIES = 3;

/**
 * Where an opponent down to a few territories can go this turn (#179), per stack: its own
 * neighbours, the visible neutrals its movable armies plus the deploy that can reach it take, and
 * my territories that fall to that once this plan's orders are in. Sorted by id.
 */
export interface OpponentExits {
  player: number;
  stacks: { territory: number; movable: number; own: number[]; neutrals: number[]; mine: number[] }[];
}

/** The most turns {@link EliminateEta} looks ahead. */
export const ETA_HORIZON = 30;

export interface ExchangeView extends Exchange {
  from: number;
  to: number;
  armies: number;
  player: number;
}

/** The names of {@link MoveSlot}, earliest first. */
export type MoveSlotName = 'protected' | 'early' | 'sure' | 'filler' | 'last';
const SLOT_NAMES: readonly MoveSlotName[] = ['protected', 'early', 'sure', 'filler', 'last'];

export interface OffenceEntry {
  target: number;
  kind: 'break' | 'strike' | 'strike-attack' | 'counter';
  cost: number;
  value: number;
  taken: boolean;
  why: string;
}

export interface BonusAtRisk {
  bonusId: number;
  name: string;
  value: number;
  /** Its members the plan concedes, sorted. */
  conceded: number[];
}

/**
 * The positive bonuses complete over `after` (the holdings after a plan) with at least one
 * member in `conceded`, sorted by id (#109): what the plan's concessions put at risk.
 */
export function bonusesAtRisk(g: MapGraph, after: ReadonlySet<number>, conceded: ReadonlySet<number>): BonusAtRisk[] {
  if (!conceded.size) return [];
  return g.map.bonuses
    .filter((b) => b.value > 0)
    .map((b) => ({ b, ts: bonusTerritories(g, b.id) }))
    .filter(({ ts }) => ts.length > 0 && ts.every((t) => after.has(t)) && ts.some((t) => conceded.has(t)))
    .sort((x, y) => x.b.id - y.b.id)
    .map(({ b, ts }) => ({
      bonusId: b.id,
      name: b.name,
      value: b.value,
      conceded: ts.filter((t) => conceded.has(t)).sort(byNum),
    }));
}

export interface FrontierBudget {
  borders: number;
  enemyBorders: number;
  holdCost: number;
  /**
   * The next income the plan counts on (#128): `expected.nextIncome` without the bonuses broken
   * by the borders it concedes, and without those of a held bonus still contested (warned about
   * as short, not conceded). It can be below `expected.nextIncomeIfConcededFall`, which leaves
   * out only the conceded borders.
   */
  income: number;
}

const byNum = (a: number, b: number) => a - b;
/** A probability as a whole percent, for the rationale. */
const pct = (p: number) => `${Math.round(p * 1000) / 10}%`;

/** The combat model's view of the planner settings. */
export function combatSettings(settings: PlannerSettings = {}): CombatSettings {
  return {
    offensiveKillRate: settings.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE,
    defensiveKillRate: settings.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE,
    luck: luckFraction(settings.luckModifier),
    ...(settings.roundingMode !== undefined ? { rounding: settings.roundingMode } : {}),
  };
}

/** A `minWinChance` option clamped to [0.5, 1] (default 1). */
export function minWinChanceOf(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0.5, v));
}

/**
 * The win chance an ordinary capture is sized for when `minWinChance` is not given (#126): with
 * luck on, certainty can cost several times a likely win (a 2-army neutral needs 14 armies to be
 * certain at 75% luck, 5 for 95%), so {@link LUCK_WIN_CHANCE}; with no luck certainty is cheap
 * (weighted-random rounding: one army more than straight rounding), so 1.
 */
export const LUCK_WIN_CHANCE = 0.95;
/**
 * The most a hold may fall to the attack it is sized against (#126): with luck or weighted-random
 * rounding a stack falls to an attack below its exact `armiesToTake` some of the time, so a hold
 * is judged against the fewest attackers that win more often than this.
 */
export const HOLD_FALL_CHANCE = 0.05;
/**
 * Marks around a rationale clause citing a two-step hold (#172): `OPEN <territory> SEP <clause>
 * SEP <fallback> CLOSE`, resolved at the end of the plan (the clause if the hold still applies, the
 * fallback if not).
 */
export const CITE_OPEN = '\u0001';
export const CITE_SEP = '\u0002';
export const CITE_CLOSE = '\u0003';
const CITE_RE = /\u0001(\d+)\u0002([^\u0002\u0003]*)\u0002([^\u0003]*)\u0003/g;
export function defaultMinWinChance(settings: PlannerSettings = {}): number {
  return luckFraction(settings.luckModifier) > 0 ? LUCK_WIN_CHANCE : 1;
}

/** Certain sizes by settings and defenders: each is a search over the exact model. */
const certainMemo = new Map<string, number | null>();

/**
 * Armies to send at a territory held by `defenders`; `null` when it cannot be taken. With
 * `minWinChance` 1 (default) the certain sizing (#126): the fewest armies whose exact
 * {@link winChance} is 1 — every roll and every rounding takes it (`armiesToTake` at 0% luck under
 * straight rounding; one army more under weighted-random rounding; the kills the luck-free share
 * guarantees, {@link guaranteedKills}, with luck). Below 1, the fewest armies whose
 * {@link winChance} reaches it.
 */
export function captureCost(defenders: number, settings: PlannerSettings = {}, minWinChance = 1): number | null {
  const combat = combatSettings(settings);
  if (minWinChance < 1) return armiesForChance(defenders, minWinChanceOf(minWinChance), combat);
  if (!combat.luck && combat.rounding !== 'WeightedRandom') return armiesToTake(defenders, combat);
  const key = `${combat.offensiveKillRate}|${combat.defensiveKillRate}|${combat.luck}|${combat.rounding}|${defenders}`;
  if (!certainMemo.has(key)) {
    if (certainMemo.size > 50_000) certainMemo.clear();
    certainMemo.set(key, armiesForChance(defenders, 1, combat));
  }
  return certainMemo.get(key)!;
}

/**
 * How many attacked territories fall for sure when their owner answers with its best
 * response: one deploy budget `deploy`, split over its territories to save as many as it
 * can. `saveCosts[i]` is the deploys target i needs to survive its attack (the most
 * defenders the attack takes, minus its armies, plus one; 0 when it survives unreinforced).
 * Saving the cheapest first is optimal: any j saved targets cost at least the j cheapest
 * save costs, so j can be saved exactly when those fit the budget.
 */
export function guaranteedFalls(saveCosts: readonly number[], deploy: number): number {
  let left = deploy;
  let saved = 0;
  for (const c of [...saveCosts].sort((a, b) => a - b)) {
    if (c > left) break;
    left -= c;
    saved++;
  }
  return saveCosts.length - saved;
}

/**
 * {@link guaranteedFalls} when not all of the owner's deploy can reach every target (#179: Local
 * Deployment pays a bonus only into its own territories): `reaches[i]` is the most it can deploy on
 * target i. A target whose save costs more than that falls for sure; the rest share the one budget
 * `deploy`, cheapest first. An upper bound on what it saves (its pools may not cover the cheapest
 * set together), so the falls stay sure.
 */
export function guaranteedFallsReaching(saveCosts: readonly number[], reaches: readonly number[], deploy: number): number {
  const savable = saveCosts.filter((c, i) => c <= (reaches[i] ?? deploy));
  return saveCosts.length - savable.length + guaranteedFalls(savable, deploy);
}

/** One visible opponent's estimated deploy next turn and how it was reached. */
export interface EnemyDeployEstimate {
  playerId: number;
  /** max(base + bonusIncome, MIN_ENEMY_DEPLOY, base) — never below what it visibly holds; that floor on the opening board. */
  estimate: number;
  /** The territories it visibly owns (owner shown, armies or not): what `base` is computed from. */
  held: number;
  /**
   * Its base income: MinimumArmyBonus, or (BonusArmyPer on) its visible
   * territories / BonusArmyPer when larger.
   */
  base: number;
  /** Value of the bonuses this player visibly holds in full. */
  bonusIncome: number;
  /** Its largest visible stack next to one of my territories (else its largest visible stack): what can move, not what it earns. */
  largestStack: number;
  /** Every visible territory holds the same army count: no one has deployed yet. */
  opening: boolean;
  /**
   * Its deploy as observed since the previous board ({@link observeDeploy}), at most
   * {@link EnemyDeployEstimate.observedCap}; `null` without a previous board.
   */
  observed: number | null;
  /** The observed deploy before the plausibility cap; `null` without a previous board. */
  observedRaw: number | null;
  /**
   * The most it could earn on this board (issue #69): `base` plus every positive bonus it could
   * possibly hold (none of its territories visibly held by someone else, owner-only included);
   * `null` without a previous board.
   */
  observedCap: number | null;
  /** Which territories the observation counted and skipped; `null` without a previous board. */
  observation: DeployObservation | null;
  /**
   * Its tracked income ({@link OpponentTrack.income}) when its track has at least
   * {@link TRACKED_MIN_TURNS} observed turns; it then replaces `observed` in the estimate.
   * `null` otherwise.
   */
  tracked: number | null;
  /** The observed turns behind `tracked` (`from` turns, oldest first); empty when `tracked` is `null`. */
  trackedTurns: number[];
  /**
   * The most it could earn on this board: `base` plus every positive bonus none of whose
   * territories someone else visibly holds (the same figure as `observedCap`, given or not a
   * previous board).
   */
  couldEarn: number;
  /**
   * The fog prior (#119), when asked for ({@link EnemyIncomePrior}: a symmetric-start 1v1) and
   * it borders the fog: my own income, or its simulated opening income when given and larger (#166), capped
   * at `couldEarn`; else `null`.
   */
  prior: number | null;
  /**
   * `'tracked'` when the tracked income beat the visible-bonus figure, else `'observed'` when the
   * single-turn observed figure did (only without a usable track), else `'visible'` — unless the
   * fog prior beat all of them: `'prior'`.
   */
  source: 'visible' | 'observed' | 'tracked' | 'prior' | 'exact';
  /**
   * #164: its income exactly — base plus every bonus it holds — when the game's fog shows every
   * territory's owner ({@link OWNERS_SHOWN_FOG}) and this board does; the estimate is then this
   * figure (`source` `'exact'`), observations aside (only the army cap, Sanctions and a
   * Reinforcement card are unknown). `null` otherwise, and on the opening board.
   */
  exact: number | null;
  /**
   * #164: a Reinforcement card it may hold (the card clock), added to `estimate`: its armies and the
   * turn it became due. `null` before then, after a deployment above its income was seen (until the
   * next card can be due), or without a clock.
   */
  card: { armies: number; due: number } | null;
  /** #164: the latest turn a deployment above its income was seen (a Reinforcement card played); else `null`. */
  cardPlayed: number | null;
}

/**
 * The fog prior (#119): in a 1v1 that started even (the same territories and armies each), an
 * opponent I cannot see all of — one bordering the fog — is assumed to earn at least what I earn
 * (`myIncome`, card armies out), capped at what it could earn on the board. Observed deploys are
 * lower bounds under fog: the evidence (a finished game's true deploys against the estimate)
 * read 2–3× low without it. A prior, never an observation; the warning says so.
 */
export interface EnemyIncomePrior {
  myIncome: number;
  /**
   * #166: per player, its income this turn from the pick advisor's opening simulation run from
   * the starts the award of picks proved (`openingIncome`); for that player the prior figure is the
   * larger of it and `myIncome` (still capped, still only beside the fog, still only raising).
   */
  opening?: ReadonlyMap<number, number>;
}

/**
 * Fog levels that hide a territory's armies. The live board names war.app's StandingFogLevel
 * (1 You, 2 Visible, 3 OwnerOnly, 4 Fogged; the client refuses a deploy on 3 or 4 as "fogged");
 * a GameFeed standing may spell it as a word or as the raw number (every GameFeed scalar is a
 * string).
 */
const HIDDEN_FOG = /fog|owneronly|^\s*[34]\s*$/i;
/** Fog levels that hide a territory's owner too (StandingFogLevel 4, Fogged). */
const OWNER_HIDDEN_FOG = /fog|^\s*4\s*$/i;

/**
 * `t` when a board shows both its owner (a player or a neutral) and its armies, else
 * `undefined`: a fogged territory (owner unknown, armies `null`), or one whose fog level hides
 * its armies even if a placeholder owner or count came with it (issue #69).
 *
 * One exception: an entry named `"OwnerOnly"` that still carries a count is fog level 2
 * (Visible) from a board cache written before #69, which misnamed it; every current board nulls
 * an owner-only territory's armies, and the old cache left level 3 unnamed (`"3"`).
 */
export function visibleState(t: TerritoryState | undefined): TerritoryState | undefined {
  if (!t || t.armies === null) return undefined;
  if (t.owner.kind !== 'player' && t.owner.kind !== 'neutral') return undefined;
  if (t.fogLevel !== undefined && HIDDEN_FOG.test(t.fogLevel) && !/^\s*owneronly\s*$/i.test(t.fogLevel)) return undefined;
  return t;
}

/**
 * `t` when a board shows its owner (a player or a neutral), whatever its armies: visible, or
 * owner-only (light fog); `undefined` when fogged, even under a placeholder owner.
 */
export function ownerShown(t: TerritoryState | undefined): TerritoryState | undefined {
  if (!t || (t.owner.kind !== 'player' && t.owner.kind !== 'neutral')) return undefined;
  if (t.fogLevel !== undefined && OWNER_HIDDEN_FOG.test(t.fogLevel)) return undefined;
  return t;
}

/** What {@link observeDeploy} read off two boards for one opponent. */
export interface DeployObservation {
  /** Its observed deploy last turn, floored at 0. */
  deploy: number;
  /** Its territories now that were visible last turn too (held both times, or captured), by id. */
  counted: number[];
  /** Of `counted`, those it took from another visible owner (a player, me included, or a neutral). */
  captured: number[];
  /**
   * Of `captured`, those taken (at least partly) from the fog (issue #86): more armies stand there
   * than its territories next to them visibly sent away, and a neighbour was hidden on a board,
   * so the rest arrived from the fog — a move, not income. They count only what the capture
   * cost plus what the visible sources sent; the stack stays a threat.
   */
  fromFog: number[];
  /**
   * The armies read as moves out of the fog, never income: the stacks on `fromFog` beyond what
   * visible sources sent, plus the ambiguous armies (growth on `grewFromFog`, a reinforced
   * capture's surplus) beyond the turn's bound ({@link ambiguousBound}).
   */
  fogArmies: number;
  /** Its territories now that last turn's board did not show: fog reveals, never income. */
  reveals: number[];
  /**
   * Of `captured`, those it took with more armies than its visible neighbours visibly sent, where
   * one of them did shrink into it and a neighbour was hidden (#123): the surplus counts as a
   * deploy on the visible stack that attacked (deploy-then-capture) up to the turn's bound
   * ({@link ambiguousBound}), though a stack out of the fog may have joined it (`low` counts it
   * so); beyond the bound it is in `fromFog` too.
   */
  reinforced: number[];
  /**
   * Its territories held on both boards, next to a territory hidden on either, whose growth was
   * read (at least partly) as a move out of the fog (#123): the growth there beyond the turn's
   * bound ({@link ambiguousBound}: twice what it was expected to deploy, at most what it could earn).
   */
  grewFromFog: number[];
  /** The armies of that growth read as moves (part of `fogArmies`). */
  fogGrowth: number;
  /** {@link ObserveContext.expected}, when given. */
  expected: number | null;
  /**
   * Of `captured`, those taken from me (#123, given {@link ObserveContext.me}): my orders are
   * unknown here, so the capture is priced at what the guard I may have left kills, never at my
   * stack last turn (I may have attacked out of it).
   */
  emptied: number[];
  /** What `high` adds for `emptied` (my stack last turn standing there, not the guard). */
  emptiedHigh: number;
  /** The deploy with every ambiguous army read the low way (fog moves, emptied captures), floored at 0. */
  low: number;
  /** The deploy with every ambiguous army read the high way (deploys, my stack standing), floored at 0. */
  high: number;
}

/**
 * What {@link observeSigned} knows beyond the two boards (#123); every field optional, and
 * without them the reading is the board-only one.
 */
export interface ObserveContext {
  /** My player id: a capture from me is priced at the guard (`emptied`). */
  me?: number;
  /** Armies that stand guard on a territory (1, or 0 when the game lets a territory empty); default 1. */
  guard?: number;
  /**
   * What it was expected to deploy without this observation (its visible income, the fog prior,
   * or its tracked/carried income): ambiguous armies (growth on its territories next to a hidden
   * one, a reinforced capture's surplus) beyond twice that are moves out of the fog
   * (`grewFromFog`, `fromFog`), not income ({@link ambiguousBound}). Absent: every growth counts
   * as deploy.
   */
  expected?: number;
  /**
   * The most it could deploy (its base plus every bonus it could hold): the turn's deploy never
   * reads above it once ambiguous armies are counted (`reinforced`, growth beside the fog); the
   * rest arrived from the fog. With neither this nor `expected` (a board-only reading), a
   * capture's surplus is all a move, as before #123.
   */
  most?: number;
}

/**
 * One opponent's deploy last turn as seen across two boards (issues #57, #69): the *net*
 * change of its visible armies plus what it visibly lost attacking, floored at 0. Only
 * territories visible on both boards count ({@link visibleState}): one hidden last time
 * (fogged, or under a fog level that hid its armies) only came into view, so it is a fog
 * reveal whoever holds it now — never growth, never a capture.
 * - under it both times: armies now − armies then, shrinks included — a transfer between
 *   its own territories nets to zero, so it is never read as deploy;
 * - taken from another visible owner (another player, me included, or a visible neutral): what
 *   the capture cost it — the attackers the previous defenders killed at the game's defensive
 *   kill rate (`straightKills`, as in `armiesToTake`); taken from me (given `context.me`), the
 *   defenders are the guard I may have left, not my stack last turn (#123, `emptied`: I may have
 *   attacked out of it) — plus the armies now on it up to what its territories next to it, shown
 *   on both boards, visibly sent away (their total shrink, each army claimed by one capture only):
 *   those moved in from a visible source, whose shrink they cancel, so source shrink + destination
 *   gain nets to the attrition (issue #86). An unchanged visible neighbour sent nothing, so it
 *   explains nothing. The rest, when a neighbour was hidden on either board, is ambiguous (#123):
 *   a deploy on a visible source that shrank into it (`reinforced`), or a move out of the fog —
 *   never income (`fromFog`), still a threat to the borders next to it. With every neighbour in
 *   view it can only be a deploy on the source.
 * - growth on its territory next to a hidden one is ambiguous the same way (`grewFromFog`).
 * Ambiguous armies count as deploy while the turn's total stays within {@link ambiguousBound}
 * (twice `context.expected`, never past `context.most`); the rest are moves. Without `expected`,
 * growth is all deploy and a capture's surplus counts up to `most` (none without it, #86).
 * `low` and `high` read every ambiguous army one way or the other (fog moves and the guard, or
 * deploys and my stack standing there).
 * Not counted: armies it lost on a territory it attacked but did not take. The defender's
 * count there also moves with the defender's own deploys and transfers (mine included —
 * this board says nothing about my orders), so the loss cannot be read off it; leaving it
 * out keeps the figure a lower bound (the failed attack's losses still shrink its source). The
 * opponent tracker adds it back when my orders that turn are known (#119, `measureOrders`).
 * One turn only, not smoothed (the tracker reads a history). Transfers in from (or out to) the
 * fog still bias it — income in the fog is unseen anyway.
 */
export function observeDeploy(
  g: MapGraph,
  board: BoardState,
  previous: BoardState,
  playerId: number,
  rates: KillRates = {},
  context: ObserveContext = {},
): DeployObservation {
  const { signed: _signed, ...o } = observeSigned(g, board, previous, playerId, rates, context);
  return o;
}

/**
 * {@link observeDeploy} with its total before the floor at 0 (`signed`): the opponent tracker
 * adds what my own orders measure (#119) to it before flooring.
 */
export function observeSigned(
  g: MapGraph,
  board: BoardState,
  previous: BoardState,
  playerId: number,
  rates: KillRates = {},
  context: ObserveContext = {},
): DeployObservation & { signed: number } {
  const before = new Map(previous.territories.map((t) => [t.territoryId, t]));
  let total = 0;
  /** What `low` and `high` differ from `total` by. */
  let lowExtra = 0;
  let highExtra = 0;
  const counted: number[] = [];
  const captured: number[] = [];
  const fromFog: number[] = [];
  let fogArmies = 0;
  const reveals: number[] = [];
  const reinforced: number[] = [];
  const emptied: number[] = [];
  let emptiedHigh = 0;
  /**
   * The ambiguous armies (#123): growth on its held territories next to a hidden one (a stack
   * may have walked in) and a capture's surplus over what a visible source that shrank into it
   * sent (deploy-then-capture, or a stack out of the fog joined). Read after the loop against
   * one bound, the same for both ({@link ambiguousBound}).
   */
  const ambiguous: { id: number; armies: number; kind: 'growth' | 'capture' }[] = [];
  const now = new Map(board.territories.map((t) => [t.territoryId, t]));
  const defensive = rates.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const guard = Math.max(0, context.guard ?? 1);
  const mineBothTimes = (id: number) => {
    const a = visibleState(now.get(id));
    const b = visibleState(before.get(id));
    return a?.owner.kind === 'player' && a.owner.playerId === playerId && b?.owner.kind === 'player' && b.owner.playerId === playerId;
  };
  /**
   * What each of its territories shown with armies on both boards visibly sent away (its
   * shrink): the most a capture next to it can have received from it. A capture draws on it
   * (ascending ids), so two captures never both claim the same armies.
   */
  const shrinkLeft = new Map<number, number>();
  for (const t of board.territories)
    if (g.territoryById.has(t.territoryId) && mineBothTimes(t.territoryId))
      shrinkLeft.set(t.territoryId, Math.max(0, visibleState(before.get(t.territoryId))!.armies! - t.armies!));
  /** Not shown with armies on both boards: armies could have left it unseen. */
  const hidden = (id: number) => !visibleState(now.get(id)) || !visibleState(before.get(id));
  for (const t of [...board.territories].sort((a, b) => a.territoryId - b.territoryId)) {
    if (!g.territoryById.has(t.territoryId) || !visibleState(t)) continue;
    if (t.owner.kind !== 'player' || t.owner.playerId !== playerId) continue;
    const was = visibleState(before.get(t.territoryId));
    if (!was) {
      reveals.push(t.territoryId);
      continue;
    }
    counted.push(t.territoryId);
    const ns = [...neighborsOf(g, t.territoryId)].sort((a, b) => a - b);
    if (was.owner.kind === 'player' && was.owner.playerId === playerId) {
      const growth = t.armies! - was.armies!;
      if (growth > 0 && ns.some(hidden)) ambiguous.push({ id: t.territoryId, armies: growth, kind: 'growth' });
      else total += growth;
    } else {
      captured.push(t.territoryId);
      // What the capture cost it, always. Taken from me (#123), the defenders were what I left
      // there, which this board cannot tell (I may have attacked out of it): priced at the guard,
      // my stack last turn the high reading.
      if (context.me !== undefined && was.owner.kind === 'player' && was.owner.playerId === context.me) {
        const least = straightKills(Math.min(was.armies!, guard), defensive);
        total += least;
        highExtra += straightKills(was.armies!, defensive) - least;
        emptiedHigh += straightKills(was.armies!, defensive) - least;
        emptied.push(t.territoryId);
      } else total += straightKills(was.armies!, defensive);
      // The armies standing there only as far as a visible source's shrink accounts for them
      // (it cancels them). Beyond that, with a neighbour that was hidden on either board: when a
      // visible source did shrink into it, the attack came from that stack and the rest was
      // deployed on it first (deploy-then-capture, #123); when none did, the rest arrived from
      // the fog — a move, not income (#86). With no hidden neighbour, the rest can only be a
      // deploy on a visible source before it attacked.
      let arrived = t.armies!;
      let claimed = 0;
      for (const n of ns) {
        const left = shrinkLeft.get(n);
        if (!left || !arrived) continue;
        const take = Math.min(left, arrived);
        shrinkLeft.set(n, left - take);
        arrived -= take;
        claimed += take;
        total += take;
      }
      if (arrived > 0 && ns.some(hidden)) {
        if (claimed > 0) ambiguous.push({ id: t.territoryId, armies: arrived, kind: 'capture' });
        else {
          fromFog.push(t.territoryId);
          fogArmies += arrived;
          highExtra += arrived;
        }
      } else total += arrived;
    }
  }
  // #123: the ambiguous armies, read as deploy up to one bound on the turn's deploy — the same
  // bound for growth beside the fog and a reinforced capture's surplus, shared in id order —
  // and the rest as moves out of the fog. The low reading takes all of them out, the high one
  // counts all of them.
  const grewFromFog: number[] = [];
  let fogGrowth = 0;
  const bound = ambiguousBound(context);
  // Without an expected deploy (a board-only reading), growth is all deploy, as before #123.
  if (bound === null)
    for (const x of ambiguous) if (x.kind === 'growth') total += x.armies;
  // A board-only reading (neither `expected` nor `most`) has no room at all: a negative total (a
  // stack of its own that shrank into the fog) must not make room for a capture's surplus.
  let room = bound === null && context.most === undefined ? 0 : Math.max(0, (bound ?? Math.max(0, context.most!)) - total);
  for (const x of [...ambiguous].sort((a, b) => a.id - b.id)) {
    if (bound === null && x.kind === 'growth') {
      lowExtra -= x.armies;
      continue;
    }
    const deployed = Math.min(x.armies, room);
    room -= deployed;
    total += deployed;
    lowExtra -= deployed;
    const moved = x.armies - deployed;
    highExtra += moved;
    if (x.kind === 'capture') {
      if (deployed > 0) reinforced.push(x.id);
      if (moved > 0) fromFog.push(x.id);
    } else if (moved > 0) {
      grewFromFog.push(x.id);
      fogGrowth += moved;
    }
    fogArmies += moved;
  }
  fromFog.sort((a, b) => a - b);
  return {
    deploy: Math.max(0, total),
    signed: total,
    counted,
    captured,
    fromFog,
    fogArmies,
    reveals,
    reinforced,
    grewFromFog,
    fogGrowth,
    expected: context.expected ?? null,
    emptied,
    emptiedHigh,
    low: Math.max(0, total + lowExtra),
    high: Math.max(0, total + highExtra),
  };
}

/**
 * How much more than it was expected to deploy an opponent may earn unseen (#123 review): under
 * fog the visible income reads 2–3× low (#119), so ambiguous armies count as deploy up to twice
 * the expected figure. A one-off stack out of the fog is not read as a phantom income; a steady
 * hidden bonus (as large as the visible income) still is, and the tracker, which raises the
 * expected figure to its carried income, learns a larger one over a few turns.
 */
export const HIDDEN_INCOME_FACTOR = 2;

/**
 * The most an opponent's deploy may total once ambiguous armies are counted (#123): twice what
 * it was expected to deploy ({@link HIDDEN_INCOME_FACTOR}), never more than it could earn
 * (`most`). Null without an expected figure: then growth is all deploy and a capture's surplus
 * counts up to `most` (none without it, #86).
 */
function ambiguousBound(context: ObserveContext): number | null {
  if (context.expected === undefined) return null;
  const twice = HIDDEN_INCOME_FACTOR * Math.max(0, context.expected);
  return context.most !== undefined ? Math.min(Math.max(0, context.most), twice) : twice;
}

/** {@link observeDeploy}'s deploy figure alone. */
export function observedDeploy(
  g: MapGraph,
  board: BoardState,
  previous: BoardState,
  playerId: number,
  rates: KillRates = {},
): number {
  return observeDeploy(g, board, previous, playerId, rates).deploy;
}

/**
 * The army count every visible player territory holds, when they all hold the same one (the
 * initial allotment). Neutrals are left out (#128): their stacks are not the starting stacks on
 * ordinary maps, so counting them meant this never fired. Only the first turn can be the opening
 * board (#128): with a previous board, or a known turn past the first, equal stacks are a
 * coincidence of the mid-game, and reading them as the opening would drop visible bonuses.
 */
export function openingArmies(
  g: MapGraph,
  board: BoardState,
  when: { turn?: number | null | undefined; previous?: BoardState | undefined } = {},
): number | null {
  if (when.previous !== undefined || (when.turn !== null && when.turn !== undefined && when.turn > 1)) return null;
  const counts = new Set<number>();
  for (const t of board.territories)
    if (g.territoryById.has(t.territoryId) && t.armies !== null && t.owner.kind === 'player') counts.add(t.armies);
  return counts.size === 1 ? [...counts][0]! : null;
}

/**
 * Per-opponent enemy deploy estimates, one per visible enemy player (sorted by
 * id): base income plus the bonuses that player visibly holds in full, never
 * below max({@link MIN_ENEMY_DEPLOY}, base income). Its stack next to me does not
 * limit it — income held in plain view can all be deployed on my border, however
 * small the stack there. Bonuses in the fog are unseen, so this is what the
 * visible board supports. On the opening board (every visible player territory holds
 * the same count, with no previous board and `when.turn` unknown or the first) every
 * opponent gets the floor.
 */
export function enemyDeployEstimates(
  g: MapGraph,
  board: BoardState,
  me: number,
  settings: PlannerSettings = {},
  previous?: BoardState,
  tracks?: readonly OpponentTrack[],
  prior?: EnemyIncomePrior,
  when: { turn?: number | null; fog?: string | undefined; reinforcement?: ReinforcementClock | undefined } = {},
): EnemyDeployEstimate[] {
  const owner = new Map<number, number>();
  const armies = new Map<number, number>();
  const seenNow = new Map<number, TerritoryState>();
  for (const t of board.territories) if (g.territoryById.has(t.territoryId)) seenNow.set(t.territoryId, t);
  // Owners count whatever the armies: an owner-only territory (light fog) is visibly held, so
  // it counts toward base income and the bonuses held in full. Only stacks need the armies.
  for (const t of board.territories) {
    if (!g.territoryById.has(t.territoryId) || t.owner.kind !== 'player') continue;
    owner.set(t.territoryId, t.owner.playerId);
    if (t.armies !== null) armies.set(t.territoryId, t.armies);
  }
  const players = [...new Set([...owner.values()].filter((p) => p !== me))].sort(byNum);
  const opening = openingArmies(g, board, { turn: when.turn, previous }) !== null;
  // #164: under No, Light and Dense fog every owner shows, so income is exact — when this board
  // shows every territory's owner too (the setting is a name, never compared by position).
  const ownersAll =
    when.fog !== undefined &&
    OWNERS_SHOWN_FOG.has(when.fog) &&
    g.map.territories.every((t) => ownerShown(seenNow.get(t.id)) !== undefined);
  const minimum = Math.max(0, Math.floor(settings.baseIncome ?? DEFAULT_BASE_INCOME));
  const per = settings.bonusArmyPer ?? 0;
  return players.map((playerId) => {
    // Its visible territories are a lower bound on what it holds, so on its
    // per-territory income too.
    const theirs = new Set<number>();
    for (const [t, p] of owner) if (p === playerId) theirs.add(t);
    const held = theirs.size;
    const base = territoryIncome(held, minimum, per);
    // The one income rule (#85) over what it visibly holds; `bonusIncome` is what it adds to the base.
    const bonusIncome = boardIncome(g, theirs, { base: minimum, per }).total - base;
    let adjacent = 0;
    let any = 0;
    for (const [t, p] of owner) {
      if (p !== playerId) continue;
      const a = armies.get(t);
      if (a === undefined) continue;
      any = Math.max(any, a);
      if (neighborsOf(g, t).some((n) => owner.get(n) === me)) adjacent = Math.max(adjacent, a);
    }
    const largestStack = adjacent || any;
    // Every opponent earns at least the game's base income (never below the 5 minimum), and
    // never less than the bonuses it visibly holds: its stack next to me limits neither.
    const floor = Math.max(MIN_ENEMY_DEPLOY, base);
    const visible = opening ? floor : Math.max(floor, base + bonusIncome);
    // What it was seen to deploy is cut only by what it could earn
    // (#69): its base plus every bonus none of whose territories someone else visibly holds
    // (an owner-only territory is visibly held: its owner shows). Both come from this board,
    // so a bonus it lost since last turn is out, though it may have paid for that deploy.
    let possible = 0;
    for (const b of g.map.bonuses) {
      const ts = bonusTerritories(g, b.id);
      if (b.value <= 0 || !ts.length) continue;
      const taken = ts.some((t) => {
        const st = ownerShown(seenNow.get(t));
        return st !== undefined && !(st.owner.kind === 'player' && st.owner.playerId === playerId);
      });
      if (!taken) possible += b.value;
    }
    const couldEarn = base + possible;
    // #119: the fog prior. In a symmetric-start 1v1 an opponent bordering the fog earns at least
    // what I earn, capped at what it could earn on this board. It only ever raises the figure.
    const fogBeside = [...theirs].some((t) => neighborsOf(g, t).some((n) => !ownerShown(seenNow.get(n))));
    // #166: with its starts proven, its opening simulated from them raises the prior when it earns
    // more than I do; never lowers it (the simulation is a simple player, and #119's evidence read low).
    const priorBase = Math.max(prior?.myIncome ?? 0, prior?.opening?.get(playerId) ?? 0);
    const priorFigure = prior && fogBeside ? Math.min(Math.max(0, Math.floor(priorBase!)), couldEarn) : null;
    // A track over enough turns replaces the single-turn observed figure (S3).
    const track = tracks?.find((t) => t.playerId === playerId);
    const usable = track && track.income !== null && track.turns.length >= TRACKED_MIN_TURNS ? track : undefined;
    const tracked = usable ? usable.income : null;
    // #123: what it was expected to deploy before this observation (its visible income, the
    // prior, or its tracked income): ambiguous armies beyond twice that are moves out of the fog
    // ({@link ambiguousBound}); a capture from me is priced at the guard.
    const observation = previous
      ? observeDeploy(g, board, previous, playerId, settings, {
          me,
          guard: (settings.oneArmyStandsGuard ?? true) ? 1 : 0,
          expected: Math.max(visible, priorFigure ?? 0, tracked ?? 0),
          most: couldEarn,
        })
      : null;
    const observedCap = observation ? couldEarn : null;
    const observedRaw = observation?.deploy ?? null;
    const observed = observation ? Math.min(observation.deploy, observedCap!) : null;
    const seenSource: EnemyDeployEstimate['source'] =
      tracked !== null
        ? tracked > visible
          ? 'tracked'
          : 'visible'
        : observed !== null && observed > visible
          ? 'observed'
          : 'visible';
    const seen = seenSource === 'tracked' ? tracked! : seenSource === 'observed' ? observed! : visible;
    // #164: with every owner shown, its income is base + held bonuses exactly; a deploy above it was
    // a card (or armies the board misread), never income.
    const exact = ownersAll && !opening ? Math.max(0, base + bonusIncome) : null;
    const source: EnemyDeployEstimate['source'] =
      exact !== null ? 'exact' : priorFigure !== null && priorFigure > seen ? 'prior' : seenSource;
    const income = source === 'exact' ? exact! : source === 'prior' ? priorFigure! : seen;
    // #164: a Reinforcement card, from the turn the clock says one can be in hand, until a deployment
    // above its income is seen; the next card is due a card's capturing turns after the last one
    // (pieces carry over while a card is held), never before the turn after the play.
    // A play is seen as a deploy (its low reading) above the income that turn: exactly, when every
    // owner shows; under fog only a jump of the card's armies over its visible income counts (a
    // smaller excess may be a bonus the fog hides — and the tracked income then carries the jump).
    const played: number[] = [];
    if (when.reinforcement) {
      const above = (low: number, income: number) => (exact !== null ? low > income : low >= income + when.reinforcement!.armies);
      for (const x of track?.turns ?? []) if (above(x.low, x.visibleIncome)) played.push(x.from);
      // Last turn's deploy was paid by last turn's income: what it held on the previous board (a
      // bonus it lost since paid for it), never below this board's figure.
      if (observation && previous && when.turn !== null && when.turn !== undefined) {
        const before = new Set<number>();
        for (const t of previous.territories)
          if (g.territoryById.has(t.territoryId) && t.owner.kind === 'player' && t.owner.playerId === playerId) before.add(t.territoryId);
        const paid = boardIncome(g, before, { base: minimum, per }).total;
        if (above(observation.low, Math.max(exact ?? visible, paid))) played.push(when.turn - 1);
      }
    }
    let card: EnemyDeployEstimate['card'] = null;
    let cardPlayed: number | null = null;
    if (when.reinforcement && when.turn !== null && when.turn !== undefined) {
      const r = when.reinforcement;
      let due = r.firstTurn;
      let cards = 0;
      for (const t of [...new Set(played)].sort(byNum)) {
        if (t < due || t >= when.turn) continue;
        cards++;
        cardPlayed = t;
        due = r.turnsPerCard === null ? Infinity : Math.max(t + 1, r.firstTurn + cards * Math.max(1, r.turnsPerCard));
      }
      if (when.turn >= due && r.armies > 0) card = { armies: r.armies, due };
    }
    const estimate = income + (card?.armies ?? 0);
    return {
      playerId,
      estimate,
      held,
      base,
      bonusIncome,
      largestStack,
      opening,
      observed,
      observedRaw,
      observedCap,
      couldEarn,
      observation,
      tracked,
      trackedTurns: usable ? usable.incomeTurns : [],
      prior: priorFigure,
      source,
      exact,
      card,
      cardPlayed,
    };
  });
}

/**
 * Default enemy deploy: the largest {@link enemyDeployEstimates} figure among the
 * players with a stack next to me — visible, or its owner shown and its armies hidden (#164) —
 * at least {@link MIN_ENEMY_DEPLOY}. Pass the turn, fog setting and Reinforcement clock (`when`)
 * and the fog prior {@link planEnemyEstimates} uses, or a mid-game board of equal stacks reads as
 * the opening board (#128), an opponent's card is left out (#164), and the figure disagrees with
 * the planner's. Unlike the planner's, it does not know the teams: a teammate counts.
 */
export function defaultEnemyDeploy(
  g: MapGraph,
  board: BoardState,
  me: number,
  settings: PlannerSettings = {},
  previous?: BoardState,
  tracks?: readonly OpponentTrack[],
  prior?: EnemyIncomePrior,
  when: { turn?: number | null; fog?: string | undefined; reinforcement?: ReinforcementClock | undefined } = {},
): number {
  const mineIds = new Set(
    board.territories.flatMap((t) => (t.owner.kind === 'player' && t.owner.playerId === me ? [t.territoryId] : [])),
  );
  const next = new Set<number>();
  for (const t of board.territories) {
    if (t.owner.kind !== 'player' || t.owner.playerId === me) continue;
    if (t.armies === null && (ownerShown(t) === undefined || visibleState(t))) continue;
    if (!g.territoryById.has(t.territoryId)) continue;
    if (neighborsOf(g, t.territoryId).some((n) => mineIds.has(n))) next.add(t.owner.playerId);
  }
  return enemyDeployEstimates(g, board, me, settings, previous, tracks, prior, when).reduce(
    (m, e) => (next.has(e.playerId) ? Math.max(m, e.estimate) : m),
    MIN_ENEMY_DEPLOY,
  );
}

/**
 * This turn's income on the board, cards aside: {@link boardIncome} over the territories `me`
 * holds. warapp_plan_turn and warapp_submit_turn both use it (plus the armies of the card
 * plays in their orders), so the plan's deploy total is the total the submit check requires.
 */
export function incomeFor(g: MapGraph, board: BoardState, me: number, settings?: GameSettings): number {
  const held = new Set<number>();
  for (const t of board.territories)
    if (g.territoryById.has(t.territoryId) && t.owner.kind === 'player' && t.owner.playerId === me) held.add(t.territoryId);
  return boardIncome(g, held, incomeRules(settings)).total;
}

export interface Target {
  id: number;
  cost: number;
  enemy: boolean;
  sources: number[];
}

export interface BonusPlan {
  bonusId: number;
  value: number;
  focus: boolean;
  remaining: number[];
  completable: boolean;
  cost: number;
  borders: number;
  /** Deploys its frontier needs next turn to hold once completed (0 when not judged). */
  defenseCost: number;
  /**
   * Its worth once complete (#70): its value plus the (negative) value of every other negative
   * bonus its missing members complete. Equal to `value` on a map without negative bonuses.
   */
  net: number;
  /** The frontier its missing members add, in armies (rule 4d; negative when it closes gaps). */
  frontier: number;
  /** Missing members in the fog (#101), each counted in `cost` at `fogEach` armies. */
  fogged: number;
  /** The armies each fogged member counts for: its bonus's costliest visible missing member. */
  fogEach: number;
}

export { alliesOf, planEnemyEstimates } from './plan/estimates.js';

/**
 * #172: how one planning pass treats the two-step hold. Attacks are sized greedily, so an early
 * attack out of a guarded territory cannot know that a later order of the same plan takes the
 * reach's stack or the territory in between; {@link planTurn} learns that from earlier passes.
 */
export interface TwoStepPass {
  /** Reaches from, or through, these territories are cut: the plan takes them (a later order included). */
  readonly cut: ReadonlySet<number>;
  /** Attacks are sized without the two-step hold (to learn what the plan would take without it). */
  readonly relaxAttacks: boolean;
  /** Set by the pass when some two-step hold was found to bind. */
  used: boolean;
  /**
   * Whether a territory of mine in between a reach and its target is held (so its own one-step
   * hold covers the reach, which is cut), as learned from the end of an earlier pass; a territory
   * absent here is judged by the concession as the pass goes.
   */
  readonly viaHeld: ReadonlyMap<number, boolean>;
  /** No territory of mine in between is held: the fallback that is the same at every order. */
  readonly viaNever: boolean;
  /** Filled by the pass: each "held in between" decision it made, by territory. */
  readonly viaSeen: Map<number, boolean>;
  /** Set by the pass when one territory was judged both ways. */
  viaMixed: boolean;
  /** Filled at the end of the pass: whether each territory in `viaSeen` ends kept and holding. */
  readonly viaFinal: Map<number, boolean>;
  /** Shared by every pass of one {@link planTurn}: what depends only on its input. */
  readonly shared: TwoStepShared;
}
/**
 * What every pass of one {@link planTurn} shares (#172): the two-step reaches depend only on the
 * start board (the opponents, their deploys, the territories worth guarding), so they are found
 * once, by the first pass that needs them, and each pass filters them by its own plan.
 */
export interface TwoStepShared {
  reaches?: ReadonlyMap<number, readonly TwoStepReach[]>;
}
/** A two-step hold on one territory of mine (#172): what stays, what it needs, and the reach. */
export interface TwoStepHoldAt {
  /** Armies (in `stayAt` terms) that stay to hold. */
  stay: number;
  /** Armies it needs to hold against the reach (as a one-step hold is measured). */
  needs: number;
  reach: TwoStepReach;
}
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
    territories: state, label, bonusName, mine, mineSet, incomeGain, nextIncomeWith, incomeAfter, armiesOf, unitsAt,
    uncounted, uncountedKind, defenceAt, bonusTs, completedBy, territoryShare, plainWorth, inFocus,
  } = pc;
  const {
    guard, rates, chanceOf, chanceAt, costAt, toTake, luck, noSplit,
  } = pc;
  const { armyLead, leadLever, clearLeader, ffaLeader, holdPasses, leadText, myCommanders } = pc;
  const {
    warnings, rationale, deployed, avail, locked, spared, unabsorbed, absorbLines, captured, combined, moves,
    survivorsAt, captureOrder, captureUndo, staged, incoming,
  } = ps;

  if (!mine.length) return emptyPlan(pc, ps);

  // ---- the deploy book (plan/orders.ts): budget, guard, deploys, pools, protected value ----
  const book = deployBook(pc, ps);
  const {
    guardAt, coverOf, heldNow, gainWith, orderOf, deploy, pools, roomAt, spareAt,
  } = book;
  // As the deploy book reads it, restated here so TypeScript narrows `pools` wherever it is tested.
  const local = pools !== null && pools.bonuses.length > 0;

  // ---- 0. threat trend, 1. defence (plan/threats.ts) ----
  const threats = threatsPhase(pc, ps, input);
  const {
    growthOf, deployReaching, reinforcementAt, forceAt,
    borders, facing, borderAt, ownedBy, ownerOf, fogEdge,
  } = threats;

  // ---- 1. holds, #172, 1h, 1b, 1c, #122 garrisons (plan/holds.ts) ----
  const hd = holdsPhase(pc, ps, book, threats, pass);
  const {
    acting, conceded, concedeUnaffordable, floorOrConcede, fundNearMiss, fundUnit,
    garrisonCompleted, heldAgainst, heldBorders, heldStack, hold, holds, keepFor, kept,
    keptIncome, keptShort, leftFor, mayHold, noteRecent, reconsider, settleContested, stayAt,
    threatWarnings, twoStepBound, twoStepCited, twoStepHold, twoStepKeep, twoStepNote, uneconomic,
    units, withdraw,
  } = hd;

  // ---- 2. targets, 4d. frontier cost, bonus scoring, #101 (plan/targets.ts) ----
  const tgt = targetsPhase(pc, ps, input, book, threats, hd);
  const {
    breakable, counterAt, targets, leadSteps, leadTry,
    targetScoreCost, landScoreCost, offence, offenceSkip, skipOffence, badTrades, frontierOf, startHold,
    plans, economicMember, uneconomicMember, negativeMember, ratio, committing, byCloseness, retakeChecks,
    retakeWarning,
  } = tgt;

  // ---- R3, No-Split, capture helper, 3a. combined, passes 1 and 2 (plan/captures.ts) ----
  const caps = capturesPhase(pc, ps, pass, book, threats, hd, tgt);
  const {
    notCompleted, strikes, worstCase, finishedOff, defendersAt,
    tryCapture, snapshot, complete, stopped, stoppedLine, tryExpand,
    advance,
  } = caps;

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
          if (t.holdCost > room) return concedeUnaffordable(t, room);
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
      if (t.holdCost > room) concedeUnaffordable(t, room);
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

  // ---- Order Priority for a strike (rule 1s) ----
  // war.app interleaves both players' attacks, so a struck player's stacks next to my commander
  // may attack before the strike lands. Judged on what stays on my commander's territory once
  // every planned deploy and move is in (a strike from it thins it), against the STRUCK players'
  // visible stacks only: moving first kills their commander before they attack, but does nothing
  // against a third player, so a threat from someone else is no reason to spend the card.
  const commanderThreatened = [...myCommanders].some((c) => {
    const b = borderAt(c, (n) => {
      const st = state.get(n);
      return !(st?.owner.kind === 'player' && struck.has(st.owner.playerId));
    });
    return b !== null && (toTake(stayAt(c) + unitsAt(c)) ?? Infinity) <= b.threat;
  });
  /** The threat to my commander, not a withdrawal, advised Order Priority for the strike (rule 1s). */
  let strikeCard = false;
  const strikeWho = [...struck].sort(byNum).map((p) => `player ${p}`).join(' and ');
  if (struck.size && commanderThreatened) {
    const where = [...myCommanders].map(label).join(', ');
    const who = strikeWho;
    if (opts.holdsOrderPriority) {
      strikeCard = true;
      rationale.push(
        `Play Order Priority: my commander's territory ${where} is threatened this turn by what is left on it after this turn's orders, and with the card my attacks resolve first, so the strike on ${who}'s commander lands before its attacks.`,
      );
    } else
      warnings.push(
        `My attacks and ${who}'s interleave this turn, so its stacks may attack my commander's territory ${where} before the strike lands, and what is left on it after this turn's orders would fall; I hold no Order Priority card to make my attacks resolve first.`,
      );
  }

  // ---- expected ----
  const after = heldNow();
  const completed = completedBy(after);
  // #126: a completion lands only if every capture it needs does — its chance is their product.
  for (const id of completed) {
    const taken = bonusTerritories(g, id).filter((x) => captured.has(x));
    // Each member's capture is its last attack (a combined capture's softeners fail by design).
    const chances = taken.map((x) => moves.filter((m) => m.kind === 'attack' && m.to === x).at(-1)?.winChance ?? 1);
    const joint = chances.reduce((a, b) => a * b, 1);
    if (joint < 1)
      rationale.push(
        `Bonus ${bonusName(id)} (+${g.bonusById.get(id)!.value}) completes with a ${pct(joint)} chance: the product of its ${taken.length} capture${taken.length === 1 ? "'s" : "s'"} win chances this turn.`,
      );
  }
  // A bonus refused in one pass but completed by a later one is not reported as refused.
  for (const id of [...notCompleted.keys()].sort(byNum)) {
    if (completed.includes(id)) continue;
    warnings.push(notCompleted.get(id)!.warning);
    rationale.push(notCompleted.get(id)!.why);
  }

  // Issue #109: the income the plan's concessions put at risk. `nextIncome` counts every
  // territory the plan keeps (conceded borders included); a second figure drops the conceded
  // borders, by the same income rule, and names the bonuses they break.
  const nextIncome = incomeAfter(after);
  const atRisk = bonusesAtRisk(g, after, conceded);
  const ifFall = incomeAfter(new Set([...after].filter((t) => !conceded.has(t))));
  const reportRisk = atRisk.length > 0 || ifFall !== nextIncome;
  if (ifFall < nextIncome) {
    const what = atRisk.length
      ? `bonus ${atRisk.map((b) => `${bonusName(b.bonusId)} (+${b.value})`).join(', ')}`
      : [...conceded].sort(byNum).map(label).join(', ');
    warnings.push(
      `This plan concedes ${what}: next income ${nextIncome} if they hold, ${ifFall} if the conceded borders fall.`,
    );
  }
  const nextIncomeText = ifFall < nextIncome ? `${nextIncome}, ${ifFall} if the conceded borders fall` : `${nextIncome}`;

  // Rule 4d's frontier budget (#71): the frontier this plan leaves against the next income.
  const frontier: FrontierBudget = {
    ...frontierOf(after, (x) => (mineSet.has(x) ? stayAt(x) : (survivorsAt.get(x) ?? 0))),
    income: keptIncome(after),
  };
  const startCost = startHold();
  const outgrown = frontier.holdCost > frontier.income && frontier.holdCost > startCost;
  // A capture stopped by one pass but taken by a later one (the next income grew in between) is
  // in the orders: nothing may still say it was not taken.
  const notTaken = stopped.filter((x) => !captured.has(x.t));
  const takenAfterAll = stopped.filter((x) => captured.has(x.t)).map((x) => stoppedLine(x.t));
  if (takenAfterAll.length) {
    const kept = rationale.filter((r) => !takenAfterAll.some((line) => r.startsWith(line)));
    rationale.splice(0, rationale.length, ...kept);
  }
  if (outgrown || notTaken.length) {
    const stop = notTaken.length
      ? ` Expansion that adds enemy borders without completing a bonus is stopped: ${notTaken.map((x) => `${label(x.t)} (the frontier would need ${x.holdCost}, next income ${x.income})`).join(', ')} not taken.`
      : '';
    warnings.push(
      outgrown
        ? `Frontier grows faster than income: holding its ${frontier.enemyBorders} enemy-facing borders next turn needs ${frontier.holdCost} at the expected deploy, more than ${
            frontier.income < nextIncome
              ? `the ${frontier.income} of next income the plan counts on (${nextIncome} if every border holds: the bonuses it concedes or still contests are left out)`
              : `the next income of ${frontier.income}`
          } (${startCost} at the start of the turn).${stop}`
        : `Frontier grows faster than income.${stop}`,
    );
  }
  // #172: each two-step hold an order cited, or that shrank or ruled out an order (a pressure
  // attack's size, a softener, a finisher, a top-up), is stated once, with the stay the plan ends
  // on (an order's own note would read the stay mid-plan) — if it still applies at the end. One
  // that no longer does (a later capture took the territory in between, or the stay fell so far
  // that holding is hopeless) is not stated, and the orders' citations of it are dropped.
  const stillHeld = new Set<number>();
  for (const t of [...new Set([...twoStepBound, ...twoStepCited.keys()])].sort(byNum)) {
    // The stay the plan ends on, rule 6's arrivals included, decides whether the hold still applies.
    const h = twoStepHold(t, undefined, true);
    if (!h) continue;
    stillHeld.add(t);
    rationale.push(`Hold ${label(t)} against a stack two steps away (${twoStepNote(t, h)}).`);
  }
  for (let i = rationale.length - 1; i >= 0; i--) {
    const line = rationale[i]!;
    if (!line.includes(CITE_OPEN)) continue;
    const text = line.replace(CITE_RE, (_m, t: string, clause: string, fallback: string) =>
      stillHeld.has(Number(t)) ? clause : fallback,
    );
    if (text.trim()) rationale[i] = text;
    else rationale.splice(i, 1);
  }
  // #201: an absorption is claimed only where an attack on that player is made.
  for (const [p, line] of absorbLines) {
    const owned = (t: number) => {
      const o = state.get(t)?.owner;
      return o?.kind === 'player' && o.playerId === p;
    };
    if (moves.some((m) => m.kind === 'attack' && owned(m.to))) continue;
    const i = rationale.indexOf(line);
    if (i >= 0) rationale.splice(i, 1);
  }
  if (frontier.enemyBorders)
    rationale.push(
      `Frontier after this plan: ${frontier.borders} borders, ${frontier.enemyBorders} facing an enemy, needing ${frontier.holdCost} next turn to hold at the expected deploy (next income ${nextIncomeText}); every capture's score paid for the borders it adds.`,
    );

  // #201, behind: the borders sized for the expected attack, per player — what that gambles.
  {
    // Read from `borders`, the sizing the plan used (re-judged after captures), never from a
    // hypothetical re-judge: the expected attack is the border's `threat`, the worst case its `worst`.
    const gambled = new Map<number, { player: number; worst: number; expected: number; growth: number }>();
    for (const b of borders.values())
      if (b.worst !== undefined) gambled.set(b.id, { player: b.player, worst: b.worst, expected: b.threat, growth: b.growth });
    const byPlayer = new Map<number, number[]>();
    for (const [id, x] of gambled) if (mineSet.has(id) && !conceded.has(id)) byPlayer.set(x.player, [...(byPlayer.get(x.player) ?? []), id]);
    for (const [p, ids] of [...byPlayer].sort((a, b) => a[0] - b[0])) {
      // Gambled: holds against the expected attack as the plan leaves it, not against the worst case.
      // One short of even the expected attack is no gamble (its threat warning says so).
      const takeAt = (id: number) => toTake(stayAt(id) + unitsAt(id)) ?? Infinity;
      const gamble = ids.sort(byNum).filter((id) => takeAt(id) > gambled.get(id)!.expected && takeAt(id) <= gambled.get(id)!.worst);
      const allHold = ids.every((id) => takeAt(id) > gambled.get(id)!.worst);
      if (!gamble.length && !allHold) continue;
      warnings.push(
        `Behind (#201): the borders facing player ${p} are sized for its expected attack (its movable armies next to each plus its whole ~${deployOf(p)} deploy, #59), not the worst case its growth per turn projects, and the armies saved go to the captures. ${
          gamble.length
            ? `Gambled: ${gamble
                .map((id) => {
                  const x = gambled.get(id)!;
                  return `${label(id)} (it holds against the expected ~${x.expected}, not the worst-case ~${x.worst} at its growth of ~${x.growth} a turn)`;
                })
                .join(', ')} — each falls if player ${p} keeps growing at that rate and attacks it.`
            : 'Each still holds against the worst case as the plan leaves it.'
        }`,
      );
    }
  }
  // Issue #69, second point: several borders facing one opponent are each sized for its whole
  // deploy. That is each border's worst case — the opponent picks where to land after I
  // commit — so a sure hold of all of them needs every one sized for it; no army is counted
  // twice on one border (movable + max(deploy, growth)).
  for (const [p, ids] of [...heldAgainst].sort((a, b) => a[0] - b[0])) {
    const held = [...ids].filter((id) => !conceded.has(id)).sort(byNum);
    if (held.length < 2) continue;
    rationale.push(
      `Each of the ${held.length} borders held against player ${p} (${held.map(label).join(', ')}) is sized for its full ~${deployOf(p)} deploy: it chooses where to land after seeing my orders, so any one of them can face all of it, and a share each would leave whichever it picks short. Each border's threat counts its stacks next to that border once plus one deploy, never the deploy twice.`,
    );
  }

  // #167: cover odds. One deploy lands on one territory: against a player that faces two or more of
  // my kept borders, those that hold against its stacks alone but not with its whole deploy on them
  // are a gamble on where it lands — say which, and the chance each survives if it picks at random.
  // A split deploy takes every border whose shortfall it funds alongside another's: those get 0%.
  {
    const facingBy = new Map<number, { x: number; movable: number }[]>();
    for (const x of mine) {
      if (conceded.has(x)) continue;
      const by = new Map<number, number>();
      for (const n of neighborsOf(g, x)) {
        const st = state.get(n);
        if (captured.has(n) || st?.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) continue;
        by.set(st.owner.playerId, (by.get(st.owner.playerId) ?? 0) + Math.max(0, st.armies - guard) + unitsAt(n));
      }
      for (const [q, movable] of by) facingBy.set(q, [...(facingBy.get(q) ?? []), { x, movable }]);
    }
    for (const [q, list] of [...facingBy].sort((a, b) => a[0] - b[0])) {
      if (list.length < 2) continue;
      const d = deployOf(q);
      const short = list.flatMap(({ x, movable }) => {
        const take = toTake(stayAt(x) + unitsAt(x));
        return take !== null && take > movable && take <= movable + d ? [{ x, gap: take - movable }] : [];
      });
      if (!short.length) continue;
      const n = list.length;
      // A deploy can be split: a border whose shortfall the deploy funds together with another
      // border's is no coin flip — the split takes both. How many it takes at once: the smallest
      // shortfalls first, while the deploy covers them.
      const splits = short.filter(({ x, gap }) => short.some((o) => o.x !== x && gap + o.gap <= d));
      const gaps = short.map(({ gap }) => gap).sort((a, b) => a - b);
      let k = 0;
      for (let left = d; k < gaps.length && gaps[k]! <= left; k++) left -= gaps[k]!;
      const flips = short.filter((s) => !splits.includes(s));
      const parts: string[] = [];
      // #201: the split takes k at once. Each of those holds with chance 0% only when there are
      // k of them or fewer; with more, it picks k of them and each holds with (m − k) ÷ m.
      if (splits.length) {
        const m = splits.length;
        const named = `(${splits.map(({ x, gap }) => `${label(x)} short ${gap}`).join(', ')})`;
        parts.push(
          m <= k
            ? `its ~${d} deploy, split, can take ${k} of the ${n} borders facing it at once ${named}: each of those holds with chance 0%.`
            : `its ~${d} deploy, split, can take ${k} of the ${n} borders facing it at once ${named}: if it picks ${k} of those ${m} at random, each holds with chance ${Math.round(((m - k) / m) * 100)}%, and all of them with 0%.`,
        );
      }
      if (flips.length)
        parts.push(
          `${splits.length ? 'Besides, its' : 'its'} one ~${d} deploy can land on one of the ${n} borders facing it; ${flips.length} hold${flips.length === 1 ? 's' : ''} against its stacks alone but not with that deploy on ${flips.length === 1 ? 'it' : 'them'} (${flips.map(({ x }) => label(x)).join(', ')}) — a gamble on where it lands: if it picks among the ${n} at random, ${
            flips.length === 1
              ? `it holds with chance ${Math.round(((n - 1) / n) * 100)}%`
              : `each holds with chance ${Math.round(((n - 1) / n) * 100)}%${splits.length ? '' : `, and all of them with ${Math.round(((n - flips.length) / n) * 100)}%`}`
          }.`,
        );
      rationale.push(`Cover odds against player ${q} (#167): ${parts.join(' ')}`);
    }
  }

  if (noSplit && moves.length && guard)
    warnings.push(
      'No-Split is on: each order sends its territory\'s whole stack less the one army that stands guard; whether war.app leaves that army behind under No-Split is unverified (a live turn with the guard off left every source at 0).',
    );

  // ---- offence report (#72) ----
  for (const [t, { lost, killed }] of [...badTrades].sort((a, b) => a[0] - b[0]))
    if (!captured.has(t))
      rationale.push(
        `Not attacking ${label(t)}: the combined capture loses ${lost} armies for the ${killed} it kills, a trade below even while behind on armies.`,
      );
  /** What the final orders send at `t` (a top-up of idle armies can raise a capture's size). */
  const sentAt = (t: number) => moves.reduce((n, m) => (m.kind === 'attack' && m.to === t ? n + m.armies : n), 0);
  // A border warned about before the deploys may have been deployed to since: say what the
  // plan leaves there, so the warning does not contradict the hold, floor or spread lines.
  for (let i = 0; i < warnings.length; i++) {
    const hit = [...threatWarnings].find(([, w]) => w.text === warnings[i]);
    if (!hit) continue;
    const [id, { threat }] = hit;
    const n = deployed.get(id) ?? 0;
    if (n <= 0) continue;
    const have = stayAt(id);
    const take = toTake(have + unitsAt(id));
    warnings[i] += ` Before this turn's deploys: the plan deploys ${n} there, leaving ${have} armies (${take ?? 'none can'} to take${take !== null && take > threat ? `, more than the ${threat} that can reach it: it holds` : `; the ${threat} that can reach it still could`}).`;
  }
  // #201: the FFA leader's borders held against two or more opponents attacking together.
  if (ffaLeader)
    for (const id of [...borders.keys()].sort(byNum)) {
      if (conceded.has(id) || !mineSet.has(id)) continue;
      const f = forceAt(id, (n) => captured.has(n), { trend: true, allPlayers: true });
      if (!f?.split || f.split.players.length < 2) continue;
      rationale.push(
        `I lead this free-for-all (#201): ${label(id)} is held against players ${f.split.players.join(' and ')} attacking together (${f.split.attacks.join(' then ')}, up to ${f.split.takes} armies), not each alone: the others may combine against the leader.`,
      );
    }
  // #128: a border that holds against each opponent alone but not against two of them attacking
  // it in the same turn (FFA players do not coordinate, so this is a warning, not a hold).
  for (const id of [...borders.keys()].sort(byNum)) {
    if (conceded.has(id) || !mineSet.has(id)) continue;
    const alone = borderAt(id, (n) => captured.has(n));
    const pile = forceAt(id, (n) => captured.has(n), { trend: true, allPlayers: true, pileOn: true });
    if (!alone || !pile?.split || pile.split.players.length < 2) continue;
    const have = stayAt(id) + unitsAt(id);
    const take = toTake(have);
    if (take === null || take <= alone.threat || have > pile.split.takes) continue;
    warnings.push(
      `${label(id)} holds against each opponent alone, but players ${pile.split.players.join(' and ')} attacking it in the same turn (${pile.split.attacks.join(' then ')}) could take up to ${pile.split.takes} armies, and ${have} stay there.`,
    );
  }
  // ---- #167: every enemy territory next to mine left alone names why ----
  // One rationale line lists each visible enemy territory next to a territory I held at the start
  // that no order attacks, with the first reason that applies: a special unit there, a reason the
  // offence report already gave (rule 0p.2's second front among them), a capture that lowers income,
  // its size against the most any neighbour of mine can spare once it holds its border, or that it is
  // no target of the plan's (rule 2: a player's territory is attacked to break a bonus, counter-attack,
  // finish a player off, strike, or as rule 4e's fallback; adapting in an FFA, the lead strikes).
  {
    const spareNow = (x: number, n: number) => {
      if (!mineSet.has(x) || holdLocked.has(x) || conceded.has(x) || myCommanders.has(x) || orderOf(x)) return 0;
      const gone = (m: number) => m === n;
      return Math.max(0, avail.get(x)! - Math.max(keepFor(x, gone), twoStepKeep(x, gone)));
    };
    const attacked = new Set(moves.filter((m) => m.kind === 'attack').map((m) => m.to));
    const left = [...new Set(mine.flatMap((x) => neighborsOf(g, x)))].sort(byNum).filter((n) => {
      const st = state.get(n);
      return !mineSet.has(n) && !attacked.has(n) && st?.owner.kind === 'player' && foe(st.owner.playerId) && st.armies !== null;
    });
    const reasonFor = (n: number): string => {
      const st = state.get(n)!;
      const p = (st.owner as { playerId: number }).playerId;
      if (uncounted(n)) return `it holds ${uncountedKind(n)}, whose strength the board does not carry`;
      if (unitsAt(n) > 0) return `an enemy commander stands there: only a commander strike (rule 1s) attacks it, sized for its owner's whole deploy`;
      if (spared.has(n) && unabsorbed.has(p))
        return `absorbing player ${p} would not bring my income to the FFA leader's: the armies are better spent against the leader (#201)`;
      if (spared.has(n)) return `player ${p} is a buffer in this FFA: finishing it off costs more frontier than it pays (#179)`;
      const skip = offenceSkip.get(n);
      if (skip) return skip;
      if (gainWith([n]) < 0) return 'taking it would lower my income (it completes a negative bonus)';
      const need = costAt(n);
      const extra = reinforcementAt(n);
      const sure = extra > 0 ? costAt(n, defenceAt(n) + extra) : need;
      const best = neighborsOf(g, n)
        .filter((x) => mineSet.has(x))
        .map((x) => ({ x, spare: spareNow(x, n) }))
        .sort((a, b) => b.spare - a.spare || a.x - b.x)[0]!;
      if (need === null) return 'no attack can take it at these kill rates';
      if (best.spare < need)
        return `taking it needs ${need}${sure !== null && sure > need ? ` (${sure} if player ${p} deploys its ~${extra} there first)` : ''}, and the most a neighbour of mine can spare once it holds its border is ${best.spare}${best.spare > 0 ? ` (${label(best.x)})` : ''}`;
      if (goal !== 'balanced') {
        // Rule 4e's fallback (and a lead) can still take a player's territory under another goal.
        const others = [...attacked].filter((t) => t !== n && state.get(t)?.owner.kind === 'player').sort(byNum);
        return others.length
          ? `under goal ${goal} the plan attacks a player's territory only where a rule calls for it (here ${others.map(label).join(', ')}), and none calls for this one`
          : `goal ${goal} attacks no player's territory${goal === 'complete-bonus' ? ' outside the bonus it completes' : ''}`;
      }
      const ffaLead = auto && profile.format === 'ffa' && profile.opponents >= 2;
      if (ffaLead && leadLever && !noSplit && sure !== null && sure > need) {
        // The lead strikes ran: this one was not sized for sure (defenders plus its owner's deploy).
        const lead = neighborsOf(g, n)
          .filter((x) => mineSet.has(x))
          .map((x) => ({ x, spare: leadSpareFor(x, n) }))
          .sort((a, b) => b.spare - a.spare || a.x - b.x)[0]!;
        // #203: why its bonus's step failed, as measured when that pass tried it (later deploys,
        // counted in the spare above, could not fund it then).
        const tried = leadTry.get(n);
        const deployText =
          tried === undefined
            ? ''
            : tried.kind === 'r3'
              ? `; its bonus's step was refused: what survives the attack would not hold it next turn (R3)`
              : tried.kind === 'trade'
                ? `; its bonus's step was refused: a trade below even (~${tried.lost} lost for ${tried.killed} killed)`
                : tried.kind === 'frontier'
                  ? `; its bonus's step was stopped by rule 4d's frontier budget: it adds a border facing an enemy`
                  : tried.from === undefined
                    ? `; when its bonus's step was tried, no neighbour of mine was free to attack it`
                    : `; when its bonus's step was tried, ${label(tried.from)} could spare ${tried.spare} for it and ${
                        tried.reach === 0
                          ? 'none of this turn\'s deploy could still reach it'
                          : `this turn's deploy could add at most ${tried.reach} there${local ? ' (Local Deployment)' : ''}: ${tried.spare + tried.reach} in all`
                      }`;
        if (lead.spare < sure)
          return `a lead strike (my army lead is ${leadText()}, over ${SECOND_FRONT_LEAD}×) needs ${sure} — sized for its ${defenceAt(n)} defenders plus player ${p}'s ~${extra} deploy — and the most a neighbour of mine can spare for it is ${lead.spare}${lead.spare > 0 ? ` (${label(lead.x)})` : ''}${deployText}`;
      }
      return `${label(best.x)} could spare ${best.spare} for it, but it breaks no bonus and is no counter-attack, finishing blow or strike — the only reasons the plan attacks a player's territory (rule 2), besides rule 4e's fallback when nothing else is captured${
        !ffaLead
          ? ''
          : !leadLever
            ? ` (a lead strike takes one only with an army lead over ${SECOND_FRONT_LEAD}×; mine is ${leadText()})`
            : noSplit
              ? ` (no lead strike under No-Split: an order carries the whole stack)`
              : ''
      }`;
    };
    // Capped (#130 trimmed the response before): the first NOT_ATTACKING_REASONS by id with their
    // reasons, the rest named.
    const told = left.slice(0, NOT_ATTACKING_REASONS);
    const rest = left.slice(NOT_ATTACKING_REASONS);
    if (left.length)
      rationale.push(
        `Not attacking ${left.length === 1 ? 'the enemy territory' : `${left.length} enemy territories`} next to mine: ${told
          .map((n) => `${label(n)} (player ${(state.get(n)!.owner as { playerId: number }).playerId}, ${state.get(n)!.armies} armies): ${reasonFor(n)}`)
          .join('; ')}${rest.length ? `; and ${rest.length} more: ${rest.map(label).join(', ')}` : ''}.`,
      );
  }
  // ---- 7. schedule the moves (#127) ----
  // Orders zigzag (the first mover's 1st, the other's 1st and 2nd, …), so the place of a move in
  // the list decides what it meets. One order is protected when Order Priority is advised.
  const CONCEDED_ORDER = /; play Order Priority so it goes first\.$/;
  /** The strike Order Priority protects (rule 1s), when the threat to my commander advised the card. */
  const strikeOrder = strikeCard ? moves.find((m) => m.kind === 'attack' && strikes.has(m.to)) : undefined;
  /**
   * #179: the strike that eliminates a player finished off (rule 1e) — the attack on its largest
   * stack (most armies plus special units, then lowest id): the one that can flee or strike first.
   * Else a commander strike (rule 1s) the threat to my commander did not already protect
   * (`commander`): it ends a player too, and the commander can walk away before it lands.
   * A combined capture there (rule 3a) has no such strike: its first attack only wears the stack
   * down, and Order Priority moves only my first order ahead, so the card cannot secure it.
   */
  const kill = (() => {
    for (const p of [...finishedOff].sort(byNum)) {
      const target = [...(ownedBy.get(p) ?? [])]
        .filter((t) => moves.some((m) => m.kind === 'attack' && m.to === t))
        .sort((a, b) => armiesOf(b) + unitsAt(b) - (armiesOf(a) + unitsAt(a)) || a - b)[0];
      const order = target === undefined ? undefined : moves.find((m) => m.kind === 'attack' && m.to === target);
      if (order) return { p, order, attacks: moves.filter((m) => m.kind === 'attack' && m.to === target).length, commander: false };
    }
    // Else a strike on a commander (rule 1s) that no threat to mine advised the card for: it too
    // ends a player, and the commander can walk away before it lands.
    if (strikeOrder) return undefined;
    for (const t of [...strikes].sort(byNum)) {
      const st = state.get(t);
      if (st?.owner.kind !== 'player' || !struck.has(st.owner.playerId)) continue;
      const order = moves.find((m) => m.kind === 'attack' && m.to === t);
      if (order) return { p: st.owner.playerId, order, attacks: moves.filter((m) => m.kind === 'attack' && m.to === t).length, commander: true };
    }
    return undefined;
  })();
  if (!strikeOrder && kill && combined.has(kill.order.to))
    warnings.push(
      `The strike that eliminates player ${kill.p} is a combined capture of ${label(kill.order.to)} (${kill.attacks} attacks that must run in order): Order Priority moves only my first order ahead, so it cannot secure the kill; its stack can still flee or strike before the capture lands.`,
    );
  const killOrder = strikeOrder || (kill && combined.has(kill.order.to)) ? undefined : kill?.order;
  const outOfConceded = moves.filter((m) => conceded.has(m.from) && m !== strikeOrder && m !== killOrder);
  /** My first order: the one Order Priority would protect. Checked against the schedule below. */
  let firstOrder: PlannedMove | undefined =
    strikeOrder ?? killOrder ?? [...outOfConceded].sort((a, b) => b.armies - a.armies || a.from - b.from || a.to - b.to)[0];
  /** The visible stacks of one player next to `t` plus its deploy: what can reach `t` this turn. */
  const reachOf = (t: number) => {
    const byPlayer = new Map<number, number>();
    for (const n of neighborsOf(g, t)) {
      const st = state.get(n);
      if (st?.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) continue;
      const p = st.owner.playerId;
      byPlayer.set(p, (byPlayer.get(p) ?? deployOf(p)) + Math.max(0, st.armies - guard) + unitsAt(n));
    }
    return byPlayer.size ? Math.max(...byPlayer.values()) : null;
  };
  const facesEnemy = (t: number) =>
    neighborsOf(g, t).some((n) => {
      const st = state.get(n);
      return st?.owner.kind === 'player' && foe(st.owner.playerId);
    });
  const lastWhy = new Map<PlannedMove, string>();
  const slotOf = (m: PlannedMove): MoveSlot => {
    if (m === firstOrder) return MoveSlot.Protected;
    if (m.kind === 'transfer') return conceded.has(m.from) || facesEnemy(m.to) ? MoveSlot.Early : MoveSlot.Filler;
    if (conceded.has(m.from)) return MoveSlot.Early;
    const st = state.get(m.to);
    if (st?.owner.kind === 'player') {
      if (worstCase.has(m.to) || strikes.has(m.to)) return MoveSlot.Sure;
      lastWhy.set(m, `${label(m.to)} (player ${st.owner.playerId}'s stack can attack first; attacking second fights its survivors)`);
      return MoveSlot.Last;
    }
    // A neutral another player can reach: early only when my survivors hold against its capture
    // of that neutral (sized as mine are), at most what its stacks next to it plus its deploy send.
    const near = reachOf(m.to);
    if (near === null) return MoveSlot.Filler;
    const reach = Math.min(near, captureCost(defenceAt(m.to), s) ?? near);
    const survivors = m.armies - Math.min(m.armies, straightKills(defenceAt(m.to), rates.defensiveKillRate));
    if ((toTake(survivors) ?? Infinity) > reach) return MoveSlot.Sure;
    lastWhy.set(m, `${label(m.to)} (another player can send ~${reach} at it, which would take my ${survivors} survivors: taken last, mine is the capture that stands)`);
    return MoveSlot.Last;
  };
  // "Eliminated even if it reinforces" holds only if my attacks land before its own orders: moving
  // first, it can move between its territories or take a thin border of mine, and survive.
  for (const p of opts.movesFirst ? [] : [...finishedOff].sort(byNum)) {
    const theirs = ownedBy.get(p) ?? [];
    /** Its stacks next to my `b` plus the deploy that can reach them (as the cover sizes it, #179). */
    const reach = (b: number) => {
      const adj = neighborsOf(g, b).filter((n) => theirs.includes(n));
      return deployReaching(p, adj) + adj.reduce((a, n) => a + Math.max(0, armiesOf(n) - guard) + unitsAt(n), 0);
    };
    const exposed = mine.filter(
      (b) => neighborsOf(g, b).some((n) => theirs.includes(n)) && (toTake(stayAt(b) + unitsAt(b)) ?? Infinity) <= reach(b),
    );
    const most = Math.max(0, ...exposed.map(reach));
    warnings.push(
      `Eliminating player ${p} assumes my attacks land before its own orders: they interleave, so if it moves first it can move between its territories${exposed.length ? `, or take ${exposed.map(label).join(' or ')} (what this plan leaves there falls to its ~${most})` : ''}, and survive.`,
    );
  }
  // ---- #179: the exits of an opponent down to a few territories ----
  // Each of its stacks can move to its own neighbours, take a neutral its movable armies plus the
  // deploy that can reach it take, or take a territory of mine that falls to that (what this plan
  // leaves there).
  const exits: OpponentExits[] = [];
  for (const [p, theirs] of [...ownedBy].sort((a, b) => a[0] - b[0])) {
    // Its land bordering the fog, it may hold more there: not known to be down to a few.
    if (theirs.length > FEW_TERRITORIES || (fogEdge(p).length && !finishedOff.has(p))) continue;
    const stacks = theirs.map((t) => {
      const movable = Math.max(0, armiesOf(t) - guard) + unitsAt(t);
      const reach = movable + deployReaching(p, [t]);
      const next = [...neighborsOf(g, t)].sort(byNum);
      return {
        territory: t,
        movable,
        own: next.filter((n) => theirs.includes(n)),
        neutrals: next.filter((n) => {
          const st = state.get(n);
          return st?.owner.kind === 'neutral' && st.armies !== null && !captured.has(n) && (captureCost(defenceAt(n), s) ?? Infinity) <= reach;
        }),
        mine: next.filter((n) => mineSet.has(n) && (toTake(stayAt(n) + unitsAt(n)) ?? Infinity) <= reach),
      };
    });
    exits.push({ player: p, stacks });
    if (!finishedOff.has(p) || opts.movesFirst) continue;
    for (const x of stacks)
      for (const n of x.neutrals) {
        const by = neighborsOf(g, n).filter((y) => mineSet.has(y) || captured.has(y)).sort(byNum);
        warnings.push(
          `player ${p}'s stack on ${label(x.territory)} can flee onto ${label(n)} before my attack lands and survive there; ${by.length ? `${by.map(label).join(' or ')} borders it: retake it next turn` : 'nothing of mine borders it'}.`,
        );
      }
  }
  const decided = [...moves];
  /** Within a slot, a larger early move first: one grouped early transfer beats several small ones. */
  const rankOf = (m: PlannedMove) => (slotOf(m) === MoveSlot.Early ? m.armies : 0);
  let scheduled = scheduleMoves(decided, slotOf, rankOf);
  if (firstOrder && scheduled[0] !== firstOrder) {
    // A move it depends on (one into its source, say) must run before it, so it is not my first
    // order, and the card protects only that one: my first order is whatever the schedule puts first.
    const head = scheduled[0]!;
    if (firstOrder === killOrder)
      warnings.push(
        `The strike that eliminates player ${kill!.p} cannot be my first order: ${label(head.from)} → ${label(head.to)} must run before it.`,
      );
    if (firstOrder === strikeOrder) {
      const r = rationale.findIndex((l) => l.startsWith("Play Order Priority: my commander's territory"));
      if (r >= 0) rationale.splice(r, 1);
      warnings.push(
        `The strike on ${strikeWho}'s commander cannot be my first order: ${label(head.from)} → ${label(head.to)} must run before it, so Order Priority would not make it land before ${strikeWho}'s attacks on my commander's territory.`,
      );
    }
    firstOrder = outOfConceded.includes(head) ? head : undefined;
    lastWhy.clear();
    scheduled = scheduleMoves(decided, slotOf, rankOf);
  }
  moves.splice(0, moves.length, ...scheduled);
  // Order Priority moves only my first order ahead of the opponent's first: spend the card only
  // for that order — the strike rule 1s advised it for, else a move out of a conceded border that
  // saves enough — when I hold one, and when I do not move first anyway.
  /** Why Order Priority is not advised for the protected first order, if not. */
  let why: string | undefined;
  if (!firstOrder) ps.cardAdvice = null;
  else {
    const n = firstOrder.armies;
    /** #179: a strike that ends a player is protected even moving first when the opponent may hold the card too. */
    const decisive = firstOrder === strikeOrder || firstOrder === killOrder;
    const contested = decisive && opts.movesFirst === true && opts.opponentsMayHoldOrderPriority === true;
    why = opts.movesFirst && !contested
      ? "I move first this turn, so my first order already runs before any of the opponent's"
      : firstOrder === strikeOrder
        ? undefined
        : !opts.holdsOrderPriority
          ? 'I hold no Order Priority card to play'
          : n < ORDER_PRIORITY_MIN_ARMIES && !opts.orderPriorityForced && firstOrder !== killOrder
            ? `it saves only ${n} ${n === 1 ? 'army' : 'armies'}, under the ${ORDER_PRIORITY_MIN_ARMIES} a card is worth`
            : undefined;
    ps.cardAdvice = why === undefined ? 'order-priority' : null;
    const mayHold = (who: string) =>
      `I move first this turn, but ${who} may hold an Order Priority card: two cancel, so mine keeps this order first`;
    if (firstOrder === killOrder && ps.cardAdvice) {
      const units = unitsAt(firstOrder.to);
      const stack = `${armiesOf(firstOrder.to)}${units ? ` armies and special units worth ${units}` : ''}`;
      const what = kill!.commander
        ? `the strike on player ${kill!.p}'s commander, which eliminates it (${stack} there), before the commander can move away`
        : `the strike that eliminates player ${kill!.p}, on its largest stack (${stack}), the one that could flee or strike first`;
      rationale.push(
        `Play Order Priority: ${label(firstOrder.from)} → ${label(firstOrder.to)} is ${what}; ${contested ? mayHold(`player ${kill!.p}`) : `with the card it is my first order and runs before player ${kill!.p}'s first`}.`,
      );
    }
    if (firstOrder === strikeOrder && contested) {
      const r = rationale.findIndex((l) => l.startsWith("Play Order Priority: my commander's territory"));
      if (r >= 0) rationale[r] = `${rationale[r]} ${mayHold(strikeWho)}.`;
    } else if (firstOrder === strikeOrder && opts.movesFirst) {
      // Rule 1s advised the card before it knew I move first: take that line back.
      const r = rationale.findIndex((l) => l.startsWith("Play Order Priority: my commander's territory"));
      if (r >= 0) rationale.splice(r, 1);
      rationale.push("Order Priority is not needed for the strike: I move first this turn, so my first order already runs before any of the opponent's.");
    }
  }
  // Each move out of a conceded border says where it stands: the protected first order, or early
  // but possibly too late (the card protects one order only).
  const top = firstOrder && conceded.has(firstOrder.from) ? label(firstOrder.from) : undefined;
  for (let i = 0; i < warnings.length; i++) {
    if (!CONCEDED_ORDER.test(warnings[i]!)) continue;
    const head = warnings[i]!.replace(CONCEDED_ORDER, '');
    const isTop = top !== undefined && (head.startsWith(`The withdrawal from ${top} only`) || head.startsWith(`The attack out of ${top} only`));
    warnings[i] = !isTop
      ? `${head}; it is listed early, but only my first order can run before the opponent's first, so it may come too late.`
      : why === undefined
        ? `${head}; play Order Priority: it is my first order, and the card runs it before the opponent's first.`
        : `${head}; it is my first order (Order Priority not advised: ${why}).`;
  }
  const lasts = scheduled.filter((m) => lastWhy.has(m)).map((m) => lastWhy.get(m)!);
  if (lasts.length || scheduled.some((m, i) => m !== decided[i])) {
    rationale.push(
      `Move order (#127): ${firstOrder ? `${label(firstOrder.from)} → ${label(firstOrder.to)} first; ` : ''}withdrawals and transfers into borders the enemy can break early, attacks that land even if the owner deploys there first next, uncontested captures and interior transfers as filler${lasts.length ? `, and last ${lasts.join('; ')}` : ''}.`,
    );
  }

  // Where each move put last lands among the opponent's orders (two players only: with more,
  // the interleave runs through every player). An Order Priority played (and not matched) makes me
  // the first mover for the turn, whichever I was.
  const foes = [
    ...new Set([...state.values()].flatMap((st) => (st.owner.kind === 'player' && foe(st.owner.playerId) ? [st.owner.playerId] : []))),
  ];
  const lastMoves = scheduled.filter((m) => lastWhy.has(m));
  if (foes.length === 1 && lastMoves.length) {
    const p = foes[0]!;
    const mover: MoverPosition =
      opts.movesFirst === true || ps.cardAdvice === 'order-priority'
        ? 'first'
        : opts.movesFirst === false
          ? 'second'
          : 'unknown';
    const orders = (ownedBy.get(p) ?? []).filter((t) => Math.max(0, armiesOf(t) - guard) + unitsAt(t) > 0).length;
    const need = indexAfterAll(orders, mover);
    const items = lastMoves.map((m) => {
      const k = scheduled.indexOf(m) + 1;
      const before =
        mover === 'unknown'
          ? `after ${opponentOrdersBefore(k, 'first')} of player ${p}'s orders if I move first, ${opponentOrdersBefore(k, 'second')} if it does`
          : `after ${opponentOrdersBefore(k, mover)} of player ${p}'s orders (${mover === 'first' ? 'I move' : 'it moves'} first)`;
      const short = need - k;
      return `${label(m.to)} is my order ${k}: ${before}; player ${p} has ${orders} ${orders === 1 ? 'territory' : 'territories'} in view with armies to move, so it runs after them all${short > 0 ? ` from order ${need} (${short} more ${short === 1 ? 'order' : 'orders'} above it)` : ''}.`;
    });
    rationale.push(`Move position (#127): ${items.join(' ')}`);
  }

  const offenceList = [...offence.values()].map(({ bonusId, ...o }): OffenceEntry => {
    // A strike attack's cost is what the final orders send (a top-up can raise it).
    // The strike stack's own entry is final as built.
    if (o.kind === 'strike') return o;
    if (o.kind === 'strike-attack') return o.taken && captured.has(o.target) ? { ...o, cost: sentAt(o.target) || o.cost } : o;
    // A bonus broken this turn is a break made, whichever member fell and whatever path took it.
    const via = captured.has(o.target)
      ? o.target
      : bonusId !== undefined
        ? bonusTerritories(g, bonusId).filter((x) => captured.has(x)).sort(byNum)[0]
        : undefined;
    if (via !== undefined)
      return {
        ...o,
        target: via,
        cost: sentAt(via) || o.cost,
        taken: true,
        why: via === o.target ? o.why : `already broken by the capture of ${label(via)}: ${o.why}`,
      };
    return {
      ...o,
      taken: false,
      why: `not made — ${offenceSkip.get(o.target) ?? 'other uses of the income scored higher per army, or it could not be afforded'}: ${o.why}`,
    };
  });

  // #172: how each territory in between that a two-step hold judged ends — kept (not conceded)
  // and holding its own border with what the final orders leave there (its armies, deploys and
  // every transfer in, less every order out) — for settledPass to check the pass against.
  for (const v of pass.viaSeen.keys()) {
    const b = borders.get(v);
    const ends = moves.reduce((n, m) => n - (m.from === v ? m.armies : 0) + (m.kind === 'transfer' && m.to === v ? m.armies : 0), armiesOf(v) + (deployed.get(v) ?? 0));
    pass.viaFinal.set(v, !conceded.has(v) && b !== undefined && (toTake(ends + unitsAt(v)) ?? Infinity) > b.threat);
  }

  // ---- #201: a break without an elimination invites retaliation (FFA) ----
  // In an FFA a player whose bonus I break and leave standing aims what it has left at me; in a
  // 1v1 it does anyway, so no warning there.
  if (profile.format === 'ffa' && profile.opponents >= 2) {
    for (const [p, ts] of [...ownedBy].sort((a, b) => a[0] - b[0])) {
      if (!foe(p)) continue;
      const broken = g.map.bonuses
        .filter((b) => b.value > 0)
        .filter((b) => {
          const members = bonusTerritories(g, b.id);
          return members.length > 0 && members.every((t) => ownerOf(t) === p) && members.some((t) => captured.has(t));
        })
        .sort((a, b) => a.id - b.id);
      if (!broken.length) continue;
      const left = ts.filter((t) => !captured.has(t));
      if (!left.length && !fogEdge(p).length) continue;
      const armies = left.reduce((n, t) => n + armiesOf(t), 0);
      const value = broken.reduce((n, b) => n + b.value, 0);
      warnings.push(
        `Breaking player ${p}'s bonus${broken.length === 1 ? '' : 'es'} ${broken.map((b) => `${b.name} (+${b.value})`).join(', ')} without eliminating it invites retaliation (#201): it keeps ${left.length} territor${left.length === 1 ? 'y' : 'ies'} in view (${armies} armies)${fogEdge(p).length ? ' and more in the fog' : ''} and a ~${deployOf(p)} deploy, and loses +${value} a turn to me — in a free-for-all what it has left is likeliest aimed at whoever broke it.`,
      );
    }
  }

  // ---- #167: the exchange of each attack on a player ----
  const exchanges: ExchangeView[] = moves.flatMap((m): ExchangeView[] => {
    const st = state.get(m.to);
    if (m.kind !== 'attack' || st?.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) return [];
    const p = st.owner.playerId;
    const deploy = reinforcementAt(m.to);
    // Its stack can hit my source: what stays there against its movable armies plus its deploy.
    const take = toTake(stayAt(m.from) + unitsAt(m.from));
    const threatensSource = take !== null && take <= Math.max(0, st.armies - guard) + unitsAt(m.to) + deployOf(p);
    const x = classifyExchange({
      attackers: m.armies,
      defenders: defenceAt(m.to),
      deploy,
      income: Math.max(deploy, deployOf(p)),
      threatensSource,
      rates,
    });
    return [{ from: m.from, to: m.to, armies: m.armies, player: p, ...x }];
  });
  if (exchanges.length)
    rationale.push(
      `Exchange of attacks on players (#167): ${exchanges
        .map((e) => {
          const [now, est, whole] = e.cases as [ExchangeCase, ExchangeCase, ExchangeCase];
          const at = (c: ExchangeCase) => `${c.captures ? 'takes' : `${c.net >= 0 ? '+' : ''}${c.net}`} against ${c.defenders}`;
          return `${label(e.to)} from ${label(e.from)} with ${e.armies}: ${e.label} (${at(now)}, ${at(est)} after the estimated deploy, ${at(whole)} after the whole income)`;
        })
        .join('; ')}.`,
    );

  // ---- #179: turns to eliminate each visible opponent ----
  const eliminateEta: Record<number, EliminateEta> = {};
  {
    const dist = new Map<number, number>(mine.map((t) => [t, 0] as const));
    const queue = [...mine];
    for (let i = 0; i < queue.length; i++) {
      const x = queue[i]!;
      for (const n of neighborsOf(g, x))
        if (!dist.has(n)) {
          dist.set(n, dist.get(x)! + 1);
          queue.push(n);
        }
    }
    const movable = mine.reduce((n, x) => n + Math.max(0, armiesOf(x) - guard), 0);
    for (const [p, ts] of [...ownedBy].sort((a, b) => a[0] - b[0])) {
      const distance = Math.max(...ts.map((t) => dist.get(t) ?? Infinity));
      const base = ts.reduce((n, t) => n + (captureCost(defenceAt(t), s) ?? Infinity), 0);
      if (!Number.isFinite(distance) || !Number.isFinite(base)) continue;
      const need = (k: number) => base + (k * deployOf(p) > 0 ? (captureCost(k * deployOf(p), s) ?? Infinity) : 0);
      let turns: number | null = null;
      for (let k = Math.max(1, distance); k <= ETA_HORIZON && turns === null; k++) if (need(k) <= movable + income * k) turns = k;
      const armies = need(turns ?? Math.max(1, distance));
      eliminateEta[p] = { turns, atLeast: fogEdge(p).length > 0, distance, armies: Number.isFinite(armies) ? armies : null };
    }
  }

  return {
    goal,
    profile,
    // Deploys interleave like moves, and the order they land in shows the opponent my income and
    // the move order: next to a visible enemy first, in the back after (ascending id within each).
    deploys: [...deployed]
      .filter(([, n]) => n > 0)
      .sort((a, b) => Number(facesEnemy(b[0])) - Number(facesEnemy(a[0])) || a[0] - b[0])
      .map(([territoryId, armies]) => ({ territoryId, armies })),
    moves,
    expected: {
      captures: [...captured].sort(byNum),
      bonusesCompleted: completed,
      nextIncome,
      ...(reportRisk ? { nextIncomeIfConcededFall: ifFall, bonusesAtRisk: atRisk } : {}),
    },
    warnings,
    rationale,
    enemyDeploy,
    conceded: [...conceded].sort(byNum),
    cardAdvice: ps.cardAdvice,
    multiSourceCaptures: [...combined].sort(byNum),
    frontier,
    offence: offenceList,
    moveSlots: moves.map((m) => SLOT_NAMES[slotOf(m)]!),
    ...(exchanges.length ? { exchanges } : {}),
    ...(Object.keys(eliminateEta).length ? { eta: { eliminate: eliminateEta } } : {}),
    ...(exits.length ? { exits } : {}),
  };
}
