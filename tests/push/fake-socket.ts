// A fake war.app socket.io v0.9 endpoint (xhr-polling) for the bridge mock.
// Everything is synthetic: made-up session ids, frames built by this
// project's own encoder. It enforces the rule verified live — a POST before
// the first poll has returned the connect packet is HTTP 400.
import type { HttpResponse } from '@fetchproxy/server';
import { encodeReply, encodeRequest, toHex, type ExtrasUp } from '../../src/protocol/codec.js';
import { Method } from '../../src/protocol/methods.js';
import type { BridgeHandler, BridgeRequest } from '../bridge-mock.js';

export const SOCKET_PREFIX = 'https://war.app/socket.io/1/';

/** One scripted answer to a poll: a payload string, or a whole HTTP response. */
export type PollAnswer = string | HttpResponse;

export interface FakeSocketIo {
  handler: BridgeHandler;
  /** Every socket.io request, in order. */
  requests: BridgeRequest[];
  /** POST bodies that were accepted, with the session they were sent on. */
  posts: Array<{ sid: string; body: string; contentType: string | undefined }>;
  /** Handshakes served so far. */
  handshakes: () => number;
  /** POSTs refused with 400 because they came before the connect packet. */
  rejectedPosts: () => number;
  /** Queue an answer for the next poll (answers a waiting poll at once). */
  push: (answer: PollAnswer) => void;
  /** Answer the next handshake(s) with these responses instead of a session. */
  failHandshake: (...answers: HttpResponse[]) => void;
  /** Resolves when some poll is waiting on an empty queue (the client is idle). */
  idle: () => Promise<void>;
  /** Release every waiting poll with a noop; later requests get HTTP 503. */
  close: () => void;
}

const res = (status: number, body: string, url: string): HttpResponse => ({ status, body, url });

/** A fake socket.io server. Session ids are `sid1`, `sid2`, … per handshake. */
export function fakeSocketIo(opts: { heartbeat?: number; close?: number; transports?: string } = {}): FakeSocketIo {
  const requests: BridgeRequest[] = [];
  const posts: FakeSocketIo['posts'] = [];
  const queue: PollAnswer[] = [];
  const handshakeFailures: HttpResponse[] = [];
  const connected = new Set<string>();
  let waiting: Array<(a: PollAnswer) => void> = [];
  let idleWaiters: Array<() => void> = [];
  let handshakes = 0;
  let rejected = 0;
  let closed = false;

  const next = (): Promise<PollAnswer> => {
    const q = queue.shift();
    if (q !== undefined) return Promise.resolve(q);
    if (closed) return Promise.resolve('8::');
    const p = new Promise<PollAnswer>((resolve) => waiting.push(resolve));
    const idle = idleWaiters;
    idleWaiters = [];
    idle.forEach((f) => f());
    return p;
  };

  const handler: BridgeHandler = async (req) => {
    requests.push(req);
    // Closed: the server is gone (a client backs off rather than spinning on noops).
    if (closed) return res(503, '', req.path);
    const url = new URL(req.path);
    if (url.pathname === '/socket.io/1/') {
      handshakes++;
      const fail = handshakeFailures.shift();
      if (fail) return fail;
      return res(
        200,
        `sid${handshakes}:${opts.heartbeat ?? 15}:${opts.close ?? 10}:${opts.transports ?? 'websocket,xhr-polling'}`,
        req.path,
      );
    }
    const m = /^\/socket\.io\/1\/xhr-polling\/([^/]+)$/.exec(url.pathname);
    if (!m) return res(404, '', req.path);
    const sid = m[1]!;
    if (req.method === 'POST') {
      if (!connected.has(sid)) {
        rejected++;
        return res(400, '', req.path);
      }
      posts.push({ sid, body: req.body ?? '', contentType: req.headers['content-type'] });
      return res(200, '1', req.path);
    }
    if (!connected.has(sid)) {
      connected.add(sid);
      return res(200, '1::', req.path);
    }
    const a = await next();
    return typeof a === 'string' ? res(200, a, req.path) : a;
  };

  return {
    handler,
    requests,
    posts,
    handshakes: () => handshakes,
    rejectedPosts: () => rejected,
    push: (answer) => {
      const w = waiting.shift();
      if (w) w(answer);
      else queue.push(answer);
    },
    failHandshake: (...answers) => {
      handshakeFailures.push(...answers);
    },
    idle: () => (waiting.length > 0 ? Promise.resolve() : new Promise<void>((r) => idleWaiters.push(r))),
    close: () => {
      closed = true;
      const w = waiting;
      waiting = [];
      w.forEach((f) => f('8::'));
    },
  };
}

/** Route socket.io paths to `socket` and everything else to `rest`. */
export function withSocket(socket: FakeSocketIo, rest: BridgeHandler): BridgeHandler {
  return (req) => (req.path.startsWith(SOCKET_PREFIX) ? socket.handler(req) : rest(req));
}

const PUSH_EXTRAS: ExtrasUp = {
  dict: null,
  client: 'v6.07.0.1',
  serverInfoVersionA: 1,
  serverInfoVersionB: 2,
  fDb: null,
  kFa: null,
  platform: 0,
};

/** The message number every server push carries (0x80000000 as an int32). */
export const PUSH_MSG_NUM = -0x80000000;

/**
 * A synthetic GameUpdated push frame, as uppercase hex: the game id, the chat and non-chat flags, no
 * dict. `bare`: the game id alone (an older shape, still read as a plain update).
 */
export function gameUpdatedHex(gameId: number, opts: { chat?: boolean; bare?: boolean } = {}): string {
  return toHex(
    encodeRequest({
      method: Method.GameUpdated,
      msgNum: PUSH_MSG_NUM,
      extras: PUSH_EXTRAS,
      email: null,
      params: (w) => (opts.bare ? w.int32(gameId) : w.int32(gameId).bool(opts.chat ?? false).bool(!opts.chat).bool(false)),
    }),
  );
}

/** A synthetic Subscribe reply: `rejected` maps a topic to an error code; null = all accepted. */
export function subscribeReplyHex(msgNum: number, rejected: Record<string, number> | null): string {
  return toHex(
    encodeReply({
      method: Method.Subscribe,
      msgNum,
      body: (w) => {
        if (rejected === null) {
          w.bool(false);
          return;
        }
        w.bool(true).dict(
          new Map(Object.entries(rejected)),
          (ww, k) => ww.string(k),
          (ww, v) => ww.int32(v),
        );
      },
    }),
  );
}

/** socket.io v0.9 multi-packet framing: `�<len>�<packet>` per packet. */
export function framed(...packets: string[]): string {
  return packets.map((p) => `�${p.length}�${p}`).join('');
}
