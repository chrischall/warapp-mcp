// Strategy notes: the community's heuristics as data, in our own words, each with the
// link it came from (docs/STRATEGY.md lists them and says which are encoded where).
// Pure and deterministic; no I/O. `warapp_strategy` and the `warapp://strategy`
// resource serve them.

import { gameProfile, type GameFormat, type GamePhase, type GameProfile, type ProfilePlayer, type ProfileSettings } from '../analysis/profile.js';
import { bonusTerritories } from '../analysis/bonuses.js';
import type { MapGraph } from '../analysis/graph.js';
import type { BoardState } from '../board.js';
import { armiesToTake, DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE } from '../analysis/combat.js';
import { cardRules } from '../cards.js';
import type { GameSettings } from '../normalize.js';

export const NOTE_TOPICS = ['format', 'settings', 'cards', 'reading', 'opening', 'timing', 'fighting', 'map'] as const;
export type NoteTopic = (typeof NOTE_TOPICS)[number];

/** The pages the notes were researched from (read 2026-11; paraphrased, never copied): the war.app wiki and forum, and community guides they link to. */
export const STRATEGY_SOURCES = {
  general: 'https://war.app/Forum/811395-general-strategy-guidelines',
  oneVsOne: 'https://war.app/Forum/99097-good-1v1-strategies',
  ffa: 'https://war.app/Forum/621189-ffa-strategy',
  combat: 'https://war.app/wiki/Combat_Basics',
  luck: 'https://war.app/wiki/Luck_Modifier',
  cards: 'https://war.app/wiki/Cards',
  moveOrder: 'https://war.app/wiki/Move_order',
  manualDistribution: 'https://war.app/wiki/Manual_distribution',
  turnPhases: 'https://war.app/wiki/Turn_phases',
  orderPriority: 'https://war.app/wiki/Order_priority_card',
  orderDelay: 'https://war.app/wiki/Order_delay_card',
  blockade: 'https://war.app/wiki/Blockade_and_Emergency_Blockade_Cards',
  armyCap: 'https://war.app/wiki/Army_cap',
  noSplit: 'https://war.app/wiki/No-split_mode',
  multiAttack: 'https://war.app/wiki/Multi-attack',
  // The second research pass (read 2026-11-13): more wiki pages, forum threads, and three community
  // guides the wiki links to (the clan guide and two documents).
  localDeployments: 'https://war.app/wiki/Local_deployments',
  forumTeamLadder: 'https://war.app/Forum/394357-2-v-2-ladder-tutorial-final-earth',
  advancedStrategy: 'https://war.app/wiki/Advanced_Strategy',
  ai: 'https://war.app/wiki/AI',
  airlift: 'https://war.app/wiki/Airlift_Card',
  attackTransferOnly: 'https://war.app/wiki/Attack_Only_and_Transfer_Only',
  beginnerGuide: 'https://docs.google.com/document/d/e/2PACX-1vS5eO54w3LgnkcwbLqM3DhynuQGoChrPn313QXIMm0QZ3ApILPuvcunEdmG_nZflHKcfRwCpZfvHA8L/pub',
  bomb: 'https://war.app/wiki/Bomb_Card',
  cardMinimums: 'https://war.app/wiki/Card_minimums',
  cities: 'https://war.app/wiki/Cities_(commerce)',
  clanGuide: 'https://warlight.nghood.com/',
  commanders: 'https://war.app/wiki/Commanders',
  commerce: 'https://war.app/wiki/Commerce',
  diplomacy: 'https://war.app/wiki/Diplomacy_Card',
  fog: 'https://war.app/wiki/Fog',
  forumAiCards: 'https://war.app/Forum/141245-ais-use-blockadegiftdiplomacybomb',
  forumAttackTransferOrders: 'https://war.app/Forum/4440-usefulness-attacktransfer-orders',
  forumAutoDistAnalysis: 'https://war.app/Forum/621318-favorite-cw-template-sead-analysis',
  forumBattleTactics: 'https://war.app/Forum/2557-need-battle-tactics',
  forumBlockadeProposal: 'https://war.app/Forum/1125-proposal-blockade-card',
  forumBombCommander: 'https://war.app/Forum/152187-bombing-territory-commander',
  forumBombStrategy: 'https://war.app/Forum/148237-strategy-bomb-cards',
  forumCommanderTemplate: 'https://war.app/Forum/223845-commander-template-challenge',
  forumDelayCard: 'https://war.app/Forum/412763-delay-card',
  forumFfaGames: 'https://war.app/Forum/4723-best-way-quality-ffa-games',
  forumImprovingGameplay: 'https://war.app/Forum/140529-help-improving-gameplay',
  forumIntelBeforeTurn1: 'https://war.app/Forum/427054-maximize-intel-before-t1',
  forumKeepDelayCard: 'https://war.app/Forum/804335-keep-play-order-delay-card',
  forumKeepingPlayers: 'https://war.app/Forum/169693-keeping-players-game-longer',
  forumKingmaking: 'https://war.app/Forum/699119-kingmaking-reportableagainst-rules',
  forumPickClues: 'https://war.app/Forum/719814-alexclusives-clues',
  forumPickingGuide: 'https://war.app/Forum/434535-1v1-ladder-strategic-picking-guide',
  forumPickOrder: 'https://war.app/Forum/429801-pick-order-issue-1vs1',
  forumSafePicking: 'https://war.app/Forum/42216-safe-picking-play',
  forumSkillChecklist: 'https://war.app/Forum/664334-skill-evaluation-phakh-gokhn',
  forumSmallEarthSeries: 'https://war.app/Forum/551071-small-earth-series-nauzhror-vs-sanmu-shamu',
  forumStrategicTemplates: 'https://war.app/Forum/721296-makes-template-strategic?Offset=120',
  forumTeamStrategy: 'https://war.app/Forum/139981-team-strategy-question',
  guard: 'https://war.app/wiki/One_Army_Must_Stand_Guard',
  mediumEarth: 'https://war.app/wiki/Medium_Earth_Traditional',
  negativeBonuses: 'https://war.app/wiki/Negative_bonuses',
  percentageAttacks: 'https://war.app/wiki/Percentage_attacks',
  sanctions: 'https://war.app/wiki/Sanctions_Card',
  smallEarthGuide: 'https://docs.google.com/document/d/18vq7hPEy3WORXujZJiQVgRPCdaQ-iys9RmFNv7_yq7U',
  specialUnit: 'https://war.app/wiki/Special_unit',
  spyCards: 'https://war.app/wiki/Spy,_Reconnaissance,_and_Surveillance_Cards',
  strategic1v1: 'https://war.app/wiki/Strategic_1_v_1',
  strategyGuideDoc: 'https://docs.google.com/document/d/1YAoH8zzh7uk9-jQwuYzwGll0hsPukq1u8P2lHrTMoqo',
  surrender: 'https://war.app/wiki/Surrender',
  teamGames: 'https://war.app/wiki/Team_Games',
  territoryIncome: 'https://war.app/wiki/Extra_armies_for_territories',
  // The end-game pass (read 2026-11-13): finishing, being behind, stand-offs, leavers and AI seats.
  aiSurrenders: 'https://war.app/wiki/AI_surrenders_when_one_human_remains',
  booting: 'https://war.app/wiki/Booting',
  playersIntoAis: 'https://war.app/wiki/Players_turning_into_AIs',
  voteToEnd: 'https://war.app/wiki/Vote_to_End',
  forumBadSurrender: 'https://war.app/Forum/642777-bad-surrender',
  forumCommanderDeath: 'https://war.app/Forum/156933-commanders-eliminated-ends-turn-player',
  forumFfaLeague: 'https://war.app/Forum/546500-ffa-competition-league',
  forumFfaTruce: 'https://war.app/Forum/5231-ffa-ffa',
  forumGuessMultiBorder: 'https://war.app/Forum/145784-guess-attack-multibordering',
  forumLargeFront: 'https://war.app/Forum/101261-fight-over-large-front',
  forumNeverSurrender: 'https://war.app/Forum/376144-people-never-surrender',
  forumStalemate: 'https://war.app/Forum/41750-strategic-1v1-draw-perfect-play',
  forumTeamCommanders: 'https://war.app/Forum/737712-kabix-2v2-template',
  forumTellingSurrender: 'https://war.app/Forum/118844-telling-opponent-surrender',
  forumTougherOpponents: 'https://war.app/Forum/297674-strategy-facing-tougher-opponents',
  forumTurningAi: 'https://war.app/Forum/3768-turningai-issue',
} as const;

/** Game facts a note may need that the profile does not carry. */
export interface NoteContext {
  /** Percent; absent means the default (60). */
  offensiveKillRate?: number;
  /** Percent; absent means the default (70). */
  defensiveKillRate?: number;
  /** The game's army cap (armies ≤ income × this); `null` / absent when there is none. */
  armyCap?: number | null;
  /** Armies may attack again after a capture in the same turn. */
  multiAttack?: boolean;
  /** The cards in play, by display name ("Order Delay"); absent when not known. */
  cardsInPlay?: readonly string[];
  /** One Army Must Stand Guard; absent means on (the default). */
  oneArmyStandsGuard?: boolean;
  /** GameFeed's `MoveOrder`: `Random`, `Cycle` or `NoLuckCycle`. */
  moveOrder?: string;
  /** Starting territories are ranked picks (`manual`) or dealt out (`automatic`). */
  distribution?: 'manual' | 'automatic';
  /** One army of income per this many territories held (0: off). */
  bonusArmyPer?: number;
  /** The game allows attack-only orders, transfer-only orders, orders by percentage. */
  attackOnlyAllowed?: boolean;
  transferOnlyAllowed?: boolean;
  percentageAllowed?: boolean;
  /** A commerce game (gold buys armies). */
  commerce?: boolean;
  /** The game has wastelands much larger than its ordinary neutrals (at least 5, and twice their size). */
  wastelands?: boolean;
  /** Completing some bonus would cut income in this game ({@link hasCostlyBonus} on the game's map). */
  negativeBonus?: boolean;
}

/**
 * Which games a note is for, as data: every key given must hold, and a key left out does not
 * matter. A condition on something the game did not state (its move order, say) does not hold.
 */
export interface NoteCondition {
  format?: readonly GameFormat[];
  phase?: readonly GamePhase[];
  /** Also holds while the standing is unknown. */
  standing?: readonly ('ahead' | 'even' | 'behind')[];
  /** At least one of these cards is in play (any card, when the game's list is not known). */
  cardsInPlay?: readonly string[];
  anyCards?: true;
  /** GameFeed fog names: NoFog, LightFog, Foggy, ModerateFog, VeryFoggy, ExtremeFog. */
  fog?: readonly string[];
  commanders?: boolean;
  /** One Army Must Stand Guard (on unless the game says otherwise). */
  guard?: boolean;
  multiAttack?: boolean;
  localDeployments?: boolean;
  noSplit?: boolean;
  moveOrder?: readonly string[];
  distribution?: 'manual' | 'automatic';
  /** No luck and straight rounding: every battle ends exactly as the kill rates say. */
  exact?: true;
  /** 60% offence, 70% defence. */
  defaultKillRates?: true;
  /** The defensive kill rate is the higher one. */
  defenceBeatsOffence?: true;
  /** Extra armies for territories is on. */
  territoryIncome?: true;
  attackOnlyAllowed?: true;
  transferOnlyAllowed?: true;
  percentageAllowed?: true;
  commerce?: true;
  wastelands?: true;
  negativeBonus?: true;
}

/** Whether a game with this profile and these settings meets a note's condition. */
export function noteMatches(c: NoteCondition, p: GameProfile, x: NoteContext = {}): boolean {
  const off = x.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const def = x.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  if (c.format && !c.format.includes(p.format)) return false;
  if (c.phase && !c.phase.includes(p.phase)) return false;
  if (c.standing && p.standing !== 'unknown' && !c.standing.includes(p.standing)) return false;
  if (c.cardsInPlay && !(x.cardsInPlay ? x.cardsInPlay.some((n) => c.cardsInPlay!.includes(n)) : p.settings.cards)) return false;
  if (c.anyCards && !p.settings.cards) return false;
  if (c.fog && (p.settings.fog === null || !c.fog.includes(p.settings.fog))) return false;
  if (c.commanders !== undefined && p.settings.commanders !== c.commanders) return false;
  if (c.guard !== undefined && (x.oneArmyStandsGuard ?? true) !== c.guard) return false;
  if (c.multiAttack !== undefined && (x.multiAttack ?? false) !== c.multiAttack) return false;
  if (c.localDeployments !== undefined && p.settings.localDeployments !== c.localDeployments) return false;
  if (c.noSplit !== undefined && p.settings.noSplit !== c.noSplit) return false;
  if (c.moveOrder && (x.moveOrder === undefined || !c.moveOrder.includes(x.moveOrder))) return false;
  if (c.distribution && x.distribution !== c.distribution) return false;
  if (c.exact && !(p.settings.luck === 0 && p.settings.rounding !== 'WeightedRandom')) return false;
  if (c.defaultKillRates && !(off === DEFAULT_OFFENSIVE_KILL_RATE && def === DEFAULT_DEFENSIVE_KILL_RATE)) return false;
  if (c.defenceBeatsOffence && !(def > off)) return false;
  if (c.territoryIncome && !((x.bonusArmyPer ?? 0) > 0)) return false;
  if (c.attackOnlyAllowed && x.attackOnlyAllowed !== true) return false;
  if (c.transferOnlyAllowed && x.transferOnlyAllowed !== true) return false;
  if (c.percentageAllowed && x.percentageAllowed !== true) return false;
  if (c.commerce && x.commerce !== true) return false;
  if (c.wastelands && x.wastelands !== true) return false;
  if (c.negativeBonus && x.negativeBonus !== true) return false;
  return true;
}

/**
 * Whether completing some bonus would cut income: its value plus the value of every bonus that
 * lies inside it comes to less than zero. A negative value alone is not enough — maps built from
 * overlapping "progressive" bonuses use negative entries as offsets, and the full set still pays.
 */
export function hasCostlyBonus(g: MapGraph): boolean {
  if (![...g.bonusById.values()].some((b) => b.value < 0)) return false;
  const all = [...g.bonusById.values()].map((b) => ({ value: b.value, territories: bonusTerritories(g, b.id) })).filter((b) => b.territories.length > 0);
  return all.some((b) => {
    if (b.value >= 0) return false;
    const mine = new Set(b.territories);
    return all.filter((o) => o.territories.every((t) => mine.has(t))).reduce((n, o) => n + o.value, 0) < 0;
  });
}

const flag = (v: unknown): boolean | undefined =>
  v === true || v === 'true' || v === 'True' ? true : v === false || v === 'false' || v === 'False' ? false : undefined;

/** The settings a note's condition may need, from a game's GameFeed settings. */
export function noteContext(settings: GameSettings | undefined): NoteContext {
  if (!settings) return {};
  const raw = settings.raw;
  const out: NoteContext = {};
  if (settings.offensiveKillRate !== undefined) out.offensiveKillRate = settings.offensiveKillRate;
  if (settings.defensiveKillRate !== undefined) out.defensiveKillRate = settings.defensiveKillRate;
  if (settings.armyCap !== undefined) out.armyCap = settings.armyCap;
  if (settings.multiAttack !== undefined) out.multiAttack = settings.multiAttack;
  out.cardsInPlay = cardRules(settings).inPlay;
  if (settings.oneArmyStandsGuard !== undefined) out.oneArmyStandsGuard = settings.oneArmyStandsGuard;
  if (settings.moveOrder !== undefined) out.moveOrder = settings.moveOrder;
  // "Automatic" is what the lobby fixture sends; "Manual" is the client's name for ranked picks and
  // is not verified from a live feed: any other spelling leaves the distribution unknown, which
  // hides the pick notes rather than showing them wrongly.
  const dealt = raw.AutomaticTerritoryDistribution;
  if (dealt === 'Manual' || dealt === 'Automatic') out.distribution = dealt === 'Manual' ? 'manual' : 'automatic';
  if (settings.bonusArmyPer !== undefined) out.bonusArmyPer = settings.bonusArmyPer;
  const attackOnly = flag(raw.AllowAttackOnly);
  if (attackOnly !== undefined) out.attackOnlyAllowed = attackOnly;
  const transferOnly = flag(raw.AllowTransferOnly);
  if (transferOnly !== undefined) out.transferOnlyAllowed = transferOnly;
  const percentage = flag(raw.AllowPercentageAttacks);
  if (percentage !== undefined) out.percentageAllowed = percentage;
  // An empty `Commerce` object is a game without it (the lobby fixture); what a commerce game
  // sends there is not verified, so any content counts as on.
  const commerce = raw.Commerce;
  if (typeof commerce === 'object' && commerce !== null) out.commerce = Object.keys(commerce).length > 0;
  // Wastelands that are walls, not just neutrals: some templates scatter many small ones.
  const wastelands = raw.Wastelands;
  if (typeof wastelands === 'object' && wastelands !== null) {
    const w = wastelands as Record<string, unknown>;
    const size = Number(w.WastelandSize ?? 0);
    out.wastelands = Number(w.NumberOfWastelands ?? 0) > 0 && size >= Math.max(5, 2 * (settings.initialNonDistributionArmies ?? 2));
  }
  return out;
}

export interface StrategyNote {
  id: string;
  topic: NoteTopic;
  /** Whether the note applies to a game with this profile (and these settings). */
  when: (profile: GameProfile, context: NoteContext) => boolean;
  /** The heuristic, in our own words. */
  text: string;
  /** The page it rests on. */
  source: string;
  /**
   * `source`: the linked page states the idea. `derived`: our reasoning from the rule or
   * the advice the linked page gives (the page does not state the note itself).
   */
  basis: 'source' | 'derived';
  /** Where the server acts on it, when it does (else it is advice only). */
  encoded?: string;
}

const S = STRATEGY_SOURCES;
const always = () => true;
const cards = (p: GameProfile) => p.settings.cards;
/** A note's condition as data (see {@link NoteCondition}). */
const on = (c: NoteCondition) => (p: GameProfile, x: NoteContext) => noteMatches(c, p, x);
/** Fog levels that show every territory's owner: nothing about who holds what is hidden. */
const OWNERS_SHOWN = new Set(['NoFog', 'LightFog', 'ModerateFog']);
/** Every battle ends exactly as the kill rates say: no luck, and fractions round straight. */
const exact = (p: GameProfile) => p.settings.luck === 0 && p.settings.rounding !== 'WeightedRandom';
/** The 60/70 breakpoints: two defenders fall to three attackers and three need five. */
const defaultBreakpoints = (rates: NoteContext) => armiesToTake(2, rates) === 3 && armiesToTake(3, rates) === 5;

export const STRATEGY_NOTES: readonly StrategyNote[] = [
  // ---- format ----
  {
    id: '1v1-break-bonuses',
    topic: 'format',
    when: (p) => p.format === '1v1',
    text:
      'Once you touch your one opponent, income decides the game, not kills: take one territory in each of their ' +
      'bonuses to switch it off, rather than trading armies against their stacks.',
    source: S.oneVsOne,
    basis: 'source',
  },
  {
    id: '1v1-contact-ground',
    topic: 'format',
    when: (p) => p.format === '1v1',
    text:
      'Work out early where you will meet the opponent and shape that ground: bonuses you can hold through a narrow ' +
      'front or a bottleneck are worth some income, and an exposed bonus is worth less than its value says.',
    source: S.oneVsOne,
    basis: 'source',
  },
  {
    id: 'ffa-strike-last',
    topic: 'format',
    when: (p) => p.format === 'ffa',
    text:
      'In a free-for-all, let rivals spend their armies on each other and move in afterwards; a war you are not in ' +
      'makes both sides weaker against you.',
    source: S.ffa,
    basis: 'source',
  },
  {
    id: 'ffa-pick-fights',
    topic: 'format',
    when: (p) => p.format === 'ffa',
    text:
      'Choose your fights: know who borders you, keep expanding while you can, and avoid fighting two neighbours at ' +
      'once — a second front splits your deploys while the players behind you grow.',
    source: S.ffa,
    basis: 'derived',
  },
  {
    id: 'ffa-diplomacy',
    topic: 'format',
    when: (p) => p.format === 'ffa',
    text:
      'A truce on one border frees armies for another. Without chat, stop attacking and deploying on a border and ' +
      'many players answer in kind. With chat, fix the terms (turns of notice, a cap on border armies): a truce ' +
      'with no terms ends when it stops paying one side, so keep a guard where a betrayal would hurt most.',
    source: S.ffa,
    basis: 'derived',
  },
  {
    id: 'ffa-big-stack',
    topic: 'format',
    when: (p) => p.format === 'ffa',
    text:
      "A giant enemy stack cannot be everywhere: fill the territories it leaves behind, wall its path with a blockade, " +
      'or wait in the fog and hit where it is heading once you are strong enough.',
    source: S.ffa,
    basis: 'source',
  },
  {
    id: 'teams-focus',
    topic: 'format',
    when: (p) => p.format === 'teams',
    text:
      'With teammates, attack the same opponent together: its one income must cover two fronts. Start with the ' +
      'weaker opponent; once its income is capped and it can no longer hurt you, turn together on the stronger ' +
      'one before it outgrows you.',
    source: S.forumTeamLadder,
    basis: 'source',
  },
  // ---- settings ----
  {
    id: 'settings-efficient-sizes',
    topic: 'settings',
    when: always,
    text:
      'Attack with the smallest army that wins: with exact results every few extra armies kill one more ' +
      'defender and armies between those breakpoints are wasted (with luck or weighted rounding they buy a ' +
      'better chance). At the defaults (60% attack, 70% defence) three attackers take two defenders and ' +
      'five take three.',
    source: S.combat,
    basis: 'source',
    encoded: 'the planner sizes every attack at its breakpoint (src/analysis/combat.ts, warapp_plan_turn)',
  },
  {
    id: 'settings-defend-with-three',
    topic: 'settings',
    // Its numbers are the 60/70 breakpoints: offered only where two defenders fall to
    // three attackers and three need five, and only where results are exact (at 75% luck
    // three against two wins about two times in three).
    when: (p, rates) => exact(p) && defaultBreakpoints(rates),
    text:
      'Leave three, not two, on a border you want to keep cheap to hold: at the default kill rates two defenders fall ' +
      'to three attackers but three need five, so the extra army costs the attacker two.',
    source: S.general,
    basis: 'source',
  },
  {
    id: 'settings-poke',
    topic: 'settings',
    // One attacker must kill one defender for sure: a kill rate of at least 50% and exact results.
    when: (p, rates) => exact(p) && (rates.offensiveKillRate ?? 60) >= 50,
    text:
      'A one-army attack can spoil an opponent\'s breakpoint: it kills one of the armies they counted on, so their ' +
      'attack of exactly the right size falls short. Expect the same against you and keep a margin. Where one ' +
      'army must stand guard it is wasted on a territory holding a single army: that defender survives.',
    source: S.general,
    basis: 'source',
  },
  {
    id: 'settings-move-order',
    topic: 'settings',
    when: always,
    text:
      'Know the move order and sort your orders into three groups: certain strikes and reinforcements first; ' +
      'attacks the opponent could answer last; everything else in between, where it serves as the delay. A heavy ' +
      'attack in the middle of the list is exposed to both a reinforcement and a reply.',
    source: S.general,
    basis: 'source',
  },
  {
    id: 'settings-move-order-zigzag',
    topic: 'settings',
    when: always,
    text:
      'Orders do not simply alternate. Each round every player runs one order, and the order of players ' +
      'reverses from round to round: with two players, first mover, second, second, first, first, and so ' +
      'on, separately in each phase, deployments included. Cyclic and no-luck cycle reverse the players ' +
      'each turn; random redraws them.',
    source: S.moveOrder,
    basis: 'source',
  },
  {
    id: 'settings-attack-second',
    topic: 'settings',
    // Only where a defender kills more per army than an attacker.
    when: (_p, rates) => (rates.defensiveKillRate ?? 70) > (rates.offensiveKillRate ?? 60),
    text:
      'Against a stack about your size, do not attack first: a defender kills more per army, so whoever ' +
      'attacks second fights the survivors. If you attack, list it last; if the stack has not attacked by ' +
      'then, you lose the exchange. Attack as your first order only on a turn you move first and if you win ' +
      "against its owner's whole income.",
    source: S.combat,
    basis: 'derived',
    encoded: 'the planner lists its moves in this order (rule 7, warapp_plan_turn)',
  },
  {
    id: 'settings-contested-neutral',
    topic: 'settings',
    // Its numbers are the 60/70 breakpoints with exact results.
    when: (p, rates) => exact(p) && defaultBreakpoints(rates),
    text:
      'A two-army neutral the opponent can also reach: three attackers leave two survivors, which three armies ' +
      'take straight back. Make that capture your last order, so yours is the one that stands, or send four ' +
      'early: the three survivors then need five.',
    source: S.combat,
    basis: 'derived',
    encoded: 'the planner orders such a capture last, or early when its survivors hold (rule 7)',
  },
  {
    id: 'settings-army-cap',
    topic: 'settings',
    when: (_p, context) => (context.armyCap ?? 0) > 0,
    text:
      'With an army cap you may hold at most your income times the cap, and at the cap no new armies arrive ' +
      '(a Reinforcement card still pays). Near it, spend armies instead of banking them: what dies in a useful ' +
      'attack makes room for the next income.',
    source: S.armyCap,
    basis: 'derived',
  },
  {
    id: 'settings-multi-attack',
    topic: 'settings',
    when: (_p, context) => context.multiAttack === true,
    text:
      'With Multi-Attack an army that captures can attack again in the same turn (a transfer ends its turn), so ' +
      'the threat to a territory is every stack that can chain its way there, not only the one next door. A held ' +
      'line breaks easily: keep small garrisons inside your bonuses and plan to break back.',
    source: S.multiAttack,
    basis: 'derived',
  },
  {
    id: 'settings-no-luck-exact',
    topic: 'settings',
    // Weighted-random rounding makes a breakpoint attack a chance even with no luck.
    when: exact,
    text: 'With no luck every battle ends exactly as the kill rates say, so an attack at its breakpoint never fails: plan to the army.',
    source: S.luck,
    basis: 'source',
    encoded: 'capture costs assume the exact result (src/analysis/combat.ts armiesToTake)',
  },
  {
    id: 'settings-luck-guaranteed',
    topic: 'settings',
    when: (p) => p.settings.luck > 0,
    text:
      "With luck on, part of each side's kills is the average and the rest is a roll. Count only the kills the roll " +
      'cannot take away, and add a margin (or accept a stated chance) on attacks you cannot afford to lose.',
    source: S.luck,
    basis: 'derived',
    encoded: 'exact win chances and min_win_chance (src/analysis/combat.ts winChance, guaranteedKills; warapp_plan_turn)',
  },
  {
    id: 'settings-weighted-rounding',
    topic: 'settings',
    when: (p) => p.settings.rounding === 'WeightedRandom',
    text:
      'Weighted-random rounding turns a fractional kill into a chance of one more, so the straight-rounding ' +
      'breakpoints are no longer certain: one extra army often buys the safety.',
    source: S.luck,
    basis: 'derived',
    encoded: 'win chances model weighted-random rounding (src/analysis/combat.ts winChance)',
  },
  {
    id: 'settings-local-deployments',
    topic: 'settings',
    when: (p) => p.settings.localDeployments,
    text:
      'With Local Deployment the armies a bonus earns can be deployed only inside it; base income, territory ' +
      'income and Reinforcement cards go anywhere. So each bonus must defend itself and a quiet bonus cannot feed ' +
      'the front. A cut in income (negative bonus, army cap, Sanctions) is shared evenly by every pool.',
    source: S.localDeployments,
    basis: 'source',
    encoded: 'deploys are limited to each pool (src/analysis/local-deploy.ts, warapp_plan_turn)',
  },
  {
    id: 'settings-no-split',
    topic: 'settings',
    when: (p) => p.settings.noSplit,
    text:
      'With No-Split a territory that moves sends everything it has, in one attack or transfer a turn: a stack ' +
      'cannot fan out or leave a garrison behind, so a territory that must hold should not move. Stage armies on ' +
      'several territories ahead of the turn you need several attacks.',
    source: S.noSplit,
    basis: 'source',
    encoded:
      'one move per source, each sending the whole stack, and none from a territory that must hold (src/analysis/planner.ts, warapp_plan_turn; #124)',
  },
  // ---- cards ----
  {
    id: 'cards-piece-each-turn',
    topic: 'cards',
    when: cards,
    text:
      "A turn with at least one capture of an enemy or neutral territory earns that turn's card pieces (the " +
      "settings say how many), even if you lose it again; more captures earn nothing extra and a teammate's " +
      'territory does not count. Take the capture when the pieces are worth more than the armies it costs.',
    source: S.cards,
    basis: 'source',
  },
  {
    id: 'cards-order-delay',
    topic: 'cards',
    when: on({ cardsInPlay: ['Order Delay'] }),
    text:
      'Order Delay holds back only the orders listed after it; at the end of your list it does nothing. Put ' +
      'it above every order that is not urgent and keep the decisive attack last. warapp_submit_turn writes ' +
      'the card after all your moves, where it has no effect, so play it in the game client.',
    source: S.orderDelay,
    basis: 'source',
  },
  {
    id: 'cards-order-priority',
    topic: 'cards',
    when: on({ cardsInPlay: ['Order Priority'] }),
    text:
      "Order Priority moves only your first order ahead of the opponent's first: put the one order that must " +
      'beat them at the top (a withdrawal, or a strike on a stack or a commander before it moves). If you would ' +
      'move first anyway it adds nothing, unless they may play one too: two cancel, so yours is what keeps ' +
      'your first move.',
    source: S.orderPriority,
    basis: 'source',
    encoded:
      'the planner puts the protected order first and advises the card (cardAdvice, warapp_plan_turn) for a commander ' +
      'strike or a withdrawal worth a card, only when you hold one and are not known to move first',
  },
  {
    id: 'cards-blockade-own-bonus',
    topic: 'cards',
    when: on({ cardsInPlay: ['Blockade', 'Emergency Blockade'], standing: ['behind'] }),
    text:
      'When you are the weaker side, a Blockade on a territory in front of your bonus (not a member: you give up ' +
      'the territory and its armies) makes a big neutral wall. It resolves after the attacks, is wasted if the ' +
      'territory fell first, and multiplies armies moved in that turn; an Emergency Blockade runs before the attacks.',
    source: S.blockade,
    basis: 'derived',
  },
  {
    id: 'cards-turn-order',
    topic: 'cards',
    when: on({ cardsInPlay: ['Order Priority', 'Order Delay', 'Bomb', 'Emergency Blockade', 'Airlift', 'Gift', 'Blockade', 'Sanctions', 'Spy', 'Reconnaissance', 'Surveillance'] }),
    text:
      'Cards run in a fixed order: Order Priority, Spy-type cards, then Reinforcement, before the deployments; ' +
      'then Bomb, Emergency Blockade, Airlift and Gift, in that order, before any attack; Order Delay among the ' +
      'attacks; Blockade, then Sanctions, after them. So a bomb halves a stack before it is blockaded or flown out.',
    source: S.turnPhases,
    basis: 'source',
    encoded: 'card plays are sent in turn-phase order (src/protocol/methods.ts writeSendOrdersParams)',
  },
  // ---- reading the game ----
  {
    id: 'reading-count-armies',
    topic: 'reading',
    when: always,
    text:
      "Count the armies an opponent shows each turn: what appears beyond their losses is their income, and income " +
      'tells you how far ahead or behind you are.',
    source: S.oneVsOne,
    basis: 'source',
    encoded: 'per-opponent deploy estimates from the board and its trend (warapp_plan_turn enemyDeploy, profile standing)',
  },
  {
    id: 'reading-infer-bonuses',
    topic: 'reading',
    when: (p) => p.settings.fog === null || p.settings.fog === 'Foggy',
    text:
      "An opponent's deploys minus the base income are their bonuses: match that number against the bonuses they " +
      'could hold to find which ones are complete, then aim to break those.',
    source: S.oneVsOne,
    basis: 'derived',
  },
  {
    id: 'reading-unseen-opponent',
    topic: 'reading',
    // Under Light and Dense fog every owner is shown, so its income is read off the board, not assumed.
    when: (p) => !OWNERS_SHOWN.has(p.settings.fog ?? ''),
    text:
      'An opponent you cannot see is growing too. Until its deploys show otherwise, assume it earns about what ' +
      'you earn, and read the first big stack it shows as income saved over the turns you did not see it — not ' +
      'as a one-off.',
    source: S.oneVsOne,
    basis: 'derived',
  },
  {
    id: 'reading-who-moves-first',
    topic: 'reading',
    when: always,
    text:
      'The first deployment or order to run shows the first mover; under a cyclic (not random) order it ' +
      'alternates, and after picks whoever was awarded first moves second on turn 1. Under fog, count your ' +
      'deployments (or your moves) before its first visible one of the same kind: even means it moved ' +
      'first, if one of yours ran later.',
    source: S.moveOrder,
    basis: 'source',
  },
  {
    id: 'reading-pick-zigzag',
    topic: 'reading',
    when: (p, x) => (p.phase === 'opening' || p.phase === 'expansion') && x.distribution !== 'automatic',
    text:
      'Picks are handed out in a zigzag in move order, each player getting their highest-ranked territory still ' +
      'free, so rank enough. Any territory you ranked above your last granted pick and did not get is another ' +
      "player's start; in a two-player game, being granted list number 2 × your starts shows every enemy start.",
    source: S.manualDistribution,
    basis: 'derived',
  },
  {
    id: 'reading-border-neutrals',
    topic: 'reading',
    when: (p) => p.phase !== 'late',
    text:
      'Wait before taking a neutral that borders an enemy: captured armies are thin there, and the opponent can take ' +
      'it back cheaply on the same turn you spent armies on it.',
    source: S.general,
    basis: 'source',
  },
  {
    id: 'reading-idle-armies',
    topic: 'reading',
    when: (p) => p.phase !== 'opening',
    text: 'Armies far from any front do nothing: walk them towards where they will be needed, a little every turn.',
    source: S.ffa,
    basis: 'source',
  },
  {
    id: 'reading-ahead',
    topic: 'reading',
    when: (p) => p.standing === 'ahead' || p.standing === 'unknown',
    text:
      'Ahead on income, use every turn: break a bonus or take ground the opponent cannot retake. Trade armies ' +
      'only where you kill more than you lose, which needs clearly more than the defenders after their ' +
      'deployment (fighting-trade-zones); at the usual kill rates an attack at even numbers costs the attacker ' +
      'more, lead or not.',
    source: S.oneVsOne,
    basis: 'derived',
    encoded: 'ahead in a 1v1, the planner allows more pressure (profile rule 0p, warapp_plan_turn)',
  },
  {
    id: 'reading-behind',
    topic: 'reading',
    when: (p) => p.standing === 'behind' || p.standing === 'unknown',
    text:
      'Behind on income, every turn costs you: any edge you have in armies shrinks every turn, so spend it ' +
      'now on an attack that breaks a bonus, and refuse trades that only swap armies. Defend the bonuses that ' +
      'pay (defence kills more than attack). Stacking and waiting helps only the richer side.',
    source: S.oneVsOne,
    basis: 'derived',
    encoded: 'behind, the profile picks the defend goal and minimal attack sizes (profile rule 0p, warapp_plan_turn)',
  },
  // ---- map ----
  {
    id: 'map-defensible-bonuses',
    topic: 'map',
    when: always,
    text:
      'Value a bonus by what it costs to take and to keep: few territories, few ways in and a narrow front make a ' +
      'small bonus better than a big one you cannot hold.',
    source: S.oneVsOne,
    basis: 'source',
    encoded: 'map notes rank bonuses by value per army and list their entry points (warapp_strategy); picks weigh entry points',
  },
  {
    id: 'map-chokepoints',
    topic: 'map',
    when: always,
    text:
      'Territories that are the only link between regions (bottlenecks) are where small armies stop big ones: hold ' +
      'them in front of your bonuses, and do not leave your back open past them.',
    source: S.oneVsOne,
    basis: 'source',
    encoded: 'map notes and warapp_get_map list the chokepoints',
  },
  // ---- cards: each card, and the card economy (second research pass) ----
  {
    id: 'cards-count-arrival',
    topic: 'cards',
    when: on({ anyCards: true }),
    text:
      'Count when each card arrives: it needs its pieces minus the starting pieces, earned at the per-turn ' +
      'rate only on turns with a capture, and is playable the next turn. With minimums equal to the pieces ' +
      'per turn this is exact per player; a team shares one hand and each capturing teammate is said to add ' +
      'pieces, so it fills faster.',
    source: S.cardMinimums,
    basis: 'derived',
    encoded: "warapp_strategy lists each card's clock for a game (`cardClock`, src/strategy/card-clock.ts)",
  },
  {
    id: 'cards-opponent-reinforcement-due',
    topic: 'cards',
    when: on({ cardsInPlay: ['Reinforcement'] }),
    text:
      'From the first turn an opponent can hold a Reinforcement card, add its armies to what they can ' +
      'deploy against you, every turn until you have seen the extra armies land. A card they have not ' +
      'played is still in their hand.',
    source: S.clanGuide,
    basis: 'derived',
  },
  {
    id: 'cards-reinforcement-play-or-hold',
    topic: 'cards',
    when: on({ cardsInPlay: ['Reinforcement'] }),
    text:
      'In contact, play a Reinforcement card the turn you get it unless holding it has a reason: nothing worth ' +
      'spending it on, making the opponent undercount your next deployment, or a border neither side can ' +
      'break, where cards kept up to the hand limit and played in one turn can tip it when a single card ' +
      'cannot.',
    source: S.smallEarthGuide,
    basis: 'source',
    encoded:
      'the planner plays every Reinforcement card it holds and says the play is a default (in a team game it holds them for the ' +
      'team unless cards must be shed)',
  },
  {
    id: 'cards-delay-keep-threat',
    topic: 'cards',
    when: on({ cardsInPlay: ['Order Delay'] }),
    text:
      'An unplayed Order Delay is a threat in itself: once the opponent has spent theirs and you still hold ' +
      'one, no number of filler moves makes their late attack safe, so they must hold armies back. Play it ' +
      'on the turn it decides a fight, not on the first turn you can.',
    source: S.forumKeepDelayCard,
    basis: 'source',
    encoded: 'forced discards keep Order Delay longest; warapp_plan_turn advises it (cards.advice.orderDelay, with the card order and its `before` for warapp_submit_turn — a placement unverified live) only when an attack the opponent can answer first is planned',
  },
  {
    id: 'cards-delay-opponent-holds',
    topic: 'cards',
    when: on({ cardsInPlay: ['Order Delay'] }),
    text:
      'When an opponent may hold an Order Delay and you do not, do not attack lightly on every border: ' +
      'their delayed counter-attacks then hit your weakened stacks. Make one heavy attack, or defend and ' +
      'let their late stacks break on your defence.',
    source: S.forumDelayCard,
    basis: 'source',
  },
  {
    id: 'cards-bomb-hold',
    topic: 'cards',
    when: on({ cardsInPlay: ['Bomb'] }),
    text:
      'Do not bomb just because you can. The card kills half of whatever stands there, so it is worth more ' +
      'the more the enemy stacks, and while you still hold it they cannot safely build one big stack. Spend ' +
      'it on the turn it wins a fight or saves a border.',
    source: S.forumBombStrategy,
    basis: 'source',
    encoded: 'warapp_plan_turn (cards.advice.bomb) names a target only where halving a stack changes a hold, a capture or a commander kill, else says to hold it',
  },
  {
    id: 'cards-bomb-target',
    topic: 'cards',
    when: on({ cardsInPlay: ['Bomb'] }),
    text:
      'A bomb can only hit a territory next to one of yours. It lands after deployment and before every ' +
      'attack, so it also halves what the enemy deploys there that turn. Aim it at the stack you are about ' +
      'to attack or that is about to attack you, where halving it changes who wins.',
    source: S.bomb,
    basis: 'derived',
  },
  {
    id: 'cards-bomb-split-stacks',
    topic: 'cards',
    when: on({ cardsInPlay: ['Bomb'] }),
    text:
      'While an opponent may hold a Bomb, do not keep everything in one stack beside them: spread it over ' +
      'two or three territories. Deploying one step back and moving up also dodges the bomb (it strikes ' +
      'after deployment, before any move), but only when your move lands before their attack: you move ' +
      'first, or you play Order Priority.',
    source: S.bomb,
    basis: 'source',
    encoded: "warapp_plan_turn warns of borders that hold only while unbombed, once the card clock lets an opponent hold a Bomb (the plan's sizing does not yet halve them)",
  },
  {
    id: 'cards-bomb-commander',
    topic: 'cards',
    when: on({ cardsInPlay: ['Bomb'], commanders: true }),
    text:
      'A bomb is reported to halve only the ordinary armies and leave a commander unharmed (players and the ' +
      "developer say so; the wiki does not cover it). So a bomb on a commander's guard, then one attack big " +
      'enough for what is left plus the commander, is a cheap kill - against yours as well.',
    source: S.forumBombCommander,
    basis: 'derived',
  },
  {
    id: 'cards-emergency-blockade-trap',
    topic: 'cards',
    when: on({ cardsInPlay: ['Emergency Blockade'] }),
    text:
      'An Emergency Blockade can destroy an attack you could not survive: deploy on the territory the big ' +
      'stack must hit and play the card there, and the attackers meet your armies times the multiplier. If ' +
      'they do not attack, you have given away the armies and the territory for nothing.',
    source: S.blockade,
    basis: 'source',
    encoded: 'warapp_plan_turn (cards.advice.emergencyBlockade) offers it on a conceded border where the wall kills more than it gives up, never on the commander or a held bonus',
  },
  {
    id: 'cards-emergency-blockade-opponent',
    topic: 'cards',
    when: on({ cardsInPlay: ['Emergency Blockade'] }),
    text:
      'When an opponent may hold an Emergency Blockade, size the wall before a big attack: their armies on ' +
      'the target plus all they can deploy, times the multiplier. Send a large stack only where even that ' +
      'cannot stop it.',
    source: S.forumStrategicTemplates,
    basis: 'derived',
    encoded: 'warapp_plan_turn warns of a planned attack that wall would stop, once the card clock lets the opponent hold one',
  },
  {
    id: 'cards-blockade-spoil-bonus',
    topic: 'cards',
    when: on({ cardsInPlay: ['Blockade', 'Emergency Blockade'], standing: ['behind'] }),
    text:
      'A bonus you cannot hold is worth ruining. Blockade one of your territories inside it that the enemy ' +
      'cannot take this turn: the big neutral left there denies them the bonus until they pay to clear it.',
    source: S.forumAiCards,
    basis: 'source',
  },
  {
    id: 'cards-blockade-size',
    topic: 'cards',
    when: on({ cardsInPlay: ['Blockade', 'Emergency Blockade'] }),
    text:
      'Size a blockade against what the enemy can bring. The wall is your armies there times the ' +
      'multiplier; unless breaking it costs more than their stack beside it plus a turn of their income, ' +
      'you have only given the territory away. A low multiplier rarely passes that test.',
    source: S.forumBlockadeProposal,
    basis: 'derived',
  },
  {
    id: 'cards-blockade-commander',
    topic: 'cards',
    when: on({ cardsInPlay: ['Blockade', 'Emergency Blockade'], commanders: true }),
    text:
      'Never play a Blockade or Emergency Blockade on the territory your commander stands on: special units ' +
      'count for nothing on a blockaded territory, so treat it as losing the commander, and with it the ' +
      'game.',
    source: S.specialUnit,
    basis: 'derived',
  },
  {
    id: 'cards-airlift-defend',
    topic: 'cards',
    when: on({ cardsInPlay: ['Airlift'] }),
    text:
      'An airlift lands before any attack, so its strongest use is defence: fly a stack onto the territory ' +
      'the enemy is about to hit and their attack runs into it. The flown armies cannot move or attack ' +
      'again that turn, so it does not set up an attack this turn.',
    source: S.airlift,
    basis: 'source',
  },
  {
    id: 'cards-airlift-opponent',
    topic: 'cards',
    when: on({ cardsInPlay: ['Airlift'] }),
    text:
      'While an opponent may hold an Airlift, any territory you attack can be reinforced from anywhere ' +
      'before your attack lands. Count their largest stack you have seen as a possible defender, and attack ' +
      'where you would still win, or not at all.',
    source: S.forumStrategicTemplates,
    basis: 'derived',
  },
  {
    id: 'cards-diplomacy-starts-next-turn',
    topic: 'cards',
    when: on({ cardsInPlay: ['Diplomacy'] }),
    text:
      'A Diplomacy card starts the turn after it is played. If you play one, your attacks on that player in ' +
      'the same turn still happen. Once you see one played on you it is already in force: attacks on that ' +
      'player do nothing, so take them out of your orders and plan for the turn it ends.',
    source: S.diplomacy,
    basis: 'derived',
  },
  {
    id: 'cards-diplomacy-target',
    topic: 'cards',
    when: on({ cardsInPlay: ['Diplomacy'], format: ['ffa', 'teams'] }),
    text:
      'Diplomacy pays only with two or more enemies. Play it on the one attacking you hardest, not on a ' +
      'strong neighbour who is leaving you alone, and not when you are the one winning the fights; use the ' +
      'quiet turns for something that border would not have allowed.',
    source: S.forumAiCards,
    basis: 'source',
  },
  {
    id: 'cards-sanctions-sign-and-timing',
    topic: 'cards',
    when: on({ cardsInPlay: ['Sanctions'] }),
    text:
      "Read the Sanctions percentage first: a negative one raises the target's income, so that card goes on " +
      "yourself or a teammate. A normal one resolves at the end of the turn and cuts the target's income " +
      'from their next turn; Reinforcement cards are added after it and still pay in full.',
    source: S.sanctions,
    basis: 'derived',
  },
  {
    id: 'cards-gift-enemy-teammate',
    topic: 'cards',
    when: on({ cardsInPlay: ['Gift'], format: ['teams'] }),
    text:
      "In a team game a territory about to fall can be gifted to the attacker's teammate: by default the " +
      'attack becomes a transfer and the bonus stays incomplete that turn. If the other team may hold a ' +
      'Gift card, a bonus-completing capture must treat teammates as enemies ' +
      '(`attack_teammates` in warapp_submit_turn, not yet verified live).',
    source: S.clanGuide,
    basis: 'source',
  },
  {
    id: 'cards-spy-turn-ahead',
    topic: 'cards',
    when: on({ cardsInPlay: ['Spy', 'Reconnaissance', 'Surveillance'], fog: ['LightFog', 'Foggy', 'ModerateFog', 'VeryFoggy', 'ExtremeFog'] }),
    text:
      'A Spy, Reconnaissance or Surveillance card shows its view next turn, so play it the turn before the ' +
      "decision it should inform: Surveillance to learn whether a bonus is held, Spy for one opponent's " +
      'whole position, Reconnaissance for what stands behind a border you mean to attack or defend.',
    source: S.spyCards,
    basis: 'derived',
  },
  // ---- settings: commanders, the guard, income, commerce (second research pass) ----
  {
    id: 'settings-commander-protect',
    topic: 'settings',
    when: on({ commanders: true }),
    text:
      'Losing your Commander eliminates you and turns everything you hold neutral. Each turn, first check ' +
      'that no stack beside it could kill every army with it and deal 7 more in one attack; if one could, ' +
      'deploy on its territory. It moves only when an order sets `commander`, so do not strip its guard. ' +
      'Never Blockade its territory.',
    source: S.commanders,
    basis: 'source',
    encoded: "the planner holds its commander's territory before anything else and never carries the commander (warapp_submit_turn does when a move sets `commander`)",
  },
  {
    id: 'settings-commander-strike',
    topic: 'settings',
    when: on({ commanders: true }),
    text:
      'An enemy Commander dies only to one attack that kills every army with it and then deals 7 more; ' +
      'less leaves it unharmed. That removes its owner, and all it held turns neutral where it stands. Against ' +
      "one opponent, strike first when a stack covers its armies, its 7 and its owner's deploy; with more " +
      'sides, first see who collects the land.',
    source: S.commanders,
    basis: 'derived',
    encoded: "the planner strikes an adjacent enemy commander first, sized for its armies, its 7 and its owner's deploy",
  },
  {
    id: 'settings-commander-free-captures',
    topic: 'settings',
    when: on({ commanders: true, phase: ['opening', 'expansion'] }),
    text:
      'A Commander attacking alone fights as 7 armies and is unharmed by less than 7 damage, so it can take ' +
      'small neutrals at no cost. To send it, set `commander` on the move in warapp_submit_turn (with ' +
      '`armies` 0 it goes alone; not yet verified live); without it, an order from its territory sends only armies and thins its guard.',
    source: S.forumCommanderTemplate,
    basis: 'source',
  },
  {
    id: 'settings-guard-off-taps',
    topic: 'settings',
    when: on({ guard: false }),
    text:
      'With no army required to stay behind, a territory can be left empty, and any single army then ' +
      'captures it; against one defender a single attacker only trades. Send one army at empty enemy border ' +
      'territories to break bonuses, and keep armies on every border territory of a bonus you hold.',
    source: S.guard,
    basis: 'derived',
  },
  {
    id: 'settings-territory-income-threshold',
    topic: 'settings',
    when: on({ territoryIncome: true }),
    text:
      'Income from territories replaces the base income only when it is the larger of the two, so more ' +
      'territories pay nothing until your count divided by the setting exceeds the base. Past that point ' +
      'each further group of territories is one army a turn, and cheap neutrals are worth taking for ' +
      'themselves.',
    source: S.territoryIncome,
    basis: 'source',
    encoded: 'the income model (`boardIncome`) takes the larger of the base and the territory income',
  },
  {
    id: 'settings-negative-bonus',
    topic: 'settings',
    when: on({ negativeBonus: true }),
    text:
      'A bonus worth less than zero cuts your income while you hold all of it, unless other bonuses on the ' +
      'same territories pay more than it costs, and you cannot give a territory up at will. Stop one ' +
      'territory short of completing it; if you hold it, a Blockade or Gift on one of its territories is ' +
      'the way out.',
    source: S.negativeBonuses,
    basis: 'source',
  },
  {
    id: 'settings-commerce-army-price',
    topic: 'settings',
    when: on({ commerce: true }),
    text:
      'Unless the game sets a flat price, armies bought in one turn get dearer in steps, so the same gold ' +
      'buys more armies spread over several turns than saved and spent at once. Buy steadily, and save only ' +
      "for a turn that needs a bigger stack than one turn's gold can raise.",
    source: S.commerce,
    basis: 'derived',
  },
  {
    id: 'settings-commerce-cities',
    topic: 'settings',
    when: on({ commerce: true }),
    text:
      'Where the game sells cities: a city pays gold every turn to whoever holds its territory and is never ' +
      'destroyed, so a captured city pays the captor. Build far from any enemy, spread them (by default ' +
      'each further city on one territory costs more), and buy armies instead when an attack is near.',
    source: S.cities,
    basis: 'derived',
  },
  // ---- opening: picks and the first turns (second research pass) ----
  {
    id: 'opening-pick-guarantees',
    topic: 'opening',
    when: on({ format: ['1v1'], distribution: 'manual', phase: ['opening'] }),
    text:
      'With two or more starts each in a two-player game you cannot lose both your first and second listed ' +
      'picks, nor both your first and third; losing the first gives you the second and third. So an area ' +
      'you must be in is secured by ranking two of its territories 1 and 2, or 1 and 3.',
    source: S.forumPickOrder,
    basis: 'source',
  },
  {
    id: 'opening-safe-with-neighbour',
    topic: 'opening',
    when: on({ distribution: 'manual', phase: ['opening'] }),
    text:
      'A bonus is only as safe as the pickable territories that can reach it before it pays. If one ' +
      'neighbouring pick threatens the bonus you mean to take first, rank that pick among your top picks ' +
      'too: granted both, expand there freely; refused it, another player starts there. Ranked below your ' +
      'last granted pick, it tells you nothing.',
    source: S.forumSafePicking,
    basis: 'source',
  },
  {
    id: 'opening-pair-order',
    topic: 'opening',
    when: on({ format: ['1v1'], distribution: 'manual', phase: ['opening'], commanders: false }),
    text:
      'When two picks only pay off together and the opponent may want the same two, expect one each. Rank ' +
      'first the one that does better alone against the other: the one whose bonus is harder to break, or ' +
      "that reaches the other's bonus first. That is not always the bonus you are after.",
    source: S.forumPickingGuide,
    basis: 'source',
  },
  {
    id: 'opening-counter-stands-alone',
    topic: 'opening',
    when: on({ distribution: 'manual', phase: ['opening'] }),
    text:
      'Pick a territory to break a bonus you expect the opponent to take only if its own bonus is worth ' +
      'finishing. If they are not there you must be able to carry on and take it yourself; a pick that is ' +
      'useless unless the guess is right leaves you one start short.',
    source: S.forumPickClues,
    basis: 'source',
  },
  {
    id: 'opening-commit-speed',
    topic: 'opening',
    when: on({ format: ['1v1'], distribution: 'manual', moveOrder: ['NoLuckCycle'], phase: ['opening'] }),
    text:
      "Under no-luck cycle the pick order goes to the faster player: by one guide's account the clock runs " +
      'from pressing Begin to committing, so committing early in the day is not what counts. The faster ' +
      'gets the first award and the first move on turn 2; the slower the award or two after it and the ' +
      'first move on turn 1.',
    source: S.forumSkillChecklist,
    basis: 'source',
  },
  {
    id: 'opening-wastelands',
    topic: 'opening',
    when: on({ phase: ['opening', 'expansion'], wastelands: true }),
    text:
      'A wasteland much larger than the ordinary neutrals makes its bonus slow: do not start in it or ' +
      "expand into it first, as its cost comes back only after several turns of that bonus's income. It is " +
      'also a wall: between an enemy start and your bonus it protects; on your own way out it strands ' +
      'armies. A small one is just a neutral.',
    source: S.mediumEarth,
    basis: 'source',
  },
  {
    id: 'opening-automatic-no-intel',
    topic: 'opening',
    when: on({ distribution: 'automatic', phase: ['opening'] }),
    text:
      'With automatic distribution no pick list shows where the others are or who moves first, but the deal ' +
      'narrows it: where each bonus holds one start, theirs are in bonuses you did not get. Plan against ' +
      'the most dangerous of those until scouting rules it out, read the move order from first orders, and ' +
      'do not resign over the deal.',
    source: S.forumAutoDistAnalysis,
    basis: 'source',
  },
  {
    id: 'opening-first-turn-bonus-second-mover',
    topic: 'opening',
    when: on({ phase: ['opening'] }),
    text:
      'Finishing a bonus on turn 1 can cost it on turn 2: an enemy start one move from its border can ' +
      'arrive with its stack and a full deploy, and if they move first on turn 2 you cannot answer in time. ' +
      'Unless you know you move first on turn 2, with such a start possible finish a turn later or hold the ' +
      'approach first.',
    source: S.forumSmallEarthSeries,
    basis: 'source',
  },
  {
    id: 'opening-one-bonus-at-a-time',
    topic: 'opening',
    when: on({ phase: ['opening', 'expansion'], localDeployments: false }),
    text:
      "Do not split a turn's income between two unfinished bonuses: both then finish later. Put it all into " +
      'the bonus that completes soonest, and split only when each share finishes something this turn or one ' +
      'share is needed to hold a border.',
    source: S.beginnerGuide,
    basis: 'source',
    encoded: 'the planner commits to the bonus closest to completion until one is held (rule 4f)',
  },
  {
    id: 'opening-capture-survivors',
    topic: 'opening',
    when: on({ exact: true, defaultKillRates: true, phase: ['opening', 'expansion'] }),
    text:
      'Smallest sure captures and what moves in: 3 armies take a 2 and 2 move in; 5 take a 3 (3 move in); 6 ' +
      'take a 4 (3); 8 take a 5 (4); 16 take a 10 (9). One army more adds a survivor, not a kill, so send ' +
      'it only when that survivor has a job next turn.',
    source: S.combat,
    basis: 'derived',
  },
  {
    id: 'opening-chain-captures',
    topic: 'opening',
    when: on({ phase: ['opening', 'expansion'] }),
    text:
      'Plan a route, not single captures: the survivors of one capture launch the next. Size the last ' +
      'capture at its minimum and each earlier one to deliver what the next needs, plus the army that must ' +
      'stay behind where one must, so a single deployment carries down the whole chain.',
    source: S.forumSkillChecklist,
    basis: 'source',
  },
  {
    id: 'opening-tap-then-capture',
    topic: 'opening',
    when: on({ exact: true, defaultKillRates: true, phase: ['opening', 'expansion'], noSplit: false }),
    text:
      'Two orders can take what one cannot afford: a 1-army attack first kills one defender, so the capture ' +
      'behind it needs fewer armies (a 3 falls to 1 then 3 instead of 5; a 5 to 1 then 6 instead of 8). ' +
      'Losses are the same; it costs an extra order and one survivor fewer.',
    source: S.forumSkillChecklist,
    basis: 'source',
  },
  {
    id: 'opening-hide-expansion',
    topic: 'opening',
    when: on({ fog: ['Foggy'], phase: ['opening', 'expansion'] }),
    text:
      'Where the opponent sees only territory next to their own, they learn your income from what you ' +
      'deploy and capture in their sight. Finish bonuses out of view, take the territory that touches them ' +
      'as late as the plan allows, and deploy out of sight when the armies can walk up in time.',
    source: S.smallEarthGuide,
    basis: 'source',
  },
  // ---- timing: the order of orders within a turn (second research pass) ----
  {
    id: 'timing-first-order-certain',
    topic: 'timing',
    when: on({ moveOrder: ['Cycle', 'NoLuckCycle'], phase: ['contact', 'late'] }),
    text:
      "On a turn you move first, your first attack or transfer runs before any of the opponent's, unless it " +
      'plays Order Priority. Give it to the order that must not be answered: a strike that beats the ' +
      "defenders plus their owner's whole income and any card armies, a stack leaving a lost territory, or " +
      'a reinforcement that must arrive.',
    source: S.beginnerGuide,
    basis: 'source',
  },
  {
    id: 'timing-reinforce-first',
    topic: 'timing',
    when: on({ phase: ['contact', 'late'] }),
    text:
      'List reinforcing transfers at the top of the turn, the largest or the one to the weakest territory ' +
      'first, and as one order rather than several small ones: every enemy order that runs before they ' +
      'arrive is a chance to hit that territory without them.',
    source: S.advancedStrategy,
    basis: 'source',
  },
  {
    id: 'timing-dummy-must-move',
    topic: 'timing',
    when: always,
    text:
      'A dummy order pushes your later orders back only if armies actually move. A Transfer Only that ' +
      'cannot transfer, or an order from a territory with nothing left to send, delays nothing: pad a late ' +
      'attack with real transfers of spare armies or cheap captures.',
    source: S.moveOrder,
    basis: 'source',
  },
  {
    id: 'timing-delay-pairs',
    topic: 'timing',
    when: on({ format: ['1v1'], phase: ['contact', 'late'] }),
    text:
      'Orders run in pairs: moving first, your 2nd and 3rd run back to back (then 4th and 5th); moving ' +
      'second, your 1st and 2nd. So one more dummy order helps only every other time. Count the orders the ' +
      'opponent can make, pad a late attack just past that (one extra if unsure who is first), and keep the ' +
      'other armies at the front.',
    source: S.moveOrder,
    basis: 'derived',
  },
  {
    id: 'timing-deploy-border-first',
    topic: 'timing',
    when: on({ fog: ['LightFog', 'Foggy', 'ModerateFog', 'VeryFoggy', 'ExtremeFog'] }),
    text:
      'Deployments are dealt out in turn like orders, so their order is information. Deploy next to the ' +
      'opponent first and in the back afterwards: a deployment out of its sight that lands before your ' +
      'border one tells it you had income to spare, and lets it count how much.',
    source: S.clanGuide,
    basis: 'source',
  },
  {
    id: 'timing-transfer-only-reinforce',
    topic: 'timing',
    when: on({ transferOnlyAllowed: true }),
    text:
      'When you move armies into a territory of yours that the enemy could take first this turn, make the ' +
      'order Transfer Only: if it has fallen, the armies stay put instead of attacking the stack that took ' +
      'it. In warapp_submit_turn, set the move\'s mode "transfer-only" (not yet verified live); a plain order would attack.',
    source: S.attackTransferOnly,
    basis: 'source',
  },
  {
    id: 'timing-attack-only-retake',
    topic: 'timing',
    when: on({ attackOnlyAllowed: true }),
    text:
      'To answer an attack you only suspect, give a late Attack Only order onto your own threatened ' +
      'territory from a neighbouring stack big enough to beat what would survive taking it: it strikes only ' +
      'if the territory fell. In warapp_submit_turn, set the move\'s mode "attack-only" (not yet verified live); a plain order would ' +
      'be a transfer.',
    source: S.forumAttackTransferOrders,
    basis: 'source',
  },
  {
    id: 'timing-percentage-remainder',
    topic: 'timing',
    when: on({ percentageAllowed: true }),
    text:
      'A percentage order is worked out when it runs, from the armies still able to move, so an enemy ' +
      'attack that lands first shrinks what it sends, not the share that stays. Use one when the armies ' +
      'left behind matter more. In warapp_submit_turn, set `percent` on the move and give the percentage as `armies` ' +
      '(not yet verified live).',
    source: S.percentageAttacks,
    basis: 'source',
  },
  // ---- fighting: stacks in contact, ahead and behind (second research pass) ----
  {
    id: 'fighting-trade-zones',
    topic: 'fighting',
    when: on({ defaultKillRates: true, exact: true, phase: ['contact', 'late'] }),
    text:
      "Size an attack on a stack against its armies after its owner's deployment. Below roughly seven " +
      'sixths of that number you lose more than you kill; from there to about five thirds you kill more ' +
      'without capturing, still a good exchange; above that you capture (small stacks a little sooner: ' +
      'three take two).',
    source: S.combat,
    basis: 'derived',
  },
  {
    id: 'fighting-ahead-worst-case',
    topic: 'fighting',
    when: on({ standing: ['ahead'], format: ['1v1', 'teams'] }),
    text:
      'Ahead, pick the plan that still works when the opponent guesses right: holds that survive its whole ' +
      'income, attacks sized for its full deployment, and no more armies than each objective needs. Time is ' +
      'on your side, so the gambles belong to the player who is behind.',
    source: S.smallEarthGuide,
    basis: 'derived',
    encoded: "warapp_check_plan runs a list of orders against the opponent's single-deploy replies",
  },
  {
    id: 'fighting-doomed-stack',
    topic: 'fighting',
    when: (p, x) => noteMatches({ phase: ['contact', 'late'] }, p, x) && (x.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE) < 100,
    text:
      'A stack that is wiped out on defence kills fewer armies than it loses. If the attackers in reach can ' +
      'take it even after your deployment, do not reinforce it: move it back to where it can be joined, and ' +
      'spend the income on a break where the opponent is weak.',
    source: S.forumBattleTactics,
    basis: 'source',
    encoded: 'the planner concedes a border it cannot hold and withdraws from it',
  },
  {
    id: 'fighting-pin',
    topic: 'fighting',
    when: on({ format: ['1v1', 'teams'], phase: ['contact', 'late'], exact: true }),
    text:
      "Where, counting both sides' deployments, each exchange leaves your stack larger relative to theirs, " +
      'keep attacking even at a small loss: a defender that is only just holding cannot deploy one army ' +
      'elsewhere without losing the territory a few turns later. Stop the turn the ratio stops improving.',
    source: S.forumSkillChecklist,
    basis: 'source',
  },
  {
    id: 'fighting-cover-valuable-attack-cheap',
    topic: 'fighting',
    when: on({ format: ['1v1', 'teams'], phase: ['contact', 'late'] }),
    text:
      'When you can cover only one of two threatened points, cover the more valuable one most turns but not ' +
      'every turn; when you can hit only one of two, go for the less valuable one more often. Always ' +
      'guarding the big bonus, or always striking at it, is a pattern the other side can plan around.',
    source: S.clanGuide,
    basis: 'source',
  },
  {
    id: 'fighting-standoff-grow-elsewhere',
    topic: 'fighting',
    when: on({ format: ['1v1', 'teams'], phase: ['contact', 'late'] }),
    text:
      'When two big stacks face each other, count the next turns out before calling it stuck. If attacking every ' +
      'turn breaks it, do that; if the opponent could do that to you, keep deploying what holds. Only armies ' +
      'beyond that are surplus: put them into a bonus the opponent cannot see or reach, if every hold still ' +
      'survives.',
    source: S.forumSkillChecklist,
    basis: 'derived',
  },
  {
    id: 'fighting-go-round',
    topic: 'fighting',
    when: on({ phase: ['contact', 'late'] }),
    text:
      'Stuck at a walled border, look for the other way in: a wasteland beside a blockade is often the ' +
      'cheaper obstacle, and a neighbour that touches the enemy bonus in two places makes the defender ' +
      'guess. Do not spend the main stack breaking a large blockade when another route or bonus pays ' +
      'sooner.',
    source: S.smallEarthGuide,
    basis: 'source',
  },
  {
    id: 'fighting-hidden-stack',
    topic: 'fighting',
    when: on({ fog: ['LightFog', 'Foggy', 'ModerateFog', 'VeryFoggy', 'ExtremeFog'], phase: ['contact', 'late'], moveOrder: ['Cycle', 'NoLuckCycle'] }),
    text:
      'A transfer between two territories the opponent cannot see is invisible to it. Build a stack one ' +
      'step behind the front and, on a turn you are sure to move first, transfer it with your first order ' +
      'into the territory its stack is about to take, enough to make that attack fail. If it falls first, ' +
      'the transfer is an attack.',
    source: S.forumSkillChecklist,
    basis: 'source',
  },
  {
    id: 'fighting-trade-bonus-up',
    topic: 'fighting',
    when: on({ format: ['1v1', 'teams'], phase: ['contact', 'late'], standing: ['even', 'behind'] }),
    text:
      'If the stack attacking your bonus stands on a territory of a richer bonus of its own, hold a stack ' +
      'back, pad your list, and take that territory with your last order once its armies have left: you ' +
      'lose the smaller bonus, it loses the bigger. It works only if the stack attacks; send no more than ' +
      'you can afford to lose if it stays.',
    source: S.forumSkillChecklist,
    basis: 'source',
  },
  // ---- reading: fog, picks and what the opponent shows (second research pass) ----
  {
    id: 'reading-fog-owners-shown',
    topic: 'reading',
    when: on({ fog: ['LightFog', 'ModerateFog'] }),
    text:
      "This fog level shows the owner of every territory, so an opponent's income is not a guess: add the " +
      'bonuses it holds in full to its base or territory income. Only army counts are hidden, so follow ' +
      'what it earns and loses each turn to judge how large its unseen stacks can be.',
    source: S.fog,
    basis: 'derived',
  },
  {
    id: 'reading-fog-border-armies-hidden',
    topic: 'reading',
    when: on({ fog: ['ModerateFog', 'VeryFoggy'] }),
    text:
      'At this fog level even the territories next to yours show only their owner, never their armies. Do ' +
      'not size a hold or an attack from the board: reckon what the opponent can have there from its income ' +
      'and its losses, and keep a margin for what you cannot see.',
    source: S.fog,
    basis: 'derived',
  },
  {
    id: 'reading-fog-attacks-reveal',
    topic: 'reading',
    when: on({ fog: ['LightFog', 'Foggy', 'ModerateFog', 'VeryFoggy', 'ExtremeFog'] }),
    text:
      'Every attack on your own territory shows where it came from, whose it was and how many armies were ' +
      "sent, even out of the fog. One onto another player's territory shows its size only if it captured, " +
      "and only where you can see that territory's armies. Note each with its turn: it fixes a stack you " +
      'cannot otherwise see.',
    source: S.fog,
    basis: 'source',
  },
  {
    id: 'reading-stack-arrival',
    topic: 'reading',
    when: on({ fog: ['LightFog', 'Foggy', 'ModerateFog', 'VeryFoggy', 'ExtremeFog'], phase: ['contact', 'late'] }),
    text:
      'When a stack you saw goes out of view, count the turns it needs to walk to each of your borders and ' +
      'expect it from that turn on. Do not advance toward where it must be unless you are sure to move ' +
      'first; and when a deployment drops with no fight to explain it, add the missing armies to that ' +
      'stack.',
    source: S.forumImprovingGameplay,
    basis: 'source',
  },
  {
    id: 'reading-deploy-order-leak',
    topic: 'reading',
    when: on({ fog: ['LightFog', 'Foggy', 'ModerateFog', 'VeryFoggy', 'ExtremeFog'] }),
    text:
      "Deployments alternate like orders. When more of yours run before an opponent's first visible " +
      'deployment than the move order allows, it has deployed somewhere out of your sight first, so its ' +
      'income is larger than what arrives at your border.',
    source: S.clanGuide,
    basis: 'source',
  },
  {
    id: 'reading-pick-move-order',
    topic: 'reading',
    when: on({ format: ['1v1'], distribution: 'manual', moveOrder: ['Cycle', 'NoLuckCycle'], phase: ['opening', 'expansion'] }),
    text:
      'Under a cyclic move order the pick award is turn 0: whoever was awarded first moves second on turn 1 ' +
      'and first on turn 2. If your k-th granted pick was number 2k on your list you know which: k odd, you ' +
      'were awarded second and move first on turn 1; k even, the reverse.',
    source: S.forumIntelBeforeTurn1,
    basis: 'source',
  },
  {
    id: 'reading-unpicked-starts',
    topic: 'reading',
    when: on({ distribution: 'manual', phase: ['opening', 'expansion'] }),
    text:
      'A pickable territory nobody was granted turns into a neutral of the in-distribution size. When you ' +
      'see one still neutral at that size, cross it off the list of possible enemy starts; plan captures ' +
      'through it at that size, which is often more than an ordinary neutral.',
    source: S.strategic1v1,
    basis: 'derived',
  },
  {
    id: 'reading-opponent-opening-pace',
    topic: 'reading',
    when: on({ distribution: 'manual', phase: ['opening', 'expansion'], fog: ['Foggy', 'VeryFoggy', 'ExtremeFog'] }),
    text:
      'Before you can see the opponent, price their best start: from the pickable territories you were not ' +
      'granted, work out which bonuses fall on turn 1 or 2 and the income that gives by turn 3. Size your ' +
      'first borders against that pace, not against base income.',
    source: S.forumPickingGuide,
    basis: 'derived',
  },
  {
    id: 'reading-commander-first-award',
    topic: 'reading',
    when: on({ format: ['1v1'], distribution: 'manual', commanders: true, phase: ['opening', 'expansion'] }),
    text:
      'A commander starts on the first territory its player was awarded. In a two-player game, if you did ' +
      'not get your first pick, the opponent was awarded it first and their commander is on it. If you got ' +
      'your first and third picks but not your second, their commander is on your second for certain only ' +
      'if you were awarded second.',
    source: S.commanders,
    basis: 'derived',
  },
  // ---- format: free-for-all and teams (second research pass) ----
  {
    id: 'ffa-leader-only',
    topic: 'format',
    when: on({ format: ['ffa'], phase: ['contact', 'late'], standing: ['even', 'behind'] }),
    text:
      'With a clear leader who is not you, the smaller players lose by fighting each other. Attack a ' +
      "smaller neighbour only if its income added to yours would match the leader's; otherwise hold that " +
      'border and attack the leader only where the exchange favours you. With three left, hitting the ' +
      'weakest hands the leader the game.',
    source: S.forumKeepingPlayers,
    basis: 'derived',
  },
  {
    id: 'ffa-hide-strength',
    topic: 'format',
    when: on({ format: ['ffa'] }),
    text:
      'The armies neighbours see you deploy are what they count. Where fog hides it, deploy out of their ' +
      'sight and move up when you can spare the turn; everywhere, keep border stacks no larger than the ' +
      'hold needs: where every owner is visible, the largest player is the one the others combine against.',
    source: S.advancedStrategy,
    basis: 'source',
  },
  {
    id: 'ffa-peaceful-stacker',
    topic: 'format',
    when: on({ format: ['ffa'], phase: ['contact', 'late'] }),
    text:
      'The player at peace with both of its neighbours while they fight is the real leader. Rank opponents ' +
      'by the armies they have built as well as by income, and expect it to turn on the weaker neighbour ' +
      'when that fight ends.',
    source: S.forumFfaGames,
    basis: 'derived',
  },
  {
    id: 'ffa-finish-or-spare',
    topic: 'format',
    when: on({ format: ['ffa'], phase: ['contact', 'late'] }),
    text:
      'A player you have broken but not eliminated has nothing left to lose and may throw every army at ' +
      'you. Either take its last territories, or do not cripple it and leave it able to fight someone else.',
    source: S.forumKingmaking,
    basis: 'derived',
  },
  {
    id: 'ffa-neighbour-leaves',
    topic: 'format',
    when: on({ format: ['ffa'] }),
    text:
      'When a neighbour surrenders or is booted, its land goes to an AI or turns neutral (set separately ' +
      "for each; neutral after a boot is players' report), and any truce ends. Neutral land keeps its " +
      'armies, so thin bonuses there are cheap. An AI fights on, goes for neutral bonuses first, and its ' +
      'player may take the seat back.',
    source: S.playersIntoAis,
    basis: 'derived',
  },
  {
    id: 'teams-score-team',
    topic: 'format',
    when: on({ format: ['teams'] }),
    text:
      'Judge your turn by what the team gains. Tying down two opponents while a teammate takes bonuses is a ' +
      'good trade even if you stay on base income all game; expanding for yourself instead of fighting ' +
      'there is the usual mistake.',
    source: S.clanGuide,
    basis: 'source',
  },
  {
    id: 'teams-one-owner-per-bonus',
    topic: 'format',
    when: on({ format: ['teams'] }),
    text:
      'A bonus pays only when one player holds every territory in it. Settle who owns each bonus; the other ' +
      'teammate moves out all but one army, then the owner takes the territory with an order set to treat ' +
      'teammates as enemies (no card piece): `attack_teammates` in warapp_submit_turn (not yet ' +
      'verified live); a ' +
      'plain order there is a transfer.',
    source: S.teamGames,
    basis: 'source',
  },
  {
    id: 'teams-transfer-not-deploy',
    topic: 'format',
    when: on({ format: ['teams'] }),
    text:
      "You may transfer armies onto a teammate's territory but never deploy there. Pass idle armies across " +
      "a shared border to the teammate nearer the fight: they are the teammate's from then on, and can be " +
      'used from the next turn.',
    source: S.teamGames,
    basis: 'derived',
  },
  {
    id: 'teams-shared-hand',
    topic: 'format',
    when: on({ format: ['teams'], anyCards: true }),
    text:
      'A team holds one hand of cards between its players, with one limit on how many it may keep. Before ' +
      "you play a card, check which teammate's turn gains most from it and that it has not been played " +
      'already: played by whoever commits first, it is gone for the teammate in the fight that decides the ' +
      'game.',
    source: S.teamGames,
    basis: 'source',
  },
  {
    id: 'teams-reinforce-capture',
    topic: 'format',
    when: on({ format: ['teams'], transferOnlyAllowed: true }),
    text:
      "To strengthen a teammate's capture in the same turn, it captures with its first order and you " +
      'transfer in at least one order later, marked Transfer Only so a failed capture leaves your armies ' +
      'home. In warapp_submit_turn, set the move\'s mode "transfer-only" (not yet verified live); a plain order would attack and ' +
      'take the territory.',
    source: S.forumTeamStrategy,
    basis: 'source',
  },
  {
    id: 'teams-ai-teammate',
    topic: 'format',
    when: on({ format: ['teams'] }),
    text:
      "An AI in a teammate's seat plays no card of its own accord while a human is on the team, though the " +
      "rules can force a play for the team. It may attack a teammate's territory to finish a bonus (one " +
      'thread reports it taking only one-army ones: keep two on yours beside it). Armies you transfer to it ' +
      "become the AI's: defend from your land.",
    source: S.ai,
    basis: 'derived',
  },
  // ---- the end-game (third research pass): stand-offs, finishing, behind, leavers ----
  {
    id: 'fighting-grind-threshold',
    topic: 'fighting',
    when: on({ phase: ['contact', 'late'], exact: true, defaultKillRates: true }),
    text:
      'With both sides deploying everything at one border, attacking every turn wins from about 1.1 to 1.15 ' +
      "times the defender's stack at 100 armies or more (1.2 to 1.3 times at 20, more with large incomes), " +
      'though the first attacks lose more than they kill. Short of that it feeds the defender; with neither ' +
      'side that far ahead: a stand-off.',
    source: S.forumSkillChecklist,
    basis: 'derived',
  },
  {
    id: 'fighting-income-lead-clock',
    topic: 'fighting',
    when: on({ phase: ['contact', 'late'], standing: ['ahead'], exact: true, defaultKillRates: true }),
    text:
      'From equal stacks at one border, more income breaks it by stacking a few turns, then attacking every ' +
      'turn: a fifth more (12 against 10) takes about 8 to 12 turns, half as much again 4 or 5, double 3. A ' +
      'tenth more may never get through there: spend that lead on a second point of contact.',
    source: S.strategyGuideDoc,
    basis: 'derived',
  },
  {
    id: 'fighting-army-lead-expires',
    topic: 'fighting',
    when: on({ format: ['1v1', 'teams'], phase: ['contact', 'late'], exact: true, defaultKillRates: true }),
    text:
      'More armies with less income is a lead that shrinks every turn. At 40 against 20 with 7 income against ' +
      '10, attacking every turn from now breaks the border in 2 turns; wait 2 turns first and the same attacks ' +
      'are ground down. Spend such a lead at once on a capture that cuts their income, or do not count on it.',
    source: S.combat,
    basis: 'derived',
  },
  {
    id: 'fighting-failed-attack-reply',
    topic: 'fighting',
    when: on({ phase: ['contact', 'late'], exact: true, defaultKillRates: true }),
    text:
      'A failed attack leaves your territory thin. If the stack you hit is larger than your attack (from about ' +
      '1.06 times at 100 armies to 1.2 times at 10) and has not moved yet, its reply takes your territory as ' +
      'well. Near parity, attack only after that stack has attacked, or with enough to capture.',
    source: S.forumSkillChecklist,
    basis: 'source',
  },
  {
    id: 'fighting-double-border-safety',
    topic: 'fighting',
    when: on({ phase: ['contact', 'late'], exact: true, defaultKillRates: true }),
    text:
      'A territory survives an attack of A only with more than 0.6 × A armies (61 against 100). One enemy ' +
      'stack touching two territories you must keep needs that on each, about 1.2 × A in all, 1.8 × A for ' +
      'three: with less you are guessing. To break a one-border deadlock, walk your stack to a territory ' +
      'touching two of theirs.',
    source: S.forumStalemate,
    basis: 'derived',
  },
  {
    id: 'fighting-finish-contain',
    topic: 'fighting',
    when: on({ format: ['1v1', 'teams'], phase: ['late'], standing: ['ahead'] }),
    text:
      'To end a won game, pen the last stack in rather than taking the map: a stack beside each way out, a ' +
      'small late attack retaking each territory it leaves, and your first order on it on a turn you move ' +
      'first, sized for its armies plus its whole income. On a turn it moves first, a strike where it ' +
      'stands misses if it runs.',
    source: S.forumNeverSurrender,
    basis: 'source',
  },
  {
    id: 'fighting-ahead-stop-expanding',
    topic: 'fighting',
    when: on({ format: ['1v1', 'teams'], phase: ['late'], standing: ['ahead'] }),
    text:
      "Once the game is yours, count the turns to finish it: the steps to the opponent's farthest territory, or the " +
      'armies its land needs over what you can spare each turn, whichever is more. Take a neutral bonus only ' +
      "if it repays its cost within that time and opens no border; every other army goes at the opponent's " +
      'bonuses and stacks.',
    source: S.forumNeverSurrender,
    basis: 'derived',
  },
  {
    id: 'fighting-more-threats-than-deploy',
    topic: 'fighting',
    when: on({ phase: ['contact', 'late'], standing: ['ahead'] }),
    text:
      'The opponent has one deployment to share among every territory you can take this turn. Ahead, set up ' +
      'more captures than it can save, each sized to win unless reinforced and aimed at different bonuses: ' +
      'whatever it guesses some fall and its income drops, unless it strikes back instead (warapp_check_plan ' +
      'tries that).',
    source: S.forumGuessMultiBorder,
    basis: 'derived',
  },
  {
    id: 'fighting-behind-take-variance',
    topic: 'fighting',
    when: on({ format: ['1v1'], phase: ['contact', 'late'], standing: ['behind'] }),
    text:
      'Well behind, the safe plan only loses more slowly. Prefer lines that win if one guess is right: an ' +
      'attack sized for where the opponent will not deploy, a stack sent past its front. Make them while your ' +
      'stack still outweighs a turn of its income, and vary your targets so it cannot read you.',
    source: S.forumTougherOpponents,
    basis: 'source',
  },
  {
    id: 'fighting-raid-back-line',
    topic: 'fighting',
    when: on({ format: ['1v1', 'teams'], phase: ['contact', 'late'] }),
    text:
      'Armies defending a border the other side can overrun are wasted; past its front they threaten every ' +
      'bonus they touch, and it must garrison them all or turn back. Each turn move the stack on to a ' +
      'territory touching two bonuses rather than holding what it took. Facing one, turn a stack on it ' +
      'while your front keeps advancing.',
    source: S.forumLargeFront,
    basis: 'derived',
  },
  {
    id: 'fighting-vote-to-end',
    topic: 'fighting',
    when: on({ phase: ['contact', 'late'], standing: ['even'] }),
    text:
      'A game nobody can win can end by vote, but only if every player still alive votes for it, and never ' +
      'in ladder, tournament, quickmatch, clan-war or coin games. It then has no winner and counts as a loss ' +
      'for anyone already out. Propose it in chat once nothing is left to try; the vote is cast in the game ' +
      'client.',
    source: S.voteToEnd,
    basis: 'source',
  },
  {
    id: 'fighting-not-risk',
    topic: 'fighting',
    when: on({ phase: ['contact', 'late'], defenceBeatsOffence: true, multiAttack: false }),
    text:
      'Risk habits mislead here. A defender kills more per army, so attacking an equal stack loses more than it ' +
      'kills; it deploys before your attack lands, so size for that; armies move one step a turn, so nothing ' +
      'is swept in one turn; and cards have fixed effects, with no rule page paying you for eliminating a player.',
    source: S.combat,
    basis: 'derived',
  },
  {
    id: 'reading-net-gain',
    topic: 'reading',
    when: on({ phase: ['contact', 'late'] }),
    text:
      "Measure a lead in armies, not income alone: each turn take your income plus the armies you killed, " +
      "less the opponent's income and the armies you lost. A smaller income that wins its exchanges is " +
      'gaining; a larger one that loses them is not. Judge it over a few turns, not one.',
    source: S.forumSkillChecklist,
    basis: 'source',
  },
  {
    id: 'reading-when-lost',
    topic: 'reading',
    when: on({ format: ['1v1'], phase: ['contact', 'late'], standing: ['behind'] }),
    text:
      'Call a two-player game lost only when this has held for several turns: no bonus of yours survives, ' +
      'the opponent out-deploys you by far and shows more armies, none of its bonuses breaks against its ' +
      'full deployment, its commander (if any) is out of reach, and fog hides no other picture. Then ' +
      'surrender rather than run a stack to delay.',
    source: S.forumTellingSurrender,
    basis: 'derived',
  },
  {
    id: 'reading-surrender-checks',
    topic: 'reading',
    when: on({ phase: ['contact', 'late'], standing: ['behind'] }),
    text:
      'Before you surrender, read the settings. Where surrenders must be accepted, you keep playing until every ' +
      'other player has accepted. Your land then turns neutral or passes to an AI, as the game is set; with ' +
      'more than two sides that can decide the game between the others, so see who borders it.',
    source: S.surrender,
    basis: 'source',
  },
  {
    id: 'reading-leaver-replan',
    topic: 'reading',
    when: on({ format: ['ffa', 'teams'] }),
    text:
      'Players report that a surrender or boot shows at once to anyone who has not committed, who can re-plan ' +
      'the same turn. When a neighbour is near its boot time or has asked to surrender, read the game again ' +
      'just before you commit: its land may be neutral already, or played by an AI that keeps no truce.',
    source: S.forumTurningAi,
    basis: 'source',
  },
  {
    id: 'timing-setup-then-first-order',
    topic: 'timing',
    when: on({ format: ['1v1'], moveOrder: ['Cycle', 'NoLuckCycle'], phase: ['contact', 'late'] }),
    text:
      'Under a cyclic order you move first every other turn. On the turn before yours, step beside the target ' +
      'late in your list; next turn, strike with your first order. The opponent gets a deployment in between ' +
      'but no move, so size the strike for its stack plus its whole income.',
    source: S.forumSkillChecklist,
    basis: 'source',
  },
  {
    id: 'settings-commander-kill-ends-game',
    topic: 'settings',
    when: on({ format: ['1v1'], commanders: true }),
    text:
      'In a two-player game the game ends the moment a commander dies, and no later order runs. If both ' +
      'commanders can be killed this turn, the kill that runs first wins: make it your first order and know ' +
      'who moves first. If the opponent may hold Order Priority, play yours: two cancel and the usual order ' +
      'stands.',
    source: S.forumCommanderDeath,
    basis: 'derived',
  },
  {
    id: 'settings-commander-guard-numbers',
    topic: 'settings',
    when: on({ commanders: true, exact: true, defaultKillRates: true }),
    text:
      'A commander with g armies on its territory dies to the attack that takes g + 7: alone 11, with 5 armies 20, ' +
      'with 10 28, with 20 45. To make an attack of A fail, keep round(0.6 × A) − 6 armies with it (6 against ' +
      '20, 54 against 100). A smaller attack kills armies, never the commander.',
    source: S.commanders,
    basis: 'derived',
  },
  {
    id: 'settings-commander-keep-back',
    topic: 'settings',
    when: on({ commanders: true }),
    text:
      'A commander is attacked only from a territory next to it: with no enemy or fogged territory beside ' +
      'it, it is safe this turn; with none within two steps, next turn too (under Multi-Attack count chains). ' +
      'Ahead, keep it that far back. Move it with `commander` on a move in ' +
      'warapp_submit_turn (not yet verified live).',
    source: S.commanders,
    basis: 'derived',
  },
  {
    id: 'settings-commander-snipe-behind',
    topic: 'settings',
    when: on({ format: ['1v1'], commanders: true, phase: ['contact', 'late'], standing: ['behind'] }),
    text:
      'Behind in a commander game, killing theirs wins whatever the incomes. Work out where it can be: its ' +
      'first awarded territory or last sighting, one step for each turn since (anywhere its owner holds, after ' +
      'an Airlift). Keep one stack able to cover its guard, its 7 and a full deployment, and bring it within ' +
      'reach.',
    source: S.commanders,
    basis: 'derived',
  },
  {
    id: 'settings-commander-kill-neutral',
    topic: 'settings',
    when: on({ format: ['ffa', 'teams'], commanders: true }),
    text:
      'With more than two players a commander kill pays nothing directly: all its owner held turns neutral ' +
      'where it stands, armies included. Its stacks facing you become neutral walls, and its thin land is ' +
      'cheap for whoever borders it. Before the strike, see who that is: you, or a rival.',
    source: S.commanders,
    basis: 'derived',
  },
  {
    id: 'cards-priority-catch-runner',
    topic: 'cards',
    when: on({ format: ['1v1'], cardsInPlay: ['Order Priority'], phase: ['late'], standing: ['ahead'] }),
    text:
      'A stack that keeps moving away is caught only on a turn your attack runs before its move: every other ' +
      'turn under a cyclic order, an even chance each turn under a random one. Order Priority on your first ' +
      'order makes it certain unless the opponent plays one too. Save the card for the strike that ' +
      'eliminates.',
    source: S.orderPriority,
    basis: 'derived',
  },
  {
    id: 'cards-bomb-standoff-size',
    topic: 'cards',
    when: on({ cardsInPlay: ['Bomb'], phase: ['contact', 'late'], exact: true, defaultKillRates: true }),
    text:
      'A Bomb halves a stack after its deployment and before any attack, so the capture drops from five ' +
      'thirds of the stack to about five sixths: 83 instead of 166 against 100. With one, a stack about equal ' +
      'to theirs captures the turn you play it (in the game client); facing one, keep the stacks beside its ' +
      'holder split.',
    source: S.bomb,
    basis: 'derived',
  },
  {
    id: 'cards-diplomacy-three-sides',
    topic: 'cards',
    when: on({ format: ['ffa'], cardsInPlay: ['Diplomacy'] }),
    text:
      'With three sides left a Diplomacy card makes a two-on-one while it runs: the two at peace can attack ' +
      'only the third. Play it on the opponent you want facing the other; if your two opponents end up at ' +
      'peace by card, expect both on you from the next turn. It is played in the game client.',
    source: S.diplomacy,
    basis: 'derived',
  },
  {
    id: 'cards-sanctions-on-leader',
    topic: 'cards',
    when: on({ format: ['ffa', 'teams'], cardsInPlay: ['Sanctions'] }),
    text:
      'A Sanctions card with a positive percentage takes a share of income, so it costs the largest player ' +
      'most, and two on one player compound. When several of you face one leader, play them on it for the ' +
      'same turns, the turn before you attack: the cut starts with its next income. It is played in the game ' +
      'client.',
    source: S.sanctions,
    basis: 'derived',
  },
  {
    id: '1v1-opponent-replaced-by-ai',
    topic: 'format',
    when: on({ format: ['1v1'], phase: ['contact', 'late'] }),
    text:
      'An opponent who surrenders or is booted may be replaced by an AI that plays on, and its player may take ' +
      'the seat back a limited number of times; whether the AI gives up once you are the last human is a ' +
      'setting. Until the game shows as won, keep every hold and keep finishing.',
    source: S.playersIntoAis,
    basis: 'source',
  },
  {
    id: '1v1-beaten-opponent-chat',
    topic: 'format',
    when: on({ format: ['1v1'], phase: ['late'], standing: ['ahead'] }),
    text:
      'If a beaten opponent plays on, do not tell it to surrender. Say once, politely, what the board shows ' +
      '(incomes, armies) and keep committing promptly; that often ends it. Repeated demands are rude, can draw ' +
      'a warning and make some players dig in. Only the boot timer removes a player who stops moving.',
    source: S.forumTellingSurrender,
    basis: 'source',
  },
  {
    id: 'ffa-last-human',
    topic: 'format',
    when: on({ format: ['ffa', 'teams'] }),
    text:
      'Where AIs give up once one human is left (in a team game, one team with humans), they surrender as ' +
      'soon as the last other human is out, whatever they hold: with AI seats in play, count the humans ' +
      'still in and finish that one first. Where they do not, an AI plays to the end and can win, even for ' +
      'a booted leader.',
    source: S.aiSurrenders,
    basis: 'derived',
  },
  {
    id: 'ffa-coalition-match-commitment',
    topic: 'format',
    when: on({ format: ['ffa'], phase: ['contact', 'late'], standing: ['even', 'behind'] }),
    text:
      'When you and another smaller player both face a runaway leader, match the effort the other puts in. ' +
      'A league player warns that whoever throws everything at the leader while the other also guards your ' +
      'shared border is squeezed from both sides and falls first; if both hold back, the leader beats you ' +
      'one at a time.',
    source: S.forumFfaLeague,
    basis: 'source',
  },
  {
    id: 'ffa-two-player-moment',
    topic: 'format',
    when: on({ format: ['ffa'], phase: ['contact', 'late'] }),
    text:
      "With three left, the game turns two-player when the leader's income collapses, not when its last " +
      'territory falls, and any pact against it ends there. Before helping to finish anyone, compare what you ' +
      'and the other survivor would hold afterwards: whoever is clearly behind then usually loses within a ' +
      'turn or two.',
    source: S.forumFfaLeague,
    basis: 'derived',
  },
  {
    id: 'ffa-second-needs-third',
    topic: 'format',
    when: on({ format: ['ffa'], phase: ['contact', 'late'], standing: ['even', 'behind'] }),
    text:
      'Only first place wins. Second of three, you cannot win without the third, so helping the leader finish ' +
      'it only buys second place. Third, the second needs you alive and fighting the leader: that is worth a ' +
      'quiet border from it, and you can ask for one.',
    source: S.forumKeepingPlayers,
    basis: 'source',
  },
  {
    id: 'ffa-leader-combined-holds',
    topic: 'format',
    when: on({ format: ['ffa'], phase: ['contact', 'late'], standing: ['ahead'] }),
    text:
      'Clearly the largest, be ready for the others to stop fighting each other and turn on you. Size each border ' +
      'for every neighbour touching it attacking in the same turn, fight one neighbour at a time and finish ' +
      'it, show no more than a border needs, and keep quiet in public chat: naming the leader starts the ' +
      'pile-on.',
    source: S.forumFfaLeague,
    basis: 'derived',
  },
  {
    id: 'ffa-buffer-neighbour',
    topic: 'format',
    when: on({ format: ['ffa'], phase: ['contact', 'late'] }),
    text:
      'Eliminating a player pays the land you take, and no rule page gives the eliminator more. Before ' +
      'finishing a weak neighbour, see who stands behind it: if its land keeps a stronger player off you, its ' +
      'income holds that border for free. Finish it when its bonuses would otherwise go to a rival, or it can ' +
      'still hurt you.',
    source: S.forumKeepingPlayers,
    basis: 'derived',
  },
  {
    id: 'ffa-surrender-veto',
    topic: 'format',
    when: on({ format: ['ffa'] }),
    text:
      'Where surrenders must be accepted, every other player must accept before a loser leaves; its land then ' +
      'turns neutral or goes to an AI, as the game is set. Accept when that helps you more than your rivals; ' +
      'if it would mostly feed a rival, refusing keeps the player in (it must move or be booted). Accept in ' +
      'the game client.',
    source: S.surrender,
    basis: 'derived',
  },
  {
    id: 'ffa-truce-end',
    topic: 'format',
    when: on({ format: ['ffa'], phase: ['contact', 'late'] }),
    text:
      'Every truce in a free-for-all ends, since only one player wins. End yours before the partner grows too ' +
      'strong to beat, but not while the leader still gains from your fight. If you agreed terms, give the ' +
      'notice they name, and expect the partner to use it to move stacks to your border.',
    source: S.forumFfaTruce,
    basis: 'source',
  },
  {
    id: 'ffa-lost-game-exit',
    topic: 'format',
    when: on({ format: ['ffa'], phase: ['contact', 'late'], standing: ['behind'] }),
    text:
      'When you cannot win a free-for-all, staying on is accepted while your moves still affect the result, ' +
      'unlike in a two-player game. Leaving is a move as well: your land turns neutral or passes to an AI, and ' +
      'whoever borders it can profit. Before surrendering, see which opponent your land would feed.',
    source: S.forumBadSurrender,
    basis: 'source',
  },
  {
    id: 'ffa-boot-clock',
    topic: 'format',
    when: on({ format: ['ffa', 'teams'] }),
    text:
      'Past the direct-boot time any player may boot one who has not committed (in the game client), when ' +
      'it chooses; the seat goes to an AI where the game says so, and players report it turns neutral ' +
      'otherwise. Near a deadline, note which neighbours have not committed and what their bonuses would ' +
      'cost, and commit your own turn in good time.',
    source: S.booting,
    basis: 'derived',
  },
  {
    id: 'teams-commander-weakest',
    topic: 'format',
    when: on({ format: ['teams'], commanders: true }),
    text:
      "In a team game a commander's death removes only its owner; the teammate plays on alone and the dead " +
      "player's land turns neutral. The weaker or more exposed enemy's commander is the short way to " +
      "outnumbering them, and the same goes for your side: guard a teammate's commander by transferring " +
      'armies onto its territory early in your orders.',
    source: S.forumTeamCommanders,
    basis: 'derived',
  },
  {
    id: 'teams-hand-over-before-leaving',
    topic: 'format',
    when: on({ format: ['teams'] }),
    text:
      'A teammate who surrenders or is booted leaves its land to an AI or neutral, as the game is set; neutral, ' +
      "its income is gone from the team, as when one is eliminated. Armies about to be lost do more in a " +
      "teammate's hands: transfer them across a shared border first. Do not surrender alone; agree it with " +
      'the team.',
    source: S.teamGames,
    basis: 'derived',
  },
  {
    id: 'teams-no-march-through',
    topic: 'format',
    when: on({ format: ['teams'] }),
    text:
      "An order into a teammate's territory hands the armies over and they stop there, so your stacks cannot " +
      "march through a teammate's land. Route around it, or hand armies over on purpose where the teammate " +
      'faces the enemy and has nothing better coming.',
    source: S.teamGames,
    basis: 'derived',
  },
];

/** Every note, or one topic's, in the table's order. */
export function generalNotes(topic?: NoteTopic): StrategyNote[] {
  return STRATEGY_NOTES.filter((n) => topic === undefined || n.topic === topic);
}

/** The notes that apply to a game with this profile (optionally one topic). */
export function notesFor(profile: GameProfile, topic?: NoteTopic, context: NoteContext = {}): StrategyNote[] {
  return generalNotes(topic).filter((n) => n.when(profile, context));
}

export interface FeedProfileInput {
  graph: MapGraph;
  players: readonly ProfilePlayer[];
  settings?: ProfileSettings;
  turn?: number | null;
  picking?: boolean;
  /** GameFeed's standing when it sends one (`game.standing`): contact and late phases read it. */
  board?: BoardState;
}

/**
 * A game's profile from GameFeed alone: format, settings and phase. It is seen from the
 * first seated player — the format does not depend on the seat — and the phase reads
 * GameFeed's standing when there is one (without it no contact or territory-share late
 * game can be seen). The standing is `unknown`: it needs income estimates, which
 * warapp_plan_turn makes.
 */
export function feedProfile(input: FeedProfileInput): GameProfile {
  const playing = input.players.filter((p) => (p.state ?? 'Playing') === 'Playing');
  const me = (playing[0] ?? input.players[0])?.id ?? 0;
  return gameProfile({
    graph: input.graph,
    board: input.board ?? { source: 'gamefeed', territories: [], verified: false },
    me,
    players: input.players.length ? input.players : [{ id: me }],
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.turn !== undefined ? { turn: input.turn } : {}),
    ...(input.picking !== undefined ? { picking: input.picking } : {}),
    income: 0,
    estimates: [],
  });
}

export const TOPIC_TITLES: Record<NoteTopic, string> = {
  format: 'Format: 1v1, free-for-all, teams',
  settings: 'Settings',
  cards: 'Cards',
  reading: 'Reading the game',
  opening: 'The opening: picks and the first turns',
  timing: 'Timing: the order of orders within a turn',
  fighting: 'Fighting: stacks in contact, ahead and behind',
  map: 'The map',
};

/** Notes as markdown, grouped by topic, each with its id and source link. */
export function notesMarkdown(notes: readonly StrategyNote[], title = 'war.app strategy notes'): string {
  const lines = [`# ${title}`, ''];
  for (const t of NOTE_TOPICS) {
    const these = notes.filter((n) => n.topic === t);
    if (!these.length) continue;
    lines.push(`## ${TOPIC_TITLES[t]}`, '');
    for (const n of these) {
      lines.push(`- \`${n.id}\` — ${n.text} ([source](${n.source})${n.basis === 'derived' ? ', our reasoning from it' : ''})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
