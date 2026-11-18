// Regression tests for the experience parser in content_script.js (B1, B2).
// The page layout here follows what the current scraper reads:
// one <p> per line inside the "Experience" section.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFakeChrome } from '../helpers/fake-chrome.js';
import { runInPage } from '../helpers/load.js';

afterEach(() => vi.useRealTimers());

function profilePage(entries) {
  const lines = entries.flat().map((t) => `<p>${t}</p>`).join('');
  return `<main>
    <section><h1>Aoife Murphy</h1><p>Senior Data Scientist at Spotify</p><p>Dublin, County Dublin, Ireland</p></section>
    <section><h2>Experience</h2>${lines}</section>
  </main>`;
}

async function scrape(html) {
  document.body.innerHTML = html;
  const { chrome, dispatchMessage } = createFakeChrome();
  globalThis.chrome = chrome;
  delete globalThis.__outreachContentScript; // listen again on this test's fake chrome
  runInPage(['scraper.js', 'content_script.js']);
  vi.useFakeTimers();
  const pending = dispatchMessage({ action: 'scrapeProfile' });
  await vi.advanceTimersByTimeAsync(5000);
  const res = await pending;
  expect(res.success).toBe(true);
  return res.data;
}

const pick = (entries) => entries.map(({ title, company, duration }) => ({ title, company, duration }));

describe('job titles are not mistaken for dates (B1)', () => {
  it('keeps titles that contain month letters: MARketing, JUNior, dOCToral, AUGmented', async () => {
    const data = await scrape(profilePage([
      ['Marketing Manager', 'Spotify · Full-time', 'Jan 2022 - Present · 2 yrs 11 mos', 'Dublin, County Dublin, Ireland'],
      ['Junior Data Analyst', 'Accenture · Full-time', '2019 - 2021 · 2 yrs', 'Bengaluru, Karnataka, India'],
      ['Doctoral Researcher', 'Trinity College Dublin', 'Sep 2017 - Aug 2019 · 2 yrs'],
      ['Augmented Reality Engineer', 'Meta · Internship', 'Jun 2016 - Aug 2016 · 3 mos'],
    ]));
    expect(data.experienceEntries.map((e) => e.title)).toEqual([
      'Marketing Manager', 'Junior Data Analyst', 'Doctoral Researcher', 'Augmented Reality Engineer',
    ]);
    expect(data.currentTitle).toBe('Marketing Manager');
  });
});

describe('locations outside India do not shift the job list (B2)', () => {
  it('reads every job correctly for a profile in Europe', async () => {
    const data = await scrape(profilePage([
      ['Senior Data Scientist', 'Spotify · Full-time', 'Jan 2022 - Present · 2 yrs 11 mos', 'Berlin, Germany · Hybrid'],
      ['Data Scientist', 'Zalando · Full-time', 'Mar 2019 - Dec 2021 · 2 yrs 10 mos', 'London, England, United Kingdom'],
      ['Data Science Intern', 'Google · Internship', 'Jun 2018 - Aug 2018 · 3 mos', 'Toronto, Ontario, Canada'],
      ['Research Assistant', 'University of Toronto', '2016 - 2018 · 2 yrs'],
    ]));
    expect(pick(data.experienceEntries)).toEqual([
      { title: 'Senior Data Scientist', company: 'Spotify', duration: 'Jan 2022 - Present · 2 yrs 11 mos' },
      { title: 'Data Scientist', company: 'Zalando', duration: 'Mar 2019 - Dec 2021 · 2 yrs 10 mos' },
      { title: 'Data Science Intern', company: 'Google', duration: 'Jun 2018 - Aug 2018 · 3 mos' },
      { title: 'Research Assistant', company: 'University of Toronto', duration: '2016 - 2018 · 2 yrs' },
    ]);
    expect(data.pastCompanies).toEqual(['Zalando', 'Google', 'University of Toronto']);
  });

  it('a title with a comma is not mistaken for a location', async () => {
    const data = await scrape(profilePage([
      ['Engineer, Machine Learning', 'Google · Full-time', '2020 - Present · 4 yrs'],
      ['Head of Growth, EMEA', 'Stripe · Full-time', '2018 - 2020 · 2 yrs', 'Remote'],
      ['Analyst', 'Deloitte · Full-time', '2016 - 2018 · 2 yrs'],
    ]));
    expect(data.experienceEntries.map((e) => e.title)).toEqual([
      'Engineer, Machine Learning', 'Head of Growth, EMEA', 'Analyst',
    ]);
  });

  it('still works for a profile in India (no regression)', async () => {
    const data = await scrape(profilePage([
      ['Software Engineer', 'Flipkart · Full-time', 'Jul 2021 - Present · 3 yrs', 'Bengaluru, Karnataka, India · On-site'],
      ['SDE Intern', 'Amazon · Internship', 'Jan 2021 - Jun 2021 · 6 mos', 'Hyderabad, Telangana, India'],
    ]));
    expect(pick(data.experienceEntries)).toEqual([
      { title: 'Software Engineer', company: 'Flipkart', duration: 'Jul 2021 - Present · 3 yrs' },
      { title: 'SDE Intern', company: 'Amazon', duration: 'Jan 2021 - Jun 2021 · 6 mos' },
    ]);
  });
});
