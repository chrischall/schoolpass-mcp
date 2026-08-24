/**
 * Environment configuration for the SchoolPass client.
 *
 * Follows the fleet's **deferred-config-error** pattern: reading config never
 * throws at construction time, so the MCP server still boots (and answers the
 * host's install-time `tools/list` probe) when credentials are absent. Missing
 * config surfaces as a {@link SchoolPassConfigError} thrown from
 * {@link resolveConfig} on the first tool call that needs it.
 */

import { McpToolError, readEnvVar } from '@chrischall/mcp-utils';
import { DEFAULT_API_HOST } from './protocol.js';

/** Resolved, validated runtime configuration. */
export interface SchoolPassConfig {
  email: string;
  password: string;
  /** The school's tenant id, sent as the `AppCode` header on every call. */
  schoolCode: number;
  /** Regional API host, e.g. `busapi-east16-ss.school-pass.net`. */
  apiHost: string;
}

/** Thrown (once, lazily) when required credentials are missing or malformed. */
export class SchoolPassConfigError extends McpToolError {
  constructor(message: string) {
    super(message, {
      hint:
        'Set SCHOOLPASS_EMAIL, SCHOOLPASS_PASSWORD and SCHOOLPASS_SCHOOL_CODE (your school id). ' +
        'The school id is the number in the web app: sign in at your school’s ' +
        'school-pass.net portal, open the new SchoolPass app, and it is the `appCode` in ' +
        'localStorage (also the AppCode header on its API calls). Optionally set ' +
        'SCHOOLPASS_API_HOST if your school is on a different regional shard.',
    });
    this.name = 'SchoolPassConfigError';
  }
}

/**
 * Read and validate config from the environment. Throws
 * {@link SchoolPassConfigError} if a required value is missing or the school
 * code is not a positive integer. Call this at request time, not construction
 * time.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): SchoolPassConfig {
  const email = readEnvVar('SCHOOLPASS_EMAIL', { env });
  const password = readEnvVar('SCHOOLPASS_PASSWORD', { env });
  const schoolCodeRaw = readEnvVar('SCHOOLPASS_SCHOOL_CODE', { env });
  const apiHost = readEnvVar('SCHOOLPASS_API_HOST', { env }) ?? DEFAULT_API_HOST;

  const missing: string[] = [];
  if (!email) missing.push('SCHOOLPASS_EMAIL');
  if (!password) missing.push('SCHOOLPASS_PASSWORD');
  if (!schoolCodeRaw) missing.push('SCHOOLPASS_SCHOOL_CODE');
  if (missing.length > 0) {
    throw new SchoolPassConfigError(`Missing required configuration: ${missing.join(', ')}.`);
  }

  const schoolCode = Number(schoolCodeRaw);
  if (!Number.isInteger(schoolCode) || schoolCode <= 0) {
    throw new SchoolPassConfigError(
      `SCHOOLPASS_SCHOOL_CODE must be a positive integer (got ${JSON.stringify(schoolCodeRaw)}).`,
    );
  }

  return { email: email!, password: password!, schoolCode, apiHost };
}
