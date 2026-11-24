'use strict';

// What you have in common with the person you are writing to.
// A shared school or past employer is the strongest reason a stranger
// replies, so these become talking points the writer can use. A shared city
// is weak: on its own, "We are both based in Dublin" is not personal, and
// with it picked every message to someone nearby was about the city. It is
// still offered, for you to tick.
// Uses your own profile, imported once from your LinkedIn page.

const CommonGround = (() => {
  const COMPANY_NOISE = /\b(?:inc|ltd|limited|llc|llp|plc|gmbh|ag|bv|pvt|private|corp|corporation|co|company|group|holdings)\b\.?/gi;
  // Places and institutions that show someone studied or worked in India.
  // (Most users are students from India, judging by the original code.)
  const INDIA = /\b(?:india|iit|iits|nit|iiit|iim|bits pilani|delhi|mumbai|bombay|bengaluru|bangalore|chennai|madras|hyderabad|pune|kolkata|calcutta|ahmedabad|jaipur|lucknow|kanpur|kharagpur|roorkee|guwahati|vit|manipal|amity|anna university|jadavpur|srm|kiit)\b/i;

  const lc = (s) => String(s || '').toLowerCase();
  const words = (s) => lc(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const company = (s) => words(lc(s).replace(/\(.*?\)/g, '').replace(COMPANY_NOISE, ''));
  const school = (s) => words(String(s || '').split(' — ')[0]).replace(/^the /, '');
  const schoolName = (s) => String(s || '').split(' — ')[0].trim();

  function place(location) {
    const parts = String(location || '').split(',').map(p => p.trim()).filter(Boolean);
    return { city: lc(parts[0]), country: parts.length > 1 ? lc(parts[parts.length - 1]) : '', cityLabel: parts[0] || '', countryLabel: parts[parts.length - 1] || '' };
  }

  const sameSchool = (a, b) => a === b || (a.length >= 8 && b.length >= 8 && (a.includes(b) || b.includes(a)));

  function companiesOf(p) {
    return [p.currentCompany, ...(p.pastCompanies || []), ...(p.experienceEntries || []).map(e => e && e.company)]
      .filter(Boolean);
  }

  /**
   * @returns {Array<{kind, strength, label, hook}>} strongest first.
   *   label: shown to you ("You both studied at Trinity College Dublin")
   *   hook:  given to the writer ("We both studied at Trinity College Dublin")
   */
  function find(me, them) {
    if (!me || !them) return [];
    const out  = [];
    const seen = new Set();
    const add  = (item) => { if (!seen.has(item.label)) { seen.add(item.label); out.push(item); } };

    const mySchools = (me.educationEntries || []).map(school).filter(s => s.length >= 4);
    for (const entry of them.educationEntries || []) {
      const s = school(entry);
      if (s.length >= 4 && mySchools.some(m => sameSchool(m, s))) {
        const name = schoolName(entry);
        add({ kind: 'school', strength: 3, label: `You both studied at ${name}`, hook: `We both studied at ${name}` });
      }
    }

    const myCompanies = new Set(companiesOf(me).map(company).filter(Boolean));
    for (const c of companiesOf(them)) {
      if (company(c) && myCompanies.has(company(c))) {
        add({ kind: 'company', strength: 3, label: `You both worked at ${c}`, hook: `We have both worked at ${c}` });
      }
    }

    const mine = place(me.location);
    const theirs = place(them.location);
    if (mine.city && mine.city === theirs.city) {
      add({ kind: 'city', strength: 1, label: `You are both in ${theirs.cityLabel}`, hook: `We are both based in ${theirs.cityLabel}` });
    } else if (mine.country && mine.country === theirs.country) {
      add({ kind: 'country', strength: 1, label: `You are both in ${theirs.countryLabel}`, hook: `We are both based in ${theirs.countryLabel}` });
    }

    const myRoots    = INDIA.test([...(me.educationEntries || []), me.location].join(' '));
    const theirRoots = INDIA.test((them.educationEntries || []).join(' '));
    if (myRoots && theirRoots && !out.some(o => o.kind === 'school')) {
      const abroad = !INDIA.test(them.location || '');
      add({ kind: 'roots', strength: abroad ? 2 : 1, label: 'You both studied in India', hook: 'We both studied in India' });
    }

    const mySkills = new Map((me.skills || []).map(s => [lc(s), s]));
    const shared = (them.skills || []).filter(s => mySkills.has(lc(s)));
    if (shared.length >= 2) {
      const list = shared.slice(0, 3).join(', ');
      add({ kind: 'skills', strength: 1, label: `Shared skills: ${list}`, hook: `We share skills in ${list}` });
    }

    return out.sort((a, b) => b.strength - a.strength);
  }

  // What to use by default: the strong ones, at most two.
  function defaultPick(items) {
    return items.filter(i => i.strength >= 2).slice(0, 2).map(i => i.hook);
  }

  return { find, defaultPick };
})();
