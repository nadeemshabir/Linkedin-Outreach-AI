'use strict';

// A quick, local check of a draft before you send it. No AI and no network:
// it runs on every keystroke. It catches the common reasons cold outreach
// gets ignored, and names in the draft that no source backs up (the AI may
// have made them up).

const Strength = (() => {
  const CLICHES = [
    { re: /\bi hope (?:this|my) (?:message|note|email) finds you well\b/i, quote: 'I hope this message finds you well' },
    { re: /\bi hope you(?:'re| are) (?:doing )?well\b/i,                  quote: 'I hope you are doing well' },
    { re: /\bi (?:came|stumbled) across your profile\b/i,                 quote: 'I came across your profile' },
    { re: /\bi(?:'d| would) like to add you to my professional network\b/i, quote: "LinkedIn's default invite text" },
    { re: /\b(?:dear sir|dear madam|to whom it may concern)\b/i,          quote: 'Dear Sir/Madam' },
    { re: /^[^.!?\n]{0,40}\bmy name is\b/i,                                quote: 'My name is …' },
  ];
  const ASK        = /\?|\b(?:would you|could you|can we|could we|are you open|would it be|happy to|open to|willing to|mind if|let me know if)\b/i;
  const ATTACHMENT = /\b(?:attached|attaching|attachment)\b/i;

  // Capitalized words that are not facts worth checking.
  const NOT_FACTS = new Set(('i hi hello hey dear thanks thank best regards cheers sincerely linkedin ' +
    'monday tuesday wednesday thursday friday saturday sunday january february march april may june july ' +
    'august september october november december msc mba phd bsc btech mtech ms ma ba cv ai ml hr pm ux ui ' +
    'sde ceo cto coo vp us uk eu usa uae nlp llm genai').split(' '));
  const CONNECTORS = new Set(['of', 'and', '&', 'de', 'for', 'the', 'in']);

  const lc = (s) => (s || '').toLowerCase();

  // Everything we know is true: their profile, yours, the talking points.
  function corpus(ctx) {
    return lc(JSON.stringify([ctx.them, ctx.me, ctx.bio, ctx.hooks, ctx.commonGround, ctx.goal]));
  }

  // Proper names in the draft: capitalized runs that are not the first word
  // of a sentence ("Trinity College Dublin", "PyData Dublin", "Spotify").
  function namesIn(text, skip) {
    const found = [];
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
      const words = sentence.replace(/^\s*(?:hi|hello|hey|dear)\s+[^,\s]+,?\s*/i, '').split(/\s+/).filter(Boolean);
      let run = [];
      const flush = () => {
        while (run.length && CONNECTORS.has(lc(run[run.length - 1]))) run.pop();
        if (run.length) found.push(run.join(' '));
        run = [];
      };
      words.forEach((raw, i) => {
        const w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/['’]s$/i, '');
        const capital = /^\p{Lu}/u.test(w) && i > 0;
        if (capital && !NOT_FACTS.has(lc(w)) && !skip.has(lc(w))) {
          run.push(w);
        } else if (run.length && CONNECTORS.has(lc(w))) {
          run.push(w);
        } else {
          flush();
        }
        if (/[,;:()]$/.test(raw)) flush();
      });
      flush();
    }
    return [...new Set(found)];
  }

  function unsupportedNames(text, ctx) {
    const known = corpus(ctx);
    const skip  = new Set([ctx.them && ctx.them.name, ctx.me && ctx.me.name, ctx.senderName]
      .filter(Boolean).flatMap(n => lc(n).split(/\s+/)));
    return namesIn(text, skip).filter(name => {
      if (known.includes(lc(name))) return false;
      // "Dublin ML team": fine if each real word is backed by some source.
      const words = name.split(/\s+/).filter(w => w.length >= 3 && !CONNECTORS.has(lc(w)) && !NOT_FACTS.has(lc(w)));
      return words.length === 0 ? false : !words.every(w => known.includes(lc(w)));
    });
  }

  // Specific things about the recipient: companies, schools, title, skills,
  // city, and the talking points found for them.
  function mentionsSomethingSpecific(text, ctx) {
    const them = ctx.them || {};
    const terms = [
      them.currentCompany, them.currentTitle, ...(them.pastCompanies || []),
      ...(them.educationEntries || []).map(e => String(e).split(' — ')[0]),
      ...(them.skills || []), String(them.location || '').split(',')[0],
      ...(ctx.hooks || []).flatMap(h => String(h).match(/\p{Lu}[\p{L}\p{N}]{2,}/gu) || []),
      ...(ctx.commonGround || []).flatMap(h => String(h).match(/\p{Lu}[\p{L}\p{N}]{2,}/gu) || []),
    ].map(t => lc(String(t || '').trim())).filter(t => t.length >= 3);
    const firstName = lc(String(them.name || '').split(/\s+/)[0]);
    const body = lc(text);
    if (terms.some(t => t !== firstName && body.includes(t))) return true;
    // Their posts and About: two uncommon words shared with the draft
    // ("…your post about software for elderly patients").
    const theirs = new Set(longWords([them.about, ...(them.recentPosts || [])].join(' ')));
    return longWords(text).filter(w => theirs.has(w)).length >= 2;
  }

  const COMMON = new Set(('really currently recently looking interested working software engineer engineering ' +
    'experience company student opportunity opportunities career learning connect connecting thanks would ' +
    'please people through started building developer development roles position team teams hiring').split(' '));
  function longWords(s) {
    return [...new Set(lc(s).match(/\p{L}{6,}/gu) || [])].filter(w => !COMMON.has(w));
  }

  /**
   * @param {string} text  the draft
   * @param {object} ctx   { channel, limit, them, me, bio, hooks, commonGround, goal, senderName }
   */
  function check(text, ctx = {}) {
    const draft  = (text || '').trim();
    const them   = ctx.them || {};
    const first  = String(them.name || 'them').split(/\s+/)[0];
    const isNote = ctx.channel === 'note';
    const checks = [];

    if (isNote && ctx.limit) {
      const over = draft.length - ctx.limit;
      checks.push(over > 0
        ? { id: 'fits', ok: false, label: `${over} over the ${ctx.limit} limit for a note`, tip: 'Use "Fit", or edit it down.' }
        : { id: 'fits', ok: true, label: `Fits the ${ctx.limit}-character note` });
    }

    checks.push(mentionsSomethingSpecific(draft, ctx)
      ? { id: 'personal', ok: true, label: `Mentions something specific about ${first}` }
      : { id: 'personal', ok: false, label: `Nothing specific about ${first} yet`, tip: 'Add one real detail: their work, a post, or something you share.' });

    checks.push(ASK.test(draft)
      ? { id: 'ask', ok: true, label: 'Has a clear ask' }
      : { id: 'ask', ok: false, label: 'No clear ask', tip: 'End with one easy question, e.g. "Open to a 15-minute chat?"' });

    const cliche = CLICHES.find(c => c.re.test(draft));
    checks.push(cliche
      ? { id: 'opener', ok: false, label: `Cliché: "${cliche.quote}"`, tip: 'Open with why them, not a pleasantry.' }
      : { id: 'opener', ok: true, label: 'No cliché opener' });

    if (isNote && ATTACHMENT.test(draft)) {
      checks.push({ id: 'attachment', ok: false, label: 'Mentions an attachment', tip: 'A connection note cannot carry files.' });
    }

    const unsupported = unsupportedNames(draft, ctx).slice(0, 3);
    if (unsupported.length) {
      checks.push({
        id: 'facts', ok: false, warn: true,
        label: `Check: ${unsupported.map(n => `"${n}"`).join(', ')}`,
        tip: 'Not found on their profile, yours, or the talking points. Make sure it is true.'
      });
    }

    const failed = checks.filter(c => !c.ok && !c.warn).length;
    const score  = failed === 0 ? 'strong' : failed === 1 ? 'good' : 'weak';
    return { score, checks, unsupported };
  }

  return { check, namesIn };
})();
