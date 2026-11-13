import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSession,
  readSession,
  readSessionSync,
  scrubToken,
  SESSION_HOST,
  sessionDirVerdict,
  sessionFilePath,
  sessionTmpPath,
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

  it.skipIf(process.platform === 'win32')('tightens an existing directory of ours to 0700', async () => {
    const shared = join(dir, 'shared');
    await mkdir(shared, { mode: 0o755 });
    await chmod(shared, 0o755);
    const file = join(shared, 'session.json');
    await writeSession({ authToken: FAKE_TOKEN, capturedAt: '2026-11-12T00:00:00.000Z', host: SESSION_HOST }, {
      WARAPP_SESSION_FILE: file,
    });
    expect((await stat(shared)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('never uses or overwrites a file already at the old predictable tmp name', async () => {
    const file = sessionFilePath(env);
    const planted = `${file}.${process.pid}.tmp`;
    await writeFile(planted, 'planted');
    await writeSession({ authToken: FAKE_TOKEN, capturedAt: '2026-11-12T00:00:00.000Z', host: SESSION_HOST }, env);
    expect(await readFile(planted, 'utf8')).toBe('planted');
    expect((await readSession(env))?.authToken).toBe(FAKE_TOKEN);
  });

  it.skipIf(process.platform === 'win32')('writes through no symlink at the old tmp name, and leaves no tmp file behind', async () => {
    const file = sessionFilePath(env);
    const target = join(dir, 'elsewhere.txt');
    await writeFile(target, 'untouched');
    await symlink(target, `${file}.${process.pid}.tmp`);
    await writeSession({ authToken: FAKE_TOKEN, capturedAt: '2026-11-12T00:00:00.000Z', host: SESSION_HOST }, env);
    expect(await readFile(target, 'utf8')).toBe('untouched');
    const left = (await readdir(dir)).filter((n) => n.endsWith('.tmp') && n !== `session.json.${process.pid}.tmp`);
    expect(left).toEqual([]);
  });

  it('names its tmp file randomly, not by the process id alone', async () => {
    const names = new Set<string>();
    for (let i = 0; i < 3; i++) names.add(sessionTmpPath('/x/session.json'));
    expect(names.size).toBe(3);
    for (const n of names) {
      expect(n.startsWith('/x/session.json.')).toBe(true);
      expect(n).not.toBe(`/x/session.json.${process.pid}.tmp`);
    }
  });

  it('removes its tmp file when the write fails', async () => {
    const file = sessionFilePath(env);
    // The rename target is a non-empty directory, so the rename fails.
    await mkdir(file);
    await writeFile(join(file, 'x'), 'x');
    await expect(
      writeSession({ authToken: FAKE_TOKEN, capturedAt: '2026-11-12T00:00:00.000Z', host: SESSION_HOST }, env),
    ).rejects.toThrow();
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
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

describe('sessionDirVerdict', () => {
  const ME = 501;
  it('accepts a private directory of ours', () => {
    expect(sessionDirVerdict({ mode: 0o40700, uid: ME }, ME)).toBe('ok');
  });
  it('tightens a directory of ours with group or other bits', () => {
    expect(sessionDirVerdict({ mode: 0o40755, uid: ME }, ME)).toBe('tighten');
    expect(sessionDirVerdict({ mode: 0o40710, uid: ME }, ME)).toBe('tighten');
    expect(sessionDirVerdict({ mode: 0o41777, uid: ME }, ME)).toBe('tighten');
  });
  it('refuses a directory others can write to that is not ours', () => {
    expect(sessionDirVerdict({ mode: 0o41777, uid: 0 }, ME)).toBe('refuse');
    expect(sessionDirVerdict({ mode: 0o40775, uid: 502 }, ME)).toBe('refuse');
    expect(sessionDirVerdict({ mode: 0o40757, uid: 502 }, ME)).toBe('refuse');
  });
  it('leaves a root-owned directory that no one else can write to', () => {
    expect(sessionDirVerdict({ mode: 0o40755, uid: 0 }, ME)).toBe('ok');
  });
  it("refuses another user's directory whatever its mode bits say", () => {
    // We could write into it only through an ACL its owner controls (and its
    // owner could set an inheritable ACE that reaches the session file).
    expect(sessionDirVerdict({ mode: 0o40755, uid: 502 }, ME)).toBe('refuse');
    expect(sessionDirVerdict({ mode: 0o40700, uid: 502 }, ME)).toBe('refuse');
  });
  it('checks nothing where there are no POSIX owners', () => {
    expect(sessionDirVerdict({ mode: 0o40777, uid: 0 }, undefined)).toBe('ok');
  });
});

describe('writeSession and macOS ACLs', () => {
  const run = promisify(execFile);
  const hasAcl = async (p: string) => /^\S{10}\+/.test((await run('/bin/ls', ['-led', p])).stdout);

  // The mode bits do not govern an ACL: chmod 0700 leaves an inheritable
  // "everyone allow read" entry in place, and a file created under it inherits it.
  it.skipIf(process.platform !== 'darwin')('an inheritable ACE on the directory never reaches session.json', async () => {
    const shared = join(dir, 'acl');
    await mkdir(shared, { mode: 0o755 });
    await chmod(shared, 0o755);
    await run('/bin/chmod', [
      '+a',
      'everyone allow read,list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit',
      shared,
    ]);
    expect(await hasAcl(shared)).toBe(true);
    const file = join(shared, 'session.json');
    await writeSession({ authToken: FAKE_TOKEN, capturedAt: '2026-11-12T00:00:00.000Z', host: SESSION_HOST }, {
      WARAPP_SESSION_FILE: file,
    });
    expect(await hasAcl(file)).toBe(false);
    expect(await hasAcl(shared)).toBe(false);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(shared)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform !== 'darwin')('rewriting a session file that already carries an ACL leaves none', async () => {
    const file = sessionFilePath(env);
    await writeSession({ authToken: FAKE_TOKEN, capturedAt: '2026-11-12T00:00:00.000Z', host: SESSION_HOST }, env);
    await run('/bin/chmod', ['+a', 'everyone allow read', file]);
    await writeSession({ authToken: FAKE_TOKEN, capturedAt: '2026-11-13T00:00:00.000Z', host: SESSION_HOST }, env);
    expect(await hasAcl(file)).toBe(false);
  });
});

describe('writeSession into a directory others can write to', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses, naming the directory and never the token',
    async () => {
      // The sticky world-writable temp directory belongs to root, not to us.
      const shared = await realpath('/tmp').catch(() => null);
      if (!shared || (await stat(shared)).uid === process.getuid?.()) return;
      const file = join(shared, `warapp-session-test-${process.pid}.json`);
      const err = await writeSession(
        { authToken: FAKE_TOKEN, capturedAt: '2026-11-12T00:00:00.000Z', host: SESSION_HOST },
        { WARAPP_SESSION_FILE: file },
      ).then(
        () => null,
        (e: unknown) => e as Error,
      );
      await rm(file, { force: true });
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain(shared);
      expect(err!.message).not.toContain(FAKE_TOKEN);
      await expect(stat(file)).rejects.toThrow();
    },
  );
});

describe('scrubToken', () => {
  it('scrubs the percent-encoded, form-encoded and JSON-escaped spellings', () => {
    const tok = 'a b"c/d+e';
    const form = new URLSearchParams({ v: tok }).toString().slice(2);
    for (const s of [`x ${encodeURIComponent(tok)} y`, `x ${form} y`, `x ${JSON.stringify(tok)} y`]) {
      const out = scrubToken(s, tok);
      expect(out).toContain('[warapp-session]');
      expect(out).not.toContain('c/d');
      expect(out).not.toContain('c%2Fd');
    }
  });

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
