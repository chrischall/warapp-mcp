// One web-client RPC round trip: build the frame, POST it as hex through the
// browser bridge to https://war.app/Services?m=<name>&js=1, decode the reply
// envelope, and carry the server's MessageExtrasDown values into the next
// request's MessageExtrasUp, as the real client does (docs/WEB-PROTOCOL.md).
import { McpToolError } from '@chrischall/mcp-utils';
import type { FetchproxyFetchInit, FetchproxyFetchResult } from '@chrischall/mcp-utils/fetchproxy';
import { readEmail } from '../config.js';
import {
  decodeReplyEnvelope,
  encodeRequest,
  fromHex,
  ProtocolError,
  toHex,
  type ExtrasDown,
  type ExtrasUp,
  type ReplyEnvelope,
  type Writer,
} from './codec.js';
import { Method } from './methods.js';

/** The client version string the current web client sends. */
export const CLIENT_VERSION = 'v6.07.0.1';
/** EnumSerialization_Platform: the website. */
export const PLATFORM_WEBSITE = 15;
/**
 * Server-info versions for the first request of a process, before any reply
 * has supplied the real ones (the values the web client was observed sending).
 */
export const INITIAL_SERVER_INFO_A = 348;
export const INITIAL_SERVER_INFO_B = 88732;

export const SERVICES_URL = 'https://war.app/Services';
export const CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=UTF-8';

/** Methods whose frame carries no auth block. */
const NO_AUTH_METHODS: ReadonlySet<number> = new Set([Method.GetMapDetails]);

/** Whether a method's parameters start with the auth (email) block. */
export function methodTakesAuth(methodId: number): boolean {
  return !NO_AUTH_METHODS.has(methodId);
}

/**
 * The web client's own wording for the server error codes this server can
 * meet (11, 51, 208: order commits; 33, 36, 333: chat; 254, 473, 750: joining
 * an open seat; 88: any game call).
 * 51 (`MustUseCard`, verified live) has no client wording; this is ours.
 */
export const SERVER_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  10: 'war.app refused the order sequence — card plays must come in turn-phase order.',
  11: 'Your orders deploy more or fewer armies than you are receiving this turn. Please verify your orders deploy the correct number.',
  51: 'You hold more cards than this game allows, so war.app requires you to play or discard one this turn.',
  33: 'Oops! This message is too long. Try breaking it into multiple smaller messages.',
  36: 'Your message was not sent because you have been sending too many messages to this game. Please try again later.',
  88: 'This game has been deleted.',
  208: 'The game has already advanced to the next turn. Please refresh.',
  333: 'This game has been archived and can no longer receive new chat.',
  254: 'Sorry, your slot was assigned to someone else by the game creator. Please ask the game creator to open up your slot.',
  473: "You don't have enough coins to join this game. Please deposit some coins and try again.",
  750: 'Sorry, the slot you joined is no longer available. Please try again with a different slot.',
};

/** The longest slice of an unmapped server message shown to the caller. */
const MAX_SERVER_MESSAGE = 200;

/** A ServerException reply (envelope kind 5). */
export class WarappServerError extends McpToolError {
  override name = 'WarappServerError';
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message, { kind: 'unknown' });
  }
}

/** The part of the bridge transport a call uses. */
export interface RpcBridge {
  fetch(init: FetchproxyFetchInit): Promise<FetchproxyFetchResult>;
}

export interface WarappRpcOptions {
  /** The started bridge (e.g. `() => bridge.ready()`). */
  bridge: () => Promise<RpcBridge>;
  /** The signed-in account's email. Defaults to `WARAPP_EMAIL` from `env`. */
  email?: () => string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The web-client RPC channel. Hold ONE per process: message numbers count up
 * per instance and the echoed extras live on it.
 */
export class WarappRpc {
  private readonly bridge: () => Promise<RpcBridge>;
  private readonly email: () => string;
  private nextMsgNum = 1;
  private state: ExtrasUp = {
    dict: new Map(),
    client: CLIENT_VERSION,
    serverInfoVersionA: INITIAL_SERVER_INFO_A,
    serverInfoVersionB: INITIAL_SERVER_INFO_B,
    fDb: null,
    kFa: null,
    platform: PLATFORM_WEBSITE,
  };

  constructor(opts: WarappRpcOptions) {
    this.bridge = opts.bridge;
    this.email = opts.email ?? (() => readEmail(opts.env));
  }

  /** A copy of the MessageExtrasUp the next request will carry. */
  get extras(): ExtrasUp {
    return { ...this.state, dict: this.state.dict === null ? null : new Map(this.state.dict) };
  }

  /**
   * Send one request and return its reply envelope, `body` positioned at the
   * method's result. A ServerException reply throws {@link WarappServerError}.
   */
  async call(methodName: string, methodId: number, writeParams?: (w: Writer) => void): Promise<ReplyEnvelope> {
    // Resolve the email first, so a missing one fails before anything is sent.
    const email = methodTakesAuth(methodId) ? this.email() : null;
    const msgNum = this.nextMsgNum++;
    const frame = encodeRequest({
      method: methodId,
      msgNum,
      extras: this.extras,
      email,
      ...(writeParams ? { params: writeParams } : {}),
    });

    const bridge = await this.bridge();
    const res = await bridge.fetch({
      method: 'POST',
      path: `${SERVICES_URL}?m=${encodeURIComponent(methodName)}&js=1`,
      headers: { 'content-type': CONTENT_TYPE },
      body: toHex(frame),
    });
    if (res.status !== 200) {
      throw new McpToolError(`war.app answered HTTP ${res.status} to ${methodName}.`, {
        status: res.status,
        kind: 'http',
      });
    }

    const env = this.decode(methodName, res.body);
    if (env.msgNum !== msgNum) {
      throw new McpToolError(
        `war.app answered ${methodName} with message number ${env.msgNum}, expected ${msgNum}.`,
        { kind: 'unknown' },
      );
    }
    if (env.method !== methodId) {
      throw new McpToolError(`war.app answered ${methodName} (method ${methodId}) with method ${env.method}.`, {
        kind: 'unknown',
      });
    }
    if (env.extrasDown) this.echo(env.extrasDown);
    if (env.error) throw serverError(methodName, env.error.code, env.error.message, email);
    return env;
  }

  private decode(methodName: string, body: string): ReplyEnvelope {
    let bytes: Uint8Array;
    try {
      bytes = fromHex(body);
    } catch {
      throw new McpToolError(
        `war.app did not answer ${methodName} with a protocol frame. Make sure a war.app tab is open and ` +
          'signed in, then retry.',
        { kind: 'unknown' },
      );
    }
    try {
      return decodeReplyEnvelope(bytes);
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      throw new McpToolError(`Could not decode war.app's reply to ${methodName}: ${e.message}`, {
        kind: 'unknown',
        cause: e,
      });
    }
  }

  /** Carry the reply's server-info versions and notification time forward. */
  private echo(down: ExtrasDown): void {
    if (down.serverInfo) {
      this.state.serverInfoVersionA = down.serverInfo.serverInfoVersionA;
      this.state.serverInfoVersionB = down.serverInfo.serverInfoVersionB;
    }
    if (down.unreadMail) this.state.kFa = down.unreadMail.kFa;
  }
}

function serverError(methodName: string, code: number, message: string | null, email: string | null): WarappServerError {
  const known = SERVER_ERROR_MESSAGES[code];
  if (known) return new WarappServerError(code, `${known} (war.app error ${code})`);
  // Unmapped: the message can be a whole server stack trace — keep its first
  // line, short, with the account email scrubbed out.
  let detail = (message ?? '').split(/\r?\n/, 1)[0]!.trim();
  if (email) detail = detail.split(email).join('[email]');
  if (detail.length > MAX_SERVER_MESSAGE) detail = `${detail.slice(0, MAX_SERVER_MESSAGE)}…`;
  const base = `war.app refused ${methodName} (server error ${code}).`;
  return new WarappServerError(code, detail ? `${base} ${detail}` : base);
}
