// #437 task 1: the build the server runs, read once from `.git` (no process spawned) when it runs from a
// checkout, else a hash of the running bundle.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitCommit, readBuild, serverBuild } from '../src/build-id.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'warapp-build-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const PKG = JSON.stringify({ name: '@chrischall/warapp-mcp' });

async function checkout(root: string) {
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'package.json'), PKG);
  await writeFile(join(root, 'dist', 'bundle.js'), 'console.log(1);\n');
}

describe('gitCommit', () => {
  it('reads a detached HEAD, a loose ref and a packed ref', async () => {
    await mkdir(join(dir, '.git', 'refs', 'heads'), { recursive: true });
    await writeFile(join(dir, '.git', 'HEAD'), `${SHA}\n`);
    expect(gitCommit(dir)).toBe(SHA);
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(dir, '.git', 'refs', 'heads', 'main'), `${SHA2}\n`);
    expect(gitCommit(dir)).toBe(SHA2);
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/packed\n');
    await writeFile(join(dir, '.git', 'packed-refs'), `# pack-refs with: peeled\n${SHA} refs/heads/packed\n`);
    expect(gitCommit(dir)).toBe(SHA);
  });

  it('follows a worktree: `.git` a file naming the gitdir, the branch ref in the common dir', async () => {
    const common = join(dir, 'main', '.git');
    const wt = join(common, 'worktrees', 'wt');
    await mkdir(join(common, 'refs', 'heads', 'feat'), { recursive: true });
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, 'HEAD'), 'ref: refs/heads/feat/x\n');
    await writeFile(join(wt, 'commondir'), '../..\n');
    await writeFile(join(common, 'refs', 'heads', 'feat', 'x'), `${SHA2}\n`);
    const root = join(dir, 'wt');
    await mkdir(root);
    await writeFile(join(root, '.git'), `gitdir: ${wt}\n`);
    expect(gitCommit(root)).toBe(SHA2);
  });

  it('is undefined with no .git, or a HEAD that names nothing readable', async () => {
    expect(gitCommit(dir)).toBeUndefined();
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/gone\n');
    expect(gitCommit(dir)).toBeUndefined();
  });
});

describe('readBuild', () => {
  it('a checkout: the commit of the package root', async () => {
    await checkout(dir);
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, '.git', 'HEAD'), `${SHA}\n`);
    expect(readBuild(join(dir, 'dist', 'bundle.js'))).toBe(`git:${SHA}`);
  });

  it('no checkout: a hash of the running bundle', async () => {
    await checkout(dir);
    const hash = createHash('sha256').update('console.log(1);\n').digest('hex').slice(0, 16);
    expect(readBuild(join(dir, 'dist', 'bundle.js'))).toBe(`sha256:${hash}`);
  });

  it('never reads the .git of another package the server is installed inside', async () => {
    // node_modules/@chrischall/warapp-mcp inside a host's checkout: the host's commit is not ours.
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, '.git', 'HEAD'), `${SHA}\n`);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'host' }));
    const pkg = join(dir, 'node_modules', '@chrischall', 'warapp-mcp');
    await mkdir(pkg, { recursive: true });
    await checkout(pkg);
    expect(readBuild(join(pkg, 'dist', 'bundle.js'))).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it('undefined when the module file cannot be read', () => {
    expect(readBuild(join(dir, 'nowhere', 'bundle.js'))).toBeUndefined();
  });

  it('serverBuild reads this checkout once (the same answer each call)', () => {
    const b = serverBuild();
    expect(b).toMatch(/^(git:[0-9a-f]{40}|sha256:[0-9a-f]{16})$/);
    expect(serverBuild()).toBe(b);
  });
});
