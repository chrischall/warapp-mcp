import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSession,
  readSession,
  readSessionSync,
  scrubToken,
  SESSION_HOST,
  sessionFilePath,
  writeSession,
  type Session,
} from '../../src/direct/session.js';

// A FAKE token only — never a real war.app AuthToken (see CLAUDE.md: no captures).
const FAKE_TOKEN = 'test-auth-token';

let dir: string;
let env: { MCP_DATA_DIR: string };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'warapp-session-'));
  env = { MCP_DATA_DIR: dir };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('sessionFilePath', () => {
  it('defaults to <dataDir>/session.json', () => {
    expect(sessionFilePath(env)).toBe(join(dir, 'session.json'));
  });

  it('honours WARAPP_SESSION_FILE', () => {
    expect(sessionFilePath({ ...env, WARAPP_SESSION_FILE: '/tmp/s.json' })).toBe('/tmp/s.json');
  });

  it('ignores a placeholder WARAPP_SESSION_FILE', () => {
    expect(sessionFilePath({ ...env, WARAPP_SESSION_FILE: '${user_config.session_file}' })).toBe(
      join(dir, 'session.json'),
    );
  });
});

describe('readSession / writeSession', () => {
  it('round-trips a written session', async () => {
    const session: Session = { authToken: FAKE_TOKEN, capturedAt: '2026-11-12T00:00:00.000Z', host: SESSION_HOST };
    await writeSession(session, env);
    expect(await readSession(env)).toEqual(session);
  });

  it('writes the file 0600 and its directory 0700, atomically', async () => {
    const nested = join(dir, 'nested');
    const file = join(nested, 'session.json');
    const nestedEnv = { WARAPP_SESSION_FILE: file };
    await writeSession({ authToken: FAKE_TOKEN, capturedAt: '2026-11-12T00:00:00.000Z', host: SESSION_HOST }, nestedEnv);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
    // No leftover tmp file from the atomic write.
    await expect(readFile(`${file}.${process.pid}.tmp`, 'utf8')).rejects.toThrow();
  });

  it('reads a missing file as null (never throws)', async () => {
    expect(await readSession(env)).toBeNull();
  });

  it('reads a corrupt or wrong-shaped file as null (never throws)', async () => {
    const path = sessionFilePath(env);
    for (const bad of [
      'not json at all',
      '{"authToken": 123}',
      '{"authToken": ""}',
      '{"capturedAt": "2026-11-12", "host": "war.app"}',
      `{"authToken": "${FAKE_TOKEN}", "capturedAt": "x", "host": "evil.example.com"}`,
      '[]',
      'null',
    ]) {
      await writeFile(path, bad);
      expect(await readSession(env)).toBeNull();
    }
  });
});

describe('readSessionSync', () => {
  it('round-trips a written session synchronously', async () => {
    const session: Session = { authToken: FAKE_TOKEN, capturedAt: '2026-11-12T00:00:00.000Z', host: SESSION_HOST };
    await writeSession(session, env);
    expect(readSessionSync(env)).toEqual(session);
  });

  it('reads a missing file as null (never throws)', () => {
    expect(readSessionSync(env)).toBeNull();
  });

  it('reads a corrupt or wrong-shaped file as null (never throws)', async () => {
    const path = sessionFilePath(env);
    for (const bad of ['not json at all', '{"authToken": 123}', '{"authToken": ""}', 'null', '[]']) {
      await writeFile(path, bad);
      expect(readSessionSync(env)).toBeNull();
    }
  });
});

describe('clearSession', () => {
  it('removes a linked session', async () => {
    await writeSession({ authToken: FAKE_TOKEN, capturedAt: '2026-11-12T00:00:00.000Z', host: SESSION_HOST }, env);
    await clearSession(env);
    expect(await readSession(env)).toBeNull();
  });

  it('is a no-op when no session is linked (never throws)', async () => {
    await expect(clearSession(env)).resolves.toBeUndefined();
  });
});

describe('scrubToken', () => {
  it('removes the token from a sample error string, by value', () => {
    const s = `war.app refused the request with Cookie: AuthToken=${FAKE_TOKEN}; AWSELB=y`;
    const out = scrubToken(s, FAKE_TOKEN);
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).toContain('war.app refused the request');
  });

  it('also scrubs a Bearer- or prefixed form (reuses stripBearer)', () => {
    const s = `header was "Bearer ${FAKE_TOKEN}" and bare ${FAKE_TOKEN}`;
    expect(scrubToken(s, `Bearer ${FAKE_TOKEN}`)).not.toContain(FAKE_TOKEN);
  });

  it('is a no-op when there is no token', () => {
    expect(scrubToken('nothing to hide', null)).toBe('nothing to hide');
    expect(scrubToken('nothing to hide', '')).toBe('nothing to hide');
  });
});
