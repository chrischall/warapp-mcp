import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harnessFor, type Harness } from './helpers.js';

/**
 * Fleet annotation meta-test, read off the wire (tools/list). Every tool reads
 * war.app except the confirm-gated writes that reach other people
 * (submitting territory picks, submitting a turn's orders, sending chat,
 * joining a game, surrendering one, accepting another player's surrender, withdrawing committed orders) and
 * two LOCAL writes that reach no one but this machine — linking the
 * direct-transport session (confirm-gated: it stores a cookie locally) and
 * recording an agreement in the local ledger (not confirm-gated) — and one
 * confirm-gated write to war.app that changes only the account's own state:
 * marking notifications read and marking a game's chat read (#311) — and one that
 * destroys only the account's own data: deleting notifications (#311).
 */
const WRITES = [
  'warapp_accept_surrender',
  'warapp_begin_turn',
  'warapp_join_game',
  'warapp_leave_game',
  'warapp_send_chat',
  'warapp_submit_picks',
  'warapp_submit_turn',
  'warapp_surrender',
  'warapp_uncommit_turn',
];
const LOCAL_WRITES = ['warapp_backfill_history', 'warapp_link_session', 'warapp_record_agreement', 'warapp_record_intel'];
/** Writes to war.app that change only the account's own state (marking notifications and chat read, #311). */
const ACCOUNT_WRITES = ['warapp_close_finished_game', 'warapp_dismiss_notification', 'warapp_mark_chat_read'];
/** Writes to war.app that destroy only the account's own data (deleting notifications, #311). */
const ACCOUNT_DELETES = ['warapp_delete_notification'];

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
      'warapp_accept_surrender',
      'warapp_advise_diplomacy',
      'warapp_analyze_board',
      'warapp_backfill_history',
      'warapp_begin_turn',
      'warapp_chat_inbox',
      'warapp_check_plan',
      'warapp_close_finished_game',
      'warapp_delete_notification',
      'warapp_dismiss_notification',
      'warapp_get_chat',
      'warapp_get_game',
      'warapp_get_live_board',
      'warapp_get_map',
      'warapp_get_mod_alliances',
      'warapp_get_my_orders',
      'warapp_get_my_picks',
      'warapp_get_notifications',
      'warapp_get_relations',
      'warapp_get_team',
      'warapp_healthcheck',
      'warapp_join_game',
      'warapp_leave_game',
      'warapp_link_session',
      'warapp_list_open_games',
      'warapp_locate_opponents',
      'warapp_map_stats',
      'warapp_mark_chat_read',
      'warapp_my_games',
      'warapp_plan_picks',
      'warapp_plan_route',
      'warapp_plan_turn',
      'warapp_profile_opponents',
      'warapp_recent_events',
      'warapp_record_agreement',
      'warapp_record_intel',
      'warapp_scout_player',
      'warapp_send_chat',
      'warapp_session_status',
      'warapp_strategy',
      'warapp_submit_picks',
      'warapp_submit_turn',
      'warapp_surrender',
      'warapp_team_brief',
      'warapp_track_opponents',
      'warapp_uncommit_turn',
      'warapp_wait_for_turn',
    ]);
  });

  it('marks every tool but the writes read-only, never destructive', () => {
    const reads = Object.entries(ann).filter(([n]) => !WRITES.includes(n) && !LOCAL_WRITES.includes(n) && !ACCOUNT_WRITES.includes(n) && !ACCOUNT_DELETES.includes(n));
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
    expect(ann.warapp_join_game?.idempotentHint).toBe(false);
    expect(ann.warapp_leave_game?.idempotentHint).toBe(false);
    expect(ann.warapp_surrender?.idempotentHint).toBe(false);
    expect(ann.warapp_accept_surrender?.idempotentHint).toBe(false);
    expect(ann.warapp_begin_turn?.idempotentHint).toBe(false);
    expect(ann.warapp_uncommit_turn?.idempotentHint).toBe(false);
  });

  it('marks linking the session a write, but a local one that reaches no other people', () => {
    expect(ann.warapp_link_session).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('marks marking notifications read a write that reaches war.app but no other people, and destroys nothing', () => {
    for (const n of ACCOUNT_WRITES) {
      expect(ann[n], n).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    }
  });

  it('marks deleting notifications a destructive write that reaches war.app but no other people', () => {
    for (const n of ACCOUNT_DELETES) {
      expect(ann[n], n).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    }
  });

  it('marks recording an agreement a write to the local ledger only', () => {
    expect(ann.warapp_record_agreement).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('marks every game tool open-world (all reach war.app)', () => {
    const game = Object.entries(ann).filter(([n]) => n !== 'warapp_healthcheck');
    expect(game.filter(([, a]) => a?.openWorldHint !== true).map(([n]) => n)).toEqual([]);
  });
});
