import { describe, expect, it } from 'vitest';
import {
  SchoolPassApiError,
  apiBaseUrl,
  buildHeaders,
  sendRequest,
  type FetchLike,
} from '../src/protocol.js';

describe('apiBaseUrl', () => {
  it('prefixes a bare host with https and appends /api/', () => {
    expect(apiBaseUrl('busapi-east16-ss.school-pass.net')).toBe(
      'https://busapi-east16-ss.school-pass.net/api/',
    );
  });

  it('accepts a full origin and strips a trailing slash', () => {
    expect(apiBaseUrl('https://example.test/')).toBe('https://example.test/api/');
  });

  it('accepts an http origin unchanged', () => {
    expect(apiBaseUrl('http://localhost:5000')).toBe('http://localhost:5000/api/');
  });
});

describe('buildHeaders', () => {
  it('always sets AppCode and content headers', () => {
    const h = buildHeaders(1183);
    expect(h).toMatchObject({ AppCode: '1183', accept: 'application/json' });
  });

  it('merges extra headers and drops undefined values', () => {
    const h = buildHeaders(1183, { Authorization: 'Bearer x', 'x-skip': undefined });
    expect(h.Authorization).toBe('Bearer x');
    expect('x-skip' in h).toBe(false);
  });
});

describe('SchoolPassApiError', () => {
  it('gives a 401 hint about token/AppCode', () => {
    const e = new SchoolPassApiError(401, 'X', 'body');
    expect(e.status).toBe(401);
    expect(e.hint).toMatch(/token|AppCode/i);
  });

  it('gives a 403 hint about authorization', () => {
    expect(new SchoolPassApiError(403, 'X', 'body').hint).toMatch(/not authorized/i);
  });

  it('has no canned hint for a 500 unless one is passed', () => {
    expect(new SchoolPassApiError(500, 'X', 'body').hint).toBeUndefined();
    expect(new SchoolPassApiError(500, 'X', 'body', { hint: 'custom' }).hint).toBe('custom');
  });

  it('renders an empty body placeholder', () => {
    expect(new SchoolPassApiError(500, 'X', '').message).toContain('<empty body>');
  });
});

describe('sendRequest', () => {
  const capture = (status: number, body: string): FetchLike => async () =>
    new Response(body, { status });

  it('parses a JSON body and reports json:true', async () => {
    const res = await sendRequest('http://x/api/y', {
      method: 'GET',
      headers: {},
      fetchImpl: capture(200, '{"a":1}'),
    });
    expect(res.json).toBe(true);
    expect(res.body).toEqual({ a: 1 });
    expect(res.status).toBe(200);
  });

  it('leaves a non-JSON body as text with json:false', async () => {
    const res = await sendRequest('http://x/api/y', {
      method: 'GET',
      headers: {},
      fetchImpl: capture(200, 'plain string'),
    });
    expect(res.json).toBe(false);
    expect(res.body).toBe('plain string');
  });

  it('serializes a body when given one', async () => {
    let seen: string | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = init.body;
      return new Response('{}', { status: 200 });
    };
    await sendRequest('http://x/api/y', { method: 'POST', headers: {}, body: { k: 1 }, fetchImpl });
    expect(seen).toBe('{"k":1}');
  });

  it('uses globalThis.fetch when no fetchImpl is injected', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"via":"global"}', { status: 200 })) as typeof fetch;
    try {
      const res = await sendRequest('http://x/api/y', { method: 'GET', headers: {} });
      expect(res.body).toEqual({ via: 'global' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('handles an empty body', async () => {
    const res = await sendRequest('http://x/api/y', {
      method: 'GET',
      headers: {},
      fetchImpl: capture(200, ''),
    });
    expect(res.body).toBe('');
    expect(res.json).toBe(false);
  });
});
