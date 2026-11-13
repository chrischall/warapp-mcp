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
//     one turn gets a warning. Teammates (the game's team list) are never a threat, an
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
//     of mine next to it holds against its stacks there plus that deploy (a source keeps it and
//     what its attack would lose defending; a border that attacks nothing is deployed to), and
//     keeps it through the later passes (`coverKeep`); unaffordable, it is planned uncovered with
//     the move-order caveat ("Cover player …'s exits"). In an FFA (two or more opponents) an
//     elimination is priced first: the players its land makes me border and the frontier cost
//     before and after (`frontierDelta`, its threat gone); a buffer whose removal costs more than
//     a turn of my income and more than PAYBACK_TURNS × the income its land adds is left standing
//     ("Not finishing off player …"), and no pass takes its territories this turn.
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
//     Scope of "protected value", deliberately narrow: only bonuses containing T
//     count (not a bonus T merely borders; a negative bonus I hold in full that contains T
//     counts against it, #128 — losing T lifts it — floored at 0), and an incomplete one counts in full
//     when T is my only foothold, however much of it the enemy holds, else by its share
//     while I am building it (above). So with no complete bonus, no bonus being built and
//     no per-territory income (`bonusArmyPer` off, or its armies still below the base income
//     they replace), a threatened border protects +0 and is conceded: early in a game
//     `defend` holds nothing and withdraws from every threatened border, keeping armies for
//     expansion.
//     A conceded border is never deployed to (unless every territory I hold is
//     conceded): it may still attack out with the armies already on it, since they
//     are lost anyway if they stay, but no capture is funded there.
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
//     changes without its own hold need, warning when it can be retaken), or a counter-attack
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
//     adds "bring K more next turn".
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
//     together with another's are no gamble — the line says how many the split takes at once and
//     gives each 0%. Left alone: every visible enemy territory next to mine that no
//     order attacks is named in one line, "Not attacking … next to mine", with its first reason: a
//     special unit, the offence report's reason (a second front, unaffordable, a trade below even), a
//     capture lowering income, its size against the most a neighbour can spare, a lead strike's sure
//     size against what a neighbour can spare for it, or that it is no target of the plan's (rule 2;
//     under another goal, naming the player's territories other rules do attack). The first
//     NOT_ATTACKING_REASONS (by id) get a reason, the rest are named.
//     Wastelands (#167, `settings.wastelands`): a fogged missing member of a bonus is costed at the
//     costliest visible missing member plus the expected surcharge of being a wasteland
//     (ceil(count ÷ the map's territories × (a wasteland's capture cost − that))), with a rationale line.
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
import { incomeBasis, type OpponentTrack } from './opponents.js';
import type { GameSettings } from '../normalize.js';
import { carriesTeam } from '../teams.js';
import { analyzeBonus, bonusTerritories } from './bonuses.js';
import {
  armiesForChance,
  armiesToTake,
  COMMANDER_STRENGTH,
  DEFAULT_DEFENSIVE_KILL_RATE,
  DEFAULT_OFFENSIVE_KILL_RATE,
  guaranteedKills,
  luckFraction,
  nextBreakpoint,
  specialUnitStrength,
  straightKills,
  winChance,
  type CombatSettings,
  type KillRates,
} from './combat.js';
import { bfsDistances, neighborsOf, type MapGraph } from './graph.js';
import { classifyExchange, forecastBorder, type Exchange, type ExchangeCase } from './exchange.js';
import { twoStepReaches, type TwoStepReach } from './lookahead.js';
import { indexAfterAll, MoveSlot, opponentOrdersBefore, scheduleMoves, type MoverPosition } from './schedule.js';
import { chargeDeploys, deployPools } from './local-deploy.js';
import { boardIncome, DEFAULT_BASE_INCOME, incomeRules, territoryIncome } from './player.js';
import { AHEAD_RATIO, BEHIND_RATIO, gameProfile, type GameProfile, type ProfilePlayer } from './profile.js';

/** A bonus is uneconomic when its remaining capture cost exceeds this many turns of its value… */
export const PAYBACK_TURNS = 10;
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
const MAX_NAMED_REVEALS = 6;
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
}

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
const CITE_OPEN = '\u0001';
const CITE_SEP = '\u0002';
const CITE_CLOSE = '\u0003';
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
  source: 'visible' | 'observed' | 'tracked' | 'prior';
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
function openingArmies(
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
  when: { turn?: number | null } = {},
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
    const source: EnemyDeployEstimate['source'] = priorFigure !== null && priorFigure > seen ? 'prior' : seenSource;
    const estimate = source === 'prior' ? priorFigure! : seen;
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
    };
  });
}

/**
 * Default enemy deploy: the largest {@link enemyDeployEstimates} figure among the
 * players with a visible stack next to me, at least {@link MIN_ENEMY_DEPLOY}. Pass the
 * turn (`when`) and the fog prior {@link planEnemyEstimates} uses, or a mid-game board of
 * equal stacks reads as the opening board (#128) and the figure disagrees with the planner's.
 */
export function defaultEnemyDeploy(
  g: MapGraph,
  board: BoardState,
  me: number,
  settings: PlannerSettings = {},
  previous?: BoardState,
  tracks?: readonly OpponentTrack[],
  prior?: EnemyIncomePrior,
  when: { turn?: number | null } = {},
): number {
  const mineIds = new Set(
    board.territories.flatMap((t) => (t.owner.kind === 'player' && t.owner.playerId === me ? [t.territoryId] : [])),
  );
  const next = new Set<number>();
  for (const t of board.territories) {
    if (t.owner.kind !== 'player' || t.owner.playerId === me || t.armies === null) continue;
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

interface Target {
  id: number;
  cost: number;
  enemy: boolean;
  sources: number[];
}

interface BonusPlan {
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

/**
 * The fog prior to apply (#119, {@link EnemyIncomePrior}): only when the game says the start was
 * symmetric (`symmetricStart`) and it is a 1v1 — two players in the game, the other still
 * playing, no teams (the players in sight when no player list is given). An FFA down to two
 * gets none: either survivor may have absorbed the eliminated players' territories.
 */
function fogPrior(board: BoardState, me: number, ctx: PlanGameContext, myIncome: number): EnemyIncomePrior | undefined {
  if (ctx.symmetricStart !== true) return undefined;
  const players = ctx.players ?? [];
  if (players.some((p) => carriesTeam(p.team))) return undefined;
  if (players.length > 2) return undefined;
  const opponents = players.length
    ? players.filter((p) => p.id !== me && (p.state ?? 'Playing') === 'Playing').length
    : new Set(board.territories.flatMap((t) => (t.owner.kind === 'player' && t.owner.playerId !== me ? [t.owner.playerId] : []))).size;
  if (opponents !== 1) return undefined;
  return { myIncome: Math.max(0, myIncome), ...(ctx.opening ? { opening: ctx.opening } : {}) };
}

/** The players on `me`'s team (#128), from the game's player list; none in a no-team game. */
export function alliesOf(me: number, players: readonly ProfilePlayer[] | undefined): Set<number> {
  const team = players?.find((p) => p.id === me)?.team;
  if (!carriesTeam(team)) return new Set();
  return new Set((players ?? []).filter((p) => p.id !== me && p.team === team).map((p) => p.id));
}

/**
 * The per-opponent deploy estimates a plan works from: {@link enemyDeployEstimates} with the fog
 * prior (#119, {@link fogPrior}) when the game context allows it, and the turn being played (the
 * opening board is the first turn's only, #128). {@link planTurn} and warapp_check_plan both use
 * it, so they work from the same figures. `income` is my board income, card armies left out.
 * Every visible player is listed, teammates included (the caller filters them).
 */
export function planEnemyEstimates(input: {
  graph: MapGraph;
  board: BoardState;
  me: number;
  income: number;
  settings?: PlannerSettings;
  previousBoard?: BoardState;
  tracks?: readonly OpponentTrack[];
  game?: PlanGameContext;
  turn?: number | null;
}): { estimates: EnemyDeployEstimate[]; prior: EnemyIncomePrior | undefined } {
  const ctx = input.game ?? {};
  const prior = fogPrior(input.board, input.me, ctx, input.income);
  const turn = input.turn ?? ctx.turn ?? null;
  const estimates = enemyDeployEstimates(input.graph, input.board, input.me, input.settings ?? {}, input.previousBoard, input.tracks, prior, { turn });
  return { estimates, prior };
}

/**
 * #172: how one planning pass treats the two-step hold. Attacks are sized greedily, so an early
 * attack out of a guarded territory cannot know that a later order of the same plan takes the
 * reach's stack or the territory in between; {@link planTurn} learns that from earlier passes.
 */
interface TwoStepPass {
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
interface TwoStepShared {
  reaches?: ReadonlyMap<number, readonly TwoStepReach[]>;
}
/** A two-step hold on one territory of mine (#172): what stays, what it needs, and the reach. */
interface TwoStepHoldAt {
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
  const { graph: g, board, me } = input;
  const s = input.settings ?? {};
  const baseIncome = Math.max(0, Math.floor(s.baseIncome ?? DEFAULT_BASE_INCOME));
  const opts = input.options ?? {};
  const income = Math.max(0, Math.floor(input.income));
  const ctx = input.game ?? {};
  /** My teammates (#128): players on my team, never a threat, a target or an estimate. */
  const allies = alliesOf(me, ctx.players);
  /** A player whose stacks threaten me and whose territories I may attack: not me, not a teammate. */
  const foe = (p: number) => p !== me && !allies.has(p);
  /** The turn being planned, when known (the opening board is the first turn's only, #128). */
  const turnNow = input.turn ?? ctx.turn ?? null;
  const { estimates: allEstimates, prior: incomePrior } = planEnemyEstimates({
    graph: g,
    board,
    me,
    income: income - Math.max(0, Math.floor(input.cardArmies ?? 0)),
    settings: s,
    ...(input.previousBoard ? { previousBoard: input.previousBoard } : {}),
    ...(input.tracks ? { tracks: input.tracks } : {}),
    game: ctx,
    turn: turnNow,
  });
  const estimateList = allEstimates.filter((e) => foe(e.playerId));
  // ---- 0p. the game profile ----
  const profile = gameProfile({
    graph: g,
    board,
    me,
    players: ctx.players ?? [],
    settings: {
      ...(s.luckModifier !== undefined ? { luckModifier: s.luckModifier } : {}),
      ...(s.roundingMode !== undefined ? { roundingMode: s.roundingMode } : {}),
      ...(ctx.cards !== undefined ? { cards: ctx.cards } : {}),
      ...(s.localDeployments !== undefined ? { localDeployments: s.localDeployments } : {}),
      ...(s.noSplit !== undefined ? { noSplit: s.noSplit } : {}),
      ...(ctx.commanders !== undefined ? { commanders: ctx.commanders } : {}),
      ...(ctx.fog !== undefined ? { fog: ctx.fog } : {}),
      ...(s.offensiveKillRate !== undefined ? { offensiveKillRate: s.offensiveKillRate } : {}),
      ...(s.defensiveKillRate !== undefined ? { defensiveKillRate: s.defensiveKillRate } : {}),
      ...(s.oneArmyStandsGuard !== undefined ? { oneArmyStandsGuard: s.oneArmyStandsGuard } : {}),
    },
    ...(ctx.turn !== undefined ? { turn: ctx.turn } : {}),
    ...(ctx.picking !== undefined ? { picking: ctx.picking } : {}),
    income,
    estimates: estimateList,
    // #94: opponents the tracker found with nothing in view, for the 'unknown' standing note.
    unseen: (input.tracks ?? []).flatMap((t) =>
      t.earnedAtLeast ? [{ playerId: t.playerId, turnsUnseen: t.turnsUnseen, turnsUnseenAtLeast: t.turnsUnseenAtLeast, earnedAtLeast: t.earnedAtLeast.total }] : [],
    ),
  });
  /** The profile picks the goal and tunes the scoring (rule 0p): adapting, with no explicit goal. */
  const auto = opts.adapt === true && opts.goal === undefined;
  /** Rule 0p.3: behind on income. */
  const behind = auto && profile.standing === 'behind';
  /** Rule 0p.3 (#72): behind on income in a 1v1 — strike (stay balanced, break first), never defend. */
  const strike = behind && profile.format === '1v1';
  const goal: PlanGoal = opts.goal ?? (behind && !strike ? 'defend' : 'balanced');
  const balanced = goal === 'balanced';
  /** Rule 0p.3: behind — size attacks at the minimum (no pressure margin). */
  const minimal = behind;
  /** Rule 0p.3: ahead in a 1v1 — pressure allowed at {@link AHEAD_PRESSURE_FACTOR}. */
  const pressureFactor = auto && profile.format === '1v1' && profile.standing === 'ahead' ? AHEAD_PRESSURE_FACTOR : PRESSURE_FACTOR;
  /** The pressure margin over an estimated deploy: none when sizing at the minimum. */
  const marginFor = (d: number) => (minimal ? 0 : pressureMargin(d));
  /** Goals that refuse to complete a bonus they cannot hold (R3); the others only warn. */
  const guarded = balanced || goal === 'defend';
  const focus = new Set(opts.focusBonusIds ?? []);
  const reserve = Math.min(income, Math.max(0, Math.floor(opts.reserve ?? 0)));
  const custom = opts.enemyDeploy !== undefined;
  const mineAtStart = new Set(
    board.territories.flatMap((t) => (t.owner.kind === 'player' && t.owner.playerId === me ? [t.territoryId] : [])),
  );
  // As {@link defaultEnemyDeploy}, over the opponents only (teammates out, #128).
  const enemyDeploy = custom
    ? Math.max(0, Math.floor(opts.enemyDeploy!))
    : estimateList.reduce(
        (m, e) =>
          board.territories.some(
            (t) =>
              t.owner.kind === 'player' &&
              t.owner.playerId === e.playerId &&
              t.armies !== null &&
              g.territoryById.has(t.territoryId) &&
              neighborsOf(g, t.territoryId).some((n) => mineAtStart.has(n)),
          )
            ? Math.max(m, e.estimate)
            : m,
        MIN_ENEMY_DEPLOY,
      );
  const estimates = new Map(estimateList.map((e) => [e.playerId, e]));
  /** The deploy assumed for one opponent's threat: the override, else its own estimate. */
  const deployOf = (player: number) => (custom ? enemyDeploy : (estimates.get(player)?.estimate ?? MIN_ENEMY_DEPLOY));
  const guard = (s.oneArmyStandsGuard ?? true) ? 1 : 0;
  const rates = {
    offensiveKillRate: s.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE,
    defensiveKillRate: s.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE,
  };
  /** The exact combat model's settings (S2): kill rates, luck, rounding. */
  const combat = combatSettings(s);
  const chanceOf = (armies: number, defenders: number) => winChance(armies, defenders, combat);
  /** The least win chance an ordinary capture is sized for (S2; #126: 95% by default with luck on). */
  const minWin = opts.minWinChance !== undefined ? minWinChanceOf(opts.minWinChance) : defaultMinWinChance(s);
  /** Exact results: 0% luck under straight rounding, where every chance is 0 or 1. */
  const exactCombat = !combat.luck && combat.rounding !== 'WeightedRandom';
  /**
   * #126: the chance each capture of `t` is sized for, so the captures a bonus still needs reach
   * {@link minWin} together: minWin^(1/k), k the most members not mine of any positive bonus `t`
   * is in (1 outside a bonus). 1 when minWin is.
   */
  const missingOf = new Map<number, number>();
  const heldAtStart = new Set(
    board.territories.flatMap((t) => (t.owner.kind === 'player' && t.owner.playerId === me ? [t.territoryId] : [])),
  );
  for (const b of g.map.bonuses) {
    if (b.value <= 0) continue;
    const ts = bonusTerritories(g, b.id);
    const missing = ts.filter((x) => !heldAtStart.has(x)).length;
    for (const x of ts) missingOf.set(x, Math.max(missingOf.get(x) ?? 1, missing));
  }
  const chanceAt = (t: number) => (minWin >= 1 ? 1 : minWin ** (1 / (missingOf.get(t) ?? 1)));
  const costMemo = new Map<string, number | null>();
  /** An ordinary capture's size against `defenders`, at `chance` (default {@link minWin}). */
  const costOf = (defenders: number, chance = minWin): number | null => {
    const key = `${defenders}|${chance}`;
    if (!costMemo.has(key)) costMemo.set(key, captureCost(defenders, s, chance));
    return costMemo.get(key)!;
  };
  /** An ordinary capture of `t`'s size against `defenders` (default what defends it now), at {@link chanceAt}. */
  const costAt = (t: number, defenders = defenceAt(t)): number | null => costOf(defenders, chanceAt(t));
  /** {@link toTake} by defenders, for this plan's settings. */
  const takeMemo = new Map<number, number | null>();
  /**
   * The attack that takes `defenders` (holds, threats, retakes): `armiesToTake` with exact results;
   * else (#126) the fewest attackers whose win chance exceeds {@link HOLD_FALL_CHANCE}, so a stack
   * that "needs N to take, above the threat" falls to that threat at most that often.
   */
  const toTake = (defenders: number): number | null => {
    if (exactCombat) return armiesToTake(defenders, rates);
    if (!takeMemo.has(defenders))
      takeMemo.set(defenders, defenders <= 0 ? 1 : armiesForChance(defenders, HOLD_FALL_CHANCE + 1e-9, combat));
    return takeMemo.get(defenders)!;
  };
  const warnings: string[] = [];
  const rationale: string[] = [];
  const profileText = `${profile.format}, ${profile.phase}, ${profile.standing}`;
  if (opts.adapt && opts.goal !== undefined) {
    rationale.push(`Goal ${goal} was given explicitly, so it overrides the game profile (${profileText}): none of the profile's rules apply.`);
    // Also a warning: live, a script that always passed `goal: balanced` switched the 1v1 rules
    // (strike stack, breaks before expansion) off for two whole games, and nobody noticed.
    warnings.push(
      `Goal ${goal} was given explicitly, so none of the game-profile rules for ${profile.format === 'ffa' ? 'an FFA' : profile.format === 'teams' ? 'a team game' : 'a 1v1'} apply this turn (standing ${profile.standing}): leave the goal out to let the profile choose it and apply them.`,
    );
  } else if (auto) {
    const strongest = estimateList.reduce((m, e) => Math.max(m, e.estimate), 0);
    rationale.push(
      strike
        ? `Goal balanced from the game profile (${profileText}): behind on income (${income} against ~${strongest}) in a 1v1 — strike: break the opponent's bonuses with minimal attacks before expansion that completes nothing (holds of my own bonuses that pay for themselves still come first), sized at the minimum (no extra margin beyond what the rules require).`
        : minimal
          ? `Goal defend from the game profile (${profileText}): behind on income (${income} against ~${strongest}), so defend first and size attacks at the minimum (no extra margin beyond what the rules require).`
          : `Goal balanced from the game profile (${profileText}): the base goal.`,
    );
    if (pressureFactor !== PRESSURE_FACTOR)
      rationale.push(
        `Ahead in a 1v1 (${income} against ~${strongest}): keep attacking — pressure on an opponent next to the fog is allowed when each capture costs up to ${pressureFactor}× a typical neutral capture (instead of ${PRESSURE_FACTOR}×).`,
      );
  }

  const state = new Map<number, TerritoryState>();
  for (const t of board.territories) if (g.territoryById.has(t.territoryId)) state.set(t.territoryId, t);
  const label = (id: number) => `${g.territoryById.get(id)!.name} (#${id})`;
  const isMine = (id: number) => {
    const o = state.get(id)?.owner;
    return o?.kind === 'player' && o.playerId === me;
  };
  const mine = [...state.keys()].filter(isMine).sort(byNum);
  const mineSet = new Set(mine);
  // Next turn's income (#85): this turn's, less its card armies, moved by what the one income rule
  // ({@link boardIncome}) says the holdings `after` change — bonuses completed (negative ones
  // too), per-territory armies, the floor at 0.
  const incomeRulesNow = { base: baseIncome, per: s.bonusArmyPer ?? 0 };
  const boardIncomeNow = boardIncome(g, mineSet, incomeRulesNow).total;
  const cardArmies = Math.max(0, Math.floor(input.cardArmies ?? 0));
  /**
   * The income change (#70, #85) from holding `after` instead of what I held at the start: the one
   * income rule's ({@link boardIncome}) total over `after` less its total now — every bonus whose
   * completion changes (negative ones and superbonuses included), per-territory armies, and the
   * floor at 0 on both sides, so a change computed below the floor is what war.app pays.
   * Next income, R3, rule 4c's scoring and its guard all read it.
   */
  const incomeGain = (after: ReadonlySet<number>): number => boardIncome(g, after, incomeRulesNow).total - boardIncomeNow;
  /** Next income after a change of `gain`: this turn's, less its card armies, moved by `gain`. */
  const nextIncomeWith = (gain: number) => Math.max(0, income - cardArmies + gain);
  const incomeAfter = (after: ReadonlySet<number>) => nextIncomeWith(incomeGain(after));
  /**
   * #128: the next income the plan can count on — {@link incomeAfter} without the borders it
   * concedes (it does not plan to hold them, so the bonuses they break do not pay for anything).
   * Assigned once `conceded` exists; R3, rule 4d and the frontier report use it.
   */
  let keptIncome = (after: ReadonlySet<number>) => incomeAfter(after);
  const armiesOf = (id: number) => state.get(id)?.armies ?? 0;
  /** The armies the special units on `id` fight as (a commander: {@link COMMANDER_STRENGTH}). */
  const unitsAt = (id: number) => specialUnitStrength(state.get(id)?.specialUnits);
  /**
   * #128: a territory holding a special unit whose strength the board does not carry (a boss, a
   * custom unit): it counts as 0 everywhere, so no attack on it is sized as sure.
   */
  const uncounted = (id: number) => (state.get(id)?.specialUnits ?? []).some((u) => u.kind !== 'commander');
  const uncountedKind = (id: number) =>
    [...new Set((state.get(id)?.specialUnits ?? []).filter((u) => u.kind !== 'commander').map((u) => (u.kind === 'boss' ? 'a boss' : u.kind === 'custom' ? 'a custom unit' : 'a special unit')))].join(' and ');
  /** What a territory defends as now: its armies plus its special units. */
  const defenceAt = (id: number) => armiesOf(id) + unitsAt(id);
  /**
   * What capturing `x` costs the economy (#125): the armies its attackers lose (the defenders'
   * kills at the defensive rate) plus the one army left on it — not the armies sent, whose
   * survivors are still mine. That one army is waived when a territory of mine beside it that
   * faces no visible enemy already has idle armies enough to take it (nothing is deployed for
   * it). Infinity when it cannot be taken.
   */
  const econCostAt = (x: number): number => {
    const c = costAt(x);
    if (c === null) return Infinity;
    const lost = Math.min(c - 1, straightKills(defenceAt(x), rates.defensiveKillRate));
    const idle = neighborsOf(g, x).some(
      (n) =>
        isMine(n) &&
        armiesOf(n) - guard >= c &&
        !neighborsOf(g, n).some((y) => {
          const o = state.get(y)?.owner;
          return o?.kind === 'player' && foe(o.playerId);
        }),
    );
    return lost + (idle ? 0 : 1);
  };
  /**
   * #167: my army lead over the largest opponent in view — my visible armies and special units over
   * theirs (Infinity with no opponent in view). Rule 0p.2 scales with it, and above
   * SECOND_FRONT_LEAD× it is off.
   */
  const armyLead = (() => {
    const by = new Map<number, number>();
    for (const [id, st] of state)
      if (st.owner.kind === 'player' && st.armies !== null) by.set(st.owner.playerId, (by.get(st.owner.playerId) ?? 0) + st.armies + unitsAt(id));
    const my = by.get(me) ?? 0;
    const rival = [...by].filter(([p]) => foe(p)).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    return { my, rival: rival?.[0], theirs: rival?.[1] ?? 0, ratio: rival && rival[1] > 0 ? my / rival[1] : Infinity };
  })();
  /**
   * #167: adapting (rule 0p), the lead switches rule 0p.2 off. Visible armies only, so under fog a
   * strong player showing one small stack would inflate it: the lever also needs me first in the
   * profile's FFA ranking on strength (armies + STRENGTH_INCOME_TURNS × income), when there is one.
   */
  const leadLever =
    opts.adapt === true &&
    opts.goal === undefined &&
    armyLead.rival !== undefined &&
    armyLead.ratio > SECOND_FRONT_LEAD &&
    (profile.ranking === undefined || profile.ranking.myRank === 1);
  /**
   * #167: a clear FFA leader that is not me (strength at least AHEAD_RATIO × the next player's): the
   * player the others combine against, never a second front.
   */
  const clearLeader = (() => {
    const r = profile.ranking;
    if (!(opts.adapt === true && opts.goal === undefined) || !r || r.commonThreat === null || r.players.length < 2) return undefined;
    return r.players[0]!.strength >= AHEAD_RATIO * r.players[1]!.strength ? r.commonThreat : undefined;
  })();
  /** "3.3×" */
  const leadText = () => (Number.isFinite(armyLead.ratio) ? `${(Math.round(armyLead.ratio * 10) / 10).toFixed(1)}×` : 'unbounded (no opponent army in view)');
  /** My territories where my own commander stands: must-hold (rule 1k). */
  const myCommanders = new Set(
    mine.filter((id) => (state.get(id)?.specialUnits ?? []).some((u) => u.kind === 'commander' && u.playerId === me)),
  );

  // ---- rule 0p.3 (#72): behind on armies ----
  // Adapting in a 1v1: my visible armies against the strongest opponent's visible armies, each
  // with the special units standing on them (a commander fights as COMMANDER_STRENGTH). Behind
  // (below BEHIND_RATIO×, strictly, as the plan states) means no trade below even: a combined
  // capture of a player's territory whose attacks lose more armies than they kill is not made.
  // A single capture needs no check: it kills every defender and loses at most
  // round(defenders × defensive rate) ≤ defenders, so it never trades below even (pinned by
  // tests at unusual kill rates) — revisit this if single-capture sizing ever changes.
  let armiesBehind = false;
  if (auto && profile.format === '1v1') {
    const totals = new Map<number, number>();
    for (const st of state.values())
      if (st.owner.kind === 'player' && st.armies !== null)
        totals.set(
          st.owner.playerId,
          (totals.get(st.owner.playerId) ?? 0) + st.armies + specialUnitStrength(st.specialUnits),
        );
    const myArmies = totals.get(me) ?? 0;
    const [rival, theirs] = [...totals]
      .filter(([p]) => foe(p))
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] ?? [undefined, 0];
    if (rival !== undefined && theirs > 0 && myArmies < BEHIND_RATIO * theirs) {
      armiesBehind = true;
      rationale.push(
        `Behind on armies (${myArmies} visible against player ${rival}'s ${theirs}): no trade below even — a capture of a player's territory whose attacks lose more armies than they kill is not made.`,
      );
    }
  }

  if (!board.verified)
    warnings.push('Board state comes from an unverified parser of the GameFeed standing; check it against the game.');
  const luck = luckFraction(s.luckModifier);
  const weightedRounding = s.roundingMode !== undefined && s.roundingMode !== 'StraightRound';
  if (luck > 0)
    warnings.push(
      minWin < 1
        ? `Luck is ${Math.round(luck * 100)}%: each capture is sized for at least a ${Math.round(minWin * 100)}% win chance (min_win_chance${opts.minWinChance === undefined ? `, ${Math.round(LUCK_WIN_CHANCE * 100)}% by default with luck on` : ''}), so it can fail; each attack's winChance says how likely it is.`
        : `Luck is ${Math.round(luck * 100)}%: each capture is sized to be certain (min_win_chance 1: the fewest armies whose every roll takes it); each attack's winChance says how likely it is.`,
    );
  if (s.offensiveKillRate === undefined || s.defensiveKillRate === undefined)
    warnings.push(
      `Kill rates missing from the game settings; assuming ${rates.offensiveKillRate}% offense, ${rates.defensiveKillRate}% defense.`,
    );
  if (s.roundingMode === 'WeightedRandom')
    warnings.push(
      `This game uses ${s.roundingMode} rounding: capture and hold sizes are computed under it (a fraction of a kill can round either way), and each attack's winChance says how likely it is.`,
    );
  else if (weightedRounding)
    warnings.push(`Capture costs assume straight rounding; this game uses ${s.roundingMode}, which the combat model does not know.`);
  if (minWin < 1)
    rationale.push(
      `Captures are sized for at least a ${Math.round(minWin * 100)}% win chance (min_win_chance), not a guaranteed take: each gets the fewest armies whose exact win chance reaches it, and the captures a bonus still needs reach it together (each at that chance to the power 1/k, k the bonus's missing members). Attacks sized for a worst case (finishing a player off, fog pressure, commander strikes) stay certain: their win chance is 1.`,
    );
  if (!exactCombat)
    rationale.push(
      `Holds are sized so the attack assumed wins at most ${Math.round(HOLD_FALL_CHANCE * 100)}%: "need N to take" is the smallest attack that wins more often than that${luck > 0 ? ` at ${Math.round(luck * 100)}% luck` : ''}${weightedRounding ? ` under ${s.roundingMode} rounding` : ''}.`,
    );
  if (s.multiAttack)
    rationale.push('Multi-attack is on, but the plan does not chain attacks from captured territories.');
  const noSplit = s.noSplit === true;
  if (noSplit) {
    rationale.push(
      'No-Split: each territory issues at most one attack or transfer this turn, and it sends the whole stack (every army there, this turn\'s deploys included, less the guard); a territory that would split keeps its first (best) order, and one that must hold issues none.',
    );
  }

  if (!mine.length) {
    warnings.push(`Player ${me} holds no territories on this board, so there is nothing to deploy or move.`);
    return {
      goal,
      profile,
      deploys: [],
      moves: [],
      expected: { captures: [], bonusesCompleted: [], nextIncome: Math.max(0, income - cardArmies) },
      warnings,
      rationale,
      enemyDeploy,
      conceded: [],
      cardAdvice: null,
      multiSourceCaptures: [],
      frontier: { borders: 0, enemyBorders: 0, holdCost: 0, income },
      offence: [],
    };
  }

  // ---- mutable plan state ----
  let budget = income;
  const deployed = new Map<number, number>();
  // May start at −1 (a 0-army territory still owes its guard): deploys there pay for it first.
  const avail = new Map(mine.map((id) => [id, armiesOf(id) - guard]));
  const locked = new Set<number>();
  /**
   * #179: what a territory covering a finished-off player's exit keeps (in `avail` terms): its
   * stacks may attack before my attacks land. Every later pass that spends a territory's armies
   * honours it: {@link keepFor}, {@link keepOf} (every capture and combined capture), the
   * withdrawal from a conceded border, the efficient-size top-up, staging and the idle transfers.
   * Under No-Split a covered territory issues no order (it would send its whole stack).
   */
  const coverKeep = new Map<number, number>();
  /** #179: what my `x` keeps to cover a finished-off player's exit, in `avail` terms (0 when none). */
  const coverOf = (x: number) => coverKeep.get(x) ?? 0;
  /** #179: a buffer in an FFA left standing: no pass captures its territories this turn. */
  const spared = new Set<number>();
  const captured = new Set<number>();
  /** Targets taken by a combined (multi-source) capture. */
  const combined = new Set<number>();
  const moves: PlannedMove[] = [];
  /** Armies that occupy each capture this turn (its finishing attack's survivors). */
  const survivorsAt = new Map<number, number>();

  // ---- income change (#70): the one computation nextIncome, R3 and the negative-bonus rules use ----
  const bonusTs = new Map(g.map.bonuses.map((b) => [b.id, bonusTerritories(g, b.id)]));
  /** The bonuses each territory is in (superbonuses through their members included). */
  const bonusesWith = new Map<number, number[]>();
  for (const [id, ts] of bonusTs) for (const t of ts) bonusesWith.set(t, [...(bonusesWith.get(t) ?? []), id]);
  /**
   * Bonuses complete over `after` that were not complete at the start of the turn, sorted by id.
   * Such a bonus has a territory in `after` that was not mine at the start, so only the bonuses of
   * those territories are looked at (every bonus on the map was, many times a plan: #172 review).
   */
  const completedBy = (after: ReadonlySet<number>): number[] => completedOver((t) => after.has(t), after);
  /**
   * {@link completedBy} over the territories `holds` says are held, given every one of them that
   * was not mine at the start (`fresh`; mine are skipped).
   */
  const completedOver = (holds: (t: number) => boolean, fresh: Iterable<number>): number[] => {
    const out = new Set<number>();
    for (const t of fresh) {
      if (mineSet.has(t)) continue;
      for (const id of bonusesWith.get(t) ?? []) if (!out.has(id) && bonusTs.get(id)!.every(holds)) out.add(id);
    }
    return [...out].sort(byNum);
  };
  const heldNow = () => new Set([...mine, ...captured]);
  /** The income change of also capturing `ts`, on top of this turn's captures so far. */
  const gainWith = (ts: readonly number[]): number => {
    const now = heldNow();
    return incomeGain(new Set([...now, ...ts])) - incomeGain(now);
  };
  /**
   * The per-territory income (#125; Extra Armies for Territories) that `k` more territories add to
   * what I hold now: floor(territories / per) over the base, at 1/per a territory once past it (a
   * fraction, so a capture that does not cross a multiple of `per` still counts its share). 0 off.
   */
  const territoryShare = (k: number): number => {
    const per = s.bonusArmyPer ?? 0;
    if (per <= 0 || k <= 0) return 0;
    const now = mine.length;
    const exact = (n: number) => Math.max(baseIncome, n / per);
    return Math.round((exact(now + k) - exact(now)) * 100) / 100;
  };
  /** Income a turn that capturing `_t` adds on its own (#125): its bonuses' and its per-territory share. */
  const plainWorth = (_t: number, gain: number): number => Math.max(gain, territoryShare(1));
  /** `t` is in a bonus the caller focused: the negative-bonus rules never refuse it. */
  const inFocus = (t: number) => [...focus].some((id) => bonusTs.get(id)?.includes(t));
  /** Every capture planned, in the order it was made (a rolled-back one may repeat; filter by `captured`). */
  const captureOrder: number[] = [];
  /** How to take back each capture's attacks (rule 4c's guard), by target. */
  const captureUndo = new Map<number, () => void>();
  /** Captures that stage a positive bonus under rule 4c(c), with the bonus they stage. */
  const staged = new Map<number, number>();
  /** Under No-Split, the order `x` already issues (its only one); otherwise always `undefined`. */
  const orderOf = (x: number): PlannedMove | undefined => (noSplit ? moves.find((m) => m.from === x) : undefined);
  const describeOrder = (m: PlannedMove) =>
    m.kind === 'attack' ? `attacks ${label(m.to)}` : `transfers to ${label(m.to)}`;
  /** A No-Split warning: `x` already issues an order, so `what` is not planned. Never repeated. */
  const warnSplit = (x: number, what: string) => {
    const w = `No-Split: ${label(x)} already ${describeOrder(orderOf(x)!)}, so ${what} (one attack or transfer per territory).`;
    if (!warnings.includes(w)) warnings.push(w);
  };
  const deploy = (id: number, n: number) => {
    if (n <= 0) return;
    deployed.set(id, (deployed.get(id) ?? 0) + n);
    avail.set(id, avail.get(id)! + n);
    budget -= n;
  };
  const undeploy = (id: number, n: number) => {
    const d = (deployed.get(id) ?? 0) - n;
    if (d > 0) deployed.set(id, d);
    else deployed.delete(id);
    avail.set(id, avail.get(id)! - n);
    budget += n;
  };

  // ---- Local Deployment pools ----
  const pools = s.localDeployments ? deployPools(g, mineSet, income) : null;
  const local = pools !== null && pools.bonuses.length > 0;
  /** Armies that may still be deployed on `id` (pools respected; with Local Deployment off, the budget). */
  const roomAt = (id: number): number => {
    if (!local || budget <= 0) return budget;
    const fits = (n: number) => {
      const next = new Map(deployed);
      next.set(id, (next.get(id) ?? 0) + n);
      return chargeDeploys(pools, next).anywhereUsed <= pools.anywhere;
    };
    let lo = 0;
    let hi = budget;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  /** Armies a capture may still deploy on `id`: its room, less the reserve. */
  const spareAt = (id: number) => Math.min(budget - reserve, roomAt(id));
  if (local) {
    rationale.push(
      `Local Deployment: ${pools.anywhere} of the ${income} income may be deployed anywhere; each held bonus's armies stay inside it.`,
    );
    for (const p of pools.bonuses)
      rationale.push(
        `Local Deployment: bonus ${p.name} (#${p.bonusId})'s +${p.value} may only be deployed on its territories (${p.territoryIds.map(label).join(', ')}).`,
      );
    if (pools.trimmed)
      warnings.push(
        `Local Deployment: the income of ${income} is less than the held bonuses are worth; ${pools.trimmed} pooled armies were dropped from the plan's pools.`,
      );
  }

  // ---- protected value ----
  // Judged against my holdings at the start of the turn until the capture passes
  // have run; then against those holdings plus this turn's captures (R2).
  let holdings: Set<number> = mineSet;
  /** #122: bonus `ts` is being built — its missing members all visible neutrals, finishing it economic (rule 4). */
  const building = (ts: readonly number[], value: number): boolean => {
    let cost = 0;
    let worst = 0;
    for (const x of ts) {
      if (holdings.has(x)) continue;
      const st = state.get(x);
      if (st?.owner.kind !== 'neutral' || st.armies === null) return false;
      const c = econCostAt(x);
      cost += c;
      worst = Math.max(worst, c);
    }
    return cost <= PAYBACK_TURNS * value && worst <= WASTELAND_FACTOR * value;
  };
  const protectedValue = (t: number): number => {
    // Each bonus is visited once, so it counts once however many of its borders are threatened.
    let v = 0;
    const mineWithout = (x: number) => x !== t && holdings.has(x);
    for (const b of g.map.bonuses) {
      const ts = bonusTerritories(g, b.id);
      if (!ts.includes(t)) continue;
      // #128: a negative bonus I hold in full that contains T is lifted when T falls.
      if (b.value < 0) {
        if (ts.every((x) => holdings.has(x))) v += b.value;
        continue;
      }
      if (b.value === 0) continue;
      if (ts.every((x) => holdings.has(x))) {
        v += b.value;
        continue;
      }
      // An incomplete bonus I am working on (T is in it): lost access if T is my only way in.
      const access = (has: (x: number) => boolean) =>
        ts.some((x) => has(x) || neighborsOf(g, x).some(has));
      if (!access(mineWithout)) {
        v += b.value;
        continue;
      }
      // #122: a member of a bonus I am building carries its share of the bonus — value × the
      // members I hold ÷ its size — so a second member is not worth +0 when the first (my only
      // foothold) was worth the whole bonus. Being built: every missing member is a visible
      // neutral, and finishing it passes rule 4's economy tests (a bonus behind an enemy, the
      // fog or a wasteland is not being built).
      if (building(ts, b.value)) {
        const held = ts.filter((x) => holdings.has(x) || x === t).length;
        v += Math.round(((b.value * held) / ts.length) * 10) / 10;
      }
    }
    // Per-territory income replaces the base only when larger, so losing T
    // costs an army only above it.
    const per = s.bonusArmyPer ?? 0;
    if (per > 0) v += territoryIncome(mine.length, baseIncome, per) - territoryIncome(mine.length - 1, baseIncome, per);
    // Floored at 0 only (#128): a negative bonus can outweigh the rest, never below nothing.
    return Math.max(0, v);
  };
  const valueCache = new Map<number, number>();
  const valueOf = (t: number) => {
    if (!valueCache.has(t)) valueCache.set(t, protectedValue(t));
    return valueCache.get(t)!;
  };

  // ---- 0. threat trend ----
  // Growth of each visible enemy territory next to me since the previous board
  // (visible both times, same owner, grown): its armies per turn of build-up.
  interface Growth {
    from: number;
    to: number;
    growth: number;
  }
  const growthOf = new Map<number, Growth>();
  if (input.previousBoard) {
    const before = new Map(input.previousBoard.territories.map((t) => [t.territoryId, t]));
    /** Same owner, shown with armies on both boards. */
    const heldBoth = (id: number, player: number) => {
      const a = visibleState(state.get(id));
      const b = visibleState(before.get(id));
      return a?.owner.kind === 'player' && a.owner.playerId === player && b?.owner.kind === 'player' && b.owner.playerId === player;
    };
    // #123: what each enemy territory visibly sent away (its shrink), claimed once (ascending ids)
    // by a growing neighbour of the same owner: that growth was a transfer, a one-off, not a trend.
    // The board cannot tell a fight from a transfer: a shrink beside another player's shrinking
    // stack is read as a fight and explains nothing.
    const shrinkLeft = new Map<number, number>();
    // A neighbour that shrank beside a shrinking stack of another player (me included) may have
    // lost a fight rather than sent armies (as `combatLosses` in the tracker reads it): it explains
    // no growth, so a deploy on the border beside it is still projected.
    const shrankBy = (id: number): { player: number; shrink: number } | null => {
      const a = visibleState(state.get(id));
      const b = visibleState(before.get(id));
      if (a?.owner.kind !== 'player' || b?.owner.kind !== 'player' || a.owner.playerId !== b.owner.playerId) return null;
      return { player: a.owner.playerId, shrink: b.armies! - a.armies! };
    };
    const fought = (id: number, player: number) =>
      neighborsOf(g, id).some((n) => {
        const o = shrankBy(n);
        return o !== null && o.player !== player && o.shrink > 0;
      });
    for (const [id, st] of state)
      if (st.owner.kind === 'player' && foe(st.owner.playerId) && heldBoth(id, st.owner.playerId) && !fought(id, st.owner.playerId))
        shrinkLeft.set(id, Math.max(0, visibleState(before.get(id))!.armies! - st.armies!));
    for (const [id, st] of [...state].sort((a, b) => a[0] - b[0])) {
      if (st.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) continue;
      if (!neighborsOf(g, id).some((n) => mineSet.has(n))) continue;
      // Visible both times (#69): a stack hidden last turn only came into view.
      const was = visibleState(before.get(id));
      if (was?.owner.kind !== 'player' || was.owner.playerId !== st.owner.playerId || was.armies === null) continue;
      let growth = st.armies - was.armies;
      if (growth <= 0) continue;
      for (const n of [...neighborsOf(g, id)].sort((a, b) => a - b)) {
        const left = shrinkLeft.get(n);
        if (!left || growth <= 0 || !heldBoth(n, st.owner.playerId)) continue;
        const take = Math.min(left, growth);
        shrinkLeft.set(n, left - take);
        growth -= take;
      }
      // Projected growth never beats what it could have deployed, every ambiguous army read as
      // deploy (#123, `high`): a stack that walked in beside the fog is massing all the same
      // (lesson 5), but growth no deploy or fog arrival explains is not projected.
      const observedHigh = estimates.get(st.owner.playerId)?.observation?.high;
      if (observedHigh !== undefined) growth = Math.min(growth, observedHigh);
      if (growth > 0) growthOf.set(id, { from: was.armies, to: st.armies, growth });
    }
  }
  /**
   * Local Deployment (#128): each opponent's bonuses it visibly holds in full, as deploy pools that
   * land only on their own territories. Empty without Local Deployment or under the override.
   */
  /** Each opponent's team, in a team game (#128): opponents on one team attack together. */
  const teamOf = new Map<number, number>();
  for (const p of ctx.players ?? []) if (carriesTeam(p.team) && foe(p.id)) teamOf.set(p.id, p.team);
  const enemyPools = new Map<number, { value: number; members: ReadonlySet<number> }[]>();
  if (s.localDeployments && !custom) {
    const ownerAt = (t: number) => {
      const o = ownerShown(state.get(t))?.owner;
      return o?.kind === 'player' ? o.playerId : undefined;
    };
    for (const b of g.map.bonuses) {
      if (b.value <= 0) continue;
      const ts = bonusTerritories(g, b.id);
      const p = ts.length ? ownerAt(ts[0]!) : undefined;
      if (p === undefined || !foe(p) || !ts.every((t) => ownerAt(t) === p)) continue;
      enemyPools.set(p, [...(enemyPools.get(p) ?? []), { value: b.value, members: new Set(ts) }]);
    }
  }
  /**
   * What `player` may deploy on any of `on` (#128): its whole estimate, except under Local
   * Deployment, where a bonus it visibly holds pays only into that bonus's territories — the
   * estimate less the visible pools it counts (unseen income counts as deployable anywhere) plus
   * the pools that contain one of `on`, never above the estimate. The estimate may leave pools
   * out (the opening board's floor; a negative bonus lowering its bonus income), so only what
   * it holds above its free floor — max({@link MIN_ENEMY_DEPLOY}, base income) — is taken as
   * pooled: the free base always lands anywhere.
   */
  const deployReaching = (player: number, on: readonly number[]): number => {
    const all = deployOf(player);
    const pools = enemyPools.get(player);
    if (!pools?.length) return all;
    const pooled = pools.reduce((n, q) => n + q.value, 0);
    const here = pools.reduce((n, q) => n + (on.some((t) => q.members.has(t)) ? q.value : 0), 0);
    const free = Math.min(all, Math.max(MIN_ENEMY_DEPLOY, estimates.get(player)?.base ?? 0));
    return Math.min(all, Math.max(free, all - pooled) + here);
  };
  /**
   * #120: what the owner of enemy territory `t` may add there before my attack lands — its deploy
   * estimate (under Local Deployment, what reaches `t`), or its growth there per turn when larger
   * (rule 1t). 0 for a territory no opponent holds.
   */
  const reinforcementAt = (t: number): number => {
    const st = state.get(t);
    if (st?.owner.kind !== 'player' || !foe(st.owner.playerId)) return 0;
    return Math.max(deployReaching(st.owner.playerId, [t]), growthOf.get(t)?.growth ?? 0);
  };
  /** Fewest armies on a territory that hold against `threat` attackers. */
  const holdArmies = (threat: number) => {
    let a = 0;
    while ((toTake(a) ?? Infinity) <= threat) a++;
    return a;
  };
  /** The most defenders one attack of `attackers` takes ({@link toTake}); -1 when it takes none. */
  const reachMemo = new Map<number, number>();
  const takesAlone = (attackers: number): number => {
    if (!reachMemo.has(attackers)) reachMemo.set(attackers, holdArmies(attackers) - 1);
    return reachMemo.get(attackers)!;
  };
  /**
   * The armies a softening attack of `n` kills, in a separate-attack threat: the luck-free share,
   * rounded straight (S2) — deliberately not the game's luck and rounding. Under luck,
   * {@link guaranteedKills} is the fewest kills luck allows, which would understate a threat
   * whose last attack ({@link toTake}) is sized pessimistically for me; the luck-free share is
   * what the softener kills on average, under either rounding.
   */
  const killsOf = (n: number) => guaranteedKills(n, rates.offensiveKillRate, 0, 'StraightRound');
  interface Force {
    player: number;
    /** That player's movable armies (and units) next to the territory. */
    movable: number;
    /** That player's fastest-growing stack next to it (0 without a trend, or not projected). */
    growth: number;
    /** What that player may deploy there (its estimate; under Local Deployment what reaches it). */
    deploy: number;
    /**
     * The attack that takes as much as the force can (#128): the larger of that player's movable
     * plus max(deploy, growth) as one attack, and the single attack equivalent to several
     * separate attacks (each stack its own, and with `allPlayers`, every opponent's too).
     */
    threat: number;
    /** When separate attacks beat one: what they are, for the rationale. */
    split?: { attacks: number[]; takes: number; players: number[] };
  }
  /**
   * The enemy force that can hit my `t` next turn (#128). Per opponent: each of its stacks next
   * to `t` (territories in `gone` excluded) is movable armies plus its units, and it may deploy
   * {@link deployReaching} there — onto one stack — plus, with `trend`, its fastest growth when
   * larger. One attack of all of it is the old model (a transfer then an attack); separate attacks
   * each round on their own, so a 1-army softener kills 1 at 60% and the last attack takes the
   * rest: the force reaches max over the last attack L of Σ kills(others) + reach(L). With
   * `allPlayers`, every opponent next to `t` may attack it in the same turn (worst case); else
   * each opponent alone. `player` is the strongest one alone. `null` with no opponent next to it.
   */
  const forceAt = (
    t: number,
    gone: (n: number) => boolean,
    o: { trend: boolean; allPlayers: boolean; pileOn?: boolean },
  ): Force | null => {
    const byPlayer = new Map<number, { stacks: { id: number; movable: number }[]; growth: number }>();
    for (const n of [...neighborsOf(g, t)].sort(byNum)) {
      const st = state.get(n);
      if (gone(n) || st?.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) continue;
      const p = byPlayer.get(st.owner.playerId) ?? { stacks: [], growth: 0 };
      // An enemy commander can join the attack: it fights as COMMANDER_STRENGTH armies.
      p.stacks.push({ id: n, movable: Math.max(0, st.armies - guard) + unitsAt(n) });
      if (o.trend) p.growth = Math.max(p.growth, growthOf.get(n)?.growth ?? 0);
      byPlayer.set(st.owner.playerId, p);
    }
    if (!byPlayer.size) return null;
    const each = [...byPlayer]
      .sort((a, b) => a[0] - b[0])
      .map(([player, p]) => {
        const deploy = deployReaching(player, p.stacks.map((x) => x.id));
        const movable = p.stacks.reduce((n, x) => n + x.movable, 0);
        const add = Math.max(deploy, p.growth);
        return { player, stacks: p.stacks, growth: p.growth, deploy, movable, add, single: movable + add };
      });
    const best = [...each].sort((a, b) => b.single - a.single || a.player - b.player)[0]!;
    // Separate attacks: try each stack as the last attack, its owner's deploy on it; every other
    // opponent in the group lands its deploy on its own largest stack.
    let split: Force['split'];
    let splitTakes = -1;
    // Opponents on one team coordinate; players of an FFA each attack alone (two of them landing
    // on one border in the same turn is a warning, {@link pileOnAt}, not a hold).
    const groups: (typeof each)[] = [];
    for (const e of each) {
      const team = o.allPlayers ? teamOf.get(e.player) : undefined;
      const mates = team === undefined ? undefined : groups.find((gr) => teamOf.get(gr[0]!.player) === team);
      if (mates) mates.push(e);
      else groups.push([e]);
    }
    if (o.pileOn) groups.splice(0, groups.length, each);
    for (const group of groups) {
      const count = group.reduce((n, e) => n + e.stacks.length, 0);
      if (count < 2) continue;
      for (const last of group)
        for (const L of last.stacks) {
          const attacks: number[] = [];
          for (const e of group) {
            const big = [...e.stacks].sort((a, b) => b.movable - a.movable || a.id - b.id)[0]!;
            const on = e === last ? L : big;
            for (const x of e.stacks) if (x !== L) attacks.push(x.movable + (x === on ? e.add : 0));
          }
          const lastArmies = L.movable + last.add;
          const softeners = attacks.filter((a) => a > 0);
          const takes = softeners.reduce((n, a) => n + killsOf(a), 0) + takesAlone(lastArmies);
          if (takes > splitTakes) {
            splitTakes = takes;
            split = { attacks: [...softeners, lastArmies], takes, players: group.map((e) => e.player) };
          }
        }
    }
    let threat = best.single;
    if (split && split.takes > takesAlone(best.single)) threat = Math.max(threat, toTake(split.takes) ?? threat);
    else split = undefined;
    return { player: best.player, movable: best.movable, growth: best.growth, deploy: best.deploy, threat, ...(split ? { split } : {}) };
  };
  /**
   * The strongest visible enemy force that could hit `t` next turn ({@link forceAt}, every
   * opponent next to it, trend included). `null` with no enemy next to it.
   */
  const threatAt = (t: number, gone: (n: number) => boolean): { player: number; threat: number } | null => {
    const f = forceAt(t, gone, { trend: true, allPlayers: true });
    return f ? { player: f.player, threat: f.threat } : null;
  };
  /**
   * The expected (not worst-case) attack on my `t` next turn (issue #59): per player, its
   * movable armies (and units, #128) next to `t` plus its deploy estimate — no trend projection,
   * one opponent at a time, its stacks attacking separately when that takes more. 0 with none.
   */
  const expectedAt = (t: number): number =>
    forceAt(t, (n) => captured.has(n), { trend: false, allPlayers: false })?.threat ?? 0;
  interface Exposure {
    id: number;
    player: number;
    /** Armies the enemy needs to take it. */
    take: number;
    /** Deploys it still needs next turn to hold. */
    need: number;
  }
  /** Members of a bonus I would hold that a visible enemy could take next turn, given the armies staying on each. */
  const exposure = (members: readonly number[], gone: (n: number) => boolean, stays: (m: number) => number): Exposure[] => {
    const out: Exposure[] = [];
    for (const m of members) {
      const th = threatAt(m, gone);
      if (!th) continue;
      // My commander defends with the armies on my territory (a capture's units were the enemy's).
      const have = stays(m) + (mineSet.has(m) ? unitsAt(m) : 0);
      const take = toTake(have);
      if (take === null || take > th.threat) continue;
      out.push({ id: m, player: th.player, take, need: holdArmies(th.threat) - have });
    }
    return out;
  };

  // ---- 1. defence ----
  /** A border's threat ({@link forceAt}): the strongest player's force, separate attacks included. */
  interface Border extends Force {
    id: number;
  }
  const borders = new Map<number, Border>();
  /** Every visible enemy player with a stack next to one of my territories. */
  const facing = new Set<number>();
  /** The strongest visible enemy threat to my `t` (territories in `gone` excluded), or `null` with none next to it. */
  const borderAt = (t: number, gone: (n: number) => boolean): Border | null => {
    const f = forceAt(t, gone, { trend: true, allPlayers: true });
    return f ? { id: t, ...f } : null;
  };
  for (const t of mine) {
    for (const n of neighborsOf(g, t)) {
      const st = state.get(n);
      if (st?.owner.kind === 'player' && foe(st.owner.playerId) && st.armies !== null) facing.add(st.owner.playerId);
    }
    const b = borderAt(t, () => false);
    if (b) borders.set(t, b);
  }
  // #128: an enemy unit the board gives no strength for is in no threat: say so.
  for (const e of [...state.keys()].sort(byNum)) {
    const st = state.get(e)!;
    if (st.owner.kind !== 'player' || !foe(st.owner.playerId) || !uncounted(e)) continue;
    const next = neighborsOf(g, e).filter((n) => mineSet.has(n));
    if (next.length)
      warnings.push(
        `${label(e)} (player ${st.owner.playerId}) holds ${uncountedKind(e)}, whose strength the board does not carry: the threat to ${next.map(label).join(', ')} counts its armies only.`,
      );
  }
  /**
   * Borders that hold at the start of the turn on the armies they have (#121): their surplus is
   * what they hold beyond that, and a capture from one keeps what holds it.
   */
  const safeAtStart = new Set(
    [...borders.values()]
      .filter((b) => (toTake(armiesOf(b.id) + unitsAt(b.id)) ?? Infinity) > b.threat)
      .map((b) => b.id),
  );
  for (const [e, gr] of growthOf) {
    // Name the most exposed of my territories next to it (fewest armies, then id).
    const t = neighborsOf(g, e)
      .filter((n) => mineSet.has(n))
      .sort((a, b) => armiesOf(a) - armiesOf(b) || a - b)[0]!;
    const b = borders.get(t)!;
    const next = b.movable + Math.max(b.deploy, b.growth);
    const after = b.movable + b.growth + Math.max(b.deploy, b.growth);
    warnings.push(
      `${label(e)} is building: +${gr.growth}/turn (${gr.from} → ${gr.to}); at this rate ${label(t)} needs ${holdArmies(next)} to hold next turn and ${holdArmies(after)} the turn after`,
    );
  }
  for (const b of borders.values())
    if (b.growth > b.deploy)
      rationale.push(
        `Threat on ${label(b.id)} uses the trend: player ${b.player}'s stack next to it grows +${b.growth}/turn, more than the ~${b.deploy} deploy estimate, so ~${b.threat}.`,
      );
  if (borders.size) {
    if (custom)
      warnings.push(
        `Enemy deploy estimate: threat checks assume ~${enemyDeploy} (your estimate); enemy income is unknown, so they could deploy more.`,
      );
    else {
      const opening = openingArmies(g, board, { turn: turnNow, previous: input.previousBoard });
      for (const p of [...facing].sort(byNum)) {
        const e = estimates.get(p)!;
        const visible = `base ${e.base} + visible bonuses +${e.bonusIncome} = ${e.base + e.bonusIncome}`;
        if (e.observation) {
          const o = e.observation;
          const turns = input.turn !== undefined ? `turn ${input.turn - 1} → turn ${input.turn}` : 'previous board → this board';
          const shown = o.reveals.slice(0, MAX_NAMED_REVEALS).map(label).join(', ');
          const more = o.reveals.length > MAX_NAMED_REVEALS ? ` and ${o.reveals.length - MAX_NAMED_REVEALS} more` : '';
          rationale.push(
            `Observed deploy for player ${p}, ${turns}: +${e.observedRaw}/turn over ${o.counted.length} territories visible on both boards (${o.captured.length} captured${o.captured.length ? `, ${o.fromFog.length} from the fog` : ''}); ${o.reveals.length} skipped as fog reveals${o.reveals.length ? ` (${shown}${more}): not shown with an owner and armies last turn (fogged, armies hidden, or not yet picked), so what they hold is not income` : ''}.`,
          );
          // A stack that arrived from the fog by a capture is a threat, never income (#86).
          for (const id of o.fromFog) {
            const where = neighborsOf(g, id).some((n) => mineSet.has(n)) ? 'stack next to you' : 'stack';
            rationale.push(
              `Player ${p}'s ${where}: ${armiesOf(id)} on ${label(id)} (threat), arrived from the fog by a capture: a move, not income.`,
            );
          }
          // #123: the ambiguous readings, each named with the other way it could read.
          if (o.grewFromFog.length) {
            rationale.push(
              `Player ${p}: ${o.fogGrowth} of its growth on ${o.grewFromFog.map(label).join(', ')} (beyond twice the ~${o.expected} it was expected to deploy) is next to the fog: read as a move out of the fog, not income — though it may be income the fog hides (observed +${o.low}–${o.high} either way).`,
            );
          }
          if (o.reinforced.length)
            rationale.push(
              `Player ${p} took ${o.reinforced.map(label).join(', ')} with more than its visible stack next to ${o.reinforced.length === 1 ? 'it' : 'them'} sent: read as armies deployed on that stack before it attacked (deploy-then-capture), though a stack out of the fog may have joined (observed +${o.low}–${o.high} either way).`,
            );
          if (o.emptied.length)
            rationale.push(
              `Player ${p} took ${o.emptied.map(label).join(', ')} from you: priced at what the guard you may have left there kills, not your stack last turn (you may have attacked out of it); had it all stood there, it deployed +${o.high}.`,
            );
          if (o.fromFog.length) {
            const n = o.fromFog.length;
            rationale.push(
              `Player ${p}'s estimated income: ~${e.estimate}/turn (${n} ${n === 1 ? 'stack' : 'stacks'} that arrived from the fog not counted in it).`,
            );
          }
          if (e.observedRaw! > e.observedCap!)
            warnings.push(
              `player ${p} was observed to deploy +${e.observedRaw}/turn, more than it could earn on this board (base ${e.base} for its ${e.held} visible territories + bonuses it could still hold +${e.observedCap! - e.base} = ${e.observedCap}): capped at ${e.observedCap}. Armies moved in from the fog, a Reinforcement card, or a bonus it has lost since may explain the rest.`,
            );
        }
        if (e.tracked !== null) {
          const track = input.tracks!.find((t) => t.playerId === p)!;
          const used = track.turns.filter((x) => e.trackedTurns.includes(x.from));
          rationale.push(
            `Tracked income for player ${p}: ~${e.tracked}/turn (${incomeBasis(track)}): ${used.map((x) => `turn ${x.from} +${x.observed}`).join(', ')}, each observed deploy a lower bound under fog; at least its visible base + bonuses ${track.visibleIncome}; used in place of the single-turn observed figure (warapp_track_opponents has the details).`,
          );
        }
        if (e.source === 'prior') {
          warnings.push(
            `Enemy deploy estimate for player ${p}: ~${e.estimate} (a prior, not an observation: ${
              (incomePrior!.opening?.get(p) ?? -1) > incomePrior!.myIncome
                ? `its opening simulated from the starts the award of picks proved earns ${incomePrior!.opening!.get(p)} this turn`
                : `in a 1v1 that started even, an opponent bordering the fog is assumed to earn at least my own income ${incomePrior!.myIncome}`
            }, capped at the most it could earn on this board, ${e.couldEarn}; ${visible}${e.tracked !== null ? `, tracked ~${e.tracked}` : e.observed !== null ? `, observed +${e.observed}/turn` : ''}); observed deploys are lower bounds under fog, and it could deploy more.`,
          );
          continue;
        }
        if (e.source === 'tracked') {
          warnings.push(
            `Enemy deploy estimate for player ${p}: ~${e.estimate} (tracked over ${e.trackedTurns.length} observed turns, more than ${visible}); it holds income the fog hides, and could deploy more.`,
          );
          continue;
        }
        if (e.source === 'observed') {
          warnings.push(
            `Enemy deploy estimate for player ${p}: ~${e.estimate} (observed +${e.observed}/turn: the net growth of its territories visible on both boards plus what its captures from a visible owner cost it, more than ${visible}); it holds income the fog hides, and could deploy more.`,
          );
          continue;
        }
        const seen = e.observed !== null ? ` Its deploy was observed +${e.observed}/turn since last turn, below that.` : '';
        warnings.push(
          (opening !== null
            ? `Enemy deploy estimate for player ${p}: ~${e.estimate} (opening board: every visible player territory holds ${opening}, so no one has deployed yet and every opponent gets its base income, at least ${MIN_ENEMY_DEPLOY}); enemy income is unknown, so they could deploy more.`
            : `Enemy deploy estimate for player ${p}: ~${e.estimate} (${visible}, at least max(${MIN_ENEMY_DEPLOY}, base); its largest stack next to me (${e.largestStack}) is what can move, not a limit on what it deploys); enemy income beyond its visible bonuses is unknown, so they could deploy more.`) + seen,
        );
      }
    }
  }

  interface Threatened {
    id: number;
    have: number;
    threat: number;
    holdCost: number;
    value: number;
    /** Protected value plus the armies a hold saves, in income terms (armies / PAYBACK_TURNS). */
    worth: number;
    /** A weak opponent that held it last turn and threatens it now: it is never conceded economically. */
    recentFrom?: number;
    /** The armies my special units there fight as (my commander: {@link COMMANDER_STRENGTH}); they never move. */
    units: number;
    /** My commander stands here: must-hold (rule 1k), never conceded. */
    critical?: true;
    /**
     * Deploys already given toward its hold (#118: rule 1h's floor tier, then the shared-deploy
     * split); `have` includes them and `holdCost` is what is still needed.
     */
    given?: number;
  }
  const threatened: Threatened[] = [];
  /**
   * Rule 1a's economic test: its hold costs more than CONCEDE_FACTOR × its worth. Never for a
   * border just taken from a weak opponent, nor (#122) in the opening when the hold costs no more
   * than the armies already there — a start is the whole position then, and the top-up saves at
   * least as many as it spends (live, three starts around an enemy start were each stripped for
   * want of 2 armies, and neutrals attacked out of each).
   */
  const uneconomic = (t: Threatened) =>
    t.recentFrom === undefined &&
    t.holdCost > CONCEDE_FACTOR * t.worth &&
    !(profile.phase === 'opening' && t.holdCost <= t.have);
  /** Armies that stay on my `id` after this turn's deploys, outgoing moves and incoming withdrawals so far. */
  const stayAt = (id: number) => avail.get(id)! + guard + (incoming.get(id) ?? 0);
  /**
   * Armies (in `avail` terms) that must stay on my `x` for it to hold against the visible
   * threat next to it (its special units counted; the territories `gone` says fall this turn
   * left out: once taken they threaten nothing); 0 with no enemy next to it. When it cannot
   * hold on what it has: everything on my commander's territory (rule 1k: nothing leaves it),
   * else everything only if `room` deploys would make it hold, and nothing otherwise (triage
   * would concede it, so keeping its armies home saves nothing).
   */
  const keepFor = (x: number, gone: (n: number) => boolean, room = Infinity) => {
    const a = avail.get(x)!;
    const covering = Math.max(0, Math.min(a, coverKeep.get(x) ?? 0));
    const b = borderAt(x, (n) => captured.has(n) || gone(n));
    if (!b) return covering;
    const need = Math.max(0, holdArmies(b.threat) - unitsAt(x));
    const short = need - stayAt(x);
    if (short > room && !myCommanders.has(x)) return covering;
    return Math.max(covering, a - Math.max(0, Math.min(a, -short)));
  };
  // ---- #172: two steps away ----
  /**
   * What my `t` protects against a stack two steps away: the bonuses I hold in full that contain
   * it (net of negative ones, floored at 0) — and, with my commander there, everything. A
   * territory protecting nothing is never held against a reach (its armies serve the front).
   */
  const heldBonusValueMemo = new Map<number, number>();
  const heldBonusValue = (t: number): number => {
    let v = heldBonusValueMemo.get(t);
    if (v === undefined) {
      v = 0;
      for (const id of bonusesWith.get(t) ?? []) if (bonusTs.get(id)!.every((x) => heldAtStart.has(x))) v += g.bonusById.get(id)!.value;
      heldBonusValueMemo.set(t, (v = Math.max(0, v)));
    }
    return v;
  };
  const guardsTwoStep = (t: number) => myCommanders.has(t) || heldBonusValue(t) > 0;
  /**
   * Every two-step reach to a territory of mine worth guarding (lookahead.ts, as check_plan), by
   * territory: found once per {@link planTurn} (it depends only on the start board) and shared by
   * its passes, each of which filters it by its own plan ({@link twoStepHold}).
   */
  /**
   * Territories whose two-step hold an order cited (see {@link twoStepCite}), with the hold it
   * met: each is stated once, at the end, with the stay the plan ends on.
   */
  const twoStepCited = new Map<number, TwoStepHoldAt>();
  /**
   * Armies rule 6 moves into each territory of mine (staging and idle interior transfers), which
   * {@link stayAt}'s `incoming` leaves out: they end the plan there, so a two-step hold counts them.
   */
  const arrived = new Map<number, number>();
  /** {@link stayAt} with rule 6's arrivals: what stays on my `t` once every order has run. */
  const finalStayAt = (t: number) => stayAt(t) + (arrived.get(t) ?? 0);
  /**
   * Territories whose two-step hold kept back armies some order could otherwise have used (an
   * attack's size, a softener, a finisher, a top-up): each is explained at the end, unless an
   * order already said so.
   */
  const twoStepBound = new Set<number>();
  const twoStepAt = (t: number): readonly TwoStepReach[] => {
    if (!pass.shared.reaches) {
      const byTerritory = new Map<number, TwoStepReach[]>();
      const teams = new Map<number, number>();
      for (const p of ctx.players ?? []) if (carriesTeam(p.team)) teams.set(p.id, p.team);
      const opponents = [
        ...new Set(board.territories.flatMap((x) => (x.owner.kind === 'player' && foe(x.owner.playerId) && x.armies !== null ? [x.owner.playerId] : []))),
      ]
        .sort(byNum)
        .map((id) => ({ id, deploy: deployOf(id) }));
      const reaches = twoStepReaches({
        graph: g,
        board,
        me,
        opponents,
        settings: {
          ...(s.offensiveKillRate !== undefined ? { offensiveKillRate: s.offensiveKillRate } : {}),
          ...(s.defensiveKillRate !== undefined ? { defensiveKillRate: s.defensiveKillRate } : {}),
          ...(s.luckModifier !== undefined ? { luckModifier: s.luckModifier } : {}),
          ...(s.roundingMode !== undefined ? { roundingMode: s.roundingMode } : {}),
          ...(s.oneArmyStandsGuard !== undefined ? { oneArmyStandsGuard: s.oneArmyStandsGuard } : {}),
          ...(s.multiAttack !== undefined ? { multiAttack: s.multiAttack } : {}),
        },
        ...(teams.size ? { teams } : {}),
        ...(opts.movesFirst !== undefined ? { firstMover: opts.movesFirst ? ('me' as const) : ('opponent' as const) } : {}),
        only: guardsTwoStep,
      });
      for (const r of reaches) byTerritory.set(r.territory, [...(byTerritory.get(r.territory) ?? []), r]);
      pass.shared.reaches = byTerritory;
    }
    return pass.shared.reaches.get(t) ?? [];
  };
  /**
   * #172: the armies that stay on my `t` (in {@link stayAt} terms) to hold against the strongest
   * stack that can reach it next turn by taking the territory in between this turn, and that
   * reach; `null` when none binds. A reach through, or from, a territory this turn takes (or
   * `gone` says falls) is cut, and so is one through a territory of mine the plan does not concede
   * (its own one-step hold covers it), and so is one it cannot hold even with next turn's whole
   * income deployed there. One-step holds are separate: callers take the larger, never both.
   */
  /**
   * Whether my `v`, in between a reach and its target, is held — kept and holding its own border —
   * as the plan's end decides it (see {@link settledPass}): learned from an earlier pass, else
   * judged by the concession so far and checked at the end.
   */
  const viaHeld = (v: number): boolean => {
    const d = pass.viaNever ? false : (pass.viaHeld.get(v) ?? !conceded.has(v));
    const seen = pass.viaSeen.get(v);
    if (seen !== undefined && seen !== d) pass.viaMixed = true;
    pass.viaSeen.set(v, d);
    return d;
  };
  const twoStepHold = (t: number, gone: (n: number) => boolean = () => false, final = false): TwoStepHoldAt | null => {
    if (!mineSet.has(t) || conceded.has(t) || !guardsTwoStep(t)) return null;
    let best: TwoStepHoldAt | null = null;
    for (const r of twoStepAt(t)) {
      if (captured.has(r.via) || captured.has(r.from) || gone(r.via) || gone(r.from)) continue;
      // Taken by an order of this plan that lands later (planTurn's refining passes).
      if (pass.cut.has(r.via) || pass.cut.has(r.from)) continue;
      // Through a territory of mine the plan holds: that is its border's one-step hold, not this.
      if (mineSet.has(r.via) && viaHeld(r.via)) continue;
      // Measured as a one-step hold is (holdArmies: under luck or weighted-random rounding, it
      // falls at most HOLD_FALL_CHANCE of the time), never below check_plan's luck-free `needs`.
      const needs = Math.max(r.needs, holdArmies(r.power));
      const stay = Math.max(0, needs - unitsAt(t));
      // Hopeless — not even what is there now and what next turn can deploy there make it hold:
      // keeping its armies home saves nothing (as {@link keepFor} judges a one-step hold). Judged
      // by `t`'s own stay: rule 6's arrivals do not make a hold worth keeping `t`'s armies for
      // (they already cover it, and counting them would make the decision depend on whether the
      // transfer in runs before `t`'s own order). Only the end of the plan (`final`), deciding
      // whether a hold an order cited still applies, counts them.
      if ((final ? finalStayAt(t) : stayAt(t)) + nextRoomAt(t) < stay) continue;
      if (!best || stay > best.stay) best = { stay, needs, reach: r };
    }
    if (!best || best.stay <= 0) return null;
    pass.used = true;
    return best;
  };
  /**
   * What next turn could deploy on my `t`, card armies aside: the whole income, or under Local
   * Deployment only what may land there — the pools of the bonuses holding it and the free rest.
   */
  const nextRoomAt = (t: number): number => {
    const whole = Math.max(0, income - cardArmies);
    if (!local) return whole;
    const own = pools.bonuses.filter((b) => b.territoryIds.includes(t)).reduce((n, b) => n + b.value, 0);
    return Math.min(whole, Math.max(0, pools.anywhere - cardArmies) + own);
  };
  /** {@link twoStepHold} in `avail` terms: what of `t`'s movable armies stays (0 with none). */
  const twoStepKeep = (t: number, gone?: (n: number) => boolean): number => {
    const h = twoStepHold(t, gone);
    if (!h) return 0;
    const a = avail.get(t)!;
    return a - Math.max(0, Math.min(a, stayAt(t) - h.stay));
  };
  /**
   * An order that keeps `t`'s two-step hold (#172) names it, without numbers: the hold is stated
   * once, at the end ({@link twoStepNote}), with the stay the plan ends on — a stay read mid-plan
   * disagrees with the orders after it. `clause` renders the rationale text that names it; the
   * text is marked, so the end of the plan keeps it only if the hold still applies then (a later
   * capture or a smaller stay can end it), and puts `fallback` in its place otherwise (by default
   * nothing; a line that is only the citation falls back to a plain account of what it kept).
   */
  const twoStepCite = (t: number, h: TwoStepHoldAt, clause: (cite: string) => string, fallback = '') => {
    twoStepCited.set(t, h);
    return `${CITE_OPEN}${t}${CITE_SEP}${clause('its hold against a stack two steps away')}${CITE_SEP}${fallback}${CITE_CLOSE}`;
  };
  /**
   * The rationale clause for a two-step hold (#172), at the end of the plan: the armies the plan
   * ends with there (rule 6's arrivals included), its special units named, since they count toward
   * what it needs. A hold kept short of that (kept because next turn's deploy can make up the rest)
   * says how many more to bring.
   */
  const twoStepNote = (t: number, h: TwoStepHoldAt) => {
    const r = h.reach;
    const kept = finalStayAt(t);
    const units = unitsAt(t);
    const short = h.needs - units - kept;
    return `kept ${kept} on ${label(t)}${units ? ` (with its special units, worth ${units})` : ''}: player ${r.opponent} can reach it next turn from ${label(r.from)} via ${label(r.via)} (~${r.attackers} attacking; it needs ${h.needs} to hold${short > 0 ? `; bring ${short} more next turn` : ''})`;
  };
  /**
   * Fill `threatened` from `borders`, judging each by the armies that stay on it (its
   * armies at the start of the turn unless a finishing-off attack already left).
   */
  /** Rule 1a's pre-deploy threat warning per border, restated once the deploys are known. */
  const threatWarnings = new Map<number, { text: string; threat: number }>();
  const assessThreats = () => {
    for (const b of borders.values()) {
      const have = stayAt(b.id);
      const units = unitsAt(b.id);
      const take = toTake(have + units);
      if (take === null || take > b.threat) continue;
      const text = `${label(b.id)} (${have} armies${units ? ' and my commander' : ''}) could be taken next turn: player ${b.player} has ${b.movable} movable armies next to it plus ~${b.growth > b.deploy ? `${b.growth} (its growth per turn)` : `${b.deploy} deploy`}, and ${take} would do${b.split ? ` — sent as separate attacks (${b.split.attacks.join(' then ')}), its stacks take up to ${b.split.takes}` : ''}.`;
      threatWarnings.set(b.id, { text, threat: b.threat });
      warnings.push(text);
      // armiesToTake grows at least one army per ~(100 / offensive kill rate) defenders, so this ends.
      let d = 1;
      while ((toTake(have + units + d) ?? Infinity) <= b.threat) d++;
      const value = valueOf(b.id);
      const from = recentlyTakenFrom(b.id);
      threatened.push({
        id: b.id,
        have,
        threat: b.threat,
        holdCost: d,
        value,
        worth: value + have / PAYBACK_TURNS,
        ...(from !== undefined && from === b.player ? { recentFrom: from } : {}),
        units,
        ...(myCommanders.has(b.id) ? { critical: true as const } : {}),
      });
    }
    threatened.sort(
      (a, b) =>
        Number(b.critical === true) - Number(a.critical === true) ||
        Number(b.recentFrom !== undefined) - Number(a.recentFrom !== undefined) ||
        b.worth / b.holdCost - a.worth / a.holdCost ||
        a.holdCost - b.holdCost ||
        a.id - b.id,
    );
  };

  const acting = goal === 'defend';
  const conceded = new Set<number>();
  const concedeUnaffordable = (t: Threatened, left: number) => {
    conceded.add(t.id);
    warnings.push(
      `${label(t.id)} cannot be held with the ${left} armies left to deploy (needs ${t.holdCost}, protects +${t.value}): conceded`,
    );
  };
  /** Said only once its hold is actually deployed. */
  const noteRecent = (t: Threatened) => {
    if (t.recentFrom !== undefined)
      rationale.push(
        `${label(t.id)} was captured from player ${t.recentFrom} last turn, and that opponent is weak: it is not conceded economically (conceding hands it back for free).`,
      );
  };
  /** What stays on a held border, for the rationale: its armies, and my commander when it stands there. */
  const heldStack = (t: Threatened) => `${t.have + t.holdCost} armies${t.units ? ' and my commander' : ''}`;
  /** The borders a hold deployed to, by the player threatening them (for the #69 rationale). */
  const heldAgainst = new Map<number, Set<number>>();
  const hold = (t: Threatened) => {
    noteRecent(t);
    deploy(t.id, t.holdCost);
    locked.add(t.id);
    const by = borders.get(t.id)?.player;
    if (by !== undefined) heldAgainst.set(by, (heldAgainst.get(by) ?? new Set()).add(t.id));
    rationale.push(
      `Deploy ${t.holdCost + (t.given ?? 0)} to ${label(t.id)} so it holds (protects +${t.value}): ${heldStack(t)} need ${toTake(t.have + t.units + t.holdCost)} to take, above the ~${t.threat} threat.`,
    );
  };
  // ---- 1h. held-bonus units (#51) ----
  // Every bonus I hold in full with a threatened border is one unit: all its threatened
  // borders are held, or none (holding some while conceding another breaks it anyway).
  interface Unit {
    bonusId: number;
    value: number;
    members: Threatened[];
    /** Sum of its members' hold costs (a border shared with another unit counted in both). */
    cost: number;
    /** Local Deployment (#103): its own pool, deployable nowhere else (0 with the flag off). */
    pool: number;
    /** What holding it costs beyond its own pool, judged against its worth: max(0, cost − pool). */
    net: number;
    /** Its value plus the armies its holds save, in income terms. */
    worth: number;
    /** Why it does not pay for itself, if it does not (see {@link UnitLoss}). */
    loss: 'payback' | 'factor' | null;
    conceded: boolean;
    /** Rule 1h's floor tier (#118): every threatened border beats the armies already next to it. */
    floored: boolean;
    /**
     * Not held in full and not conceded (#118): floored, then upgraded to a whole hold or given
     * a share of what is left against the one deploy its opponent has ({@link settleContested}).
     */
    contested: boolean;
  }
  const units: Unit[] = [];
  // #128: what the plan can count on excludes the borders it concedes, and those of a held bonus
  // it has not decided to hold whole yet (contested, #118): R3 runs before that is settled.
  keptIncome = (after) =>
    incomeAfter(
      new Set(
        [...after].filter(
          (t) => !conceded.has(t) && !units.some((u) => (u.conceded || u.contested) && u.members.some((m) => m.id === t)),
        ),
      ),
    );
  /** Borders a funded unit (or an individual hold) already holds. */
  const heldBorders = new Set<number>();
  /** My commander's borders whose whole hold rule 1k deployed. */
  const commanderHeld = new Set<number>();
  /** Local Deployment: the armies bonus `id`'s own pool holds this turn (0 with the flag off). */
  const poolOf = (id: number) => (local ? (pools.bonuses.find((p) => p.bonusId === id)?.value ?? 0) : 0);
  const buildUnits = () => {
    for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
      const ts = bonusTerritories(g, b.id);
      if (b.value <= 0 || !ts.length || !ts.every((x) => holdings.has(x))) continue;
      const members = threatened.filter((t) => ts.includes(t.id)).sort((x, y) => x.id - y.id);
      if (!members.length) continue;
      // My commander's border, once its hold is funded (rule 1k), is held whatever it costs: a
      // sunk cost the unit no longer pays, and a stack it no longer saves, so it is left out of
      // the unit's cost and its payback test. A hold rule 1k could not fully fund still counts.
      const paying = members.filter((m) => !commanderHeld.has(m.id));
      const cost = paying.reduce((n, m) => n + m.holdCost, 0);
      const worth = b.value + paying.reduce((n, m) => n + m.have / PAYBACK_TURNS, 0);
      // It pays back within PAYBACK_TURNS, and (as rule 1a asks of every border) costs at
      // most CONCEDE_FACTOR × its worth, unless a member was just taken from a weak opponent.
      const recent = members.some((m) => m.recentFrom !== undefined);
      // Local Deployment (#103): the bonus's own armies can be deployed nowhere else, so
      // spending them on its defence costs nothing — only what holding it needs beyond them.
      const pool = poolOf(b.id);
      const net = Math.max(0, cost - pool);
      units.push({
        bonusId: b.id,
        value: b.value,
        members,
        cost,
        pool,
        net,
        worth,
        loss: net > PAYBACK_TURNS * b.value ? 'payback' : !recent && net > CONCEDE_FACTOR * worth ? 'factor' : null,
        conceded: false,
        floored: false,
        contested: false,
      });
    }
  };
  /** A threatened border still owned by a unit not conceded (it is held or conceded with it). */
  const inLiveUnit = (id: number) => units.some((u) => !u.conceded && u.members.some((m) => m.id === id));
  /** `t` judged on its own: its protected value less the bonuses of the units conceded with it. */
  const residual = (t: Threatened): Threatened => {
    const lost = units.filter((u) => u.conceded && u.members.some((m) => m.id === t.id)).reduce((n, u) => n + u.value, 0);
    const value = Math.max(0, t.value - lost);
    return { ...t, value, worth: value + t.have / PAYBACK_TURNS };
  };
  const unitBorders = (u: Unit) =>
    `${u.members.length} threatened border${u.members.length === 1 ? '' : 's'}`;
  /** Why a unit is conceded: it does not pay for itself, or the armies left cannot cover it. */
  type UnitLoss = { economic: 'payback' | 'factor' } | { economic: false; left: number };
  /**
   * Concede `u` as a whole, then judge each of its members no other live unit owns on its
   * own merits (`single`, quietly: other bonuses, per-territory income, the stack it saves).
   * One warning: rule 1a's for a one-border unit that stays conceded (so it names the full
   * value it protects), else "conceding <bonus>: holding all N borders needs X, …".
   */
  const concedeUnit = (u: Unit, loss: UnitLoss, single: (t: Threatened, quiet: boolean) => void) => {
    u.conceded = true;
    for (const m of u.members) if (!heldBorders.has(m.id) && !inLiveUnit(m.id)) single(residual(m), true);
    const [only] = u.members;
    if (u.members.length === 1) {
      if (conceded.has(only!.id) && !heldBorders.has(only!.id))
        warnings.push(
          loss.economic
            ? `${label(only!.id)} cannot be held economically (needs ${only!.holdCost}, protects +${only!.value}): conceded`
            : `${label(only!.id)} cannot be held with the ${loss.left} armies left to deploy (needs ${only!.holdCost}, protects +${only!.value}): conceded`,
        );
      return;
    }
    const why =
      loss.economic === false
        ? `more than the ${loss.left} armies left to deploy`
        : loss.economic === 'payback'
          ? `more than it pays back in ${PAYBACK_TURNS} turns (${PAYBACK_TURNS} × +${u.value} = ${PAYBACK_TURNS * u.value})`
          : `more than ${CONCEDE_FACTOR} × its worth (~${Math.round(u.worth * 10) / 10})`;
    const needs = u.pool > 0 && loss.economic ? `${u.cost} (${u.net} beyond its own ${Math.min(u.pool, u.cost)} local armies)` : `${u.cost}`;
    warnings.push(
      `conceding bonus ${bonusName(u.bonusId)} (+${u.value}): holding all ${u.members.length} threatened borders (${u.members.map((m) => label(m.id)).join(', ')}) needs ${needs}, ${why}`,
    );
  };
  /** The armies `u` may still deploy, for its warning: a one-border unit's room (pools respected). */
  const leftFor = (u: Unit) => {
    if (u.members.length === 1) return roomAt(u.members[0]!.id);
    if (!local) return budget;
    // Local Deployment: what may be deployed on its borders together (pools respected).
    const given = u.members.map((m) => {
      const n = roomAt(m.id);
      deploy(m.id, n);
      return { id: m.id, n };
    });
    for (const x of given) undeploy(x.id, x.n);
    return given.reduce((n, x) => n + x.n, 0);
  };
  /**
   * Deploy every hold of `u` not yet funded, or nothing: false when they do not all fit.
   * `each` may take over one member's hold (attacking on top of it), given the deploys
   * the members after it still need; it returns false to leave it a plain hold.
   */
  const fundUnit = (u: Unit, each?: (m: Threatened, rest: number) => boolean, line?: string): boolean => {
    // A commander border rule 1k could not fully hold is still owed (it cannot be deployed to further).
    const todo = u.members.filter((m) => !heldBorders.has(m.id) || (m.critical && !commanderHeld.has(m.id)));
    const cost = todo.reduce((n, m) => n + m.holdCost, 0);
    if (cost > budget) return false;
    if (local) {
      // Pools: each hold must fit its own territory's room, the earlier ones deployed.
      const done: Threatened[] = [];
      for (const m of todo) {
        if (m.holdCost > roomAt(m.id)) {
          for (const d of done) undeploy(d.id, d.holdCost);
          return false;
        }
        deploy(m.id, m.holdCost);
        done.push(m);
      }
      for (const d of done) undeploy(d.id, d.holdCost);
    }
    const one = u.members.length === 1;
    // What this unit deploys itself: a border another unit already holds costs it nothing (its
    // own floor, #118, counts as its own).
    const own = cost + todo.reduce((n, m) => n + (m.given ?? 0), 0);
    const needs = !todo.length
      ? u.members.every((m) => commanderHeld.has(m.id))
        ? `${one ? 'is' : 'are'} already held for my commander`
        : `${one ? 'is' : 'are'} already held for another bonus`
      : own < u.cost
        ? `need${one ? 's' : ''} ${own} more (${u.cost - own} already deployed for another bonus)`
        : `need${one ? 's' : ''} ${own} in all`;
    rationale.push(
      line ??
        `Hold bonus ${bonusName(u.bonusId)} (+${u.value}) whole: its ${unitBorders(u)} ${needs} (it pays back within ${PAYBACK_TURNS} turns), before any capture that completes no bonus.`,
    );
    let rest = cost;
    for (const m of todo) {
      rest -= m.holdCost;
      if (!each?.(m, rest)) hold(m);
      heldBorders.add(m.id);
    }
    return true;
  };
  /**
   * Rule 1h near miss (issue #59), when {@link fundUnit} cannot cover `u`: give each of its
   * borders not yet held what may still be deployed there, up to its hold cost (pools
   * respected). It is kept — those deploys stay, nothing is withdrawn — when the total is
   * short by at most {@link nearMissMargin} of the need, or when every short border still
   * holds against the expected attack ({@link expectedAt}: movable + deploy estimate, not the
   * trend's worst case). Otherwise every deploy is rolled back: false.
   */
  const fundNearMiss = (u: Unit): boolean => {
    const todo = u.members.filter((m) => !heldBorders.has(m.id));
    if (!todo.length) return false;
    const given = todo.map((m) => {
      const n = Math.max(0, Math.min(m.holdCost, roomAt(m.id)));
      deploy(m.id, n);
      return { m, n };
    });
    // A floor already deployed (#118) counts toward both, as if deployed here.
    const need = todo.reduce((n, m) => n + m.holdCost + (m.given ?? 0), 0);
    const total = given.reduce((n, x) => n + x.n + (x.m.given ?? 0), 0);
    const short = need - total;
    const margin = nearMissMargin(need);
    const shortOnes = given.filter((x) => x.n < x.m.holdCost);
    const holdsExpected = shortOnes.every(
      (x) => (toTake(x.m.have + x.n) ?? Infinity) > expectedAt(x.m.id),
    );
    if (short > margin && !holdsExpected) {
      for (const x of given) if (x.n > 0) undeploy(x.m.id, x.n);
      return false;
    }
    const expected = Math.max(...shortOnes.map((x) => expectedAt(x.m.id)));
    const why =
      short <= margin
        ? `short by ${short}, within the near-miss margin of ${Math.round(margin * 10) / 10}`
        : `enough to hold against the expected ~${expected} attack (movable + deploy estimate), not the worst case`;
    const one = todo.length === 1;
    warnings.push(
      `Bonus ${bonusName(u.bonusId)} (+${u.value}) is held though short: its ${todo.length} threatened border${one ? '' : 's'} need${one ? 's' : ''} ${need}, only ${total} left to deploy, so ${total ? `all ${total} go there` : 'its armies stay'} (${why}); ${shortOnes.map((x) => label(x.m.id)).join(', ')} may fall.`,
    );
    for (const { m, n } of given) {
      noteRecent(m);
      locked.add(m.id);
      heldBorders.add(m.id);
      rationale.push(
        n + (m.given ?? 0) > 0
          ? `Deploy ${n + (m.given ?? 0)} to ${label(m.id)} so bonus ${bonusName(u.bonusId)} (+${u.value}) is not conceded: ${m.have + n} armies need ${toTake(m.have + n)} to take, against the ~${m.threat} threat (its armies stay: withdrawing them would guarantee the loss).`
          : `Keep the armies on ${label(m.id)} so bonus ${bonusName(u.bonusId)} (+${u.value}) is not conceded: ${m.have} armies need ${toTake(m.have)} to take, against the ~${m.threat} threat.`,
      );
    }
    return true;
  };

  // ---- 1h. floor tier and one shared deploy (#118) ----
  // One enemy deploy lands on one target. Sizing every border of a held bonus for the whole of
  // it conceded every bonus once the deploy outgrew them, though the stacks already next to the
  // borders could take none. So a held bonus first gets its floor — every threatened border beats
  // the armies already next to it — and, when it is not then held whole, what is left is spread
  // over its borders so the deploy must be aimed at a border to break it.
  /** The most movable armies (special units included) one visible enemy player has next to my `t`. */
  const adjacentMovable = (t: number) => {
    const byPlayer = new Map<number, number>();
    for (const n of neighborsOf(g, t)) {
      const st = state.get(n);
      if (captured.has(n) || st?.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) continue;
      byPlayer.set(st.owner.playerId, (byPlayer.get(st.owner.playerId) ?? 0) + Math.max(0, st.armies - guard) + unitsAt(n));
    }
    return Math.max(0, ...byPlayer.values());
  };
  /** The deploys `m` needs to beat the armies already next to it (never more than its hold cost). */
  const floorOf = (m: Threatened) => {
    const movable = adjacentMovable(m.id);
    let d = 0;
    while (d < m.holdCost && (toTake(m.have + m.units + d) ?? Infinity) <= movable) d++;
    return d;
  };
  /** Deploy `n` to `m` as part of its hold: what it has grows and what its hold still needs shrinks. */
  const give = (m: Threatened, n: number) => {
    deploy(m.id, n);
    m.have += n;
    m.holdCost -= n;
    m.given = (m.given ?? 0) + n;
  };
  /**
   * Fund the floors of `us` — units about to be conceded — best value per army first (ties:
   * cheaper, then its first border's id), all of a unit's floor or none; a unit whose floor is
   * funded is `floored`.
   */
  const floorUnits = (us: readonly Unit[]) => {
    const need = (u: Unit) => u.members.filter((m) => !commanderHeld.has(m.id)).map((m) => ({ m, f: floorOf(m) }));
    // A floor only helps where the deploy must choose: against a player with one threatened
    // border of mine to aim at, all of its deploy lands there, and a floor alone saves nothing.
    const targetsOf = new Map<number, number>();
    for (const t of threatened) {
      const p = borders.get(t.id)?.player;
      if (p !== undefined) targetsOf.set(p, (targetsOf.get(p) ?? 0) + 1);
    }
    const spread = (u: Unit) => u.members.every((m) => (targetsOf.get(borders.get(m.id)?.player ?? -1) ?? 0) >= 2);
    const order = us
      .filter(spread)
      .map((u) => ({ u, cost: need(u).reduce((n, x) => n + x.f, 0) }))
      .sort((a, b) => (b.cost ? b.u.value / b.cost : Infinity) - (a.cost ? a.u.value / a.cost : Infinity) || a.cost - b.cost || a.u.members[0]!.id - b.u.members[0]!.id);
    for (const { u } of order) {
      // Recomputed: a border shared with a unit floored before it already has its floor.
      const todo = need(u).filter((x) => x.f > 0);
      if (todo.reduce((n, x) => n + x.f, 0) > budget) continue;
      const done: { m: Threatened; f: number }[] = [];
      let fits = true;
      for (const x of todo) {
        if (x.f > roomAt(x.m.id)) {
          fits = false;
          break;
        }
        give(x.m, x.f);
        done.push(x);
      }
      if (!fits) {
        for (const x of done) {
          undeploy(x.m.id, x.f);
          x.m.have -= x.f;
          x.m.holdCost += x.f;
          x.m.given = (x.m.given ?? 0) - x.f;
        }
        continue;
      }
      u.floored = true;
      rationale.push(
        ...done.map(
          (x) =>
            `Floor for bonus ${bonusName(u.bonusId)} (+${u.value}): deploy ${x.f} to ${label(x.m.id)} so its ${x.m.have} armies beat the ${adjacentMovable(x.m.id)} already next to it (${toTake(x.m.have + x.m.units)} to take): one enemy deploy lands on one target, so every border first holds against what is already there.`,
        ),
      );
    }
  };
  /**
   * #122: would `u` survive on `left` armies short of its whole hold — kept as a near miss (short
   * by at most {@link nearMissMargin}) or floored (every border faces a player with two or more
   * targets, and its floor fits)? An estimate for rule 1h.3's starve check: `left` is pool-aware
   * under Local Deployment (the caller passes what may be deployed on its borders), but the
   * expected-attack test of the near miss and `fundable`'s greedy order are left out.
   */
  const keptShort = (u: Unit, left: number): 'near' | 'floor' | null => {
    const todo = u.members.filter((m) => !heldBorders.has(m.id));
    const need = todo.reduce((n, m) => n + m.holdCost, 0);
    if (need - left <= nearMissMargin(need)) return 'near';
    const targetsOf = new Map<number, number>();
    for (const t of threatened) {
      const p = borders.get(t.id)?.player;
      if (p !== undefined) targetsOf.set(p, (targetsOf.get(p) ?? 0) + 1);
    }
    const spread = todo.every((m) => (targetsOf.get(borders.get(m.id)?.player ?? -1) ?? 0) >= 2);
    return spread && todo.reduce((n, m) => n + floorOf(m), 0) <= left ? 'floor' : null;
  };
  /** Keep a floored unit that is not held whole (#118): its borders stay, nothing is withdrawn. */
  const contest = (u: Unit) => {
    u.contested = true;
    for (const m of u.members) locked.add(m.id);
  };
  /** A unit that cannot be held whole now: floored and kept when it can be (#118), else conceded whole. */
  const floorOrConcede = (u: Unit, left: number, single: (t: Threatened, quiet: boolean) => void) => {
    floorUnits([u]);
    if (u.floored) contest(u);
    else concedeUnit(u, { economic: false, left }, single);
  };
  /** Its borders' threat beyond the armies already next to them: the opponent's deploy (or growth). */
  const deployShare = (m: Threatened) => m.threat - adjacentMovable(m.id);
  /**
   * After the captures (the better use of the armies): hold each contested unit whole when what
   * is left covers it (best worth per army first), else spread what is left over the borders
   * still short, one army at a time to the one the opponent's deploy breaks most cheaply (ties:
   * the higher bonus value, then id), each up to its full hold.
   */
  /** A member of a unit conceded after the captures, judged on its own (rule 1a, against what is left). */
  const singleLate = (t: Threatened, quiet: boolean) => {
    if (t.critical) return;
    if (uneconomic(t)) {
      conceded.add(t.id);
      if (!quiet) warnings.push(`${label(t.id)} cannot be held economically (needs ${t.holdCost}, protects +${t.value}): conceded`);
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
  /** Armies the opponent's deploy needs on my `m` to take it, with `have` armies there. */
  const breakCostWith = (m: Threatened, have: number) => (toTake(have + m.units) ?? Infinity) - adjacentMovable(m.id);
  /**
   * The bonus value the opponents' best response takes from the floored units in `us`, given
   * the armies on each border: per player, its one deploy split to break the most value (each
   * unit broken through its cheapest short border facing that player; a 0/1 knapsack), as
   * `guaranteedFalls` sizes a single budget on offence.
   */
  const bestResponse = (us: readonly Unit[], have: ReadonlyMap<Threatened, number>, short: (m: Threatened) => boolean) => {
    const players = new Map<number, { deploy: number; items: Map<Unit, number> }>();
    for (const u of us)
      for (const m of u.members) {
        if (!short(m)) continue;
        const p = borders.get(m.id)?.player;
        if (p === undefined) continue;
        const e = players.get(p) ?? { deploy: 0, items: new Map<Unit, number>() };
        e.deploy = Math.max(e.deploy, deployShare(m));
        const c = Math.max(0, breakCostWith(m, have.get(m) ?? m.have));
        e.items.set(u, Math.min(e.items.get(u) ?? Infinity, c));
        players.set(p, e);
      }
    let loss = 0;
    const by: { player: number; deploy: number; units: Unit[]; of: Unit[]; cost: number; value: number }[] = [];
    for (const [player, { deploy, items }] of [...players].sort((a, b) => a[0] - b[0])) {
      const d = Math.max(0, Math.floor(deploy));
      // best[x]: the most value x armies of the deploy break, with the cheapest such pick.
      type Pick = { value: number; cost: number; units: Unit[] };
      const best: Pick[] = Array.from({ length: d + 1 }, () => ({ value: 0, cost: 0, units: [] }));
      for (const [u, c] of items) {
        if (c > d) continue;
        for (let x = d; x >= c; x--) {
          const prev = best[x - c]!;
          const cand = { value: prev.value + u.value, cost: prev.cost + c, units: [...prev.units, u] };
          const cur = best[x]!;
          if (cand.value > cur.value || (cand.value === cur.value && cand.cost < cur.cost)) best[x] = cand;
        }
      }
      const pick = best[d]!;
      loss += pick.value;
      if (pick.value > 0) by.push({ player, deploy: d, units: pick.units, of: [...items.keys()], cost: pick.cost, value: pick.value });
    }
    return { loss, by };
  };
  const bestResponseLoss = (us: readonly Unit[], have: ReadonlyMap<Threatened, number>, short: (m: Threatened) => boolean) =>
    bestResponse(us, have, short).loss;
  const settleContested = () => {
    const open = units.filter((u) => u.contested && !u.conceded);
    if (!open.length) return;
    const need = (u: Unit) => u.members.filter((m) => !heldBorders.has(m.id)).reduce((n, m) => n + m.holdCost, 0);
    const ratio = (u: Unit) => u.worth / Math.max(1, need(u));
    const order = [...open].sort((a, b) => ratio(b) - ratio(a) || a.members[0]!.id - b.members[0]!.id);
    // Holding one floored unit whole can leave the others thinner than spreading the same
    // armies over all of them: simulate both and keep whole holds unless spreading loses less
    // to the opponents' best response (Local Deployment: whole holds, pools decide the room).
    const simulate = (wholeFirst: boolean) => {
      let b = budget;
      const have = new Map<Threatened, number>();
      const left = new Map<Threatened, number>();
      for (const u of open)
        for (const m of u.members)
          if (!heldBorders.has(m.id)) {
            have.set(m, m.have);
            left.set(m, m.holdCost);
          }
      let lost = 0;
      for (const u of order) {
        if (u.floored && !wholeFirst) continue;
        const ms = u.members.filter((m) => (left.get(m) ?? 0) > 0);
        const more = ms.reduce((n, m) => n + left.get(m)!, 0);
        if (more <= b) {
          b -= more;
          for (const m of ms) {
            have.set(m, have.get(m)! + left.get(m)!);
            left.set(m, 0);
          }
        } else if (!u.floored) lost += u.value;
      }
      const floored = open.filter((u) => u.floored);
      const valueAt = (m: Threatened) => Math.max(0, ...floored.filter((u) => u.members.includes(m)).map((u) => u.value));
      const fill = [...new Set(floored.flatMap((u) => u.members))].filter((m) => left.has(m));
      while (b > 0) {
        const next = fill
          .filter((m) => left.get(m)! > 0)
          .sort((x, y) => breakCostWith(x, have.get(x)!) - breakCostWith(y, have.get(y)!) || valueAt(y) - valueAt(x) || x.id - y.id)[0];
        if (!next) break;
        have.set(next, have.get(next)! + 1);
        left.set(next, left.get(next)! - 1);
        b--;
      }
      return lost + bestResponseLoss(floored, have, (m) => (left.get(m) ?? 0) > 0);
    };
    const spreadFloored = !local && open.some((u) => u.floored) && simulate(false) < simulate(true);
    for (const u of order) {
      if (u.floored && spreadFloored) continue;
      const more = need(u);
      const floored = u.members.some((m) => (m.given ?? 0) > 0);
      const why =
        u.loss === 'payback'
          ? `more than it pays back in ${PAYBACK_TURNS} turns`
          : u.loss === 'factor'
            ? `more than ${CONCEDE_FACTOR} × its worth`
            : null;
      if (
        more <= budget &&
        fundUnit(
          u,
          undefined,
          `Hold bonus ${bonusName(u.bonusId)} (+${u.value}) whole: ${floored ? 'past its floor ' : ''}its ${unitBorders(u)} need${u.members.length === 1 ? 's' : ''} ${more}${floored ? ' more' : ''}${why ? ` (${why})` : ''}, and nothing else this turn uses those armies.`,
        )
      ) {
        u.contested = false;
        continue;
      }
      // Not floored (one target for the deploy): the old concession, now that the captures had their turn.
      if (!u.floored) {
        u.contested = false;
        concedeUnit(u, u.loss ? { economic: u.loss } : { economic: false, left: leftFor(u) }, singleLate);
        // As a conceded border always could: it may still attack out (rule 1a).
        for (const m of u.members) if (conceded.has(m.id)) locked.delete(m.id);
      }
    }
    const short = units
      .filter((u) => u.contested && !u.conceded)
      .flatMap((u) => u.members.filter((m) => !heldBorders.has(m.id)).map((m) => ({ m, u })));
    const value = (m: Threatened) => Math.max(...short.filter((x) => x.m === m).map((x) => x.u.value));
    const members = [...new Set(short.map((x) => x.m))];
    const given = new Map<Threatened, number>();
    const breakCost = (m: Threatened) => breakCostWith(m, m.have);
    if (spreadFloored)
      rationale.push(
        `Spread what is left over the floored bonuses' borders rather than hold one whole: against the opponent's best use of its deploy that loses less.`,
      );
    while (budget > 0) {
      const next = members
        .filter((m) => m.holdCost > 0 && roomAt(m.id) > 0)
        .sort((a, b) => breakCost(a) - breakCost(b) || value(b) - value(a) || a.id - b.id)[0];
      if (!next) break;
      give(next, 1);
      given.set(next, (given.get(next) ?? 0) + 1);
    }
    for (const [m, n] of [...given].sort((a, b) => a[0].id - b[0].id))
      rationale.push(
        m.holdCost <= 0
          ? `Deploy ${n} more to ${label(m.id)} so it holds (${m.have} armies, ${toTake(m.have + m.units)} to take, above the ~${m.threat} threat).`
          : `Deploy ${n} more to ${label(m.id)} against the one shared deploy: ${m.have} armies, so player ${borders.get(m.id)?.player}'s deploy needs ${breakCost(m)} of its ~${deployShare(m)} there to take it.`,
      );
    for (const m of members) if (m.holdCost <= 0) heldBorders.add(m.id);
    const stillShort: Unit[] = [];
    for (const u of units) {
      if (!u.contested || u.conceded) continue;
      const left = u.members.filter((m) => !heldBorders.has(m.id));
      if (!left.length) {
        u.contested = false;
        continue;
      }
      stillShort.push(u);
      warnings.push(
        `Bonus ${bonusName(u.bonusId)} (+${u.value}) is not safe against the whole enemy deploy (its ${unitBorders(u)} would need ${left.reduce((n, m) => n + m.holdCost, 0)} more), but it is not conceded: every border beats the armies already next to it, so it falls only to armies deployed against it — ${left.map((m) => `${label(m.id)} (${m.have} armies; ${breakCost(m)} of the ~${deployShare(m)} deploy take it)`).join(', ')}.`,
      );
    }
    // Read together, the lines above can suggest one deploy breaks only one bonus: say what
    // each opponent's best use of its one deploy breaks (the same knapsack the spread used).
    const have = new Map(stillShort.flatMap((u) => u.members.map((m) => [m, m.have] as const)));
    for (const r of bestResponse(stillShort, have, (m) => !heldBorders.has(m.id)).by) {
      const list = (us: readonly Unit[]) => {
        const names = us.map((u) => bonusName(u.bonusId));
        return `bonus${names.length > 1 ? 'es' : ''} ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}`;
      };
      const what = r.units.length === r.of.length ? `${list(r.units)}${r.units.length > 1 ? ' at once' : ''}` : `${r.units.length} of ${list(r.of)}`;
      warnings.push(`Player ${r.player}'s ~${r.deploy} deploy can still break ${what} (${r.cost} of it needed): +${r.value} at risk this turn.`);
    }
  };

  // Under `balanced`, holds worth paying for compete with expansion in the greedy step below.
  const holds: Threatened[] = [];
  const triage = () => {
    // ---- 1k. my commander's border is must-hold (#61) ----
    // Losing the commander eliminates me: its border is never conceded, and it is held
    // first, under every goal. When the hold does not fit, everything left that may be
    // deployed there goes there, and nothing leaves it.
    for (const t of threatened) {
      if (!t.critical) continue;
      heldBorders.add(t.id);
      locked.add(t.id);
      const room = roomAt(t.id);
      if (t.holdCost <= room) {
        deploy(t.id, t.holdCost);
        commanderHeld.add(t.id);
        rationale.push(
          `Deploy ${t.holdCost} to ${label(t.id)}: my commander stands there, so it must hold (losing the commander eliminates me): ${heldStack(t)} need ${toTake(t.have + t.units + t.holdCost)} to take, above the ~${t.threat} threat.`,
        );
        continue;
      }
      deploy(t.id, room);
      warnings.push(
        `My commander's territory ${label(t.id)} cannot be made safe this turn: it needs ${t.holdCost} more armies against the ~${t.threat} threat, but only ${room} can be deployed there. ${room ? `All ${room} go there, and` : 'Still,'} nothing leaves it (losing the commander eliminates me; it is never conceded).`,
      );
    }
    let triageBudget = budget;
    buildUnits();
    if (goal === 'expand')
      for (const u of units)
        if (!u.loss)
          warnings.push(
            `goal expand does not defend held bonus ${bonusName(u.bonusId)} (+${u.value}) first: holding its ${unitBorders(u)} needs ${u.cost} (it pays back within ${PAYBACK_TURNS} turns).`,
          );
    if (!guarded) units.length = 0;
    /** The per-border triage of rule 1a. */
    const single = (t: Threatened, quiet = false) => {
      // My commander's border is already held (rule 1k).
      if (t.critical) return;
      const left = Math.min(acting ? budget : triageBudget, local ? roomAt(t.id) : Infinity);
      if (uneconomic(t)) {
        conceded.add(t.id);
        if (!quiet)
          warnings.push(`${label(t.id)} cannot be held economically (needs ${t.holdCost}, protects +${t.value}): conceded`);
        return;
      }
      if (balanced) {
        // Its armies stay put until the greedy step decides: holding assumes they are all there.
        holds.push(t);
        locked.add(t.id);
        return;
      }
      if (t.holdCost > left) {
        if (quiet) conceded.add(t.id);
        else concedeUnaffordable(t, left);
        return;
      }
      triageBudget -= t.holdCost;
      if (acting) {
        hold(t);
        heldBorders.add(t.id);
      }
    };
    // #118: CONCEDE_FACTOR and the payback test concede a floored unit only when the armies have
    // a better use: it is kept, and held whole after the captures if what is left covers it.
    const losing = units.filter((u) => u.loss);
    floorUnits(losing);
    for (const u of losing) contest(u);
    type Item = { unit: Unit } | { border: Threatened };
    const items: Item[] = [
      ...units.filter((u) => !u.conceded && !u.contested).map((unit) => ({ unit })),
      ...threatened.filter((t) => !units.some((u) => u.members.some((m) => m.id === t.id))).map((border) => ({ border })),
    ];
    if (!acting) {
      // Under `balanced` the units compete in the greedy step; their members stay put.
      for (const u of units) if (!u.conceded && !u.contested) for (const m of u.members) locked.add(m.id);
      for (const it of items) if ('border' in it) single(it.border);
      return;
    }
    // `defend`: units and single borders by worth per army (a recent capture first).
    const key = (it: Item) =>
      'unit' in it
        ? { recent: it.unit.members.some((m) => m.recentFrom !== undefined), ratio: it.unit.worth / it.unit.net, cost: it.unit.cost, id: it.unit.members[0]!.id }
        : { recent: it.border.recentFrom !== undefined, ratio: it.border.worth / it.border.holdCost, cost: it.border.holdCost, id: it.border.id };
    items.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return Number(y.recent) - Number(x.recent) || y.ratio - x.ratio || x.cost - y.cost || x.id - y.id;
    });
    for (const it of items) {
      if ('border' in it) {
        if (!heldBorders.has(it.border.id) && !conceded.has(it.border.id)) single(it.border);
        continue;
      }
      if (!fundUnit(it.unit) && !fundNearMiss(it.unit)) floorOrConcede(it.unit, leftFor(it.unit), single);
    }
  };

  // ---- 1b. withdraw from conceded borders ----
  let cardAdvice: CardAdvice | null = null;
  // Armies withdrawn into each territory this turn (they stay there: armies never move twice).
  const incoming = new Map<number, number>();
  /** Conceded borders of a held bonus whose garrison stays (it holds against the expected attack). */
  const stood = new Set<number>();
  /** Bonuses whose Local Deployment concession warning (#103) is already given. */
  const warnedLocal = new Set<number>();
  /** Local Deployment (#103): conceded borders of a held bonus that might still hold; the leftover may go there. */
  const mayHold = new Set<number>();
  /** Local Deployment: the armies every pool containing `id` holds this turn. */
  const poolsAt = (id: number) =>
    local ? pools.bonuses.filter((p) => p.territoryIds.includes(id)).reduce((n, p) => n + p.value, 0) : 0;
  /** A border no deploy this turn can hold: its hold needs more than its pools and every free army. */
  const lostAnywayAt = (m: Threatened) => local && m.holdCost > poolsAt(m.id) + pools.anywhere;
  /** A held bonus that falls whatever this turn deploys: one of its threatened borders cannot be held. */
  const lostAnyway = (u: Unit) => u.members.some(lostAnywayAt);
  const withdraw = () => {
    if (!conceded.size) return;
    const withdrawals: PlannedMove[] = [];
    const keep = (id: number) => mineSet.has(id) && !conceded.has(id);
    // Borders that can hold: mine, not conceded, next to something not mine.
    const holding = mine.filter((id) => keep(id) && neighborsOf(g, id).some((n) => !mineSet.has(n)));
    for (const t of [...conceded].sort(byNum)) {
      // #179: a covered exit keeps its cover; only the rest may leave.
      const n = avail.get(t)! - coverOf(t);
      // No-Split (#124): a transfer sends the whole stack, so a covered exit sends none.
      if (n <= 0 || (noSplit && coverOf(t) > 0)) continue;
      // Issue #59: a held bonus's border keeps its garrison while it still holds against the
      // expected attack — withdrawing it would guarantee the loss.
      const held = g.map.bonuses
        .filter((b) => {
          const ts = bonusTerritories(g, b.id);
          return b.value > 0 && ts.includes(t) && ts.every((x) => mineSet.has(x));
        })
        .sort((a, b) => a.id - b.id);
      const stays = stayAt(t);
      const take = toTake(stays) ?? Infinity;
      const expected = expectedAt(t);
      if (held.length && take > expected) {
        locked.add(t);
        stood.add(t);
        rationale.push(
          `Keep the ${n} movable armies on ${label(t)} (not withdrawn): it is a border of held bonus ${held.map((b) => bonusName(b.id)).join(', ')}, and its ${stays} armies need ${take} to take, above the expected ~${expected} attack (movable + deploy estimate).`,
        );
        continue;
      }
      // Local Deployment (#103): a conceded held bonus keeps its garrisons unless it truly
      // cannot be held — some threatened border needs more than its pools and every free army
      // could give it. Withdrawing turns "might lose it" into "certainly loses it".
      if (local && held.length) {
        const mine1 = units.filter((u) => u.conceded && u.members.some((m) => m.id === t));
        const maybe = mine1.filter((u) => !lostAnyway(u));
        if (maybe.length) {
          locked.add(t);
          stood.add(t);
          mayHold.add(t);
          for (const u of maybe) {
            if (warnedLocal.has(u.bonusId)) continue;
            warnedLocal.add(u.bonusId);
            warnings.push(
              `Bonus ${bonusName(u.bonusId)} (+${u.value}) is conceded but might still hold: each of its ${unitBorders(u)} could be held with its own ${u.pool} local armies and the ${pools.anywhere} free ones, so its garrisons stay and its local armies defend it (withdrawing would make the loss certain); it may fall.`,
            );
          }
          rationale.push(
            `Keep the ${n} movable armies on ${label(t)} (not withdrawn): bonus ${maybe.map((u) => bonusName(u.bonusId)).join(', ')} might still hold under Local Deployment, and withdrawing would guarantee the loss.`,
          );
          continue;
        }
        for (const u of mine1) {
          if (warnedLocal.has(u.bonusId)) continue;
          warnedLocal.add(u.bonusId);
          const worst = u.members.find((m) => lostAnywayAt(m))!;
          warnings.push(
            `Bonus ${bonusName(u.bonusId)} (+${u.value}) cannot be held: ${label(worst.id)} needs ${worst.holdCost}, more than its own ${poolsAt(worst.id)} local armies and all ${pools.anywhere} free ones could give it, so its garrisons withdraw (it is lost either way).`,
          );
        }
      }
      const options = neighborsOf(g, t)
        .filter(keep)
        .map((c) => {
          const dist = bfsDistances(g, [c], { passable: keep });
          let best = Infinity;
          let value = 0;
          for (const h of holding) {
            const d = dist.get(h);
            if (d === undefined) continue;
            if (d < best || (d === best && valueOf(h) > value)) [best, value] = [d, valueOf(h)];
          }
          return { id: c, best, value };
        })
        .sort((a, b) => a.best - b.best || b.value - a.value || a.id - b.id);
      const to = options[0];
      if (!to) {
        warnings.push(`${label(t)} is conceded and has nowhere to withdraw to: its ${n} movable armies stay.`);
        continue;
      }
      // #118: a border of a bonus I hold in full keeps its garrison — those armies kill attackers
      // where they stand — unless withdrawing them makes another valued border hold this turn.
      // (Under Local Deployment rule 1b's pool test above decides instead.)
      if (held.length && !local) {
        const dest = borders.get(to.id);
        const at = stayAt(to.id) + unitsAt(to.id);
        const makesHold =
          dest !== undefined &&
          !conceded.has(to.id) &&
          valueOf(to.id) > 0 &&
          (toTake(at) ?? Infinity) <= dest.threat &&
          (toTake(at + n) ?? Infinity) > dest.threat;
        if (!makesHold) {
          locked.add(t);
          stood.add(t);
          rationale.push(
            `Keep the ${n} movable armies on ${label(t)} (not withdrawn): it is a border of held bonus ${held.map((b) => bonusName(b.id)).join(', ')}, and withdrawing them would make no other valued border hold this turn, while there they kill attackers.`,
          );
          continue;
        }
      }
      if (orderOf(t)) {
        warnSplit(t, `its ${n} remaining armies are not withdrawn to ${label(to.id)}`);
        locked.add(t);
        continue;
      }
      avail.set(t, avail.get(t)! - n);
      locked.add(t);
      const reason = 'withdraws from a conceded border';
      withdrawals.push({ from: t, to: to.id, armies: n, kind: 'transfer', reason });
      incoming.set(to.id, (incoming.get(to.id) ?? 0) + n);
      rationale.push(`Withdraw ${n} from ${label(t)} to ${label(to.id)}: ${reason}, toward a border that holds.`);
      warnings.push(
        `The withdrawal from ${label(t)} only executes if ${label(t)} is still mine when the order runs; play Order Priority so it goes first.`,
      );
      cardAdvice = 'order-priority';
    }
    // Withdrawals go first: they only execute while the border is still mine.
    moves.unshift(...withdrawals);
  };

  // ---- 1c. reconsider concessions after the capture passes (R2) ----
  // Triage ran before captures were known, so a border in a bonus this turn's
  // captures complete was valued +0 and conceded. Re-value every border against
  // the holdings after the captures; a conceded border in a bonus completed this
  // turn is kept (never withdrawn from) and garrisoned from the leftover.
  /** Conceded borders kept because this turn's captures complete a bonus they protect. */
  const kept = new Set<number>();
  const reconsider = () => {
    if (!captured.size) return;
    holdings = new Set([...mine, ...captured]);
    valueCache.clear();
    if (!conceded.size) return;
    for (const t of [...conceded].sort(byNum)) {
      // Already withdrawn from (rule 1b ran first): its armies are gone, and it stays conceded.
      if (moves.some((m) => m.from === t && m.reason === 'withdraws from a conceded border')) continue;
      const completes = g.map.bonuses
        .filter((b) => {
          const ts = bonusTerritories(g, b.id);
          return b.value > 0 && ts.includes(t) && ts.every((x) => holdings.has(x)) && !ts.every((x) => mineSet.has(x));
        })
        .sort((a, b) => a.id - b.id);
      if (!completes.length) continue;
      conceded.delete(t);
      kept.add(t);
      locked.add(t);
      // Drop its concession warning: it is no longer conceded.
      const conceding = `${label(t)} cannot be held `;
      for (let i = warnings.length - 1; i >= 0; i--)
        if (warnings[i]!.startsWith(conceding) && warnings[i]!.endsWith(': conceded')) warnings.splice(i, 1);
      rationale.push(
        `Keep ${label(t)} (not conceded): this turn's captures complete ${completes.map((b) => `bonus ${b.name} (#${b.id}) (+${b.value})`).join(', ')}, so it protects +${valueOf(t)}.`,
      );
    }
  };
  // (Under `defend` the withdrawal runs after the capture passes, once `reconsider` has
  // kept any border this turn's captures make valuable; it still goes first in the orders.)

  // ---- #122: a bonus completed this turn is garrisoned like a held one (rule 1h) ----
  // Its members I held at the start of the turn that face an enemy would otherwise get only the
  // leftover (rule 1c), after every advance had spent the income: live, completed bonuses stood
  // beside enemies on 1-army borders and never paid a turn. So once a capture completes a bonus,
  // its threatened members are held whole right away — before any later capture — when the holds
  // pay for themselves as a held bonus's do (cost ≤ PAYBACK_TURNS × value and ≤ CONCEDE_FACTOR ×
  // its worth) and fit what may still be deployed; otherwise they are left to the leftover as
  // before. Captured members are not garrisoned: next turn's deploys land before any attack.
  /** Bonuses whose garrison was judged (funded or not), so each is judged once. */
  const garrisonJudged = new Set<number>();
  /** Members garrisoned so: like a border rule 1c keeps, the leftover tops them up to a comfortable margin first. */
  const garrisoned = new Set<number>();
  /** Do these deploys fit together what may still be deployed (the budget, and the pools under Local Deployment)? */
  const fitsTogether = (adds: readonly { id: number; d: number }[]): boolean => {
    if (adds.reduce((n, x) => n + x.d, 0) > budget) return false;
    if (!local) return true;
    const next = new Map(deployed);
    for (const x of adds) next.set(x.id, (next.get(x.id) ?? 0) + x.d);
    return chargeDeploys(pools, next).anywhereUsed <= pools.anywhere;
  };
  const garrisonCompleted = () => {
    if (!guarded || !captured.size) return;
    const after = new Set([...mine, ...captured]);
    for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
      if (b.value <= 0 || garrisonJudged.has(b.id)) continue;
      const ts = bonusTerritories(g, b.id);
      if (!ts.length || !ts.every((x) => after.has(x)) || ts.every((x) => mineSet.has(x))) continue;
      garrisonJudged.add(b.id);
      const todo: { id: number; d: number; threat: number }[] = [];
      let have = 0;
      let split = false;
      for (const t of ts) {
        const border = borders.get(t);
        if (!mineSet.has(t) || !border || heldBorders.has(t) || myCommanders.has(t)) continue;
        const stays = stayAt(t) + unitsAt(t);
        let d = 0;
        while ((toTake(stays + d) ?? Infinity) <= border.threat) d++;
        if (!d) continue;
        // No-Split: a deploy on a territory that already issues an order leaves with it.
        if (orderOf(t)) split = true;
        todo.push({ id: t, d, threat: border.threat });
        have += stays;
      }
      if (!todo.length || split) continue;
      const cost = todo.reduce((n, x) => n + x.d, 0);
      const worth = b.value + have / PAYBACK_TURNS;
      if (cost > PAYBACK_TURNS * b.value || cost > CONCEDE_FACTOR * worth || cost > budget - reserve) continue;
      // The pools are checked for the members together: each may fit the free pool on its own
      // while together they overdraw it.
      if (!fitsTogether(todo)) continue;
      for (const x of todo) {
        deploy(x.id, x.d);
        garrisoned.add(x.id);
        heldBorders.add(x.id);
        locked.add(x.id);
        const stays = stayAt(x.id) + unitsAt(x.id);
        rationale.push(
          `Garrison ${label(x.id)} for bonus ${bonusName(b.id)} (+${b.value}), completed this turn: deploy ${x.d} so its ${stays} armies need ${toTake(stays)} to take, above the ~${x.threat} threat — held like a bonus held at the start, before any later capture, not left to the leftover.`,
        );
      }
    }
  };

  // ---- enemy bonuses I could break (under `balanced`) ----
  // A bonus is breakable when every territory in it is visible and held by one enemy, or (#72)
  // when the opponent tracker infers it behind the fog: its track (over at least
  // TRACKED_MIN_TURNS observed turns) lists it in every combination of bonuses that fits the
  // opponent's income gap (all of them listed), or in its single best fit (the first listed, with
  // fewer bonuses than the next), and on this board every member
  // is that opponent's or hidden. Such a break is "probable".
  interface Breakable {
    bonusId: number;
    value: number;
    player: number;
    /** Why an inferred bonus is probably held (absent when every member is visible). */
    probable?: string;
  }
  const breakable: Breakable[] = [];
  const breakMember = new Set<number>();
  if (balanced) {
    for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
      const ts = bonusTerritories(g, b.id);
      if (b.value <= 0 || !ts.length) continue;
      const owners = new Set<number>();
      let visible = true;
      for (const t of ts) {
        const st = state.get(t);
        if (st?.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) visible = false;
        else owners.add(st.owner.playerId);
      }
      if (visible && owners.size === 1) {
        breakable.push({ bonusId: b.id, value: b.value, player: [...owners][0]! });
        for (const t of ts) breakMember.add(t);
        continue;
      }
      // Inferred (#72): one opponent's visible members, the rest hidden, and its track fits it.
      if (owners.size !== 1) continue;
      const player = [...owners][0]!;
      const hiddenOrTheirs = ts.every((t) => {
        const st = ownerShown(state.get(t));
        return st === undefined || (st.owner.kind === 'player' && st.owner.playerId === player);
      });
      if (!hiddenOrTheirs) continue;
      const tr = input.tracks?.find((x) => x.playerId === player);
      const fits = tr && tr.income !== null && tr.turns.length >= TRACKED_MIN_TURNS ? tr.inferred?.candidates : undefined;
      if (!fits?.length) continue;
      // "Every" only when the tracker listed every fit (no "and N more"). The best fit must be
      // strictly smaller than the next: equal-sized fits are ordered only by bonus id.
      const more = tr!.inferred!.more;
      const inEvery = more === 0 && fits.every((c) => c.bonusIds.includes(b.id));
      const single = fits.length === 1 && more === 0;
      const inBest =
        fits[0]!.bonusIds.includes(b.id) && (single || (fits[1] !== undefined && fits[0]!.bonusIds.length < fits[1].bonusIds.length));
      if (!inEvery && !inBest) continue;
      breakable.push({
        bonusId: b.id,
        value: b.value,
        player,
        probable: inEvery
          ? 'in every combination of bonuses that fits its income gap'
          : 'in the best fit of its income gap',
      });
      for (const t of ts) breakMember.add(t);
    }
  }

  // ---- counter-attacks (under `balanced`, #72) ----
  // An enemy stack next to me that shrank since the previous board by attacking me: visible on
  // both boards under the same owner (F1, #69), every neighbour visible on both, one of them a
  // territory I held on both, every neighbour that was neither mine nor its owner's unchanged in
  // owner and armies (else it may have expanded or hit a third player), and the shrink not
  // absorbed by its own neighbours' growth (a transfer). The boards cannot tell its attack on me
  // from my failed attack on it (both shrink it next to me), so the rationale says "fighting me":
  // either way it is cheaper to take now. When it is now cheaper to take than it was, it is a strike candidate scored like
  // a break (rule 4a). A member of a breakable bonus is a break instead.
  interface Counter {
    player: number;
    from: number;
    to: number;
    costNow: number;
    costThen: number;
  }
  const counterAt = new Map<number, Counter>();
  if (balanced && input.previousBoard) {
    const before = new Map(input.previousBoard.territories.map((t) => [t.territoryId, t]));
    const heldBy = (st: TerritoryState | undefined, p: number) => st?.owner.kind === 'player' && st.owner.playerId === p;
    for (const [id, st] of [...state].sort((a, b) => a[0] - b[0])) {
      if (st.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null || breakMember.has(id)) continue;
      const p = st.owner.playerId;
      const ns = neighborsOf(g, id);
      if (!ns.some((n) => mineSet.has(n))) continue;
      const was = visibleState(before.get(id));
      if (!heldBy(was, p) || was!.armies! <= st.armies) continue;
      if (!ns.every((n) => visibleState(state.get(n)) && visibleState(before.get(n)))) continue;
      if (!ns.some((n) => mineSet.has(n) && heldBy(before.get(n), me))) continue;
      // Pinned on me: every neighbour that was neither mine nor theirs keeps its owner and armies.
      // A neutral it took (an expansion) or a third player it hit could have spent the shrink.
      const elsewhere = ns.some((n) => {
        const a = state.get(n)!;
        const b = before.get(n)!;
        if (heldBy(b, me) || heldBy(b, p)) return false;
        const owner = (x: TerritoryState) => (x.owner.kind === 'player' ? x.owner.playerId : x.owner.kind);
        return owner(a) !== owner(b) || a.armies !== b.armies;
      });
      if (elsewhere) continue;
      const absorbed = ns.reduce((sum, n) => {
        const a = state.get(n)!;
        const b = before.get(n)!;
        return heldBy(a, p) && heldBy(b, p) ? sum + Math.max(0, a.armies! - b.armies!) : sum;
      }, 0);
      if (was!.armies! - st.armies <= absorbed) continue;
      const costNow = costAt(id);
      const costThen = costAt(id, was!.armies! + unitsAt(id));
      if (costNow === null || costThen === null || costNow >= costThen) continue;
      counterAt.set(id, { player: p, from: was!.armies!, to: st.armies, costNow, costThen });
    }
  }

  // ---- 2. targets ----
  const targets = new Map<number, Target>();
  for (const t of [...g.territoryById.keys()].sort(byNum)) {
    if (mineSet.has(t)) continue;
    const sources = neighborsOf(g, t).filter((n) => mineSet.has(n));
    if (!sources.length) continue;
    const st = state.get(t);
    if (!st || st.owner.kind === 'unknown' || st.armies === null) {
      warnings.push(
        `Fogged territory ${label(t)} borders my ${sources.map(label).join(', ')}: its armies are unknown (fog), so no attack is planned.`,
      );
      continue;
    }
    if (st.owner.kind === 'available') continue;
    // A teammate's territory is never a target (#128).
    if (st.owner.kind === 'player' && !foe(st.owner.playerId)) continue;
    if (uncounted(t)) {
      warnings.push(
        `${label(t)} holds ${uncountedKind(t)}, whose strength the board does not carry: its defence is unknown, so no attack is planned on it.`,
      );
      continue;
    }
    const enemy = st.owner.kind === 'player';
    if (enemy && goal !== 'complete-bonus' && !(balanced && (breakMember.has(t) || counterAt.has(t)))) continue;
    const cost = costAt(t);
    if (cost === null) continue;
    targets.set(t, { id: t, cost, enemy, sources });
  }

  // Bonus passes work toward my own bonuses; under `balanced` enemy targets are only break candidates.
  const bonusTarget = (t: number) => targets.has(t) && !(balanced && targets.get(t)!.enemy);

  // ---- 4d. frontier cost (#71) ----
  /** Armies a capture of `t` leaves there: its attack's survivors. */
  const survivorsOf = (t: number) => targets.get(t)!.cost - Math.round((defenceAt(t) * rates.defensiveKillRate) / 100);
  /**
   * `x` as a border when I hold `held` with `have` armies on it: a border when a neighbour is not
   * held; facing an enemy when a visible enemy is next to it, and then `need` is the deploys it
   * needs next turn to hold (the R3 arithmetic: threat = movable + max(deploy, growth) per player).
   */
  const borderOf = (x: number, held: ReadonlySet<number>, have: number) => {
    if (neighborsOf(g, x).every((n) => held.has(n))) return { border: false, enemy: false, need: 0 };
    const th = threatAt(x, (n) => held.has(n));
    if (!th) return { border: true, enemy: false, need: 0 };
    const units = mineSet.has(x) ? unitsAt(x) : 0;
    return { border: true, enemy: true, need: Math.max(0, holdArmies(th.threat) - have - units) };
  };
  /**
   * A border's cost in armies: {@link NEUTRAL_BORDER_COST}, plus its hold need when it faces an
   * enemy under a guarded goal (`expand` and `complete-bonus` ignore defence, as in R3).
   */
  const borderCost = (b: ReturnType<typeof borderOf>, withNeed = true) =>
    b.border ? NEUTRAL_BORDER_COST + (guarded && withNeed ? b.need : 0) : 0;
  /**
   * The marginal frontier of adding `adds` to `base` (#71), in armies: the cost of every border
   * the capture touches after it (the captures and their held neighbours) minus their cost
   * before. Borders it opens add, borders it closes (a neighbour whose last outside neighbour it
   * takes) subtract. `haveOf` gives the armies on each territory (a capture: its survivors).
   * `needOnAdds` false leaves the captures' own hold need out (R3's defence cost already counts it).
   */
  const frontierDelta = (
    base: ReadonlySet<number>,
    adds: readonly number[],
    haveOf: (x: number) => number,
    needOnAdds = true,
  ) => {
    const after = new Set([...base, ...adds]);
    const touched = new Set(adds);
    for (const t of adds) for (const n of neighborsOf(g, t)) if (base.has(n)) touched.add(n);
    let armies = 0;
    let enemy = 0;
    for (const x of touched) {
      const now = borderOf(x, after, haveOf(x));
      armies += borderCost(now, needOnAdds || base.has(x));
      enemy += Number(now.enemy);
      if (!base.has(x)) continue;
      const was = borderOf(x, base, haveOf(x));
      armies -= borderCost(was);
      enemy -= Number(was.enemy);
    }
    return { armies, enemy };
  };
  /** Each target's frontier cost captured alone from my holdings at the start of the turn. */
  const edgeCost = new Map(
    [...targets.keys()].map((t) => [t, frontierDelta(mineSet, [t], (x) => (x === t ? survivorsOf(t) : armiesOf(x))).armies]),
  );
  /** A capture's cost in a score: its armies plus its frontier, at least one army (a cost of 0 stays 0). */
  const scoreCost = (cost: number, frontier: number) => (cost > 0 ? Math.max(1, cost + frontier) : 0);
  /** A target's cost in a score: its capture cost plus the frontier it adds alone. */
  const targetScoreCost = (t: number) => scoreCost(targets.get(t)!.cost, edgeCost.get(t)!);
  /**
   * A break's or counter-attack's cost in a score (#72): it only has to land, not survive the
   * counter-attack, so the captured territory's own hold need is left out. The rest of the
   * frontier change stays: its border weight, and my borders around it (the threat it removes).
   */
  const landScoreCost = (t: number) =>
    scoreCost(
      targets.get(t)!.cost,
      frontierDelta(mineSet, [t], (x) => (x === t ? survivorsOf(t) : armiesOf(x)), false).armies,
    );

  // ---- offence report (#72) ----
  /** The offensive options considered, by kind and target, in the order they were found. */
  const offence = new Map<string, OffenceEntry & { bonusId?: number }>();
  /** Why an offensive capture was not made, by target (the first reason wins). */
  const offenceSkip = new Map<number, string>();
  const skipOffence = (t: number, why: string) => {
    if (!offenceSkip.has(t)) offenceSkip.set(t, why);
  };
  /** Captures of a player's territory refused as a trade below even (rule 0p.3), by target. */
  const badTrades = new Map<number, { lost: number; killed: number }>();
  /**
   * The frontier when I hold `held`: borders, those facing an enemy, and the deploys they need next
   * turn to hold. A conceded border counts as a border but not in the hold cost: the plan gives it
   * up rather than pay for it (a garrison that still stands, #59, is held and counts).
   */
  const frontierOf = (held: ReadonlySet<number>, haveOf: (x: number) => number) => {
    let borders = 0;
    let enemyBorders = 0;
    let holdCost = 0;
    for (const x of [...held].sort(byNum)) {
      const b = borderOf(x, held, haveOf(x));
      borders += Number(b.border);
      enemyBorders += Number(b.enemy);
      if (!conceded.has(x) || stood.has(x)) holdCost += b.need;
    }
    return { borders, enemyBorders, holdCost };
  };
  /** The frontier's hold cost at the start of the turn (my armies then; today's concessions left out). */
  const startHold = () => frontierOf(mineSet, armiesOf).holdCost;

  // ---- bonus scoring ----
  /** "N armies to finish", naming the fogged members counted in it (#101). */
  const fogNote = (fogged: number, each: number) =>
    fogged ? ` (${fogged} fogged member${fogged === 1 ? '' : 's'} counted at ${each} each)` : '';
  const toFinish = (cost: number, fogged: number, each: number) => `${cost} armies to finish${fogNote(fogged, each)}`;
  const plans: BonusPlan[] = [];
  /** #167: the share of the map's territories that started as wastelands, and what one costs to take and loses. */
  const wasteShare =
    s.wastelands && s.wastelands.count > 0 && s.wastelands.size > 0 && g.territoryById.size > 0
      ? Math.min(1, s.wastelands.count / g.territoryById.size)
      : 0;
  const wasteCost = wasteShare > 0 ? (costOf(s.wastelands!.size) ?? Infinity) : 0;
  const wasteLoss = wasteShare > 0 ? Math.min(wasteCost - 1, straightKills(s.wastelands!.size, rates.defensiveKillRate)) + 1 : 0;
  /** Every positive bonus worth completing (net > 0) still missing members: its armies to finish (rule 4e). */
  const finishCost = new Map<number, { cost: number; value: number; net: number; fogged: number; fogEach: number }>();
  const economicMember = new Set<number>();
  const uneconomicMember = new Set<number>();
  /** Missing members of a negative bonus (not focused): plain expansion never steps into one. */
  const negativeMember = new Set<number>();
  for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
    const isFocus = focus.has(b.id);
    const ts = bonusTerritories(g, b.id);
    const remaining = ts.filter((t) => !mineSet.has(t));
    if (b.value < 0 && !isFocus) {
      // Completing it would cut income: never plan into it (an economic
      // membership elsewhere still wins — see the pass-3 filter).
      for (const t of remaining) {
        uneconomicMember.add(t);
        negativeMember.add(t);
      }
      continue;
    }
    if (b.value <= 0 && !isFocus) continue;
    if (!remaining.length) continue;
    // Cluster as a unit (#70): the negative bonuses its missing members complete come off its
    // worth (on a map without negative bonuses, net = value).
    const rest = new Set(remaining);
    const penalties = completedOver((x) => mineSet.has(x) || rest.has(x), remaining).filter((id) => id !== b.id && g.bonusById.get(id)!.value < 0);
    const penalty = penalties.reduce((n, id) => n + g.bonusById.get(id)!.value, 0);
    // #125: its missing members' per-territory income (Extra Armies for Territories) is income too.
    const perGain = territoryShare(remaining.length);
    const net = b.value + penalty + perGain;
    if (penalty < 0 && remaining.some(bonusTarget))
      rationale.push(
        `Bonus ${b.name} (#${b.id}) (+${b.value}) is worth +${net} net once complete: its missing members also complete ${penalties.length} negative bonus${penalties.length === 1 ? '' : 'es'} (${penalty}), and each step short of completion only adds penalties.`,
      );
    if (net <= 0 && !isFocus) {
      for (const t of remaining) uneconomicMember.add(t);
      if (remaining.some(bonusTarget))
        rationale.push(`Skip bonus ${b.name} (#${b.id}): completing it costs more income than it pays (net ${net}).`);
      continue;
    }
    // Armies to finish (#101): every missing member's capture cost. A fogged member counts at its
    // bonus's costliest visible missing member (it cannot be costed, and counting it as free made
    // the figure jump when it came into view); with none visible, the bonus cannot be costed.
    let cost = 0;
    let worst = 0;
    let fogged = 0;
    // #125: the economy test charges the armies lost, not the armies sent.
    let loss = 0;
    let worstLoss = 0;
    for (const t of remaining) {
      const st = state.get(t);
      if (!st || st.owner.kind === 'unknown' || st.armies === null) {
        fogged++;
        continue;
      }
      const c = costAt(t) ?? Infinity;
      cost += c;
      worst = Math.max(worst, c);
      const l = econCostAt(t);
      loss += l;
      worstLoss = Math.max(worstLoss, l);
    }
    let fogEach = fogged ? (fogged < remaining.length ? worst : Infinity) : 0;
    let fogLoss = fogged ? (fogged < remaining.length ? worstLoss : Infinity) : 0;
    // #167: with automatic Wastelands, a fogged member may be one: its expected surcharge over an
    // ordinary member is (wastelands ÷ territories on the map) × (a wasteland's cost − this one's).
    if (wasteShare > 0 && fogged && Number.isFinite(fogEach)) {
      const extra = Math.ceil(wasteShare * Math.max(0, wasteCost - fogEach));
      const extraLoss = Math.ceil(wasteShare * Math.max(0, wasteLoss - fogLoss));
      if (extra > 0) {
        fogEach += extra;
        fogLoss += extraLoss;
        if (remaining.some(bonusTarget))
          rationale.push(
            `${b.name} (#${b.id}): its ${fogged} fogged member${fogged === 1 ? '' : 's'} may be ${fogged === 1 ? 'a wasteland' : 'wastelands'} (${s.wastelands!.count} of the map's ${g.territoryById.size} territories start at ${s.wastelands!.size}): +${extra * fogged} armies expected.`,
          );
      }
    }
    cost += fogged * fogEach;
    loss += fogged * fogLoss;
    if (b.value > 0) finishCost.set(b.id, { cost, value: b.value, net, fogged, fogEach });
    const economic = isFocus || (loss <= PAYBACK_TURNS * net && worstLoss <= WASTELAND_FACTOR * net);
    for (const t of remaining) (economic ? economicMember : uneconomicMember).add(t);
    if (!remaining.some(bonusTarget)) continue;
    if (!economic) {
      rationale.push(
        `Skip bonus ${b.name} (#${b.id}): uneconomic for +${net === b.value ? b.value : `${b.value} (net +${net})`} (${toFinish(cost, fogged, fogEach)}, losing ~${loss}; ${worstLoss} lost on its costliest territory).`,
      );
      continue;
    }
    // R3: what holding the completed bonus's frontier would cost next turn (each
    // remaining member holding the survivors of its capture, mine their armies now).
    let defenseCost = 0;
    if (guarded && remaining.every(bonusTarget)) {
      const rem = new Set(remaining);
      const exposed = exposure(ts, (n) => rem.has(n), (m) => {
        if (!rem.has(m)) return armiesOf(m);
        const c = targets.get(m)!.cost;
        return c - straightKills(defenceAt(m), rates.defensiveKillRate);
      });
      defenseCost = exposed.reduce((sum, e) => sum + e.need, 0);
      if (defenseCost > 0)
        rationale.push(
          `Bonus ${b.name} (#${b.id}) needs ~${defenseCost} more armies next turn to hold its frontier once completed (${exposed.map((e) => `${label(e.id)} ${e.need}`).join(', ')}): its score is +${b.value} / (${cost} + ${DEFENSE_DISCOUNT} × ${defenseCost}).`,
        );
    }
    // #71: the frontier its missing members add (their hold need left out when R3 judged it).
    const reach = remaining.filter((t) => targets.has(t));
    const frontier = frontierDelta(
      mineSet,
      reach,
      (x) => (mineSet.has(x) ? armiesOf(x) : survivorsOf(x)),
      !(guarded && remaining.every(bonusTarget)),
    ).armies;
    plans.push({
      bonusId: b.id,
      value: b.value,
      focus: isFocus,
      remaining,
      completable: remaining.every(bonusTarget),
      cost,
      borders: analyzeBonus(g, b.id)!.borderTerritoryIds.length,
      defenseCost,
      net,
      frontier,
      fogged,
      fogEach,
    });
  }
  const ratio = (p: BonusPlan) => {
    const cost = scoreCost(p.cost + DEFENSE_DISCOUNT * p.defenseCost, p.frontier);
    return cost > 0 ? p.net / cost : Infinity;
  };
  plans.sort(
    (a, b) =>
      Number(b.focus) - Number(a.focus) || ratio(b) - ratio(a) || a.borders - b.borders || a.bonusId - b.bonusId,
  );
  const bonusName = (id: number) => `${g.bonusById.get(id)!.name} (#${id})`;

  // ---- #101: commit to the closest bonus ----
  // While no bonus is held (and in the opening and expansion phases), expansion goes to the bonus
  // closest to completion — fewest turns to finish at this income (its armies to finish, counting
  // the members I hold, over the income) — then the next closest, instead of one capture into each
  // of several large bonuses by value per army. Bonuses as close as each other keep the score order
  // (value per army, rule 4), except that a bonus advanced last turn (a member captured since
  // `previousBoard`) keeps priority unless another is strictly closer. Focused bonuses come first.
  const holdsBonus = g.map.bonuses.some((b) => {
    const ts = bonusTs.get(b.id)!;
    return b.value > 0 && ts.length > 0 && ts.every((t) => mineSet.has(t));
  });
  // #132: in an FFA, contact with one front still leaves neutrals to expand into: keep committing
  // while any neutral borders a territory of mine.
  const neutralsInReach =
    profile.format === 'ffa' && mine.some((t) => neighborsOf(g, t).some((n) => state.get(n)?.owner.kind === 'neutral'));
  const committing = !holdsBonus || profile.phase === 'opening' || profile.phase === 'expansion' || neutralsInReach;
  const advancedLast = new Set<number>();
  if (input.previousBoard) {
    const before = new Map(input.previousBoard.territories.map((t) => [t.territoryId, t]));
    for (const p of plans) {
      const took = bonusTs.get(p.bonusId)!.some((t) => {
        const o = before.get(t)?.owner;
        return mineSet.has(t) && o !== undefined && o.kind !== 'unknown' && !(o.kind === 'player' && o.playerId === me);
      });
      if (took) advancedLast.add(p.bonusId);
    }
  }
  /**
   * #125: the layers a bonus's missing members are reached in — the farthest one's distance from
   * what I hold. A capture's armies attack no further this turn, so a chain takes a turn a layer
   * however cheap its members are.
   */
  const fromMine = bfsDistances(g, mine);
  const depthOf = (p: BonusPlan) => Math.max(0, ...p.remaining.map((t) => fromMine.get(t) ?? 0));
  /** Turns to finish a bonus at this income, and at least its depth (with no income, its armies to finish). */
  const turnsOf = (p: BonusPlan) => (income > 0 ? Math.max(Math.ceil(p.cost / income), depthOf(p)) : p.cost);
  const scoreRank = new Map(plans.map((p, i) => [p.bonusId, i]));
  /** Bonus plans closest to completion first (focus first; ties: advanced last turn, then the score order). */
  const byCloseness = committing
    ? [...plans].sort(
        (a, b) =>
          Number(b.focus) - Number(a.focus) ||
          turnsOf(a) - turnsOf(b) ||
          Number(advancedLast.has(b.bonusId)) - Number(advancedLast.has(a.bonusId)) ||
          scoreRank.get(a.bonusId)! - scoreRank.get(b.bonusId)!,
      )
    : plans;
  const turnsText = (p: BonusPlan) => {
    const n = turnsOf(p);
    const deep = n > Math.ceil(p.cost / income) ? ` (${n} layers deep)` : '';
    return income > 0 ? `${n} turn${n === 1 ? '' : 's'}${deep}` : 'no income';
  };
  if (committing && byCloseness.length > 1) {
    const why = holdsBonus
      ? `${profile.phase[0]!.toUpperCase()}${profile.phase.slice(1)} phase${
          profile.phase === 'opening' || profile.phase === 'expansion' ? '' : ', neutrals in reach'
        }`
      : 'No bonus held';
    rationale.push(
      `${why}: expansion goes to the bonus closest to completion first — ${byCloseness
        .map(
          (p, i) =>
            `${bonusName(p.bonusId)} ${i ? p.cost : `${p.cost} armies to finish`}${fogNote(p.fogged, p.fogEach)}, ${turnsText(p)}${i || income <= 0 ? '' : ` at income ${income}`}`,
        )
        .join(', ')} — and a farther bonus gets only armies the closer ones cannot use.`,
    );
    const top = byCloseness.find((p) => !p.focus);
    for (const p of byCloseness.filter((x) => advancedLast.has(x.bonusId))) {
      if (p === top)
        rationale.push(
          `${bonusName(p.bonusId)} keeps priority: I advanced it last turn, and no bonus is strictly closer to completion.`,
        );
      else if (top && !p.focus && turnsOf(top) < turnsOf(p))
        rationale.push(
          `${bonusName(p.bonusId)}, advanced last turn, gives way to ${bonusName(top.bonusId)}: it is strictly closer to completion (${turnsText(top)} to finish against ${turnsText(p)}).`,
        );
    }
  }
  /**
   * A break's retake check, by its target: the warning it raised (if any) and what it was
   * judged on, so a top-up that adds survivors re-judges it.
   */
  const retakeChecks = new Map<number, { bonusId: number; survivors: number; counter: number; warning?: string }>();
  const retakeWarning = (t: number, bonusId: number, survivors: number, counter: number): string | undefined => {
    const take = toTake(survivors);
    return take !== null && take <= counter
      ? `${label(t)} can be retaken after it breaks ${bonusName(bonusId)}: ${survivors} survivors need ${take} to take, against ~${counter} next turn.`
      : undefined;
  };

  // ---- R3: a completion must leave a frontier I can hold ----
  /**
   * "Not completed" warning and rationale, by bonus: kept outside `warnings`/`rationale`
   * so a rolled-back pass cannot drop them. A refusal is not final — the next income
   * grows as other bonuses complete — so they are emitted at the end only for bonuses
   * the plan did not complete after all.
   */
  const notCompleted = new Map<number, { warning: string; why: string }>();
  /**
   * Called with `t` just captured (`survivors` armies move in): for every bonus this
   * capture completes, the deploys its exposed members still need next turn to
   * hold must fit my projected next income (plus this turn's leftover, for members
   * I held at the start: a fresh capture cannot be deployed to). Otherwise the
   * bonus is lost immediately: refused under `balanced`/`defend`, warned otherwise.
   * The total need is checked, not each member alone: holding the bonus needs every
   * exposed member held. The leftover is as of this check; a later capture this turn
   * may still spend it (defence funds held borders first, so this is rarely material).
   */
  const defensible = (t: number, survivors: number): boolean => {
    const after = new Set([...mine, ...captured]);
    const completes = g.map.bonuses
      .filter((b) => {
        const ts = bonusTerritories(g, b.id);
        return b.value > 0 && ts.includes(t) && ts.every((x) => after.has(x));
      })
      .sort((a, b) => a.id - b.id);
    if (!completes.length) return true;
    const nextIncome = keptIncome(after);
    const spare = Math.max(0, budget - reserve);
    const stays = (m: number) => {
      if (mineSet.has(m)) return avail.get(m)! + guard + (incoming.get(m) ?? 0);
      if (m === t) return survivors;
      // An earlier capture this turn: the survivors of its finishing attack.
      return survivorsAt.get(m) ?? 0;
    };
    /**
     * #128: what holding `m` next turn needs that it would not have needed anyway. A member I held
     * at the start that is exposed either way (its armies before any attack leaves it, against the
     * threat without this turn's captures) only adds its need beyond that: refusing the completion
     * would not save it.
     */
    const either = (m: number) => {
      if (!mineSet.has(m)) return 0;
      const th = threatAt(m, (n) => captured.has(n) && n !== t && !mineSet.has(n));
      if (!th) return 0;
      return Math.max(0, holdArmies(th.threat) - armiesOf(m) - (deployed.get(m) ?? 0) - unitsAt(m));
    };
    const exposedOf = (id: number) =>
      exposure(bonusTerritories(g, id), (n) => captured.has(n), stays).map((e) => ({ ...e, added: Math.max(0, e.need - either(e.id)) }));
    // #128: every bonus this turn's earlier captures completed shares the same next income — two
    // completions that each fit it may not fit it together.
    const ids = new Set(completes.map((b) => b.id));
    const earlier = new Map<number, number>();
    for (const e of completedBy(after)
      .filter((id) => !ids.has(id) && g.bonusById.get(id)!.value > 0 && !bonusTs.get(id)!.every((x) => mineSet.has(x)))
      .flatMap(exposedOf))
      earlier.set(e.id, Math.max(earlier.get(e.id) ?? 0, e.added));
    let ok = true;
    for (const b of completes) {
      const exposed = exposedOf(b.id);
      const total = exposed.reduce((sum, e) => sum + e.added, 0);
      const before = [...earlier].reduce((n, [id, need]) => n + (exposed.some((e) => e.id === id) ? 0 : need), 0);
      const held = exposed.filter((e) => mineSet.has(e.id)).reduce((sum, e) => sum + e.added, 0);
      const anyway = exposed.filter((e) => e.added < e.need);
      // A completion that adds no exposure (total 0) is never refused: refusing it saves nothing,
      // whatever the earlier completions need (it only adds income).
      if (total === 0 || total + before <= nextIncome + Math.min(spare, held)) {
        if (anyway.length && guarded)
          rationale.push(
            `Complete bonus ${bonusName(b.id)} though ${anyway.map((e) => label(e.id)).join(', ')} may fall next turn: ${anyway.length === 1 ? 'it is' : 'they are'} exposed whether or not it is completed, so refusing would save nothing.`,
          );
        continue;
      }
      const worst = [...exposed].sort((a, b) => b.added - a.added || b.need - a.need || a.id - b.id)[0]!;
      const head = `completing ${bonusName(b.id)} leaves ${label(worst.id)} indefensible (player ${worst.player} can take it for ${worst.take}; next income ${nextIncome})`;
      if (guarded) {
        if (!notCompleted.has(b.id)) {
          notCompleted.set(b.id, {
            warning: `${head}: not completed`,
            why: `Do not complete bonus ${bonusName(b.id)}: holding its frontier next turn needs ${total} more armies (${exposed.map((e) => `${label(e.id)} ${e.added}`).join(', ')})${before ? `, on top of the ${before} this turn's other completions need` : ''}, more than the next income of ${nextIncome}${held ? ` plus the ${Math.min(spare, held)} left this turn` : ''}, so it would fall next turn; the armies stay for defence.`,
          });
        }
        ok = false;
      } else {
        const w = `${head}: completed anyway (goal ${goal} ignores defence)`;
        if (!warnings.includes(w)) warnings.push(w);
      }
    }
    return ok;
  };

  // ---- No-Split: the whole stack moves (#124) ----
  /** Territories a pass assumes fall this turn (finishing a player off): they threaten nothing. */
  let assumeGone: (n: number) => boolean = () => false;
  interface MustHold {
    from: number;
    value: number;
    stays: number;
    threat: number;
  }
  /**
   * No-Split (#124): an order sends `x`'s whole stack, so only the guard (and armies withdrawn into
   * it) stay. `x` must hold — it issues no order — when it protects something (a bonus, income, my
   * commander), is not conceded, and what stays would fall to the visible threat left once this
   * turn's captures land. The target `t` stops threatening only when the `sent` armies take it for
   * sure even if its owner deploys there first. `null` when the order may go (always with No-Split off).
   */
  const mustHold = (x: number, t: number, sent: number): MustHold | null => {
    if (!noSplit || conceded.has(x)) return null;
    const value = valueOf(x);
    if (value <= 0 && !myCommanders.has(x)) return null;
    const st = state.get(t);
    const owner = st?.owner.kind === 'player' && foe(st.owner.playerId) ? st.owner.playerId : undefined;
    const sure = owner === undefined || (captureCost(defenceAt(t) + deployOf(owner), s) ?? Infinity) <= sent;
    const b = borderAt(x, (n) => captured.has(n) || assumeGone(n) || (n === t && sure));
    if (!b) return null;
    const stays = guard + (incoming.get(x) ?? 0);
    if ((toTake(stays + unitsAt(x)) ?? Infinity) > b.threat) return null;
    return { from: x, value, stays, threat: b.threat };
  };
  /** A No-Split warning: `h.from` must hold, so `what` is not planned. Never repeated. */
  const warnHold = (h: MustHold, what: string) => {
    const w = `No-Split: ${label(h.from)} must hold (${h.value > 0 ? `protects +${h.value}` : 'my commander stands there'}): an order would send its whole stack, leaving ${h.stays} against the ~${h.threat} threat, so ${what}.`;
    if (!warnings.includes(w)) warnings.push(w);
  };

  // ---- capture helper ----
  let anchor: number | undefined;
  /** Why the last {@link tryCapture} refused (R3, No-Split on a source that could take it); else size. */
  let refusal:
    | { kind: 'r3' }
    | { kind: 'split'; from: number }
    | { kind: 'trade'; lost: number; killed: number }
    | ({ kind: 'must-hold' } & MustHold)
    | undefined;
  /**
   * Rule 4e in contact (#107): a capture of a player's territory must trade at least even. Set while
   * the fallback tries an enemy capture; a combined capture that loses more than it kills is then
   * refused (as when behind on armies, rule 0p.3), and {@link belowEven} says by how much.
   */
  let evenTradesOnly = false;
  let belowEven: { lost: number; killed: number } | undefined;
  /**
   * Armies on my `x` free to attack `t`: my commander's territory keeps what holds it (rule 1k),
   * and so does a border that held at the start of the turn and is not conceded (#121: one surplus
   * per territory — a capture never spends the garrison that holds a safe border).
   */
  const movableFor = (x: number, t: number) => avail.get(x)! - keepOf(x, t);
  /**
   * Set only while rule 4e retries a step that failed on its size, to name the border it would
   * have stripped (its hold check then reports it, as before #121).
   */
  let spendKeeps = false;
  /**
   * What `x` keeps back from an attack on `t` (see {@link movableFor}), and (#172) what a stack two
   * steps away needs it to keep — the larger, never both; an attack on the territory in between
   * cuts that reach.
   */
  const keepOf = (x: number, t: number) => {
    const near = myCommanders.has(x) || (!spendKeeps && safeAtStart.has(x) && !conceded.has(x)) ? keepFor(x, (n) => n === t) : 0;
    const far = spendKeeps || pass.relaxAttacks ? 0 : twoStepKeep(x, (n) => n === t);
    if (far > near) twoStepBound.add(x);
    // #179: a covered exit keeps its cover whatever the pass (conceded or not, keeps spent or not).
    return Math.max(near, far, coverOf(x));
  };
  /**
   * A conceded border attacks out only with the armies already on it (it is never deployed to),
   * unless every territory I hold is conceded, when there is nowhere better, or (#122) the capture
   * completes a bonus the border is in: rule 1c then keeps it, so it is not given up.
   */
  const concededSource = (x: number, t: number, cost: number) =>
    movableFor(x, t) >= cost ||
    mine.every((id) => conceded.has(id)) ||
    g.map.bonuses.some((b) => {
      const ts = bonusTerritories(g, b.id);
      return b.value > 0 && ts.includes(x) && ts.includes(t) && ts.every((y) => y === t || mineSet.has(y) || captured.has(y));
    });
  /** Enemy commanders' territories attacked as a commander strike (rule 1s): exempt from R3. */
  const strikes = new Set<number>();
  /**
   * Defenders assumed at a target attacked to finish its owner off: its armies plus that
   * owner's full deploy estimate (the worst case). Other targets: their armies now.
   */
  const worstCase = new Map<number, number>();
  /** Players this plan eliminates (rule 1e, every territory taken for sure), for the move-order caveat (#127). */
  const finishedOff = new Set<number>();
  const defendersAt = (t: number) => worstCase.get(t) ?? defenceAt(t);
  /**
   * Capture `t` from its best source. A conceded border is never deployed to: it attacks
   * out only with the armies already on it (unless every territory I hold is conceded,
   * when there is nowhere better). `force` names the source (it may be locked) and the
   * armies on it that stay out of the attack. `fromConceded` (rule 4e only) names the one conceded
   * border that may attack out with deploys too: they leave with the attack.
   */
  const tryCapture = (
    t: number,
    reason: string,
    force?: { from: number; keep: number },
    fromConceded?: number,
  ): boolean => {
    refusal = undefined;
    if (spared.has(t)) return false;
    const tg = targets.get(t)!;
    // My commander's territory keeps what holds it (rule 1k). Under No-Split nothing is kept: the
    // whole stack moves, and a territory that must hold issues no order (#124).
    const spare = (x: number) => (noSplit ? avail.get(x)! : force ? avail.get(x)! - Math.max(force.keep, coverOf(x)) : movableFor(x, t));
    if (force && orderOf(force.from)) return false;
    /** No-Split: why `x` must hold instead (it would send at least the capture's cost). */
    const held = (x: number) => mustHold(x, t, Math.max(avail.get(x)!, tg.cost));
    if (force) {
      // The caller says why (another source may still take it).
      const h = held(force.from);
      if (h) {
        refusal = { kind: 'must-hold', ...h };
        return false;
      }
    }
    const open = (x: number) =>
      !locked.has(x) && (!conceded.has(x) || x === fromConceded || concededSource(x, t, tg.cost));
    // No-Split (#124): a covered exit (#179) issues no order — it would send its whole stack.
    const usable = (x: number) => open(x) && !held(x) && !(noSplit && coverOf(x) > 0);
    const sources = force
      ? [force.from]
      : tg.sources.filter((x) => usable(x) && !orderOf(x)).sort((a, b) => avail.get(b)! - avail.get(a)! || a - b);
    const needAt = (x: number) => Math.max(0, tg.cost - spare(x));
    // Sorted by armies, the first source needs the fewest deploys; under Local Deployment
    // another may have more room (its bonus pool), so take the first that can afford it.
    const src = local ? (sources.find((x) => needAt(x) <= spareAt(x)) ?? sources[0]) : sources[0];
    const need = src === undefined ? Infinity : needAt(src);
    // No single source can afford it: try a combined capture (never for a forced source).
    if (src === undefined || need > spareAt(src)) {
      if (force) return false;
      if (tryCombined(t, reason)) return true;
      const trade = belowEven;
      // No-Split: name a source that could have taken it alone but already issues an order.
      // Its order already carries its whole stack (#124): count that stack as what it could have sent.
      const split = tg.sources.find(
        (x) => usable(x) && orderOf(x) && Math.max(0, needAt(x) - orderOf(x)!.armies) <= spareAt(x),
      );
      // No-Split: or one that could, but must hold its border (#124).
      const holder = split === undefined ? tg.sources.find((x) => open(x) && !orderOf(x) && held(x) && needAt(x) <= spareAt(x)) : undefined;
      if (split !== undefined) {
        warnSplit(split, `the attack on ${label(t)} is not planned`);
        refusal = { kind: 'split', from: split };
      } else if (holder !== undefined) {
        const h = held(holder)!;
        warnHold(h, `the attack on ${label(t)} is not planned`);
        refusal = { kind: 'must-hold', ...h };
      } else if (trade) refusal = { kind: 'trade', ...trade };
      return false;
    }
    // #121: the deploys beyond what the attack alone needs keep a safe border holding.
    const forHold = noSplit || force ? 0 : Math.min(need, keepOf(src, t));
    // #172: the source keeps what a stack two steps away needs (when that binds, not its border's hold).
    const far = noSplit || force || spendKeeps || pass.relaxAttacks ? null : twoStepHold(src, (n) => n === t);
    const farKeep = far ? twoStepKeep(src, (n) => n === t) : 0;
    const farBinds = far !== null && farKeep > 0 && farKeep >= keepOf(src, t);
    deploy(src, need);
    // No-Split: the whole stack goes, every army deployed there so far included (#124).
    const sent = noSplit ? Math.max(tg.cost, avail.get(src)!) : tg.cost;
    avail.set(src, avail.get(src)! - sent);
    captured.add(t);
    const survivors = sent - straightKills(defendersAt(t), rates.defensiveKillRate);
    // A commander strike is never refused by R3: killing the commander eliminates a player.
    if (!strikes.has(t) && !defensible(t, survivors)) {
      // Undo: under a guarded goal a bonus that falls next turn is not completed.
      avail.set(src, avail.get(src)! + sent - need);
      const left = (deployed.get(src) ?? 0) - need;
      if (left > 0) deployed.set(src, left);
      else deployed.delete(src);
      budget += need;
      captured.delete(t);
      refusal = { kind: 'r3' };
      return false;
    }
    survivorsAt.set(t, survivors);
    captureOrder.push(t);
    captureUndo.set(t, () => avail.set(src, avail.get(src)! + sent));
    moves.push({ from: src, to: t, armies: sent, kind: 'attack', reason, winChance: chanceOf(sent, defenceAt(t)) });
    if (tg.enemy && !worstCase.has(t))
      warnings.push(`Attack on enemy ${label(t)} assumes its owner does not reinforce it first.`);
    rationale.push(
      `Attack ${label(t)} from ${label(src)} with ${sent}${need ? ` (deploy ${need} there)` : ''}${
        sent > tg.cost ? `, the whole stack (No-Split; ${tg.cost} would take it)` : ''
      }: ${reason}.`,
    );
    if (farBinds) rationale.push(twoStepCite(src, far!, (c) => `The attack on ${label(t)} leaves ${label(src)} ${c}.`));
    else if (forHold > 0) {
      const th = borderAt(src, (n) => captured.has(n));
      if (th)
        rationale.push(
          `Deploy ${forHold} to ${label(src)} so it still holds its border after the attack on ${label(t)} (${stayAt(src)} stay against a threat of ${th.threat}).`,
        );
    }
    return true;
  };
  if (reserve) rationale.push(`Hold a reserve of ${reserve} out of captures.`);

  // ---- 3a. combined (multi-source) captures (R4) ----
  interface Softener {
    from: number;
    armies: number;
    kills: number;
    /** Defenders left when it attacks. */
    before: number;
    /** Its attack fails by design: these return home. */
    survivors: number;
  }
  interface Combined {
    softeners: Softener[];
    finisher: number;
    armies: number;
    /** Deploys the finisher needs. */
    need: number;
    /** Defenders left for the finisher. */
    left: number;
    survivors: number;
  }
  /**
   * The cheapest combined capture of `t` (fewest sources) under exact 0%-luck,
   * straight-round arithmetic, or `null` when even every eligible source together
   * (plus the deploys left) cannot take it.
   */
  const combinedPlan = (t: number): Combined | null => {
    const tg = targets.get(t)!;
    // A commander takes no partial damage, so softening one is not plain arithmetic: never combined.
    if (unitsAt(t) > 0) return null;
    const eligible = tg.sources
      .filter(
        (x) =>
          !locked.has(x) &&
          !conceded.has(x) &&
          !myCommanders.has(x) &&
          avail.get(x)! > 0 &&
          !orderOf(x) &&
          !(noSplit && coverOf(x) > 0) &&
          !mustHold(x, t, avail.get(x)!),
      )
      .sort((a, b) => avail.get(b)! - avail.get(a)! || a - b);
    const off = rates.offensiveKillRate;
    const def = rates.defensiveKillRate;
    for (let k = 2; k <= eligible.length; k++) {
      const finisher = eligible[0]!;
      let left = defendersAt(t);
      // The defenders there now: under a worst case (more assumed) a softener must not take
      // it either if the reinforcement never comes.
      let real = armiesOf(t);
      const softeners: Softener[] = [];
      for (const x of eligible.slice(1, k).sort(byNum)) {
        // Never kill the last defender: the finisher's attack is the one that moves in. Under
        // No-Split the whole stack goes (#124): a stack that would kill the last one is no softener.
        // #121: a safe border keeps what holds it (its survivors come home, but may arrive late).
        let a = noSplit ? avail.get(x)! : Math.min(avail.get(x)!, movableFor(x, t));
        while (a > 0 && straightKills(a, off) >= Math.min(left, real)) {
          if (noSplit) a = 0;
          else a--;
        }
        const kills = straightKills(a, off);
        if (a <= 0 || kills <= 0) continue;
        const lost = Math.min(a, straightKills(left, def));
        softeners.push({ from: x, armies: a, kills, before: left, survivors: a - lost });
        left -= kills;
        real -= kills;
      }
      if (!softeners.length) continue;
      const take = armiesToTake(left, rates);
      if (take === null) return null;
      // No-Split: the finisher sends its whole stack too.
      const armies = noSplit ? Math.max(take, avail.get(finisher)!) : take;
      // #121: the finisher keeps what holds a safe border too; deploys cover the rest.
      const need = Math.max(0, armies - (noSplit ? avail.get(finisher)! : movableFor(finisher, t)));
      if (need > spareAt(finisher)) continue;
      const survivors = armies - straightKills(left, def);
      return { softeners, finisher, armies, need, left, survivors };
    }
    return null;
  };
  const tryCombined = (t: number, reason: string): boolean => {
    belowEven = undefined;
    const plan = combinedPlan(t);
    if (!plan) return false;
    const tg = targets.get(t)!;
    const n = plan.softeners.length + 1;
    if (luck > 0 || (s.roundingMode !== undefined && s.roundingMode !== 'StraightRound')) {
      const why = luck > 0 ? `luck is ${Math.round(luck * 100)}%` : `this game uses ${s.roundingMode} rounding`;
      const w = `Multi-source capture of ${label(t)} skipped: no single source can afford its ${tg.cost}, and ${n} sources together could only at 0% luck under straight rounding, but ${why}.`;
      if (!warnings.includes(w)) warnings.push(w);
      return false;
    }
    // Rule 0p.3 (#72): behind on armies, no trade below even. The softeners lose more than
    // they kill by design (each attacks a stack larger than it can take), so a combined capture
    // of a player's territory can lose more than the whole stack it destroys.
    // Rule 4e in contact (#107) asks the same of its enemy captures.
    if ((armiesBehind || evenTradesOnly) && tg.enemy) {
      const lost =
        plan.softeners.reduce((n, x) => n + x.armies - x.survivors, 0) + plan.armies - plan.survivors;
      const killed = plan.softeners.reduce((n, x) => n + x.kills, 0) + plan.left;
      if (lost > killed) {
        if (armiesBehind) {
          if (!badTrades.has(t)) badTrades.set(t, { lost, killed });
          skipOffence(t, `a trade below even while behind on armies (loses ${lost} for ${killed})`);
        }
        belowEven = { lost, killed };
        return false;
      }
    }
    const before = { avail: new Map(avail), incoming: new Map(incoming), deployed: new Map(deployed), budget };
    deploy(plan.finisher, plan.need);
    for (const x of plan.softeners) {
      avail.set(x.from, avail.get(x.from)! - x.armies);
      incoming.set(x.from, (incoming.get(x.from) ?? 0) + x.survivors);
    }
    avail.set(plan.finisher, avail.get(plan.finisher)! - plan.armies);
    captured.add(t);
    if (!defensible(t, plan.survivors)) {
      for (const [k, v] of before.avail) avail.set(k, v);
      incoming.clear();
      for (const [k, v] of before.incoming) incoming.set(k, v);
      deployed.clear();
      for (const [k, v] of before.deployed) deployed.set(k, v);
      budget = before.budget;
      captured.delete(t);
      return false;
    }
    survivorsAt.set(t, plan.survivors);
    combined.add(t);
    captureOrder.push(t);
    captureUndo.set(t, () => {
      for (const x of plan.softeners) {
        avail.set(x.from, avail.get(x.from)! + x.armies);
        incoming.set(x.from, (incoming.get(x.from) ?? 0) - x.survivors);
      }
      avail.set(plan.finisher, avail.get(plan.finisher)! + plan.armies);
    });
    for (const x of plan.softeners)
      moves.push({
        from: x.from,
        to: t,
        armies: x.armies,
        kind: 'attack',
        reason: `wears ${label(t)} down for a combined capture (${reason})`,
        winChance: chanceOf(x.armies, x.before),
      });
    moves.push({
      from: plan.finisher,
      to: t,
      armies: plan.armies,
      kind: 'attack',
      reason,
      winChance: chanceOf(plan.armies, plan.left),
    });
    if (tg.enemy && !worstCase.has(t))
      warnings.push(`Attack on enemy ${label(t)} assumes its owner does not reinforce it first.`);
    const order = [...plan.softeners.map((x) => x.from), plan.finisher].map(label).join(', then ');
    warnings.push(
      `The capture of ${label(t)} combines ${n} attacks that must run in this order (${order}): the first ${n === 2 ? 'one fails' : `${n - 1} fail`} by design, only wearing the defenders down; the arithmetic is exact only at 0% luck under straight rounding.`,
    );
    rationale.push(
      `Attack ${label(t)} with ${n} attacks (no single source can afford its ${tg.cost}): ${plan.softeners
        .map((x) => `from ${label(x.from)} with ${x.armies} (kills ${x.kills} of ${x.before}; ${x.survivors} survive and stay)`)
        .join(', then ')}, then from ${label(plan.finisher)} with ${plan.armies}${plan.need ? ` (deploy ${plan.need} there)` : ''}, taking the last ${plan.left}: ${reason}.`,
    );
    return true;
  };

  // ---- pass 1: complete a bonus this turn (all or nothing) ----
  /** Snapshot the captures, deploys and notes so far; the result undoes everything since. */
  const snapshot = () => {
    const snap = {
      budget,
      anchor,
      deployed: new Map(deployed),
      avail: new Map(avail),
      incoming: new Map(incoming),
      combined: new Set(combined),
      survivorsAt: new Map(survivorsAt),
      staged: new Map(staged),
      captureOrder: captureOrder.length,
      moves: moves.length,
      rationale: rationale.length,
      warnings: warnings.length,
    };
    return () => {
      budget = snap.budget;
      anchor = snap.anchor;
      deployed.clear();
      for (const [k, v] of snap.deployed) deployed.set(k, v);
      for (const [k, v] of snap.avail) avail.set(k, v);
      incoming.clear();
      for (const [k, v] of snap.incoming) incoming.set(k, v);
      for (const m of moves.splice(snap.moves)) captured.delete(m.to);
      combined.clear();
      for (const t of snap.combined) combined.add(t);
      survivorsAt.clear();
      for (const [k, v] of snap.survivorsAt) survivorsAt.set(k, v);
      staged.clear();
      for (const [k, v] of snap.staged) staged.set(k, v);
      captureOrder.length = snap.captureOrder;
      rationale.length = snap.rationale;
      warnings.length = snap.warnings;
    };
  };
  const complete = (p: BonusPlan) => {
    if (!p.completable) return;
    const todo = p.remaining
      .filter((t) => !captured.has(t))
      .sort((a, b) => targets.get(a)!.cost - targets.get(b)!.cost || a - b);
    if (!todo.length) return;
    const first = moves.length;
    const restore = snapshot();
    const before = incomeGain(heldNow());
    const worth = p.net === p.value ? `+${p.value}` : `+${p.value}, net +${p.net}`;
    const ok = todo.every((t) => tryCapture(t, `completes bonus ${bonusName(p.bonusId)} (${worth})`));
    // Rule 4c: completing it must not lower income (its members' negative bonuses included).
    if (ok && !p.focus && incomeGain(heldNow()) < before) {
      const net = incomeGain(heldNow()) - before;
      restore();
      rationale.push(
        `Do not complete bonus ${bonusName(p.bonusId)} (${worth}): with this turn's other captures it changes income by ${net} (its members complete negative bonuses).`,
      );
      return;
    }
    if (ok) {
      // The leftover's expansion stack is a finisher, never a combined capture's softener: its extra
      // armies would only come home (No-Split: leave with its failing attack).
      const done = moves.slice(first);
      const finisher = done.find(
        (m, i) => m.kind === 'attack' && !done.slice(i + 1).some((o) => o.kind === 'attack' && o.to === m.to),
      );
      anchor ??= (finisher ?? moves[first])?.from;
      return;
    }
    restore();
  };

  // ---- pass 2: advance a bonus one capture at a time ----
  /** Bonuses whose staging was refused (rule 4c(c)), so the rationale says it once. */
  const unstaged = new Set<number>();
  /**
   * Rule 4c(c): capturing `t` toward `p` lowers income this turn. It is a staging step, taken
   * only when the bonus completes within PAYBACK_TURNS (k turns: its other missing members'
   * capture cost / the income left after this step, rounded up, at least 1; none left:
   * refused) and the penalties until then —
   * at most k × every penalty its missing members carry — are repaid by its net worth within
   * PAYBACK_TURNS turns of completion. Returns the capture's reason and rationale line, or
   * `null` when refused.
   */
  const stage = (p: BonusPlan, t: number): { reason: string; note: string } | null => {
    const rest = p.remaining.filter((x) => x !== t && !captured.has(x));
    let restCost = 0;
    for (const x of rest) {
      const st = state.get(x);
      restCost += !st || st.owner.kind === 'unknown' || st.armies === null ? Infinity : (captureCost(defenceAt(x), s) ?? Infinity);
    }
    const penalty = p.value - p.net;
    const step = gainWith([t]);
    // The income left once this step (and this turn's other captures) lands: the staging
    // capture itself lowers it, so the turns to finish are counted at that income (#70).
    const after = incomeAfter(new Set([...heldNow(), t]));
    const turns = after > 0 ? Math.max(1, Math.ceil(restCost / after)) : Infinity;
    const interim = turns * penalty;
    if (turns <= PAYBACK_TURNS && interim <= PAYBACK_TURNS * p.net) {
      return {
        note: `Stage bonus ${bonusName(p.bonusId)} with ${label(t)} (${step} income until it completes): its other ${rest.length} missing member${rest.length === 1 ? '' : 's'} cost ${restCost}, ~${turns} turns at income ${after} (after this step); ${turns} turns × ${penalty} = ${interim} of penalties at most, repaid within ${PAYBACK_TURNS} turns of completion (${PAYBACK_TURNS} × +${p.net} = ${PAYBACK_TURNS * p.net}).`,
        reason: `stages bonus ${bonusName(p.bonusId)} (+${p.value}, net +${p.net} once complete; ${step} income until then)`,
      };
    }
    if (!unstaged.has(p.bonusId)) {
      unstaged.add(p.bonusId);
      rationale.push(
        `Do not take ${label(t)} toward bonus ${bonusName(p.bonusId)}: it costs ${step} income until the bonus completes, ${
          restCost === Infinity
            ? 'and the rest of the bonus cannot be costed (fog)'
            : `~${turns} turns away (${restCost} armies at income ${after} after this step); ${turns} × ${penalty} = ${interim} of penalties is not repaid by ${PAYBACK_TURNS} × +${p.net}`
        }.`,
      );
    }
    return null;
  };
  /**
   * Captures rule 4d's budget stopped, with the frontier they would have left (for the warning;
   * dropped, with their rationale lines, if a later pass takes them after all).
   */
  const stopped: { t: number; holdCost: number; income: number }[] = [];
  /** The start of rule 4d's rationale line for a stopped `t` (one per attempt that differed). */
  const stoppedLine = (t: number) => `Do not take ${label(t)}: it adds a border facing an enemy without completing a bonus,`;
  /**
   * Rule 4d's frontier budget, judged with `t` just captured: under a guarded goal, a capture
   * that adds a border facing an enemy without completing a bonus (and not focused) is stopped
   * when holding the frontier next turn would then need more than the next income, and more than
   * it needed at the start of the turn. Returns the rationale line when stopped, else `null`.
   */
  const outgrows = (t: number): string | null => {
    if (!guarded || inFocus(t)) return null;
    const held = heldNow();
    if (completedBy(held).some((id) => g.bonusById.get(id)!.value > 0 && bonusTs.get(id)!.includes(t))) return null;
    const stays = (x: number) => (mineSet.has(x) ? stayAt(x) : (survivorsAt.get(x) ?? 0));
    const without = new Set([...held].filter((x) => x !== t));
    if (frontierDelta(without, [t], stays).enemy <= 0) return null;
    const f = frontierOf(held, stays);
    const next = keptIncome(held);
    const start = startHold();
    if (f.holdCost <= next || f.holdCost <= start) return null;
    const why = `${stoppedLine(t)} and the frontier would then need ${f.holdCost} next turn to hold (${f.enemyBorders} enemy-facing borders), more than the next income of ${next} and more than the ${start} it needed at the start of the turn.`;
    if (!stopped.some((x) => x.t === t)) stopped.push({ t, holdCost: f.holdCost, income: next });
    return why;
  };
  /** Capture `t` for expansion, unless rule 4d's frontier budget stops it (then everything is undone). */
  const tryExpand = (t: number, reason: string): boolean => {
    const restore = snapshot();
    if (!tryCapture(t, reason)) return false;
    const why = outgrows(t);
    if (why === null) return true;
    restore();
    if (!rationale.includes(why)) rationale.push(why);
    return false;
  };
  const advance = (p: BonusPlan) => {
    const todo = p.remaining
      .filter((t) => bonusTarget(t) && !captured.has(t))
      .sort((a, b) => targetScoreCost(a) - targetScoreCost(b) || targets.get(a)!.cost - targets.get(b)!.cost || a - b);
    for (const t of todo) {
      const stepping = !p.focus && gainWith([t]) < 0 ? stage(p, t) : undefined;
      if (stepping === null) continue;
      const worth = p.net === p.value ? `+${p.value}` : `+${p.value}, net +${p.net}`;
      const reason = stepping?.reason ?? `advances bonus ${bonusName(p.bonusId)} (${worth}, ${toFinish(p.cost, p.fogged, p.fogEach)})`;
      if (tryExpand(t, reason)) {
        anchor ??= moves[moves.length - 1]!.from;
        if (stepping) {
          staged.set(t, p.bonusId);
          rationale.push(stepping.note);
        }
      }
    }
  };

  // ---- 1e. finish off an opponent (#45) ----
  // Before any border is conceded: for each visible opponent whose every territory is
  // visible (none borders the fog) and borders mine — any such opponent, however strong,
  // fewest territories first — search the attack sizes on its territories against its best
  // response (its deploy estimate is one budget, spread to save as many as it can; see
  // `guaranteedFalls`). Kept when every territory falls (elimination), or when the falls it
  // cannot prevent leave it one territory or take at least half, no attacking border faces
  // a territory left unattacked, and every hold worth paying for against those is funded.
  // Visible enemy territories by owner, sorted.
  const ownedBy = new Map<number, number[]>();
  for (const [id, st] of [...state].sort((a, b) => a[0] - b[0])) {
    if (st.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) continue;
    ownedBy.set(st.owner.playerId, [...(ownedBy.get(st.owner.playerId) ?? []), id]);
  }
  const ownerOf = (id: number) => {
    const o = state.get(id)?.owner;
    return o?.kind === 'player' ? o.playerId : undefined;
  };
  const hidden = (n: number) => {
    const st = state.get(n);
    return !st || st.owner.kind === 'unknown' || st.armies === null;
  };
  // Anything on the board hidden: an opponent may hold territories there no visible one borders.
  const fogAnywhere = [...g.territoryById.keys()].some(hidden);
  /** Its territories with a fogged neighbour: it may hold more in the fog. */
  const fogEdge = (p: number) => ownedBy.get(p)!.filter((t) => neighborsOf(g, t).some(hidden));
  const inReach = (p: number) => ownedBy.get(p)!.every((t) => neighborsOf(g, t).some((n) => mineSet.has(n)));
  /** Fully visible, fewer territories than mine, and a deploy below my income. */
  const weak = new Set(
    [...ownedBy.keys()].filter(
      (p) => !fogEdge(p).length && ownedBy.get(p)!.length < mine.length && deployOf(p) < income,
    ),
  );
  const previousOwner = new Map(
    (input.previousBoard?.territories ?? []).flatMap((t) =>
      t.owner.kind === 'player' ? [[t.territoryId, t.owner.playerId] as const] : [],
    ),
  );
  /** The weak opponent that held my `id` on the previous board, if any. */
  const recentlyTakenFrom = (id: number): number | undefined => {
    const p = previousOwner.get(id);
    return p !== undefined && p !== me && weak.has(p) ? p : undefined;
  };
  /** The most defenders `armies` attackers take for certain (`captureCost` at chance 1). */
  const takesUpTo = (armies: number) => {
    let y = 0;
    while ((captureCost(y + 1, s) ?? Infinity) <= armies) y++;
    return y;
  };
  /** Everything a finish-off attempt may change, to restore it. */
  const checkpoint = (ts: readonly number[]) => ({
    budget,
    deployed: new Map(deployed),
    avail: new Map(avail),
    incoming: new Map(incoming),
    captured: new Set(captured),
    combined: new Set(combined),
    survivorsAt: new Map(survivorsAt),
    worstCase: new Map(worstCase),
    targets: new Map(ts.map((t) => [t, targets.get(t)] as const)),
    notCompleted: new Map(notCompleted),
    staged: new Map(staged),
    captureOrder: captureOrder.length,
    moves: moves.length,
    rationale: rationale.length,
    warnings: warnings.length,
  });
  const restore = (c: ReturnType<typeof checkpoint>) => {
    budget = c.budget;
    deployed.clear();
    for (const [k, v] of c.deployed) deployed.set(k, v);
    for (const [k, v] of c.avail) avail.set(k, v);
    incoming.clear();
    for (const [k, v] of c.incoming) incoming.set(k, v);
    captured.clear();
    for (const t of c.captured) captured.add(t);
    combined.clear();
    for (const t of c.combined) combined.add(t);
    survivorsAt.clear();
    for (const [k, v] of c.survivorsAt) survivorsAt.set(k, v);
    worstCase.clear();
    for (const [k, v] of c.worstCase) worstCase.set(k, v);
    for (const [t, tg] of c.targets) {
      if (tg) targets.set(t, tg);
      else targets.delete(t);
    }
    notCompleted.clear();
    for (const [k, v] of c.notCompleted) notCompleted.set(k, v);
    staged.clear();
    for (const [k, v] of c.staged) staged.set(k, v);
    captureOrder.length = c.captureOrder;
    moves.length = c.moves;
    rationale.length = c.rationale;
    warnings.length = c.warnings;
  };
  /** One sizing of the attacks: per target, the share of the deploy it is sized for, or SKIP. */
  const SKIP = -1;
  interface Attempt {
    sizes: number[];
    attacked: number[];
    /** Deploys player `p` must place on each attacked target to save it. */
    saveCost: number[];
    falls: number;
    all: boolean;
    armies: number;
    deploys: number;
    /** Success before the hold checks: eliminates, or leaves it one territory, or takes half. */
    enough: boolean;
    freed: boolean;
    unfunded: boolean;
    left: number[];
  }
  /**
   * Positive when `a` beats `b`: an elimination, then more sure falls, then fewer attacking
   * armies, then a dearer cheapest save (the opponent must commit more to save any one), then
   * fewer deploys. A tie keeps the first found (shares are tried from the full deploy down,
   * lowest territory id first), so the plan is deterministic.
   */
  const better = (a: Attempt, b: Attempt) =>
    Number(a.all) - Number(b.all) ||
    a.falls - b.falls ||
    b.armies - a.armies ||
    Math.min(...a.saveCost) - Math.min(...b.saveCost) ||
    b.deploys - a.deploys;
  /**
   * Plan the captures of player `p`'s territories against its best response. Committed
   * (true) when it eliminates `p`, or cuts it to one territory or takes at least half of it
   * with no attacking border facing what is left unattacked and every hold worth paying for
   * against that funded; otherwise rolled back. `probe`: always rolled back, true when an
   * elimination is affordable.
   */
  const finishOff = (p: number, probe: boolean, fogged: readonly number[] = []): boolean => {
    const ts = ownedBy.get(p)!;
    /** Next to the fog (#60): only taking every visible territory for sure counts, as pressure. */
    const pressure = fogged.length > 0;
    /** Its estimated deploy; under pressure, sized for with a margin over it (#60). */
    const estimateP = deployOf(p);
    const marginP = pressure ? marginFor(estimateP) : 0;
    const deployP = estimateP + marginP;
    const deployText = marginP ? `~${estimateP} deploy plus a margin of ${marginP}` : `~${deployP} deploy`;
    /**
     * #179: what it may deploy on `t` — under Local Deployment its bonus pools pay only into their
     * own territories (`deployReaching`), so a territory outside them faces less; else all of it.
     */
    const reachOn = new Map(ts.map((t) => [t, Math.min(deployP, deployReaching(p, [t]) + marginP)] as const));
    const reachText = (t: number) =>
      reachOn.get(t)! < deployP ? `the ~${reachOn.get(t)!} of its deploy that can reach it (Local Deployment)` : `its full ${deployText}`;
    const start = checkpoint(ts);
    if (ts.some((t) => captureCost(defenceAt(t), s) === null)) return false;
    /**
     * Reserve the holds for an attempt that leaves `stay` unattacked. Holds against other
     * players (and against `stay`) worth paying for (rule 1a's CONCEDE_FACTOR test) come
     * first. A source keeps what holds it there. On a border that attacks nothing, each such
     * hold — best worth per army first, and only if it fits what is left — is deployed there
     * while the captures are sized, so neither the captures nor a Local Deployment pool can
     * spend that room; one that does not fit is left to triage.
     */
    const reserve = (stay: ReadonlySet<number>, cover = false) => {
      const tried = ts.filter((t) => !stay.has(t));
      const sources = new Set(tried.flatMap((t) => neighborsOf(g, t).filter((n) => mineSet.has(n))));
      const keepAt = new Map<number, number>();
      const elsewhere: { x: number; cost: number; worth: number }[] = [];
      /** A hold's cost on my `x` against the threats left once `gone` fall, or null when not worth paying. */
      const holdCostAt = (x: number, gone: (n: number) => boolean) => {
        const rest = borderAt(x, gone);
        if (!rest) return null;
        // Armies that must stay: the hold less what my special units there fight as.
        const need = Math.max(0, holdArmies(rest.threat) - unitsAt(x));
        const cost = Math.max(0, need - armiesOf(x));
        const worth = valueOf(x) + armiesOf(x) / PAYBACK_TURNS;
        // My commander's border is always worth holding (rule 1k).
        return cost > CONCEDE_FACTOR * worth && !myCommanders.has(x) ? null : { need, cost, worth };
      };
      for (const x of mine) {
        const h = holdCostAt(x, (n) => ownerOf(n) === p && !stay.has(n));
        if (!h) continue;
        const { need, cost, worth } = h;
        if (sources.has(x)) {
          // No-Split (#124): nothing is kept back, the whole stack moves; a source that must hold
          // against what is left issues no order instead (tryCapture asks `mustHold`).
          if (noSplit) continue;
          const keep = Math.max(0, need - guard);
          keepAt.set(x, keep);
          avail.set(x, avail.get(x)! - keep);
        } else if (cost > 0) elsewhere.push({ x, cost, worth });
      }
      /** The holds reserved, by border. */
      const funded = new Map<number, number>();
      elsewhere.sort((a, b) => b.worth / b.cost - a.worth / a.cost || a.cost - b.cost || a.x - b.x);
      for (const h of elsewhere) {
        if (h.cost > roomAt(h.x)) continue;
        deploy(h.x, h.cost);
        funded.set(h.x, h.cost);
      }
      // #179: cover its exits onto my land. Unless I move first, its stacks may attack before my
      // attacks land, so each of my territories next to it holds against its stacks there plus the
      // deploy that can reach them: a source keeps that (and what the attack would lose defending,
      // so the attack still goes out whole), a border that attacks nothing is deployed to. These
      // stay after the commit (the territory is locked), unlike the holds above.
      const covers = new Set<number>();
      /** What each covered territory keeps, in `avail` terms. */
      const coverAt = new Map<number, number>();
      let uncoverable = false;
      if (cover)
        for (const x of mine) {
          const adj = ts.filter((t) => neighborsOf(g, x).includes(t));
          if (!adj.length) continue;
          const threat = deployReaching(p, adj) + adj.reduce((n, t) => n + Math.max(0, armiesOf(t) - guard) + unitsAt(t), 0);
          const need = Math.max(0, holdArmies(threat) - unitsAt(x));
          covers.add(x);
          coverAt.set(x, Math.max(0, need - guard));
          if (sources.has(x)) {
            if (noSplit) {
              uncoverable = true;
              break;
            }
            const keep = Math.max(need - guard, straightKills(threat, rates.offensiveKillRate));
            // It keeps the loss buffer too through the later passes, not only the hold.
            coverAt.set(x, keep);
            const extra = keep - (keepAt.get(x) ?? 0);
            if (extra > 0) {
              keepAt.set(x, keep);
              avail.set(x, avail.get(x)! - extra);
            }
          } else {
            const cost = Math.max(0, need - armiesOf(x)) - (funded.get(x) ?? 0);
            if (cost > roomAt(x)) {
              uncoverable = true;
              break;
            }
            if (cost > 0) {
              deploy(x, cost);
              funded.set(x, (funded.get(x) ?? 0) + cost);
            }
          }
        }
      const reserved = checkpoint(ts);
      const fullReason = (t: number) => `takes player ${p}'s territory, sized for ${reachText(t)} landing there`;
      /** Size and plan the attacks for `sizes` (from `reserved`), and judge the result. */
      const attempt = (sizes: number[]): Attempt => {
        tried.forEach((t, i) => {
          const e = sizes[i]!;
          if (e === SKIP) return;
          worstCase.set(t, defenceAt(t) + e);
          targets.set(t, {
            id: t,
            cost: captureCost(defenceAt(t) + e, s)!,
            enemy: true,
            sources: neighborsOf(g, t).filter((n) => mineSet.has(n)),
          });
        });
        const order = tried
          .map((t, i) => ({ t, e: sizes[i]! }))
          .filter((x) => x.e !== SKIP)
          .sort((a, b) => targets.get(a.t)!.cost - targets.get(b.t)!.cost || a.t - b.t);
        // No-Split (#124): a source must hold only against what stays; each target sized for the
        // full deploy is taken for sure, so it threatens nothing once attacked.
        const sure = new Set(order.filter((x) => x.e >= reachOn.get(x.t)!).map((x) => x.t));
        assumeGone = (n) => sure.has(n);
        const attacked = order
          .filter(({ t, e }) =>
            tryCapture(
              t,
              e >= reachOn.get(t)! ? fullReason(t) : `presses player ${p}: sized for ${e} of its ~${reachOn.get(t)!} deploy landing there`,
            ),
          )
          .map((x) => x.t)
          .sort(byNum);
        assumeGone = () => false;
        const ours = moves.slice(reserved.moves).filter((m) => m.kind === 'attack');
        // #179: a covered territory that attacks nothing gets the deploys its kept hold still lacks.
        let uncovered = false;
        for (const x of [...covers].sort(byNum)) {
          const short = -avail.get(x)!;
          if (short <= 0 || ours.some((m) => m.from === x)) continue;
          if (short > roomAt(x)) uncovered = true;
          else deploy(x, short);
        }
        const saveCost = attacked.map((t) => {
          const at = ours.filter((m) => m.to === t);
          const finisher = at[at.length - 1]!;
          const kills = at
            .slice(0, -1)
            .reduce((n, m) => n + straightKills(m.armies, rates.offensiveKillRate), 0);
          return Math.max(0, kills + takesUpTo(finisher.armies) - defenceAt(t) + 1);
        });
        const falls = guaranteedFallsReaching(
          saveCost,
          attacked.map((t) => reachOn.get(t)!),
          deployP,
        );
        const all = falls === ts.length;
        const left = ts.filter((t) => !attacked.includes(t));
        const attackers = new Set(ours.map((m) => m.from));
        const freed = [...attackers].every((x) => !neighborsOf(g, x).some((n) => left.includes(n)));
        // What stays unattacked: a border that attacks nothing but faces it must still have its
        // hold funded, or the captures cost a border worth holding.
        const unfunded = ours.length
          ? mine.some((x) => {
              if (attackers.has(x) || !neighborsOf(g, x).some((n) => left.includes(n))) return false;
              const h = holdCostAt(x, (n) => captured.has(n));
              return h !== null && h.cost > (funded.get(x) ?? 0);
            })
          : false;
        return {
          sizes,
          attacked,
          saveCost,
          falls,
          all,
          armies: ours.reduce((n, m) => n + m.armies, 0),
          deploys: reserved.budget - budget,
          enough: falls > 0 && !uncovered && (all || ts.length - falls <= 1 || falls * 2 >= ts.length),
          freed,
          unfunded,
          left,
        };
      };
      // Every sizing, each target sized for 0..its full deploy share (or not attacked): exact
      // while there are few; otherwise evenly spaced shares, always including the full one.
      const LIMIT = 1024;
      let levels = deployP + 2;
      while (levels > 1 && levels ** tried.length > LIMIT) levels--;
      /** Each target's sizings: its reachable deploy (#179) evenly spaced down to 0, or not attacked. */
      const sharesOf = tried.map((t) => {
        const r = reachOn.get(t)!;
        const spaced = Array.from({ length: Math.max(1, levels - 1) }, (_, i) =>
          Math.round(r - (i * r) / Math.max(1, levels - 2)),
        );
        return levels >= 2 ? [...new Set(spaced), SKIP] : [r];
      });
      /** Every sizing tried; the state is left as reserved. */
      const search = () => {
        let best: Attempt | null = null;
        let bestUnfunded: Attempt | null = null;
        let canEliminate = false;
        if (uncoverable) return { best, bestUnfunded, canEliminate };
        const sizes = tried.map(() => 0);
        const visit = (i: number) => {
          if (i === tried.length) {
            const a = attempt([...sizes]);
            restore(reserved);
            if (a.all) canEliminate = true;
            if (!a.enough || !a.freed || (pressure && !a.all)) return;
            if (a.unfunded) {
              if (!bestUnfunded || better(a, bestUnfunded) > 0) bestUnfunded = a;
            } else if (!best || better(a, best) > 0) best = a;
            return;
          }
          for (const e of sharesOf[i]!) {
            sizes[i] = e;
            visit(i + 1);
          }
        };
        if (tried.length) visit(0);
        return { best: best as Attempt | null, bestUnfunded: bestUnfunded as Attempt | null, canEliminate };
      };
      /** Plan `chosen`, then release the reservations: the triage (or the greedy step) deploys the holds. */
      const commit = (chosen: Attempt) => {
        attempt(chosen.sizes);
        // #179: a covered exit keeps its hold: every later keep honours it.
        for (const [x, k] of coverAt) coverKeep.set(x, Math.max(coverKeep.get(x) ?? 0, k));
        for (const [x, k] of keepAt) avail.set(x, avail.get(x)! + k);
        for (const [x, k] of funded) {
          if (covers.has(x)) continue;
          const d = deployed.get(x)! - k;
          if (d) deployed.set(x, d);
          else deployed.delete(x);
          avail.set(x, avail.get(x)! - k);
          budget += k;
        }
      };
      return { search, commit, covers };
    };
    const found = reserve(new Set()).search();
    restore(start);
    if (probe) return found.canEliminate;
    let chosen = found.best;
    let stay: ReadonlySet<number> = new Set();
    /** #179: the elimination covers its exits onto my land (not known to move first). */
    let cover = false;
    if (chosen?.all && !pressure && opts.movesFirst !== true) {
      const c = reserve(new Set(), true).search();
      restore(start);
      if (c.best?.all) {
        chosen = c.best;
        cover = true;
      }
    }
    // A better attempt that left a hold facing what it left unattacked unfunded: once more,
    // with those holds reserved first and those territories left alone.
    const retry = found.bestUnfunded;
    if (!cover && retry && (!chosen || better(retry, chosen) > 0)) {
      const again = reserve(new Set(retry.left)).search();
      restore(start);
      if (again.best && (!chosen || better(again.best, chosen) > 0)) {
        chosen = again.best;
        stay = new Set(retry.left);
      }
    }
    if (!chosen) return false;
    const coverBefore = new Map(coverKeep);
    const committed = reserve(stay, cover);
    committed.commit(chosen);
    // #179: in an FFA, price the elimination before it stands: the players its land would make me
    // border, and the frontier cost before and after (each border's hold need next turn, the
    // victim's threat gone). A buffer whose removal costs more than a turn of my income, and more
    // than the income its land adds pays back in PAYBACK_TURNS turns, is left standing.
    if (chosen.all && !pressure && profile.format === 'ffa' && profile.opponents >= 2) {
      const next = [...new Set(ts.flatMap((t) => neighborsOf(g, t)))].sort(byNum);
      const exposed = next.filter((n) => {
        const o = ownerOf(n);
        return o !== undefined && o !== p && foe(o) && !neighborsOf(g, n).some((x) => mineSet.has(x));
      });
      if (exposed.length) {
        const after = new Set([...mineSet, ...ts]);
        const delta = frontierDelta(mineSet, ts, (x) => (mineSet.has(x) ? stayAt(x) : (survivorsAt.get(x) ?? 0))).armies;
        const gain = Math.max(0, incomeGain(after));
        const limit = Math.max(PAYBACK_TURNS * gain, income);
        const who = [...new Set(exposed.map((n) => ownerOf(n)!))].sort(byNum);
        const exposure = `taking ${ts.map(label).join(', ')} makes me border ${who
          .map((q) => `player ${q}'s ${exposed.filter((n) => ownerOf(n) === q).map(label).join(', ')}`)
          .join(' and ')}`;
        const shown = Math.round(delta);
        const cost = `the frontier's hold cost changes by ${shown >= 0 ? '+' : ''}${shown} armies (its own threat gone)`;
        if (delta > limit) {
          restore(start);
          coverKeep.clear();
          for (const [k, v] of coverBefore) coverKeep.set(k, v);
          for (const t of ts) spared.add(t);
          rationale.push(
            `Not finishing off player ${p} (#179): it is a buffer: ${exposure}, and ${cost}, more than a turn of my income (${income}) and more than the +${gain} its land adds pays back in ${PAYBACK_TURNS} turns.`,
          );
          return false;
        }
        rationale.push(`Elimination price (#179): ${exposure}; ${cost}, within ${limit} (a turn of my income, or ${PAYBACK_TURNS} turns of the +${gain} its land adds).`);
      }
    }
    const { attacked, falls, left } = chosen;
    const local = attacked.filter((t) => reachOn.get(t)! < deployP);
    /** How each attack is sized: for the full deploy, or (Local Deployment, #179) what can reach it. */
    const sizedFor = local.length ? `the part of its ${deployText} that can reach it (Local Deployment)` : `its full ${deployText}`;
    if (local.length)
      rationale.push(
        `Local Deployment (#179): player ${p}'s bonus pools pay only into their own territories, so ${local.map((t) => `${label(t)} can be reinforced with ~${reachOn.get(t)!}`).join(', ')} at most, and ${local.length === 1 ? 'its attack is' : 'their attacks are'} sized for that.`,
      );
    // The territories left unattacked stay ordinary (non-worst-case) targets.
    for (const t of left) {
      worstCase.delete(t);
      const tg = start.targets.get(t);
      if (tg) targets.set(t, tg);
      else targets.delete(t);
    }
    const names = attacked.map(label).join(', ');
    const rest = left.length
      ? `; ${left.map(label).join(', ')} stay${left.length === 1 ? 's' : ''} unattacked, and no attacking border faces ${left.length === 1 ? 'it' : 'them'}`
      : '';
    if (chosen.all && pressure) {
      const edge = fogged.map(label).join(', ');
      rationale.push(
        `Pressure player ${p}: take all ${ts.length} of its visible territories (${names}) this turn, each sized for ${sizedFor} landing there; it may hold more in the fog (next to ${edge}), so this is not an elimination.`,
      );
      warnings.push(
        `Pressuring player ${p} assumes it deploys at most ~${deployP} (its ~${estimateP} estimate ${marginP ? `plus a margin of ${marginP}` : 'with no margin: behind, attacks are sized at the minimum'}); more income than that (unseen bonuses, cards) could still save a territory.`,
        `player ${p} may hold more territories in the fog (next to ${edge}): taking its ${ts.length} visible territories is pressure, not an elimination.`,
      );
      return true;
    }
    if (chosen.all) {
      finishedOff.add(p);
      rationale.push(
        `Finish off player ${p}: attack all ${ts.length} of its territories (${names}) this turn, each sized for ${sizedFor} landing there, so it is eliminated ${fogAnywhere ? 'if it holds nothing in the fog, ' : ''}even if it reinforces; the borders facing it need no holding${cover ? ' once my attacks land' : ''}.`,
      );
      if (cover && committed.covers.size)
        rationale.push(
          `Cover player ${p}'s exits (#179): I am not known to move first, so its stacks may attack before my attacks land; ${[...committed.covers].sort(byNum).map(label).join(', ')} keep${committed.covers.size === 1 ? 's' : ''} what holds against its stacks next to ${committed.covers.size === 1 ? 'it' : 'them'} plus its deploy, so it cannot break out onto my land.`,
        );
      warnings.push(
        `Eliminating player ${p} assumes it deploys at most ~${deployP} (its estimate); more income than that (unseen bonuses, cards) could still save one of its territories.`,
      );
      if (fogAnywhere)
        warnings.push(
          `player ${p} could still hold territories in the fog that border none of its visible ones: taking all ${ts.length} visible ones may not eliminate it.`,
        );
      return true;
    }
    const kept = ts.length - falls;
    const outcome = kept <= 1 ? 'cutting it to one territory' : `taking ${falls} of its ${ts.length}`;
    if (falls === attacked.length)
      rationale.push(
        `Pressure player ${p}: take ${falls} of its ${ts.length} territories (${names}) this turn, each sized for ${sizedFor} landing there, ${outcome}${rest}.`,
      );
    else {
      const saved = attacked.length - falls;
      rationale.push(
        `Pressure player ${p}: attack ${attacked.length === ts.length ? 'all' : attacked.length} ${attacked.length === ts.length ? `${ts.length} of its` : `of its ${ts.length}`} territories (${names}) this turn: its ~${deployP} deploy can save at most ${saved} of them, so at least ${falls} fall${falls === 1 ? 's' : ''}, ${outcome}${rest}.`,
      );
      warnings.push(
        `player ${p} chooses which of ${names} to save (up to ${saved}): what it deploys there survives my attack, next to the borders that attacked it.`,
      );
    }
    warnings.push(
      `Pressuring player ${p} assumes it deploys at most ~${deployP} (its estimate); more income than that (unseen bonuses, cards) could still save a territory.`,
    );
    return true;
  };
  // ---- 1s. strike an enemy commander (#61) ----
  // Killing a player's commander eliminates it, so a visible enemy commander next to a
  // territory I held at the start of the turn is attacked before anything else spends the
  // income (finishing off, pressure, holds, expansion), under every goal, sized for its
  // armies, the commander's COMMANDER_STRENGTH and its owner's full deploy estimate landing
  // there. Nothing is conceded yet, so a thin border next to it may strike. The owner's other
  // stacks still threaten this turn (attacks interleave). My commander's hold is reserved
  // first; each source keeps what holds it (`keepFor`; nothing when it cannot hold anyway,
  // unless it is my commander's).
  /** Players whose commander is struck this turn: finishing them off is moot. */
  const struck = new Set<number>();
  /** Strikes not made, warned about only when nothing else (finishing off) takes the territory. */
  const unstruck: { t: number; text: string }[] = [];
  for (const t of [...state.keys()].sort(byNum)) {
    const st = state.get(t)!;
    if (mineSet.has(t) || captured.has(t) || st.armies === null || st.owner.kind !== 'player' || !foe(st.owner.playerId) || uncounted(t)) continue;
    if (!(st.specialUnits ?? []).some((u) => u.kind === 'commander' && foe(u.playerId))) continue;
    const adjacent = neighborsOf(g, t).filter((n) => mineSet.has(n));
    if (!adjacent.length) continue;
    const p = st.owner.playerId;
    // #179: under Local Deployment only what can reach the commander's territory (its pools pay elsewhere).
    const deployP = deployReaching(p, [t]);
    const pooled = deployP < deployOf(p);
    const defenders = defenceAt(t) + deployP;
    const cost = captureCost(defenders, s);
    const at = `Player ${p}'s commander on ${label(t)}`;
    const sizing = `its ${armiesOf(t)} armies + the commander's ${COMMANDER_STRENGTH} + ${pooled ? `the ~${deployP} deploy that can reach it (Local Deployment)` : `its owner's full ~${deployP} deploy`}`;
    if (cost === null) continue;
    // Only the struck territory stops threatening (once taken). war.app interleaves both
    // players' attacks, so the owner's other stacks still attack this turn: elimination
    // changes next turn's picture, not this one's.
    const gone = (x: number) => x === t;
    // My commander's must-hold reserve is funded first (rule 1k): what its territory needs
    // against every threat but the struck one; when that does not fit, all that may be
    // deployed there (rule 1k deploys it all there anyway). It is held as a deploy on my
    // commander's territory while the strike is tried, so under Local Deployment it is charged
    // to the pools that can reach it (`roomAt`/`spareAt` see it), not just taken off the budget.
    const held = new Map<number, number>();
    const hold = (on: boolean) => {
      for (const [c, n] of held) {
        const d = (deployed.get(c) ?? 0) + (on ? n : -n);
        if (d > 0) deployed.set(c, d);
        else deployed.delete(c);
        budget += on ? -n : n;
      }
    };
    for (const c of [...myCommanders].sort(byNum)) {
      const b = borderAt(c, (x) => captured.has(x) || gone(x));
      const n = b ? Math.min(roomAt(c), Math.max(0, holdArmies(b.threat) - unitsAt(c) - stayAt(c))) : 0;
      if (n <= 0) continue;
      held.set(c, n);
      deployed.set(c, (deployed.get(c) ?? 0) + n);
      budget -= n;
    }
    hold(false);
    const reserved = [...held.values()].reduce((a, n) => a + n, 0);
    // A source that issues no order yet (No-Split: it may already strike another commander)
    // may strike. Strikes run before triage and every other pass, so no source is conceded or
    // locked yet: those cannot hold a strike back.
    const blocked = (x: number) => orderOf(x) !== undefined;
    const order = adjacent
      .filter((x) => !blocked(x))
      .map((x) => ({ x, keep: keepFor(x, gone, budget - reserved - reserve) }))
      .sort((a, b) => avail.get(b.x)! - b.keep - (avail.get(a.x)! - a.keep) || a.x - b.x);
    const prev = targets.get(t);
    targets.set(t, { id: t, cost, enemy: true, sources: adjacent });
    worstCase.set(t, defenders);
    strikes.add(t);
    const reason = `kills player ${p}'s commander, which eliminates it (sized for ${sizing})`;
    // Every source's most, with no keep and no reserve: what the strike could ever be sent.
    const most = new Map(order.map(({ x }) => [x, Math.max(0, avail.get(x)!) + Math.max(0, spareAt(x))]));
    hold(true);
    const done = order.some(({ x, keep }) => tryCapture(t, reason, { from: x, keep }));
    /** What may still be deployed on each source with the reserve held back (pools included). */
    const roomLeft = new Map(order.map(({ x }) => [x, Math.max(0, spareAt(x))]));
    hold(false);
    if (done) {
      struck.add(p);
      // #179: a commander kill turns its owner's land neutral where it stands: nothing comes to
      // me directly, and whoever borders it collects. Priced in an FFA, never gated.
      if (profile.format === 'ffa' && profile.opponents >= 2) {
        const land = (ownedBy.get(p) ?? []).filter((x) => x !== t);
        const by = new Map<number, number[]>();
        for (const x of land)
          for (const n of neighborsOf(g, x)) {
            const o = ownerOf(n);
            if (o === undefined || o === p || !foe(o)) continue;
            if (!(by.get(o) ?? []).includes(x)) by.set(o, [...(by.get(o) ?? []), x]);
          }
        const collectors = [...by].sort((a, b) => a[0] - b[0]).map(([q, xs]) => `player ${q} borders ${[...xs].sort(byNum).map(label).join(', ')}`);
        if (land.length)
          rationale.push(
            `Commander kill (#179): player ${p}'s land turns neutral where it stands; ${collectors.length ? collectors.join(', ') : 'no other player in view borders it'}, so ${collectors.length ? 'they may collect it' : 'it is mine to take'} (struck all the same: it removes a player).`,
          );
      }
      warnings.push(
        `Killing player ${p}'s commander on ${label(t)} assumes it deploys at most ~${deployP} (its estimate); more than that (unseen bonuses, cards) could save it.`,
      );
      continue;
    }
    strikes.delete(t);
    worstCase.delete(t);
    if (prev) targets.set(t, prev);
    else targets.delete(t);
    // Say what actually held it back, so a manual strike can be judged; said only if finishing
    // off does not take it. A keep is named only for a source that could send enough without
    // it and the reserve; the reserve only when it binds (a source could send enough, keep
    // kept, but for it, or dropping that keep alone would not do). With no source able to
    // send enough at all, the strike is unaffordable.
    const could = order.filter(({ x }) => most.get(x)! >= cost);
    /** What `x` could send with no keep but the reserve held back (a guard owed is paid first). */
    const unkept = (x: number) => Math.max(0, avail.get(x)! + roomLeft.get(x)!);
    const limits = [
      ...adjacent.filter(blocked).map((x) => `No-Split: ${label(x)} already ${describeOrder(orderOf(x)!)}`),
      // The reserve only where it binds: a source could send enough, keep kept, but for it; or
      // dropping the keep alone would not do either (both stand in the way).
      ...(reserved && could.some(({ x, keep }) => most.get(x)! - keep >= cost || unkept(x) < cost)
        ? [`${reserved} of the income is held back for my commander's territory`]
        : []),
      ...could
        .filter(({ keep }) => !noSplit && keep > 0)
        .map(({ x, keep }) => `${label(x)} keeps ${keep} to hold ${myCommanders.has(x) ? 'my commander' : 'its other borders'}`),
      // No-Split (#124): the whole stack would go, so a source that must hold sends nothing.
      ...could.flatMap(({ x }) => {
        const h = mustHold(x, t, most.get(x)!);
        return h ? [`No-Split: ${label(x)} must hold its border and would send its whole stack`] : [];
      }),
      ...(order.length && !could.length
        ? [`unaffordable: at most ${Math.max(...most.values())} attackers from any one territory (every movable army and every deploy)`]
        : []),
    ];
    // Nothing above binds, yet no source could: name what each could actually send (under
    // Local Deployment, its pool room is what stops it).
    if (!limits.length)
      for (const { x } of could)
        limits.push(
          `${label(x)} can send at most ${unkept(x)}${local ? ` (Local Deployment: only ${roomLeft.get(x)} may be deployed there)` : ''}`,
        );
    unstruck.push({
      t,
      text: `${at} is in reach, but killing it needs ${cost} attackers (${sizing}), more than my territories next to it can send this turn${limits.length ? ` (${limits.join('; ')})` : ''}: not attacked.`,
    });
  }
  if (guarded) {
    const candidates = [...ownedBy.keys()]
      .filter((p) => inReach(p) && !struck.has(p) && !ownedBy.get(p)!.some(uncounted))
      .sort(
        (a, b) =>
          ownedBy.get(a)!.length - ownedBy.get(b)!.length ||
          ownedBy.get(a)!.reduce((n, t) => n + armiesOf(t), 0) - ownedBy.get(b)!.reduce((n, t) => n + armiesOf(t), 0) ||
          a - b,
      );
    // A typical expansion capture: the median cost of the visible neutrals next to me.
    const neutralCosts = [...targets.values()].filter((tg) => !tg.enemy).map((tg) => tg.cost).sort(byNum);
    const expansionCost = neutralCosts.length ? neutralCosts[(neutralCosts.length - 1) >> 1]! : null;
    /**
     * Each of `p`'s visible territories, sized for its full deploy plus the pressure margin,
     * costs at most PRESSURE_FACTOR typical expansions (AHEAD_PRESSURE_FACTOR ahead in a 1v1 under
     * the profile, rule 0p.3; with no visible neutral next to me,
     * nothing to compare with: no limit). All or nothing.
     */
    const pressureAffordable = (p: number): { t: number; from: number; cost: number }[] | null => {
      const d = deployOf(p);
      if (expansionCost === null) return [];
      // #120: a capture over the limit displaces no expansion when the armies already on one source
      // beyond what holds it pay for all of it (no deploys): it is waived, each source paying once
      // (never under No-Split, where it takes that source's one order).
      const idle = new Map<number, number>();
      const waived: { t: number; from: number; cost: number }[] = [];
      for (const t of [...ownedBy.get(p)!].sort(byNum)) {
        const cost = captureCost(armiesOf(t) + d + marginFor(d), s) ?? Infinity;
        if (cost <= pressureFactor * expansionCost) continue;
        // Under No-Split the source's one order is what the capture displaces: no waiver.
        if (noSplit) return null;
        const from = neighborsOf(g, t)
          .filter((x) => mineSet.has(x) && !locked.has(x) && !orderOf(x))
          .map((x) => ({ x, left: idle.get(x) ?? Math.max(0, movableFor(x, t)) }))
          .filter(({ left }) => left >= cost)
          .sort((a, b) => b.left - a.left || a.x - b.x)[0];
        if (!from) return null;
        idle.set(from.x, from.left - cost);
        waived.push({ t, from: from.x, cost });
      }
      return waived;
    };
    for (const p of candidates) {
      const edge = fogEdge(p);
      if (edge.length) {
        // Fog is a reason not to claim elimination, not to skip a cheap capture (#60).
        const waived = pressureAffordable(p);
        if (waived && finishOff(p, false, edge)) {
          if (waived.length)
            rationale.push(
              `Pressure on player ${p} is not priced against expansion (${pressureFactor}× a typical neutral capture, ${pressureFactor * expansionCost!}): ${waived
                .map((w) => `${label(w.t)} (${w.cost}) is paid from idle armies on ${label(w.from)}`)
                .join(', ')}, so it displaces no expansion.`,
            );
          continue;
        }
        if (finishOff(p, true))
          warnings.push(
            `player ${p} may hold more territories in the fog (next to ${edge.map(label).join(', ')}): finishing it off is not attempted, though its ${ownedBy.get(p)!.length} visible territories could all be taken this turn.`,
          );
        continue;
      }
      finishOff(p, false);
    }
  }
  for (const { t, text } of unstruck) if (!captured.has(t)) warnings.push(text);
  // The borders those captures (a strike, finishing off) relieve: re-judged without the
  // territories taken. A struck player's other stacks still threaten: attacks interleave, so
  // its elimination changes next turn, not this one.
  const fallen = (n: number) => captured.has(n);
  if (captured.size)
    for (const id of [...borders.keys()]) {
      if (!neighborsOf(g, id).some(fallen)) continue;
      const b = borderAt(id, fallen);
      if (b) borders.set(id, b);
      else borders.delete(id);
    }
  assessThreats();
  triage();

  if (myCommanders.size)
    rationale.push(
      `My commander stays on ${[...myCommanders].map(label).join(', ')}: planned moves carry armies only, never the commander.`,
    );

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
      const before = budget;
      f();
      expansionSpent += before - budget;
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
      const cost = targets.get(t)!.cost;
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
    const strikeWorth = (lost: number, o: BreakOption) => weight * (lost + (o.take ?? o.survivors) / PAYBACK_TURNS);
    const round2 = (v: number) => Math.round(v * 100) / 100;
    /**
     * At most what a capture of `t` could draw on now: every source free to attack plus the
     * deployable budget. Below its cost the capture cannot be planned this turn.
     */
    const affordable = (t: number) => {
      const tg = targets.get(t)!;
      const free = tg.sources.filter((x) => !locked.has(x) && !orderOf(x)).reduce((n, x) => n + Math.max(0, avail.get(x)!), 0);
      return free + Math.max(0, budget - reserve) >= tg.cost;
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
      const before = budget;
      noteRecent(t);
      deploy(t.id, t.holdCost);
      if (!tryCapture(n, breakReason(b), { from: t.id, keep: avail.get(t.id)! })) {
        // Refused (R3: it would complete a bonus I cannot hold next turn): just hold.
        rationale.push(
          `Deploy ${t.holdCost} to ${label(t.id)} so it holds (protects +${t.value}): ${heldStack(t)} need ${toTake(t.have + t.units + t.holdCost)} to take, above the ~${t.threat} threat.`,
        );
        return true;
      }
      expansionSpent += before - budget - t.holdCost;
      anchor ??= moves[moves.length - 1]!.from;
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
          if (!tryCapture(o.t, breakReason(b))) return;
          anchor ??= moves[moves.length - 1]!.from;
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
          anchor ??= moves[moves.length - 1]!.from;
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
          theirIncome: deployOf(front.player),
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
          const pending = !unitsDue && expansionLeft > 0 && u.worth < topValue && !recent ? Math.max(0, floor - expansionSpent) : 0;
          const cost = u.members.filter((m) => !heldBorders.has(m.id)).reduce((n, m) => n + m.holdCost, 0);
          if (cost <= budget && cost > budget - pending) {
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
        (oneVsOne ? Number(a.kind === 'advance') - Number(b.kind === 'advance') : 0) ||
        b.score - a.score ||
        a.cost - b.cost ||
        a.borders - b.borders ||
        rank[a.kind] - rank[b.kind] ||
        a.id - b.id,
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
      const before = fundable(pending, budget);
      const restore = snapshot();
      const spent = expansionSpent;
      const left = expansionLeft;
      c.run();
      const after = new Set(fundable(pending, budget));
      const starved = before.filter((u) => !after.has(u));
      const lost = starved.reduce((n, u) => n + u.value, 0);
      // #122: a starved unit that cannot even be kept short (near miss, floor) is conceded. Waiting
      // costs the completion one turn of its value; conceding a held bonus loses its value every
      // turn until it is retaken — counted over PAYBACK_TURNS, the horizon every payback test
      // uses. So the completion goes first only when its one turn earns more than that.
      // Under Local Deployment only what may be deployed on its borders counts (pools respected).
      const kept = starved.map((u) => keptShort(u, local ? Math.min(budget, leftFor(u)) : budget));
      const conceding = starved.filter((_, i) => !kept[i]).reduce((n, u) => n + u.value, 0);
      // Units only left short (a near miss, a floor) still stand: the completion goes first when it
      // earns more than they are worth, or — when each stays a near miss — pays for itself within a
      // turn (#122: a +3 for 3 armies was deferred so a near miss could be topped up to sure).
      const first =
        conceding > 0
          ? c.value > PAYBACK_TURNS * conceding
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
        if (owed.every((t) => t.holdCost <= roomAt(t.id)) && owed.reduce((n, t) => n + t.holdCost, 0) <= budget)
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
        if (worth > 0 ? lost > PAYBACK_TURNS * worth : lost > PLAIN_EXPANSION_LOSS) {
          const reach = Math.max(...neighborsOf(g, t.id).filter((x) => avail.has(x)).map((x) => (avail.get(x) ?? 0) + roomAt(x)));
          if (reach >= t.cost)
            rationale.push(
              worth > 0
                ? `Do not expand into ${label(t.id)}: it adds +${worth} a turn and loses ~${lost} armies, more than ${PAYBACK_TURNS} turns of it pay back.`
                : `Do not expand into ${label(t.id)}: it adds no income and loses ~${lost} armies (more than ${PLAIN_EXPANSION_LOSS}), in no bonus worth completing.`,
            );
          continue;
        }
      }
      tryExpand(t.id, 'expands territory');
    }
  }

  // ---- 4e. never stand still (#104, #107) ----
  // A plan with no capture at all (no expansion, break, finishing off or strike), in the opening
  // or expansion phase or with my armies over the army cap, takes the cheapest affordable neutral
  // capture toward the positive bonus with the fewest armies to finish, uneconomic or not. It runs
  // after every hold, so it only spends what they leave. Its steps are ranked by what this turn can
  // afford (#107): the armies that can reach each (its best source's movable armies plus what may
  // still be deployed there) against its cost, then by the bonus's armies to finish. In the contact
  // and late phases (#107) enemy territories it can take at a trade of at least even join them,
  // ranked by the armies each capture loses (#112), and every other capture that loses nothing
  // is taken too.
  /**
   * #125: the step rule 4e ranked first and could not afford this turn (its size, nothing else):
   * the leftover saves toward it (rule 5) and idle stacks stage toward it (rule 6).
   */
  let saveStep: { t: number; bonusId: number; cost: number } | undefined;
  if (goal !== 'complete-bonus' && captured.size === 0) {
    const early = profile.phase === 'opening' || profile.phase === 'expansion';
    // In a 1v1 the strike stack (rule 0p.3c, #102) is contact's own answer: it attacks every turn.
    const strikeStackRuns = auto && profile.format === '1v1' && goal !== 'defend' && facing.size > 0;
    // A caller who chose `defend` gets no contact fallback (a `defend` adapt picked still does: its
    // holds come first); one who chose `expand` only its neutral steps.
    const contact =
      (profile.phase === 'contact' || profile.phase === 'late') && !strikeStackRuns && opts.goal !== 'defend';
    const enemyFallback = contact && opts.goal !== 'expand';
    const cap = s.armyCap ?? null;
    const total = mine.reduce((n, id) => n + armiesOf(id), 0) + income;
    const capped = cap !== null && cap > 0 && income > 0 && total > cap * income;
    if (early || capped || contact) {
      /** Ascending, safe for Infinity (a bonus that cannot be costed): Infinity − Infinity is NaN. */
      const asc = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);
      const toward = [...finishCost]
        .filter(([, f]) => f.net > 0)
        .sort(([a, x], [b, y]) => asc(x.cost, y.cost) || y.value - x.value || a - b);
      const bonusRank = new Map(toward.map(([id], i) => [id, i]));
      const WITHDRAWS = 'withdraws from a conceded border';
      /** Armies rule 1b withdrew from conceded `x` this turn (they may attack out instead). */
      const withdrawnFrom = (x: number) =>
        moves.find((m) => m.from === x && m.kind === 'transfer' && m.reason === WITHDRAWS)?.armies ?? 0;
      interface Reach {
        from: number | undefined;
        movable: number;
        deploy: number;
        reach: number;
        /** The source is a conceded border: it attacks out (with deploys) rather than withdraw. */
        viaConceded: boolean;
        /** No usable source: why each neighbour of mine is out. */
        blocked: { x: number; why: 'hold' | 'conceded' | 'split' }[];
      }
      /**
       * What can reach `t` this turn, as {@link tryCapture} judges it: its best single source's
       * movable armies (my commander's territory keeps what holds it) plus what may still be
       * deployed there. A source that holds its border (locked) or already issues an order
       * (No-Split) is out. A conceded border counts with the armies rule 1b would withdraw and
       * with deploys (#107): rather than stand still it attacks out, and its deploys leave with
       * the attack — but only when no unconceded source can take it alone. On a tie a source that
       * is not conceded wins.
       */
      const reachOf = (t: number): Reach => {
        let best: Reach = { from: undefined, movable: 0, deploy: 0, reach: 0, viaConceded: false, blocked: [] };
        const blocked: Reach['blocked'] = [];
        const tg = targets.get(t)!;
        for (const x of [...tg.sources].sort(byNum)) {
          const back = conceded.has(x) ? withdrawnFrom(x) : 0;
          // A conceded border kept in place (its garrison stays, not withdrawn) is not holding its
          // border: name it as conceded.
          if (back === 0 && locked.has(x)) {
            blocked.push({ x, why: !conceded.has(x) ? 'hold' : orderOf(x) ? 'split' : 'conceded' });
            continue;
          }
          if (back === 0 && orderOf(x)) {
            blocked.push({ x, why: 'split' });
            continue;
          }
          const movable = Math.max(0, movableFor(x, t) + back);
          // Deploys reach a conceded source only through the attack-out path below.
          const viaConceded = conceded.has(x) && !concededSource(x, t, tg.cost);
          const deploy = Math.max(0, spareAt(x));
          const reach = movable + deploy;
          // An unconceded source that can take it alone goes first: a conceded border attacks out
          // only when none can, so its armies are not thrown away for a step another source affords.
          const fits = !conceded.has(x) && reach >= tg.cost;
          const bestFits = best.from !== undefined && !conceded.has(best.from) && best.reach >= tg.cost;
          if (
            best.from === undefined ||
            (fits && !bestFits) ||
            (fits === bestFits && (reach > best.reach || (reach === best.reach && best.viaConceded && !viaConceded)))
          )
            best = { from: x, movable, deploy, reach, viaConceded, blocked: [] };
        }
        return best.from === undefined ? { ...best, blocked } : best;
      };
      /**
       * Undo rule 1b's withdrawal from conceded `x` so it may attack out (#107); the result redoes
       * it. A conceded border never withdrawn (nowhere to go) needs nothing undone.
       */
      const reclaim = (x: number): (() => void) => {
        const i = moves.findIndex((m) => m.from === x && m.kind === 'transfer' && m.reason === WITHDRAWS);
        if (i < 0) return () => {};
        const [m] = moves.splice(i, 1) as [PlannedMove];
        const had = { avail: avail.get(x)!, incoming: incoming.get(m.to) ?? 0, card: cardAdvice };
        avail.set(x, had.avail + m.armies);
        locked.delete(x);
        if (had.incoming - m.armies > 0) incoming.set(m.to, had.incoming - m.armies);
        else incoming.delete(m.to);
        const r = rationale.findIndex((l) => l.startsWith(`Withdraw ${m.armies} from ${label(x)} to `));
        const rLine = r >= 0 ? rationale.splice(r, 1)[0] : undefined;
        const w = warnings.findIndex((l) => l.startsWith(`The withdrawal from ${label(x)} only executes`));
        const wLine = w >= 0 ? warnings.splice(w, 1)[0] : undefined;
        if (!moves.some((o) => o.kind === 'transfer' && o.reason === WITHDRAWS)) cardAdvice = null;
        return () => {
          moves.splice(i, 0, m);
          avail.set(x, had.avail);
          locked.add(x);
          if (had.incoming > 0) incoming.set(m.to, had.incoming);
          else incoming.delete(m.to);
          if (rLine !== undefined) rationale.splice(r, 0, rLine);
          if (wLine !== undefined) warnings.splice(w, 0, wLine);
          cardAdvice = had.card;
        };
      };
      // #107, in contact: every visible enemy territory next to mine (no enemy commander on it)
      // whose capture does not lower income is a candidate. One not already a target is added for this rule (and dropped again
      // unless taken), sized like any capture at the plan's win chance.
      const added: number[] = [];
      const enemyTs: number[] = [];
      if (enemyFallback)
        for (const t of [...g.territoryById.keys()].sort(byNum)) {
          // #179: a buffer left standing is no candidate (its "Not attacking" line says why).
          if (mineSet.has(t) || captured.has(t) || spared.has(t)) continue;
          const st = state.get(t);
          if (st?.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null || uncounted(t)) continue;
          // An enemy commander is rule 1s's, sized for its owner's full deploy: never a fallback.
          if (unitsAt(t) > 0) continue;
          const sources = neighborsOf(g, t).filter((n) => mineSet.has(n));
          if (!sources.length || gainWith([t]) < 0) continue;
          if (!targets.has(t)) {
            const cost = costAt(t);
            if (cost === null) continue;
            targets.set(t, { id: t, cost, enemy: true, sources });
            added.push(t);
          }
          enemyTs.push(t);
        }
      const seen = new Set<number>();
      const steps = toward
        .flatMap(([id, f]) =>
          bonusTs
            .get(id)!
            .filter((t) => targets.has(t) && !targets.get(t)!.enemy && !captured.has(t) && gainWith([t]) >= 0)
            .sort((a, b) => targetScoreCost(a) - targetScoreCost(b) || targets.get(a)!.cost - targets.get(b)!.cost || a - b)
            .map((t, k) => ({ t, id, f, k, cost: targets.get(t)!.cost, ...reachOf(t) })),
        )
        // What this turn can afford first (shortfall 0 fits), then the bonus's armies to finish.
        .sort(
          (a, b) =>
            Math.max(0, a.cost - a.reach) - Math.max(0, b.cost - b.reach) ||
            bonusRank.get(a.id)! - bonusRank.get(b.id)! ||
            a.k - b.k,
        )
        // A territory in several bonuses: once, toward the first.
        .filter(({ t }) => !seen.has(t) && Boolean(seen.add(t)));
      const fewest = steps.length ? Math.min(...steps.map((x) => x.f.cost)) : Infinity;
      const economicLeft = plans.some((p) => p.remaining.some(bonusTarget));
      const why = [
        ...(early
          ? [
              economicLeft
                ? `${profile.phase} phase: no economic capture fits this turn; standing still is worse than the cheapest expansion`
                : `${profile.phase} phase: nothing passed the economy test; standing still is worse than the cheapest expansion`,
            ]
          : contact
            ? [
                `${profile.phase} phase: no capture is planned (${
                  economicLeft ? 'no economic capture fits this turn' : 'nothing passed the economy test'
                }); standing still is worse than the cheapest capture`,
              ]
            : []),
        ...(capped
          ? [
              `my ${total} armies after deploy exceed the army cap of ${cap * income} (${cap}× income ${income}): armies above it are wasted, so spending them is free`,
            ]
          : []),
      ].join('; ');
      const reasonOf = ({ id, f }: (typeof steps)[number]) =>
        `cheapest expansion toward bonus ${bonusName(id)} (+${f.value}, ${toFinish(f.cost, f.fogged, f.fogEach)}, ${
          f.cost === fewest ? 'the fewest of any bonus in reach' : 'the fewest of any bonus with a capture affordable this turn'
        })`;

      // ---- #107, in contact: enemy captures ----
      /** Rule 0p.2's setting: an FFA with two or more opponents left. Applied here with or without adapt. */
      const ffaFronts = profile.format === 'ffa' && profile.opponents >= 2 && !leadLever;
      /**
       * The first territory of mine (by id) player `p` could take next turn — its stacks next to it
       * plus max(its deploy estimate, its fastest growth there) against what taking it needs — or
       * `undefined`: `p` cannot currently attack me.
       */
      const attackableBy = (p: number): number | undefined =>
        mine.find((x) => {
          let movable = 0;
          let growth = 0;
          let next = false;
          for (const n of neighborsOf(g, x)) {
            const st = state.get(n);
            if (st?.owner.kind !== 'player' || st.owner.playerId !== p || st.armies === null) continue;
            next = true;
            movable += Math.max(0, st.armies - guard) + unitsAt(n);
            growth = Math.max(growth, growthOf.get(n)?.growth ?? 0);
          }
          const take = toTake(defenceAt(x));
          return next && take !== null && take <= movable + Math.max(deployOf(p), growth);
        });
      /** What capturing enemy `t` does to a bonus: breaks one its owner holds in full, or advances one of mine. */
      const enemyBonus = (t: number, p: number): { id: number; breaks: boolean } | undefined => {
        const breaks = g.map.bonuses
          .filter((b) => b.value > 0 && bonusTs.get(b.id)!.includes(t))
          .sort((a, b) => b.value - a.value || a.id - b.id)
          .find((b) =>
            bonusTs.get(b.id)!.every((m) => {
              const o = state.get(m)?.owner;
              return o?.kind === 'player' && o.playerId === p;
            }),
          );
        if (breaks) return { id: breaks.id, breaks: true };
        const adv = toward.find(([id]) => bonusTs.get(id)!.includes(t));
        return adv ? { id: adv[0], breaks: false } : undefined;
      };
      const enemySteps = enemyTs.map((t) => {
        const p = (state.get(t)!.owner as { playerId: number }).playerId;
        const from = attackableBy(p);
        return {
          t,
          cost: targets.get(t)!.cost,
          player: p,
          bonus: enemyBonus(t, p),
          /** Its owner can attack me now: the territory of mine it could take. */
          front: from,
          secondFront: ffaFronts && from === undefined && p !== clearLeader,
          ...reachOf(t),
        };
      });
      const enemyReason = (e: (typeof enemySteps)[number]) => {
        if (!e.bonus) return `cheapest capture: takes a territory of player ${e.player}`;
        const v = g.bonusById.get(e.bonus.id)!.value;
        if (e.bonus.breaks) return `cheapest capture: breaks bonus ${bonusName(e.bonus.id)} (+${v}) of player ${e.player}`;
        const f = finishCost.get(e.bonus.id)!;
        return `cheapest capture: advances bonus ${bonusName(e.bonus.id)} (+${v}, ${toFinish(f.cost, f.fogged, f.fogEach)}) from player ${e.player}`;
      };
      /**
       * Every candidate, in the order tried. Outside contact: rule 4e's neutral steps as ranked
       * above. In contact (#107, #112): the neutral steps and the enemy captures together —
       * affordable first, then the armies lost, then the armies sent, then one that breaks or
       * advances a bonus, then (neutral steps) rule 4e's order, then id; under rule 0p.2 a capture
       * that opens a second front (its owner cannot attack me now) only after every other.
       */
      type Pick =
        | { kind: 'neutral'; st: (typeof steps)[number] }
        | { kind: 'enemy'; st: (typeof enemySteps)[number] };
      const shortOf = (x: { cost: number; reach: number }) => Math.max(0, x.cost - x.reach);
      const rank4e = new Map(steps.map((x, i) => [x.t, i]));
      const picks: Pick[] = [
        ...steps.map((st): Pick => ({ kind: 'neutral', st })),
        ...enemySteps.map((st): Pick => ({ kind: 'enemy', st })),
      ];
      /**
       * What capturing `st` is expected to cost (#112): the defensive kills on its attackers at the
       * game's rates, and the armies sent. One source that can take it alone sends its cost and
       * loses the defenders' kills; otherwise the combined capture rule 3a would plan, its every
       * attack's losses (the softeners' and the finisher's) and armies counted — only with no luck
       * and straight rounding, where rule 3a makes one.
       */
      const lossOf = (st: Reach & { t: number; cost: number }): { lost: number; sent: number } => {
        const single = { lost: Math.min(st.cost, straightKills(defendersAt(st.t), rates.defensiveKillRate)), sent: st.cost };
        // Under luck or weighted rounding a combined capture is never made (rule 3a, `tryCombined`):
        // the single source's sizing is the one the plan would use.
        if (st.from === undefined || st.reach >= st.cost || luck > 0 || weightedRounding) return single;
        const c = combinedPlan(st.t);
        if (!c) return single;
        return {
          lost: c.softeners.reduce((n, x) => n + x.armies - x.survivors, 0) + c.armies - c.survivors,
          sent: c.softeners.reduce((n, x) => n + x.armies, 0) + c.armies,
        };
      };
      const loss = new Map(picks.map((p) => [p.st.t, lossOf(p.st)]));
      /**
       * In contact (#114): the survivors a capture leaves on a border that cannot hold next turn
       * (rule 4d's and R3's arithmetic: survivors against the threat at the expected enemy deploy),
       * with that threat. Absent when it can be held or faces no enemy. Filled below, by a trial of
       * each candidate.
       */
      const risk = new Map<number, { survivors: number; threat: number }>();
      /** A candidate's ranking cost in contact (#114): the armies it loses plus its survivors at risk. */
      const costOfPick = (t: number) => loss.get(t)!.lost + (risk.get(t)?.survivors ?? 0);
      /** "N survivor(s)". */
      const survivorsText = (n: number) => `${n} survivor${n === 1 ? '' : 's'}`;
      /**
       * "loses ~N armies" / "loses no armies": what a capture costs (#112); in contact, and when its
       * border cannot hold next turn, ", and its S survivors may fall next turn" (#114).
       */
      const lossText = (t: number) => {
        const n = loss.get(t)!.lost;
        const r = risk.get(t);
        return `${n === 0 ? 'loses no armies' : `loses ~${n} ${n === 1 ? 'army' : 'armies'}`}${
          r ? `, and its ${survivorsText(r.survivors)} may fall next turn` : ''
        }`;
      };
      // In contact (#112, #114): affordable first, then the cost (the armies the capture loses plus
      // its survivors at risk), then the armies it sends; breaking or advancing a bonus is only a
      // tie-break. Under rule 0p.2 a capture that opens a second front still comes after every other.
      const keyOf = (p: Pick) => [
        p.kind === 'enemy' && p.st.secondFront ? 1 : 0,
        shortOf(p.st),
        costOfPick(p.st.t),
        loss.get(p.st.t)!.sent,
        p.kind === 'enemy' && !p.st.bonus ? 1 : 0,
        p.kind === 'neutral' ? rank4e.get(p.st.t)! : Infinity,
        p.st.t,
      ];
      const reasonFor = (p: Pick) => {
        const r = p.kind === 'neutral' ? reasonOf(p.st) : enemyReason(p.st);
        // In contact the reason names what the capture costs (#112).
        if (!contact) return r;
        const head = p.kind === 'neutral' ? 'cheapest expansion' : 'cheapest capture';
        return `${head} (${lossText(p.st.t)})${r.slice(head.length)}`;
      };
      /** A candidate: what reaches it, as {@link reachOf} judges it. */
      type Cand = Reach & { t: number; cost: number };
      /**
       * Why a step was not taken: rule 4d's frontier stop (with the frontier it would leave), R3
       * (it completes a bonus that falls next turn), No-Split (a source that could take it already
       * issues an order), a trade below even, a hold it would leave short (contact), or its size.
       */
      type Fail =
        | { kind: '4d'; holdCost: number; income: number }
        | { kind: 'r3' }
        | { kind: 'split'; from: number }
        | { kind: 'trade'; lost: number; killed: number }
        | { kind: 'hold'; from: number; stays: number; spare: number; threat: number }
        | ({ kind: 'must-hold' } & MustHold)
        | { kind: 'size' };
      const failed = new Map<number, Fail>();
      /**
       * Every source of the attack on `t` must still hold its border once `t` is taken (#107 in
       * contact; every phase since the opening emptied border stacks live). A source left short gets the deploys still available there that make it hold (they
       * are placed now, so the leftover deploy cannot go elsewhere; the step's undo takes them
       * back). A source that cannot be made to hold is returned, with what stays, the deploys that
       * were available and the threat it faces; else `undefined`. A conceded border is skipped: its
       * armies are given up anyway.
       */
      const holdLeftShort = (t: number): { from: number; stays: number; spare: number; threat: number } | undefined => {
        // No-Split (#124): deploys there would leave with the attack, and a source that must hold
        // never attacks (tryCapture): one that protects nothing may be emptied.
        if (noSplit) return undefined;
        for (const m of moves) {
          if (m.kind !== 'attack' || m.to !== t || conceded.has(m.from)) continue;
          const th = threatAt(m.from, (n) => captured.has(n));
          if (!th) continue;
          const stays = stayAt(m.from);
          const holds = (n: number) => (toTake(stays + n + unitsAt(m.from)) ?? Infinity) > th.threat;
          if (holds(0)) continue;
          const spare = Math.max(0, spareAt(m.from));
          let n = 1;
          while (n <= spare && !holds(n)) n++;
          if (n > spare) return { from: m.from, stays, spare, threat: th.threat };
          deploy(m.from, n);
          rationale.push(
            `Deploy ${n} to ${label(m.from)} so it still holds its border after the attack on ${label(t)} (${stays + n} stay against a threat of ${th.threat}).`,
          );
        }
        return undefined;
      };
      /**
       * Why a step that does not fit failed (#121): a source that keeps what holds its border could
       * have afforded it by spending that garrison — then it is the hold it would leave short (as
       * {@link holdLeftShort} words it), else its size. Tried with the keeps off and undone.
       */
      const sizeOrHold = (st: Cand, reason: string): Fail => {
        const restore = snapshot();
        spendKeeps = true;
        let short: ReturnType<typeof holdLeftShort>;
        try {
          if (st.from !== undefined && conceded.has(st.from)) return { kind: 'size' };
          const ok = tryCapture(st.t, reason);
          short = ok ? holdLeftShort(st.t) : undefined;
        } finally {
          spendKeeps = false;
          restore();
        }
        return short ? { kind: 'hold', ...short } : { kind: 'size' };
      };
      /** The trade of the planned capture of `t`: defenders killed against attackers lost (every attack on it). */
      const tradeOf = (t: number): { lost: number; killed: number } => {
        const sent = moves.filter((m) => m.kind === 'attack' && m.to === t);
        const killed = defendersAt(t);
        if (sent.length === 1) return { lost: straightKills(killed, rates.defensiveKillRate), killed };
        // A combined capture: every attack's losses — the softeners' (their survivors return home)
        // and the finisher's.
        let left = killed;
        let lost = 0;
        for (const m of sent) {
          const kills = Math.min(left, straightKills(m.armies, rates.offensiveKillRate));
          lost += Math.min(m.armies, straightKills(left, rates.defensiveKillRate));
          left -= kills;
        }
        return { lost, killed };
      };
      /**
       * Try one step. From a conceded border (#107) rule 1b's withdrawal is undone first and the
       * border attacks out with deploys, a rationale line saying so. The result undoes it all.
       */
      const attempt = (st: Cand, reason: string): (() => void) | null => {
        const out = st.from !== undefined && conceded.has(st.from) ? st.from : undefined;
        // Neither the snapshot nor a no-op unreclaim puts back the card advice an attack out of a
        // conceded border sets (#114: a candidate only tried and undone must leave none behind).
        const card = cardAdvice;
        const unreclaim = out === undefined ? () => {} : reclaim(out);
        const before = out === undefined ? 0 : movableFor(out, st.t);
        const restore = snapshot();
        if (!tryCapture(st.t, reason, undefined, out)) {
          unreclaim();
          return null;
        }
        const move = [...moves].reverse().find((m) => m.kind === 'attack' && m.to === st.t)!;
        if (out !== undefined && move.from === out) {
          const need = Math.max(0, st.cost - before);
          // Every movable army leaves with the attack: left behind on the conceded border they are
          // lost; at the target they survive.
          const extra = Math.max(0, movableFor(out, st.t));
          if (extra > 0) {
            const sent = move.armies;
            avail.set(out, avail.get(out)! - extra);
            move.armies = sent + extra;
            move.winChance = chanceOf(move.armies, defenceAt(st.t));
            survivorsAt.set(st.t, (survivorsAt.get(st.t) ?? 0) + extra);
            captureUndo.set(st.t, () => avail.set(out, avail.get(out)! + move.armies));
            const head = `Attack ${label(st.t)} from ${label(out)} with ${sent}`;
            let r = rationale.length - 1;
            while (r >= 0 && !rationale[r]!.startsWith(`${head}:`) && !rationale[r]!.startsWith(`${head} (`)) r--;
            if (r >= 0) rationale[r] = `Attack ${label(st.t)} from ${label(out)} with ${move.armies}${rationale[r]!.slice(head.length)}`;
          }
          rationale.push(
            `Attack out of conceded ${label(out)} rather than withdraw: its ${before} movable armies${need ? ` (and ${need} deployed there, which leave with the attack)` : ''} take ${label(st.t)}; one capture is worth more than saving them.`,
          );
          // Like the withdrawal it replaces, the attack only runs if the border is still mine.
          warnings.push(
            `The attack out of ${label(out)} only executes if ${label(out)} is still mine when the order runs; play Order Priority so it goes first.`,
          );
          cardAdvice = 'order-priority';
        } else unreclaim();
        const viaOut = out !== undefined && move.from === out;
        return () => {
          // restore() rewinds to the snapshot, taken after the reclaim and counting moves, lines
          // and warnings by length: a withdrawal already put back is taken out again first, so
          // the rewind removes only this step and the withdrawal is then put back once.
          const unwind = out === undefined || viaOut ? unreclaim : reclaim(out);
          restore();
          unwind();
          cardAdvice = card;
        };
      };
      /**
       * After `t` is captured in the plan (#114): its survivors and the threat they face, when they
       * cannot hold it next turn (rule 4d's border arithmetic: they need deploys), else `undefined`.
       */
      const exposure = (t: number): { survivors: number; threat: number } | undefined => {
        const held = heldNow();
        const survivors = survivorsAt.get(t) ?? 0;
        const b = borderOf(t, held, survivors);
        if (!b.enemy || b.need <= 0) return undefined;
        return { survivors, threat: threatAt(t, (n) => held.has(n))!.threat };
      };
      if (contact) {
        // #114: rule 4d is a cost here, not a veto. Each candidate is tried (and undone) to see
        // what its capture leaves exposed; then they are ranked.
        evenTradesOnly = true;
        for (const pick of picks) {
          const undo = attempt(pick.st, '');
          if (!undo) continue;
          const e = exposure(pick.st.t);
          if (e) risk.set(pick.st.t, e);
          undo();
        }
        evenTradesOnly = false;
        picks.sort((a, b) => {
          const x = keyOf(a);
          const y = keyOf(b);
          for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
          return 0;
        });
      }
      let taken: Pick | undefined;
      evenTradesOnly = contact;
      for (const pick of picks) {
        const st = pick.st;
        const undo = attempt(st, reasonFor(pick));
        if (!undo) {
          const r = refusal as typeof refusal;
          failed.set(st.t, r ?? sizeOrHold(st, reasonFor(pick)));
          continue;
        }
        // Every phase, not only contact: a capture that leaves its source to fall is worse than
        // standing still (live, an opening plan sent a 15-stack's every army at a 15-neutral
        // from beside two enemy 15-stacks).
        const short = holdLeftShort(st.t);
        if (short) {
          undo();
          failed.set(st.t, { kind: 'hold', ...short });
          continue;
        }
        // #114: in contact rule 4d is a cost (ranked above), not a veto.
        const stop = contact ? null : outgrows(st.t);
        if (stop === null) {
          taken = pick;
          break;
        }
        undo();
        if (!rationale.includes(stop)) rationale.push(stop);
        const f = stopped.find((x) => x.t === st.t)!;
        failed.set(st.t, { kind: '4d', holdCost: f.holdCost, income: f.income });
      }
      evenTradesOnly = false;
      // #107: in the opening, rule 4d's frontier stop must not make the plan stand still: one
      // capture that grows the frontier is better than none (4d still judges every other capture).
      let waived: { holdCost: number; income: number } | undefined;
      if (!taken && profile.phase === 'opening') {
        const st = steps.find((x) => failed.get(x.t)?.kind === '4d');
        const undo = st ? attempt(st, reasonOf(st)) : null;
        if (st && undo) {
          // The waiver is for the frontier the captured territory adds, never for a source the
          // attack leaves unable to hold: that is checked (and its deploys placed) again here.
          const short = holdLeftShort(st.t);
          if (short) {
            undo();
            failed.set(st.t, { kind: 'hold', ...short });
          } else {
            taken = { kind: 'neutral', st };
            waived = failed.get(st.t) as { holdCost: number; income: number };
          }
        }
      }
      /** The bonuses `t` would complete that R3 refused, as "name (#id)". */
      const refusedBonuses = (t: number) =>
        [...notCompleted.keys()]
          .filter((id) => bonusTs.get(id)?.includes(t))
          .sort(byNum)
          .map(bonusName);
      /** Why no neighbour of mine can attack `st`: each holds its border, is conceded, or already issues an order. */
      const blockedText = (st: Cand) =>
        `no neighbour of mine can attack it (${st.blocked
          .map(({ x, why }) =>
            why === 'hold'
              ? `${label(x)} stays to hold its border`
              : why === 'conceded'
                ? `${label(x)} is a conceded border whose armies stay there`
                : `${label(x)} already issues an order under No-Split`,
          )
          .join('; ')})`;
      /** "needs C, and at most R can reach it this turn (M movable on S[, a conceded border] + D to deploy[; the holds took H])". */
      const reachText = (st: Cand, held: number) =>
        st.from === undefined
          ? blockedText(st)
          : `it needs ${st.cost}, and at most ${st.reach} can reach it this turn (${st.movable} movable on ${label(st.from)}${
              conceded.has(st.from) ? ', a conceded border,' : ''
            } + ${st.deploy} to deploy${held > 0 ? `; the holds took ${held}` : ''})`;
      /** "S would stay[, S+D with the D deploys left there,] against a threat of T". */
      const holdText = (f: { stays: number; spare: number; threat: number }) =>
        `${f.stays} would stay${f.spare > 0 ? `, ${f.stays + f.spare} with the ${f.spare} deploys left there,` : ''} against a threat of ${f.threat}`;
      /** Why `st` was not taken, as a clause after its name. */
      const failText = (st: Cand, fail: Fail | undefined) => {
        if (fail?.kind === '4d')
          return `is refused by rule 4d's frontier stop: the frontier would then need ${fail.holdCost} next turn to hold, more than the next income of ${fail.income}`;
        if (fail?.kind === 'r3') {
          const names = refusedBonuses(st.t);
          return names.length
            ? `is refused by rule R3: taking it completes bonus ${names.join(', ')}, which could not be held next turn (see "completing ${names[0]} leaves …: not completed")`
            : 'is refused by rule R3: the bonus it completes could not be held next turn';
        }
        if (fail?.kind === 'split')
          return `is not planned under No-Split: ${label(fail.from)} could take it but already issues an order (one attack or transfer per territory)`;
        if (fail?.kind === 'trade')
          return `is not taken: no single source can afford it, and the combined capture loses ${fail.lost} armies for the ${fail.killed} it kills, a trade below even`;
        if (fail?.kind === 'must-hold')
          return `is not planned under No-Split: ${label(fail.from)} could take it, but its whole stack would go and leave ${fail.stays} against the ~${fail.threat} threat to a border that must hold`;
        if (fail?.kind === 'hold')
          return `is not taken: attacking it would leave ${label(fail.from)} unable to hold its border (${holdText(fail)})`;
        if (st.from === undefined) return `cannot be reached: ${blockedText(st)}`;
        // What the holds took before this rule ran (no capture spent anything yet).
        const held = income - budget;
        if (st.reach >= st.cost)
          return `is not taken, though ${st.reach} could reach it (it needs ${st.cost}): no single source can deliver them this turn`;
        if (held > 0 && st.reach + held >= st.cost) return `does not fit what the holds leave: ${reachText(st, held)}`;
        return `does not fit this turn: ${reachText(st, 0)}`;
      };
      // #112, in contact: after the fallback's capture, every other candidate that loses no armies
      // is taken too, by armies sent, then id — when every hold stays covered and income does not
      // fall. Its survivors at risk never exceed the armies it sends, so rule 4d does not stop one
      // either (#114); the rationale says when the new border may fall. A conceded border never
      // attacks out for one. Why one was not taken is kept for the list of dropped candidates.
      const free: { pick: Pick; exposed?: { survivors: number; threat: number } }[] = [];
      /** Why a candidate that loses nothing was not also taken, as a clause after its name. */
      const freeWhy = new Map<number, string>();
      if (contact && taken) {
        evenTradesOnly = true;
        const others = picks
          .filter((p) => p !== taken && loss.get(p.st.t)!.lost === 0)
          .sort((a, b) => loss.get(a.st.t)!.sent - loss.get(b.st.t)!.sent || a.st.t - b.st.t);
        for (const pick of others) {
          const t = pick.st.t;
          if (captured.has(t)) continue;
          if (gainWith([t]) < 0) {
            freeWhy.set(t, 'is not taken: with the captures planned it would lower next income');
            continue;
          }
          const now: Cand = { ...reachOf(t), t, cost: pick.st.cost };
          if (now.from === undefined) {
            freeWhy.set(t, `cannot be reached after the first capture: ${blockedText(now)}`);
            continue;
          }
          if (conceded.has(now.from)) {
            freeWhy.set(t, `is not taken: only conceded ${label(now.from)} could still attack it, and a conceded border never attacks out for a capture that only costs nothing`);
            continue;
          }
          const undo = attempt(now, reasonFor(pick));
          if (!undo) {
            freeWhy.set(t, failText(now, (refusal as typeof refusal) ?? { kind: 'size' }));
            continue;
          }
          const lost = tradeOf(t).lost;
          if (lost > 0) {
            undo();
            freeWhy.set(t, `is not taken: after the first capture it would lose ~${lost} ${lost === 1 ? 'army' : 'armies'}, so it no longer costs nothing`);
            continue;
          }
          const short = holdLeftShort(t);
          if (short) {
            undo();
            freeWhy.set(t, failText(now, { kind: 'hold', ...short }));
            continue;
          }
          free.push({ pick, exposed: exposure(t) });
        }
        evenTradesOnly = false;
      }
      // Enemy targets added for this rule and not taken are dropped again.
      for (const t of added) if (!captured.has(t)) targets.delete(t);
      // A capture of a player's territory refused as a trade below even, or for a hold it would
      // leave short: said whatever was taken.
      for (const e of enemySteps) {
        const f = failed.get(e.t);
        if (captured.has(e.t)) continue;
        if (f?.kind === 'trade')
          warnings.push(
            `Not attacking ${label(e.t)}: the combined capture loses ${f.lost} armies for the ${f.killed} it kills, a trade below even.`,
          );
        if (f?.kind === 'hold')
          warnings.push(
            `Not attacking ${label(e.t)}: it would leave ${label(f.from)} unable to hold its border (${holdText(f)}).`,
          );
      }
      if (taken) {
        const t = taken.st.t;
        rationale.push(`Take ${label(t)} though no planned capture is economic: ${why}.`);
        if (waived)
          rationale.push(
            `Take ${label(t)} though the frontier would then need ${waived.holdCost} next turn to hold, more than the next income of ${waived.income}: rule 4d's frontier stop is waived for this one capture: in the opening, one capture that grows the frontier is better than none (rule 4d still applies to every other capture).`,
          );
        if (taken.kind === 'enemy') {
          const e = taken.st;
          const { lost, killed } = tradeOf(t);
          rationale.push(`Attack on ${label(t)} kills ${killed} for ${lost} lost: a trade of at least even.`);
          if (ffaFronts)
            rationale.push(
              e.front !== undefined
                ? `Player ${e.player} can already attack me (${label(e.front)}): taking ${label(t)} opens no new front.`
                : `Player ${e.player} cannot attack me now: taking ${label(t)} opens a second front (no second front in an FFA), taken only because no neutral capture fits this turn.`,
            );
        } else {
          // The bonus with the fewest armies to finish was passed over: say why.
          const st = taken.st;
          const closer = st.f.cost > fewest ? steps.find((x) => x.f.cost === fewest) : undefined;
          if (closer) {
            const fail = failed.get(closer.t);
            rationale.push(
              `${bonusName(closer.id)} has fewer armies to finish (${closer.f.cost}), but ${
                fail?.kind === '4d'
                  ? `rule 4d's frontier stop refuses ${label(closer.t)}`
                  : fail?.kind === 'size' || fail === undefined
                    ? closer.from === undefined
                      ? `${label(closer.t)} ${failText(closer, fail)}`
                      : `${label(closer.t)} needs ${closer.cost} and at most ${closer.reach} can reach it this turn`
                    : `${label(closer.t)} ${failText(closer, fail)}`
              }.`,
            );
          }
        }
        for (const { pick, exposed } of free) {
          const t = pick.st.t;
          rationale.push(
            `Also take ${label(t)}: it costs nothing (it loses no armies, every hold stays covered and income does not fall)${
              exposed
                ? `; its ${survivorsText(exposed.survivors)} may fall next turn (a threat of ${exposed.threat} against them), no more than the armies it sends`
                : ''
            }.`,
          );
          if (pick.kind === 'enemy' && ffaFronts && pick.st.secondFront)
            rationale.push(
              `Player ${pick.st.player} cannot attack me now: taking ${label(t)} opens a second front, taken only because it costs nothing.`,
            );
        }
      } else if (picks[0]) {
        const top = picks[0];
        const head =
          top.kind === 'neutral'
            ? `Standing still: no capture is planned, and the cheapest expansion (${label(top.st.t)}, ${top.st.cost} armies, toward bonus ${bonusName(top.st.id)})`
            : `Standing still: no capture is planned, and the cheapest capture (${label(top.st.t)}, ${top.st.cost} armies, a territory of player ${top.st.player})`;
        const tail = `${failText(top.st, failed.get(top.st.t))}.`;
        warnings.push(`${head} ${tail}`);
        const why = failed.get(top.st.t);
        if (top.kind === 'neutral' && (why === undefined || why.kind === 'size'))
          saveStep = { t: top.st.t, bonusId: top.st.id, cost: top.st.cost };
      }
      // #114, in contact: every candidate the fallback considered and dropped leaves a reason (the
      // top one, when nothing is taken, is in the stand-still warning). One already said elsewhere
      // is not repeated: an enemy capture refused as a trade or for a hold has its "Not attacking"
      // warning.
      const dropped = (contact ? picks : []).flatMap((p) => {
        const t = p.st.t;
        if (captured.has(t) || (!taken && p === picks[0])) return [];
        const fail = failed.get(t);
        if (fail && p.kind === 'enemy' && (fail.kind === 'trade' || fail.kind === 'hold')) return [];
        if (fail) return [`${label(t)} ${failText(p.st, fail)}`];
        const why = freeWhy.get(t);
        if (why) return [`${label(t)} ${why}`];
        if (!taken) return [`${label(t)} ${failText(p.st, undefined)}`];
        if (shortOf(p.st) > 0) return [`${label(t)} ${failText(p.st, undefined)}`];
        const after = `is ranked after ${label(taken.st.t)}`;
        if (p.kind === 'enemy' && p.st.secondFront && !(taken.kind === 'enemy' && taken.st.secondFront))
          return [`${label(t)} ${after}: player ${p.st.player} cannot attack me now, so it is tried only after every other capture`];
        const c = costOfPick(t);
        const tc = costOfPick(taken.st.t);
        return [
          `${label(t)} ${after}: it costs ${c} (${lossText(t)}) against ${tc}${c === tc ? ' (ties go by armies sent, then a bonus, then id)' : ''}`,
        ];
      });
      if (dropped.length) rationale.push(`Other candidates not taken: ${dropped.join('; ')}.`);
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
  /** The strike stack rule 0p.3c built this turn (#72), and the leftover it got. */
  let strikeStack: { id: number; player: number; income: number; source: string; deployed: number } | undefined;
  /** Armies a Local Deployment pool put on each border this turn (#103): never moved out. */
  const poolDeployed = new Map<number, number>();
  /** A territory the plan has not given up (or gave up but whose garrison may still hold it). */
  const open = (id: number) => !conceded.has(id) || mayHold.has(id);
  /** Armies that stay on a border after its deploys, outgoing moves and incoming withdrawals. */
  const stays = (id: number) => avail.get(id)! + guard + (incoming.get(id) ?? 0);
  // Concentrate (#72, adapting in a 1v1 facing the opponent): the spare deploys go to one strike stack
  // on the border facing the strongest opponent (the highest income estimate, tracked when its
  // track is trusted), the stack that keeps the most there, rather than to comfort margins.
  // A 1v1 rule: in an FFA or a team game the comfort margins keep the leftover (several fronts).
  // Chosen even when holds and captures leave no leftover (#102): the stack is still spent.
  let stack: { id: number; player: number; income: number; source: string } | undefined;
  /**
   * No-Split (#124): `x`'s one order when it is a small expansion a strike may take over — a single
   * attack on a neutral that completes no bonus this turn, stages none and is not focused.
   */
  const smallExpansion = (x: number): PlannedMove | undefined => {
    const m = orderOf(x);
    if (!m || m.kind !== 'attack' || !captured.has(m.to) || combined.has(m.to)) return undefined;
    if (state.get(m.to)?.owner.kind !== 'neutral' || staged.has(m.to) || inFocus(m.to)) return undefined;
    const now = heldNow();
    const before = completedBy(new Set([...now].filter((y) => y !== m.to)));
    return completedBy(now).some((id) => !before.includes(id)) ? undefined : m;
  };
  /** The stack on `x` a strike could send: what stays, plus a small expansion's armies (No-Split). */
  const stackAt = (x: number) => stays(x) + (smallExpansion(x)?.armies ?? 0);
  if (auto && profile.format === '1v1' && goal !== 'defend' && facing.size) {
    const player = [...facing]
      .map((p) => ({ p, e: estimates.get(p) }))
      .sort((a, b) => (b.e?.estimate ?? 0) - (a.e?.estimate ?? 0) || a.p - b.p)[0]!;
    /** The opponent's territories next to `x` a strike could aim at. */
    const aims = (x: number) =>
      neighborsOf(g, x).filter((n) => {
        const st = state.get(n);
        return !captured.has(n) && st?.owner.kind === 'player' && st.owner.playerId === player.p && st.armies !== null;
      });
    const fronts = mine
      .filter(
        (x) =>
          open(x) &&
          // No-Split: a territory whose one order is not a small expansion has nothing left to strike with.
          (!orderOf(x) || smallExpansion(x) !== undefined) &&
          aims(x).length > 0,
      )
      .sort((a, b) => stackAt(b) - stackAt(a) || a - b);
    /**
     * #120: the best strike `x` could make this turn with every leftover army on it — an adjacent
     * target sized for its defenders plus what its owner may deploy there first (rule 3) — and the
     * armies it would have to spare, after what holds `x` once that target falls. `null` when none
     * fits.
     */
    const bestStrike = (x: number) => {
      const room = Math.max(0, Math.min(budget, roomAt(x)));
      let best: { n: number; cost: number; extra: number; spare: number; can: number } | null = null;
      for (const n of aims(x)) {
        const extra = reinforcementAt(n);
        const cost = costAt(n, defenceAt(n) + extra);
        if (cost === null || gainWith([n]) < 0) continue;
        const threat = Math.max(threatAt(x, (y) => captured.has(y) || y === n)?.threat ?? 0, deployOf(player.p));
        const hold = Math.max(0, holdArmies(threat) - unitsAt(x));
        const can = stackAt(x) + room - guard;
        const spare = Math.min(can - cost, stackAt(x) + room - cost - hold);
        if (spare < 0) continue;
        if (!best || spare > best.spare || (spare === best.spare && n < best.n)) best = { n, cost, extra, spare, can };
      }
      return best;
    };
    // Rule 0p.3c (#120): the stack goes where it can strike — the border with the most to spare
    // after its best strike — and only with no border able to strike, to the one holding the most
    // armies (live, 180 armies fed the front facing the opponent's biggest stack while a strike on
    // a 1-army territory elsewhere was affordable every turn).
    const able = noSplit ? [] : fronts.flatMap((x) => {
      const b = bestStrike(x);
      return b ? [{ x, ...b }] : [];
    });
    able.sort((a, b) => b.spare - a.spare || stackAt(b.x) - stackAt(a.x) || a.x - b.x);
    const pick = able[0];
    const id = pick?.x ?? fronts[0];
    if (pick) {
      const most = fronts[0]!;
      rationale.push(
        `Strike stack on ${label(pick.x)}: ${label(pick.x)} can take ${label(pick.n)} this turn (${pick.cost} of the ${pick.can} it could send with the leftover, sized for its ${defenceAt(pick.n)} defenders plus the ~${pick.extra} player ${player.p} may deploy there first; ${pick.spare} to spare once it holds)${
          most !== pick.x
            ? `, rather than ${label(most)}, which holds more armies but ${able.some((a) => a.x === most) ? `has less to spare after its best strike` : 'can take nothing next to it so sized'}`
            : ''
        }.`,
      );
    }
    if (id !== undefined)
      stack = {
        id,
        player: player.p,
        income: player.e?.estimate ?? MIN_ENEMY_DEPLOY,
        source: player.e?.source === 'tracked' ? 'tracked' : player.e?.source === 'observed' ? 'observed' : 'estimated',
      };
  }
  /**
   * #125: the capture to save toward — rule 4e's top step it could not afford, else (rule 4f
   * committing) the closest bonus's cheapest missing member in reach when this turn made no capture
   * into that bonus — and its source: my territory beside it (open, not a softener, issuing no
   * order under No-Split) with the most armies free, ties by id.
   */
  const stepSource = (
    open: (x: number) => boolean,
    notSoftening: (x: number) => boolean,
  ): { t: number; bonusId: number; cost: number; from: number } | undefined => {
    let step = saveStep;
    if (!step && committing) {
      for (const p of byCloseness) {
        if (p.remaining.some((t) => captured.has(t))) return undefined;
        const t = p.remaining
          .filter((x) => bonusTarget(x) && state.get(x)?.owner.kind === 'neutral')
          .sort((a, b) => targets.get(a)!.cost - targets.get(b)!.cost || a - b)[0];
        if (t === undefined) continue;
        step = { t, bonusId: p.bonusId, cost: targets.get(t)!.cost };
        break;
      }
    }
    if (!step || captured.has(step.t)) return undefined;
    const from = neighborsOf(g, step.t)
      .filter((x) => mineSet.has(x) && open(x) && notSoftening(x) && !orderOf(x))
      .sort((a, b) => avail.get(b)! - avail.get(a)! || a - b)[0];
    // Only a step this turn cannot afford: one the plan could take but did not (R3, rule 4c or 4d
    // refused it) is no reason to save.
    if (from === undefined || avail.get(from)! + roomAt(from) >= step.cost) return undefined;
    return { ...step, from };
  };
  /** Set by the leftover deploy (rule 5): the step it saved toward, which idle stacks stage toward (rule 6). */
  let staging: { t: number; bonusId: number; cost: number; from: number } | undefined;
  // ---- leftover deploy ----
  if (budget > 0) {
    const foggedNext = (id: number) =>
      neighborsOf(g, id).filter((n) => {
        const st = state.get(n);
        return !captured.has(n) && (!st || st.owner.kind === 'unknown' || st.armies === null);
      }).length;
    const short = [...borders.values()]
      // No-Split (#124): a deploy on a territory that issues an order leaves with it, holding nothing.
      .filter((b) => open(b.id) && !orderOf(b.id))
      .map((b) => ({ ...b, take: toTake(stays(b.id) + unitsAt(b.id)) }))
      .filter((b) => b.take !== null && b.take <= COMFORT_MARGIN * b.threat)
      .sort((a, b) => valueOf(b.id) - valueOf(a.id) || a.take! / a.threat - b.take! / b.threat || a.id - b.id);
    /** No-Split (#124): an attack that only softens its target; deploys there would leave with it, killing nothing more that matters. */
    const softens = (m: PlannedMove) =>
      noSplit && moves.some((o, i) => i > moves.indexOf(m) && o.kind === 'attack' && o.to === m.to);
    const expansion = anchor ?? moves.find((m) => m.kind === 'attack' && !softens(m))?.from;
    /** Not a softener's source (No-Split): the leftover there would only leave with its failing attack. */
    const notSoftening = (x: number) => {
      const m = orderOf(x);
      return !m || !softens(m);
    };
    const fogged = [...mine].filter((x) => open(x) && notSoftening(x)).sort((a, b) => foggedNext(b) - foggedNext(a) || a - b).find((id) => foggedNext(id) > 0);
    const saving = stepSource(open, notSoftening);
    const biggest = (ids: number[]) =>
      [...ids].sort((a, b) => armiesOf(b) + (deployed.get(b) ?? 0) - (armiesOf(a) + (deployed.get(a) ?? 0)) || a - b)[0];
    // Holds before the strike stack: a border kept for the bonus this turn completes (rule 1c:
    // the leftover is its only garrison) is topped up to a comfortable margin, and any other
    // open border that would fall (its take at or below the threat) to just hold. The stack
    // gets the rest.
    if (stack)
      for (const b of short) {
        const kept1c = kept.has(b.id) || garrisoned.has(b.id);
        const bar = kept1c ? COMFORT_MARGIN * b.threat : b.threat;
        const room = roomAt(b.id);
        let d = 0;
        for (;;) {
          const take = toTake(stays(b.id) + d + unitsAt(b.id));
          if (take === null || take > bar || d >= room) break;
          d++;
        }
        if (d <= 0) continue;
        rationale.push(
          `Deploy ${d} to ${label(b.id)} before the strike stack: ${
            garrisoned.has(b.id)
              ? `it is garrisoned for the bonus this turn completes, topped up to a comfortable margin over the ~${b.threat} threat`
              : kept1c
                ? `it is kept for the bonus this turn completes, and the leftover is its only garrison`
                : `it would fall to the ~${b.threat} threat`
          } (protects +${valueOf(b.id)}).`,
        );
        deploy(b.id, d);
      }
    // #121: before any comfort margin, a conceded border that the leftover can make hold is held
    // after all (live, a border short by 2 was conceded while 5 went to one that already held,
    // and it fell with 15 armies). Only where the leftover would otherwise buy comfort margins
    // (no strike stack), from what is left once every held border that would fall as it stands
    // has its hold; best worth per army first. Its withdrawal is taken back, unless the
    // territory it went to needs those armies to hold; a border that attacks out, my
    // commander's, or one whose garrison already stays is not revived.
    if (!stack && short.length) {
      let falling = 0;
      for (const b of borders.values()) {
        if (conceded.has(b.id) || orderOf(b.id)) continue;
        let d = 0;
        while ((toTake(stayAt(b.id) + d + unitsAt(b.id)) ?? Infinity) <= b.threat) d++;
        falling += d;
      }
      const revivable = threatened
        .filter(
          (t) =>
            conceded.has(t.id) &&
            !stood.has(t.id) &&
            !moves.some((m) => m.from === t.id && m.reason !== 'withdraws from a conceded border'),
        )
        .map((t) => {
          const b = borders.get(t.id)!;
          const out = moves.find((m) => m.from === t.id);
          const back = out?.armies ?? 0;
          let d = 0;
          while ((toTake(stayAt(t.id) + back + d + unitsAt(t.id)) ?? Infinity) <= b.threat) d++;
          return { t, d, out, threat: b.threat };
        })
        .filter(({ out }) => {
          if (!out) return true;
          // The territory the withdrawal went to keeps holding without it.
          const dest = borders.get(out.to);
          if (!dest || conceded.has(out.to)) return true;
          const at = stayAt(out.to) + unitsAt(out.to);
          const heldWith = (toTake(at) ?? Infinity) > dest.threat;
          return !heldWith || (toTake(at - out.armies) ?? Infinity) > dest.threat;
        })
        .sort((a, b) => b.t.worth / Math.max(1, b.d) - a.t.worth / Math.max(1, a.d) || a.d - b.d || a.t.id - b.t.id);
      for (const { t, d, out, threat } of revivable) {
        if (d > budget - falling || d > roomAt(t.id)) continue;
        if (out) {
          moves.splice(moves.indexOf(out), 1);
          avail.set(t.id, avail.get(t.id)! + out.armies);
          const inc = (incoming.get(out.to) ?? 0) - out.armies;
          if (inc > 0) incoming.set(out.to, inc);
          else incoming.delete(out.to);
          const r = rationale.findIndex((l) => l.startsWith(`Withdraw ${out.armies} from ${label(t.id)} to `));
          if (r >= 0) rationale.splice(r, 1);
          const w = warnings.findIndex((l) => l.startsWith(`The withdrawal from ${label(t.id)} only executes`));
          if (w >= 0) warnings.splice(w, 1);
        }
        conceded.delete(t.id);
        const conceding = `${label(t.id)} cannot be held `;
        for (let i = warnings.length - 1; i >= 0; i--)
          if (warnings[i]!.startsWith(conceding) && warnings[i]!.endsWith(': conceded')) warnings.splice(i, 1);
        if (d > 0) deploy(t.id, d);
        locked.add(t.id);
        rationale.push(
          `Hold ${label(t.id)} after all (not conceded): deploy ${d} there${out ? `, and keep the ${out.armies} that would have withdrawn` : ''}; the leftover covers it before any comfort margin (${stayAt(t.id) + unitsAt(t.id)} armies need ${toTake(stayAt(t.id) + unitsAt(t.id))} to take, above the ~${threat} threat; protects +${t.value}).`,
        );
      }
      if (cardAdvice === 'order-priority' && !moves.some((m) => conceded.has(m.from))) cardAdvice = null;
    }
    let where: number;
    let why: string;
    let lock = false;
    if (stack) {
      lock = true;
      where = stack.id;
      why = `one strike stack on the border facing player ${stack.player}, the strongest opponent (~${stack.income} income, ${stack.source}), not spread`;
    } else if (short[0]) {
      // #121: spread to each short border's comfortable margin, in order, before any border gets
      // more (two symmetric borders at an exact hold ended as 16 and 7); the rest goes to the first.
      let spread = false;
      if (short.length > 1)
        for (const b of short) {
          const room = roomAt(b.id);
          let d = 0;
          while (d < room) {
            const take = toTake(stays(b.id) + d + unitsAt(b.id));
            if (take === null || take > COMFORT_MARGIN * b.threat) break;
            d++;
          }
          if (d <= 0) continue;
          rationale.push(
            `Deploy ${d} of the leftover to ${label(b.id)}: it brings it to a comfortable margin over the ~${b.threat} threat (protects +${valueOf(b.id)}), before any border gets more.`,
          );
          deploy(b.id, d);
          locked.add(b.id);
          spread = true;
        }
      lock = true;
      where = short[0].id;
      why = spread
        ? `the rest, once every short border has its comfortable margin, to the one with the most at stake (protects +${valueOf(where)})`
        : `the held border with the most at stake (protects +${valueOf(where)}), still short of a comfortable margin over the ~${short[0].threat} threat`;
    } else if (saving) {
      where = saving.from;
      why = `save toward ${label(saving.t)} (${saving.cost} to take), the next step of bonus ${bonusName(saving.bonusId)}, which this turn cannot afford`;
      lock = true;
    } else if (expansion !== undefined && open(expansion)) {
      where = expansion;
      why = 'the stack working on the top expansion';
      lock = true;
    } else if (fogged !== undefined) {
      where = fogged;
      why = 'the border with the most fogged neighbours';
    } else {
      const b = biggest(mine.filter((x) => open(x) && notSoftening(x)));
      if (b !== undefined) {
        where = b;
        why = 'my biggest stack';
      } else {
        where = biggest(mine)!;
        why = 'my biggest stack';
        warnings.push(`Every territory I hold is conceded; the leftover ${budget} goes to ${label(where)} anyway.`);
      }
    }
    const n = roomAt(where);
    if (saving && where === saving.from) staging = saving;
    if (n > 0) {
      rationale.push(`Deploy the leftover ${n} to ${label(where)}: ${why}.`);
      deploy(where, n);
      // Keep a strike or expansion stack there: the transfer step must not walk it back as "idle
      // interior" armies. Only when it got deploys (under Local Deployment it may get none).
      if (lock) locked.add(where);
    }
    if (stack) strikeStack = { ...stack, deployed: Math.max(0, n) };
    // Local Deployment: what is left of each bonus pool stays inside its bonus, on its
    // most threatened member (not conceded first; ties by id). One charge, taken before
    // any of these deploys: re-charging after each would let the matching spread a
    // pool's armies over an overlapping pool and strand the latter's.
    if (local && budget > 0) {
      const danger = (id: number) => {
        const b = borders.get(id);
        if (!b) return -Infinity;
        return b.threat - (toTake(stays(id) + unitsAt(id)) ?? Infinity);
      };
      // A conceded border whose garrison stays (#59) is still defended: its pool goes there.
      const lost = (id: number) => conceded.has(id) && !stood.has(id);
      const charged = chargeDeploys(pools, deployed).used;
      for (const p of pools.bonuses) {
        const left = p.value - (charged.get(p.bonusId) ?? 0);
        if (left <= 0) continue;
        // #103: a member next to a threatening enemy always beats an interior one, even a
        // border the plan gave up: the pool can be deployed nowhere else.
        const m = [...p.territoryIds].sort(
          (a, b) =>
            // No-Split (#124): a member that issues an order would send the pool away with it.
            Number(orderOf(a) !== undefined) - Number(orderOf(b) !== undefined) ||
            Number(borders.has(b)) - Number(borders.has(a)) ||
            Number(lost(a)) - Number(lost(b)) ||
            danger(b) - danger(a) ||
            a - b,
        )[0]!;
        rationale.push(
          `Deploy bonus ${p.name} (#${p.bonusId})'s ${left} to ${label(m)}: Local Deployment keeps them inside the bonus, and it is its most threatened ${borders.has(m) ? 'border' : 'member'}${borders.has(m) ? ' (they stay there this turn)' : ''}.`,
        );
        deploy(m, left);
        // Armies deployed from a pool to defend its border are never moved out the same turn.
        if (borders.has(m)) {
          locked.add(m);
          poolDeployed.set(m, (poolDeployed.get(m) ?? 0) + left);
        }
      }
    }
    if (budget > 0) {
      // Unreachable: the leftover deploy filled `where` to its exact room, so no anywhere
      // armies remain, and each pool's unused room (from one maximum charge) went inside
      // it. Never leave income undeployed — but say the plan breaks the pools.
      warnings.push(
        `Local Deployment: ${budget} armies could not be placed within the pools; they go to ${label(where)}, which breaks Local Deployment — war.app may refuse this turn.`,
      );
      deploy(where, budget);
    }
  }

  // The stack exists whether or not a leftover reached it (#102): holds and captures may take the
  // whole income, and an 80-stack must not stand idle for want of one spare army.
  if (stack && !strikeStack) strikeStack = { ...stack, deployed: 0 };

  // ---- spend the strike stack (#102) ----
  // Once rule 0p.3c builds a strike stack, it attacks every adjacent enemy territory it can take
  // at the plan's win chance (the ordinary capture sizing; rule 4c re-checked as its captures
  // accumulate), breaking or retaking a bonus first (re-ranked after each capture: a bonus breaks
  // once), then by bonus value, then cheapest, then id — while what stays on it holds against the threat
  // left after those attacks (rule 1's arithmetic: the captured territories no longer threaten
  // it). It grows (deploy, no attack) only when nothing in reach is worth taking.
  if (strikeStack) {
    const S = strikeStack.id;
    if (strikeStack.deployed === 0)
      rationale.push(
        `No leftover reaches the strike stack ${label(S)} this turn (holds, captures or Local Deployment pools took the income): it is spent with the armies already on it.`,
      );
    const prev = new Map((input.previousBoard?.territories ?? []).map((t) => [t.territoryId, t]));
    /** Bonuses I held in full on the previous board and no longer do: lost, and retakable. */
    const lost = new Set(
      g.map.bonuses
        .filter((b) => {
          const ts = bonusTs.get(b.id) ?? [];
          if (b.value <= 0 || !ts.length || ts.every((t) => mineSet.has(t))) return false;
          return ts.every((t) => {
            const was = visibleState(prev.get(t));
            return was?.owner.kind === 'player' && was.owner.playerId === me;
          });
        })
        .map((b) => b.id),
    );
    interface StrikeTarget {
      id: number;
      cost: number;
      chance: number;
      breaks: Breakable[];
      retakes: number[];
    }
    const candidates: StrikeTarget[] = [];
    for (const n of neighborsOf(g, S)) {
      const st = state.get(n);
      if (captured.has(n) || st?.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null || uncounted(n)) continue;
      const cost = costAt(n);
      // Never a capture that lowers income (rule 4c): it completes a negative bonus. Re-checked
      // below against the strike's own captures, which can complete one only together.
      if (cost === null || gainWith([n]) < 0) continue;
      const owner = st.owner.playerId;
      candidates.push({
        id: n,
        cost,
        chance: chanceOf(cost, defenceAt(n)),
        breaks: breakable.filter((b) => b.player === owner && bonusTs.get(b.bonusId)!.includes(n)),
        retakes: [...lost].filter((id) => bonusTs.get(id)!.includes(n)).sort(byNum),
      });
    }
    /** Captures planned from the stack so far, in order. */
    const plannedHere = new Set<number>();
    /** The opponent bonuses `c` breaks: only the first member of each to fall this turn breaks it. */
    const breaksOf = (c: StrikeTarget) =>
      c.breaks.filter((b) => !bonusTs.get(b.bonusId)!.some((t) => t !== c.id && captured.has(t)));
    const strikeValue = (c: StrikeTarget) =>
      Math.max(0, ...breaksOf(c).map((b) => b.value), ...c.retakes.map((id) => g.bonusById.get(id)!.value));
    /** What taking `c` does, against the captures planned so far (a retake completes only with every member held). */
    const effectOf = (c: StrikeTarget): string | null => {
      const held = heldNow();
      held.add(c.id);
      const effects = [
        ...breaksOf(c).map(
          (b) => `breaks ${b.probable ? 'probable ' : ''}enemy bonus ${bonusName(b.bonusId)} (+${b.value} from player ${b.player})`,
        ),
        ...c.retakes.map(
          (id) =>
            `${bonusTs.get(id)!.every((t) => held.has(t)) ? 'retakes' : 'toward retaking'} bonus ${bonusName(id)} (+${g.bonusById.get(id)!.value}), which I held last turn`,
        ),
      ];
      return effects.length ? effects.join('; ') : null;
    };
    const rank = () =>
      [...candidates].sort(
        (a, b) =>
          Number(breaksOf(b).length + b.retakes.length > 0) - Number(breaksOf(a).length + a.retakes.length > 0) ||
          strikeValue(b) - strikeValue(a) ||
          a.cost - b.cost ||
          a.id - b.id,
      );
    /** What may never leave the stack this turn: a Local Deployment pool's deploys (#103). */
    const pinned = poolDeployed.get(S) ?? 0;
    /**
     * The threat on the stack once `gone` (and this turn's other captures) fall, and the armies that
     * hold it. Never below the opponent's deploy alone: orders interleave, so it may land its deploy
     * on a target before my attack resolves, and that territory then still borders the stack.
     */
    const holdAfter = (gone: ReadonlySet<number>) => {
      const th = threatAt(S, (x) => captured.has(x) || gone.has(x));
      const threat = Math.max(th?.threat ?? 0, deployOf(strikeStack!.player));
      return { threat, need: Math.max(0, holdArmies(threat) - unitsAt(S)) };
    };
    const taken: { c: StrikeTarget; effect: string | null; value: number; armies: number; chance: number }[] = [];
    const refused = new Map<number, string>();
    let sent = 0;
    /**
     * No-Split (#124): the stack's one order goes to the strike on `t`, not to the small expansion
     * `m` it already made: that capture is taken back, and its armies rejoin the stack.
     */
    const dropExpansion = (m: PlannedMove, t: number) => {
      const undo = captureUndo.get(m.to);
      if (undo) undo();
      else avail.set(S, avail.get(S)! + m.armies);
      captured.delete(m.to);
      survivorsAt.delete(m.to);
      moves.splice(moves.indexOf(m), 1);
      const head = `Attack ${label(m.to)} from ${label(S)} with `;
      for (let i = rationale.length - 1; i >= 0; i--) if (rationale[i]!.startsWith(head)) rationale.splice(i, 1);
      rationale.push(
        `No-Split: ${label(S)}'s one order goes to the strike on ${label(t)}, not the expansion into ${label(m.to)} (it completes no bonus): the whole stack strikes.`,
      );
      skipOffence(m.to, `No-Split: ${label(S)}'s one order goes to the strike on ${label(t)}`);
    };
    for (let again = true; again; ) {
      again = false;
      for (const c of rank()) {
        if (plannedHere.has(c.id)) continue;
        if (gainWith([c.id]) < 0) {
          const held = heldNow();
          held.add(c.id);
          const negs = completedBy(held)
            .filter((id) => g.bonusById.get(id)!.value < 0 && bonusTs.get(id)!.includes(c.id))
            .map((id) => `negative bonus ${bonusName(id)} (${g.bonusById.get(id)!.value})`);
          refused.set(c.id, `with this turn's other captures it lowers next income: it completes ${negs.join(', ')} (rule 4c)`);
          continue;
        }
        const expansion = noSplit && !taken.length ? smallExpansion(S) : undefined;
        if (noSplit && ((orderOf(S) && !expansion) || taken.length)) {
          refused.set(c.id, `No-Split: ${label(S)} issues one order this turn`);
          continue;
        }
        if (noSplit) {
          // The whole stack goes (#124): nothing stays to hold S but the guard, so it strikes only
          // when it need not hold (it protects nothing, or the strike leaves no visible threat to it).
          const whole = avail.get(S)! + (expansion?.armies ?? 0);
          if (pinned > 0) {
            refused.set(c.id, `No-Split: the ${pinned} Local Deployment armies defending ${label(S)} would leave with the whole stack`);
            continue;
          }
          if (c.cost > whole) {
            refused.set(c.id, `it needs ${c.cost}, more than the ${Math.max(0, whole)} the stack can send`);
            continue;
          }
          const h = mustHold(S, c.id, whole);
          if (h) {
            refused.set(
              c.id,
              `No-Split: the whole stack would go, leaving ${h.stays} against the ~${h.threat} threat, and ${label(S)} must hold (${h.value > 0 ? `protects +${h.value}` : 'my commander stands there'})`,
            );
            continue;
          }
          if (expansion) dropExpansion(expansion, c.id);
          const armies = avail.get(S)!;
          plannedHere.add(c.id);
          refused.delete(c.id);
          taken.push({ c, effect: effectOf(c), value: strikeValue(c), armies, chance: chanceOf(armies, defenceAt(c.id)) });
          avail.set(S, 0);
          sent += armies;
          captured.add(c.id);
          survivorsAt.set(c.id, armies - straightKills(defenceAt(c.id), rates.defensiveKillRate));
          captureOrder.push(c.id);
          again = true;
          break;
        }
        const gone = new Set([...plannedHere, c.id]);
        const { threat, need } = holdAfter(gone);
        // #179: what covers a finished-off player's exit stays too.
        const movable = avail.get(S)! - Math.max(pinned, coverOf(S));
        const stay = avail.get(S)! + guard + (incoming.get(S) ?? 0) - c.cost;
        if (c.cost > movable) {
          refused.set(c.id, `it needs ${c.cost}, more than the ${Math.max(0, movable)} the stack can send`);
          continue;
        }
        if (stay < need) {
          refused.set(
            c.id,
            `it would leave the stack ${stay}, below the ${need} that hold it against the ~${threat} threat after the attacks`,
          );
          continue;
        }
        const effect = effectOf(c);
        const value = strikeValue(c);
        plannedHere.add(c.id);
        refused.delete(c.id);
        taken.push({ c, effect, value, armies: c.cost, chance: c.chance });
        avail.set(S, avail.get(S)! - c.cost);
        sent += c.cost;
        captured.add(c.id);
        survivorsAt.set(c.id, c.cost - straightKills(defenceAt(c.id), rates.defensiveKillRate));
        captureOrder.push(c.id);
        again = true;
        break;
      }
    }
    // #120: each attack is then sized for its defenders plus what their owner may deploy there
    // first, in the order taken, while the stack still covers it and keeps its hold after every
    // attack. One the stack cannot cover keeps its size (its warning gives the reinforced odds).
    const reinforced = new Map<number, number>();
    if (!noSplit) {
      const { need } = holdAfter(new Set());
      const room = () => Math.min(avail.get(S)! - Math.max(pinned, coverOf(S)), avail.get(S)! + guard + (incoming.get(S) ?? 0) - need);
      // The stack's earlier attacks on a player (a break or counter-attack from it) first.
      for (const m of moves) {
        if (m.from !== S || m.kind !== 'attack' || combined.has(m.to) || worstCase.has(m.to) || strikes.has(m.to)) continue;
        const extra = reinforcementAt(m.to);
        const full = extra > 0 ? costAt(m.to, defenceAt(m.to) + extra) : null;
        if (full === null || full <= m.armies || full - m.armies > room()) continue;
        const add = full - m.armies;
        const before = m.armies;
        avail.set(S, avail.get(S)! - add);
        m.armies = full;
        m.winChance = chanceOf(full, defenceAt(m.to));
        if (survivorsAt.has(m.to)) survivorsAt.set(m.to, survivorsAt.get(m.to)! + add);
        worstCase.set(m.to, defenceAt(m.to) + extra);
        const w = warnings.indexOf(`Attack on enemy ${label(m.to)} assumes its owner does not reinforce it first.`);
        if (w >= 0) warnings.splice(w, 1);
        rationale.push(
          `Size the attack on ${label(m.to)} from the strike stack ${label(S)} up from ${before} to ${full}: ${full} take it even if player ${strikeStack.player} deploys its ~${extra} there first, and the stack still holds.`,
        );
      }
      for (const x of taken) {
        const extra = reinforcementAt(x.c.id);
        const full = extra > 0 ? costAt(x.c.id, defenceAt(x.c.id) + extra) : null;
        if (full === null || full <= x.armies) continue;
        const add = full - x.armies;
        if (add > room()) continue;
        avail.set(S, avail.get(S)! - add);
        sent += add;
        x.armies = full;
        x.chance = chanceOf(full, defenceAt(x.c.id));
        survivorsAt.set(x.c.id, survivorsAt.get(x.c.id)! + add);
        worstCase.set(x.c.id, defenceAt(x.c.id) + extra);
        reinforced.set(x.c.id, extra);
      }
    }
    // What stays on the stack is its hold: an efficient-size top-up (S2) never draws on it, and
    // the transfer step never moves it (its captures can leave it interior; it may have got no deploys).
    if (taken.length) {
      holdLocked.add(S);
      locked.add(S);
    }
    const { threat: finalThreat, need: finalNeed } = holdAfter(new Set());
    const stays = avail.get(S)! + guard + (incoming.get(S) ?? 0);
    for (const { c, effect, value, armies, chance } of taken) {
      const reason = `the strike stack ${effect ?? 'takes an adjacent enemy territory'}`;
      moves.push({ from: S, to: c.id, armies, kind: 'attack', reason, winChance: chance });
      const extra = reinforced.get(c.id);
      if (extra === undefined) warnings.push(`Attack on enemy ${label(c.id)} assumes its owner does not reinforce it first.`);
      const keeps = noSplit
        ? `No-Split sends the whole stack (${c.cost} would take it), and ${label(S)} need not hold: ${
            valueOf(S) > 0 || myCommanders.has(S) ? 'no visible threat to it is left' : 'it protects nothing'
          }`
        : `the stack keeps ${stays}, enough to hold against the ~${finalThreat} threat after the attacks (needs ${finalNeed})`;
      const sized =
        extra === undefined
          ? ''
          : ` — sized for its ${defenceAt(c.id)} defenders plus the ~${extra} player ${strikeStack.player} may deploy there first (${c.cost} would take it as it stands)`;
      rationale.push(
        `Attack ${label(c.id)} from the strike stack ${label(S)} with ${armies} (win chance ${pct(chance)}${sized}): ${
          effect ?? 'it can take this adjacent enemy territory'
        }; ${keeps}.`,
      );
      offence.set(`strike:${c.id}`, {
        target: c.id,
        kind: 'strike-attack',
        cost: armies,
        value,
        taken: true,
        why: `from the strike stack ${label(S)} with ${armies} (win chance ${pct(chance)}): ${effect ?? 'takes an adjacent enemy territory'}`,
      });
    }
    for (const c of rank()) {
      if (plannedHere.has(c.id)) continue;
      const effect = effectOf(c);
      offence.set(`strike:${c.id}`, {
        target: c.id,
        kind: 'strike-attack',
        cost: c.cost,
        value: strikeValue(c),
        taken: false,
        why: `not made from the strike stack ${label(S)} — ${refused.get(c.id) ?? 'not worth it'}${effect ? `: ${effect}` : ''}`,
      });
    }
    const builds = `the spare deploys build one strike stack facing player ${strikeStack.player}, the strongest opponent (~${strikeStack.income} income, ${strikeStack.source})`;
    if (!taken.length) {
      const held = candidates.length
        ? candidates.map((c) => `${label(c.id)}: ${refused.get(c.id) ?? 'not worth it'}`).join('; ')
        : 'no visible enemy territory next to it can be taken';
      rationale.push(`Grow the strike stack ${label(S)}: nothing next to it is worth taking this turn (${held}).`);
    }
    if (strikeStack.deployed > 0 || taken.length)
      offence.set(`strike:${S}`, {
        target: S,
        kind: 'strike',
        cost: strikeStack.deployed,
        value: strikeStack.income,
        taken: taken.length > 0,
        why: taken.length
          ? `${builds}; it attacks ${taken.map(({ c }) => label(c.id)).join(', ')} this turn (${sent} armies sent)`
          : `${builds}; it grows: nothing next to it is worth taking this turn`,
      });
  }

  // A kept border the leftover could not make safe: the completed bonus can fall with it.
  for (const t of [...kept].sort(byNum)) {
    const b = borders.get(t)!;
    const stays = avail.get(t)! + guard + (incoming.get(t) ?? 0);
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

  // ---- #167: lead strikes ----
  // Adapting in a free-for-all with two or more opponents, under `balanced`, when my visible armies
  // are more than SECOND_FRONT_LEAD × the largest opponent's in view: rule 0p.2 is off, and every
  // enemy territory next to mine (no special unit on it, never one whose capture lowers income) is
  // attacked from the territory of mine beside it with the most to spare — armies beyond what holds
  // it once the target falls (rule 1's arithmetic, #172's two-step keep too; never a hold, a conceded
  // border, my commander's territory or the strike stack; no deploys: the income is spent) — when
  // that covers an attack sized for its defenders plus what its owner may deploy there first (rule
  // 3's #120 sizing, so it lands for sure). Breaks first, then a step into a positive bonus, then
  // cheapest, then id. Not under No-Split (an order carries the whole stack).
  /** A lead strike's source: armies on `x` beyond what holds it once `n` falls (also named by the "Not attacking" line). */
  const leadSpareFor = (x: number, n: number) => {
    if (!mineSet.has(x) || holdLocked.has(x) || conceded.has(x) || myCommanders.has(x) || x === strikeStack?.id) return 0;
    const gone = (m: number) => m === n;
    return Math.max(0, avail.get(x)! - Math.max(keepFor(x, gone), twoStepKeep(x, gone)));
  };
  if (auto && balanced && profile.format === 'ffa' && profile.opponents >= 2) {
    if (leadLever)
      rationale.push(
        `FFA army lead: my ${armyLead.my} armies in view are ${Number.isFinite(armyLead.ratio) ? `${leadText()} player ${armyLead.rival}'s ${armyLead.theirs}, the most of any opponent` : `against no opposing army in view`} (more than ${SECOND_FRONT_LEAD}×): no second-front rule — idle stacks beside weak enemy territories attack them, a lever, not a risk.`,
      );
    if (leadLever && !noSplit) {
      const candidates = [...new Set(mine.flatMap((x) => neighborsOf(g, x)))]
        .filter((n) => {
          const st = state.get(n);
          return (
            !mineSet.has(n) &&
            !captured.has(n) &&
            // #179: a buffer left standing is taken by no pass this turn.
            !spared.has(n) &&
            st?.owner.kind === 'player' &&
            foe(st.owner.playerId) &&
            st.armies !== null &&
            !uncounted(n) &&
            unitsAt(n) === 0
          );
        })
        .map((n) => {
          const p = (state.get(n)!.owner as { playerId: number }).playerId;
          const d = defenceAt(n);
          const extra = reinforcementAt(n);
          const breaks = breakable.find((b) => b.player === p && bonusTs.get(b.bonusId)!.includes(n));
          const step = g.map.bonuses.find((b) => b.value > 0 && bonusTs.get(b.id)!.includes(n) && !breaks);
          return { n, p, d, extra, cost: costAt(n, d + extra), breaks, step };
        })
        .filter((c) => c.cost !== null)
        .sort(
          (a, b) =>
            Number(!a.breaks) - Number(!b.breaks) || Number(!a.step) - Number(!b.step) || a.cost! - b.cost! || a.n - b.n,
        );
      for (const c of candidates) {
        if (captured.has(c.n) || gainWith([c.n]) < 0) continue;
        const cost = c.cost!;
        const src = neighborsOf(g, c.n)
          .filter((x) => mineSet.has(x))
          .map((x) => ({ x, spare: leadSpareFor(x, c.n) }))
          .filter((o) => o.spare >= cost)
          .sort((a, b) => b.spare - a.spare || a.x - b.x)[0];
        if (!src) continue;
        avail.set(src.x, avail.get(src.x)! - cost);
        captured.add(c.n);
        worstCase.set(c.n, c.d + c.extra);
        survivorsAt.set(c.n, cost - straightKills(c.d + c.extra, rates.defensiveKillRate));
        captureOrder.push(c.n);
        captureUndo.set(c.n, () => avail.set(src.x, avail.get(src.x)! + cost));
        if (!targets.has(c.n)) targets.set(c.n, { id: c.n, cost, enemy: true, sources: neighborsOf(g, c.n).filter((x) => mineSet.has(x)) });
        const effect = c.breaks
          ? `breaks ${c.breaks.probable ? 'probable ' : ''}enemy bonus ${bonusName(c.breaks.bonusId)} (+${c.breaks.value} from player ${c.p})`
          : c.step
            ? `a step into bonus ${bonusName(c.step.id)} (+${c.step.value})`
            : `takes a territory of player ${c.p}`;
        const reason = `army lead: ${effect}, sure even if player ${c.p} deploys its ~${c.extra} there first (${c.d} + ${c.extra} defenders), with armies ${label(src.x)} does not need to hold`;
        moves.push({ from: src.x, to: c.n, armies: cost, kind: 'attack', reason, winChance: chanceOf(cost, c.d) });
        rationale.push(`Attack ${label(c.n)} from ${label(src.x)} with ${cost}: ${reason}.`);
      }
    }
  }

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

  // ---- transfers ----
  if (s.allowTransferOnly ?? true) {
    // #121: a capture counts as held only when it lands for sure — a neutral, or an attack on a
    // player sized for its owner's whole deploy (finishing off, fog pressure, a commander strike).
    // An exact-sized attack on a player fails if the owner reinforces first, and a garrison moved
    // off beside it as "idle interior" would leave its border on the guard.
    const lands = (t: number) =>
      state.get(t)?.owner.kind !== 'player' || worstCase.has(t) || strikes.has(t);
    const held = new Set([...mine, ...[...captured].filter(lands)]);
    // A conceded border is not "the front": the plan gives it up, so armies never flow into it and
    // distances are not measured through it; idle armies concentrate on a front that holds.
    const passable = (id: number) => held.has(id) && !conceded.has(id);
    const isEnemy = (id: number) => {
      const st = state.get(id);
      return st?.owner.kind === 'player' && foe(st.owner.playerId);
    };
    // Enemy front first (#121): idle armies head for the territories a visible enemy holds; only
    // with no enemy reachable do they head for the nearest territory not mine (neutral or fog).
    const ids = [...g.territoryById.keys()];
    const enemyFront = ids.filter((id) => !held.has(id) && isEnemy(id));
    const anyFront = ids.filter((id) => !held.has(id));
    const distEnemy = bfsDistances(g, enemyFront, { passable });
    const distAny = bfsDistances(g, anyFront, { passable });
    // #125: staging. Idle armies on a territory facing no visible enemy — a border beside neutrals
    // included — walk one step toward the source of the capture the leftover saved toward, when
    // it is no farther than the enemy front; once there they help take it.
    if (staging) {
      const st = staging;
      const distStage = bfsDistances(g, [st.from], { passable });
      for (const t of mine) {
        const n = avail.get(t)!;
        if (n <= 0 || locked.has(t) || t === st.from || conceded.has(t) || myCommanders.has(t)) continue;
        if (neighborsOf(g, t).some((x) => isEnemy(x) || x === st.t)) continue;
        if (moves.some((m) => m.from === t && m.kind === 'attack')) continue;
        const d = distStage.get(t);
        if (d === undefined || d < 1 || d > (distEnemy.get(t) ?? Infinity)) continue;
        const step = neighborsOf(g, t)
          .filter((x) => mineSet.has(x) && !conceded.has(x) && (distStage.get(x) ?? Infinity) < d)
          .sort((a, b) => distStage.get(a)! - distStage.get(b)! || a - b)[0];
        if (step === undefined) continue;
        // #172: what a stack two steps away needs it to keep stays (the step below says so).
        const far = twoStepHold(t);
        // #179: nor what covers a finished-off player's exit.
        const k = n - Math.max(twoStepKeep(t), coverOf(t));
        // No-Split (#124): the whole stack or nothing.
        if (k <= 0 || (noSplit && k < n)) continue;
        if (orderOf(t)) {
          warnSplit(t, `its ${k} idle armies do not stage toward ${label(st.t)}`);
          continue;
        }
        avail.set(t, n - k);
        const reason = `stages toward ${label(st.t)}, the next step of bonus ${bonusName(st.bonusId)}`;
        moves.push({ from: t, to: step, armies: k, kind: 'transfer', reason });
        arrived.set(step, (arrived.get(step) ?? 0) + k);
        rationale.push(
          `Move ${k} from ${label(t)} to ${label(step)}: ${reason} (${st.cost} to take from ${label(st.from)}, not affordable this turn)${
            k < n && far ? twoStepCite(t, far, (c) => `; the rest stay: ${c}`) : ''
          }.`,
        );
      }
    }
    for (const t of mine) {
      const dist = distEnemy.has(t) ? distEnemy : distAny;
      const n = avail.get(t)!;
      if (n <= 0 || locked.has(t)) continue;
      // My commander's territory next to an enemy at the start of the turn keeps its armies,
      // even when this turn's captures make it interior: a capture can still fail. So does one
      // next to a border the plan concedes (#121): the enemy takes it next, and then faces it.
      if (
        myCommanders.has(t) &&
        neighborsOf(g, t).some((x) => (ownerOf(x) ?? me) !== me || conceded.has(x))
      )
        continue;
      const d = dist.get(t);
      if (d === undefined || d <= 1) continue;
      // Only into a territory held at the start of the turn: a planned capture is
      // not mine yet, and a "transfer" into it would execute as an attack.
      const step = neighborsOf(g, t)
        .filter((x) => mineSet.has(x) && !conceded.has(x) && (dist.get(x) ?? Infinity) < d)
        .sort((a, b) => dist.get(a)! - dist.get(b)! || a - b)[0];
      if (step === undefined) continue;
      // #128: interior only if this turn's attacks on players beside it land. Until they do, it
      // keeps what holds against the threat there as if they failed (its neighbours' owners'
      // stacks and deploy as they stand): a +12 bonus was left on 1 beside a capture.
      const pending = neighborsOf(g, t).filter((x) => captured.has(x) && state.get(x)?.owner.kind === 'player');
      const ifFail = pending.length ? borderAt(t, () => false) : null;
      const keep128 = ifFail ? Math.max(0, holdArmies(ifFail.threat) - unitsAt(t)) : 0;
      // #172: or it is interior now, but a stack two steps away can take the territory in between
      // this turn and attack it next. The larger hold binds (never the two added together).
      const far = twoStepHold(t);
      const twoStep = far !== null && far.stay > keep128 ? far : null;
      const keep = Math.max(keep128, twoStep?.stay ?? 0, coverKeep.has(t) ? coverKeep.get(t)! + guard : 0);
      // No-Split (#124): a transfer sends the whole stack, so one that must keep some sends none.
      const part = Math.min(n, Math.max(0, stayAt(t) - keep));
      const k = noSplit && part < n ? 0 : part;
      if (k <= 0) {
        if (twoStep)
          rationale.push(
            twoStepCite(t, twoStep, (c) => `Keep the ${n} idle armies on ${label(t)}: ${c}.`, `Keep the ${n} idle armies on ${label(t)}.`),
          );
        else if (pending.length)
          rationale.push(
            `Keep the ${n} idle armies on ${label(t)}: it is interior only once ${pending.map(label).join(', ')} falls, and until then they hold it against ~${ifFail!.threat}.`,
          );
        continue;
      }
      if (orderOf(t)) {
        warnSplit(t, `its ${k} idle armies are not transferred to ${label(step)}`);
        continue;
      }
      avail.set(t, n - k);
      const reason = 'moves idle interior armies toward the front';
      moves.push({ from: t, to: step, armies: k, kind: 'transfer', reason });
      arrived.set(step, (arrived.get(step) ?? 0) + k);
      rationale.push(
        `Transfer ${k} from ${label(t)} to ${label(step)}: ${reason}${
          k < n && twoStep
            ? twoStepCite(t, twoStep, (c) => ` (the rest stay: ${c})`)
            : k < n
            ? ` (${stayAt(t)} stay: it is interior only once ${pending.map(label).join(', ')} falls, and until then they hold it against ~${ifFail!.threat})`
            : ''
        }.`,
      );
    }
  }

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
  if (frontier.enemyBorders)
    rationale.push(
      `Frontier after this plan: ${frontier.borders} borders, ${frontier.enemyBorders} facing an enemy, needing ${frontier.holdCost} next turn to hold at the expected deploy (next income ${nextIncomeText}); every capture's score paid for the borders it adds.`,
    );

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
      if (splits.length)
        parts.push(
          `its ~${d} deploy, split, can take ${k} of the ${n} borders facing it at once (${splits.map(({ x, gap }) => `${label(x)} short ${gap}`).join(', ')}): each of those holds with chance 0%.`,
        );
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
        if (lead.spare < sure)
          return `a lead strike (my army lead is ${leadText()}, over ${SECOND_FRONT_LEAD}×) needs ${sure} — sized for its ${defenceAt(n)} defenders plus player ${p}'s ~${extra} deploy — and the most a neighbour of mine can spare for it is ${lead.spare}${lead.spare > 0 ? ` (${label(lead.x)})` : ''}`;
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
  if (!firstOrder) cardAdvice = null;
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
    cardAdvice = why === undefined ? 'order-priority' : null;
    const mayHold = (who: string) =>
      `I move first this turn, but ${who} may hold an Order Priority card: two cancel, so mine keeps this order first`;
    if (firstOrder === killOrder && cardAdvice) {
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
      opts.movesFirst === true || cardAdvice === 'order-priority'
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
    cardAdvice,
    multiSourceCaptures: [...combined].sort(byNum),
    frontier,
    offence: offenceList,
    moveSlots: moves.map((m) => SLOT_NAMES[slotOf(m)]!),
    ...(exchanges.length ? { exchanges } : {}),
    ...(Object.keys(eliminateEta).length ? { eta: { eliminate: eliminateEta } } : {}),
    ...(exits.length ? { exits } : {}),
  };
}
