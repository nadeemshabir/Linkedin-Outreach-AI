// Builds test pages that copy the STRUCTURE of LinkedIn's 2026 profile page
// (as seen live in Nov 2026), filled with made-up people. No real profile
// data is stored in this repo.
//
// What is copied from the live page:
//   - no <h1>; the name is an <h2> inside a link to the profile
//   - pronouns / "· 2nd" degree lines under the name; location just before
//     the /overlay/contact-info/ link
//   - Experience / Education / Skills boxes with data-testid hooks, jobs
//     separated by <hr role="presentation">, grouped roles in <ul><li>
//   - descriptions and About in span[data-testid="expandable-text-box"] with
//     <br> paragraphs and a "…more" button
//   - media captions and "+5" thumbnail counters after a job's dates
//   - the page scrolls inside <main id="workspace">, not the window, and
//     (with lazy: true) the lower sections only load when <main> scrolls -
//     their box appears first and fills a moment later.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
let nextId = 1000;

function expandable(text) {
  const paragraphs = String(text).split('\n').map(esc).join('<br><br>');
  return `<span data-testid="expandable-text-box">${paragraphs}<button data-testid="expandable-text-button" aria-hidden="true"><span><span><span>…</span><span>more</span></span></span></button></span>`;
}

function topCard(p, owner) {
  const buttons = owner
    ? '<button aria-label="Open to"><span><span>Open to</span></span></button><button aria-label="More"><span><span>More</span></span></button>'
    : p.relationship === 'pending'
      ? `<button aria-label="Pending, click to withdraw invitation sent to ${esc(p.name)}"><span><span>Pending</span></span></button><button aria-label="More"><span>More</span></button>`
      : p.degree === '1st'
        ? `<button aria-label="Message ${esc(p.name)}"><span><span>Message</span></span></button><button aria-label="More"><span>More</span></button>`
        : `<button aria-label="Invite ${esc(p.name)} to connect"><span><span>Connect</span></span></button><button aria-label="More"><span>More</span></button>`;
  return `
  <section class="aaaja3 aaajk6"><section class="aaamas aaailv">
    <div><div><div>
      <div><div><a href="/in/${p.slug}/"><div><div><h2>${esc(p.name)}</h2><svg></svg></div></div></a></div>
        ${p.pronouns ? `<p>${esc(p.pronouns)}</p>` : ''}
        ${!owner && p.degree ? `<p>· ${esc(p.degree)}</p>` : ''}
      </div>
      <p>${esc(p.headline)}</p>
      ${p.subline ? `<p>${esc(p.subline)}</p>` : ''}
      <div><p>${esc(p.location)}</p><p>·</p><p><a href="/in/${p.slug}/overlay/contact-info/">Contact info</a></p></div>
    </div></div></div>
    <div><a href="/mynetwork/invite-connect/connections/"><p>500+ connections</p></a></div>
    <div><div>${buttons}</div></div>
  </section></section>`;
}

function aboutSection(p) {
  if (!p.about) return '';
  return `<section><div><div><div><h2>About</h2></div><div><p>${expandable(p.about)}</p></div></div></div></section>`;
}

function activitySection(p) {
  if (!p.posts || !p.posts.length) return '';
  const items = p.posts.map((post, i) => `
    <li><div role="listitem"><div>
      <div><p><span>${esc(p.name)}</span></p><p><span>• ${esc(p.degree || 'You')}</span></p><p><span>${esc(p.headline)}</span></p><p><span>${i + 1}w •</span></p></div>
      <a href="/feed/update/urn:li:activity:${nextId++}/"><p>${expandable(post)}</p></a>
    </div></div></li>`).join('');
  return `<section><div><div><h2>Activity</h2><div><a href="/feed/followers/"><p>1,204 followers</p></a></div></div>
    <section role="list"><ul>${items}</ul></section></div></section>`;
}

function single(job, slug, owner, first) {
  const id = nextId++;
  const textLink = owner ? `/in/${slug}/edit/forms/position/${id}/` : `/company/${id}/`;
  const companyLine = job.type ? `${job.company} · ${job.type}` : job.company;
  const locInside = owner && job.location ? `<p>${esc(job.location)}</p>` : '';
  const locOutside = !owner && job.location ? `<p>${esc(job.location)}</p>` : '';
  const extras = (job.caption ? `<p>${esc(job.caption)}</p>` : '') + (job.thumbs ? `<p>+${job.thumbs}</p>` : '');
  return `<div>${first ? '' : '<hr role="presentation">'}
    <div><div><div><div>
      <a href="/company/${id}/"><figure></figure></a>
      <div><a href="${textLink}"><div><div><div><p>${esc(job.title)}</p><p>${esc(companyLine)}</p></div></div><p>${esc(job.dates)}</p>${locInside}</div></a>
        ${job.present ? '<div><div><div><p><span>Present</span></p></div></div></div>' : ''}
      </div>
    </div></div></div></div>
    <div><div>${locOutside}${extras}
      ${job.description ? `<div><p>${expandable(job.description)}</p></div>` : ''}
      ${owner && job.skills ? `<p><a href="/in/${slug}/overlay/${id}/skill-associations-details/">${esc(job.skills)}<span aria-hidden="true"><svg></svg></span><span></span></a></p>` : ''}
    </div></div>
  </div>`;
}

function grouped(job, first) {
  const id = nextId++;
  const roles = job.roles.map(r => `
    <li><div><div></div></div><div>
      <div><a href="/company/${id}/"><div><p>${esc(r.title)}</p><p>${esc(r.dates)}</p></div></a>
        ${/present/i.test(r.dates) ? '<div><div><div><p><span>Present</span></p></div></div></div>' : ''}</div>
      ${r.location ? `<p>${esc(r.location)}</p>` : ''}
      ${r.description ? `<div><p>${expandable(r.description)}</p></div>` : ''}
      ${r.thumbs ? `<p>+${r.thumbs}</p>` : ''}
    </div></li>`).join('');
  return `<div>${first ? '' : '<hr role="presentation">'}
    <div><div><div>
      <a href="/company/${id}/"><figure></figure></a>
      <div><a href="/company/${id}/"><div><div><div><p>${esc(job.company)}</p><p>${esc(job.total)}</p></div></div>${job.location ? `<p>${esc(job.location)}</p>` : ''}</div></a></div>
    </div></div></div>
    <ul>${roles}</ul>
  </div>`;
}

// Each lower section is a box with a data-testid and its content.
function experienceBox(p, owner) {
  return {
    testid: `profile_ExperienceTopLevelSection_${p.slug}`,
    inner: p.jobs.map((job, i) => (job.roles ? grouped(job, i === 0) : single(job, p.slug, owner, i === 0))).join(''),
  };
}

function educationBox(p) {
  return {
    testid: `profile_EducationTopLevelSection_${p.slug}`,
    inner: p.education.map((e, i) => `<div>${i ? '<hr role="presentation">' : ''}
      <div><div><a href="/school/${nextId++}/"><figure></figure></a>
        <div><div><div><p>${esc(e.school)}</p>${e.degree ? `<p>${esc(e.degree)}</p>` : ''}</div></div>
        ${e.dates ? `<a href="/school/${nextId}/"><div><p>${esc(e.dates)}</p></div></a>` : ''}</div>
      </div></div></div>`).join(''),
  };
}

function skillsBox(p) {
  return {
    testid: `profile_Skills_${p.slug}`,
    inner: p.skills.map((s, i) => `<div>${i ? '<hr role="presentation">' : ''}
      <div><div><p><span>${esc(s.name)}</span></p>
        ${s.context ? `<div role="list"><div role="listitem"><figure></figure><div><p><span>${esc(s.context)}</span></p></div></div></div>` : ''}
      </div></div></div>`).join('') + `<a href="/in/${p.slug}/details/skills/"><span><span>Show all</span></span></a>`,
  };
}

const LOWER = [
  ['experience', 'Experience', experienceBox],
  ['education', 'Education', educationBox],
  ['skills', (p) => `Skills (${p.skills.length + 7})`, skillsBox],
];

/**
 * @param {object} p        a made-up profile (see test/fixtures/profiles.js)
 * @param {object} opts
 * @param {boolean} [opts.owner]  your own profile (pronouns, edit links, no degree)
 * @param {boolean} [opts.lazy]   lower sections load only when <main> scrolls (needs a real browser)
 */
export function profilePage(p, { owner = false, lazy = false } = {}) {
  const sections = LOWER.map(([key, heading, box]) => {
    const has = key === 'experience' ? p.jobs.length : key === 'education' ? p.education.length : p.skills.length;
    if (!has) return '';
    const title = typeof heading === 'function' ? heading(p) : heading;
    const { testid, inner } = box(p, owner);
    if (!lazy) return `<section><div><div><h2>${esc(title)}</h2></div><div data-testid="${testid}">${inner}</div></div></section>`;
    return `<section data-lazy="${key}" style="min-height:900px"></section>
      <template id="tpl-${key}-head"><div><div><h2>${esc(title)}</h2></div><div data-testid="${testid}"></div></div></template>
      <template id="tpl-${key}-box">${inner}</template>`;
  }).join('');

  const lazyScript = !lazy ? '' : `<script>
    // Like LinkedIn: load a section when it scrolls into view inside <main>.
    // The (empty) box appears first; its content arrives a moment later.
    const main = document.querySelector('main');
    function check() {
      for (const ph of document.querySelectorAll('section[data-lazy]:not([data-loading])')) {
        if (ph.getBoundingClientRect().top > main.clientHeight + 100) continue;
        const key = ph.dataset.lazy;
        ph.setAttribute('data-loading', '');
        ph.style.minHeight = '';
        ph.appendChild(document.getElementById('tpl-' + key + '-head').content.cloneNode(true));
        setTimeout(() => {
          ph.querySelector('[data-testid]').replaceChildren(document.getElementById('tpl-' + key + '-box').content.cloneNode(true));
        }, 250);
      }
    }
    main.addEventListener('scroll', check);
  </script>`;

  return `<!doctype html><html><head><meta charset="utf-8">
  <title>(3) ${esc(p.name)} | LinkedIn</title>
  <style>html,body{margin:0;height:100%;overflow:hidden;font-family:sans-serif}
    main{height:100vh;overflow-y:scroll} section{padding:8px 16px;border-bottom:1px solid #ddd}</style>
  </head><body><div id="app"><main id="workspace">
  ${topCard(p, owner)}
  ${aboutSection(p)}
  ${activitySection(p)}
  ${sections}
  <section><div><h2>People you may know</h2><p>Someone Else</p></div></section>
  </main></div>${lazyScript}</body></html>`;
}
