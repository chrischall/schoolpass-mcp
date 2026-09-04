import { describe, it, expect } from 'vitest';
import { viewResponse, viewArg, SPS_VIEWS } from '../src/view.js';

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text as string);

describe('the rungs', () => {
  it('offers compact and full, and not raw — full already IS the SchoolPass payload', () => {
    expect(SPS_VIEWS).toEqual(['compact', 'full']);
  });

  it('defaults to compact when no view is given', () => {
    // The whole point of the vocabulary: the cheap rung is what a caller gets
    // without asking. An efficiency that has to be requested is one that is
    // usually not.
    const data = { studentId: 1, photoUrl: 'https://cdn.schoolpass.test/s/1.png' };
    expect(parse(viewResponse(undefined, data))).toEqual({ studentId: 1 });
  });

  it('falls back to compact for a rung this server does not honour', () => {
    // The schema rejects it first; this is the second line, and it fails toward
    // the small correct answer rather than throwing.
    const data = { studentId: 1, photoUrl: 'https://cdn.schoolpass.test/s/1.png' };
    expect(parse(viewResponse('raw', data))).toEqual({ studentId: 1 });
  });

  it('advertises both rungs, and the note that says what compact drops', () => {
    // The generic blurb says a projection happened; only this server can say
    // that the projection is media stripping and NOT a field list.
    const description = viewArg().description ?? '';
    expect(description).toContain('"compact" (default)');
    expect(description).toContain('"full"');
    expect(description).not.toContain('"raw"');
    expect(description).toContain('image/avatar URLs');
  });
});

describe('what compact does — and what it deliberately does not', () => {
  it('strips image and avatar URLs', () => {
    const data = {
      students: [
        { studentId: 7, firstName: 'Ada', avatar: 'https://cdn.schoolpass.test/a.png', photoUrl: 'https://cdn.schoolpass.test/b.jpg' },
      ],
    };
    expect(parse(viewResponse('compact', data))).toEqual({ students: [{ studentId: 7, firstName: 'Ada' }] });
  });

  it('keeps EVERY other field, because nothing here knows which SchoolPass fields matter', () => {
    // The honest ceiling for this repo: no captured payload, no documented
    // field list. Media stripping is SUBTRACTIVE and names no fields, so it
    // cannot put a hole in a record — the failure an invented field list would
    // risk, where a record comes back short and reads like a verified answer.
    const record = {
      studentId: 42,
      firstName: 'Ada',
      grade: '4',
      dismissalLocationId: 9,
      dismissalLocationName: 'Car Line',
      aftercare: false,
      changeSeriesId: null,
      somethingNobodyAnticipated: 'kept',
    };
    expect(parse(viewResponse('compact', { dailyList: [record] }))).toEqual({ dailyList: [record] });
  });

  it('keeps null — an absent key and a null one are different facts', () => {
    // `changeSeriesId: null` is how the calendar says "this day is the default";
    // dropping it would make "no change" indistinguishable from "not reported".
    expect(parse(viewResponse('compact', { changeSeriesId: null }))).toEqual({ changeSeriesId: null });
  });

  it('keeps a page URL — only URLs that point AT an image go', () => {
    const d = { link: 'https://schoolpass.test/parent/students/42' };
    expect(parse(viewResponse('compact', d))).toEqual(d);
  });

  it('keeps a media-shaped fact that is not a picture', () => {
    // `hasThumbnail` is a fact about the record, and a caller filtering on it
    // would read a vanished key as "not reported".
    const d = { hasPhoto: false, thumbnailWidth: 64 };
    expect(parse(viewResponse('compact', d))).toEqual(d);
  });
});

describe('full', () => {
  it('returns the SchoolPass payload untouched, images included', () => {
    const data = {
      studentId: 1,
      photoUrl: 'https://cdn.schoolpass.test/s/1.png',
      nested: { avatar: 'https://cdn.schoolpass.test/a.gif' },
    };
    expect(parse(viewResponse('full', data))).toEqual(data);
  });
});

describe('whitespace', () => {
  it('emits none of its own, and never touches whitespace inside a value', () => {
    // Formatting whitespace is ~a fifth of a large response and nothing reads
    // it. Whitespace INSIDE a value is content — a dismissal note's line breaks
    // — and JSON.stringify leaves every byte of it alone.
    const notes = 'Grandma is picking up.\n\n  Bay 3.   ';
    const text = viewResponse('compact', { notes }).content[0]!.text as string;
    expect(text.split('\n')).toHaveLength(1);
    expect(JSON.parse(text).notes).toBe(notes);
  });

  it('minifies on the full rung too', () => {
    const text = viewResponse('full', { a: 1, b: { c: 2 } }).content[0]!.text as string;
    expect(text).toBe('{"a":1,"b":{"c":2}}');
  });
});
