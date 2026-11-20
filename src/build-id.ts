// The build the server runs (#437 task 1), for the decision log beside `planner.version`: the git commit
// when it runs from a checkout of this package (read from `.git` directly, no process spawned; a worktree's
// `.git` file and its common dir followed, a packed ref read too), else a hash of the running module file
// (`dist/bundle.js` once bundled). Only the package root's own `.git` is read: installed inside another
// project's checkout, that project's commit is never taken for ours. Read once per process (`serverBuild`).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@chrischall/warapp-mcp';
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/** The commit HEAD names in the checkout at `root`; `undefined` when there is none or it does not read. */
export function gitCommit(root: string): string | undefined {
  let gitDir = join(root, '.git');
  try {
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(gitDir) ?? '');
      if (!m) return undefined;
      gitDir = resolve(root, m[1]!);
    }
  } catch {
    return undefined;
  }
  const head = readText(join(gitDir, 'HEAD'))?.trim();
  if (!head) return undefined;
  if (SHA.test(head)) return head;
  const ref = /^ref:\s*(refs\/\S+)$/.exec(head)?.[1];
  if (!ref || ref.split('/').includes('..')) return undefined;
  const commonDir = readText(join(gitDir, 'commondir'))?.trim();
  const common = commonDir ? resolve(gitDir, commonDir) : gitDir;
  for (const d of [gitDir, common]) {
    const v = readText(join(d, ref))?.trim();
    if (v && SHA.test(v)) return v;
  }
  for (const line of (readText(join(common, 'packed-refs')) ?? '').split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha && SHA.test(sha)) return sha;
  }
  return undefined;
}

/** The nearest folder at or above `from` holding a package.json, and whether it is this package's. */
function packageRoot(from: string): { root: string; ours: boolean } | undefined {
  let d = from;
  for (let i = 0; i < 64; i++) {
    const pkg = join(d, 'package.json');
    if (existsSync(pkg)) {
      try {
        return { root: d, ours: (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }).name === PACKAGE_NAME };
      } catch {
        return { root: d, ours: false };
      }
    }
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
  return undefined;
}

/**
 * The build of the server whose module file is `moduleFile`: `git:<sha>` from this package's own checkout,
 * else `sha256:<16 hex>` of the module file; `undefined` when neither reads. Never throws.
 */
export function readBuild(moduleFile: string): string | undefined {
  try {
    const pkg = packageRoot(dirname(moduleFile));
    const commit = pkg?.ours ? gitCommit(pkg.root) : undefined;
    if (commit) return `git:${commit}`;
    return `sha256:${createHash('sha256').update(readFileSync(moduleFile)).digest('hex').slice(0, 16)}`;
  } catch {
    return undefined;
  }
}

let cached: { build: string | undefined } | undefined;

/** {@link readBuild} of the running server, read once per process. */
export function serverBuild(): string | undefined {
  if (!cached) {
    let file: string | undefined;
    try {
      file = fileURLToPath(import.meta.url);
    } catch {
      file = undefined;
    }
    cached = { build: file ? readBuild(file) : undefined };
  }
  return cached.build;
}
