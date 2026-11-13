// socket.io v0.9 packet helpers shared by both push transports (xhr-polling
// over the bridge, src/push/socketio.ts; the direct WebSocket,
// src/push/websocket.ts). Pure functions — no I/O.

export const SOCKET_URL = 'https://war.app/socket.io/1/';

export interface Handshake {
  sid: string;
  heartbeatMs: number;
  closeMs: number;
  transports: string[];
}

/** Parse a handshake reply `sid:heartbeat:close:transports`; throws on anything else. */
export function parseHandshake(body: string): Handshake {
  const parts = body.trim().split(':');
  const [sid, hb, close, transports] = parts;
  if (parts.length !== 4 || !sid || !/^[A-Za-z0-9_-]+$/.test(sid) || transports === undefined) {
    throw new Error('war.app did not answer the socket handshake with a session.');
  }
  return {
    sid,
    heartbeatMs: (Number(hb) || 0) * 1000,
    closeMs: (Number(close) || 0) * 1000,
    transports: transports.split(','),
  };
}

/** Split a poll body into packets (one bare packet, or the `�<len>�` framing). */
export function splitPayload(body: string): string[] {
  if (!body.startsWith('�')) return body === '' ? [] : [body];
  const out: string[] = [];
  let i = 0;
  while (i < body.length && body[i] === '�') {
    const end = body.indexOf('�', i + 1);
    if (end < 0) break;
    const len = Number(body.slice(i + 1, end));
    if (!Number.isInteger(len) || len < 0) break;
    out.push(body.slice(end + 1, end + 1 + len));
    i = end + 1 + len;
  }
  return out;
}

export type Packet =
  | { type: 'disconnect' }
  | { type: 'connect' }
  | { type: 'heartbeat' }
  | { type: 'message'; data: string }
  | { type: 'noop' }
  /** `7:::<reason>`: the server refused the session (e.g. `1+0`, "client not handshaken"). */
  | { type: 'error'; reason: string }
  | { type: 'other'; raw: string };

/** Parse one packet `type:id:endpoint[:data]`. */
export function parsePacket(raw: string): Packet {
  const type = raw.split(':', 1)[0];
  switch (type) {
    case '0':
      return { type: 'disconnect' };
    case '1':
      return { type: 'connect' };
    case '2':
      return { type: 'heartbeat' };
    case '8':
      return { type: 'noop' };
    case '7': {
      const parts = raw.split(':');
      return { type: 'error', reason: parts.slice(3).join(':') };
    }
    case '3': {
      // Data follows the third colon.
      let at = -1;
      for (let n = 0; n < 3; n++) {
        at = raw.indexOf(':', at + 1);
        if (at < 0) return { type: 'other', raw };
      }
      return { type: 'message', data: raw.slice(at + 1) };
    }
    default:
      return { type: 'other', raw };
  }
}
