import { describe, it, expect } from 'vitest';
import { exportFrom } from '../helpers/load.js';

const Strength = exportFrom('utils/strength.js', 'Strength');

const them = {
  name: 'Aoife Murphy',
  currentTitle: 'Senior Data Scientist',
  currentCompany: 'Spotify',
  pastCompanies: ['Accenture'],
  educationEntries: ['Trinity College Dublin — MSc Computer Science'],
  skills: ['Python', 'Recommender Systems'],
  location: 'Dublin, County Dublin, Ireland',
};
const ctx = { channel: 'note', limit: 200, them, senderName: 'Rahul Sharma', hooks: ['Spotify opened a new ML hub in Dublin'] };
const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

describe('message strength check', () => {
  it('a specific, short note with an ask is strong', () => {
    const r = Strength.check('Hi Aoife, your move from Accenture to Spotify\'s Dublin ML hub is the path I hope to take. Open to a quick chat?', ctx);
    expect(r.score).toBe('strong');
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it('flags the classic opener, and "I would like to connect" is not an ask', () => {
    const r = Strength.check('Hi Aoife, I came across your profile and would like to connect. I am a data analyst.', ctx);
    const c = byId(r);
    expect(c.opener).toMatchObject({ ok: false, label: 'Cliché: "I came across your profile"' });
    expect(c.ask.ok).toBe(false);
    expect(r.score).toBe('weak');
  });

  it('a generic note is not personal, even with their name in it', () => {
    const r = Strength.check('Hi Aoife, I am looking for data roles. Would you be open to a chat?', ctx);
    expect(byId(r).personal).toMatchObject({ ok: false, label: 'Nothing specific about Aoife yet' });
  });

  it('mentioning one of their posts counts as specific', () => {
    const withPost = { ...ctx, them: { ...them, recentPosts: ['We shipped an app that helps elderly patients track medicines, built for practical usability.'] } };
    const r = Strength.check('Hi Aoife, I saw your post about practical usability for elderly patients. Could we chat?', withPost);
    expect(byId(r).personal.ok).toBe(true);
    // Sharing only everyday words with a post is not enough.
    const r2 = Strength.check('Hi Aoife, I am currently looking for software roles. Could we chat?', withPost);
    expect(byId(r2).personal.ok).toBe(false);
  });

  it('no question = no clear ask', () => {
    const r = Strength.check('Hi Aoife, I loved your work at Spotify.', ctx);
    expect(byId(r).ask.ok).toBe(false);
  });

  it('a note over the limit fails, and says by how much', () => {
    const r = Strength.check(`Hi Aoife, Spotify ${'x'.repeat(200)}?`, ctx);
    expect(byId(r).fits).toMatchObject({ ok: false });
    expect(byId(r).fits.label).toMatch(/^\d+ over the 200 limit for a note$/);
  });

  it('a connection note cannot carry an attachment', () => {
    const r = Strength.check('Hi Aoife, loved your Spotify work. I have attached my CV. Open to a chat?', ctx);
    expect(byId(r).attachment).toMatchObject({ ok: false });
  });

  describe('fact-check', () => {
    it('names backed by their profile or the talking points pass', () => {
      const r = Strength.check('Hi Aoife, congrats on the new Spotify ML hub in Dublin. As a Trinity College Dublin hopeful, open to a chat?', ctx);
      expect(r.unsupported).toEqual([]);
    });

    it('flags names that no source backs up (possible AI invention)', () => {
      const r = Strength.check('Hi Aoife, I loved your talk at PyData Berlin and your promotion at Google. Open to a chat?', ctx);
      expect(r.unsupported).toEqual(['PyData Berlin', 'Google']);
      expect(byId(r).facts).toMatchObject({ ok: false, warn: true, label: 'Check: "PyData Berlin", "Google"' });
    });

    it('a fact warning alone does not lower the score', () => {
      const r = Strength.check('Hi Aoife, your Spotify work on Python recommenders and your PyData Berlin talk stood out. Open to a chat?', ctx);
      expect(r.score).toBe('strong');
      expect(r.unsupported).toEqual(['PyData Berlin']);
    });

    it("the sender's own facts count when they are in the bio", () => {
      const withBio = { ...ctx, bio: 'MSc Data Analytics at University College Dublin' };
      const r = Strength.check('Hi Aoife, I just finished my MSc at University College Dublin and admire your Spotify work. Open to a chat?', withBio);
      expect(r.unsupported).toEqual([]);
    });

    it('does not flag the greeting, names, months or degree letters', () => {
      expect(Strength.namesIn('Hi Aoife, I start my MSc in September. Thanks, Rahul', new Set(['aoife', 'rahul']))).toEqual([]);
    });
  });
});
