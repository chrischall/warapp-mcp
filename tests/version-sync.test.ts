// Invariant: every `// x-release-please-version` annotation in src/ holds the
// same version as package.json — a constant whose extra-files registration
// lacks the marker silently stops being bumped by release-please.
import { describe, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionSyncTest } from '@chrischall/mcp-utils/test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('version sync', () => {
  it('every `x-release-please-version` annotation matches package.json', () => {
    expect(versionSyncTest({ srcDir: join(ROOT, 'src'), pkgPath: join(ROOT, 'package.json') })).toEqual([]);
  });
});
