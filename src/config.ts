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
  // readEnvVar trims, which would silently alter a password that starts or
  // ends with whitespace (fleet-audit#691). Use it only to decide whether the
  // password is SET (blank / sentinel / unsubstituted placeholder = unset), and
  // keep the raw value when it is.
  const password = readEnvVar('SCHOOLPASS_PASSWORD', { env }) === undefined
    ? undefined
    : env.SCHOOLPASS_PASSWORD;
  const schoolCodeRaw = readEnvVar('SCHOOLPASS_SCHOOL_CODE', { env });
  const apiHostRaw = readEnvVar('SCHOOLPASS_API_HOST', { env });

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

  const apiHost = apiHostRaw === undefined ? DEFAULT_API_HOST : normalizeApiHost(apiHostRaw);

  return { email: email!, password: password!, schoolCode, apiHost };
}

/** A SchoolPass regional shard: one or more labels under `school-pass.net`. */
const SCHOOL_PASS_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+school-pass\.net$/;

/**
 * Validate a `SCHOOLPASS_API_HOST` override and reduce it to a bare host.
 *
 * The login POST sends the account email and password to this host, so it must
 * be https and under `school-pass.net`: a mistyped `http://` override would put
 * the password on the wire in cleartext, and a look-alike host would hand it to
 * a third party (fleet-audit#694). Accepts a bare host or an `https://` origin
 * with an optional trailing slash; anything with another scheme, a port, a
 * path, or userinfo is refused.
 */
function normalizeApiHost(raw: string): string {
  const host = raw
    .replace(/^https:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!SCHOOL_PASS_HOST.test(host)) {
    throw new SchoolPassConfigError(
      `SCHOOLPASS_API_HOST must be an https school-pass.net host such as ${DEFAULT_API_HOST} ` +
        `(got ${JSON.stringify(raw)}).`,
    );
  }
  return host;
}
