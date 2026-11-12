import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harnessFor, type Harness } from './helpers.js';

/**
 * Fleet annotation meta-test, read off the wire (tools/list). Every tool reads
 * war.app except three confirm-gated writes that reach other people
 * (submitting territory picks, submitting a turn's orders, sending chat) and
 * one confirm-gated LOCAL write that reaches no one but this machine — linking
 * the direct-transport session (it only stores a cookie locally).
 */
const WRITES = ['warapp_send_chat', 'warapp_submit_picks', 'warapp_submit_turn'];
const LOCAL_WRITES = ['warapp_link_session'];

interface Ann {
  readOnlyHint?: unknown;
  idempotentHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

let h: Harness;
let ann: Record<string, Ann | undefined>;

beforeAll(async () => {
  h = await harnessFor();
  ann = Object.fromEntries(
    (await h.harness.client.listTools()).tools.map((t) => [t.name, t.annotations as Ann | undefined]),
  );
});
afterAll(async () => {
  await h?.harness.close();
});

describe('tool annotations', () => {
  it('covers the full surface (guards against a registrar being dropped)', () => {
    expect(Object.keys(ann).sort()).toEqual([
      'warapp_analyze_board',
      'warapp_get_chat',
      'warapp_get_game',
      'warapp_get_live_board',
      'warapp_get_map',
      'warapp_get_my_picks',
      'warapp_healthcheck',
      'warapp_link_session',
      'warapp_list_open_games',
      'warapp_my_games',
      'warapp_plan_route',
      'warapp_plan_turn',
      'warapp_recent_events',
      'warapp_scout_player',
      'warapp_send_chat',
      'warapp_session_status',
      'warapp_submit_picks',
      'warapp_submit_turn',
      'warapp_wait_for_turn',
    ]);
  });

  it('marks every tool but the writes read-only, never destructive', () => {
    const reads = Object.entries(ann).filter(([n]) => !WRITES.includes(n) && !LOCAL_WRITES.includes(n));
    expect(reads.filter(([, a]) => a?.readOnlyHint !== true).map(([n]) => n)).toEqual([]);
    expect(reads.filter(([, a]) => a?.destructiveHint === true).map(([n]) => n)).toEqual([]);
  });

  it('marks the writes as writes that reach other people', () => {
    for (const n of WRITES) {
      expect(ann[n], n).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    }
    expect(ann.warapp_submit_picks?.idempotentHint).toBe(true);
    expect(ann.warapp_send_chat?.idempotentHint).toBe(false);
    expect(ann.warapp_submit_turn?.idempotentHint).toBe(false);
  });

  it('marks linking the session a write, but a local one that reaches no other people', () => {
    expect(ann.warapp_link_session).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('marks every game tool open-world (all reach war.app)', () => {
    const game = Object.entries(ann).filter(([n]) => n !== 'warapp_healthcheck');
    expect(game.filter(([, a]) => a?.openWorldHint !== true).map(([n]) => n)).toEqual([]);
  });
});
