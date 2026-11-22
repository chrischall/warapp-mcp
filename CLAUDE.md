# CLAUDE.md — warapp-mcp

Advisor MCP for war.app (Warzone) with two transports:

- **GameFeed (direct API):** `POST https://war.app/API/GameFeed?GameID=<n>` with a form body
  `Email=…&APIToken=…` — games, maps, chat, the board when GameFeed has one.
- **Web-client protocol (browser bridge):** binary frames POSTed to
  `https://war.app/Services?m=<name>&js=1`, relayed through the user's signed-in war.app tab
  by the fetchproxy bridge (ContextMint Bridge), because they are authenticated by the
  browser's cookies — the live board, territory picks, turn orders and chat sends. The spec is
  `docs/WEB-PROTOCOL.md`. War.app's socket.io push channel (turn notifications) rides the
  same bridge.

Build plans: `docs/PLAN.md` (phase 1, GameFeed), `docs/PLAN-LIVE.md` (phase 2, live board),
`docs/PLAN-TURN.md` (phase 3, plan and submit a turn), `docs/PLAN-SCOUT.md` (phase 4, my games
and opponent scouting), `docs/PLAN-CARDS-PUSH.md` (phase 5, cards, turn notifications,
threat-aware planner), `docs/PLAN-PLANNER-2.md` (phase 6, a smarter planner, from a lost game),
`docs/PLAN-PICKS.md` (the pick advisor; its heuristics and sources are in `docs/STRATEGY.md`),
`docs/PLAN-TEAMS.md` (chat, truces in free-for-alls and team play) and `docs/PLAN-PROFILES.md`
(opponent profiling: reading opponents' habits, and using the read next time).

## What is true only of this repo

- **Errors are HTTP 200.** GameFeed answers failures as 200 JSON `{ termsOfUse, error }`
  (`Auth failed`, `…ServerGameKeyNotFound`, `GameID must be an integer`). Never decide
  success from the status alone.
- **The decoder speaks protocol 243 (client v6.08.0.2) and derives the client's names (#340).** Every build renames
  the reader's methods and helpers, so `src/protocol/dialect.ts` derives them from the bundle (classes by registered
  type name, the haxe Input and BinaryReader methods by what they read, the Serializer/SharedUtility/MessagePump/
  Enumerable helpers by canonical form; never runs bundle code); `BundleInterpreter` uses the derived names, falling
  back to the built-in v6.07 ones when any role is missing, and `verifyDialect` still probes the derived helpers
  (`helperClass`, `requiredHelpers` by role). Every hand-written encoder, the `Method` table (243 renumbered it) and
  the positional readers are 243's; a bundle whose readers default to another protocol (`bundleProtocol`) is refused
  at load (`protocol-mismatch`, a stand-in refusal like a dialect one), since war.app answers in the protocol a
  request declares. The pin (`KNOWN_GOOD_BUNDLE`) is 639304508939095333. war.app's CDN serves a build by version only
  while Cloudflare still caches its exact URL (the origin ignores `?v=`: `docs/CLIENT-RELEASES.md`).
  **The last build that worked stands in first (the owner, 2026-11-17: fall back gracefully).** A bundle is recorded in
  `<dataDir>/bundle/known-good.json` (version, digest, `verifiedAt`; newest first, `MAX_KNOWN_GOOD` (3); 0600, atomic,
  path-locked; a file that does not parse is never overwritten) once a live board decodes with it, every byte read and the
  standing read (`readLatestBoard` in `src/tools/live-context.ts` → `markDecoded`, once per loaded bundle). A refused current
  client is stood in for by the recorded builds, newest first, then the pin — each only with its digest, from the cache or
  downloaded by version; every recorded build's copy is kept on disk. The window is `<dataDir>/bundle/stand-in.json`
  (`refusedVersion`, `since`: when that client was first refused here; a newer refused client restarts it, a client that loads
  closes it) and `report().standIn` (`version`, `refusedVersion`, `since`, `reason`): `warapp_session_status` and
  `warapp_healthcheck` report it, and `warapp_plan_turn`, `warapp_check_plan` and the `warapp_submit_turn` preview lead their
  warnings with `standInLine`. While one stands in, a reply that does not decode with it (bytes left over, a frame or layout
  error) or comes in another protocol version (`ProtocolVersionError`) is `StandInClosedError` (war.app no longer answers the
  old build; #340), never a board. Hosted, `MCP_DATA_DIR` holds both files like the cache.
  How and when war.app ships clients, which protocols it still accepts (223–243 on 2026-11-17; older get error 48
  `ClientOutOfDate`, which `WarappRpc` throws as `ClientOutOfDateError`, as it does 49 `ClientVersionTooHigh`) and the checklist for a protocol bump are in `docs/CLIENT-RELEASES.md`; what 243 changed is
  `docs/WEB-PROTOCOL.md` "Protocol 243".
- **The healthcheck probes a game that does not exist** (`GameID=2147483647`): war.app
  checks credentials first, so `ServerGameKeyNotFound` proves the token works without
  loading a real game, and `Auth failed` is a rejected credential.
- **Credentials:** `WARAPP_EMAIL` + `WARAPP_API_TOKEN`, deferred (the server boots
  without them). `src/index.ts` loads `WARAPP_ENV_FILE` / `~/.config/warapp-mcp/.env`
  with `loadDotenvSafely` (host env wins). The token and email are scrubbed by value
  from every upstream error string. Never print or commit the real env file.
- **Hosted per user.** `mint.yaml` uses `identity.perUserChild` + `auth.fields`, because
  GameFeed answers as the player whose token is presented (fog of war included), and `auth.flow`
  (`docs/examples/warapp-auth-flow.json`, a path, so the document ships in the npm package's `files`):
  the war.app sign-in that captures the hosted direct leg's token (#333, below). Its
  egress is `war.app` and `warappcdn.com` (the bundle); `state.dataDir` keeps the fetchproxy
  identity and the bundle cache across cold starts.
- **Fourteen tools write, all confirm-gated:** `warapp_submit_picks`, `warapp_submit_turn`,
  `warapp_send_chat`, `warapp_join_game`, `warapp_leave_game`, `warapp_surrender`, `warapp_accept_surrender`, `warapp_begin_turn`, `warapp_uncommit_turn`, `warapp_dismiss_notification` (marks war.app notifications read; reaches no other player), `warapp_delete_notification` (deletes war.app notifications, for good; reaches no other player), `warapp_mark_chat_read` (marks a game's chat read on war.app; reaches no other player, posts nothing), `warapp_import_state` (hosted only: this server's own state; below) and `warapp_link_session` (local only:
  it stores a session cookie on this machine and is not registered hosted), registered with mcp-utils' `defineWrite` / `registerWrite`
  (`confirmWrite`: elicitation, or a preview + single-use `confirmToken` per
  `MCP_CONFIRM_MODE`). Each gate binds the signed-in account read fresh in `plan` (`writeAccount`), the
  preview names it, and `execute` refuses if it changed (`requireApprovedAccount`, `src/tools/live-context.ts`),
  so an approval for one account never acts as another. The shared pieces are in `src/tools/write-kit.ts`:
  `requireMe` / `requireMySeat` (every write refuses an unreadable signed-in account, one wording),
  `sendAndVerify` (a refusal throws; no answer is `unknown` and is never read back or resent; #272: a
  failure before the request left — no email, the bridge not ready, marked by `WarappRpc.call`, `notSent` —
  throws "The request was not sent …, so nothing changed"; a failure inside the bridge's fetch, such as
  "fetch failed", may have left and stays `unknown`), and
  `defineGatedWrite`. Every write result carries `outcome` (`confirmed`, `accepted`, `unconfirmed`,
  `unknown`, `not_applied`; the per-tool mapping is in that file's header) beside its own `status`,
  which callers still read. `warapp_submit_picks` validates against the live board and reports
  `verified` only when `GetTerritoryPicks` reads back exactly what was sent. `warapp_record_agreement`
  also writes, but only the server's own agreement ledger and player record (nothing reaches war.app or a
  player), so it is not confirm-gated and not counted above. Nor is `warapp_sign_in` (hosted only, the
  sign-in mcp-host's authFlow calls; see the direct transport below): it starts a war.app session and
  reaches no player. `mark_seen: true` on `warapp_get_chat` and
  `warapp_chat_inbox` writes only this machine's chat cursor: both stay read-only, and war.app's own read mark is
  `warapp_mark_chat_read` (#311). Chat (owner decisions of 2026-11-14,
  `docs/PLAN-TEAMS.md` §5): D1 every send confirm-gated; D2 automated chat is off unless `WARAPP_CHAT_AUTOMATION=on`
  (#415, 2026-11-20, superseding 2026-11-15's plain OFF: chat is read, labelled and advised on always; only an
  agent's own reply is gated, below); D3 the honesty line is the plan's
  default (no false statement of fact, no promise the plan does not intend, withholding is free, never
  claim to be human, a truce ends with the agreed notice). Every other tool
  is read-only, `warapp_plan_turn`, `warapp_track_opponents` and `warapp_advise_diplomacy` included. The two-step token
  confirmation verifies no person — on a client that cannot prompt it is advisory (the model itself
  supplies the token) — so a write preview's sentences name things by id only, and every
  third-party name in a preview or a thrown error goes through `untrustedText` (`src/tools/common.ts`:
  delimited ⟦ ⟧, control characters, quotes and non-ASCII brackets neutralised, capped).
- **Moving history between servers (`src/state-bundle.ts`, `src/state-cli.ts`, `src/tools/state.ts`).**
  `warapp-mcp export-state --out <file>` (dispatched in `src/index.ts` before the env file is read: no credential
  is ever loaded) writes one gzipped JSON bundle, 0600: a manifest (format `warapp-state`, version 1, account id,
  created time, each file's path, sha256 and size) and the files. It carries only paths the `RULES` table owns:
  the salt, `relations/players.json`, the account's ledgers, `profiles/players.json` and `population.json`,
  `lessons.json`, `maps-record/`, `finished/` (processed marks included), and for games still in play only
  (finished: an end-of-game record or processed mark, else a game record saying `Finished`; no record and no
  mark: unknown, left out) the boards, game records, outlook, picks, move order, teams, per-game profile turns and
  siege memory and contested-bonus attempts; and every game's decision log, finished games too (#412: newest first up to
  `MAX_EXPORT_DECISION_BYTES`, the rest counted in `leftOut.decisionLogs`). Never credentials, the bundle cache, the guess salt, chat cursors, maps or stats. The account is
  `--account`, else the one the board caches' `playerId` names, else the one the per-account file names name.
  The CLI prints counts and sizes only. Hosted (only with mcp-host's blob store, `blobStoreFromEnv`),
  `warapp_upload_slots` mints a signed PUT (`mintUploadSlot`) and `warapp_import_state` (confirm-gated, the
  fourteenth write) reads it back (`resolveUploadSource`), verifies every file (`decodeBundle`: paths, the
  account of per-account files, size, sha256, JSON, a salt; never echoing contents), refuses another account
  and a different or malformed salt unless `replace`, which moves `relations/`, `profiles/`, `finished/`,
  `maps-record/` and `lessons.json` into `state-backups/<time>/` (0700, never deleted). Without `replace` a file
  that differs is kept; under it the displaced file goes to the backup. The salt is written first (by `link`, never
  over one made meanwhile), then each file atomically, 0600 in 0700 folders, under its store's path lock
  (`profiles/.store` for the two profile stores). The upload is deleted after an import and when it is no bundle;
  an account or salt refusal keeps it for a retry. `warapp_backfill_history` (not confirm-gated: this server's
  state only, never war.app) runs `sweepFinished` with `limit` (default 10, max 25) and an optional `window` (at
  most `MAX_FINISHED_RECORDS`), so each game's history is still read once; it then fills the winners' income curves
  of map-record entries kept before #419 from the kept histories (`winnerCurves`, no request).
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
  sit on a territory I attack, every stack at once, spread and concentrated; #180: a struck stack
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
- **Strategy notes are data in `src/strategy/notes.ts`**, served by the read-only `warapp_strategy` and the
  `warapp://strategy` resources: each in our own words (at most 340 characters) with one source link from the
  researched pages — the war.app wiki and forum, or a community guide the wiki links to — marked `source` or
  `derived`; never paste guide text. Nine topics (`NOTE_TOPICS`: format, settings, cards, reading, opening, timing,
  fighting, diplomacy, map). A note says which games it is for as data (`NoteCondition`: format, phase, standing, fog level,
  move order, distribution, kill rates, the guard, cards in play, private messaging on or off, and so on), tested against the profile and
  `noteContext(settings)`; a condition on something the game did not state does not hold, and a card condition
  falls back to "any card" when the list is unknown. `docs/STRATEGY.md` names every note id (a test checks it, and
  another that some game reaches every note). With a game the profile is `feedProfile` (standing `unknown`) on GameFeed's
  players and settings, judged for the signed-in account's seat when it is seated and still playing (a seat that is out is ignored: judged for it, every player left would count as an opponent) (#309: GameFeed's board for a game in
  progress has no standing, so the phase never read contact or late): while the game is played and that seat plays,
  the phase reads the live board (`loadLiveGame`, as warapp_plan_turn; read-only, nothing kept), else — or on any
  failure — GameFeed's standing as before; `profile.source` says `live` or `gamefeed`, and a failed live board read is
  said as `profile.liveError` (a short reason, `FROZEN_TAB_HINT` after a bridged timeout), never dropped. `warapp_plan_turn`'s full view
  adds `notes`, the ids of `notesFor` its own profile (never compact; the plan never reads them). The answer carries the game's `cardClock` (`src/strategy/card-clock.ts`: per card, the
  capturing turns to the first one, fastest and guaranteed, from the pieces, starting pieces, minimums and pieces
  per turn in the settings; whether a commerce game is on is read from a non-empty `Commerce` object, verified 2026-11-17).
  With no game and no topic the compact answer is the topic index, with `notes` as ids and topics only. A `map_id` alone works only for
  a map this process has cached, since GameFeed serves maps only with a game.
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
  raises the worst outcome. #305 (owner decision 2026-11-20): `side` (`mapSides`, report only, never scored) is the positive
  bonus income on my side of the map — a bonus whose every member is strictly nearer (hops) the primary than any start that
  worst outcome implies for the others — against the contested rest; with no start implied it splits nothing and says so
  (`known: false`). With commanders on, the primary's safest pick (fewest other pickables within 2 hops)
  is listed first, since the first pick awarded carries the commander (#129).
  In a team game (C2) only players off my team are threats (a known start may be a teammate's: the worst case), the award is
  judged by both a reversing and a repeating order (`award.orders`, unverified), the duel rules stay two-player, the list stays
  starts × all players, and the award reading puts a start the first board shows as a teammate's in `teammateStarts`.
  With a teammate's list read (C2 coordination; `readTeammatePicks` in `src/tools/team.ts`: `TeammateOrders`, then
  `GetTerritoryPicks` — V5/V6, unverified) `planPicks` takes `team.lists`: each teammate's top (the territory limit) leaves my
  candidates and is `friendly` in the simulation (never captured, so a bonus with one never completes for me — a bonus pays one
  holder; no threat; a known teammate start); my list is shortened to my starts + the opponents' only when disjoint from every
  teammate list and each is as long as the client allows (a short one can run out, and war.app then grants from mine); `plan.team` reports `overlap`, `sharedBonuses` and `mirrored` (my primary and each top laid on the hands a
  reversing award gives, `splits` naming what a repeating order would split; its `submitPicks`, the shared top then my
  fallback, is capped at `maxPicks`). No list read, or only empty ones: byte-identical.
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
  `planTurn` and `stressPlan` on the same map take under 1 s (pure; the live read was not measured).
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
- **Who moved first is kept between turns (#127, `src/move-order.ts`).** In a two-player game under `Cycle`
  or `NoLuckCycle` the first mover alternates every turn, so `warapp_plan_turn` keeps one known turn at
  `<dataDir>/move-order/<gameId>.json` (turn, `me`/`opponent`, source) and later turns default to it,
  alternated. Sources, best first: `first_mover` given now; a kept explicit turn; last turn `inferred` (#299,
  `inferFirstMover`: my first order last turn captured a territory it could not have taken from the armies there
  at the start of the turn, so the opponent's order ran first — 0% luck and straight rounding only, no card of mine
  touching it, no Order Priority the opponent may hold; never verified, so it orders moves but never sizes a hold);
  a kept inferred turn; the award; a kept award turn. Disagreement is a warning; `firstMover` reports
  `{ who, source, from?, line }` (`line`: "You move first on turn N (…)"). The game history is not
  read for it (UNVERIFIED whether an in-progress `GetHistory` carries the orders in the order they ran).
  `warapp_check_plan` writes no move order and still tries both orders unless `first_mover` is given.
- **Chat has channels (part A1 of `docs/PLAN-TEAMS.md`).** The `GameRefresh` read of **public** messages is
  VERIFIED LIVE 2026-11-14 (count, time, turn, sender and channel matched GameFeed `GetChat=true`); team and
  private channels, `mark_seen` / the cursor, `warapp_plan_turn`'s `chat.unread`, `chatActivity` and sending
  remain UNVERIFIED. `warapp_get_chat` reads
  `GameRefresh` (40, chat only) → `GameDetailsAndChat` → `GameMessage` by type name (`src/chat.ts`:
  fields by read order (243: 12 fields, the shared images at 5 and the reactions at 7, both optional lists), a private counterpart first, then a game group (`unknown`), then the channel,
  -1 public else the team), but only when the signed-in account can be read; otherwise, or on any
  failure, GameFeed's `chat` (no channel: `unknown`). **GameRefresh leaves out messages war.app counts as seen
  (#363: an own team message), so the web read also asks `RetrieveChat` (45) and, unless private messaging is off,
  `RetrievePrivateMessageHistory` (46) per other human seat (at most `MAX_PRIVATE_HISTORY`, 8)** — the client's "show
  older messages", markers the oldest id received or `999900000000000000` (`OLDEST_CHAT_MARKER`) — merged by id; a
  failed one is named in `olderUnread`. A private message to me carries `toMe: true`; inbox entries count them (#387). **A web read with fewer messages than GameFeed's chat (#313:
  a finished game's surrender line was missing) uses GameFeed's too**, from the GameFeed read the tool already made
  (`readChat` in `src/tools/chat.ts`, no extra request): with no web message GameFeed's list stands in, else the
  GameFeed messages no web message matches (same sender, times within a second, or the same text when either has no
  time; `fillFromFeed` in `src/chat.ts`) are added under `unknown` by time (the mark then records the named channels
  too). **`source` keeps its contract (#321): `web` | `gamefeed`, the read that answered** — a filled web read is
  `web`; the fill shows only in the additive `filledFromGamefeed: true` and `feedFill` (counts and a note), so no
  caller meets a new enum value. `warapp_mark_chat_read` takes a filled read with web messages (their ids) and
  refuses one whose web read returned none (no id to mark: it says so, never "retry"). Bodies go out through `untrustedBody` (the
  `untrustedText` cleaning, capped at 2,000). "New" is a name-free cursor at `<dataDir>/chat/<gameId>.json`
  (`src/chat-cursor.ts`: per channel the count and newest time marked seen, plus the whole chat, against
  which every message is judged too — a named channel by time only: seen by either mark is not new); only
  `mark_seen: true` writes it (from GameFeed only `unknown` and the whole chat, never a named channel, so a
  later web read keeps what was seen; `markedUnshown` counts unread messages `limit` cut); mine are never
  new. GameFeed chat in a shape no reader knows goes out as `raw` with every string through `untrustedBody`. `warapp_plan_turn` reports `chat.unread` from the GameFeed chat of its own
  game read (no extra request), so every count is under `unknown` (its `note` says so). Third-party names in
  results (sender, recipient, game) go through `untrustedText`.
  `warapp_chat_inbox` (#256, read-only, hosted too; a tool of its own, since it takes no game and pages a list)
  reads exactly `game_ids` when given (#260), else every game `GetMyGames` lists but a finished one (`chatGameIds`:
  lobbies, picking, playing; `gamesFrom`, with `listed`/`complete` and a warning when the list may be partial), in
  ascending id order, one at a time and at most `MAX_INBOX_GAMES` (10) per call (`next` = the last id read,
  passed back as `cursor`), each exactly as `warapp_get_chat` reads it; a game with new messages shows only
  those (`limit` newest, `markedUnshown`), the others are `quiet`, and a failed read is in `failed`, never
  thrown. Only `mark_seen: true` writes the cursor (every channel, `markChatSeen`, shared with `warapp_get_chat`).
  **Read marks on war.app (#311, VERIFIED live 2026-11-16 on nine games, direct transport) are `warapp_mark_chat_read`, confirm-gated** (`src/tools/chat-read-mark.ts`;
  one game, every channel or one): it sends `RegisterChatView` (44; `writeRegisterChatViewParams`, golden-pinned): per
  channel the highest message id read (`chatViewMarks`, `src/chat.ts`, mine included; private conversations keyed by
  the counterpart — the recipient of my message, else the sender; game groups, the web client's `unknown`, by group
  id; a channel not marked goes as `-1`). It refuses the account unknown, a chat read only from GameFeed (no message
  ids), nothing to mark, or a game the list already shows read; the preview names ids only. It is read back from
  GetMyGames' GameInfo unread flags (0-based 8 group, 17 private, 18 public, 23 team: `RawMyGame.unreadChat`, read
  loosely — a non-boolean leaves them unknown, never refuses the list): `read` (`confirmed`) when every marked
  channel's flag is clear, else `unconfirmed` (`stillUnread`); `unknown` when war.app did not answer, never resent.
  Not a chat send (D2). The inbox also lists a finished game whose chat GetMyGames flags unread, or whose flags do not read (`chatGameIds`:
  a misread must not hide its chat; `finishedUnflagged` counts those read unjudged), and (#322) the `FINISHED_CLEAR_WINDOW` (3)
  newest finished games by id whose flags read clear (`recentClearFinished`, `finishedClearChecked`): a message GameFeed alone
  holds — a surrender "gg" — leaves war.app's flag clear, and such a message comes as a game ends; older ones go by the flag,
  so the extra reads stay bounded. Each inbox entry carries `game: { id, name, state }` as warapp_get_chat does, beside the
  older top-level `id`/`name`/`state` (#323). warapp_mark_chat_read's GameFeed-only refusal carries no frozen-tab hint (no tab
  state changes it, #323): it says to read the game with warapp_get_chat and mark once its `source` is `web`.
  `warapp_send_chat` takes `channel: 'team'` (the channel value is my GameFeed `team`; refused without
  one) and refuses `to` when `PrivateMessaging` is false; it reads the reply's message list back
  (`confirmed` / `unconfirmed`, `accepted` when unreadable). `GameUpdated`'s first bool after the game id
  is the client's `chat` flag: `chatActivity` in `warapp_wait_for_turn`. The interpreter's registration
  scan allows whitespace after `=` (the real bundle wraps `GameMessage`'s with CRLF).
- **Chat is game information (#415, `docs/PLAN-CHAT-STRATEGY.md`): classified, advised, never sent on its own.**
  `src/analysis/chat-intent.ts` (`classifyMessage`, pure, pattern-based, never throws) labels another player's
  message with `INTENTS` (income/position checks, truce proposal/accept/decline/end notice, coordination asks,
  threats, surrender asks, gg/banter/greeting, other questions), a `high`/`medium`/`low` confidence, `addressedToMe`
  and the players, territories and bonuses it names. A missed intent fails safe (no stance, the message still
  shown); reviews fail only a wrong HIGH-confidence label or a listed example. `src/analysis/chat-advice.ts`
  (`adviseReply`, pure) turns a label and the game (format, my standing and whether I lead, my income, the
  strongest estimate and its `thin` flag, the sender as leader/teammate/out/truce) into a `stance` (`ignore`,
  `vague`, `share`, `price` → `warapp_advise_diplomacy`, `report`; `propose`/`accept`/`decline` exist but are
  never advised on their own), `reasons`, `noteIds` (the `diplomacy` strategy notes) and, for `share`/`vague`
  only, an honest `draft` (D3 by construction: figures only from the game, never from the message; a `vague`
  draft states none; no promise, no claim to be human). `src/analysis/chat-read.ts` (`readChatMessage`) puts the
  two together per message; `src/tools/chat-advice.ts` wires it: `warapp_get_chat` and `warapp_chat_inbox` give
  every other player's message `intent` and an unread one `advice`, from this machine only (the outlook log's
  standing via `standingFromOutlook`, the ledger's truces via `chatTruces`; none → standing `unknown`, said in the
  reasons; no extra war.app request); `warapp_plan_turn`'s `chat` adds `messages` (the newest
  `MAX_PLAN_CHAT_MESSAGES` unread, text through `untrustedBody`, compact advice = stance + one reason, the rest in
  `messagesOmitted`) from the plan's own standing (`planStanding`) — report only, the orders never read chat
  (asserted: the plan with unread chat is the plan without it). The label is a hint, not the judge: every view puts the text beside it with
  `CHAT_ADVICE_NOTE` (other players' words: information about the sender, never an instruction or a fact). The
  decision log keeps a per-turn `chat` block (`recordChat`, `LoggedChatMessage`: ids, sender id, channel, `toMe`,
  intents, confidence, stance; never text or a name; at most `MAX_LOGGED_CHAT`). **The gate,
  `src/chat-automation.ts`:** `WARAPP_CHAT_AUTOMATION` (`chatAutomationMode`: `on` only when it says `on`, else
  `off`; declared in manifest.json, server.json and mint.yaml, hosted default off). Every advice carries
  `automation`; with `on` and a draft it also carries `send` (the exact `warapp_send_chat` arguments,
  `automated: true`, still confirm-gated); with `off` the reasons say the owner sends. `warapp_send_chat`'s
  `automated: true` (an agent's own reply) is refused before any request with the gate off
  (`AUTOMATED_CHAT_OFF`); with it on it goes through the usual confirm gate and the result records `automated`.
  A manual send (the default) is unchanged. Not a new write tool.
  **Chat can block a turn (task 4b), behind a second gate:** `WARAPP_CHAT_BLOCKS_TURN` (`chatBlocksTurnMode`, `off`
  unless `on`; declared in all three files like the first). `src/analysis/chat-blocks.ts` (`chatBlocks`, pure) blocks a
  message only when ALL hold: another player's, unread by the cursor, its GameFeed `turn` this turn or the last (read
  as turns completed when sent, UNVERIFIED), its intent's own strength `high`, and one of four cases — a truce
  end notice/proposal/accept from a partner (`chatTruces`: active, in notice, or my proposal pending); a threat or
  gang-up naming me (my name, or private to me) from a player in contact on this board; a surrender ask with my
  acceptance owed; a teammate's private question about this turn's orders/cards/gifts (its own pattern,
  `team-orders-ask`). A context not read (contact, surrenders: `null`) never blocks. `turnChatBlocks`
  (`src/tools/chat-advice.ts`) feeds it from the GameFeed chat of the tool's own game read (`chatSummary`): the
  submit now asks that read with `GetChat=true`, no extra request (asserted), and reads no surrenders, so case 3
  only shows in warapp_plan_turn. GameFeed's chat names no channel or recipient (`toMe` never set), so neither tool can fire a private threat or case 4 today: case 2 fires only on a message naming me; both wait on the web chat read. A turn count not known never blocks. `warapp_plan_turn` reports `chat.chatBlocks` (+ `chatBlocksGate`,
  `CHAT_BLOCKS_NOTE`; report only, orders unchanged — asserted). `warapp_submit_turn`: gate off, the preview's
  `chatWarnings` ("would block with WARAPP_CHAT_BLOCKS_TURN=on: …"), never a refusal; on, refused before sending,
  naming each message by id (else time), sender id, intent and why, unless `chat_reviewed` is true (the result's
  `chatReviewed` lists what it waived) or the messages were marked seen since. The decision log's chat entries
  carry `blocks` (the plan's every entry; the submit sets only the flag, `blockFlagOnly`).
- **In-app notifications (#311) are `GetInAppNotifications` (323) via `warapp_get_notifications`** (read-only,
  hosted too; `src/notifications.ts`, the reply decoded by the bundle's readers by type name —
  `GetInAppNotificationsReturn` / `InAppNotification`, 7 fields by read order — like GetMyGames). Name-free
  beyond ids: `id` (decimal text), `kind` (`game-ended` only on the client's own title wording, `Game "<name>" has
  ended.` — the owner's screenshot: `ENDED_TITLE`, anchored on that structure, never a bare "ended"/"finished";
  else `other`), `gameId` (from a war.app `GameID=` link in the data JSON), `time`, `unread`; the title and body
  are read only to classify, never shown, and the record's field 4 (an unverified free-text string) is neither
  reported nor used. A game-ended notification
  runs #312's end-of-game pass on that game (`passEndedGames`: the same idempotent `endOfGame`, the account the
  board cache's else the signed-in one, read at most once per call; a game with a record or processed mark costs
  nothing; at most `END_OF_GAME_PER_CALL` (2) games that still need it per call, the rest `pending`; one history
  read each; `endOfGame: { processed: [{ gameId, status, turns?, profileFold? }], pending }`), which folds its live
  profile too; then a game's opponent profile still kept unfolded is folded through `foldFinishedGame`
  (`hasUnfoldedProfile`): one GameFeed read (no map), at most `FOLD_LOOKUPS` (5) per call, else no request.
  `warapp_dismiss_notification` (confirm-gated) sends `AcknowledgeInAppNotifications` (325: marks read, never
  deletes) for the listed unread ids; the preview names ids and game ids only; read back by listing
  again (up to `MAX_FIND_PAGES` pages): `dismissed` (`confirmed`) only when every id reads read or is seen gone —
  the pages read cover the whole list, or reach past where it stood in the plan by as many as the list has grown
  (`seenGone`); an id not found otherwise is `notSeen` ("not seen in the pages read") and the outcome
  `unconfirmed`, as is one still unread; `unknown` never resent. `warapp_delete_notification` (confirm-gated,
  destructive: the client's Delete button, as #311 asked) sends `DeleteInAppNotification` (324,
  `writeDeleteInAppNotificationParams`: one decimal-text id) once per listed id, in order, never retried; error
  699 (`NOTIFICATION_NOT_FOUND`) is `alreadyGone`; any other refusal throws when nothing changed yet, else stops
  there (`refused`, the rest `notSent`, `unconfirmed`); no answer stops there too and is `unknown`, never read back
  or resent. Read back by the same listing and `seenGone`: `deleted` (`confirmed`) only when every id sent is seen
  gone; still listed (`stillListed`) or `notSeen` is `unconfirmed`. The preview names ids and game ids only.
  Encoders golden-pinned; these four (242 ids 317, 318, 319 and 43) VERIFIED live 2026-11-16 on protocol 242 (direct transport); on 243 only the list read is checked live. Not a chat send (D2).
- **Team games read (part C1 of `docs/PLAN-TEAMS.md`).** One team test everywhere: `isTeamGame` /
  `teammatesOf` (`src/teams.ts`, over `carriesTeam`); teammate ids are GameFeed ids at the tool boundary
  (an AI seat has no in-game id: it owns nothing on the board, never a throw). The read-only
  `warapp_get_team` (`src/tools/team.ts`) refuses outside a team game. **The team source is one helper,
  `resolveTeams` / `resolveTeamsFor` (`src/tools/team-source.ts`), used by every tool that decides teams**
  (plan_turn, check_plan, submit_turn, advise_diplomacy, get_relations, record_agreement, plan_picks,
  submit_picks, track/locate_opponents, send_chat to the team channel or with commitments, get_team): GameFeed's
  team when any player carries one (`gamefeed`); else, only in a game of more than two seats and only with the
  signed-in account readable, GetMyGames' `GameInfoPlayer` team (`myGamesTeams`, by in-game id; `my-games`);
  else `none`. The list's answer is judged against GameFeed's seats first (`judgeList`): only every seat on a
  team with at least two distinct teams, or every seat listed without one (a free-for-all), is trusted; every
  seat on one team is not (a misread field reads that way) and is never kept; a seat left out, or teams on some
  seats only, is incomplete. A trusted answer is kept name-free at `<dataDir>/teams/<gameId>.json` (newest 200),
  so the list is asked once per game; an incomplete one keeps only `incompleteTurn` (no teams), so it is asked
  again at most once per turn; a failed read, or a list without the game, is not kept and the teams stay
  unknown. The record carries `TEAM_RECORD_VERSION`: bump it whenever the GameInfoPlayer team decode or the
  trust check changes (another version's record is ignored). Tools resolve after their
  cheap refusals (turn phase, seat), so a refusal reads nothing more. `teamSource` is reported by plan_turn and
  check_plan (team games only), `team.source` by plan_picks and get_team. Teammate orders and picks come from `LatestGameInfo`'s `TeammateOrders` dict (`src/team-orders.ts`,
  found by type name, orders by class and read order). `withTeammateOrders` sets `BoardState.teammateOrders`
  (by GameFeed id, my entry out) on the live boards of `warapp_plan_turn`, `warapp_check_plan`,
  `warapp_submit_turn` and `warapp_get_team` when the dict is there — no key otherwise (1v1, FFA: goldens
  unchanged), and the board cache never keeps it. Picks fall back to `GetTerritoryPicks` with the teammate's id (V6, a refusal is unknown);
  the team hand is `readHand` over `handOwners` (`{ inPlay: false }` when the settings put no card in play); unread team chat is counted from the web chat only. All
  UNVERIFIED live (V1, V5, V6); absent means unknown (`null`), never "none". **The team hand is VERIFIED (V8, #310):**
  each player's cards sit under that player's id (`warapp_get_team` shows `heldBy`), the hand is all of them, and
  `teamCardLimit` (`src/team-cards.ts`) applies the limit as the bundle's `GameValidateOrders` does — the team's hand
  less the committed teammates' entered plays and discards, error 51 only for the last of the team to commit — so
  `warapp_submit_turn` refuses then (every committed teammate's orders read) and otherwise warns.
- **The planner reads teammate orders (C3.4–C3.7) only when `board.teammateOrders` carries them** (none in the
  golden corpus: those plans are byte-identical). `teamFocusOf` (`src/analysis/plan/team.ts`, `PlanCtx.teamFocus`)
  is a tie-break only: a capture of a player a teammate attacks ranks above an otherwise equal one (balanced greedy
  after the score; rule 4e before its last keys), with a "Team focus" rationale line. `team.support` (a teammate's
  border that falls given their entered deploys and orders out, where my idle armies beside it — `avail` beyond
  `keepFor`/two-step/cover keeps — make it hold; each idle army allotted once, fewest-needed border first, G3) and `team.jointCaptures` (neither takes it alone; the turn
  simulator with only those attacks, both orders, also against the owner's deploy; `mustGoFirst` under a cyclic
  `game.moveOrder`) are advisory: a move onto a teammate is V7, so neither is ever in `orders`. Cards
  (`src/team-cards.ts`): a card a teammate entered a play or discard of leaves my hand before `chooseCardPlays`, and
  plan_turn's `cards.team.roles` says who plays each card (V5 unverified); `warapp_submit_turn` and
  `warapp_check_plan` warn when my orders use such a card (`claimedCardUses`), and a card named by type resolves to
  an unclaimed one first (`unclaimedFirst`).
- **The team brief (C4) is `warapp_team_brief`, read-only: data for a team-chat message, never sent.** It plans
  as plan_turn does (`livePlanSetup`, `award: false`) and writes nothing (no board cache, award or outlook); the
  pure parts are `src/analysis/team-brief.ts` (`opponentIncomes`/`incomeBasis`, `briefConflicts`, `briefAsks`,
  `pickOverlap`, `picksLost`). Stages: picking (my list, teammates' lists, overlap, shared bonuses), turn 1 (the
  picks my kept list lost, `readAward` computed without writing), each turn (incomes and basis, deploys and
  attacks, asks, offers = `team.support`, cards, conflicts; `conflicts.read: null` = no teammate orders read; a
  `bonus` conflict is their attack into a bonus my plan completes, or captures into a direct member of: `completes`).
  `warapp_join_game` takes `team`: refused outside a team game, with random teams, or when full or not offered;
  it is the int32 AcceptOpenSeat already sends (the client's team picker passes the chosen team: bundle, UNVERIFIED
  live). The preview lists that team's seats by in-game id, human or AI (`GameInfoPlayer` field 4 is IsAI).
- **The agreement ledger (part A2 of `docs/PLAN-TEAMS.md`).** An agreement (a truce) exists only when
  recorded with `warapp_record_agreement` (structured terms; chat is never parsed into one), at
  `<dataDir>/relations/<gameId>-<playerId>.json` (`src/relations-store.ts`: one file per account, ids,
  turns and statuses only, 0600, atomic; registered hosted too, on the per-user data dir). The model is pure in
  `src/analysis/relations.ts`: the status table (terminal: ended, broken-by-them / -by-me), the state on a
  turn (over when the partner is out or turned AI, two players remain, or its turn / player / notice end
  came), `breachWatch` over consecutive cached boards from the turn agreed (visibility as `observeDeploy`:
  a fog reveal is no event; an attack is read only with my cached orders and only when the partner alone,
  visibly, borders the territory, and no transfer of mine in came from a source taken or hit; anything the
  fog leaves open is `massing`, never `broken`; massing reach is plain graph distance 2, not
  `twoStepReaches`, which asks what a stack could take and hold, not where armies stand), `tacitTruces` (3 quiet turns, reported only), the endgame
  (no other opponent ≥ 0.5 × the larger income) and `trust`. Refused: me, an AI, a player out, a
  teammate, a 1v1, two left, and no third player or team outside me, my team and the partner's; an
  `until_turn` before this turn. Massing needs its growing pairs to end at the newest board. The ledger's `usage`
  logs per planned turn (not a what-if plan) the armies each honoured truce freed and what a break would cost (T6: `lossIfBroken` armies, `incomeLostIfBroken`).
  Its `intel` (#386, `warapp_record_intel`, not confirm-gated; pure part `src/analysis/intel.ts`) keeps avoid territories
  (`promisedTo`), avoid players (a reason code from `AVOID_REASONS`, never free text) and stated incomes with their turn;
  `warapp_plan_turn` and `warapp_check_plan` apply it by default (`resolveIntel`, reported as `intel`): an explicit
  `avoid_territories` / `avoid_players` / `known_income` replaces the stored list of its kind for that call (`[]` included), and
  an income more than `INCOME_STALE_TURNS` (3) turns old is not applied (a warning). Its read-modify-write runs
  under an in-process per-path lock (`src/path-lock.ts`; another process sharing the data dir is not
  covered). **The cross-game player record** (owner decision D5 of 2026-11-14: on, local AND hosted —
  registered and enabled on a hosted child, in its per-user data dir) is `src/player-record-store.ts` at
  `<dataDir>/relations/players.json` (version 3; versions 1 and 2 read loosely): per player, keyed by an
  HMAC of the GameFeed id under the salt `relations/players.salt` (made only on the write path; a salt
  file that exists but is malformed is never regenerated, and a `players.json` that exists but does not
  parse — bad JSON, not an object — is never overwritten or moved aside: the write reports `failed`, reads
  `unreadable`), name-free entries per agreement (its key an HMAC of my account, game and agreement —
  entries keyed by game and agreement alone before that are read as they are and updated in place: format, turns
  agreed and ended, terms shape, outcome with notice honoured or not, break turn and strongest flag, the
  context at the break from the cached boards — endgame, leader, outgrowing — retaliated, proposed
  again) and tallies (`src/analysis/player-record.ts`: `recordDelta` moves each once, on the transition
  that earns it, so they never double-count and outlive entries dropped past the bound; 30 entries per
  player, 300 players). `warapp_record_agreement` updates it inside the ledger's lock (its own lock, a
  different path), so entries land in the order the ledger changed; `warapp_submit_turn`'s `break_agreement`
  goes through the same path (`recordBrokenByMe` / `updateAgreementRecord`, `src/tools/relations.ts`). `WARAPP_PLAYER_RECORD=off` switches it off. The tools report `playerRecord`
  (`warapp_record_agreement`: `updated` / `off` / `failed`; `warapp_get_relations`: `on` / `off` /
  `unreadable`).
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
  does not undo it, and says so (`agreementsStillBroken`, the agreements broken-by-me on that turn). Not yet: writing `broken-by-them` to the
  ledger itself (the plan's T8 warning says to record it with `warapp_record_agreement` before submitting).
- **Deals outside the ledger (#375): `avoid_territories` / `avoid_players`** on `warapp_plan_turn` and
  `warapp_check_plan`, for this call only (`PlanOptions.avoid`). The planner treats each like a truce's covered
  territory for T1 (`truceOf` wraps `noTarget`; `Truce.avoided` names it in the "Not attacking" line), a neutral
  included, in any format; holds are not relaxed (T2 does not apply). check_plan warns when the orders attack one.
  #441: an avoided player's neutrals go too (`skirtedNeutrals`, wrapped into `noTarget` in the estimates phase): a
  neutral whose only enemy neighbour is that player, or in a bonus it visibly holds over half of, unless it completes
  a bonus of mine or its minimal capture's survivors alone would hold against the stacks beside it plus the owner's
  deploy; a "Not taking … (#441)" line per one beside my land. No avoided player: golden unchanged.
  #457: a truce partner's neutrals go the same way while an agreement (not only a card) with it is active or in
  notice, in any format it binds (`Truce.keptWith`, passed to `skirtedNeutrals` as `truce`; the partner counts as an
  enemy neighbour even when a card makes it no foe): skipped unless the capture completes a bonus of mine — holding
  next turn is no exemption, since to the partner it reads as a breach either way (`Skirt.truce`) — with a "Not
  taking … (#457)" line saying to raise it with the partner. A neutral the final orders do take beside a partner's
  land gets a warning that it "may read as a breach to player P" (`warnTruceNeutrals`, after `finishPlan`). No
  relations in the golden corpus: all 6253 plans (2000 synthetic + every suite input) byte-identical.
- **Pricing a deal (B3): `warapp_advise_diplomacy`, read-only, free-for-alls only** (docs/PLAN-TEAMS.md
  section 8 B3). `priceTruce` (`src/analysis/relations.ts`, pure) diffs two plans on the exact input
  `warapp_plan_turn` builds (`livePlanSetup`, `src/tools/turn.ts`, shared): without the truce and with it (the
  planner called, never changed). The hypothetical truce replaces any recorded one with that player but keeps
  its board reading (state — `broken` with the breach — trust, watch flags): a recorded truce is priced on the
  plan `warapp_plan_turn` makes, and a broken or flagged one is `no` (`relation` in the entry), as is one I
  already gave notice on (`noticeBy: 'me'`: withdraw the notice or propose new terms). The
  no-deal plan never holds it: a shared `without` is reused only for a partner with no relation in the input
  (`priceTruce` ignores one given otherwise). It writes nothing: no board cache, and `livePlanSetup` is called
  with `award: false` (the award shapes only a two-player plan; reading it on turn 1 writes it). The host's
  description key is UNVERIFIED, shown through `untrustedText`.
- **A message promises only what the plan does (B4, `src/analysis/commitments.ts`, pure; `src/tools/commitments.ts`).**
  `warapp_send_chat` takes `commitments` (no-attack, will-attack, notice, propose, accept), declared — the text is
  never parsed — and its plan step checks each against this turn's orders (`livePlanSetup` with `award: false` and the teams as resolved — unknown, no #275 tripwire, as in warapp_plan_turn —,
  then `planTurn`; the orders this server submitted this turn, `readCachedOrders`, stand in when there are any)
  and the ledger (`agreementChange`: the same rule `recordCommitments` re-applies after the send). One not
  carried refuses the send. A notice's `ends_turn` must be the turn the agreed notice gives (0 turns of notice:
  this turn — the truce ends with the message and this turn's attacks are free); an accept compares only
  the terms it restates; a truce whose `until_turn` is past is refused; an attack on a territory a promise names
  whose owner is fogged conflicts (scope `all`: named as unchecked). A propose/accept/notice whose partner does
  not read the message (`audience`: private to another player, or the team channel with the partner off the team)
  is refused (D3: no truce changes unseen); a no-attack/will-attack binds no agreement and may go to anyone. The
  preview's `checkedAgainst` names the default plan (no goal, focus, reserve, first mover or award). The submitted orders are `MyOrders.sent`
  (every move, Transfer Only flagged), not `moves`. With commitments the game is read with its map and the turn must be in play. Once
  the message is `confirmed` or `accepted` (war.app took it; `unconfirmed`/`unknown` record nothing and say so)
  they go into the ledger's `commitments` as mine (ids and turns only, at most 200), a propose/accept/notice
  through warapp_record_agreement's path (player record included). `warapp_submit_turn` warns (never refuses)
  via `commitmentWarnings`: an attack a no-attack still covers or an open proposal of mine covers (scope `all`:
  an attack into the fog, `unchecked`), and a will-attack for this turn the orders leave out; `warapp_plan_turn`
  gives the same warnings for its plan (the planner never reads commitments). A will-attack is only for the current turn.
- **A pending surrender is read from the game details (#317, `src/surrender-pending.ts`, UNVERIFIED live).**
  GameFeed keeps a player who asked to surrender `Playing`, and GetMyGames / LatestGameInfo carry nothing:
  only GameRefresh (40) asked with `nonChat` does — `GameDetailsAndChat` → `GameWL` (14 fields, players at 7) →
  `GamePlayer` (37 fields since 243; the reader's link back to the game, set first, is dropped before counting).
  `pendingSurrenders` gives `{ inGameId, player (GameFeed id or null), owedByMe }`, owed by the client's own
  test (their seat `Playing` + `Surrendered`, mine `Playing`, not AI or turned AI, my id not in their
  `PlayersAcceptedMySurrender`); my own surrender is left out. `src/tools/surrender-pending.ts` reads it only
  for a game being played or picked with my seat playing; unreadable, not read (past the bound) or my seat unknown
  is `null`, never `[]`; every other game (a lobby, a finished game, a game my seat is out of) is `[]` without a
  read (#327: none can wait on me there, and nothing failed to read).
  Reported by `warapp_my_games` (per game, `player` null — the list has no GameFeed ids — and a top-level count;
  at most `MAX_SURRENDER_READS` games, brief reads none), `warapp_wait_for_turn` (status `surrender_pending`
  unless `ignore_surrenders`; after one failed details read — a frozen tab stalls each until the bridge times
  out, and the rpc layer has no per-call timeout — it stops asking for the rest of that wait and says why once in
  `surrenderUnread`, with `FROZEN_TAB_HINT`) and `warapp_plan_turn` (`surrenderPending`, the first warning when
  owed). Each read costs one GameRefresh; nothing is cached (a surrender can come any moment). A GameFeed id and
  an in-game id are never one field: results carry `player` (GameFeed id or `null`) beside `inGameId`, and the
  in-game id of a GameFeed player comes from one helper, `inGameOf` (`src/live.ts`).
- **Accepting another player's surrender is `AcceptSurrender` (69) via `warapp_accept_surrender`, confirm-gated**
  (#317; encoder read from the bundle's writer, golden-pinned, UNVERIFIED live). `player` names the surrendering
  player (optional with one pending). The plan reads the game details and refuses a finished game, a lobby, a game
  I am not playing, an instant-surrender game, unreadable details, no surrender pending from that player, and my
  acceptance not owed (already given, or my seat cannot accept). The preview (`src/analysis/accept-surrender.ts`,
  pure): whose `seat` (`player`, `inGameId`, name through `untrustedText`), `landBecomes` (`AI` / `neutral` /
  `null`, from `SurrenderedPlayersTurnIntoAIs`, not for a seat already an AI), `land` (from the live board, else
  `null`: its territories in view and `borderedBy`, each neighbour by how many of ITS territories border that land;
  #417: `hiddenLand` — 0 when the board hides no territory, else `null`, said plainly in `hiddenLine` and the advice:
  the standing carries no per-player territory count, so its land behind the fog is unknown — and `hiddenOnBoard`,
  the map's territories the board does not show, the bound),
  `othersStillToAccept` (`{ player, inGameId }` each) / `goesThroughNow`, `winsGame` (no seat off my side left, a seat handed to an AI counting as
  one unless the AIs give up when one human remains; `null` when it hangs on an unread setting or teams I could not
  read) and one `advice` line: the win, or in a free-for-all the neighbour with the most bordering territories, citing
  `ffa-surrender-veto`. The outcome is read back from GameFeed (the seat `SurrenderAccepted`, handed to an AI, or
  the game over → `accepted`) and the game details (my id among those that accepted → `pending`, others still owe
  theirs; both `confirmed`); else `unconfirmed`, and no answer is `unknown`. Never resent.
- **Surrender is `Surrender` (68) via `warapp_surrender`, confirm-gated** (`undo` takes back a
  pending one). It refuses finished games and games the account is not playing, and reads the
  outcome from GameFeed (`surrendered` / `pending` — the others' acceptance is needed when the game's
  `InstantSurrender` says so, and MAY be needed with more than two players when it is unread (#228) — /
  `still_playing` after an undo — GameFeed has no pending state — / `unchanged`; lobbies refused), never from the reply, which has no result.
- **A speed first turn hides the board until Begin.** With MoveOrder `NoLuckCycle` war.app sends
  no standing on turn 1 (or while picking) until the player presses Begin, which starts their
  turn timer; the live tools say so instead of the lobby error. `warapp_begin_turn` sends
  `BeginFirstTurn` (80, confirm-gated, encoding read from the bundle — not verified live) and
  reports `begun` only once the board reads back.
- **Withdrawing committed orders is `UnCommit` (82) via `warapp_uncommit_turn`, confirm-gated.** Its
  parameters (only the int32 game id after the auth block) are read from the bundle's writer and
  golden-pinned, NOT yet verified live. It refuses outside a turn phase and when `hasCommittedOrders`
  is false, and reads the outcome from GameFeed (`uncommitted` / `unconfirmed`); a transport failure
  is `unknown`, never retried. `warapp_submit_turn`'s "already committed" refusal points to it.
- **Leaving a lobby is `DeclineGame` (65) via `warapp_leave_game`, confirm-gated** (#217): the lobby's
  Decline button, also how a seated player leaves a game still `WaitingForPlayers`. Its parameters
  (the int32 game id, then a "mod hooks the decline" bool sent false) are read from the bundle's writer
  and golden-pinned; **verified live 2026-11-14** for a seat taken through an open seat (an invited
  seat and a hosted bridge run are not yet checked). It refuses a started game (surrender instead), a seat the
  account does not hold, and mod games; reports `left` only once GameFeed (else a `GetMyGames` entry)
  shows the seat given up — never from the reply, whose bool means "your chat was removed"; a transport
  failure is `unknown`, never retried. 17, 4 and 7 are read back from game state (the client swallows
  them); 191 (your own open game) and 88 are refusals. After a leave GameFeed refuses the game ("This API
  can only be used for games you are in…"), which confirms it.
- **A coalition before a surrender (#445, 2026-11-21; advice only).** `coalitionAdvice` (`src/analysis/coalition.ts`, pure): in a free-for-all of three or more where the #436 surrender line is crossed and I am not the leader, `warapp_plan_turn` reports `coalition` — viable when the trailing players (me included) together earn at least the leader's estimate, with the candidate partners (those bordering the leader first, then by income), `graceTurns` (`COALITION_GRACE_TURNS`, 2; the planner and tool do not count it), `outreach` (owner decision 2026-11-22: the best partner, plus every other candidate whose income is within `OUTREACH_CLOSE_RATIO` (0.9) of its) and an honest figure-free `draft` — and leads its warnings with "Try a coalition first" when viable. Never sent: the draft is for `warapp_send_chat` (D1/D2 gates apply). A player the cross-game record shows broke a truce with me (`tallies.brokenByThem` above 0, any game) is never a partner (owner decision 2026-11-22): `warapp_plan_turn` reads the record for the candidates and passes them as `breakers`; they are in `leftOut` with reason `broke-a-truce`, and the record off, unreadable or empty leaves nobody out.
- **The joining policy is a refusal (#423, 2026-11-21; extended 2026-11-22).** `warapp_join_game` refuses a lobby whose `joiningPolicy` breaks (`policyBreaks` in `src/open-games.ts`: Commerce, mods, custom scenarios, costly neutrals, over four seats, a boot under 12 hours, lotteries, the handicap rules Local Deployment, Commanders, No-Split, an army cap, Multi-Attack, non-default kill rates, and — owner decisions of 2026-11-22, `JoinAccount` — `attended-games`: `ATTENDED_GAMES_LIMIT` (15) or more games being played or picked with my seat playing, from `GetMyGames` (`attendedGames`; lobbies and finished games not counted), and `negative-bonus`: the lobby's map, read with the lobby's GameFeed settings, has a bonus under 0 after the game's overrides) unless `override_policy: true`, which the preview records as `policyOverridden`. A check whose input could not be read is `unchecked` (the verdict `null`), never passed; the list tool passes no account, so those two are not evaluated there. The preview also carries `attendedGames` and `mapRecord` (games and outcomes of my finished games on the map, reported only). Owner decisions of 2026-11-22 for the rest of #423: a tournament game is a warning, never a refusal; a game from a template already running is allowed, with no preference for or against it, and no per-template limit, so nothing is built for templates. The tournament IS in the open-games record: GameInfo field 25 is a `warlight.shared.GameInfoTournament` (3 fields: a coin structure, a number, the tournament id), absent on other games — verified live 2026-11-22 through `GetMyGames`, which decodes the same GameInfo: my two tournament games carried ids 66805 and 66801, each listed by `/API/GameIDFeed?TournamentID=`, and 54 other games held none. `readOpenGame` reads it as `OpenGame.tournamentId`; `policyWarnings` (never a break, never a `PolicyCheck`) gives `JoinPolicy.warnings`, which the join preview's `policy` and the list tool's `policyWarnings` carry. GameFeed has no such field, and the lobby page's HTML carries none either (the client renders its Settings tab; `GetLatestGameInfo` is refused for a lobby I am not in). `TemplateIDUsed` and `TournamentID` exist on the client's mod-API GameSettings proxy, not on any record this server reads.

- **A lottery is read from the data, never the name** (#217, `lotteryOf` in `src/open-games.ts`): a
  map of at most `LOTTERY_MAX_TERRITORIES` (4) territories is one; base income 0 with overridden
  bonuses and the map size unread is a likely one (`lottery: null`, a policy break
  too). The open-games record carries no map size, so `markLotteries` asks GameFeed (map included)
  only for lobbies with that settings shape, at most `LOTTERY_LOOKUPS` (5) per call, else uses a
  cached map. A lottery breaks the joining policy.
- **Open games come from the `/MultiPlayer/OpenGames` page payload (`AllOpenGamesData`), not a `/Services` call; joining is `AcceptOpenSeat` (62) via `warapp_join_game`, confirm-gated** and reported `joined` only once GameFeed or `GetMyGames` shows the account seated (`docs/WEB-PROTOCOL.md` "Open games").
- **Commerce games (#332, `src/commerce.ts` pure, `src/tools/commerce-deploy.ts`; docs/WEB-PROTOCOL.md "Commerce
  games").** GameFeed's `Commerce` object is parsed into `settings.commerceRules` (VERIFIED live on two games) and read
  through `commerceRules`. The deploy is the purchase: `armiesForGold` / `goldForArmies` are the client's price
  functions (multiplier 0: one gold per army; m > 0: batches of m at 1, 2, 3 … gold each), and `commerceDeployOf` —
  one computation for `warapp_plan_turn`'s deploy budget, `warapp_submit_turn`'s deploy check and `warapp_check_plan`'s
  income (through `stressOpponents`) — buys armies with my gold from the live standing (`standingGold`, `src/live.ts`:
  GameStanding's Resources, gold = 1, only my own entry under fog; VERIFIED live), which already carries saved gold and
  any Sanctions (so none is applied on top), else with the modelled income (`source: 'model'`, a warning).
  `warapp_plan_turn` reports `commerce` (gold, armies, cost, gold left, multiplier). The submit allows a smaller deploy
  (the gold carries over; a warning names it) and refuses one the gold cannot pay for (error 597, before sending) —
  only when the gold was read from the board (`submitCommerceCheck`, `src/tools/commerce-deploy.ts`): the model's figure
  leaves out saved gold, so then a different total is a warning (an `incomeUncertain` reason), as before #332;
  593/596/597/599–602 have messages. A territory's cities (`TerritoryStanding`'s structures dict, `"1"` = City) ride on
  `LiveTerritory.cities` / `TerritoryState.cities` (absent at 0) and pay `CityIncome` gold each (`cityGold` in
  `incomeDetail` / `visibleIncomeFor`). With multiplier > 0 an opponent's estimate read off the board (`visible`,
  `exact`) is converted to the armies its gold buys (`applyArmyPrice`, after Sanctions; `PlannerSettings.
  armyCostMultiplier`, set only above 0); observed, tracked and prior figures are already armies. Every plain game is
  byte-identical (golden corpus). **Cities:** `warapp_submit_turn` takes `cities` (`cityPurchaseOf`: a game that
  allows them (602), my territories (600), merged per territory, priced by `cityPurchaseCost` — the client's formula,
  the global increase counting every city I own — and paid from the same gold before the deploys: refused (597)
  only on gold read from the board, a warning on the income model's, as the deploys are); it sends
  `GameOrderPurchase` (tag 24, phase 0, `writePurchaseOrder`, golden-pinned from the bundle writer, UNVERIFIED live:
  the preview says so). `warapp_plan_turn`'s `commerce.cityAdvice` (`cityAdvice`, advice only, never an order) names
  my cheapest territory with no neighbour I do not hold, its cost and `paysBackInTurns` (`worthIt` within
  `PAYBACK_TURNS`). Still not modelled, and said by `commerceWarning` only when it applies: unread gold, a rising
  price in the plan's own values and payback (priced one gold per army), and cities in the plan's own orders.
- **Turn submission (`warapp_submit_turn`) sends `SendOrders`** (card plays, then deploys, then moves;
  encoders in `src/protocol/methods.ts` are golden-pinned to a live commit), turn number =
  GameFeed `numberOfTurns` + 1 — every tool reports this as `turn` (`currentTurn()`); the
  completed count is `turnsCompleted` (#130). It always acts as the signed-in account (refuses any other
  `player`, and refuses when that account cannot be determined), validates on the live board
  (own deploys and sources — under Multi-Attack a move, never a deploy, may also go from a territory an
  earlier move in the list enters; each move out counts the armies moved in earlier in the list, an upper
  bound; without Multi-Attack an army moved in earlier may stand guard, so its source sends all its own with a preview warning, #292,
  unverified live; an attack-only move into my own territory or a transfer-only one into a territory not mine
  arrives nowhere (no guard, no move on, no chain) — adjacent moves, armies ≤ armies + deployed − 1, deploys = planner income —
  the server's error 11 otherwise; only a preview warning when `incomeUncertainties` names a
  setting the income model does not compute or does not verify in full (the army cap: war.app pays
  min(income, round(cap × income) − my armies on the board), the cap on this turn's income, verified by six
  live cases on 2026-11-15 — received 41, 49, 25, 27 and 71 where it bit, the binding case through
  `warapp_submit_turn` among them, and a 61 room it did not bind — `incomeDetail`, #253; an unreadable army count of mine leaves it uncut, and plan
  and submit preview both say so; card armies are
  outside it; plan, submit and `warapp_check_plan` deploy on the cut figure, `warapp_plan_turn` reports `incomeCapped`;
  the fog prior, the standing and check_plan's leader test read my income before the cut, the truces'
  trust reads the cut figure on purpose (what I can deploy this turn), and another
  player's income is never cut: its fogged armies are unknown; under Local Deployment a cut makes the
  pool split a guess, `armyCapPoolsUncertainty`: the plan warns and the pool check only warns); after an error 11 the caller passes
  the game's own number as `income`, which replaces the model for the check), and refuses outside a turn phase or when my
  `hasCommittedOrders` is already true (a second `SendOrders` replacing the first is
  unverified; the client uses "Modify orders" = `UnCommit`, which `warapp_uncommit_turn` sends). **Success is read from game state, never
  from the reply:** its bool is the "vacation ended" flag. After sending, GameFeed is re-read:
  `numberOfTurns` advanced → `resolved`; my `hasCommittedOrders` true → `committed`; neither,
  or a transport failure after sending → `unknown` (never suggest resending blindly).
  A move's options (#165: `mode` transfer-only/attack-only, `percent`, `commander`,
  `attack_teammates`, checked in `src/tools/order-options.ts`) are each refused unless the game
  allows it (`AllowTransferOnly`, `AllowAttackOnly`, `AllowPercentageAttacks`, `Commanders`, a
  teammate); their encoding follows the client bundle, golden-pinned but UNVERIFIED live.
  The optional `override_reason` (≤ 500 chars, names scrubbed) and `override_by` (`'hand' | 'agent'`) change nothing
  sent: after a confirmed send they go into the decision log (#412, below) beside the turn's plan, only when the
  orders differ from it.
- **Special units (`src/live.ts`, #61).** An `Armies` record ends with its special units
  (Commander, Boss1–4, CustomSpecialUnit), each dispatched on a byte tag; every unit class
  ends with the shared fields GUID, owner (in-game id), so the owner is the LAST field and the
  kind comes from the registered class name. Fogged territories report no units.
  `BoardState.specialUnits` keys owners by GameFeed id like territory owners.
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
- **Cards (`src/cards.ts`).** The hand is read from the live board (`LatestGameInfo` standing →
  my in-game id → GUID → card instance, by bundle type name); the card **type is `Gb`, the LAST
  integer field** (the base reader sets it last) and a Reinforcement card's armies are `tc`, the
  first integer (its subclass prepends it) — reading the type from the first integer mislabels a
  Reinforcement whose armies equal another type id; the rules from GameFeed settings
  (`MaxCardsHold`, `ReinforcementCard.FixedArmies`; a card set to `'none'` is not in play).
  Holding **more** whole cards than `MaxCardsHold` (not equal — live: 4/4 accepted, 5/4 refused;
  the bundle's check is `remaining > MaxCardsHold` after removing every played and discarded
  card) war.app refuses a `SendOrders` (**error 51 `MustUseCard`**), so `cardsToShed` cards must
  be played or discarded and `warapp_submit_turn` refuses up front. The planner always plays
  Reinforcement (its armies join the income); when cards must go, the lowest-value cards in the game leave
  first (`keepValue`, #163: the information cards first, the timing cards — Order Delay, Order Priority,
  Emergency Blockade, Bomb, Airlift — last). An Order Priority that must go is played, not discarded, one
  at most (#127); an Order Delay that must go is played where the schedule advises it
  (`cards.advice.orderDelay`, `insteadOfDiscard`) rather than discarded, and is discarded only when the
  plan has no attack for it to delay. `chooseCardPlays` itself never plays
  Blockade (it gives a territory away) or Order Delay (where it goes is the schedule's call). A discard (`GameOrderDiscard`) is tag 9, the GUID, the
  base — from the bundle's writer, not yet live-verified. Card plays must come in war.app's
  turn-phase order or the server answers **error 10 `OrdersInIncorrectOrder`**, so
  `writeSendOrdersParams` sorts every order by `TurnPhase` (discards 10, Order Priority 12,
  Reinforcement 20, deploys 25, moves 50, Order Delay 50, Blockade 60). Order Delay (tag 11) runs
  in phase 50, verified live 2026-11-12 (sent in phase 12 it drew error 10). Within a phase,
  card plays are written after the other orders (an Order Delay after every move, the
  live-verified shape), unless an Order Delay names `before` (`beforeMove`, #186): then it is
  written among the moves, which war.app accepted live 2026-11-13; whether the later moves then
  wait for the opponent's is unverified (docs/WEB-PROTOCOL.md). Order Delay may be combined with
  other card plays.
  Play-card encoders are golden-pinned; a GUID is written as its 16 bytes in .NET order.
  The Blockade play (tag 18, phase 60; card by name, target territory by id) was verified live 2026-11-16: the
  territory turned neutral at the end of the turn at its armies × the game's multiplier. Order Priority (card by
  name, no target) committed and resolved live 2026-11-16, but whether my first move ran first cannot be told from
  the result: that effect stays unverified.
  **The targeted cards (PLAN-TEAMS part D, V9):** Spy, Reconnaissance, Surveillance
  (phase 15), Airlift (43), Gift (47), Diplomacy (75), Sanctions (80), tags and fields from each
  `GameOrderPlayCard<X>` writer (docs/WEB-PROTOCOL.md). The Airlift play (card by name, `from`, `to`, `armies`) was
  verified live 2026-11-16 (the source lost the armies, the target gained them, the card left the hand), and the
  Diplomacy play (card by name, `players`) verified live 2026-11-18 (played through `warapp_submit_turn`, in force on
  later boards until the turn expected, #369); every other targeted card is UNVERIFIED live (Sanctions was played
  once 2026-11-18, its effect not yet checked). `TARGETED_CARD_PLAYS` (`src/protocol/methods.ts`) is the set whose
  targets are resolved; `UNVERIFIED_CARD_PLAYS` (the preview's encoding warning and the result's `cardPlayCheck`) is
  it without Airlift (#296), Diplomacy (#369) and Reconnaissance (#443: accepted live 2026-11-20 — a turn with the play committed with no error, then withdrawn, so the reveal itself is not yet seen; an advised Reconnaissance now goes into `warapp_plan_turn`'s `orders`, #434). `warapp_submit_turn` takes their targets
  (`src/tools/card-plays.ts`) and refuses what the bundle's `GameValidateOrders` refuses (a commander
  never gifted or airlifted to a teammate; no Spy on me or a teammate, nor on the neutral — target 0 — unless
  the game's `SpyCard.CanSpyOnNeutral`; no Diplomacy between teammates, nor naming a player out — the
  validator checks both named players for 381) plus Sanctions on my own side (an opponent instead when the
  percentage is negative); an Airlift of the commander alone sends 0 armies (the validator does not check
  the count); what an Airlift sends leaves its source's later moves (armies it lands cannot move that
  turn); a Gift to an opponent gets its own preview line naming the recipient by id as an opponent. **Bomb** (tag 20, phase 30,
  `GameOrderPlayCardBomb`) and **Emergency Blockade** (tag 8, phase 37, `GameOrderPlayCardAbandon`) each write one
  int32 territory, UNVERIFIED live too: a Bomb is refused on my own or a teammate's territory (526) or one next to
  none of mine (527); an Emergency Blockade on a territory not mine (95), twice on one (96), on my commander's
  (ours), or under an Airlift that runs after it; the preview warns when it breaks a bonus I hold or strands
  moves. The preview warns the encoding is unverified and the result
  carries `cardPlayCheck`. The planner never plays them; `warapp_plan_turn`'s `cards.advice` (D2,
  `src/analysis/card-support.ts`, pure) says where they pay, each with an `order`, never added to the
  orders: Diplomacy on the opponent whose stacks tie down the most of my border armies (#424: the only one in
  contact too, unless no other opponent is still playing — a 1v1 says nothing; a truce partner the truce
  already covers is passed over unless the truce is in notice or leaves a border it presses uncovered; one a
  Diplomacy card in force covers is passed over, unless this is that card's last turn: then it is chained
  first, `chain: true`, and the in-effect warning says it is the last turn and to chain or ready the borders — in a 1v1 only to ready them,
  `diplomacyOpponents` gating both), a Bomb (`bombAdvice`, `src/analysis/card-threats.ts`) never on a territory
  of a player at peace with me (#452: a Diplomacy card in force — decoded, or the plan's T9 set — or a binding
  truce; the hold-the-card line names them as passed over), Sanctions
  on the strongest opponent (the FFA ranking, else visible armies + 3 × visible income; on me when the
  percentage is negative), an Airlift onto a border of mine or a teammate's that falls without it (#434: else
  `redeploy` — an idle stack, only my land beside it and unused by the plan, two or more steps from the target, or one
  cut off from my main holdings, with more than `REDEPLOY_MIN_ARMIES` (3) to spare, to the strike stack, else the
  thinnest border), a
  Gift of the members that complete a teammate's nearer bonus, and (#434, `blockadeOffer` in `card-threats.ts`) a
  Blockade (`cards.advice.blockade`) on a border the plan concedes that is the one way into held bonuses or my commander
  (`opensBehind`, #291), when its armies after the plan × `BlockadeCard.MultiplyAmount` stop the stack beside it —
  never on a member of a bonus I hold (it breaks the bonus) or my commander's territory. **The spy cards (G2, `intelAdvice`)** only
  where the fog hides what the plan needs, never with fog off: Spy on an opponent out of view (else the
  owner shown beside my most hidden stacks), Surveillance on a bonus I hold half or more of with a fogged
  member (else the most valuable with a hidden border of mine), Reconnaissance on the hidden territory
  beside the most of mine, else (#443) on the hidden territory behind the opponent in contact whose stacks
  tie down the most of my border armies (`pressures`), a distribution-mode start first when the map carries
  the mode's territories. #434: an advised spy card whose kind is not in `UNVERIFIED_CARD_PLAYS` is flagged
  `inOrders` and warapp_plan_turn puts its play into `orders` (`intelOrders`); all three are still in the set, so
  none is today — verifying one live is removing it from that set. **A team hand's cards carry `owner`**
  (the in-game id read under, mine when under me at all; V8 verified, #310): the planner plays, discards and
  advises only my own, says how many must go from the teammates', and `warapp_submit_turn` warns on a
  teammate's card. An Order Delay that must leave the hand is played where the schedule advises it, not
  discarded.
  **The cards in effect (D3, UNVERIFIED live: `readActiveCards` is not yet checked on a live board).**
  `src/analysis/cards-in-effect.ts` (pure) keeps a decoded ActiveCard only when sure: turn known, the card
  in play with a `Duration`, its `untilTurn` after this turn and at most Duration turns ahead (the
  bundle's ActiveCard: ExpiresAfterTurn = Duration + turn number + 1, worn off at the end of the turn
  that reaches it), every named player a distinct player still playing. A Diplomacy between me and an
  opponent (never a teammate) is T9: `planRelationsFrom`'s `diplomacy` marks a ledger truce with it
  enforced, else adds a relation `card: 'Diplomacy'` covering everything; an enforced relation binds in
  any format, its player is no foe this turn, and when the card is gone by next turn (`lookAheadFoes`) still
  counts for every next-turn judgement: the two-step hold (#172), the frontier's hold cost (rule 4d) and a
  completion's defensibility (R3) — `nextTurnAt` in `plan/threats.ts` (G2). `warapp_check_plan` keeps the
  player among the opponents, so `exposedNextTurn` counts it anyway. Sanctions on me cut `warapp_plan_turn`'s income by the bundle's
  rule (per card, round((1 − Percentage) × income), .5 up, cap 10000; not under Local Deployment, which
  warns). Sanctions on others (G2) show in `cardsInEffect.sanctionsOnOthers` and cut that opponent's
  estimate when it is read off the board (`visible`/`exact`; `applySanctions` in `plan/estimates.ts`); an
  observed, tracked or prior figure stays whole with a warning (it may already carry the cut). The
  `SanctionsCard.Percentage` scale (a fraction) is UNVERIFIED for GameFeed. The Sanctions advice passes
  over a truce partner and a player a Diplomacy card keeps at peace with me, saying why. Anything not sure is
  a warning and changes nothing; the plan reports `cardsInEffect` (`verified: false`), and
  `warapp_check_plan` counts a card as a truce (`safeIfTruceHolds`; `safe` still tries its player).
  With no active card every plan is unchanged (golden).
- **Turn notifications are a socket.io v0.9 client with two transports.** While the active
  transport is the direct leg, a **WebSocket** (`src/push/websocket.ts`): handshake GET with the
  `AuthToken` cookie (host-locked to war.app), then `wss://war.app/socket.io/1/websocket/<sid>`
  with the same `Cookie` header. Otherwise — and as the fallback when the WebSocket cannot come up
  (no session, signed out, no `websocket` transport, failed upgrade) — **xhr-polling over the
  bridge** (`src/push/socketio.ts`): the first poll must return the connect packet `1::` before
  any POST (a POST first is HTTP 400). Both answer `2::` heartbeats and send `Subscribe`
  (method 242, no auth block) to `Game.<id>`. A push is method 245 `GameUpdated` carrying the game
  id and its chat flags (no text), so `warapp_wait_for_turn` re-reads GameFeed after one (debounced per game, below). **A reconnect loses the
  pushes sent during the gap** (war.app has closed a healthy socket after ~60 s): close, error
  or a missed heartbeat reconnects (new handshake, new sid, re-subscribe) and `onReconnect`
  fires, on which `warapp_wait_for_turn` re-reads every watched game — as it does when a failed
  `Subscribe` goes through on a retry (`onConnect` with `resubscribed: true`). A wait checks every
  game (membership included) before it watches any, so a game not mine is never subscribed; a
  released game is unwatched (not re-subscribed on a reconnect); at most `MAX_WATCHED_GAMES` games
  are watched at once; and GameFeed re-reads are debounced per game (one in flight, one queued).
  A wait that starts the socket reads each game twice up front (its check, then the re-read on
  the first connect): accepted, since skipping it could miss a turn. A push for a game no wait
  watches is not recorded. Two waits on one game: the second's `watch` waits for a Subscribe the
  first has in flight, or sees (`mark`) one that went through after it began reading, and
  re-reads. When the Subscribe retries on a session run out (five), the listener starts a new
  session itself. An instant `2::` heartbeat reply is paced like an empty poll.
  The push transport shows
  in `warapp_session_status` (`pushTransport`) and the push tools. One listener per process
  (`src/push/listener.ts`), started lazily: many processes sharing the bridge port collide.
  Tests drive a scripted fake bridge and a fake WebSocket, never a real socket.
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
- **No-loss neutral captures (#426, DRAFT: owner decisions of 2026-11-22, awaiting merge).** A neutral in view whose
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
- **#433/#427 (partial, 2026-11-20).** Local Deployment's free income floors at the game's own base income (`gameBase` in `plan/threats.ts`), not 5; the profile's standing reads my income without my own Reinforcement card (`plan/estimates.ts`), as it already did opponents'. Golden: 159 of 2000 synthetic plans and 4 suite plans re-hashed (the rest of #433 and #427 is open).
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
  check_plan passes them through `stressOpponents`. Each observed
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
  and 3 more). **The full-deploy border is revived first** (review fix, `fullConceded` in `plan/leftover.ts`,
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
  in warapp_check_plan's table on the same orders), the
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
  (`incomeRise.proven`); the could-earn cap still applies. Proof may lower one only on a turn with every army
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
  concessions and none more.
  **Where the read is reported (part D, `src/tools/profile-reads.ts`, read-only, never throws):** one computation
  (`readOpponents`) serves `warapp_profile_opponents` and three reports, none of which any plan, price or verdict
  reads (the golden corpus is unchanged): `warapp_plan_turn`'s `reads` (each opponent in contact on the live board
  with a habit at the confidence bar or a label: its labels, those habits with `n` and `basis`, `gamesMet`; full adds
  the counter lines; a what-if plan reports it too and still keeps nothing; absent with profiling off or the teams
  unknown), `warapp_advise_diplomacy`'s per-neighbour `habits` (`retaliate` and `attack`, beside `record`; it keeps no
  turn) and `warapp_scout_player`'s `met` (`metRead`: games met and every habit from the cross-game record alone,
  shrunk toward the all-formats pool; only when the record holds the player).
- **The end-of-game pass (#312 E1; owner decisions P2–P4 of 2026-11-16) runs once per finished game the account
  played** (`src/tools/end-of-game.ts`, never throws): it reads the game's history ONCE (`getGame` with history,
  settings and `map: false`: a cached map is attached by its id, and the client's refresh of a cached map lacking
  land the standing names — which would repeat the request — never runs, and `noRetry` keeps the client from
  re-sending it on a 429 or 5xx, so the POST goes out once; with no map cached, one map-only read without the
  history follows, and when that fails the record is kept `noMap`), never retried, and keeps the
  capture name-free at `<dataDir>/finished/<hmac>.json` (`src/finished-store.ts`: the file name `finishedGameKey`, an
  HMAC of my account and the game under the ONE shared salt; players inside by `playerKey`; no clock; 0600, atomic, at
  most `MAX_FINISHED_RECORDS` (500) by last write or the sweep's refresh, never one the writer protects; a file that does not parse is never overwritten and blocks the pass,
  `record-unreadable`). The file is a processed mark: any status stops every trigger. So is the **lasting mark**
  (`markProcessed`, `<dataDir>/finished/processed.json`: the record keys only, hashed, no id; at most
  `MAX_PROCESSED_KEYS` (5000, ten times the record bound), the least recently marked dropped; atomic, 0600, under
  the path lock; a marks file that does not parse is never overwritten and marks then rest on the records), written
  as soon as a pass's request is spent (a failed request included; not when the reply shows the game still in
  play, which may end later) or it consumes the history a caller read (`warapp_get_game` with `include_history`), so a game whose record the bound pruned is never read again. **The one remaining
  exception:** a game whose record and mark have both aged out (5000 later passes) reads again if a trigger names it. `captured` holds
  (`src/analysis/finished-game.ts`, pure) the outcome from my player state (`won`, `lost`, `surrendered`, `eliminated`,
  `booted`, `ended-by-vote`) with the completed turns, the first history board I held no land (`outTurn`) and the
  winners; my pick list and award (`readPickRecord`); each player's start; per history board (`afterTurn` completed
  turns) each player's income by `boardIncome` (base or per-territory, plus full bonuses; cards and the army cap aside),
  territories, armies and full bonuses; for each target my cached orders attacked and did not take (orders of turn T on
  boards T − 1 and T) what stood there before and after; the history's boards themselves (`boards`: `[territory,
  owner, armies]` rows, the owner an index into `boardOwners` (player keys; any other owner unknown, its raw value
  never kept), a board listing the same territories as the one before kept as its changed rows; at most the first
  `MAX_RECORD_BOARDS_HEAD` (30) and the last `MAX_RECORD_BOARDS_TAIL` (30) boards, `boardsOmitted` counting the rest:
  the calibration harness's truth, #318); the settings shape (`nameFreeSettings`, src/replay.ts) and the
  map id. Every status also keeps the final outlook line this server logged for the game (`outlook`: `finalOutlookOf`,
  src/outlook-log.ts, from `<dataDir>/outlook/<gameId>.json` as me — the newest planned turn, its state, held turns,
  ratio, and `estimated` (the outlook log now marks a turn read on the likely high) / `thin`; no id, none of the basis's
  words; absent when it never planned the game). A failed request is `read-failed` (the error kind only), an unreadable history `history-unreadable` with
  #315's reason, each with the outcome the read that showed it finished gives; neither is retried by a trigger — only
  `warapp_get_game` with `include_history` re-runs a failed pass, from that call's own read (no further request).
  Triggers: `warapp_get_game` (the account: the board cache's, else the signed-in one), `warapp_wait_for_turn`'s read,
  a game-ended in-app notification in `warapp_get_notifications` (see "In-app notifications"), and the `warapp_my_games` sweep over its finished games (my seat held) not yet processed, newest first, at most
  `END_OF_GAME_PER_CALL` (2) per call, each also folding its live profile (`foldFinished`, #273); the records are the
  sweep's cursor (`endOfGame: { processed, pending }`). The sweep looks only at the newest `sweepWindow` (half the
  record bound: 250) finished games, refreshes their records each call and protects them from its own writes' prune,
  so the records kept are the newest games'; the lasting marks keep any game from being read twice (P2). A pass that spent its request but left no record (the write
  failed, or the reply showed the game not finished or not mine) is remembered in-process (`attempted`, bounded), so no
  trigger reads that game's history again in this process (`attempted` status). Only a seat of mine (P3);
  `WARAPP_PLAYER_PROFILE=off` or no data dir: nothing — not even the signed-in account is read (`finishedAccount` checks
  first); `warapp_get_game` asks for the account (an InviteToken page read) at most once per finished game per process
  when it cannot be read (the sweep picks the game up later). Registered hosted like the profile store. Inform only (P1): no planner decision reads it (golden
  unchanged).
  **Processing a captured history (#312 E2, `processHistory` in `src/tools/end-of-game.ts`; pure parts in
  `src/analysis/game-lessons.ts`, stores in `src/lessons-store.ts`)** runs right after a `captured` record is written,
  each part on its own, and reports `processed: { profiles, map, lessons }` (`no-map` without the map; profiles
  `teams-unknown` for a game of 3+ seats whose teams `keptTeams` cannot read, `nothing` when no turn was observed).
  (1) **Part C:** `observeHistory` reads each pair of consecutive history boards N, N + 1 as turn N + 1 with my
  cached orders of that turn (`observeTurn`, while I held land), `habitsOf` per opponent (never me, a teammate or a
  human who became an AI; AI seats pooled), folded with `source: 'history'`, which replaces the live entry; the
  per-game file, when there, is marked `folded: 'history'` (`markHistoryFolded`). `foldGame` never counts a game twice
  (`foldedBefore`: the population holds it, or the per-game file was marked): a player with no entry for the game
  is skipped when its entry list is full (one may have been dropped), and the population when it no longer holds
  the game. (2) **The map's record** `<dataDir>/maps-record/<mapId>.json`: games, outcomes, and per game (at most
  `MAX_MAP_ENTRIES`, 50) the format, seats, result, turns, my start region (territories and every bonus they touch,
  `startRegion`), my income curve (by completed turns, at most 60 points) and income after turns 4 and 8, and each
  winner's start region, income curve (#419, as mine; an entry kept before it gets one from its end-of-game record's
  boards through `warapp_backfill_history`'s `winnerCurves`, `backfillWinnerCurves` in `src/tools/map-curves.ts`, winners
  matched by start territories, no request) and income after turns 4 and 8 (the pace to beat); at most `MAX_MAP_RECORDS` (200) maps
  by last write; `mapRecordSummary` gives the medians. (3) **The lessons** `<dataDir>/lessons.json`: per format the
  games, outcomes, lost games by cause (`lessonLoss`: `howLost` on the history boards — `commander`,
  `last-territories`, `unknown` — or `surrendered`, `booted`, `still-holding`), the turn my income first went flat
  (`flatTurn`: from board 1 on, within `FLAT_TOLERANCE` (10%, at least 1) on each of the next `FLAT_TURNS` (3)
  boards; `flat: { n, sum }`), and the calibration (#294, #318 a): for each turn T I cached a board for,
  `trackOpponents` over my cached boards up to T (every seat as still playing) against the opponent's income on
  history board T − 1, estimate ÷ truth counted by coverage bucket (`none`, `under-25`, `25-50`, `50-75`, `75-up`:
  `n`, `sum`, `sq`, `logSum`, `under` < 0.5, `over` > 1.5) — aggregates only, no turn or player. Each game's entry
  (at most `MAX_LESSON_ENTRIES`, 500) holds its own counts, so processing it again replaces its share; a dropped
  entry's counts stay. Both stores: keyed by `finishedGameKey`, no id, name or clock; 0600, atomic, under the path
  lock; a file that does not parse (or a malformed total) is never overwritten (`failed`).
  **Where they are read (#312 E3, `src/tools/past-games.ts`, read-only, never throws; off with profiling off or no data
  dir; every view carries `PAST_GAMES_NOTE` and none is a planner input — P1, the golden corpus is unchanged — save
  #419's fog pace, `fogPaceFor`, above under thin evidence):**
  `warapp_plan_picks`' `mapRecord` (when the map has a game: games, outcomes, `myStarts` — my results per bonus my start
  touched (`mapRecordStarts`), `inPrimary` when this primary touches it — `winnerStarts`, and `pace.afterTurn4/8`: the
  medians of the winners' and my income; compact lists the first `MAP_RECORD_COMPACT` (8) bonuses; `unreadable` when the
  record does not parse); `warapp_plan_turn`'s `pace` (only when `turnsCompleted` is 4 or 8 and the record has a figure
  there: my income now — card armies out — beside the median winner's and my past median, `behindWinners`; read after
  the plan is made); `warapp_map_stats`' `myGames` (the same view in full, no request; the tool stays opt-in); and
  `warapp_track_opponents` full's `pastGames` (`lessonsSummary`: per format the games, outcomes, how lost, the mean flat
  turn, and the calibration per coverage band — `n`, `mean` and `geoMean` of estimate ÷ truth, `low` < 0.5 and `high` >
  1.5 shares — and every format together; `thisFormat` names the game's). The profile reads name a habit's basis
  `history` (`HabitBasis`) when the past weighs most and at least half of its `n` comes from entries folded from a
  finished history (`ProfileHistory.players[].fromHistory`, the player's `history` entries at their weight, this game's
  left out); the value never changes for it. **#312 item 4 is only partly met:** the calibration from past games is
  reported in `warapp_track_opponents` full (`pastGames`) only; the outlook and the estimate warnings
  (`warapp_plan_turn`'s) do not report it yet.
  **Finished-record and aggregate hygiene (#437 task 4, `docs/PLAN-DECISION-LOG-V2.md`; additive, every `version`
  stays 1, older records and stores read):** each finished record carries `kinds` (`gameKinds` in
  `src/analysis/finished-game.ts`): `lottery` (a map of at most `LOTTERY_MAX_TERRITORIES` territories; without the map,
  the decision log's join context read it as one, or the settings fit the lottery shape), `no-show` (a decision log or
  board cache is kept for the game, no won result, and no turn committed — no cached orders, no logged `sent` — or a
  boot seen while turn 1 or 2 was played, or a boot ending the game within one turn), `legacy` (no decision log and no
  board cache: never a no-show for want of orders), `team`. A lottery or no-show game (`excludedKind`, lottery first)
  is counted apart: `processHistory` writes `recordMapExcluded` / `recordLessonsExcluded` instead (`processed` all
  `excluded`; a game counted before has its share taken back), folds no history profile, and the sweep's live fold
  reports `profileFold: { status: 'nothing', reason: 'excluded' }`. Both stores keep `excluded: { lottery, noShow, keys }`
  (keys with their kind, at most `MAX_EXCLUDED_KEYS`, so a game is counted apart once; a game later counted as a game
  leaves it); `lessonsSummary`, `mapRecordSummary` and the views show `excluded` with `EXCLUDED_NOTE`. Every other
  profile fold skips such a game too, whichever tool reads it first (`foldExclusion` in `src/tools/game-kind.ts`, shared
  with the pass's `kindsOf`: the kinds of the game's finished record when there is one, else read now from the game and
  what this server kept as the cached account — its map's size, the log's `join.lottery`, the orders and seat events;
  with no cached account only the map size or the lottery settings shape): `foldFinished` (warapp_get_game,
  warapp_profile_opponents) answers `{ status: 'nothing', reason: 'excluded' }`, and the file-only folds
  (warapp_wait_for_turn's read, a game-ended notification) go through `foldKeptProfile`, which folds nothing for it.
  `outcome.leftTurn` (`leftTurnOf`): for a surrender or a boot the turn being played when the decision log's events saw
  my seat leave (`my-surrender`, my seat's `surrender-accepted` / `booted`; the earliest), else the history's out turn;
  for an elimination the out turn. It is the lessons' `howLost.turn` for a surrender or boot, and `failedAttacks` drops
  my orders of that turn and later (they never ran). **Commander territories in a finished history are counted (#437,
  VERIFIED live 2026-11-20):** GameFeed sends such a territory's armies as `"<N>|cmdr,<GUID>,<owner id>,"`, N the plain
  armies alone (the commander is the unit after the bar, fighting as 7, not in N); `boardFromStanding` reads it as
  `armies: N` plus `specialUnits` (fixture `tests/fixtures/gamefeed-history-commander.json`), so `PlayerTurn.armies` is
  exact there and `PlayerTurn.commanders` counts the player's own commanders on its land (the decision log's truth
  carries `commanders` beside `armies`, `mine` and each opponent). `armiesUnread` remains for a count that does not
  read on a board that hides nothing (records written before this, where a commander stood, carry it: `armies` is a
  lower bound then); only a fogged territory makes `armies` `null`. Map entries keep `kinds` and `settings: { key (`settingsKey`), localDeployments?,
  commanders? }`; `mapRecordSummary` / `mapRecordStarts` take a `MapMatch` (`mapMatchOf`: the current game's format,
  Local Deployment and Commanders — an entry that kept no flag matches on it, counted in `settingsUnknown`), and
  warapp_plan_picks' `mapRecord` and warapp_plan_turn's `pace` read only the matching games, with `matched: { by,
  entries, of, settingsUnknown, note }`; warapp_map_stats (no game) reads them all.
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
    bonuses containing it, plus bonuses I'd lose all access to, plus its share (value × members
    held ÷ size) of a bonus I am building — every missing member a visible neutral, finishing it
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
    bonus keeps the border; under No-Split a completion only). Order Priority moves only that first order ahead of the opponent's first, so the
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
    **The profile's siege (`siegeFit`):** adapting with no goal (`PlanOptions.siegeAuto: false` turns it off) the
    profile picks it, over its own goal (a `defend` included: the siege plans as balanced), when against the strongest
    opponent in contact: the format is a 1v1 or an FFA (not teams), phase `contact`/`late`, standing `even` or
    `behind`; in an FFA the target is the strength leader (`ranking.commonThreat`) and earns ≥ `SIEGE_FFA_DOMINANCE`
    (1.5) × every other opponent in contact; and a sure break (every member in view, a member next to mine) costs
    ≤ `SIEGE_FIT_TURNS` (2) × its bonus (1 × once retaken on `SIEGE_RETAKEN_TURNS` (2) earlier siege turns) and ≤ my
    income. Once the trigger fires it hands back (a rationale line), and any turn the fit fails the profile's own goal
    plays. `siege.auto` and the first rationale line say why. Golden: 6 of 611 adapting boards pick it, with the
    same deploys and moves (the goal, rationale and siege report change), and 9 more carry the hand-back line; most
    not-ahead contact boards have no sure break in reach.
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
    warning); its other members are plain expansion. `team.sharedBonuses` (advisory) lists each bonus
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
    captures +1. #319: on turns 2–`SPREAD_LAST_TURN` (6), with at least `SPREAD_TERRITORIES` (10)
    territories, no bonus held and my income at most `SPREAD_INCOME_SLACK` (3) above base, a warning says the captures
    are spread and names this rule's nearest bonus with its armies and turns; no order changes (golden unchanged). An FFA lead step into it (an enemy member, #203) is sized to land
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
    and 1 removed. The rule lives in `plan/stockpile.ts` (`pileOf`, `stockpileOf`, `strikeShareOf`; pure, shared by
    the estimates and strike phases). **The strike share (#421, owner decision of 2026-11-20):** in contact on a
    flat income — wherever rule 0p.3c builds a strike stack (a 1v1 adapting with a foe's visible territory beside
    mine, a siege on such a foe, or the stockpile) — `STRIKE_SHARE` (25%) of my income, rounded down, is held out of
    captures (`PlanCtx.strikeShare`, added to `reserve`, which holds back captures only: holds, the #122
    garrison and the #276 second line (`fillSecondLine`) keep their exact need first), so the leftover gives it to the stack ahead of comfort margins, with a
    "Strike share (#421)" line. Never at the cost of next income: `planShare` (planner.ts) replans with
    `PlanOptions.strikeShare: false` and keeps that plan when it earns more next turn (a completion the share
    starved), saying so. Golden byte-identical (no history); with a flat history injected on every plan of turn
    ≥ 5, 115 plans changed (the line), 5 in their orders: captures +2/−4 (advances that no longer fit), next
    income and concessions unchanged. **The break spend (#421, owner decision of 2026-11-20):** on the pile (`pileOf`:
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
      completion's score is discounted by that defence cost (`DEFENSE_DISCOUNT`).
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
      **The 1v1 gate budget (#297, `gateStop` in `plan/captures.ts`).** In a 1v1 every border of mine facing the
      opponent is a gate, each sized for its stack plus the opponent's whole deploy (one deploy floats to whichever
      it picks). A capture that adds a gate is stopped when the frontier would then need more next turn than the next
      income and more than without that capture: rule 4d's start-of-turn escape does not apply in a 1v1 (its line
      then carries the gate arithmetic, "… in this 1v1 it opens another gate …"; when 4d's own check fires its line
      gains "In this 1v1 that is another gate …"), and the contact fallback runs it where 4d is only a cost. The plan
      reports `gates` (1v1 only; each gate's `needs` and `armies`, `conceded` marked — a conceded gate is still a way
      in — `need`, `onGates`, `deficit` = the per-gate shortfalls summed, `income` = the frontier's, `short` =
      deficit − income) and warns only when its own captures open a gate the income cannot hold. Measured on the
      golden corpus against main: every non-1v1 plan byte-identical; of 4,926 1v1 plans orders changed on 12 (12
      captures stopped, next income never lower), the warning on 280.
  - **Game rules** (`docs/PLAN-PLANNER-4.md`, `tests/analysis/lessons-game-rules.test.ts`; the
    full-rung `settings` echo shows each):
    - **Kill rates (#28).** Every combat computation uses the game's offensive/defensive kill
      rates; only settings without them fall back to 60/70, with a warning.
    - **Local Deployment (#29).** With `localDeployments`, a held bonus's value is a pool
      deployable only on its own territories and only the rest of the income goes anywhere
      (pool rules unverified, `docs/WARAPP-API.md`); `warapp_submit_turn` refuses a broken split.
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
- **The client bundle is fetched at runtime, never vendored.** Board replies are decoded by
  interpreting war.app's own reader functions (`src/protocol/interp.ts`). `src/protocol/bundle.ts`
  discovers the current `ujs.js?v=<n>` from a war.app page (through the bridge), downloads it
  from exactly `https://warappcdn.com/js/Release/ujs.js` (any other host or path is refused; a
  timeout and a byte cap bound the download) and caches it at
  `<dataDir>/bundle/<version>.<sha256>.js` (`MCP_DATA_DIR`, else `~/.config/warapp-mcp`), deleting
  older versions once the current one loads. A cached copy is loaded only when its bytes still hash
  to the digest in its name; when the page naming the version cannot be read, the newest copy that
  verifies stands in for 5 minutes. Loading checks the built-in reader helpers against every
  definition the bundle gives them — `P.x=function`, an alias, an object-literal property — and
  builders by their item reads (`verifyDialect`, docs/WEB-PROTOCOL.md): a mismatch refuses the
  bundle, and so does an unverifiable `P.Ya`/`P.Yc`/`P.uq` (they read every army count); the
  result and the stand-in flag show in `warapp_session_status` and the live board's full view
  (`decoder`). A board whose `Armies` carry two numbers, on which every territory of mine reads 0
  armies, or whose current standing the reader's source does not name is refused, never shown as
  verified (#148). **The bundle is treated as hostile code:** the interpreter
  reads own properties only, refuses `constructor` / `__proto__` / `prototype`, lets natives call
  only interpreter closures (and the load-time check's own item readers), and bounds every read by a step budget, a call depth, size caps and a
  wall-clock deadline (`InterpError` kinds `forbidden` and `budget`) — the load-time helper check
  runs under the same rules. Never commit the bundle or snippets of it; tests use a hand-written
  mini-bundle in the same shape.
- **No captures in the repo.** No recorded frame, `*.hex` capture, or live reply goes into the
  repo — fixtures are synthetic (built by the encoder), with `test@example.com` and made-up
  ids. `git grep` for the real account email before committing. Tests and agents never call
  war.app; the owner does live verification.
- **The in-game player id is the GameFeed id minus two check digits each end**
  (`id.slice(2, -2)`); the digits vary per player.
- **A chrome-less "direct" transport** (`src/direct/`, phase 7 — `docs/PLAN-DIRECT.md`; hosted, #333).
  The signed-in session is carried by a durable **`AuthToken`** cookie, and that cookie **alone**
  authenticates both the server-rendered pages and a `/Services` POST (**verified 2026-11-12**).
  So the bridge has a direct-first router wrapped around it (`createDirectFirstBridge` in
  `src/direct/transport.ts`, over mcp-utils `createDirectFirstTransport`; the fetchproxy bridge
  itself is `createWarappBridge` in `src/transport-bridge.ts`): the direct leg issues a plain
  server-side HTTPS request carrying the cookie, falling back to the browser bridge when no session
  is linked or it has expired. **A sign-out is suspected, then confirmed:** a sign-in page or
  redirect, a 401 or 403 from war.app, a 200 `/Services` reply that is not a frame, or **war.app's own
  signed-out answer — a valid `/Services` frame carrying server error 3, `AuthFailed`** (live 2026-11-17:
  with no or a bogus AuthToken war.app answers exactly that, never a non-frame body, and a signed-out page
  such as `/MultiPlayer` is a plain 200 with no sign-in form) — is confirmed with one GET of
  `/InviteToken` with the cookie (`signInVerdict`: signed in is 200 "Your invite token is N", signed out a
  302 to `/LogIn?AuthNeeded=true`). Signed in → the reply passes through as an ordinary failure (rpc
  names error 3 `AuthFailed`), no wall; signed out or cannot tell → expired, as before. A GET of
  `/InviteToken` is its own probe. A 5xx passes through as an `http` error. A non-GET
  that reached war.app on the direct leg is **never re-sent over the bridge** (a write must not be
  sent twice); later calls use the bridge. The one reply that is re-sent is an edge challenge (a
  CDN/WAF page or `cf-mitigated` header, mcp-utils `detectEdgeBlock`), which never reached war.app —
  and a 200 that is a valid frame is war.app's answer, never a challenge, whatever header sits beside
  it. The direct leg sends the cookie to the exact origin `https://war.app` only: a GET follows
  redirects within it, a non-GET follows none. **Hosted, a wall is retried after a backoff:** a
  hosted child cannot be relinked in-process (its token's `capturedAt` is the constant
  `HOST_CAPTURED_AT`), so `WALL_RETRY_BASE_MS` (60 s) after the router leaves the direct leg — doubling for
  each wall in a row up to `WALL_RETRY_MAX_MS` (30 min), reset by a direct 200 — the next call tries direct
  again (a write that reaches war.app signed out is still never re-sent); before one odd reply kept a
  hosted child on the (usually unpaired) bridge until the process restarted. `wall()` (kind, reason, since,
  `retryAt`, `null` locally) shows in `warapp_session_status` and the healthcheck; `checkSession()` probes
  the session and, signed in, lifts any wall at once. A relink (`warapp_link_session`, or a new `capturedAt` on disk) clears the stale flag
  and returns `auto` to the direct leg. **Hosted, the direct leg and `warapp_sign_in` go through mcp-host's egress proxy**
  (`src/direct/egress.ts`): with `HTTPS_PROXY` set they send through an undici `ProxyAgent` for it instead of
  netguard's public-only dispatcher (which ignores the proxy, and a direct socket is dropped there), the war.app-only
  check kept in our code; an unusable proxy URL is refused, never a direct connection; and the push stays on
  xhr-polling over the router (no direct WebSocket) while a proxy is set. GameFeed and the bundle use global fetch.
  `WARAPP_TRANSPORT` = `auto` (default) | `direct` | `fetchproxy`; the session is stored at
  `WARAPP_SESSION_FILE` (default `<dataDir>/session.json`). One injection point: `index.ts` builds
  this one bridge and passes it to `WarappRpc`, the page fetches, the healthcheck and the push
  socket, so they all get direct mode at once. `warapp_link_session` (write, confirm-gated,
  local only) captures the cookie once through the bridge; `warapp_session_status` reports the
  linked state, age and active leg. **The `AuthToken` is a full-account credential:** file `0600`,
  dir `0700` (macOS: no ACL on either), atomic write; scrubbed by value from every upstream error string (mcp-utils
  `stripBearer` + `scrubToken`); never logged, never in a tool result (the one exception is
  `warapp_sign_in`'s, below), never in an error/hint.
  **Hosted, the direct leg serves only from the token mcp-host captured (#333, owner choice "token
  only"), enforced in code:** on a hosted child (`isHosted`, `src/hosted.ts`) `warapp_link_session` is
  not registered and the session FILE is never read or written (`writeSession` refuses;
  `src/direct/session.ts`). The war.app password is asked once in an mcp-host `authFlow` and never
  stored; only war.app's `AuthToken` is captured, as the per-user secret `WARAPP_AUTH_TOKEN`
  (`HOST_TOKEN_ENV`). `hostedSession` reads it into memory, read-only (trimmed, a leading
  `AuthToken=` dropped; a value that is not 16–4096 printable characters without `;` `,` `"` `\`
  is `malformed`, treated as absent and never echoed; `capturedAt` is `HOST_CAPTURED_AT`,
  `origin: 'host'`). With it, `createDirectFirstBridge` resolves `WARAPP_TRANSPORT` as locally
  (`auto`: direct first, the bridge its fallback, the non-GET never re-sent) from that token alone
  (the given store is not consulted); `warapp_session_status` and the healthcheck say
  `linked: true` with `linkedBy: 'host'` (`linked` stays a boolean, #335) (no capture time, no age); a signed-out session's errors, log line and
  hints say to use "Sign in" on the connection, or reconnect it, and that a paired war.app tab works meanwhile
  (`HOST_SIGN_IN_ADVICE`; mcp-host runs the login again, the router falls back to the bridge), never
  `warapp_link_session` (`LiveContext.hostSignIn`, `accountUnknown(ctx)`).
  Without it a hosted child is byte-identical to before: the store reads as empty, the router is
  pinned to the browser bridge whatever `WARAPP_TRANSPORT` says, and no hint suggests linking.
  Locally `WARAPP_AUTH_TOKEN` is ignored: only the session file counts. The flow is
  `docs/examples/warapp-auth-flow.json` (one masked password prompt on a step that calls the
  read-only `warapp_session_status`; the capture is the sign-in itself, `warapp_sign_in` with
  `email` from `WARAPP_EMAIL` and that password, `authToken` into `WARAPP_AUTH_TOKEN`: one war.app
  attempt, the token never in the gateway-readable bag). No paste-the-cookie fallback ships:
  `warapp_sign_in` takes no cookie argument, so such a flow would be an `isError` that ends the
  login (a test keeps the document, the hint and the manifest from offering one until it is built).
  `mint.yaml` declares the password flow as `auth.flow` (a path inside the package). **Once a
  registration carries the flow, every new connection needs one successful war.app password sign-in:**
  mcp-host ends the login with no grant on ANY `isError` from the capture (`credential_rejected`,
  `edge_blocked`, `transport`, `timeout`, `http`, `unknown`), so a captcha, an outage or a network fault
  ends it like a wrong password and may clear the fields already entered, and an account with no war.app
  password (Facebook sign-in) cannot connect. The bridge is the fallback only for a connection made before
  the flow was added and for a session that expires later. Adding the flow is the owner's decision.
  `tests/auth-flow-doc.test.ts` checks it against mcp-host's rules offline. **`warapp_sign_in` (part B, `src/direct/sign-in.ts`, `src/tools/sign-in.ts`)
  is registered ONLY hosted** (locally `warapp_link_session` stays the way). It takes `email` and
  `password` and makes ONE attempt, never retried (war.app may count failed sign-ins): GET
  `https://war.app/LogIn` for its cookies (`jses_WS60`, `FirstReferrer`, `AWSELB`; a page without its
  password form, or a bot check, refuses before any password is sent), then one form POST to the same
  URL (`Email`, `Password`, `KeepSignedIn=on`, those cookies); redirects are followed by hand, at most 3
  per phase, every one as a GET (the password is never re-sent, a 307/308 included) and only within
  the exact origin `https://war.app` (anywhere else is refused unrequested), through netguard's
  public-only dispatcher, one 30 s deadline, a 2 MiB cap per body. Success is an `AuthToken` set on any
  hop after the POST (one the page sets alone does not count; a deletion does not count; one that fails
  `isPlausibleAuthToken`, the hosted child's own shape check, is refused rather than kept). Refusals:
  `credential_rejected` (the form came back), `edge_blocked` (detectEdgeBlock, captcha markup, 403,
  429), `transport` / `timeout` (saying whether the POST had gone), `http` / `unknown`; the email (any
  case), the password and every cookie value of 6+ characters are scrubbed by value and the cause is
  dropped. **Its result `{ authToken }` is the single documented exception to "never in a tool
  result":** mcp-host's capture reads the credential from the capture tool's result, and the caller
  already holds the password, so it grants nothing new; nothing else about the account is returned.
  Not confirm-gated (the flow sends only the arguments its document declares); annotated not
  read-only, not destructive, not idempotent, open-world. Hiding it from the
  menu (`enabledTools` left without it) is an owner choice, off by default: mcp-host never checks a flow's
  step or capture tool against that allowlist (`wire.ts` `toolCallRequestSchema`), but the gate is
  fail-closed, so once set the connection's resources (`warapp://strategy`) and prompts are gone, and every
  tool a later release adds stays hidden until the list is edited by hand. The design, trade-off, registration change
  and the unbuilt paste fallback are in `docs/PLAN-DIRECT.md`.
- **End of game (#178).** `Game.endRules` holds the surrender, boot and AI settings; whether a surrender
  needs acceptance comes from `InstantSurrender`, not the player count (the count is only the fallback;
  #228: the surrender preview reads the game with `settings: true`, which carries it — without them it
  always fell back — and unread with more than two players `acceptance.needed` is `null`: it MAY be
  needed, the result reading unchanged).
  `warapp_plan_turn` logs each turn's outlook name-free at `<dataDir>/outlook/<gameId>.json` (per turn
  the strengths, ratio and state, and since #283 the armies and income behind them, `figures`, with the
  strongest side's id; `warapp_get_game` adds the final result); the surrender preview reads the latest from there.
  **How a lost game was lost (#274, `src/analysis/how-lost.ts` pure, `src/tools/how-lost.ts`):**
  `warapp_get_game` on a finished game the cached account did not win reports `howLost`, and (#283) on a
  game still playing once that account's seat is out (`Eliminated`, `Booted`, `SurrenderAccepted`; no
  disk read unless some seat is) — a surrender or boot by its state, with (#283) `turn` (the last turn
  played here: the newest cached board where it held land, or logged outlook) and `outlook`, the newest
  logged one up to then (its state, `held` when the log's latest state held, and `mine` / `strongest`:
  armies and board income, the strongest side's in view, from the log's per-turn `figures` —
  `OutlookTurn.figures`, absent on turns logged before #283), all in its `line`; an elimination from the newest
  cached board where it held a territory (the turn, `turnCertain` only when it is the game's newest
  completed turn): my commander there → its territory fell
  (inferred), with what stood there after my cached orders (`low` after my moves out, `high` after my
  moves in) and `armiesToTake(low + 7)` at the game's kill rates (`exact: false` with luck;
  `held.uncertain` when an order `moves` leaves out — kept only in `sent` — or a card play touches it).
  When that turn's cached orders walk the commander (`commander: true` on `MyOrders.moves` / `sent`,
  cached by `myOrdersOf`), it is read at the walk's destination, `territoryCertain: false` (it may
  have fallen on the start before the walk ran), the neighbours of both. No
  commander → the last territories; a Commanders game whose board shows none → `unknown`. The
  neighbours by owner (fog `null`), `by` only when one player alone borders it. Kept as `loss` in the
  outlook log (ids and figures; a log may hold only that; never written over another account's log) and
  read from there once the boards are gone; names go out through `untrustedText`.
  An opponent the outlook cannot measure (nothing in view now, or no observed income) gets a
  peer-paced likely high (#214, `peerPace` in `src/analysis/outlook.ts`, pure and exported for the
  planner): each turn 2 × the higher of my income and the most any opponent was tracked earning, the
  map's even share only a ceiling — never sized by the map; it can still block `winning`. Every likely
  high starts symmetric: the given start, the even share under full distribution (the real start
  then; #428, `fullDistribution`: DistributionMode 0 with no TerritoryLimit — -1 is a limited start,
  TerritoryLimit × InitialPlayerArmiesPerTerritory, verified on three games), else my opening board, else the default territory limit (3) at the starting armies — never
  the territories I hold on a later board; my income before my first board ramps up from that
  opening's.
  #228: the likely high is generous to the opponent (every army received, none lost: a game I lead read
  0.05×), so `losing` on it needs mine at most `LIKELY_LOSING_RATIO` (1/(2.4 × 2)) of it AND
  corroboration — the main front grinding me down, or my income at most `BEHIND_RATIO` × the most an
  opponent is tracked earning; the turn carries `estimated: true` and `lowLikely`, and the basis says
  which (or, uncorroborated, why it is no loss). That front is always forecast on the incomes read off
  my boards, never the plan's (#228 review): the planner reads the outlook before it plans, and the
  reported one is re-read with the plan's front, so the losing state the plan acts on (rule 3d's decided
  horizon, its line calling it an estimate) is the one shown and logged. `warapp_plan_turn` passes the plan's profile standing
  back (`standing`): an `even`/`stalemate` outlook beside `ahead`/`behind` says why the two differ.
  **What the state rests on (#304).** Every outlook turn carries `evidence` (`OutlookEvidence`, the latest's
  also on `GameOutlook.evidence`): the two incomes compared (mine — my team's in a team game — against the
  side the likely high rests on, else the strongest; tracked off my boards, its visible income at least, else
  in view), and per opponent still playing its income and the share of its frontier that income was read
  from (#294's `TrackCoverage`, `null` when unmeasured), `thin` when the board is not in full view and that
  share is under `LOW_COVERAGE` (0.5) or unmeasured. The basis says them after the state ("Incomes compared
  …", "Frontier read …", and "Thin evidence: … so "even" is not a safe reading"); plan_turn's compact
  outlook, the outlook log (per turn and `latest`, without the coverage's words) and the surrender preview
  carry it. Reporting only: it never changes the state, a ratio or any plan.
  **Leaning behind (#368).** Each outlook turn names the positive bonuses my side held in full on the board
  before and no longer does (`bonusesLost`); when the state is `even` on strength for `OUTLOOK_TURNS` running
  (#436: whatever each turn's income lean, unless the run reports `behind`) and every turn of the run lost one, `GameOutlook.leaning` is `{ toward: 'behind', turns, lost }` and the basis says
  "Leaning behind: …"; plan_turn's compact outlook carries it. Reporting only: the state, its thresholds and
  the profile's standing (#287) are unchanged.
  **Incomes, their trend, and the surrender line (#436, owner decision of 2026-11-20).** Each turn carries `income`
  (`OutlookIncome`): my side's income against the strongest opponent side's by estimate — its range (`low` the
  tracked income, its visible at least; `high` the likely high's income per turn while its evidence is thin, else
  `low`) and its estimate (the tracked figure ÷ past games' estimate ÷ truth in its coverage band, `calibration`
  from lessons.json through `outlookCalibrationFor` in `src/tools/past-games.ts`: this format's band with
  `MIN_CALIBRATION_SAMPLES` (5) or more, else every format's; never below its visible income; uncalibrated, the
  tracked figure; the estimate and `high` never above what it could earn that turn — `capIncome`, the could-earn
  bound `paceIncome` keeps to, or `low` when that is higher — since ÷ ~0.3 at low coverage can read an income it cannot
  reach). Its `lean`: `unknown` when the range spans both lines (`INCOME_BEHIND_RATIO` ⅔ and
  `INCOME_AHEAD_RATIO` 1.5), `behind`/`ahead` when the whole range, else the estimate, is past one, else `even`
  unless each side's change per turn over the turns judged (`trend`), one turn on, crosses a line the ratio heads
  to (`byTrend`). Calibration deepens a deficit the tracked figure shows, never creates one: a `behind` lean on the
  estimate or its trend, and a turn under the surrender line, also need my income under the tracked figure (the
  range's `low`); when only the calibrated estimate reads behind the lean is `unknown` (`calibratedOnly`). In-sample
  replay (10 lost games, 100 turns): truly-even turns past the crossed line 5/25 → 1/25, truly-behind 42/75 → 29/75,
  games crossed 10 → 9 of 10 (`MIN_CALIBRATION_SAMPLES` stays unmeasured). No lead is claimed at low coverage (any `evidence.thin`): `ahead` reads `unknown`, and a win on
  the likely high alone is not read (`noLeadClaim`; a win on the bound still is). **#454: the state keeps its four
  values** (winning, losing, even, stalemate — the tool contract, as #321 kept the chat source's; the planner reads
  only winning and losing): a lean beside an `even` state is the additive `lean` (`ahead`/`behind`/`unknown`, absent
  when the state already says it), per outlook turn and on `GameOutlook` — plan_turn's compact and full outlook, the
  outlook log (per turn and `latest`), `finalOutlookOf`, the surrender preview, how-lost, `MySurrenderDetail`
  (`outlookLean`) and the decision log (`outlookLean`) carry it. The mapping is exact (a lean only ever replaced an
  even state), and the internal readers use the finer `readingOf` (lean, else state): the chat standing, the
  decision log's compaction and truth/accuracy. A log, decision or finished record #453 wrote with the lean as the
  state reads as `even` with that lean (`splitReading`, on read). Turns even on strength are one run for the hold
  whatever their leans: the run's `lean` is set when every turn judged read it, else plain `even` (a slide reading
  even, behind, behind holds `even`, and #368's lean behind still reads). `GameOutlook.pace` is the pace line (both incomes
  and their change per turn) and `surrenderLine` — ADVICE ONLY, the server never acts on it — is present while my
  income is under ⅔ of the strongest estimate, `crossed` after `SURRENDER_TURNS` (3) turns running with no bonus in
  reach closing the gap (`bonusesInReach`: every missing member beside my land, its visible defenders below my
  armies beside them plus my income); plan_turn's compact outlook carries `income`, `pace` and `surrenderLine`, a
  crossed line is a leading warning, and the outlook log keeps `income` per turn and `latest.surrenderLine`. Play
  policy (notify the owner, surrender next turn unless he objects) lives outside the repo. Golden unchanged.
- **One healthcheck for both transports** (`registerAdaptiveHealthcheckTool`): the credential
  probe while the direct leg serves (and until the bridge has carried a request), the bridge probe
  only when this connection's router is on the bridge leg (the fetchproxy bridge is shared
  process-wide, so its role alone is not enough; `WARAPP_TRANSPORT=direct` never probes it); either way it reports the active leg and whether a direct session is linked and
  its age (never the token). With a direct session either arm first checks it (`sessionCheck`, plus
  the router's `wall`): signed out fails as `session_expired` even when the API token is fine (a hosted
  healthcheck said ok while every live tool failed), and on the bridge arm a signed-in check lifts the wall
  and probes over the direct leg. The bridge port is `WARAPP_WS_PORT` (default 37149); hosting needs
  `bridge: true` and `bridgePortEnv: WARAPP_WS_PORT` on the registration.
- **A frozen war.app tab stalls bridged POSTs.** Chrome freezes background tabs; the bridge
  relays `/Services` POSTs through a page tab, so they time out ("did not respond within
  30000ms") while GETs (run by the extension) still work. Reloading or focusing a war.app tab
  clears it. Live verification found this repeatedly — say so in any timeout hint. Every bridged
  `/Services` timeout carries `FROZEN_TAB_HINT` (`src/tools/live-context.ts`), and the write tools'
  `unknown` warnings repeat it (`failureText`).
- **"Me" is the signed-in account.** The live tools default `player` to the account whose
  invite token (`https://war.app/InviteToken`, read through the bridge) matches a GameFeed
  player id; the bundle is discovered from `https://war.app/MultiPlayer` (the homepage does
  not load the game client).
- **"My games" is `GetMyGames` (method 50)** through the bridge, decoded by the bundle's own
  readers by stable type name (`warlight.shared.MyGamesReturn` / `GameInfo` /
  `GameInfoPlayer`) — never a hand-transcribed layout. Its `MyGamesFilters` argument is
  required (absent, the server throws). `waitingOnYou` = the game is Playing or
  DistributingTerritories, my player is Playing, and my `committed` flag is false.
  **The whole list (#260):** the client's default filters (`Default`, count 10) are the dashboard's
  short list (live: 10 of 41 games), so `fetchMyGames` (`listMyGames`, `src/tools/my-games.ts`) asks
  `MyGamesFilterType.All` with a count of 100, then 400, then 1600 while a reply fills its count
  (`MY_GAMES_WINDOWS`; the client never pages GetMyGames: no start index), and says `partial` when the
  widest is filled or a wider read fails. Every caller gets that list (`warapp_my_games`, the chat inbox,
  the turn wait's default, the team fallback, the join/leave read-backs). `warapp_my_games` leaves finished
  games out unless `include_finished` and reports `listed` and `complete` (a `warning` when partial).
  UNVERIFIED live: `All` with a count above 10.
- **Scouting reads two server-rendered pages** through the bridge (GETs the extension makes):
  `https://war.app/Profile?p=<invite token>` (level, games played, last seen, boots, ranked
  records) and `https://war.app/CommonGames?p=<invite token>` (the head-to-head games). The
  invite token is the GameFeed player id. `src/scout.ts` and the skill's
  `references/scout.mjs` parse them identically (parity is tested) and tolerate missing
  blocks (`null`, never a throw).
- **Scouting never returns personal fields.** The Profile page also shows self-reported
  details such as location: the parser projects an **allowlist** (name, level, games, real-time
  share, last seen, boots, ranked records, common games) and nothing else. Never add location
  or any other personal field to the output, a fixture's expected output, or a doc example;
  the tests feed a page that carries a location and assert it is absent.
- **Every GameFeed scalar is a string** (ids, counts, booleans); normalize before use —
  see `docs/PLAN.md` "Facts". Fixtures under `tests/fixtures/` are anonymized.
- **A distribution mode's starting territories come from `GetMapDetails` (73, no auth; #328)**, never GameFeed
  (which names the modes only): `src/map-details.ts` decodes `MapDetails` → its mode dict (fourth field) →
  `NormalDistribution` (its id list) / `ScenarioDistribution` (its territory → slot dict's keys) by type name
  with the bundle's readers, and drops (with a warning) any id that is not a territory of the map.
  `withModeTerritories` (`src/tools/map-details.ts`; callers: `warapp_get_map`'s full view and
  `warapp_locate_opponents` in an automatic game) asks only when a caller needs them and a mode lacks them,
  at most once per map per process (`MapCache.mapDetailsTried`); a failure, a mode listed without ids or one
  whose every id is dropped is `null` (unknown), never `[]` — an empty list is never kept, and a stored `[]`
  reads as not read yet. Read ids are kept on the cached base map and in the store
  (`distributionModes[].territories`, `writeStoredModeTerritories`: the map's `storedAt` unchanged, so they
  age out with it; a stored mode without them reads as not read yet; a new game on a stored map keeps them, the
  fresh download written with the stored copy's `storedAt` so they still age out on their own clock, and a mode
  whose stored ids are not all territories of the fresh map is not carried, so it is read again).
  Only `warapp_get_map`'s full view (no `bonus` filter) asks; it lists each mode's `territoryCount` and
  `territories`. VERIFIED live 2026-11-16 for normal modes (seven modes on one map matched #328's trace); the scenario
  mode is UNVERIFIED live (docs/WEB-PROTOCOL.md "Map details"). `warapp_locate_opponents` reports where its start
  candidates came from as `startCandidates` (`source`, `count`, and for a distribution mode its id and name).
- **A game's map comes from `mapOf(game)`** (`src/tools/map.ts`), which applies the game's
  `OverriddenBonuses` (`applyBonusOverrides`); load the game with `settings: true` wherever bonus
  values matter. The JSON shape is verified live (an array of `{ bonusID, value }` numbers); overrides
  that do not read in full keep the submit pre-checks soft.
- **API facts live in `docs/WARAPP-API.md`**, each marked verified or unverified. The board
  standing parser (`src/board.ts`) is unverified and must stay loose (never throw). Territory
  and bonus ids overlap, so a bonus member is a territory first and a superbonus only otherwise.
- **Map statistics are opt-in and local-only** (`warapp_map_stats`, `src/stats.ts`): off unless
  `WARAPP_STATS=1`, always off when hosted (recognised by mcp-host's child-only variables —
  `HOSTED_MARKERS` in `src/hosted.ts`), and `mint.yaml` never sets `WARAPP_STATS`. GameIDFeed + GameFeed
  `GetHistory=true` through `WarappClient`, ≥ 1 s apart, finished games cached forever as
  name-free records at `<dataDir>/stats/<mapId>/<gameId>.json`. #302: the history is read from
  `history`, else the reply's top-level `standing<N>` / `turn<N>` / `distributionStanding` keys (shape
  UNVERIFIED, docs/WARAPP-API.md; a `distributionStanding` with no player land is the board before
  picks, so `standing0` is the start), and an unreadable one says why, name-free (`historyReport` in
  `src/trend.ts`: a reason and key names only) — `collected.unreadableGames` here, `historyUnreadable` /
  `historyRead` in `warapp_get_game` with `include_history`. A record keeps the history `layout` it was
  read in: a layout added to `RETIRED_LAYOUTS` (`src/map-stats.ts`, empty until the live check) makes its
  records unreadable, never cached and a cached one deleted and fetched again. Each game is read with
  `GetMap=false` (a cached map is attached by its id); only a finished game on an uncached map
  costs one more request, for the map.
- **All GameFeed traffic goes through `WarappClient` (`src/client.ts`)**, including the
  credential healthcheck probe; all `/Services` traffic goes through `WarappRpc`
  (`src/protocol/rpc.ts`), which echoes the reply extras into the next request. Maps are
  cached in memory (`MapCache`) and on disk (`src/map-store.ts`, local and hosted: the per-user
  `state.dataDir` persists): `<dataDir>/maps/<mapId>.json` holds the normalized map with its BASE
  bonus values (overrides are per game, applied by `mapOf`), at most `MAX_STORED_MAPS`, the least
  recently used evicted (a memory hit marks the file used, and stores it again if it has gone, so a
  game played all session keeps its map for replay); `<dataDir>/maps/games.json` says which map a game is on (bounded), so a
  known game is re-fetched with `GetMap=false` after a restart too. That index is written only for
  a caller that wants the map, on a game not finished (map statistics and `GetMap=false` callers
  spend no entry; a game read back from it after a restart moves to the newest). **A map is not immutable:** its maker can publish an edit under the same id and
  GameFeed sends no map version, so a stored map carries `storedAt` and is trusted for
  `MAX_MAP_AGE_MS` (30 days); older, or with no `storedAt`, it reads as absent and the game is
  fetched with its map again (the fresh copy replaces it). Within that time, a feed standing that
  names a territory the cached map lacks has the game fetched with its map again (once per map per
  process). Offline replay reads a stored map
  whatever its age. A bad file is ignored and
  replaced; the disk never fails a call. A tool
  that never uses the map (the turn wait, surrender, uncommit, chat — a send with `commitments` aside, which
  plans — join-game, scout, begin-turn, submit-turn's read-back) asks `GetMap=false` for its own reads, even for a game
  it has not seen. The one exception is the end-of-game pass that the turn wait (like `warapp_get_game`, the
  `warapp_my_games` sweep and `warapp_get_notifications`) runs on a finished game: its history read asks
  `GetMap=false` too, but with no map cached it makes one more read for the map (#312).
- **Offline replay (`src/replay.ts`).** Wherever the board cache is written (plan_turn,
  track_opponents, locate_opponents, get_relations) the game's settings are kept at
  `<dataDir>/games/<gameId>.json`: name-free (players by id, team, state and AI flags; raw settings
  through `sanitizeSettings` — numbers, booleans, numeric strings, a few enum words and a card's
  `Mode` word (`cardArmyCeiling` reads it), no free text,
  no mod entries, nothing equal to a player's or the game's name; overrides re-written in their
  verified shape), 0600, atomic, best effort, the newest `MAX_GAME_RECORDS` kept and a game not
  written for 60 days deleted, like the boards. `loadReplay(dataDir, gameId)` rebuilds the planner's
  inputs from the data directory alone: `{ game, settings, map, playerId, boards, orders }`
  (`undefined` without a settings record; `map` absent when the store evicted it).

- **The decision log (#412, `src/decision-log.ts`; design record `docs/PLAN-DECISIONS-412.md`).** Per game, one
  account's entry for every turn it plays, at `<dataDir>/decisions/<gameId>.json` (`{ version: 1, gameId, playerId,
  status: 'active' | 'finished' | 'compacted', turns }`), name-free (player ids and the map's own names; every player
  name the game carries is scrubbed from every string, `override_reason` included). A turn `warapp_plan_turn` planned
  (not a what-if: an explicit `goal` or `enemy_deploy`, as the board cache's rule) is a full entry: the fogged board
  (delta-encoded against the previous logged turn, a full board at the first logged turn and every `FULL_BOARD_EVERY` =
  10; `boardAt` rebuilds any turn), the planner's replay `input` (what the map store, the settings record and the board
  cannot give back; `encodeInput`/`decodeInput`), `planner.version`, the `decision` (goal, profile, deploys, moves,
  expected, conceded, offence, enemyDeploy, card advice, the logged estimates, the `rationale` and `warnings` lines verbatim, outlook state), and
  `next` (actual income, captures/holds, bonuses, eliminated; #442: `capturesMissedTo`, the player holding each missed
  capture) filled when the following turn is planned; warapp_plan_turn's `sinceLastTurn` names each capture the logged plan
  expected (kept to the moves sent, when logged) and did not make, with who holds it ("your attack hit their fresh
  capture" when it was not theirs before). Every other
  turn the server sees gets an observation entry (`kind: 'observed'`, `source: 'live' | 'history'`) wherever the board
  cache is written (`src/tools/decision-capture.ts` `captureObservation`: track/locate/profile opponents, get_relations,
  plan_turn what-ifs and `boardHistory`'s history fill); it never overwrites a planned entry, and a later plan upgrades
  it. `warapp_submit_turn` records `sent` after a confirmed send (`captureSent`, where `writeOrdersCache` runs) and an
  `override` (`by: 'agent'` by default, or the caller's `override_by`, with `override_reason` ≤ 500 chars) only when the
  orders differ from the logged decision (`ordersDiffer`); with no plan logged it records `sent` on the observation
  (or a minimal entry). Once a game is finished the end-of-game pass (src/tools/end-of-game.ts, after the record is
  captured) writes every turn's `truth` from the FULL history, before finished-store's head/tail cut (a turn with no
  entry gets a truth-only entry, a turn the history lacks is listed in `truthMissing`; no log is started for a game
  with none), each logged turn's `accuracy` and the game's `accuracySummary` (`recordTruth`, pure part
  `src/analysis/decision-truth.ts`, #318's alignment), then `compactDecisionLog` — which never drops a board, decision,
  rationale/warnings, sent, override, `next`, `truth` or `accuracy`, only the replay `input` of uninteresting turns
  (interesting: an override, an outlook change, the first `KEEP_FIRST` = 3, the last `KEEP_BEFORE_LOSS` = 5 before an
  elimination or loss, next income ≥ 20% short of expected, an estimate off by > 1.5× or < 0.5×). A pass that captured
  no history, or none run (`WARAPP_PLAYER_PROFILE=off`), marks the log `finished` uncompacted (`finishDecisionLogs`).
  Caps: `MAX_DECISION_GAMES` = 1000 games and `MAX_DECISION_BYTES` = 500 MB (`pruneDecisionLogs`, after a write at most
  once per `DECISION_PRUNE_INTERVAL_MS`: oldest finished games first, a game only ever whole, never one still running;
  listing reads only each file's head). `WARAPP_DECISION_LOG=off` writes nothing; `full` skips compaction. 0600 in
  0700, atomic under the path lock, best effort; a file that does not parse or carries another `version` is never
  overwritten, listed or pruned. The state bundle carries it (`decisions`, finished games too, newest first up to
  `MAX_EXPORT_DECISION_BYTES` = 16 MiB, the rest counted in `leftOut.decisionLogs`). Offline replay is the LOCAL dev
  script `scripts/replay-decisions.mjs` (never a tool, never in CI; pure part `src/analysis/decision-replay.ts`): it
  re-plans every turn whose input was kept, under an optional scenario, and reports identical/different orders, a
  score against `next`, the estimate accuracy against the truth and `--export-fixtures`. The invariant — unchanged code
  and no scenario reproduce the logged deploys and moves — is tested from the capture (`tests/decision-replay-tools.test.ts`).
  How to run: `docs/PLAN-PROFILES.md` "Replaying the decision log". No planner decision reads the log.
  **v2 per-turn additions (#437 task 1, `docs/PLAN-DECISION-LOG-V2.md`; additive, `version` stays 1, older entries read
  as they are):** `planner.build` (`src/build-id.ts`, read once per process: `git:<sha>` from this package's own `.git`
  — a worktree's `.git` file, its common dir and packed refs followed, no process spawned; never the `.git` of a project
  it is installed inside — else `sha256:<16 hex>` of the running bundle); `times` (ISO wall-clock: `plannedAt` by
  `recordDecision`, `sentAt` by `recordSubmission`, and from the game read `turnStartedAt` — GameFeed's `lastTurnTime`,
  read as the turn's start, unverified — and `bootAt.auto`/`direct` from AutoBoot/DirectBoot); `firstMover` (`{ who,
  source, verified }`, `null` unknown); `cards` (`hand`: my cards by type and count; `advice`: per card advised its kind,
  target ids, player and a reason code, never prose, `cardAdviceLog`; `played`/`discarded` from `sent`); `checks.submit`
  (the commander check — `null` without one — the weakest 5 headroom rows as `takeAt` and what each protects, the
  below-plan rows and the chat commitments the orders break, by id) and `checks.checkPlan` (`warapp_check_plan`'s `safe`,
  the worst reply in numbers, `harmful`/`considered`, the `atRisk` counts, `whatIf` under `enemy_deploy` or
  `known_income`; `recordCheck`, the latest run per turn wins, starting an entry when the turn has none, and a plan of
  the turn after it keeps it). The pure shapers are in `src/tools/decision-capture.ts`; compaction keeps all of them.
  **v2 per-game additions (#437 task 2; additive, `version` stays 1):** `events` (`{ turn, kind, player?, detail?, at }`,
  `turn` the turn being played when seen — completed + 1, 0 before turn 1 —; the newest `MAX_GAME_EVENTS` = 500 kept,
  `eventsDropped` counting the rest; never twice for the same change): seat changes diffed against `seats` (each seat's
  last state word and turned-AI flag, by GameFeed id; `seatEvents`: `booted`, `surrender-accepted`, `eliminated`,
  `ended-by-vote`, `turned-ai`, any other non-`Playing`/`Invited` word as `seat-state` with the word — a non-word reads
  `other`; at first sight a seat already out is an event too) on EVERY GameFeed game read (`WarappClient.observeGames` →
  `captureSeats`, wired in `src/tools/index.ts`; as the log's own account when seated, else the signed-in account only
  when a read already gave it — `LiveContext.cachedInviteToken`, never a request — and the game not `Finished`, which
  starts a log; an unchanged read is skipped by an in-process signature); `surrender-pending` (player, `owed` /
  `not-owed` / `unknown`) from `readPendingSurrenders` (warapp_wait_for_turn, warapp_plan_turn; warapp_my_games' list
  read carries no GameFeed ids and logs nothing); `surrender-accepted-by-me` (warapp_accept_surrender `confirmed`); and
  `my-surrender` (warapp_surrender `surrendered` or `pending`, `detail`: status, my income and the highest-income opponent
  from the outlook log's latest evidence, its state and turn, `mySurrenderDetail`). `join` (warapp_join_game `confirmed`,
  `joinContextLog`): `settingsKey` (`sha256:<16 hex>` of `nameFreeSettings`, keys sorted; `null` when GameFeed could not read
  the lobby), `flags` (format, seats, pace, boot minutes, and from GameFeed LD, commanders, kill rates, luck, fog, cards)
  and `policy` (`policyChecks` in `src/open-games.ts`: `broke`/`passed`/`unchecked` by code — commerce, mods,
  custom-scenario, neutral-cost, seats, boot-time, lottery), `lottery` when marked. `opponents` (by GameFeed id:
  `firstSeen` turn, `ai` for an AI seat; warapp_scout_player with `game_id` adds `level`, `ranked`, `bootRatePct`,
  `readTurn` to a log that exists, as its account — no extra request; GameFeed's player carries no level). A log holding
  only these (a lobby joined) is finished and compacted like any other (`hasContent`). All kept through compaction.
  **v2 picks phase (#437 task 3; additive, `version` stays 1):** `picks` on the log — `advice` (warapp_plan_picks,
  `picksAdviceLog` → `capturePicksAdvice`: players, territory limit, `maxPicks`, `spread`, the list, primary and fallback
  ids, the first `LOGGED_PICK_SCORES` = 10 picks' scores, both group scores, the warnings by code (`pickWarningCode`,
  each once, unknown wording `other`), the award `outcomes`/`orders` judged/`worst`/`reordered` (`null` when not judged),
  coverage numbers, the `alternative` when offered, and in a team game the teammates' ids, lists read and `mirrored`;
  never a reason, rationale or name; a re-plan replaces it, `advices` counting; logged as the log's own account when
  seated, else the signed-in seat by `myInviteToken` — cached, so usually no request; neither seated: nothing),
  `submitted` (warapp_submit_picks after a send that did not throw, `capturePicksSent`: `sent`, `readBack` or `null`,
  `verified`, `outcome`; the latest send wins, `submits` counting; a preview logs nothing) and `award` (`loadAward` on
  turn 1 when it writes the reading, `capturePicksAward`: `turn` and the `AwardReading` or `null`; written once, never
  over one kept). Each starts a log; a log holding only `picks` is finished and compacted like any other; kept through
  compaction.
  **The review export (#437 task 5, `scripts/review-export.mjs`, LOCAL dev script like the replay: never a tool, never
  in CI; logic in `src/review-export.ts`, tested in `tests/review-export.test.ts`).** `reviewGame` joins one game from
  the data dir alone: the decision log (each turn without its encoded `board` and replay `input` — `hasInput` says
  whether one was kept; `boards: true`/`--boards` adds `boardAt`'s board whole, `null` on a broken chain — plus
  `accuracySummary`, `truthMissing`, `events`, `eventsDropped`, `seats`, `join`, `opponents`, `picks`), the
  finished record, the map-record and lessons entries by `finishedGameKey` (`{ entry }`, or `{ entry: null, excluded }`
  for a game counted apart), the settings record's game by ids only, the stored map's name and size, and
  `kinds`/`format`/`outcome`/`turns` read off them; `sources` says per source `present`/`missing`/`unreadable`
  (`excluded` for the two keyed stores). My account is the log's, else the board cache's, else — a legacy game — the
  settings record seat whose `finishedPath` exists. `reviewGameIds` lists every game with a log (readable or not) or a
  settings record; `exportReview` writes `game-<id>.json` and `index.json` (one line per game: id, kinds, format, map
  id and name, outcome, turns, sources), pretty JSON, atomic, 0600, into a folder it makes 0700 and refuses when an
  existing one is readable by others (never chmod-ed). No request; nothing written to the data dir (reading a stored
  map touches its mtime, as every reader does). Name-free like its sources.
- **Calibration harness (#318, `scripts/calibrate.mjs`, LOCAL dev script: never a tool, never in CI).** Runs on
  the built `dist/**` over the data dir and prints aggregates only (no id, no name). Pure parts in
  `src/analysis/calibrate.ts`: `estimateSamples` (tracker via E2's `calibrationSamples`, the fog prior and the plan's
  estimate via `planEnemyEstimates`, each ÷ the history's true income, by format and coverage band),
  `openingBenchmark` (my real start replayed 8 turns on `planTurn` + `simulateTurn`, the opponents put back where the
  history shows them by `overlayHistory`: no fog, no attacks on me, no cards — said in the output) and the aggregates.
  Truth is the end-of-game record itself (`<dataDir>/finished/<hmac>.json`, which keeps the history's boards, owners
  by `playerKey`, delta-encoded, bounded): the harness keeps no store and makes NO request (no `--fetch`, no GameFeed
  path of its own). `calibrationSources` (`src/calibration-source.ts`) reads every record: one matched to its game's
  settings record gets the ids back by key (`historyOfRecord`, a key is never reversed) and my cached boards; one
  whose settings record aged out is read on its own (its own settings shape, the stored map by its map id at any age,
  players labelled by position — `anonymousHistoryOfRecord` — and no cached boards, so the opening benchmark only);
  what it skips (no settings, no stored map, a failed pass, a settings record whose pass has not run) is counted and
  printed with the approximations, with why. So one history read per finished game (P2) feeds the profiles, the
  lessons and the harness under one bound and one name-free store (P4). The data comes from the normal end-of-game
  pass (its triggers above); then run the harness. With `WARAPP_PLAYER_PROFILE=off` it reads nothing. Until a pass
  has run there is no truth and the harness says so (no number). No planner decision reads any of it (P1). How to run:
  `docs/PLAN-PROFILES.md` "Calibration and the opening benchmark".

## Commands

`npm run build` (tsc, which emits `dist/**` — what `scripts/calibrate.mjs` imports — then the esbuild bundle) · `npm test` (typecheck + lint + vitest) ·
`npm run test:coverage` (what CI runs: `npm test` plus the coverage thresholds in `vitest.config.ts`) · `npm run typecheck` ·
`npm run lint` (Biome, lint only — no formatter; `biome.json` turns off the house-style rules such as
`noNonNullAssertion`, which `noUncheckedIndexedAccess` makes the idiom). `exactOptionalPropertyTypes`
is off until `src/analysis/planner.ts` is clean under it.
