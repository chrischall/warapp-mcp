# warapp-mcp — plan: overridden bonus values (#62) — PRIORITY

Worktree `/Users/chris/git/warapp-mcp-overrides`, branch `fix/overridden-bonuses` (from `origin/main`).
Never switch branches, never push, never touch other worktrees. Hard rules: no live network in tests
or agents (never call war.app), synthetic fixtures only, never the real account email, a real game id
or player name; never read `~/.config/warapp-mcp/session.json` or `.env`. The cached client bundle
(`~/.config/warapp-mcp/bundle/*.js`) may be READ to learn the setting's type, never copied. TDD;
green = `npm test` AND `npm run build`. Read GitHub issue #62 (`gh issue view 62`).

## O1 — one effective map with the game's bonus values
Live: Local Deployment game, base 2, turn 1; two single-territory bonuses overridden to 12 and 7 →
war.app's income 21 = 2 anywhere + 12 in one bonus + 7 in the other; the tool said 13 and both
pre-checks (deploy total, LD pools) refused the valid turn.
1. **Parse** GameFeed settings `OverriddenBonuses` in `src/normalize.ts` into
   `GameSettings.overriddenBonuses: ReadonlyMap<bonusId, value>`. The exact JSON shape is NOT yet
   verified: learn the type from the bundle's GameSettings (what it serialises), and accept,
   defensively and without throwing: an array of objects with a bonus-id key and a value key (try the
   plausible key spellings, e.g. `bonusID`/`BonusID`/`id` and `value`/`Value`), an object keyed by
   bonus id, and string scalars (every GameFeed scalar may be a string). Unknown shapes → empty map
   plus a recorded "unparsed" flag. Mark the shape UNVERIFIED in `docs/WARAPP-API.md`.
2. **Apply at one choke point:** `applyBonusOverrides(map, settings)` returns a map whose bonuses
   carry the overridden values (superbonuses included). Use it wherever a game's map is combined with
   its settings — every tool that builds a graph for analysis/planning/validation (plan_turn,
   submit_turn's validateTurn and LD pre-check, analyze_board, plan_picks, scout/my-games income if
   any, get_map's game view if it reports values) — so income, LD pools, bonus scoring, "protects +N",
   enemy-deploy estimates and picks all see the game's values. Grep for every `graphOf`/`buildGraph`
   and map use and list them in the commit (applied / not needed).
3. **Fail soft while unverified:** when `OverriddenBonuses` is present but could not be parsed (or is
   non-empty — until the shape is verified live), the deploy-total and LD pre-checks warn instead of
   refusing (war.app enforces both). When it parsed cleanly, `incomeUncertainties` no longer lists
   overrides (the model now applies them) — but keep the soft check until the owner verifies the
   shape (a single constant `OVERRIDES_VERIFIED = false` gates it; document flipping it).
4. **Tests:** the live case as a synthetic LD game (base 2, two single-territory bonuses overridden
   to 12 and 7, held) → income 21, LD pools anywhere 2 / 12 / 7, `validateTurn` accepts the panel's
   split and the plan deploys 21 within the pools; each accepted JSON shape parses; an unparseable
   shape → map values used, soft checks, warning; no overrides → exactly today's behaviour; a
   superbonus override; bonus scoring uses the overridden value (a bonus overridden from +1 to +10 is
   preferred).
Update CLAUDE.md where a stated fact changes. Commit (fix(...): ...). Closes #62.
