// Scraper v2 on pages built like LinkedIn's 2026 profile (structure copied
// from the live site), for each made-up person in test/fixtures/profiles.js.
import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';
import { exportFrom } from '../helpers/load.js';
import { profilePage } from '../fixtures/linkedin-2026.js';
import { PROFILES, truth } from '../fixtures/profiles.js';

const LinkedInScraper = exportFrom('scraper.js', 'LinkedInScraper');

function read(p) {
  const win = new Window({ url: `https://www.linkedin.com/in/${p.slug}/` });
  win.document.write(profilePage(p, { owner: !!p.owner }));
  return LinkedInScraper.scrape(win.document);
}

describe.each(PROFILES.map((p) => [p.name, p]))('scraper v2: %s', (_name, p) => {
  const r = read(p);
  const t = truth(p);

  it('name (without the "(3)" notification count), headline, location, degree', () => {
    expect({ name: r.name, headline: r.headline, location: r.location, degree: r.degree })
      .toEqual({ name: t.name, headline: t.headline, location: t.location, degree: t.degree });
  });

  it('every job, including several roles at one company', () => {
    expect(r.experienceEntries.map((j) => ({ title: j.title, company: j.company }))).toEqual(t.jobs);
  });

  it('About keeps its paragraphs and drops the "…more" button', () => {
    expect(r.about).toBe(t.about);
  });

  it('schools, skills (not the "used at…" lines), and post text (not the author line)', () => {
    expect(r.educationEntries.map((e) => e.split(' — ')[0])).toEqual(t.schools);
    expect(r.skills).toEqual(t.skills);
    expect(r.recentPosts).toEqual(t.posts);
  });
});

describe('scraper v2: details', () => {
  const byName = Object.fromEntries(PROFILES.map((p) => [p.name, read(p)]));

  it('a job location is a place, never a media caption or a "+5" counter', () => {
    const liam = byName['Liam Byrne'].experienceEntries;
    expect(liam[0].location).toBe('London, England, United Kingdom');
    const aoife = byName['Aoife Murphy'].experienceEntries;
    expect(aoife[1]).toMatchObject({ title: 'Data Scientist', location: 'Dublin, County Dublin, Ireland' }); // from the group header, not "+3"
  });

  it('current role, current company, and past companies (not counting the current one)', () => {
    expect(byName['Aoife Murphy']).toMatchObject({
      currentTitle: 'Senior Data Scientist', currentCompany: 'Spotify', pastCompanies: ['Accenture'],
    });
    expect(byName['Maria Rossi'].experienceEntries.map((j) => j.isCurrent)).toEqual([true, false, false]);
  });

  it('relationship from the page: connected, invite pending, or none', () => {
    expect(byName["Seán O'Brien"].relationship).toBe('connected');
    expect(byName['Wei Chen'].relationship).toBe('pending');
    expect(byName['Liam Byrne'].relationship).toBe('none');
  });

  it('a hidden "· 1st" line does not make a stranger a connection (seen live, Nov 2026)', () => {
    const win = new Window({ url: 'https://www.linkedin.com/in/jane-doe-test/' });
    win.document.write(`<html><head><title>Jane Doe | LinkedIn</title></head><body><main><section>
      <h2>Jane Doe</h2>
      <div style="display:none"><p>· 1st</p></div>
      <div><p>· 2nd</p></div>
      <p>Founder at Example Co</p>
      <div><p>Pune, India</p><p>·</p><p><a href="/in/jane-doe-test/overlay/contact-info/">Contact info</a></p></div>
    </section></main></body></html>`);
    expect(LinkedInScraper.readTopCard(win.document)).toMatchObject({
      name: 'Jane Doe', degree: '2nd', relationship: 'none', headline: 'Founder at Example Co',
    });
  });

  it('on your own profile: pronouns are not the headline, and there is no degree', () => {
    expect(byName['Rahul Sharma']).toMatchObject({ headline: 'Data Analyst | MSc Data Analytics, UCD', degree: null });
  });

  it('marks its output as v2', () => {
    expect(byName['Priya Nair'].scraperVersion).toBe(2);
  });
});
