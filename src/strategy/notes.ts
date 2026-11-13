// Strategy notes: the community's heuristics as data, in our own words, each with the
// link it came from (docs/STRATEGY.md lists them and says which are encoded where).
// Pure and deterministic; no I/O. `warapp_strategy` and the `warapp://strategy`
// resource serve them.

import { gameProfile, type GameProfile, type ProfilePlayer, type ProfileSettings } from '../analysis/profile.js';
import type { MapGraph } from '../analysis/graph.js';
import type { BoardState } from '../board.js';
import { armiesToTake } from '../analysis/combat.js';

export const NOTE_TOPICS = ['format', 'settings', 'cards', 'reading', 'map'] as const;
export type NoteTopic = (typeof NOTE_TOPICS)[number];

/** The pages the notes were researched from (read 2026-11; paraphrased, never copied). */
export const STRATEGY_SOURCES = {
  general: 'https://war.app/Forum/811395-general-strategy-guidelines',
  oneVsOne: 'https://war.app/Forum/99097-good-1v1-strategies',
  ffa: 'https://war.app/Forum/621189-ffa-strategy',
  combat: 'https://war.app/wiki/Combat_Basics',
  luck: 'https://war.app/wiki/Luck_Modifier',
  cards: 'https://war.app/wiki/Cards',
} as const;

/** Game facts a note may need that the profile does not carry. */
export interface NoteContext {
  /** Percent; absent means the default (60). */
  offensiveKillRate?: number;
  /** Percent; absent means the default (70). */
  defensiveKillRate?: number;
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
      'Talk to the other players: a truce on one border frees armies for another. Trust with care — some pacts get ' +
      'broken, so keep a guard where a betrayal would hurt most.',
    source: S.ffa,
    basis: 'source',
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
      'With teammates, attack the same opponent together: a defender has one income to split between two fronts, ' +
      'while two of you hitting different territories each need only beat what stands there.',
    source: S.combat,
    basis: 'derived',
  },
  // ---- settings ----
  {
    id: 'settings-efficient-sizes',
    topic: 'settings',
    when: always,
    text:
      'Attack with the smallest army that wins: at the kill rates every few extra armies kill one more defender, and ' +
      'armies between those breakpoints are wasted. At the defaults (60% attack, 70% defence) three attackers take ' +
      'two defenders and five take three.',
    source: S.combat,
    basis: 'source',
    encoded: 'the planner sizes every attack at its breakpoint (src/analysis/combat.ts, warapp_plan_turn)',
  },
  {
    id: 'settings-defend-with-three',
    topic: 'settings',
    // Its numbers are the 60/70 breakpoints: offered only where two defenders fall to
    // three attackers and three need five.
    when: (_p, rates) => armiesToTake(2, rates) === 3 && armiesToTake(3, rates) === 5,
    text:
      'Leave three, not two, on a border you want to keep cheap to hold: at the default kill rates two defenders fall ' +
      'to three attackers but three need five, so the extra army costs the attacker two.',
    source: S.general,
    basis: 'source',
  },
  {
    id: 'settings-poke',
    topic: 'settings',
    when: always,
    text:
      'A one-army attack can spoil an opponent\'s breakpoint: it kills one of the armies they counted on, so their ' +
      'attack of exactly the right size falls short. Expect the same against you and keep a margin when it matters.',
    source: S.general,
    basis: 'source',
  },
  {
    id: 'settings-move-order',
    topic: 'settings',
    when: always,
    text:
      'Know the move order (cycle or random) from the first turn and sort your orders: what must happen before the ' +
      'opponent moves, what is better after, and what does not care.',
    source: S.general,
    basis: 'source',
  },
  {
    id: 'settings-no-luck-exact',
    topic: 'settings',
    when: (p) => p.settings.luck === 0,
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
      'With Local Deployment a bonus pays only inside itself: each bonus has to defend itself, a quiet bonus cannot ' +
      'feed the front, and breaking an enemy bonus takes away the armies that would have stood on it.',
    source: S.general,
    basis: 'derived',
    encoded: 'deploys are limited to each pool (src/analysis/local-deploy.ts, warapp_plan_turn)',
  },
  {
    id: 'settings-no-split',
    topic: 'settings',
    when: (p) => p.settings.noSplit,
    text:
      'With No-Split a territory makes one attack or transfer a turn, so a stack cannot fan out: stage armies on ' +
      'several territories ahead of the turn you need several attacks.',
    source: S.general,
    basis: 'derived',
    encoded: 'one move per source (src/analysis/planner.ts, warapp_plan_turn)',
  },
  // ---- cards ----
  {
    id: 'cards-piece-each-turn',
    topic: 'cards',
    when: cards,
    text:
      'Capture at least one territory every turn: that earns the turn\'s card piece, even if you lose it again, and ' +
      'more captures in the same turn earn nothing extra.',
    source: S.cards,
    basis: 'source',
  },
  {
    id: 'cards-order-delay',
    topic: 'cards',
    when: cards,
    text:
      'Order Delay moves your orders to the end of the turn: hold it for a big attack that should land after the ' +
      'defender has spent their own moves, or play it when going late helps more than going early.',
    source: S.cards,
    basis: 'derived',
  },
  {
    id: 'cards-order-priority',
    topic: 'cards',
    when: cards,
    text:
      'Order Priority puts your orders first: use it to pull armies out of a territory about to be hit, or to strike ' +
      'a stack (a commander) before it moves.',
    source: S.cards,
    basis: 'derived',
    encoded: 'the planner advises it for a withdrawal or a commander strike (cardAdvice, warapp_plan_turn)',
  },
  {
    id: 'cards-blockade-own-bonus',
    topic: 'cards',
    when: (p) => p.settings.cards && (p.standing === 'behind' || p.standing === 'unknown'),
    text:
      'When you are the weaker side, a Blockade on your own border territory turns it into a big neutral wall: you ' +
      'lose the territory but the bonus behind it gets a turn or more of safety.',
    source: S.cards,
    basis: 'derived',
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
    when: always,
    text:
      "An opponent's deploys minus the base income are their bonuses: match that number against the bonuses they " +
      'could hold to find which ones are complete, then aim to break those.',
    source: S.oneVsOne,
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
      'Ahead on income, trade: an even exchange of armies hurts the smaller income more, so keep the pressure on ' +
      'and break their bonuses while you out-deploy them.',
    source: S.oneVsOne,
    basis: 'derived',
    encoded: 'ahead in a 1v1, the planner allows more pressure (profile rule 0p, warapp_plan_turn)',
  },
  {
    id: 'reading-behind',
    topic: 'reading',
    when: (p) => p.standing === 'behind' || p.standing === 'unknown',
    text:
      'Behind on income, avoid even trades: defend the bonuses you have (defence kills more than attack), build up ' +
      'when expansion is expensive, and strike only where it breaks a bonus or saves one.',
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

const TOPIC_TITLES: Record<NoteTopic, string> = {
  format: 'Format: 1v1, free-for-all, teams',
  settings: 'Settings',
  cards: 'Cards',
  reading: 'Reading the game',
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
