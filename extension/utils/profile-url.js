'use strict';

// Turns any LinkedIn URL into a stable ID for one person: "/in/<slug>/".
// Returns null when the page is not a member profile.
//   https://www.linkedin.com/in/Aoife-Murphy/details/experience/?x=1  →  /in/aoife-murphy/

const ProfileUrl = (() => {
  function key(url) {
    if (!url) return null;
    let u;
    try { u = new URL(url); } catch (_) { return null; }
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/in\/([^/]+)/i);
    if (!m) return null;
    let slug = m[1];
    try { slug = decodeURIComponent(slug); } catch (_) { /* keep as is */ }
    return `/in/${slug.toLowerCase()}/`;
  }

  function canonical(profileKey) {
    return profileKey ? `https://www.linkedin.com${encodeURI(profileKey)}` : '';
  }

  return { key, canonical };
})();
