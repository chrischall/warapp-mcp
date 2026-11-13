// Strategy notes (docs/PLAN-STRATEGY.md, S5): the community heuristics that fit a game's
// profile, plus notes computed from its map. Read-only: one GameFeed read with a game,
// none without. Also served as MCP resources: `warapp://strategy` (every general note)
// and `warapp://strategy/map/{mapId}` (a map this process has loaded).
import { McpToolError } from '@chrischall/mcp-utils';
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { WarappClient } from '../client.js';
import type { Game, GameMap } from '../normalize.js';
import { mapNotes, mapNotesMarkdown, type MapNotes } from '../strategy/map-notes.js';
import {
  feedProfile,
  generalNotes,
  NOTE_TOPICS,
  notesFor,
  notesMarkdown,
  type StrategyNote,
} from '../strategy/notes.js';
import { cardRules } from '../cards.js';
import { gameIdArg, graphOf, readAnnotations, respond, untrustedDescription, viewArg, WARAPP_UNTRUSTED_NOTE } from './common.js';
import { lookupMeta } from './hints.js';
import { DEFAULT_TERRITORY_LIMIT, PICK_PHASE_STATE, pickSettings } from './picks.js';
import { mapOf } from './map.js';
import { currentTurn } from './turn.js';

const VIEWS = ['compact', 'full'] as const;

export const STRATEGY_URI = 'warapp://strategy';
export const STRATEGY_MAP_URI = 'warapp://strategy/map/{mapId}';

const mapIdArg = z.coerce
  .number()
  .int()
  .min(1)
  .max(2 ** 31 - 1)
  .optional()
  .describe('A war.app map id (the game settings\' Map). Alone, it works for a map this server has already loaded with a game.');

function mapNotLoaded(mapId: number): McpToolError {
  return new McpToolError(`Map ${mapId} has not been loaded yet.`, {
    hint: 'war.app serves a map only with a game: pass the game_id of a game on that map (warapp_strategy or warapp_get_map loads it).',
  });
}

const noteView = (full: boolean) => (n: StrategyNote) => ({
  id: n.id,
  topic: n.topic,
  text: n.text,
  source: n.source,
  ...(full ? { basis: n.basis, encoded: n.encoded ?? null } : {}),
});

const mapView = (map: GameMap, n: MapNotes, full: boolean) => ({
  id: map.id,
  name: map.name,
  bonuses: n.bonuses.map((b) => ({
    ...b,
    entryPoints: full ? b.entryPoints : b.entryPoints.map((e) => e.name),
  })),
  bonusesShown: `${n.bonuses.length} of ${n.bonusesRanked}`,
  chokepoints: full ? n.chokepoints : n.chokepoints.map(({ territoryId, name, connects }) => ({ territoryId, name, connects })),
  ...(n.incomeTargets ? { incomeTargets: n.incomeTargets } : {}),
  assumptions: n.assumptions,
});

/** The map notes of a game: its settings, and an opening simulation while picks are open. */
function gameMapNotes(game: Game, map: GameMap): MapNotes {
  const picking = game.state === PICK_PHASE_STATE;
  const playing = game.players.filter((p) => (p.state ?? 'Playing') === 'Playing').length;
  const limit = game.settings?.territoryLimit;
  return mapNotes({
    graph: graphOf(map),
    settings: pickSettings(game.settings),
    ...(game.settings?.overriddenBonusesUnparsed ? { overridesUnparsed: true } : {}),
    ...(picking
      ? { opening: { players: Math.max(2, playing || game.players.length), territoryLimit: limit && limit > 0 ? limit : DEFAULT_TERRITORY_LIMIT } }
      : {}),
  });
}

const MAP_ONLY_NOTE = "Bonus values are the map's own; a game can override them (pass its game_id to see its values).";

export function registerStrategyTool(server: McpServer, client: WarappClient): void {
  server.registerTool(
    'warapp_strategy',
    {
      title: 'war.app strategy notes for a game or a map',
      description: untrustedDescription(
        'Strategy notes for war.app (Warzone), each a short heuristic in our own words with the community guide or ' +
          'wiki page it comes from, by topic: format (1v1, free-for-all, teams), settings (attack sizes, luck, ' +
          'Local Deployment, No-Split), cards, reading the game (counting armies, ahead/behind play) and the map. ' +
          'With `game_id`: the notes that fit its profile (format, settings, phase, read from GameFeed — standing is ' +
          'left to warapp_plan_turn) plus map notes: bonuses ranked by value per army to take at its settings with ' +
          'their entry points, chokepoints, and in the picking stage income targets by turn from the pick ' +
          "advisor's opening. With only `map_id` (a map already loaded with a game): the map notes. With neither: " +
          'every general note. Read-only.',
      ),
      _meta: lookupMeta(['warzone strategy', 'strategy tips', 'how to play this map', 'warzone advice']),
      annotations: readAnnotations('war.app strategy notes'),
      inputSchema: z.object({
        game_id: gameIdArg.optional(),
        map_id: mapIdArg,
        topic: z.enum(NOTE_TOPICS).optional().describe('Only notes on this topic; any topic but "map" leaves the map notes out.'),
        view: viewArg(
          VIEWS,
          'compact (default) gives each note\'s id, topic, text and source, and the map notes with entry points by name; ' +
            '"full" adds whether each note is stated by its source or our reasoning from it, where the server acts on it, ' +
            'the whole profile and the chokepoints\' reasons.',
        ),
      }),
    },
    async ({ game_id, map_id, topic, view }) => {
      const withMap = topic === undefined || topic === 'map';
      if (game_id === undefined && map_id === undefined) {
        return respond(view, VIEWS, (rung) => ({ scope: 'general', notes: generalNotes(topic).map(noteView(rung === 'full')) }));
      }
      if (game_id === undefined) {
        const map = client.cachedMap(map_id!);
        if (!map) throw mapNotLoaded(map_id!);
        const notes = mapNotes({ graph: graphOf(map) });
        notes.assumptions.push(MAP_ONLY_NOTE);
        return respond(view, VIEWS, (rung) => ({
          scope: 'map',
          notes: generalNotes('map').map(noteView(rung === 'full')),
          map: mapView(map, notes, rung === 'full'),
        }));
      }
      const game = await client.getGame(game_id, { settings: true });
      const map = mapOf(game);
      if (map_id !== undefined && map_id !== map.id) {
        throw new McpToolError(`Game ${game.id} is played on map ${map.id}, not map ${map_id}.`, {
          hint: 'Omit map_id when you pass a game_id: the game names its map.',
        });
      }
      const s = game.settings;
      const profile = feedProfile({
        graph: graphOf(map),
        players: game.players.map((p) => ({
          id: p.id,
          ...(p.team !== undefined ? { team: p.team } : {}),
          ...(p.state !== undefined ? { state: p.state } : {}),
        })),
        settings: {
          ...(s?.luckModifier !== undefined ? { luckModifier: s.luckModifier } : {}),
          ...(s?.roundingMode !== undefined ? { roundingMode: s.roundingMode } : {}),
          cards: cardRules(s).inPlay.length > 0,
          ...(s?.localDeployments !== undefined ? { localDeployments: s.localDeployments } : {}),
          ...(s?.noSplit !== undefined ? { noSplit: s.noSplit } : {}),
          ...(s?.commanders !== undefined ? { commanders: s.commanders } : {}),
          ...(s?.fog !== undefined ? { fog: s.fog } : {}),
        },
        turn: currentTurn(game),
        picking: game.state === PICK_PHASE_STATE,
        ...(game.standing ? { board: game.standing } : {}),
      });
      const notes = notesFor(profile, topic, {
        ...(s?.offensiveKillRate !== undefined ? { offensiveKillRate: s.offensiveKillRate } : {}),
        ...(s?.defensiveKillRate !== undefined ? { defensiveKillRate: s.defensiveKillRate } : {}),
        ...(s?.armyCap !== undefined ? { armyCap: s.armyCap } : {}),
        ...(s?.multiAttack !== undefined ? { multiAttack: s.multiAttack } : {}),
      });
      const mapped = withMap ? gameMapNotes(game, map) : undefined;
      return respond(view, VIEWS, (rung) => ({
        scope: 'game',
        game: { id: game.id, name: game.name ?? null, state: game.state, turn: currentTurn(game) },
        profile:
          rung === 'full'
            ? profile
            : { format: profile.format, opponents: profile.opponents, phase: profile.phase, standing: profile.standing },
        notes: notes.map(noteView(rung === 'full')),
        ...(mapped ? { map: mapView(map, mapped, rung === 'full') } : {}),
      }));
    },
  );

  server.registerResource(
    'warapp-strategy',
    STRATEGY_URI,
    {
      title: 'war.app strategy notes',
      description: 'Every general war.app (Warzone) strategy note, by topic, each with its source link (markdown).',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: notesMarkdown(generalNotes()) }] }),
  );

  server.registerResource(
    'warapp-strategy-map',
    new ResourceTemplate(STRATEGY_MAP_URI, { list: undefined }),
    {
      title: 'war.app map strategy notes',
      description:
        'Notes computed from a war.app map this server has loaded with a game: bonuses by value per army, entry ' +
        'points, chokepoints (markdown). Bonus and territory names are written by the map designer.',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const raw = variables.mapId;
      const mapId = Number(Array.isArray(raw) ? raw[0] : raw);
      const map = Number.isInteger(mapId) && mapId > 0 ? client.cachedMap(mapId) : undefined;
      if (!map) {
        throw new Error(
          `Map ${String(raw)} has not been loaded yet: call warapp_strategy (or warapp_get_map) with a game on that map first.`,
        );
      }
      const notes = mapNotes({ graph: graphOf(map) });
      notes.assumptions.push(MAP_ONLY_NOTE);
      const text = `> ${WARAPP_UNTRUSTED_NOTE}\n\n${mapNotesMarkdown(map.name, notes)}`;
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );
}
