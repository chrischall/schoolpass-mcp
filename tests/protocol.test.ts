import { describe, expect, it } from 'vitest';
import { withCallSignal } from '@chrischall/mcp-utils';
import { ResponseTooLargeError } from '@chrischall/mcp-utils';
import {
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  SchoolPassApiError,
  SchoolPassTimeoutError,
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

describe('sendRequest — deadline and cancellation', () => {
  /** A fetch that honours its signal and otherwise never answers. */
  const stalled: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error), { once: true });
    });

  /** A fetch that IGNORES its signal and never answers. */
  const deaf: FetchLike = () => new Promise(() => {});

  it('passes an AbortSignal to fetch on every request', async () => {
    let seen: AbortSignal | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = init.signal;
      return new Response('{}', { status: 200 });
    };
    await sendRequest('http://x/api/y', { method: 'GET', headers: {}, fetchImpl });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  it('has a 30 s default deadline', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('gives up on a stalled connection with a SchoolPassTimeoutError naming the path', async () => {
    const err = await sendRequest('https://busapi-x.school-pass.net/api/studentchange?schoolCode=1', {
      method: 'POST',
      headers: {},
      body: { a: 1 },
      fetchImpl: stalled,
      timeoutMs: 20,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchoolPassTimeoutError);
    expect((err as Error).message).toContain('studentchange');
    expect((err as Error).message).not.toContain('schoolCode');
    expect((err as SchoolPassTimeoutError).timeoutMs).toBe(20);
    // TokenManager tells an outage from a dead credential by walking `cause`.
    expect(((err as Error).cause as Error).name).toBe('TimeoutError');
  });

  it('holds the deadline even when the fetch implementation ignores the signal', async () => {
    const err = await sendRequest('http://x/api/y', {
      method: 'GET',
      headers: {},
      fetchImpl: deaf,
      timeoutMs: 20,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchoolPassTimeoutError);
  });

  it('applies the deadline to the body read too', async () => {
    // Headers arrive, the body never does. A deadline that only covered the
    // handshake would still let this hang.
    const fetchImpl: FetchLike = async () =>
      new Response(new ReadableStream({ start() {} }), { status: 200 });
    const err = await sendRequest('http://x/api/y', {
      method: 'GET',
      headers: {},
      fetchImpl,
      timeoutMs: 20,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchoolPassTimeoutError);
  });

  it('honours the tool call’s own cancellation, and reports THAT — not a timeout', async () => {
    const controller = new AbortController();
    const pending = withCallSignal(controller.signal, () =>
      sendRequest('http://x/api/y', { method: 'GET', headers: {}, fetchImpl: stalled, timeoutMs: 5_000 }),
    );
    setTimeout(() => controller.abort(), 5);
    const err = await pending.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SchoolPassTimeoutError);
    expect((err as Error).name).toBe('AbortError');
  });

  it('fails fast when the call was cancelled before the request started, even on a deaf fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await withCallSignal(controller.signal, () =>
      sendRequest('http://x/api/y', { method: 'GET', headers: {}, fetchImpl: deaf, timeoutMs: 5_000 }),
    ).catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
  });
});

describe('sendRequest — response size bound', () => {
  it('caps a response at 4 MiB', () => {
    expect(MAX_RESPONSE_BYTES).toBe(4 * 1024 * 1024);
  });

  it('refuses a body whose Content-Length is over the cap, without reading it', async () => {
    let pulled = false;
    const fetchImpl: FetchLike = async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            pulled = true;
            c.enqueue(new TextEncoder().encode('x'));
            c.close();
          },
        }, { highWaterMark: 0 }),
        { status: 200, headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } },
      );
    const err = await sendRequest('http://x/api/y', { method: 'GET', headers: {}, fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect(pulled).toBe(false);
  });

  it('stops reading a streamed body as soon as it passes the cap', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    let sent = 0;
    const fetchImpl: FetchLike = async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            sent++;
            if (sent > 16) c.close(); // 16 MiB total, so an uncapped read ends instead of OOMing
            else c.enqueue(chunk);
          },
        }),
        { status: 200 },
      );
    const err = await sendRequest('http://x/api/y', { method: 'GET', headers: {}, fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect(sent).toBeLessThan(8);
  });

  it('refuses an over-cap Content-Length even with no body, or a body whose cancel throws', async () => {
    const big = { 'content-length': String(MAX_RESPONSE_BYTES + 1) };
    const responses = [
      () => new Response(null, { status: 200, headers: big }),
      () =>
        new Response(
          new ReadableStream({ cancel() { throw new Error('odd stream'); } }, { highWaterMark: 0 }),
          { status: 200, headers: big },
        ),
    ];
    for (const make of responses) {
      const err = await sendRequest('http://x/api/y', { method: 'GET', headers: {}, fetchImpl: async () => make() })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResponseTooLargeError);
    }
  });

  it('still refuses an over-cap stream whose cancel throws', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const fetchImpl: FetchLike = async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            sent++;
            if (sent > 16) c.close();
            else c.enqueue(chunk);
          },
          cancel() {
            throw new Error('odd stream');
          },
        }),
        { status: 200 },
      );
    const err = await sendRequest('http://x/api/y', { method: 'GET', headers: {}, fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
  });

  it('reads a null body (204-style) as empty', async () => {
    const res = await sendRequest('http://x/api/y', {
      method: 'GET', headers: {}, fetchImpl: async () => new Response(null, { status: 204 }),
    });
    expect(res.status).toBe(204);
    expect(res.json).toBe(false);
  });

  it('still reads a normal body (multi-byte UTF-8 split across chunks)', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: 'Zoë' }));
    const fetchImpl: FetchLike = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const b of bytes) c.enqueue(new Uint8Array([b]));
            c.close();
          },
        }),
        { status: 200 },
      );
    const res = await sendRequest('http://x/api/y', { method: 'GET', headers: {}, fetchImpl });
    expect(res.body).toEqual({ name: 'Zoë' });
  });
});
