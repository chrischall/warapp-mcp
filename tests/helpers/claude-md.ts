import { readFileSync } from 'node:fs';

/**
 * The repo's CLAUDE.md is split by folder: the root file holds what is true repo-wide and each
 * folder file holds what is true of that folder. Doc tests read them as one text, so a section
 * can move between files without a test noticing.
 * The order is the order the sections had in the single file (a test that takes the first line
 * naming a tool depends on it).
 */
export const CLAUDE_MD_FILES = [
  'CLAUDE.md',
  'src/analysis/CLAUDE.md',
  'src/tools/CLAUDE.md',
  'src/protocol/CLAUDE.md',
  'src/push/CLAUDE.md',
] as const;

export function claudeMd(): string {
  return CLAUDE_MD_FILES.map((p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')).join('\n');
}
