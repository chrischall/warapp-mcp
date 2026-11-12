# warapp-mcp — phase 9 plan: read the real hand, and Order Delay's turn phase (#20)

Worktree `/Users/chris/git/warapp-mcp-cards20`, branch `fix/card-hand` (from `origin/main`).
Other builds run in `/Users/chris/git/warapp-mcp-planner3` and `/Users/chris/git/warapp-mcp-followups23`
— never touch them or any other worktree, never switch branches, never push. Same hard rules as
earlier phases: no live network in tests or agents, no captured data, synthetic fixtures
(`test@example.com`, made-up ids and GUIDs), the real account email never in the repo.

## Facts verified live on 2026-11-12 (issue #20)

**The hand.** A decoded `warlight.shared.LatestGameInfo` holds, in field order:
1. the pending orders of this turn (a list; may contain `GameOrderPlayCard*` orders),
2. the **current** `warlight.shared.GameStanding`,
3. the last `warlight.shared.GameTurn` (its orders, including `GameOrderReceiveCard` whose list
   field carries the received `CardInstance`s, and `GameOrderPlayCard*` orders),
4. the **previous** `warlight.shared.GameStanding` (same shape as 2, one turn older),
5. other fields (toasts, the turn number).

Each `GameStanding` has a field that is a dict `in-game player id → { …, <dict GUID → CardInstance> }`
(the player's cards). `readHand` currently walks the WHOLE `LatestGameInfo` and unions every
`CardInstance`, so it lists cards that were already played last turn (they survive in the
previous standing and in the turn's receive/play orders). Playing one of those is refused with
**server error 50 `CardInstanceUnavailable`** — observed for two stale "Reinforcement" instances,
and a Blockade consumed last turn was still listed. The war.app Cards dialog matched the CURRENT
standing exactly. `standingFromInfo` (src/live.ts) already uses "the first `GameStanding` field of
`LatestGameInfo`" as the current standing — the hand must come from that same object.

**Order Delay.** `GameOrderPlayCardOrderDelay` is order tag **11** and runs in turn phase **50**
(the attack/transfer phase), not 12. Placed in phase 12 (with Order Priority) it was refused with
**error 10 `OrdersInIncorrectOrder`** live (two whole Order Delay cards, both refused). Order
Priority stays tag 10, phase 12.

## Tasks

### C1 — Read the hand from the current standing only
- `src/cards.ts` `readHand(info, myInGameId)`: find the FIRST field of `info` whose `$type` is
  `warlight.shared.GameStanding` (reuse/export the same rule `standingFromInfo` uses — one shared
  helper, e.g. `currentStanding(info)` in `src/live.ts`, used by both) and walk only that object for
  card instances under my player key. Never walk pending orders, the `GameTurn`, or the previous
  standing. If `info` has no `GameStanding`, return `[]` (stay loose, never throw).
  Keep the existing owner filter, GUID normalisation, type/armies read and dedupe.
- Tests (`tests/cards.test.ts`), TDD — write them first and see them fail:
  - a synthetic `LatestGameInfo` with: pending orders holding a `GameOrderPlayCardReinforcement`;
    a current standing with my hand {Order Delay A, Reinforcement B, Order Priority C}; a
    `GameTurn` whose `GameOrderReceiveCard` list carries B and C and whose orders include a
    `GameOrderPlayCardBlockade` for D; a previous standing with {Order Delay A, Blockade D,
    Reinforcement E}. `readHand` returns exactly A, B, C (not D, not E).
  - another player's cards in the current standing are still excluded.
  - no `GameStanding` → `[]`.
  - update existing `readHand` fixtures (the `info(...)` helper) to wrap the hand in a current
    `GameStanding` so they still describe a real shape.
- `playRequired` is unchanged (still `hand.length >= maxCardsHold`; the threshold direction is
  unverified — say so in its doc comment) but it now counts only the real hand.

### C2 — Order Delay runs in phase 50
- `src/protocol/methods.ts`: `TurnPhase` gains/uses the attack phase for Order Delay:
  `CARD_PHASE.OrderDelay = TurnPhase.Attacks` (50). Within one phase a card play sorts AFTER the
  moves (stable sort on `(phase, isCard)`), so an Order Delay is written after every
  AttackTransfer; document that the within-phase position is unverified. Update the doc comments
  that call Order Delay's phase "unverified"/"placed with Order Priority".
- `src/tools/turn.ts`: drop the "play an Order Delay card on its own" refusal (and its hint) now
  that its phase is known; Order Delay may be combined with other card plays.
- Tests, TDD: `writeSendOrdersParams` with `[OrderDelay, Reinforcement, deploy, move]` input writes
  Reinforcement, deploy, move, OrderDelay (golden bytes from the encoder, synthetic GUIDs, player
  777); Order Priority still sorts first. Replace the turn-tools test that expected the
  "Order Delay mixed with another card play" refusal with one asserting the combination is accepted
  (preview contains both plays).
- `docs/WEB-PROTOCOL.md` (and `docs/WARAPP-API.md` if it lists card phases): Order Delay = tag 11,
  phase 50, verified live 2026-11-12 (error 10 at phase 12); the hand is read from the current
  `GameStanding` (stale instances → error 50).

Both tasks: `npm test` (typecheck + vitest) must be green; `git grep` the diff for any real email
before committing. Commit each task separately with a conventional `fix(cards): …` subject.
