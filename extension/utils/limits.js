'use strict';

// LinkedIn's length limits, and a careful way to make a draft fit.
//
// A connection note is hard-capped by LinkedIn: 200 characters on a free
// account, 300 on Premium. Free accounts also get only a few personalized
// notes a month (LinkedIn does not publish one fixed number; ~5 is typical).
// Messages to connections have no tight cap, but short ones get more replies,
// so for them we only suggest a length.

const Limits = (() => {
  const NOTE_LIMIT        = { free: 200, premium: 300 };
  const MESSAGE_SUGGESTED = 500;
  const FREE_NOTES_PER_MONTH = 5;

  function limitFor(channel, plan) {
    if (channel === 'note') return plan === 'premium' ? NOTE_LIMIT.premium : NOTE_LIMIT.free;
    return MESSAGE_SUGGESTED;
  }

  // What the length meter should show.
  function lengthState(text, channel, plan) {
    const count = (text || '').length;
    const limit = limitFor(channel, plan);
    const hard  = channel === 'note';
    return { count, limit, hard, over: count > limit, near: count > limit * 0.9 && count <= limit };
  }

  // "2026-11": notes are counted per calendar month.
  function monthKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  // ── Make a draft fit ──────────────────────────────────────────────────────
  // Never cuts mid-sentence. In order, it removes:
  //   1. filler sentences ("I hope this message finds you well.")
  //   2. the sign-off ("Thank you, Rahul": LinkedIn shows your name anyway)
  //   3. middle sentences, least specific first
  // It keeps the greeting, the first sentence (the hook) and the question
  // (the ask). If that still does not fit, it says so instead of cutting.

  const FILLER = [
    /^i hope (this|my) (message|note) finds you well/i,
    /^i hope you(?:'re| are) (?:doing )?well/i,
    /^i hope you(?:'re| are) having a (?:great|good|nice|lovely) (?:day|week)/i,
    /^(?:thank you|thanks) (?:so much |very much )?for (?:your time|reading|considering)/i,
    /^(?:i am |i'm )?looking forward to (?:hearing from you|your reply|connecting|it)/i,
    /^(?:please )?(?:feel free to|don't hesitate to) (?:reach out|contact me)/i,
    /^i have attached my (?:cv|resume|résumé)/i, // you can't attach files to a note
  ];
  const GREETING = /^((?:hi|hello|hey|dear)\b[^,\n.!?]{0,40}[,!]?)\s*/i;
  const SIGNOFF  = /\s*(?:\n|^|(?<=[.!?])\s)\s*(?:thanks|thank you|best|best regards|kind regards|warm regards|regards|cheers|sincerely)\b[^\n]{0,40}$/i;
  const ASK      = /\?|\b(?:would you|could you|can we|could we|are you open|would it be|happy to|open to|willing to|mind if)\b/i;

  function splitSentences(body) {
    return body.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  }

  // Specific sentences (names, numbers, places) matter more than generic ones.
  function specificity(sentence) {
    const words = sentence.split(/\s+/).slice(1); // ignore the first word's capital
    const capitals = words.filter(w => /^[A-Z][a-zA-Z]/.test(w)).length;
    const numbers  = (sentence.match(/\d/g) || []).length ? 1 : 0;
    return capitals + numbers;
  }

  function fitToLimit(text, limit) {
    const original = (text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (original.length <= limit) return { text: original, changed: false, fits: true, removed: [] };

    let rest = original;
    let greeting = '';
    const g = rest.match(GREETING);
    if (g) { greeting = g[1]; rest = rest.slice(g[0].length); }

    let signoff = '';
    const s = rest.match(SIGNOFF);
    if (s && s.index > 0) { signoff = s[0].trim(); rest = rest.slice(0, s.index); }

    let sentences = splitSentences(rest.replace(/\s*\n\s*/g, ' '));
    const removed = [];
    const build = () => [greeting, ...sentences, signoff].filter(Boolean).join(' ').replace(/\s+([,.!?])/g, '$1');
    const fits = () => build().length <= limit;

    // 1. Filler sentences.
    for (const f of [...sentences]) {
      if (fits()) break;
      if (FILLER.some(re => re.test(f))) { sentences = sentences.filter(x => x !== f); removed.push(f); }
    }
    // 2. The sign-off.
    if (!fits() && signoff) { removed.push(signoff); signoff = ''; }
    // 3. Middle sentences: keep the first (the hook) and any ask.
    const droppable = sentences
      .map((text, i) => ({ text, i }))
      .filter(({ text, i }) => i > 0 && !ASK.test(text))
      .sort((a, b) => specificity(a.text) - specificity(b.text) || b.text.length - a.text.length);
    for (const { text } of droppable) {
      if (fits()) break;
      sentences = sentences.filter(x => x !== text);
      removed.push(text);
    }
    // 4. Last resort: the hook itself, if an ask remains.
    if (!fits() && sentences.length > 1 && !ASK.test(sentences[0]) && sentences.slice(1).some(x => ASK.test(x))) {
      removed.push(sentences[0]);
      sentences = sentences.slice(1);
    }

    const result = build();
    return { text: result, changed: result !== original, fits: result.length <= limit, removed };
  }

  return { NOTE_LIMIT, MESSAGE_SUGGESTED, FREE_NOTES_PER_MONTH, limitFor, lengthState, monthKey, fitToLimit };
})();
