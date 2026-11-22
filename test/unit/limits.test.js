// Tests for extension/utils/limits.js: LinkedIn's limits, and Fit
// (fitToLimit), which makes a draft fit by dropping whole sentences. The
// panel's "Fit" button and the in-page "Write with Ark" button use it.
// The rules are the ones in the fix notes of the second and third reviews
// ("Fit"). Where the third changed a rule, its notes win.
// Every person here is made up.
import { describe, it, expect } from 'vitest';
import { exportFrom } from '../helpers/load.js';

const Limits = exportFrom('utils/limits.js', 'Limits');
// Only to check that Fit and the writer share one rule for abbreviations,
// and to fit a note the writer wrote.
const Writer = exportFrom('utils/writer.js', 'Writer');

const LONG = 'Hi Aoife, I came across your work on recommendation systems at Spotify and found it really interesting. ' +
  'I hope this message finds you well. ' +
  'I recently finished my MSc in Data Analytics at UCD and I am now looking for data science roles in Dublin. ' +
  'I have been learning a lot about ranking models in my spare time. ' +
  'Would you be open to a 15-minute chat about how you moved into recommendations? ' +
  'Thank you, Rahul';

// The filler sentence Fit drops first. Many tests below add it, so that the
// text is too long by exactly this much, and Fit must change it.
const FILLER = 'I hope this message finds you well.';

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

  // Only the question is left, and it is still too long. Fit changed the
  // text, so the question goes on after "Hi Aoife," with a small letter.
  it('says so honestly when even the essentials do not fit', () => {
    const tooLong = 'Hi Aoife, ' + 'I would love to learn more about your work. '.repeat(3) + 'Would you be open to a chat about recommendation systems and ranking at Spotify in Dublin next week?';
    const r = Limits.fitToLimit(tooLong, 60);
    expect(r.fits).toBe(false);
    expect(r.text).toBe('Hi Aoife, would you be open to a chat about recommendation systems and ranking at Spotify in Dublin next week?');
  });

  it('drops a mention of an attachment, which a note cannot carry', () => {
    const r = Limits.fitToLimit('Hi Aoife, I am a data analyst in Dublin. I have attached my CV. Would you be open to a quick chat about Spotify?', 110);
    expect(r.text).not.toMatch(/attached/i);
    expect(r.fits).toBe(true);
  });
});

describe('fitToLimit: where a sentence ends', () => {
  it('uses the writer\'s rule for abbreviations: Limits.ABBREV and Writer.ABBREV have the same source and flags', () => {
    expect(Limits.ABBREV).toBeInstanceOf(RegExp);
    expect(Limits.ABBREV.source).toBe(Writer.ABBREV.source);
    expect(Limits.ABBREV.flags).toBe(Writer.ABBREV.flags);
    // And it is the rule in the notes: a dot after an initial or a listed
    // short word, or a list's "1.", does not end a sentence.
    for (const text of ['at J.P.', 'the Sr.', 'a B.Tech.', 'Data analyst (B.Sc.', 'Anna Univ.', 'Mu Sigma Pvt.', 'rule 1.', 'rule 12.', 'e.g.']) {
      expect(Limits.ABBREV.test(text), text).toBe(true);
    }
    for (const text of ['ranking models.', 'in 2019.', 'hired 100.', 'at UCD.']) expect(Limits.ABBREV.test(text), text).toBe(false);
  });

  // The first Fit split at every ". ", so it could drop "Morgan caught my
  // eye." and keep "…as Sr." (the second review found this in the in-page
  // button, which fits every note that is too long).
  it('never splits a sentence after "Sr.", "J.P.", "B.Tech.", "Univ." or a list\'s "1."', () => {
    const HOOK = 'your work as Sr. Data Scientist at J.P. Morgan caught my eye.';
    const DEGREE = 'I am a B.Tech. graduate from Anna Univ. in Chennai.';
    const PLAN = 'My plan is rule 1. Ship small and learn fast.';
    const ASK = 'Could you refer me for the Sr. Data Analyst role at J.P. Morgan?';
    const draft = `Hi Aoife, ${HOOK} ${DEGREE} ${PLAN} ${ASK} Thanks, Rahul`;
    // Room by room, Fit drops whole sentences only: the sign-off, then the
    // least specific sentence, then the next, then the hook.
    const steps = [
      [240, ['Thanks, Rahul'], `Hi Aoife, ${HOOK} ${DEGREE} ${PLAN} ${ASK}`],
      [200, ['Thanks, Rahul', PLAN], `Hi Aoife, ${HOOK} ${DEGREE} ${ASK}`],
      [150, ['Thanks, Rahul', PLAN, DEGREE], `Hi Aoife, ${HOOK} ${ASK}`],
      [100, ['Thanks, Rahul', PLAN, DEGREE, HOOK], 'Hi Aoife, could you refer me for the Sr. Data Analyst role at J.P. Morgan?'],
    ];
    for (const [limit, removed, text] of steps) {
      const r = Limits.fitToLimit(draft, limit);
      expect(r, `limit ${limit}`).toEqual({ text, changed: true, fits: true, removed });
    }
  });

  // The writer quotes a post as: caught my eye: "…models." The first Fit
  // split only at a dot right before a space, so the quote and the next
  // sentence were one, and dropping your intro dropped the quote too.
  it('a sentence ends after . ! or ? and a closing quote or bracket: ." .\' .” .’ .) .] ?" !"', () => {
    for (const [open, close] of [['"', '."'], ["'", ".'"], ['“', '.”'], ['‘', '.’'], ['(', '.)'], ['[', '.]'], ['"', '?"'], ['"', '!"'], ['“', '!”']]) {
      const hook = `your post caught my eye: ${open}We just open-sourced our toolkit${close}`;
      const r = Limits.fitToLimit(`Hi Aoife, ${hook} I am a data analyst in Dublin. Would you be open to a chat?`, 100);
      expect(r, close).toEqual({ text: `Hi Aoife, ${hook} Would you be open to a chat?`, changed: true, fits: true, removed: ['I am a data analyst in Dublin.'] });
    }
  });

  it('"!!" and "?!" end a sentence too, and so does a year ("2019.")', () => {
    expect(Limits.fitToLimit('Hi Aoife, congrats on the new role!! I am a data analyst in Dublin. Would you be open to a chat?', 75))
      .toMatchObject({ text: 'Hi Aoife, congrats on the new role!! Would you be open to a chat?', removed: ['I am a data analyst in Dublin.'] });
    expect(Limits.fitToLimit('Hi Aoife, is ranking solved?! I am a data analyst in Dublin. Would you be open to a chat?', 70))
      .toMatchObject({ text: 'Hi Aoife, is ranking solved?! Would you be open to a chat?', removed: ['I am a data analyst in Dublin.'] });
    expect(Limits.fitToLimit('Hi Aoife, I graduated in 2019. I am a data analyst in Dublin and I love ranking. Would you be open to a chat?', 80))
      .toMatchObject({ text: 'Hi Aoife, I graduated in 2019. Would you be open to a chat?', removed: ['I am a data analyst in Dublin and I love ranking.'] });
  });

  // The third review: a quote that ends with its own full stop, in the
  // middle of a sentence, ended the sentence there. Then "caught my eye."
  // was dropped first, as the least specific part.
  it('a quote or bracket in the middle of a sentence does not end it: only a capital, a number, a quote or "(" after it does', () => {
    const NOTE = 'Hi Aoife, your post "We just open-sourced our evaluation toolkit for ranking models." caught my eye. '
      + 'I am an MSc student at UCD working on ranking for my thesis. Would you be open to a short chat about your team?';
    expect(NOTE.length).toBeGreaterThan(200);
    expect(Limits.fitToLimit(NOTE, 200)).toEqual({
      text: 'Hi Aoife, your post "We just open-sourced our evaluation toolkit for ranking models." caught my eye. Would you be open to a short chat about your team?',
      changed: true,
      fits: true,
      removed: ['I am an MSc student at UCD working on ranking for my thesis.'],
    });
    // The same with every closing quote and bracket, and "!" or "?" before it.
    for (const [open, close] of [['"', '."'], ["'", ".'"], ['“', '.”'], ['‘', '.’'], ['(', '.)'], ['[', '.]'], ['"', '?"'], ['"', '!"']]) {
      const hook = `your post ${open}We just open-sourced our toolkit${close} caught my eye.`;
      const r = Limits.fitToLimit(`Hi Aoife, ${hook} I am a data analyst in Dublin. Would you be open to a chat?`, 110);
      expect(r, close).toEqual({ text: `Hi Aoife, ${hook} Would you be open to a chat?`, changed: true, fits: true, removed: ['I am a data analyst in Dublin.'] });
    }
    // After the quote: a number, another quote or a "(" starts a new sentence.
    for (const next of ['3 lessons stuck with me.', '"Small steps" stuck with me.', '(I agree with all of it.)']) {
      const r = Limits.fitToLimit(`Hi Aoife, your post said "ship it." ${next} I am a data analyst in Dublin. Would you be open to a chat?`, 70);
      expect(r, next).toMatchObject({ text: 'Hi Aoife, your post said "ship it." Would you be open to a chat?', fits: true });
      expect(r.removed, next).toContain(next);
    }
  });

  // Free Mode cuts a long quote and ends it with '…"'. The second version
  // never ended a sentence at "…", so a cut quote and your intro were one
  // sentence, and Fit could not drop your intro alone.
  it('a "…" with a closing quote ends a sentence before a capital: Free Mode\'s cut quote and your intro come apart', () => {
    const NOTE = 'Hi Aoife, your recent post caught my eye: "We just open-sourced our evaluation toolkit for ranking models, after two years of work with the search…" '
      + 'A bit about me: Data analyst in Dublin. Would you be open to connecting?';
    expect(NOTE.length).toBeGreaterThan(200);
    expect(Limits.fitToLimit(NOTE, 200)).toEqual({
      text: 'Hi Aoife, your recent post caught my eye: "We just open-sourced our evaluation toolkit for ranking models, after two years of work with the search…" Would you be open to connecting?',
      changed: true,
      fits: true,
      removed: ['A bit about me: Data analyst in Dublin.'],
    });
    // Before a small letter, the sentence goes on.
    const r = Limits.fitToLimit(`Hi Aoife, your post "We just open-sourced…" caught my eye. ${FILLER} I am a data analyst in Dublin. Would you be open to a chat?`, 125);
    expect(r).toEqual({
      text: 'Hi Aoife, your post "We just open-sourced…" caught my eye. I am a data analyst in Dublin. Would you be open to a chat?',
      changed: true, fits: true, removed: [FILLER],
    });
    // A "…" alone (with no closing quote) does not end a sentence.
    expect(Limits.fitToLimit(`Hi Aoife, your talk was great… I learned a lot from it. ${FILLER} Would you be open to a chat?`, 90)).toEqual({
      text: 'Hi Aoife, your talk was great… I learned a lot from it. Would you be open to a chat?', changed: true, fits: true, removed: [FILLER],
    });
    // So when that sentence must go, it goes whole: no "Your talk was great…" is left behind.
    expect(Limits.fitToLimit(`Hi Aoife, I build dashboards in Dublin. Your talk was great… I learned a lot from it. ${FILLER} Would you be open to a chat?`, 90)).toEqual({
      text: 'Hi Aoife, I build dashboards in Dublin. Would you be open to a chat?',
      changed: true, fits: true, removed: [FILLER, 'Your talk was great… I learned a lot from it.'],
    });
  });

  // The second version split "(B.Sc.) from Dublin" at ".)": the check for
  // an abbreviation ran only on a plain ".".
  it('"(B.Sc.)" does not end a sentence, before a small letter or a capital', () => {
    const r = Limits.fitToLimit('Hi Aoife, I am a data analyst (B.Sc.) from Dublin and I love ranking. I build dashboards for a living. Would you be open to a chat about ranking?', 120);
    expect(r).toEqual({
      text: 'Hi Aoife, I am a data analyst (B.Sc.) from Dublin and I love ranking. Would you be open to a chat about ranking?',
      changed: true, fits: true, removed: ['I build dashboards for a living.'],
    });
    const capital = Limits.fitToLimit('Hi Aoife, I am a data analyst (B.Sc.) From Dublin. I build dashboards for a living. Would you be open to a chat about ranking?', 100);
    expect(capital).toEqual({
      text: 'Hi Aoife, I am a data analyst (B.Sc.) From Dublin. Would you be open to a chat about ranking?',
      changed: true, fits: true, removed: ['I build dashboards for a living.'],
    });
    // So when that sentence must go, it goes whole: no "From Dublin." is left behind.
    expect(Limits.fitToLimit('Hi Aoife, I build dashboards for a living. I am a data analyst (B.Sc.) From Dublin. Would you be open to a chat about ranking?', 100)).toEqual({
      text: 'Hi Aoife, I build dashboards for a living. Would you be open to a chat about ranking?',
      changed: true, fits: true, removed: ['I am a data analyst (B.Sc.) From Dublin.'],
    });
    // A bracket after a word that is not an abbreviation ends the sentence.
    const word = Limits.fitToLimit('Hi Aoife, I build dashboards (mostly in Tableau.) I love ranking too. Would you be open to a chat?', 85);
    expect(word).toMatchObject({ text: 'Hi Aoife, I build dashboards (mostly in Tableau.) Would you be open to a chat?', removed: ['I love ranking too.'] });
  });

  // The fourth notes: a plain "." ends a sentence only before a capital
  // letter, a number, a quote or "(". Before a small letter the sentence
  // goes on ("moved from Infosys Ltd. to Spotify"), so Fit drops it whole
  // or keeps it whole, and never leaves half of it behind.
  it('a plain "." before a small letter does not end a sentence', () => {
    expect(Limits.fitToLimit('Hi Aoife, I use v1. it works well for ranking. I am a data analyst in Dublin. Would you be open to a chat?', 80))
      .toEqual({ text: 'Hi Aoife, I use v1. it works well for ranking. Would you be open to a chat?', changed: true, fits: true, removed: ['I am a data analyst in Dublin.'] });
    expect(Limits.fitToLimit('Hi Aoife, I am an MSc student at UCD. I saw that you moved from Infosys Ltd. to Spotify in 2023 and I would love to hear how. Would you be open to a short chat sometime?', 150))
      .toEqual({
        text: 'Hi Aoife, I am an MSc student at UCD. Would you be open to a short chat sometime?',
        changed: true, fits: true,
        removed: ['I saw that you moved from Infosys Ltd. to Spotify in 2023 and I would love to hear how.'],
      });
  });

  // The second review: a Free Mode note written for 300 characters, then
  // fitted to 200 (Premium set in the panel, but a free account), lost the
  // line about them along with your intro, and started "Dear Aoife, Would…".
  it('a Free Mode note written for 300 characters, fitted to 200: keeps the line about them, drops your intro', () => {
    const profile = { name: 'Aoife Murphy', headline: 'Senior Data Scientist at Spotify', recentPosts: ['We just open-sourced our evaluation toolkit for ranking models. Feedback welcome!'] };
    const note = Writer.local({ profile, channel: 'note', maxChars: 300, tone: 'Formal', messageType: 'Job', sender: { userBio: 'Data analyst in Dublin.' } });
    expect(note).toBe('Dear Aoife, your recent post caught my eye: "We just open-sourced our evaluation toolkit for ranking models." A bit about me: Data analyst in Dublin. '
      + 'Would you be open to a quick chat about openings on your team?');
    expect(note.length).toBeGreaterThan(200);
    expect(Limits.fitToLimit(note, 200)).toEqual({
      text: 'Dear Aoife, your recent post caught my eye: "We just open-sourced our evaluation toolkit for ranking models." Would you be open to a quick chat about openings on your team?',
      changed: true,
      fits: true,
      removed: ['A bit about me: Data analyst in Dublin.'],
    });
  });
});

describe('fitToLimit: a small letter after "Hi Aoife,"', () => {
  // The fitted text goes on after the greeting on one line, like the
  // writer's own notes: "Hi Aoife, would you…".
  it('a common first word gets a small letter after "Hi Aoife," "Dear Aoife," or "Hello,", when Fit changed the text', () => {
    expect(Limits.fitToLimit(`Hi Aoife,\n\n${FILLER}\n\nWould you be open to a chat?`, 40))
      .toEqual({ text: 'Hi Aoife, would you be open to a chat?', changed: true, fits: true, removed: [FILLER] });
    expect(Limits.fitToLimit(`Dear Aoife, Your talk was great. ${FILLER} Would you be open to a chat?`, 80).text)
      .toBe('Dear Aoife, your talk was great. Would you be open to a chat?');
    expect(Limits.fitToLimit(`Hello, Thanks for connecting. ${FILLER} Would you be open to a chat?`, 80).text)
      .toBe('Hello, thanks for connecting. Would you be open to a chat?');
    // After the hook is dropped, the question is first: it gets the small letter.
    expect(Limits.fitToLimit('Hi Aoife, Spotify is great. Would you be open to a chat about ranking at Spotify in Dublin?', 80).text)
      .toBe('Hi Aoife, would you be open to a chat about ranking at Spotify in Dublin?');
  });

  it('every common word in the notes', () => {
    const WORDS = ['would', 'could', 'can', 'will', 'your', 'you', 'thanks', 'thank', 'congrats', 'congratulations', 'we', 'my', 'our', 'it', "it's", 'it’s',
      'this', 'that', 'are', 'is', 'do', 'did', 'have', 'has', 'loved', 'enjoyed', 'saw', 'noticed', 'great', 'just', 'hope', 'as', 'since', 'if',
      'when', 'happy', 'glad', 'also', 'a', 'an', 'the', 'quick', 'really', 'after'];
    const bad = [];
    for (const word of WORDS) {
      const draft = `Hi Aoife, ${word[0].toUpperCase()}${word.slice(1)} ranking talk at PyData was great. ${FILLER} Would you be open to a chat?`;
      const r = Limits.fitToLimit(draft, draft.length - FILLER.length);
      if (r.text !== `Hi Aoife, ${word} ranking talk at PyData was great. Would you be open to a chat?`) bad.push(`${word}: ${r.text}`);
    }
    expect(bad).toEqual([]);
  });

  it('"I", names, words in capitals and other words keep their capital', () => {
    for (const first of ['I loved your talk.', "I'm a data analyst in Dublin.", "Spotify's ranking work caught my eye.", 'Aoife, your talk was great.',
      'ALSO loved your talk.', 'A/B testing at Spotify sounds fun.', 'Yours was a great talk.', 'Ranking is my thing.', 'May I ask a quick question?']) {
      const draft = `Hi Aoife, ${first} ${FILLER} Would you be open to a chat?`;
      const r = Limits.fitToLimit(draft, draft.length - FILLER.length);
      expect(r.text, first).toBe(`Hi Aoife, ${first} Would you be open to a chat?`);
      expect(r.removed, first).toEqual([FILLER]);
    }
  });

  it('only after a greeting that ends with a comma', () => {
    expect(Limits.fitToLimit(`Hi Aoife! Would you be open to a chat? ${FILLER}`, 40).text).toBe('Hi Aoife! Would you be open to a chat?');
    expect(Limits.fitToLimit(`Would you be open to a chat? ${FILLER} Thanks!`, 40).text).toBe('Would you be open to a chat? Thanks!');
  });

  it('a text that already fits is returned as it was, capital and all', () => {
    for (const text of ['Hi Aoife, Would you be open to a chat?', 'Hi Aoife, Your talk was great. Would you be open to a chat?']) {
      expect(Limits.fitToLimit(text, 200)).toEqual({ text, changed: false, fits: true, removed: [] });
    }
  });

  // The third notes: "it's" with a straight or a curly apostrophe. Phones,
  // Macs and Claude often write the curly one.
  it('"It’s" (curly apostrophe) gets a small letter, like "It\'s"', () => {
    const fit = (first) => Limits.fitToLimit(`Hi Aoife, ${first} great to see your ranking work. ${FILLER} Would you be open to a chat?`, 90).text;
    expect(fit("It's")).toBe("Hi Aoife, it's great to see your ranking work. Would you be open to a chat?");
    expect(fit('It’s')).toBe('Hi Aoife, it’s great to see your ranking work. Would you be open to a chat?');
  });
});

describe('fitToLimit: the greeting', () => {
  // The third review: the greeting stopped at the first ".", so for "Dear
  // Dr. Rao," it was "Dear Dr", and "Rao, I read your paper…" became a
  // middle sentence, which Fit dropped first: "Dear Dr. I am an MSc
  // student…". Free Mode never writes a title, but Claude does (AI Mode,
  // often Formal), and "Write with Ark" fits every note that is too long.
  it('"Dear Dr. Rao," is kept whole: the example in the third review', () => {
    const NOTE = 'Dear Dr. Rao, I read your paper on graph neural networks for fraud detection and found it fascinating. '
      + 'I am an MSc student at UCD working on a similar problem. Would you be open to a short chat about your research?';
    expect(NOTE.length).toBeGreaterThan(200);
    expect(Limits.fitToLimit(NOTE, 200)).toEqual({
      text: 'Dear Dr. Rao, I read your paper on graph neural networks for fraud detection and found it fascinating. Would you be open to a short chat about your research?',
      changed: true,
      fits: true,
      removed: ['I am an MSc student at UCD working on a similar problem.'],
    });
  });

  it('a dot after dr, prof, mr, mrs, ms, mx, sr, jr, st or a single letter does not end the greeting', () => {
    const bad = [];
    for (const greeting of ['Dear Dr. Murphy,', 'Hi Dr. Murphy,', 'Dear Prof. Byrne,', 'Hello Mr. Walsh,', 'Dear Mrs. Walsh,', 'Hello Ms. Walsh,', 'Dear Mx. Walsh,',
      'Hi Sr. Walsh,', 'Hi Jr. Walsh,', 'Hi St. John,', 'Dear A. Rao,', 'Dear Dr. A. K. Rao,', 'dear dr. rao,', 'Dear DR. RAO,', 'Dear Dr. Rao!']) {
      // Room for the greeting and the question only.
      const ask = 'Would you be open to a chat about ranking at Spotify?';
      const r = Limits.fitToLimit(`${greeting} ${FILLER} I am a data analyst in Dublin. ${ask}`, greeting.length + 1 + ask.length);
      const want = greeting.endsWith(',') ? `${greeting} would${ask.slice(5)}` : `${greeting} ${ask}`;
      if (r.text !== want || !r.fits) bad.push(`${greeting} gives ${JSON.stringify(r.text)}`);
    }
    expect(bad).toEqual([]);
  });

  it('a title with no dot ("Dear Dr Rao,") works the same', () => {
    expect(Limits.fitToLimit(`Dear Dr Rao, ${FILLER} I am a data analyst in Dublin. Would you be open to a chat about ranking?`, 60))
      .toEqual({ text: 'Dear Dr Rao, would you be open to a chat about ranking?', changed: true, fits: true, removed: [FILLER, 'I am a data analyst in Dublin.'] });
  });
});
