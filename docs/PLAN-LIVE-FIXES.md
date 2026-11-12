# warapp-mcp — plan: fixes from live play (#38, #45, #20, #44, #43)

Four independent tracks, each in its own worktree and branch off `origin/main`, each its own PR. Never
switch branches, never push, never touch another worktree. Hard rules: **no live network in tests or
agents (never call war.app), synthetic fixtures only (made-up maps, ids, names, `test@example.com`),
never the real account email, a real game id or a real player name; never read
`~/.config/warapp-mcp/session.json` or `.env`.** The locally cached client bundle
(`~/.config/warapp-mcp/bundle/*.js`) may be READ to learn encodings and rules, but never copied into
the repo. Read the GitHub issue for each track (`gh issue view <n>`) — it has the live evidence.
TDD; green = `npm test` AND `npm run build`. The planner stays pure and deterministic.

## Track A — income with "Extra Armies for Territories" (#38) — `fix/territory-income`
Live: `MinimumArmyBonus 4, BonusArmyPer 1`, 1 territory → war.app paid **4** (model said 5);
`MinimumArmyBonus 20, BonusArmyPer 1`, 164 territories → war.app paid **164** (model said 184).
Both fit the hypothesis `base = max(MinimumArmyBonus, floor(territories / BonusArmyPer))` (the
territory armies replace the minimum rather than add to it), then + held bonuses. **Verify the real
rule** from the client bundle's income computation (and the war.app wiki page on the setting if the
bundle is ambiguous — read-only web fetch of the public wiki is allowed for this track only), and
record which. Fix the income model everywhere it is used (`analyzePlayer`/`incomeFor`, the planner's
own income/enemy-deploy base, picks if it uses income). Make `validateTurn`'s deploy-total pre-check
**fail soft** when the model is uncertain (a setting whose rule is unverified): warn instead of
refusing, and when the server answers error 11 the hint names the server's number if the board/UI
data carries it. Tests: both live cases above as synthetic boards (exact income), the default (no
BonusArmyPer) unchanged, and the pre-check behaviour. `docs/WARAPP-API.md` records the rule and its
evidence.

## Track B — finish off a weak opponent (#45) — `feat/planner-elimination`
Before conceding borders, an **elimination / pressure check**: for each visible opponent whose every
territory is visible to me and reachable from mine, plan "attack every one of its territories this
turn" against a worst case (each target gets that opponent's full estimated deploy). Prefer it over
the expansion plan when it eliminates the opponent (every target taken even worst case) or takes
most of what it holds and the borders it frees no longer need holding. It uses the existing combat
model (single and combined attacks, kill rates, luck margin) and plan validity rules; rationale and
warnings say why. Also: never concede a border captured from that opponent last turn when the
opponent is the weak one. Tests: #45's case (opponent on 2 territories × 2 armies, income ~6, both
bordering mine → attacks both with the deploy split onto the two border stacks, no concession), an
opponent too strong to finish (unchanged plan), an opponent partly fogged (not attempted, warned),
and a 3-player game where finishing one opponent leaves a border to a third (still respects holds).

## Track C — cards: discard and the must-play threshold (#20) — `feat/cards-discard`
PR #25 fixed the hand read and Order Delay's phase. Remaining: (1) **discard**: `GameOrderDiscard` is
order tag **9**, phase **10** (Discards): tag 9, the instance GUID (.NET byte order), then the order
base (playerId, false, false) — verify against the bundle's writer; add an encoder with golden bytes
and `{ kind: 'discard', card }` to `warapp_submit_turn`'s card plays; the planner/card advice
prefers discarding the lowest-value whole card when a play is required and no play is useful
(e.g. only Blockade with nothing to block). (2) **must-play threshold**: live, a turn with no card
was accepted at 4/4 whole cards and refused at 5/4 — so a play (or discard) is required only when
whole cards **> MaxCardsHold**; fix `playRequired` and verify against the bundle's check. Tests:
golden discard bytes, phase ordering (discards before everything else in its phase), submit with a
discard, threshold 4/4 not required and 5/4 required. Then `Closes #20` if every item in the issue is
done (re-read the issue's items; list any left).

## Track D — speed first turn (#44) + open-games gaps (#43) — `feat/begin-first-turn`
(1) #44: detect the state "Playing, turn 1, no standing" (and the setting that enables the speed
first turn — find its GameFeed/settings key from the bundle) and make `warapp_get_live_board`/
`warapp_plan_turn` say so instead of the lobby-like error ("this game's first turn starts when you
press Begin — call warapp_begin_turn, then plan and submit at once: Begin starts the turn timer").
Add a confirm-gated `warapp_begin_turn(game_id)` (mcp-utils `defineWrite`/`registerWrite`) calling
**BeginFirstTurn = method 78**, with its parameters read from the bundle's writer (golden bytes); the
preview warns that the timer starts. Mark the encoding verified-from-bundle, not live, in
`docs/WEB-PROTOCOL.md`. (2) #43: `warapp_list_open_games`' `plannerGaps` add `BonusArmyPer`
("extra army per N territories — income model unverified, see #38") and a non-zero luck modifier or
non-straight rounding ("attack sizing assumes straight rounding and adds only a luck margin"). Tests:
the no-standing error, golden bytes, confirm gate, the two new gaps. Closes #43 and #44.
