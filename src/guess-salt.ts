// The local secret mixed into the border guess's seed (src/analysis/guess.ts `guessSeed`). The code
// is public, so a seed from the game id and turn alone could be reproduced by an opponent who reads
// it; with this salt the draw stays the same when a turn is planned again here, and unreadable
// elsewhere. Kept at `<dataDir>/guess-salt` (0600, atomic); without a data directory, or when it
// cannot be written, a salt for this process only. Never logged, never in a tool result.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SALT = /^[0-9a-f]{32}$/;
let processSalt: string | undefined;
const cached = new Map<string, string>();

export const guessSaltPath = (dir: string) => join(dir, 'guess-salt');

/** The salt for `dir` (created on first use), else this process's. Never throws. */
export async function guessSalt(dir: string | undefined): Promise<string> {
  const fallback = () => (processSalt ??= randomBytes(16).toString('hex'));
  if (!dir) return fallback();
  const hit = cached.get(dir);
  if (hit) return hit;
  const path = guessSaltPath(dir);
  try {
    const text = (await readFile(path, 'utf8')).trim();
    if (SALT.test(text)) {
      cached.set(dir, text);
      return text;
    }
  } catch {
    // Not there yet.
  }
  const salt = randomBytes(16).toString('hex');
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, salt, { mode: 0o600 });
    await rename(tmp, path);
    cached.set(dir, salt);
    return salt;
  } catch {
    return fallback();
  }
}
