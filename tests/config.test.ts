import { describe, expect, it } from 'vitest';
import { resolveConfig, SchoolPassConfigError } from '../src/config.js';
import { DEFAULT_API_HOST } from '../src/protocol.js';

const base = {
  SCHOOLPASS_EMAIL: 'parent@example.com',
  SCHOOLPASS_PASSWORD: 'secret',
  SCHOOLPASS_SCHOOL_CODE: '1183',
};

describe('resolveConfig', () => {
  it('reads and validates a complete config', () => {
    const c = resolveConfig(base);
    expect(c).toEqual({
      email: 'parent@example.com',
      password: 'secret',
      schoolCode: 1183,
      apiHost: DEFAULT_API_HOST,
    });
  });

  it('honors an API host override', () => {
    const c = resolveConfig({ ...base, SCHOOLPASS_API_HOST: 'busapi-west1-ss.school-pass.net' });
    expect(c.apiHost).toBe('busapi-west1-ss.school-pass.net');
  });

  it('lists every missing required var in the error', () => {
    try {
      resolveConfig({});
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SchoolPassConfigError);
      const msg = (err as Error).message;
      expect(msg).toContain('SCHOOLPASS_EMAIL');
      expect(msg).toContain('SCHOOLPASS_PASSWORD');
      expect(msg).toContain('SCHOOLPASS_SCHOOL_CODE');
    }
  });

  it('rejects a non-numeric school code', () => {
    expect(() => resolveConfig({ ...base, SCHOOLPASS_SCHOOL_CODE: 'abc' })).toThrow(
      SchoolPassConfigError,
    );
  });

  it('rejects a non-positive school code', () => {
    expect(() => resolveConfig({ ...base, SCHOOLPASS_SCHOOL_CODE: '0' })).toThrow(
      SchoolPassConfigError,
    );
  });

  it('treats a placeholder ${...} value as unset', () => {
    // readEnvVar strips ${...} placeholders to undefined.
    expect(() => resolveConfig({ ...base, SCHOOLPASS_EMAIL: '${SCHOOLPASS_EMAIL}' })).toThrow(
      SchoolPassConfigError,
    );
  });
});
