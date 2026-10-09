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

  // fleet-audit#694: the login POST sends the password to this host, so a
  // cleartext or look-alike override must never be used.
  it('accepts an https:// origin for a school-pass.net shard, normalised to the bare host', () => {
    const c = resolveConfig({
      ...base,
      SCHOOLPASS_API_HOST: 'HTTPS://BusAPI-West1-SS.School-Pass.net/',
    });
    expect(c.apiHost).toBe('busapi-west1-ss.school-pass.net');
  });

  it.each([
    ['plain http', 'http://busapi-east16-ss.school-pass.net'],
    ['another scheme', 'ftp://busapi-east16-ss.school-pass.net'],
    ['a host outside school-pass.net', 'busapi-east16-ss.example.com'],
    ['a look-alike suffix', 'busapi-east16-ss.school-pass.net.evil.test'],
    ['the bare apex with a look-alike prefix', 'evilschool-pass.net'],
    ['a port', 'busapi-east16-ss.school-pass.net:8080'],
    ['a path', 'busapi-east16-ss.school-pass.net/x'],
    ['userinfo', 'https://me@busapi-east16-ss.school-pass.net'],
  ])('rejects an API host override with %s', (_label, host) => {
    expect(() => resolveConfig({ ...base, SCHOOLPASS_API_HOST: host })).toThrow(
      /SCHOOLPASS_API_HOST must be an https school-pass\.net host/,
    );
  });

  // fleet-audit#691: the password is a secret, not a token — surrounding
  // whitespace can be part of it, so trimming it makes the login impossible.
  it('keeps leading and trailing whitespace in the password', () => {
    const c = resolveConfig({ ...base, SCHOOLPASS_PASSWORD: '  pass word \t' });
    expect(c.password).toBe('  pass word \t');
  });

  it('still treats a whitespace-only password as missing', () => {
    expect(() => resolveConfig({ ...base, SCHOOLPASS_PASSWORD: '   ' })).toThrow(
      /SCHOOLPASS_PASSWORD/,
    );
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
