// The real extension reading a LinkedIn-2026-like page in Chromium.
// The page scrolls inside <main> and loads Experience, Education and Skills
// only when they scroll into view - like the live site.
import { test, expect } from './extension.js';
import { profilePage } from '../fixtures/linkedin-2026.js';
import { PROFILES, truth } from '../fixtures/profiles.js';

for (const p of [PROFILES[0], PROFILES[5]]) {
  test(`reads ${p.name} in full on a fresh visit, then puts the scroll back`, async ({ context, serviceWorker }) => {
    const url = `https://www.linkedin.com/in/${p.slug}/`;
    await context.route(url, (route) => route.fulfill({
      status: 200, contentType: 'text/html; charset=utf-8', body: profilePage(p, { lazy: true }),
    }));
    const page = await context.newPage();
    await page.goto(url);
    expect(await page.locator('[data-testid^="profile_ExperienceTopLevelSection"]').count()).toBe(0); // not loaded yet

    const res = await serviceWorker.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      return chrome.tabs.sendMessage(tab.id, { action: 'scrapeProfile' });
    }, url);

    const t = truth(p);
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ name: t.name, headline: t.headline, location: t.location, about: t.about });
    expect(res.data.experienceEntries.map((j) => ({ title: j.title, company: j.company }))).toEqual(t.jobs);
    expect(res.data.skills).toEqual(t.skills);
    expect(await page.evaluate(() => document.querySelector('main').scrollTop)).toBe(0);
  });
}
