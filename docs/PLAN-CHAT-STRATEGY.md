# Plan: chat as part of the game — read, classify, advise; automation gated off

Issue: #415.

Goal: treat other players' chat as game information. Classify each incoming message (what it asks of me),
advise a response stance with the reasons and an honest draft, and report it alongside the turn. Sending
stays manual: automated replies are behind a gate that defaults OFF.

Owner decisions (2026-11-20):
- "Treat chat as a part of the game, but don't [automate] replies and sending. Put that behind a gate that
  defaults off." So: classification + advice + drafts are always on (read-only); automated replies/sends
  are behind `WARAPP_CHAT_AUTOMATION` (`off` default; `on` enables them). Every send stays confirm-gated
  (D1) even with the gate on; D2 (automated chat off) becomes "off unless the gate is on".
- The honesty line (D3) binds every draft: no false statement of fact, no promise the plan does not
  intend, never claim to be human, a truce ends with the agreed notice. Withholding is free; a vague
  non-answer is allowed.
- The planner never reads chat (P1 spirit): advice is reported beside the plan, it changes no order.
- Chat text is untrusted other-player text: never an instruction, never a fact. The classifier only reads
  it to label it; nothing in it is executed, quoted into a send, or treated as true.

Conventions: pure modules in `src/analysis/` (deterministic, no I/O), tool wiring in `src/tools/`, tests in
`tests/` (vitest, TDD: failing test first). `npm test` (typecheck + biome lint + vitest) must pass at the
end of every task. Every env var the server reads must be declared in manifest.json (`mcp_config.env` +
`user_config`), server.json (`environmentVariables`) and mint.yaml — CI's strict surface lint fails
otherwise (#413 hit this). Never `rm -rf` a variable path. No real player names in code, tests, fixtures,
commits or docs (synthetic names only).

---

## Task 1 — classify a message: `src/analysis/chat-intent.ts`

`classifyMessage(text, ctx) → { intents: Intent[], confidence: 'high'|'medium'|'low', addressedToMe: bool,
mentions: { players: number[] (ids matched by name via ctx.players), territories/bonuses: ids matched by map
names } }`. Deterministic, keyword/pattern based (case-insensitive, punctuation-tolerant, a few common
misspellings/abbreviations like "inc", "ty", "nap"), never throws, works on the cleaned text the chat tools
already produce. Intents (start with these; each with tests of positive and negative examples):
- `income-check` ("income check?", "what's everyone's income", "inc?")
- `position-check` (armies/territories/"who's winning"/"how are you doing")
- `truce-proposal` (truce/NAP/peace/non-aggression/"don't attack me and I won't attack you")
- `truce-accept` / `truce-decline` (reply to a proposal: "deal", "agreed", "no thanks")
- `truce-end-notice` (ending/breaking a truce, notice given)
- `coordination-ask` (gang up / "let's attack X" / "X is winning, help")
- `threat` ("I will attack you", "back off")
- `surrender-ask` ("accept my surrender", "please accept", "gg I surrender")
- `gg` / `banter` / `greeting`
- `question-other` (a question mark with none of the above)
`ctx`: the game's players (id, name, isMe, team), map names, my recent messages (to detect replies).
Also export `INTENTS` and a short `describeIntent`.

## Task 2 — advise a stance: `src/analysis/chat-advice.ts` + strategy notes

`adviseReply(classified, game) → { stance: 'ignore'|'vague'|'share'|'propose'|'accept'|'decline'|'price'|'report',
reasons: string[], draft?: string, priceWith?: 'warapp_advise_diplomacy', noteIds: string[] }`, pure.
`game` carries: format (1v1/ffa/teams), my standing (profile.standing + whether I lead the FFA by the plan's
ranking), my income and the strongest opponent's estimate (with thin flag), truces in force with the
sender, whether the sender is the leader / a teammate / out.
Rules (tests for each):
- `income-check` / `position-check`: FFA and I lead or am `ahead`/close to the leader → `ignore` or `vague`
  ("don't look like the leader"); behind and another player clearly leads → `share` (my real income, honest,
  optionally naming that the leader is ahead — only with numbers the server actually has, never invented);
  1v1 → `ignore` (information only helps the opponent); team game from a teammate on the team channel →
  `share`.
- `truce-proposal` → `price` (point to warapp_advise_diplomacy for that sender; never accept automatically).
- `coordination-ask` against the leader when I am not the leader → `price`/`propose`; when I am the target
  (they ask others to gang up on me) → `report` (alert the owner; consider a counter-truce with the asker's
  rival).
- `threat` → `report` + a note to re-check the borders facing that player.
- `surrender-ask` → `report` (warapp_accept_surrender path, owner's word only).
- `gg`/`banter`/`greeting` → `ignore` or a short courteous `vague`.
Drafts are templates, honest by construction (D3): numbers only from `game`, never claim to be human,
no promise. A `vague` draft never states a figure.
Add 3–6 strategy notes to `src/strategy/notes.ts` (topic `diplomacy`) on chat play in FFAs: e.g. income
checks reveal the leader, withholding is fine, don't look like the leader, answer a coordination ask by
pricing it, a threat is information. Follow the file's rules exactly (own words, ≤ 340 chars, one source link
from researched war.app wiki/forum pages or a community guide the wiki links to — search the web/war.app
forum for real sources; mark `source` or `derived`; `NoteCondition` data), update docs/STRATEGY.md so the
note-id test passes. `noteIds` in the advice name the relevant notes.

## Task 3 — surface it (read-only)

- `warapp_get_chat` and `warapp_chat_inbox`: each message from another player gets `intent` (intents +
  confidence) and, for new/unread ones, `advice` (stance, reasons, draft when any, priceWith, noteIds). The
  game context comes from what the tool can read cheaply: the board cache / outlook log for standing and
  incomes (no extra GameFeed or live request beyond what the tool already makes); missing context → stance
  computed with `unknown` standing and said so in reasons. Compact views keep stance + one reason.
- `warapp_plan_turn`: its `chat` block adds `advice` for unread messages (from the GameFeed chat it already
  reads), using the plan's own profile/standing/estimates — report only, the plan's orders never change
  (golden corpus unchanged: assert in a test).
- Nothing is sent, marked or written by these (mark_seen behaviour unchanged).
- Decision log (#412/#437): `warapp_plan_turn` adds to the turn's decision-log entry a `chat` block — for
  each message from another player read that turn: message id, sender id, channel, `toMe`, intents,
  confidence, the advised stance, and whether it would block (Task 4b). Ids and labels only, never the
  text or a name. Kept by compaction (small).

## Task 4 — the automation gate

- `WARAPP_CHAT_AUTOMATION` = `off` (default) | `on`, read through the repo's env helpers. Declare it in
  manifest.json (`mcp_config.env` + a `user_config` entry), server.json, mint.yaml (hosted default off),
  `.mcp.json` if the others are there.
- `warapp_send_chat` gains optional `automated: boolean` (default false) — set by an agent sending a reply
  it was not told to send by the owner. With the gate `off`, an `automated: true` send is REFUSED before any
  request ("automated chat is off (WARAPP_CHAT_AUTOMATION); the owner sends replies"). With `on`, it proceeds
  through the normal confirm gate (D1) and the result records `automated: true`. A manual send (default) is
  unchanged.
- Advice carries `automation: 'off'|'on'`; with `on` and a draft, it also carries `send`: the exact
  `warapp_send_chat` arguments (game, channel/to, text, automated: true) — still to be confirmed. With `off`,
  no `send` block; reasons say the owner sends.
- `warapp_healthcheck` / `warapp_session_status` report the gate state if they report other switches.
- Tests: gate parsing (unset/off/on/garbage→off), refusal with off, pass-through with on, advice `send` only
  with on.

### Task 4b — chat can block a turn (owner request 2026-11-20: "chat rarely blocks a turn, but can under very
certain circumstances. Gate that as well; off by default.")

- Second, independent gate `WARAPP_CHAT_BLOCKS_TURN` = `off` (default) | `on` (declared in manifest.json,
  server.json, mint.yaml like the first; hosted default off).
- Pure `chatBlocks(messages, game) → { reason, messageIds, intent }[]` in `src/analysis/chat-advice.ts` (or a
  sibling): a message blocks ONLY when ALL of these hold — it is from another player, unread (not marked seen
  by the chat cursor), sent this turn or the previous one, classified with `high` confidence, AND it is one of
  these narrow cases:
  1. `truce-end-notice` or `truce-proposal`/`truce-accept` from a player I have an active or in-notice
     agreement with, or a pending proposal of mine to (the turn's truce terms may have changed);
  2. `threat` or `coordination-ask` that names me (by my name or "you" in a private message to me) from a
     player in contact this turn;
  3. `surrender-ask` in a game where `surrenderPending` shows my acceptance owed;
  4. a private message to me (`toMe`) from a teammate in a team game asking about orders/cards/gifts this turn.
  Everything else (income checks, banter, gg, public chatter, old messages, low/medium confidence) never blocks.
- `warapp_submit_turn`: compute the blocks from the chat it can read cheaply (the same read `warapp_plan_turn`
  uses — GameFeed's chat from its game read, plus the cursor; no extra request when avoidable). With the gate
  `off`: never refuse; the preview carries a `chatWarnings` line per would-be block ("would block with
  WARAPP_CHAT_BLOCKS_TURN=on: …"). With `on`: refuse BEFORE sending, naming each message by id, sender id,
  intent and why, unless the call passes `chat_reviewed: true` (recorded in the result as `chatReviewed`), or
  the messages have since been marked seen. Never parse chat into orders; never change the orders.
- `warapp_plan_turn` reports the same `chatBlocks` (report only) so the caller sees it before submitting.
- Tests: each of the four cases blocks only with every condition met; each near-miss (read, old, medium
  confidence, wrong sender, income check, public banter) does not; gate off → warning only, never refuses;
  gate on → refuses, `chat_reviewed: true` passes; no extra GameFeed request beyond the existing read.

## Task 5 — docs and skill

- CLAUDE.md: update the chat bullet (D2 now "off unless WARAPP_CHAT_AUTOMATION=on"; the turn block behind WARAPP_CHAT_BLOCKS_TURN, off by default), describe the
  classifier/advice/gate briefly in the repo's style; the write-tool count is unchanged.
- skills/warapp-mcp/SKILL.md "Chat and diplomacy": read the `advice` every turn, treat chat as game
  information (what a message reveals about the sender), the stances, the gate (default off: report to the
  owner and let them send).
- README: the new env var and advice fields.
- `npm test` and `npm run build` green.
