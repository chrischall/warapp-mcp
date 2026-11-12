// Credential and env-file resolution. Deferred-config pattern: nothing here
// runs at import time, and a missing credential is an error on the first call
// that needs it, never a boot failure.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEnvVar, requireEnvVar, type EnvSource } from '@chrischall/mcp-utils';

/** Where a regenerated token comes from (signed in to war.app in a browser). */
export const TOKEN_URL = 'https://war.app/API/GetAPIToken';

export class WarappConfigError extends Error {
  override name = 'WarappConfigError';
}

export interface WarappCredentials {
  email: string;
  token: string;
}

/** The optional dotenv file: `WARAPP_ENV_FILE`, else `~/.config/warapp-mcp/.env`. */
export function envFilePath(env: EnvSource = process.env): string {
  return readEnvVar('WARAPP_ENV_FILE', { env }) ?? join(homedir(), '.config', 'warapp-mcp', '.env');
}

/**
 * Read `WARAPP_EMAIL` + `WARAPP_API_TOKEN`. Throws a {@link WarappConfigError}
 * naming every missing variable — and never a value, so a leaked placeholder is
 * not echoed back.
 */
export function readCredentials(env: EnvSource = process.env): WarappCredentials {
  // requireEnvVar (not readEnvVar): both are required to make any call, and the
  // throw is caught here so the deferred-config pattern still holds.
  const required = (key: string): string | undefined => {
    try {
      return requireEnvVar(key, { env });
    } catch {
      return undefined;
    }
  };
  const email = required('WARAPP_EMAIL');
  const token = required('WARAPP_API_TOKEN');
  if (email && token) return { email, token };
  const missing = [email ? null : 'WARAPP_EMAIL', token ? null : 'WARAPP_API_TOKEN'].filter(Boolean);
  throw new WarappConfigError(
    `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. Set WARAPP_EMAIL to your war.app ` +
      `sign-in email and WARAPP_API_TOKEN to the API token shown at ${TOKEN_URL} while signed in.`,
  );
}

/**
 * Read `WARAPP_EMAIL` alone — the web-client protocol's auth block carries the
 * account email and nothing else (the browser's cookies authenticate the
 * request). Throws a value-free {@link WarappConfigError} when it is unset.
 */
export function readEmail(env: EnvSource = process.env): string {
  const email = readEnvVar('WARAPP_EMAIL', { env });
  if (email) return email;
  throw new WarappConfigError(
    'WARAPP_EMAIL is not set. Set it to the email you sign in to war.app with — the live-game tools send it ' +
      'with each request, alongside the session of your signed-in war.app tab.',
  );
}
