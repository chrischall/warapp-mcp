import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harnessFor, type Harness } from './helpers.js';

/**
 * Fleet annotation meta-test, read off the wire (tools/list). warapp-mcp is
 * read-only: every tool reads war.app's GameFeed and changes nothing.
 */
interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

let h: Harness;
let ann: Record<string, Ann | undefined>;

beforeAll(async () => {
  h = await harnessFor();
  ann = Object.fromEntries(
    (await h.harness.client.listTools()).tools.map((t) => [t.name, t.annotations as Ann | undefined]),
  );
});
afterAll(async () => {
  await h?.harness.close();
});

describe('tool annotations', () => {
  it('covers the full surface (guards against a registrar being dropped)', () => {
    expect(Object.keys(ann).sort()).toEqual([
      'warapp_analyze_board',
      'warapp_get_game',
      'warapp_get_map',
      'warapp_healthcheck',
      'warapp_plan_route',
    ]);
  });

  it('marks every tool read-only, never destructive', () => {
    expect(Object.entries(ann).filter(([, a]) => a?.readOnlyHint !== true).map(([n]) => n)).toEqual([]);
    expect(Object.entries(ann).filter(([, a]) => a?.destructiveHint === true).map(([n]) => n)).toEqual([]);
  });

  it('marks every game tool open-world (all reach war.app)', () => {
    const game = Object.entries(ann).filter(([n]) => n !== 'warapp_healthcheck');
    expect(game.filter(([, a]) => a?.openWorldHint !== true).map(([n]) => n)).toEqual([]);
  });
});
