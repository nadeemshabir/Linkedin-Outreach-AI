'use strict';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'scrapeProfile') {
    scrapeWithScroll().then(profile => {
      sendResponse({ success: true, data: profile });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // A quick look for the side panel: name + headline, no scrolling.
  if (msg.action === 'peekProfile') {
    waitForTopCard().then(() => {
      const { name, headline } = readTopCard();
      sendResponse({ success: true, data: { name, headline, profileUrl: window.location.href.split('?')[0] } });
    });
    return true;
  }
});

// LinkedIn changes pages without reloading. Right after the URL changes the
// old person can still be on screen, so wait until the page title shows the
// new name (or give up after a moment).
async function waitForTopCard(timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const h1 = (document.querySelector('h1')?.innerText || '').trim();
    if (h1 && document.title.includes(h1)) return;
    await wait(100);
  }
}

// Name and headline from the top card of the profile.
function readTopCard() {
  const clean = (str) => (str || '').replace(/\s+/g, ' ').trim();

  // "(3) Aoife Murphy | LinkedIn" → "Aoife Murphy"
  const name = clean(document.querySelector('h1')?.innerText) ||
               clean(document.title.replace(/^\(\d+\+?\)\s*/, '').split('|')[0]);

  let headline = null;
  for (const sec of document.querySelectorAll('section')) {
    if (sec.querySelector('h1')) {
      const pTags = Array.from(sec.querySelectorAll('p'))
        .filter(p => p.children.length === 0)
        .map(p => clean(p.innerText))
        .filter(t => t.length > 5 && t !== name);
      // Headline often contains | or @ or job title keywords
      const headlineEl = pTags.find(t =>
        t.includes('|') || t.includes('@') || t.includes('·') ||
        /manager|engineer|analyst|developer|designer|founder|director|lead|specialist|consultant|intern|fellow|trainee/i.test(t)
      ) || pTags[0];
      if (headlineEl) { headline = headlineEl; break; }
    }
  }
  return { name, headline };
}

async function scrapeWithScroll() {
  window.scrollTo(0, 800);  await wait(500);
  window.scrollTo(0, 1600); await wait(500);
  window.scrollTo(0, 2400); await wait(600);
  window.scrollTo(0, 0);    await wait(300);
  return scrapeProfile();
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function scrapeProfile() {
  const clean = (str) => (str || '').replace(/\s+/g, ' ').trim();

  // Find section by h2 heading text
  function getSection(heading) {
    return Array.from(document.querySelectorAll('section')).find(s =>
      s.querySelector('h2')?.innerText?.trim().toLowerCase().includes(heading.toLowerCase())
    ) || null;
  }

  // Get all leaf text nodes from a section using P tags and spans
  function getTexts(section) {
    if (!section) return [];
    return Array.from(section.querySelectorAll('p, span'))
      .filter(el => el.children.length === 0)
      .map(el => clean(el.innerText))
      .filter(t => t.length > 2 && !/^[·•\s]+$/.test(t));
  }

  // ── NAME + HEADLINE ───────────────────────────────────────────────────────
  const { name, headline } = readTopCard();
  const allSections = Array.from(document.querySelectorAll('section'));

  // ── LOCATION ──────────────────────────────────────────────────────────────
  let location = null;
  for (const sec of allSections) {
    if (sec.querySelector('h1')) {
      const pTags = Array.from(sec.querySelectorAll('p'))
        .filter(p => p.children.length === 0)
        .map(p => clean(p.innerText))
        .filter(t => t.length > 3);
      // Location is usually the 2nd or 3rd p tag — looks like "City, Country"
      const locEl = pTags.find(t =>
        t.includes(',') && t.length < 60 && !t.includes('|') && !t.includes('@')
      );
      if (locEl) { location = locEl; break; }
    }
  }

  // ── ABOUT ─────────────────────────────────────────────────────────────────
  let about = null;
  const aboutSection = getSection('About');
  if (aboutSection) {
    const texts = getTexts(aboutSection);
    const longText = texts.find(t => t.length > 80 && !t.includes('Experience') && !t.includes('Skills'));
    if (longText) about = longText;
  }

  // ── EXPERIENCE ────────────────────────────────────────────────────────────
  const experienceEntries = [];
  const expSection = getSection('Experience');
  if (expSection) {
    const pTags = Array.from(expSection.querySelectorAll('p'))
      .filter(p => p.children.length === 0)
      .map(p => clean(p.innerText))
      .filter(t => t.length > 2 && t !== 'Experience');

    // Group into entries of 3-4 lines each
    // Pattern: title, company·type, date, location(optional)
    let i = 0;
    while (i < pTags.length) {
      const title   = pTags[i];
      const company = pTags[i+1] || null;
      const dur     = pTags[i+2] || null;

      // Skip a stray date line (not a title)
      if (isDateLine(title)) {
        i++; continue;
      }

      experienceEntries.push({
        title,
        company:   company ? company.split('·')[0].trim() : null,
        duration:  dur && (isDateLine(dur) || /\b\d+\s*(yrs?|mos?)\b/i.test(dur)) ? dur : null,
        isCurrent: experienceEntries.length === 0
      });

      // Advance past this entry: title + company + dates, plus an optional location line
      i += hasLocationLine(pTags, i) ? 4 : 3;
    }
  }

  const currentEntry   = experienceEntries[0] || null;
  const currentTitle   = currentEntry?.title   || extractFromHeadline(headline, 'title');
  const currentCompany = currentEntry?.company || extractFromHeadline(headline, 'company');
  const pastCompanies  = [...new Set(
    experienceEntries.slice(1).map(e => e.company).filter(Boolean)
  )];

  // ── SKILLS ────────────────────────────────────────────────────────────────
  const skills = [];
  const skillsSection = getSection('Skills');
  if (skillsSection) {
    const texts = getTexts(skillsSection);
    texts.filter(t =>
      t !== 'Skills' &&
      t.length < 60 &&
      t.length > 2 &&
      !/\d{4}|follower|connection|endorsement|endorse|show all|see all|dialog|window|escape/i.test(t)
    ).forEach(t => skills.push(t));
  }

  // ── EDUCATION ─────────────────────────────────────────────────────────────
  const educationEntries = [];
  const eduSection = getSection('Education');
  if (eduSection) {
    const pTags = Array.from(eduSection.querySelectorAll('p'))
      .filter(p => p.children.length === 0)
      .map(p => clean(p.innerText))
      .filter(t => t.length > 2 && t !== 'Education');
    for (let i = 0; i < pTags.length; i += 3) {
      if (pTags[i]) educationEntries.push(
        [pTags[i], pTags[i+1]].filter(Boolean).join(' — ')
      );
    }
  }

  // ── RECENT POSTS ──────────────────────────────────────────────────────────
  const recentPosts = [];
  const activitySection = getSection('Activity');
  if (activitySection) {
    Array.from(activitySection.querySelectorAll('p, span'))
      .filter(el => el.children.length === 0)
      .map(el => clean(el.innerText))
      .filter(t =>
        t.length > 40 && t.length < 500 &&
        !/dialog|window|escape|cancel|close|beginning|notifications|premium|people you may|you might/i.test(t)
      )
      .forEach(t => { if (!recentPosts.includes(t)) recentPosts.push(t); });
  }

  return {
    name,
    headline,
    currentTitle,
    currentCompany,
    location,
    about,
    recentPosts:       recentPosts.slice(0, 3),
    experienceEntries: experienceEntries.slice(0, 5),
    pastCompanies:     pastCompanies.slice(0, 4),
    educationEntries:  educationEntries.slice(0, 3),
    skills:            skills.slice(0, 10),
    profileUrl:        window.location.href.split('?')[0],
    rawTitle:          document.title
  };
}

// "Jan 2022 - Present", "2019 - 2021", "Present". Anchored at the start of the
// line, so titles like "Marketing Manager" or "Junior Analyst" are not dates.
// (Regexes live inside functions: this file may be injected twice, and only
// function declarations can be safely declared again.)
function isDateLine(text) {
  return /^(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?\d{4}\b|^present\b/i.test(text || '');
}

// Does the entry starting at line i have a 4th line (its location)?
// Decided by structure, not by a list of city names: the next entry's dates
// sit 2 lines below its title, so find where the next date line is.
function hasLocationLine(lines, i) {
  const nextTitleAt3 = isDateLine(lines[i + 5]);
  const nextTitleAt4 = isDateLine(lines[i + 6]);
  if (nextTitleAt3 !== nextTitleAt4) return nextTitleAt4;
  return looksLikeLocation(lines[i + 3]); // last entry, or unclear
}

function looksLikeLocation(text) {
  if (!text || text.length > 80 || isDateLine(text)) return false;
  if (/\b(remote|on-?site|hybrid)\b/i.test(text)) return true;
  return /^[^,|@·]+(,[^,|@·]+){1,3}(\s·\s.+)?$/.test(text); // "City, Region, Country"
}

function extractFromHeadline(headline, field) {
  if (!headline) return null;
  const atMatch = headline.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) return field === 'title' ? atMatch[1].trim() : atMatch[2].trim();
  const pipeMatch = headline.match(/^(.+?)\s*[|·]\s*(.+)$/);
  if (pipeMatch) return field === 'title' ? pipeMatch[1].trim() : pipeMatch[2].trim();
  return null;
}