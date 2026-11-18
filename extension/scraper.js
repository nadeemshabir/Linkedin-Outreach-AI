'use strict';

// scraper.js — reads a LinkedIn profile page into plain data. No Chrome APIs,
// so it can be tested on saved pages and checked on the live site.
//
// Written against LinkedIn's 2026 profile page (checked live, Nov 2026):
//   - there is no <h1>: the name is an <h2> in the top card
//   - class names are scrambled, so we rely on structure, links and test IDs
//     (profile_ExperienceTopLevelSection, expandable-text-box, ...)
//   - the page scrolls inside <main>, not the window, and Experience,
//     Education and Skills only load once scrolled into view
// If those hooks are missing (an older layout), it falls back to reading
// paragraphs line by line.

globalThis.LinkedInScraper = globalThis.LinkedInScraper || (() => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const wait  = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const unique = (list) => [...new Set(list.filter(Boolean))];

  // Section headings in the languages LinkedIn students abroad most often use.
  // (Experience, Education and Skills are found by test ID first, so these
  // only matter for About and Activity, or as a fallback.)
  const HEADINGS = {
    about:      ['about', 'info', 'infos', 'à propos', 'acerca de', 'informazioni', 'over', 'sobre', 'om'],
    experience: ['experience', 'berufserfahrung', 'erfahrung', 'expérience', 'experiencia', 'esperienza', 'ervaring', 'experiência'],
    education:  ['education', 'ausbildung', 'formation', 'educación', 'formazione', 'opleiding', 'formação', 'utbildning'],
    skills:     ['skills', 'kenntnisse', 'compétences', 'aptitudes', 'competenze', 'vaardigheden', 'competências'],
    activity:   ['activity', 'aktivitäten', 'activité', 'actividad', 'attività', 'activiteit', 'atividade'],
  };
  const PRESENT = /\b(present|heute|actuel|aujourd|presente|attuale|heden|atual|nu)\b/i;

  // ── Text helpers ───────────────────────────────────────────────────────────
  // Text of an element, without buttons ("…more") and icons. With keepBreaks,
  // <br> becomes a new line, so About keeps its paragraphs.
  function textOf(root, { keepBreaks = false } = {}) {
    let out = '';
    (function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { out += child.textContent; continue; }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toUpperCase();
        if (tag === 'BUTTON' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'TEMPLATE') continue;
        if (tag === 'BR') { out += keepBreaks ? '\n' : ' '; continue; }
        walk(child);
      }
    })(root);
    return keepBreaks ? out.split('\n').map(clean).filter(Boolean).join('\n') : clean(out);
  }

  // Paragraphs that hold only text: titles, companies, dates, places.
  // Descriptions (<p><span>…) and skill links (<p><a>…) are not leaves.
  const leafLines = (root) => [...root.querySelectorAll('p')]
    .filter(p => p.children.length === 0)
    .map(p => clean(p.textContent))
    .filter(Boolean);

  // "Jul 2020 - Present · 6 yrs", "2019 – 2021", "Jan. 2020 – Heute"
  const isDateRange = (t) => /\b(19|20)\d{2}\b/.test(t) && /\s[-–—]\s|[-–—]/.test(t) && t.length < 80 && !/[.!?]$/.test(t);
  // "18 yrs 3 mos": a total time, with no year in it
  const isDuration  = (t) => /\d/.test(t) && !/\b(19|20)\d{2}\b/.test(t) && t.length <= 25;
  // A place: "San Francisco Bay Area", "Mumbai, Maharashtra, India · On-site",
  // "Remote". Not a media caption ("Project – Compassion can be taught.") and
  // not a thumbnail counter ("+5"), which can sit right after the dates.
  const isPlace = (t) => !!t && t.length >= 2 && t.length <= 70 && /\p{L}/u.test(t) && !/^[+\d]/.test(t)
    && !/[.!?]$/.test(t) && !/\s[–—-]\s/.test(t) && !isDateRange(t) && !isDuration(t);
  // "He/Him", "she/they"
  const isPronouns  = (t) => /^[a-z]{2,5}\/[a-z]{2,5}(\/[a-z]{2,5})?$/i.test(t);
  // "· 3rd" under the name (other languages: "· 2.", "· 2e")
  const isDegree    = (t) => /^·\s*\S{1,6}$/.test(t);

  function headingSection(doc, names) {
    const h2 = [...doc.querySelectorAll('main h2, h2')].find(h => {
      const t = clean(h.textContent).toLowerCase();
      return names.some(n => t === n || t.startsWith(n + ' ') || t.startsWith(n + '('));
    });
    return h2 ? (h2.closest('section') || h2.parentElement) : null;
  }

  // ── Top card ───────────────────────────────────────────────────────────────
  function titleName(doc) {
    // "(6) Jane Doe | LinkedIn" → "Jane Doe"
    return clean(String(doc.title || '').replace(/^\(\d+\+?\)\s*/, '').split('|')[0]);
  }

  function readTopCard(doc) {
    const fromTitle = titleName(doc);
    const h2s = [...doc.querySelectorAll('main h2')];
    const nameH2 = h2s.find(h => clean(h.textContent) === fromTitle)
      || doc.querySelector('h1')                       // older layouts
      || h2s.find(h => !h.closest('[role="listitem"]'));
    const name = clean(nameH2 && nameH2.textContent) || fromTitle;
    if (!nameH2) return { name, headline: null, location: null, degree: null, relationship: null };

    const card = nameH2.closest('section') || nameH2.parentElement;
    const after = [...card.querySelectorAll('p')]
      .filter(p => p.children.length === 0 && (nameH2.compareDocumentPosition(p) & 4)) // 4 = after
      .map(p => clean(p.textContent))
      .filter(Boolean);

    const degreeLine = after.find(isDegree);
    const degreeMatch = degreeLine && degreeLine.match(/(1st|2nd|3rd)/i);
    const degree = degreeMatch ? degreeMatch[1].toLowerCase() : null;
    const headline = after.find(t => !isPronouns(t) && !t.startsWith('·') && t.length > 1) || null;

    // Location: the line just before the "Contact info" link (any language).
    let location = null;
    const contact = card.querySelector('a[href*="/overlay/contact-info"]');
    if (contact) {
      const row = contact.closest('div');
      location = leafLines(row).find(t => t !== '·' && t !== headline) || null;
    }

    const labels = [...card.querySelectorAll('button, a[role="button"]')]
      .map(b => `${b.getAttribute('aria-label') || ''} ${clean(b.textContent)}`.toLowerCase());
    const relationship = degree === '1st' ? 'connected'
      : labels.some(l => /\bpending\b/.test(l)) ? 'pending'
      : 'none';

    return { name, headline, location, degree, relationship };
  }

  // ── Experience ─────────────────────────────────────────────────────────────
  // Jobs are separated by <hr>. Return the blocks between them.
  function entryBlocks(container) {
    const hr = container.querySelector('hr');
    const parent = hr && hr.parentElement && hr.parentElement.parentElement;
    if (!parent || !container.contains(parent)) return [container];
    return [...parent.children].filter(b => leafLines(b).length);
  }

  function readJobs(container) {
    const jobs = [];
    for (const block of entryBlocks(container)) {
      // Several roles at one company: a header (company, total time,
      // location) and one list item per role (title, dates).
      const roles = [...block.querySelectorAll('li')].filter(li => leafLines(li).some(isDateRange));
      if (roles.length) {
        const header = [...block.querySelectorAll('p')]
          .filter(p => p.children.length === 0 && !roles.some(li => li.contains(p)))
          .map(p => clean(p.textContent)).filter(Boolean);
        const company  = header[0] || null;
        const location = header.slice(1).find(isPlace) || null;
        for (const li of roles) {
          const lines = leafLines(li);
          const d = lines.findIndex(isDateRange);
          jobs.push({ title: lines[0], company, duration: lines[d], location: isPlace(lines[d + 1]) ? lines[d + 1] : location });
        }
        continue;
      }
      // One role: title, "Company · Type", dates, maybe a location.
      const lines = leafLines(block);
      const d = lines.findIndex(isDateRange);
      if (d < 1) continue;
      const companyLine = d >= 2 ? lines[1] : null;
      const [company, ...type] = companyLine ? companyLine.split('·').map(clean) : [null];
      jobs.push({
        title: lines[0],
        company: company || null,
        employmentType: type.join(' · ') || null,
        duration: lines[d],
        location: isPlace(lines[d + 1]) ? lines[d + 1] : null,
      });
    }
    const anyPresent = jobs.some(j => PRESENT.test(j.duration || ''));
    return jobs.map((j, i) => ({ ...j, isCurrent: anyPresent ? PRESENT.test(j.duration || '') : i === 0 }));
  }

  // The old line-by-line reader (with the B1/B2 fixes), for older layouts.
  const startsWithDate = (t) => /^(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?\d{4}\b|^present\b/i.test(t || '');
  function looksLikeLocation(t) {
    if (!t || t.length > 80 || startsWithDate(t)) return false;
    if (/\b(remote|on-?site|hybrid)\b/i.test(t)) return true;
    return /^[^,|@·]+(,[^,|@·]+){1,3}(\s·\s.+)?$/.test(t);
  }
  function hasLocationLine(lines, i) {
    const nextTitleAt3 = startsWithDate(lines[i + 5]);
    const nextTitleAt4 = startsWithDate(lines[i + 6]);
    if (nextTitleAt3 !== nextTitleAt4) return nextTitleAt4;
    return looksLikeLocation(lines[i + 3]);
  }
  function readJobsByLines(section) {
    const lines = leafLines(section).filter(t => !HEADINGS.experience.includes(t.toLowerCase()));
    const jobs = [];
    let i = 0;
    while (i < lines.length) {
      const title = lines[i];
      if (startsWithDate(title)) { i++; continue; }
      const company = lines[i + 1] || null;
      const dur = lines[i + 2] || null;
      jobs.push({
        title,
        company: company ? company.split('·')[0].trim() : null,
        duration: dur && (startsWithDate(dur) || /\b\d+\s*(yrs?|mos?)\b/i.test(dur)) ? dur : null,
        isCurrent: jobs.length === 0,
      });
      i += hasLocationLine(lines, i) ? 4 : 3;
    }
    return jobs;
  }

  function readExperience(doc) {
    const byId = doc.querySelector('[data-testid^="profile_ExperienceTopLevelSection"]');
    if (byId) return readJobs(byId);
    const section = headingSection(doc, HEADINGS.experience);
    if (!section) return [];
    // Older flat layout: no <hr> between jobs, all lines in one list.
    const flat = !section.querySelector('hr') && leafLines(section).filter(isDateRange).length > 1;
    if (flat) return readJobsByLines(section);
    const jobs = readJobs(section);
    return jobs.length ? jobs : readJobsByLines(section);
  }

  // ── Education, skills, about, posts ────────────────────────────────────────
  function readEducation(doc) {
    const container = doc.querySelector('[data-testid^="profile_EducationTopLevelSection"]')
      || headingSection(doc, HEADINGS.education);
    if (!container) return [];
    return entryBlocks(container).map(block => {
      const lines = leafLines(block).filter(t => !isDateRange(t) && !/^\d{4}$/.test(t) && !HEADINGS.education.includes(t.toLowerCase()));
      return [lines[0], lines[1]].filter(Boolean).join(' — ');
    }).filter(Boolean);
  }

  function readSkills(doc) {
    const container = doc.querySelector('[data-testid^="profile_Skills"]') || headingSection(doc, HEADINGS.skills);
    if (!container) return [];
    // Skill names are <p><span>; the "used at …" lines under them sit in list items.
    return unique([...container.querySelectorAll('p > span')]
      .filter(s => !s.closest('[role="listitem"]') && !s.closest('h2') && !s.closest('a'))
      .map(s => clean(s.textContent))
      .filter(t => t.length > 1 && t.length < 60 && !/^show all/i.test(t)));
  }

  function readAbout(doc) {
    const section = headingSection(doc, HEADINGS.about);
    if (!section) return null;
    const box = section.querySelector('[data-testid="expandable-text-box"]') || section.querySelector('p > span') || section.querySelector('p');
    const about = box ? textOf(box, { keepBreaks: true }) : '';
    return about.length > 1 ? about : null;
  }

  function readPosts(doc) {
    const section = headingSection(doc, HEADINGS.activity);
    if (!section) return [];
    return unique([...section.querySelectorAll('[data-testid="expandable-text-box"]')].map(b => textOf(b)))
      .filter(t => t.length > 20)
      .slice(0, 3)
      .map(t => (t.length > 400 ? `${t.slice(0, 400)}…` : t));
  }

  function fromHeadline(headline, field) {
    if (!headline) return null;
    const at = headline.match(/^(.+?)\s+(?:at|@)\s+(.+?)(?:\s*[|·].*)?$/i);
    if (at) return field === 'title' ? at[1].trim() : at[2].trim();
    const pipe = headline.match(/^(.+?)\s*[|·]\s*(.+)$/);
    if (pipe) return field === 'title' ? pipe[1].trim() : pipe[2].trim();
    return null;
  }

  // ── Loading lazy sections ──────────────────────────────────────────────────
  // LinkedIn loads Experience, Education and Skills only when they scroll into
  // view, and the page scrolls inside <main>, not the window (so
  // window.scrollTo does nothing). Scroll whatever really scrolls, then put
  // the user back where they were.
  function findScroller(doc) {
    const view = doc.defaultView;
    const candidates = [];
    for (let el = doc.querySelector('main'); el; el = el.parentElement) candidates.push(el);
    for (const el of candidates) {
      const overflow = view ? view.getComputedStyle(el).overflowY : '';
      if (/(auto|scroll)/.test(overflow) && el.scrollHeight > el.clientHeight + 10) return el;
    }
    const root = doc.scrollingElement;
    return root && root.scrollHeight > root.clientHeight + 10 ? root : null;
  }

  // LinkedIn shows a section's box first and fills it a moment later,
  // so a section counts as loaded only once its box has content.
  const LAZY = ['Experience', 'Education', 'Skills'];
  const lazyBoxes = (doc) => LAZY.map(k => doc.querySelector(`[data-testid^="profile_${k}"]`));
  const filled = (box) => !!box && clean(box.textContent).length > 20;
  const allLoaded = (doc) => lazyBoxes(doc).every(filled);

  async function loadLazySections(doc, { stepMs = 350, maxSteps = 16 } = {}) {
    const scroller = findScroller(doc);
    if (!scroller) return { scrolled: false };
    const start = scroller.scrollTop;
    let lastHeight = -1;
    let steps = 0;
    for (; steps < maxSteps && !allLoaded(doc); steps++) {
      scroller.scrollTop = Math.min(scroller.scrollTop + scroller.clientHeight * 0.9, scroller.scrollHeight);
      await wait(stepMs);
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      if (atBottom && scroller.scrollHeight === lastHeight) break;
      lastHeight = scroller.scrollHeight;
    }
    // Boxes that appeared but are still empty get a short moment to fill.
    for (let i = 0; i < 12 && lazyBoxes(doc).some(b => b && !filled(b)); i++) await wait(150);
    scroller.scrollTop = start;
    return { scrolled: true, steps };
  }

  // After LinkedIn changes page without a reload, wait until the top card
  // shows the new person (the title changes first).
  async function waitForTopCard(doc, timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const top = readTopCard(doc);
      if (top.name && top.headline && top.name === titleName(doc)) return;
      await wait(100);
    }
  }

  // ── Everything ─────────────────────────────────────────────────────────────
  function scrape(doc = document) {
    const top  = readTopCard(doc);
    const jobs = readExperience(doc);
    const current = jobs.find(j => j.isCurrent) || jobs[0] || null;
    const href = (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || '';
    return {
      name:              top.name,
      headline:          top.headline,
      currentTitle:      current ? current.title : fromHeadline(top.headline, 'title'),
      currentCompany:    current ? current.company : fromHeadline(top.headline, 'company'),
      location:          top.location,
      about:             readAbout(doc),
      recentPosts:       readPosts(doc),
      experienceEntries: jobs.slice(0, 6),
      pastCompanies:     unique(jobs.map(j => j.company).filter(c => !current || c !== current.company)).slice(0, 5),
      educationEntries:  readEducation(doc).slice(0, 4),
      skills:            readSkills(doc).slice(0, 15),
      degree:            top.degree,
      relationship:      top.relationship,
      profileUrl:        href.split('?')[0],
      rawTitle:          doc.title,
      scraperVersion:    2,
    };
  }

  return { scrape, readTopCard, loadLazySections, waitForTopCard, titleName, isDateRange };
})();
