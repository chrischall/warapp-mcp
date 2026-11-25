// warapp_upload_slots + warapp_import_state (the hosted import of a state bundle) and
// warapp_backfill_history. A fake in-memory blob store and synthetic data dirs only.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createBlobStore, mintUploadSlot, type BlobStore } from '@chrischall/mcp-utils/export';
import { afterEach, describe, expect, it } from 'vitest';
import { collectExport, encodeBundle } from '../src/state-bundle.js';
import { Method } from '../src/protocol/methods.js';
import type { Writer } from '../src/protocol/codec.js';
import { liveHarness, payload, textOf, type Harness } from './helpers.js';
import { writeMyGamesReturn } from './protocol/my-games-bundle.js';

const ANN = 4412345677; // in-game 123456
const BOB = 7176543229;
const SIGNED_IN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN}</p>` };
const SALT = 'a'.repeat(32);

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

function put(dir: string, rel: string, body: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

/** An in-memory blob store: slots minted for real, objects kept in a map. */
function fakeStore(): { store: BlobStore; objects: Map<string, Uint8Array>; upload: (bytes: Uint8Array) => string } {
  const real = createBlobStore({ baseUrl: 'https://host.example/b/reg_test', signingKey: 'a2V5' });
  const objects = new Map<string, Uint8Array>();
  const store: BlobStore = {
    baseUrl: real.baseUrl,
    prefix: real.prefix,
    signGetUrl: (k, o) => real.signGetUrl(k, o),
    signPutUrl: (k, t, o) => real.signPutUrl(k, t, o),
    signDeleteUrl: (k, o) => real.signDeleteUrl(k, o),
    put: async () => {
      throw new Error('not used');
    },
    get: async (key) => {
      const bytes = objects.get(key);
      if (!bytes) throw Object.assign(new Error('not found'), { status: 404 });
      return { key, bytes, contentType: 'application/octet-stream' };
    },
    delete: async (key) => {
      objects.delete(key);
    },
    consume: async () => {
      throw new Error('not used');
    },
  };
  const upload = (bytes: Uint8Array) => {
    const slot = mintUploadSlot(store, { filename: 'warapp-state.json.gz' });
    objects.set(slot.blobKey, bytes);
    return slot.blobKey;
  };
  return { store, objects, upload };
}

async function bundleFor(account = ANN, salt = SALT): Promise<Uint8Array> {
  const src = mkdtempSync(join(tmpdir(), 'warapp-state-src-'));
  put(src, 'relations/players.salt', salt);
  put(src, 'relations/players.json', '{"version":3,"players":{}}');
  put(src, 'lessons.json', '{"version":1,"private":"lesson-marker"}');
  put(src, `relations/5-${account}.json`, '{}');
  return encodeBundle(await collectExport(src, { account }));
}

async function hosted(blob = fakeStore()) {
  const dir = mkdtempSync(join(tmpdir(), 'warapp-state-dst-'));
  h = await liveHarness({ dataDir: dir, pages: SIGNED_IN, blobStore: blob.store });
  return { dir, blob };
}

async function previewThenConfirm(args: Record<string, unknown>) {
  const preview = payload(await h!.call('warapp_import_state', args));
  expect(preview.confirmToken).toEqual(expect.any(String));
  return { preview, result: await h!.call('warapp_import_state', { ...args, confirmToken: preview.confirmToken }) };
}

describe('warapp_upload_slots', () => {
  it('mints a signed slot for the bundle, and is offered only with a blob store', async () => {
    await hosted();
    const p = payload(await h!.call('warapp_upload_slots', { filename: 'warapp-state.json.gz' }));
    const slot = p.slot as { blobKey: string; uploadUrl: string; curl: string };
    expect(slot.blobKey).toMatch(/^uploads\//);
    expect(slot.uploadUrl).toMatch(/^https:\/\/host\.example\/b\/reg_test\//);
    expect(slot.curl).toContain('curl');
    await h!.harness.close();
    h = await liveHarness();
    const names = (await h.harness.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('warapp_upload_slots');
    expect(names).not.toContain('warapp_import_state');
    expect(names).toContain('warapp_backfill_history');
  });
});

describe('warapp_import_state', () => {
  it('previews counts per store and the accounts, writes nothing, then imports on confirm and deletes the upload', async () => {
    const { dir, blob } = await hosted();
    const key = blob.upload(await bundleFor());
    const preview = payload(await h!.call('warapp_import_state', { blob_key: key }));
    expect(existsSync(join(dir, 'relations'))).toBe(false);
    expect(blob.objects.size).toBe(1);
    const result = await h!.call('warapp_import_state', { blob_key: key, confirmToken: preview.confirmToken });
    const text = JSON.stringify(preview);
    expect(text).not.toContain(SALT);
    expect(text).not.toContain('lesson-marker');
    const pv = preview.preview as Record<string, unknown>;
    expect(pv).toMatchObject({ bundleAccount: ANN, accountMatches: true, saltOnServer: 'absent' });
    expect((pv.stores as Record<string, { files: number }>).salt?.files).toBe(1);
    const r = payload<{ data: Record<string, unknown> }>(result).data;
    expect(r).toMatchObject({ status: 'imported', outcome: 'confirmed', written: 4, blobDeleted: true });
    expect(JSON.stringify(r)).not.toContain(SALT);
    expect(readFileSync(join(dir, 'relations/players.salt'), 'utf8')).toBe(SALT);
    expect(blob.objects.size).toBe(0);
  });

  it('refuses a bundle of another account', async () => {
    const { dir, blob } = await hosted();
    const key = blob.upload(await bundleFor(BOB));
    const res = await h!.call('warapp_import_state', { blob_key: key });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/account/);
    expect(existsSync(join(dir, 'relations'))).toBe(false);
  });

  it('refuses a different salt without replace; with replace backs the old stores up', async () => {
    const { dir, blob } = await hosted();
    put(dir, 'relations/players.salt', 'b'.repeat(32));
    put(dir, 'lessons.json', '{"hosted":true}');
    const key = blob.upload(await bundleFor());
    const res = await h!.call('warapp_import_state', { blob_key: key });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/replace: true/);
    expect(readFileSync(join(dir, 'relations/players.salt'), 'utf8')).toBe('b'.repeat(32));
    const { preview, result } = await previewThenConfirm({ blob_key: key, replace: true });
    expect((preview.preview as Record<string, unknown>).saltOnServer).toBe('different');
    const r = payload<{ data: Record<string, unknown> }>(result).data;
    expect(r.backup).toMatch(/^state-backups\//);
    expect(readFileSync(join(dir, r.backup as string, 'relations/players.salt'), 'utf8')).toBe('b'.repeat(32));
    expect(readFileSync(join(dir, r.backup as string, 'lessons.json'), 'utf8')).toBe('{"hosted":true}');
    expect(readFileSync(join(dir, 'relations/players.salt'), 'utf8')).toBe(SALT);
  });

  it('refuses a bundle whose sha256 does not match, and drops the useless upload', async () => {
    const { dir, blob } = await hosted();
    const j = JSON.parse(gunzipSync(await bundleFor()).toString('utf8'));
    j.files['lessons.json'] = Buffer.from('{"tampered":1}').toString('base64');
    const key = blob.upload(gzipSync(JSON.stringify(j)));
    const res = await h!.call('warapp_import_state', { blob_key: key });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/sha256/);
    expect(existsSync(join(dir, 'relations'))).toBe(false);
    expect(blob.objects.size).toBe(0);
  });
});

describe('warapp_backfill_history', () => {
  const over = (id: number) => ({ id, name: `Over ${id}`, lastTurn: 2, state: 4, players: [{ id: 123456, name: 'Ann', state: 3, committed: false }] });
  const finished = {
    id: '1',
    state: 'Finished',
    numberOfTurns: '1',
    players: [
      { id: String(ANN), name: 'Ann', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Won' },
      { id: String(BOB), name: 'Bob', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Eliminated' },
    ],
    settings: { Map: '77' },
  };
  const ids = Array.from({ length: 30 }, (_, i) => 2000 + i);

  async function harness() {
    h = await liveHarness({
      feed: [finished],
      pages: SIGNED_IN,
      warapp: (req) => {
        if (req.method !== Method.GetMyGames) throw new Error(`unexpected method ${req.method}`);
        return { body: (w: Writer) => writeMyGamesReturn(w, ids.map(over)) };
      },
    });
  }
  const historyReads = () => h!.calls.filter((c) => c.url.includes('GetHistory=true')).length;

  it('processes 10 by default, one history read each, and counts what remains', async () => {
    await harness();
    const first = payload(await h!.call('warapp_backfill_history'));
    expect(first).toMatchObject({ processedCount: 10, remaining: 20, window: 250, finishedGames: 30 });
    // #419: entries kept before the winners' curves get them from the kept histories (none to fill here).
    expect(first.winnerCurves).toEqual({ filled: 0, unfilled: 0 });
    expect(historyReads()).toBe(10);
    const second = payload(await h!.call('warapp_backfill_history', { limit: 25 }));
    expect(second).toMatchObject({ processedCount: 20, remaining: 0 });
    expect(historyReads()).toBe(30);
    const third = payload(await h!.call('warapp_backfill_history'));
    expect(third).toMatchObject({ processedCount: 0, remaining: 0 });
    expect(historyReads()).toBe(30);
  });

  it('caps the batch at 25 and honours a narrower window', async () => {
    await harness();
    expect((await h!.call('warapp_backfill_history', { limit: 26 })).isError).toBe(true);
    const r = payload(await h!.call('warapp_backfill_history', { limit: 25, window: 5 }));
    expect(r).toMatchObject({ processedCount: 5, remaining: 0, window: 5, outsideWindow: 25 });
  });

  /** The finished records on disk (the processed marks left out), rewritten by `edit`. */
  type Backfill = { games: Record<string, unknown>[]; processed: Record<string, unknown>[]; processedCount: number; collectorVersion: number };
  const backfill = async (args?: Record<string, unknown>) => payload(await h!.call('warapp_backfill_history', args)) as unknown as Backfill;
  const editRecords = (edit: (r: Record<string, unknown>) => Record<string, unknown> | null) => {
    const dir = join(h!.dataDir!, 'finished');
    for (const f of readdirSync(dir).filter((x) => /^[0-9a-f]{32}\.json$/.test(x))) {
      const next = edit(JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);
      if (next === null) rmSync(join(dir, f));
      else writeFileSync(join(dir, f), JSON.stringify(next));
    }
  };

  it('lists every game considered one by one: what it holds and what this call did', async () => {
    await harness();
    const r = await backfill({ limit: 2 });
    expect(r.collectorVersion).toBe(1);
    expect(r.games).toHaveLength(30);
    expect(r.games[0]).toEqual({
      gameId: 2029,
      state: 'recorded',
      outdated: false,
      status: 'history-unreadable',
      collector: 1,
      failure: { reason: 'absent' },
      kinds: ['legacy'],
      result: 'won',
      thisCall: 'read',
    });
    expect(r.games[2]).toEqual({ gameId: 2027, state: 'not-processed', thisCall: 'waiting' });
    expect(r.processed[0]).toMatchObject({ gameId: 2029, status: 'history-unreadable', failure: { reason: 'absent' } });
    // A later call reads nothing for them and still lists them.
    const again = await backfill({ game_ids: [2029] });
    expect(again.games).toEqual([expect.objectContaining({ gameId: 2029, state: 'recorded' })]);
    expect(again.games[0]).not.toHaveProperty('thisCall');
    expect(historyReads()).toBe(2);
  });

  it('game_ids: only those games; one not a finished game of mine is named apart', async () => {
    await harness();
    const r = await backfill({ game_ids: [2010, 2011, 99] });
    expect(r.games.map((g) => g.gameId)).toEqual([2011, 2010]);
    expect(r).toMatchObject({ processedCount: 2, remaining: 0, notFinishedOrNotMine: [99] });
    expect(r).not.toHaveProperty('outsideWindow');
    expect(historyReads()).toBe(2);
  });

  it('reread failed: one more history read each, once per process', async () => {
    await harness();
    await h!.call('warapp_backfill_history', { game_ids: [2029, 2028] });
    expect(historyReads()).toBe(2);
    const r = await backfill({ game_ids: [2029], reread: 'failed' });
    expect(r.processed).toEqual([{ gameId: 2029, status: 'history-unreadable', reread: true, failure: { reason: 'absent' } }]);
    expect(r.games[0]).toMatchObject({ gameId: 2029, thisCall: 'reread' });
    expect(historyReads()).toBe(3);
    // The same process does not spend it twice.
    const twice = await backfill({ game_ids: [2029], reread: 'failed' });
    expect(twice.processed).toEqual([{ gameId: 2029, status: 'attempted', reread: true }]);
    expect(historyReads()).toBe(3);
  });

  it('reread outdated: only records kept under an older collector version', async () => {
    await harness();
    await h!.call('warapp_backfill_history', { game_ids: [2029, 2028] });
    const none = await backfill({ game_ids: [2029, 2028], reread: 'outdated' });
    expect(none.processedCount).toBe(0);
    // A record kept before the field reads as collector 0: outdated.
    editRecords(({ collector: _, ...r }) => r);
    const listed = await backfill({ game_ids: [2029, 2028] });
    expect(listed.games.every((g) => g.outdated && g.collector === 0)).toBe(true);
    const r = await backfill({ game_ids: [2029, 2028], reread: 'outdated' });
    expect(r.processedCount).toBe(2);
    expect(r.games.every((g) => !g.outdated && g.collector === 1)).toBe(true);
    expect(historyReads()).toBe(4);
  });

  it('a record the bound pruned reads processed-record-pruned; reread all reads it again', async () => {
    await harness();
    await h!.call('warapp_backfill_history', { game_ids: [2029] });
    editRecords(() => null);
    const listed = await backfill({ game_ids: [2029] });
    expect(listed.games).toEqual([{ gameId: 2029, state: 'processed-record-pruned' }]);
    expect(historyReads()).toBe(1);
    const r = await backfill({ game_ids: [2029], reread: 'failed' });
    expect(r.processedCount).toBe(0);
    const all = await backfill({ game_ids: [2029], reread: 'all' });
    expect(all.processed).toEqual([expect.objectContaining({ gameId: 2029, reread: true, status: 'history-unreadable' })]);
    expect(historyReads()).toBe(2);
  });

  it('a re-read that fails never replaces a captured record', async () => {
    await harness();
    await h!.call('warapp_backfill_history', { game_ids: [2029] });
    editRecords((r) => ({ ...r, status: 'captured', failure: undefined }));
    const r = await backfill({ game_ids: [2029], reread: 'all' });
    expect(r.processed).toEqual([{ gameId: 2029, status: 'history-unreadable', reread: true, failure: { reason: 'absent' }, keptPrevious: true }]);
    expect(r.games[0]).toMatchObject({ state: 'recorded', status: 'captured' });
    expect(historyReads()).toBe(2);
  });

  it('is a write to local state only, never destructive', async () => {
    await harness();
    const t = (await h!.harness.client.listTools()).tools.find((x) => x.name === 'warapp_backfill_history');
    expect(t?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(t?.description).toMatch(/never writes to war\.app/);
  });
});
