// #415 task 4: the chat automation gate. Classification, advice and drafts are always on (read-only); an
// automated reply — a message an agent sends that the owner did not tell it to send — is behind
// `WARAPP_CHAT_AUTOMATION`, `off` unless it says `on` (owner decision of 2026-11-20; D2 is now "off unless the
// gate is on"). With the gate on, every send still goes through warapp_send_chat's confirm gate (D1).

import { readEnvVar, type EnvSource } from '@chrischall/mcp-utils';

export const CHAT_AUTOMATION_ENV = 'WARAPP_CHAT_AUTOMATION';

export type ChatAutomation = 'off' | 'on';

/** The gate: `on` only when the variable says `on` (any case, trimmed); unset, `off` and anything else read `off`. */
export function chatAutomationMode(env: EnvSource = process.env): ChatAutomation {
  const v = readEnvVar(CHAT_AUTOMATION_ENV, { env });
  return v !== undefined && v.trim().toLowerCase() === 'on' ? 'on' : 'off';
}

/** warapp_send_chat's refusal of an automated send with the gate off. */
export const AUTOMATED_CHAT_OFF = 'automated chat is off (WARAPP_CHAT_AUTOMATION); the owner sends replies';
