import { describe, it, expect } from 'vitest';
import { exportFrom } from '../helpers/load.js';

const Limits = exportFrom('utils/limits.js', 'Limits');

const LONG = 'Hi Aoife, I came across your work on recommendation systems at Spotify and found it really interesting. ' +
  'I hope this message finds you well. ' +
  'I recently finished my MSc in Data Analytics at UCD and I am now looking for data science roles in Dublin. ' +
  'I have been learning a lot about ranking models in my spare time. ' +
  'Would you be open to a 15-minute chat about how you moved into recommendations? ' +
  'Thank you, Rahul';

describe('LinkedIn limits', () => {
  it('a connection note is 200 characters on free, 300 on Premium', () => {
    expect(Limits.limitFor('note', 'free')).toBe(200);
    expect(Limits.limitFor('note', 'premium')).toBe(300);
    expect(Limits.limitFor('message', 'free')).toBe(500);
  });

  it('the meter knows when a note is over the hard limit', () => {
    expect(Limits.lengthState('x'.repeat(201), 'note', 'free')).toMatchObject({ count: 201, limit: 200, hard: true, over: true });
    expect(Limits.lengthState('x'.repeat(190), 'note', 'free')).toMatchObject({ over: false, near: true });
    expect(Limits.lengthState('x'.repeat(250), 'note', 'premium')).toMatchObject({ over: false });
  });

  it('counts notes per calendar month', () => {
    expect(Limits.monthKey(new Date(2026, 10, 18))).toBe('2026-11');
    expect(Limits.monthKey(new Date(2027, 0, 1))).toBe('2027-01');
  });
});

describe('fitToLimit', () => {
  it('leaves a short draft alone', () => {
    const r = Limits.fitToLimit('Hi Aoife, loved your PyData talk. Open to a quick chat?', 200);
    expect(r).toMatchObject({ changed: false, fits: true, removed: [] });
  });

  it('fits a 400+ character draft into a 200-character note', () => {
    expect(LONG.length).toBeGreaterThan(400);
    const r = Limits.fitToLimit(LONG, 200);
    expect(r.fits).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(200);
  });

  it('keeps the greeting, the hook and the question', () => {
    const r = Limits.fitToLimit(LONG, 200);
    expect(r.text.startsWith('Hi Aoife,')).toBe(true);
    expect(r.text).toContain('recommendation systems at Spotify');
    expect(r.text).toContain('Would you be open to a 15-minute chat');
  });

  it('removes filler before anything with real content', () => {
    const r = Limits.fitToLimit(LONG, 300);
    expect(r.removed[0]).toBe('I hope this message finds you well.');
    expect(r.text).not.toContain('finds you well');
  });

  it('never cuts in the middle of a sentence', () => {
    const r = Limits.fitToLimit(LONG, 200);
    for (const sentence of r.text.replace(/^Hi Aoife,\s*/, '').split(/(?<=[.!?])\s+/)) {
      expect(LONG).toContain(sentence);
    }
  });

  it('says so honestly when even the essentials do not fit', () => {
    const tooLong = 'Hi Aoife, ' + 'I would love to learn more about your work. '.repeat(3) + 'Would you be open to a chat about recommendation systems and ranking at Spotify in Dublin next week?';
    const r = Limits.fitToLimit(tooLong, 60);
    expect(r.fits).toBe(false);
    expect(r.text).toContain('Would you be open to a chat');
  });

  it('drops a mention of an attachment, which a note cannot carry', () => {
    const r = Limits.fitToLimit('Hi Aoife, I am a data analyst in Dublin. I have attached my CV. Would you be open to a quick chat about Spotify?', 110);
    expect(r.text).not.toMatch(/attached/i);
    expect(r.fits).toBe(true);
  });
});
