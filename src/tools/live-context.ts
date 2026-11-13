// What the live-game tools share: the GameFeed client (players, map, settings,
// chat), the web-client RPC channel through the bridge (board, picks, sends),
// and the client bundle whose readers decode the board.
import { McpToolError, type EnvSource } from '@chrischall/mcp-utils';
import type { WarappClient } from '../client.js';
import { dataDir } from '../config.js';
import { inGameId, readLatestGameInfo, standingFromInfo, type ClassReader, type LiveTerritory } from '../live.js';
import type { Game } from '../normalize.js';
import { BUNDLE_FETCH_TIMEOUT_MS, BUNDLE_MAX_BYTES, BundleProvider, type DecoderReport } from '../protocol/bundle.js';
import {
  Method,
  readTerritoryPicks,
  writeGetLatestGameInfoParams,
  writeGetTerritoryPicksParams,
} from '../protocol/methods.js';
import { WarappRpc } from '../protocol/rpc.js';
import type { ReadyFetchBridge } from '../direct/transport.js';
import { BRIDGE_DOMAINS } from '../transport-bridge.js';
import { isHosted } from '../hosted.js';

export interface LiveContext {
  client: WarappClient;
  rpc: WarappRpc;
  /** The loaded client bundle (cached per process). */
  bundle: () => Promise<ClassReader>;
  /** What the last loaded bundle's decoding rests on (#148); undefined before one has loaded. Never loads one. */
  decoderReport: () => DecoderReport | undefined;
  /**
   * The signed-in account's invite token (= its GameFeed player id), read from
   * war.app's InviteToken page through the bridge; `undefined` when it cannot be read.
   * A success is cached for at most {@link IDENTITY_TTL_MS} and only while the
   * transport state (`identity`) is unchanged; `fresh: true` re-reads it — every
   * write's plan step does, so its preview and checks are for the account that acts.
   */
  myInviteToken: (opts?: { fresh?: boolean }) => Promise<number | undefined>;
  /**
   * The signed-in account's in-game id, sliced from the token TEXT: a token whose first check
   * digit is 0 loses it as a number, and the slice would then be wrong (#130). Cached and
   * re-read (`fresh`) exactly like {@link LiveContext.myInviteToken}.
   */
  myInGameId: (opts?: { fresh?: boolean }) => Promise<number | undefined>;
  /**
   * Both of the above from ONE read of the token, for a caller that needs the account a write is
   * bound to and its in-game id: two separate reads could answer for two accounts.
   */
  myIdentity: (opts?: { fresh?: boolean }) => Promise<{ token: number; inGameId: number } | undefined>;
  /** Discard the cached signed-in account (a session was linked: it may be another account). */
  forgetIdentity: () => void;
  /** GET a war.app page as text through the signed-in tab. */
  fetchPage: (url: string) => Promise<string>;
  /** Where state that survives a restart lives (bundle cache, last planned boards); none: nothing is cached. */
  dataDir?: string;
  /** A hosted child (src/hosted.ts): no direct transport, so no hint suggests linking a session. */
  hosted?: boolean;
}

/**
 * The token from war.app's `/InviteToken` page ("Your invite token is N"), as text — the
 * check digits are part of it, a leading 0 included (#130).
 */
export function parseInviteTokenText(html: string): string | undefined {
  const m = /Your invite token is\s*(\d{5,20})/.exec(html);
  if (!m) return undefined;
  return Number.isSafeInteger(Number(m[1])) ? m[1] : undefined;
}

/** The token as a number (= the GameFeed player id GameFeed reports). */
export function parseInviteToken(html: string): number | undefined {
  const t = parseInviteTokenText(html);
  return t === undefined ? undefined : Number(t);
}

export const INVITE_TOKEN_URL = 'https://war.app/InviteToken';

export interface LiveContextOptions {
  client: WarappClient;
  bridge: ReadyFetchBridge;
  env?: EnvSource;
  /** Used for the bundle download from War.app's CDN (not a war.app page). */
  fetchImpl?: typeof fetch;
  /** Test seam: the bundle, instead of discovering and downloading it. */
  bundle?: () => Promise<ClassReader>;
  /**
   * A key for the state that decides which account answers (the active leg, the
   * linked session's capture time, its stale flag — `WarappDirectBridge.identityState`).
   * Any change discards the cached account. Absent: only the lifetime bounds it.
   */
  identity?: () => Promise<string>;
  /** Test seam: the clock (ms) for the cache lifetime (default `Date.now`). */
  now?: () => number;
}

/**
 * How long a read may reuse the signed-in account. Short: on the browser bridge
 * the tab can be signed in as someone else without any state this process sees.
 */
export const IDENTITY_TTL_MS = 60_000;

const onBridge = (url: URL) => BRIDGE_DOMAINS.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`));

export interface BundleFetchLimits {
  /** Headers and body together (default {@link BUNDLE_FETCH_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Enforced while the body streams (default {@link BUNDLE_MAX_BYTES}). */
  maxBytes?: number;
}

/**
 * Read a response body as UTF-8, cancelling it as soon as it passes `maxBytes` or `signal` aborts
 * (the download timed out): nothing keeps pulling the body in the background after that, even when
 * the fetch itself ignored the signal.
 */
async function readCapped(res: Response, maxBytes: number, what: string, signal: AbortSignal): Promise<string> {
  const tooLarge = () => new Error(`${what} is larger than ${maxBytes} bytes`);
  const aborted = () => (signal.reason instanceof Error ? signal.reason : new Error(`${what} was aborted`));
  if (signal.aborted) {
    await res.body?.cancel().catch(() => {});
    throw aborted();
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw aborted();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
    // Decoded as `Response.text()` decodes (a leading byte-order mark dropped), so the cached
    // bundle is the same text the unbounded read produced.
    return new TextDecoder().decode(Buffer.concat(chunks));
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * GET a URL as text: war.app pages through the signed-in tab (the bridge's
 * only domain), the CDN-hosted bundle directly — with a timeout over the whole
 * download and a byte cap enforced while the body streams, so an endless or
 * enormous response is cut off rather than buffered.
 */
export function bundleFetcher(bridge: ReadyFetchBridge, fetchImpl: typeof fetch = fetch, limits: BundleFetchLimits = {}) {
  const timeoutMs = limits.timeoutMs ?? BUNDLE_FETCH_TIMEOUT_MS;
  const maxBytes = limits.maxBytes ?? BUNDLE_MAX_BYTES;
  return async (url: string): Promise<string> => {
    const u = new URL(url);
    if (onBridge(u)) {
      const res = await (await bridge.ready()).fetch({ method: 'GET', path: u.href });
      if (res.status !== 200) throw new Error(`war.app answered HTTP ${res.status} for ${u.pathname}`);
      return res.body;
    }
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Raced as well as signalled, so a fetch that ignores the signal still cannot hang the load; the
    // body reader is cancelled on the same signal, so nothing keeps pulling after the timeout.
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`${u.hostname} timed out after ${timeoutMs} ms fetching the client bundle`);
        ac.abort(e);
        reject(e);
      }, timeoutMs);
    });
    const download = (async () => {
      const res = await fetchImpl(u.href, { redirect: 'error', signal: ac.signal });
      if (!res.ok) throw new Error(`${u.hostname} answered HTTP ${res.status} for the client bundle`);
      return readCapped(res, maxBytes, `the client bundle from ${u.hostname}`, ac.signal);
    })();
    try {
      return await Promise.race([download, timedOut]);
    } finally {
      clearTimeout(timer);
      download.catch(() => {}); // a download still settling after a timeout is not unhandled
    }
  };
}

/** What to do about a frozen tab, said on every bridged `/Services` timeout (#130). */
export const FROZEN_TAB_HINT =
  'Chrome freezes background tabs, and war.app calls are relayed through a page tab: a frozen tab stalls them ' +
  'while page reads still work. Reload or focus a war.app tab, then check the game before retrying.';

/** A bridge timeout (fetchproxy's `FetchproxyTimeoutError`, matched by name across package copies). */
const isBridgeTimeout = (e: unknown): e is Error => e instanceof Error && e.name === 'FetchproxyTimeoutError';

/**
 * The bridge with its `/Services` POST timeouts carrying {@link FROZEN_TAB_HINT}: the message is
 * kept whole (it says whether the call may already have run), only the hint is added.
 */
function withFrozenTabHint(bridge: ReadyBridge): ReadyBridge {
  return {
    fetch: async (init) => {
      try {
        return await bridge.fetch(init);
      } catch (e) {
        if (!isBridgeTimeout(e)) throw e;
        throw new McpToolError(e.message, { kind: 'unknown', hint: FROZEN_TAB_HINT, cause: e });
      }
    },
  };
}

type ReadyBridge = Awaited<ReturnType<ReadyFetchBridge['ready']>>;

/** A failed send's message for a result warning, with the frozen-tab hint when it was a bridge timeout. */
export function failureText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return e instanceof McpToolError && e.hint === FROZEN_TAB_HINT ? `${message} ${FROZEN_TAB_HINT}` : message;
}

export function createLiveContext(opts: LiveContextOptions): LiveContext {
  const rpc = new WarappRpc({
    bridge: async () => withFrozenTabHint(await opts.bridge.ready()),
    ...(opts.env ? { env: opts.env as NodeJS.ProcessEnv } : {}),
  });
  const dir = dataDir(opts.env);
  const provider = new BundleProvider({
    dataDir: dir,
    fetchText: bundleFetcher(opts.bridge, opts.fetchImpl),
  });
  const load = opts.bundle ?? (() => provider.get());
  let lastBundle: ClassReader | undefined;
  const fetchText = bundleFetcher(opts.bridge, opts.fetchImpl);
  const identity = opts.identity ?? (async () => '');
  const now = opts.now ?? Date.now;
  // The account behind the transport can change under a running process (a
  // relink, or an expired direct session falling back to a tab signed in as
  // someone else), so a success is kept only under the state key it was read
  // in, and only for IDENTITY_TTL_MS. A failure (bridge down, signed out) is
  // never kept: the next call retries. Every read takes a generation number
  // when it starts, and only a read newer than the last one that settled may
  // set or clear the cache, so a slow, older read finishing after a fresh one
  // never overwrites it; forgetIdentity makes every read in flight older. The
  // token is kept as TEXT: its check digits, a leading 0 included, are part of
  // it (#130).
  let cached: { key: string; at: number; token: string } | undefined;
  let started = 0;
  let settled = 0;
  const tokenText = async (o: { fresh?: boolean } = {}): Promise<string | undefined> => {
    if (!o.fresh && cached && now() - cached.at < IDENTITY_TTL_MS && cached.key === (await identity())) {
      return cached.token;
    }
    const gen = ++started;
    const before = await identity();
    const t = await fetchText(INVITE_TOKEN_URL)
      .then(parseInviteTokenText)
      .catch(() => undefined);
    if (gen <= settled) return t;
    if (t === undefined) {
      settled = gen;
      cached = undefined;
      return t;
    }
    // Kept only when the state did not move during the read. If it did (the
    // read itself fell back, or a concurrent call moved the router), the answer
    // may come from either leg, so it is returned but not cached: the next
    // resolve re-reads under the settled state.
    const after = await identity();
    if (gen <= settled) return t;
    settled = gen;
    cached = before === after ? { key: after, at: now(), token: t } : undefined;
    return t;
  };
  const myIdentity = async (o: { fresh?: boolean } = {}): Promise<{ token: number; inGameId: number } | undefined> => {
    const t = await tokenText(o);
    return t === undefined ? undefined : { token: Number(t), inGameId: inGameId({ id: Number(t), feedId: t }) };
  };
  return {
    myInviteToken: async (o) => (await myIdentity(o))?.token,
    myInGameId: async (o) => (await myIdentity(o))?.inGameId,
    myIdentity,
    forgetIdentity: () => {
      cached = undefined;
      settled = started;
    },
    fetchPage: fetchText,
    dataDir: dir,
    hosted: isHosted(opts.env ?? process.env),
    client: opts.client,
    rpc,
    decoderReport: () => lastBundle?.report?.(),
    bundle: async () => {
      try {
        const b = await load();
        lastBundle = b;
        return b;
      } catch (e) {
        if (e instanceof McpToolError) throw e;
        throw new McpToolError(`Could not load war.app's client bundle: ${e instanceof Error ? e.message : String(e)}`, {
          kind: 'unknown',
          hint: 'The live-game tools decode the board with the war.app web client. Make sure a signed-in war.app tab is open and paired, then retry.',
          cause: e,
        });
      }
    },
  };
}

/**
 * The account a write's gate binds (`gate.account`): the signed-in account's
 * GameFeed id, read fresh in the plan step. Binding it makes the confirmToken
 * and the elicitation approval commit to the account, so an approval given for
 * one account never acts as another: the token minted for A's preview fails to
 * validate once the plan resolves B. `undefined` (account unknown) binds as absent.
 */
export function writeAccount(token: number | string | undefined): string | undefined {
  return token === undefined ? undefined : String(token);
}

/**
 * Refuse a write's execute step unless the signed-in account is still the one
 * its plan bound (`approved`, from {@link writeAccount}). Plan and execute are
 * separated by the user's confirmation, and the account behind the transport
 * can change in between (a relink, an expired direct session falling back to a
 * tab signed in as someone else). The confirmToken rail is covered by the
 * gate's binding; this covers elicitation, where plan and execute run in one
 * call. Nothing is checked when the plan bound no account.
 */
export async function requireApprovedAccount(
  ctx: Pick<LiveContext, 'myInviteToken'>,
  approved: string | undefined,
): Promise<void> {
  if (approved === undefined) return;
  const now = await ctx.myInviteToken({ fresh: true });
  if (now === undefined) {
    throw new McpToolError('Could not confirm which war.app account is signed in, so nothing was sent.', {
      hint:
        'Make sure a signed-in war.app tab is open and paired (or the linked session is current), then preview ' +
        'the action again.',
    });
  }
  if (String(now) !== approved) {
    throw new McpToolError('The signed-in war.app account changed since this action was previewed, so nothing was sent.', {
      hint: 'Preview the action again: it will be checked for the account that is signed in now.',
    });
  }
}

/**
 * The MoveOrder that makes the first turn a speed race ("No-luck cycle": the
 * players who enter their first orders — or, in manual distribution, their
 * picks — fastest move first). Read from the client bundle: in such a game
 * war.app withholds the board until the player presses Begin (BeginFirstTurn,
 * method 78), which starts their first-turn timer.
 */
export const SPEED_FIRST_TURN_MOVE_ORDER = 'NoLuckCycle';

/**
 * Whether a game with no board is waiting for this player to press Begin: it is
 * on its first turn (or picking), and its move order is the speed first turn —
 * or GameFeed did not say, since the web client shows Begin whenever a playing
 * seat has no standing.
 */
export function awaitsBegin(game: Game): boolean {
  if (game.state !== 'Playing' && game.state !== 'DistributingTerritories') return false;
  if ((game.numberOfTurns ?? 0) > 0) return false;
  const order = game.settings?.moveOrder;
  return order === undefined || order === SPEED_FIRST_TURN_MOVE_ORDER;
}

/** What to say when the board is hidden until Begin. */
export function beginFirstError(game: Game): McpToolError {
  const picking = game.state === 'DistributingTerritories';
  return new McpToolError(
    `war.app has no board for game ${game.id} yet: this game's first turn starts when you press Begin — call ` +
      (picking
        ? 'warapp_begin_turn, then choose and submit your picks at once: Begin starts the timer.'
        : 'warapp_begin_turn, then plan and submit at once: Begin starts the turn timer.'),
    {
      hint:
        'The first turn is a speed race (move order "No-luck cycle"): the players who ' +
        (picking ? 'pick fastest get their picks in a conflict.' : 'commit their first orders fastest move first.') +
        ' Call warapp_begin_turn only when ready to act straight away.',
    },
  );
}

/** The game's live board through the bridge; throws when war.app has none for it. */
export async function loadLiveTerritories(ctx: LiveContext, game: Game): Promise<LiveTerritory[]> {
  return (await loadLiveGame(ctx, game)).territories;
}

/** The live board plus the decoded LatestGameInfo (cards live there); throws when war.app has no board. */
export async function loadLiveGame(ctx: LiveContext, game: Game): Promise<{ territories: LiveTerritory[]; info: unknown }> {
  const env = await ctx.rpc.call('GetLatestGameInfo', Method.GetLatestGameInfo, (w) =>
    writeGetLatestGameInfoParams(w, game.id),
  );
  const bundle = await ctx.bundle();
  const info = readLatestGameInfo(bundle, env.body);
  const territories = standingFromInfo(info);
  if (!territories) {
    if (awaitsBegin(game)) throw beginFirstError(game);
    throw new McpToolError(`war.app has no board for game ${game.id} yet (game state: ${game.state}).`, {
      hint: 'A lobby has no board until territories are distributed. warapp_get_map works without one.',
    });
  }
  return { territories, info };
}

/** A player's current territory picks, in priority order. */
export async function loadPicks(ctx: LiveContext, gameId: number, inGamePlayerId: number): Promise<number[]> {
  const env = await ctx.rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, (w) =>
    writeGetTerritoryPicksParams(w, gameId, inGamePlayerId),
  );
  return readTerritoryPicks(env.body);
}
