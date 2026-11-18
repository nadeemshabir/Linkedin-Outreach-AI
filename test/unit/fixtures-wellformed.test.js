// The test pages must be well-formed, or the scraper is tested on broken HTML.
// (A missing </div> once nested every job inside the previous one.)
import { describe, it, expect } from 'vitest';
import { profilePage } from '../fixtures/linkedin-2026.js';
import { PROFILES } from '../fixtures/profiles.js';

function balance(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<template[^>]*>|<\/template>/g, '');
  const stack = [];
  for (const [, close, tag] of body.matchAll(/<(\/?)(div|section|ul|li|a|p|span|button|main)\b[^>]*>/g)) {
    if (!close) { stack.push(tag); continue; }
    const open = stack.pop();
    if (open !== tag) return `</${tag}> closes <${open}>`;
  }
  return stack.length ? `unclosed: ${stack.join(', ')}` : 'ok';
}

describe('test pages are well-formed', () => {
  for (const p of PROFILES) {
    it(p.name, () => {
      expect(balance(profilePage(p, { owner: !!p.owner }))).toBe('ok');
      expect(balance(profilePage(p, { owner: !!p.owner, lazy: true }))).toBe('ok');
    });
  }
});
