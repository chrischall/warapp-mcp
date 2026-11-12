import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envFilePath, readCredentials, readEmail, WarappConfigError } from '../src/config.js';

describe('envFilePath', () => {
  it('defaults to ~/.config/warapp-mcp/.env', () => {
    expect(envFilePath({})).toBe(join(homedir(), '.config', 'warapp-mcp', '.env'));
  });

  it('honours WARAPP_ENV_FILE', () => {
    expect(envFilePath({ WARAPP_ENV_FILE: '/tmp/x.env' })).toBe('/tmp/x.env');
  });

  it('ignores a placeholder WARAPP_ENV_FILE', () => {
    expect(envFilePath({ WARAPP_ENV_FILE: '${user_config.env_file}' })).toBe(
      join(homedir(), '.config', 'warapp-mcp', '.env'),
    );
  });
});

describe('readCredentials', () => {
  it('returns both credentials when set', () => {
    expect(readCredentials({ WARAPP_EMAIL: ' me@example.com ', WARAPP_API_TOKEN: 'abc123' })).toEqual({
      email: 'me@example.com',
      token: 'abc123',
    });
  });

  it('throws a value-free config error naming every missing variable', () => {
    let err: unknown;
    try {
      readCredentials({ WARAPP_EMAIL: '', WARAPP_API_TOKEN: '${user_config.api_token}' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WarappConfigError);
    const msg = (err as Error).message;
    expect(msg).toContain('WARAPP_EMAIL');
    expect(msg).toContain('WARAPP_API_TOKEN');
    expect(msg).not.toContain('user_config');
    expect(msg).toContain('https://war.app/API/GetAPIToken');
  });

  it('names only the missing one', () => {
    expect(() => readCredentials({ WARAPP_EMAIL: 'me@example.com' })).toThrow(/^WARAPP_API_TOKEN is not set\./);
    expect(() => readCredentials({ WARAPP_API_TOKEN: 'abc123' })).toThrow(/^WARAPP_EMAIL is not set\./);
  });
});

describe('readEmail', () => {
  it('returns WARAPP_EMAIL without needing the API token', () => {
    expect(readEmail({ WARAPP_EMAIL: ' me@example.com ' })).toBe('me@example.com');
  });

  it('throws a value-free config error when WARAPP_EMAIL is missing or a placeholder', () => {
    for (const env of [{}, { WARAPP_EMAIL: '${user_config.email}' }]) {
      let err: unknown;
      try {
        readEmail(env);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(WarappConfigError);
      expect((err as Error).message).toContain('WARAPP_EMAIL');
      expect((err as Error).message).not.toContain('user_config');
    }
  });
});
