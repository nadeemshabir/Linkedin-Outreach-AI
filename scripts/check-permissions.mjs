// Fails if the manifest asks for anything that shows a warning at install.
//
// Why it matters: when an update adds a permission with a warning, Chrome
// turns the extension OFF for every existing user until they accept it.
// For a tool students rely on, that is an outage. So this runs in CI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));

// Permissions Chrome grants without any install warning.
const NO_WARNING = new Set(['activeTab', 'storage', 'scripting', 'sidePanel', 'alarms']);
// Host access that 3.1.0 already has (users accept it there): LinkedIn,
// and Anthropic's API for AI Mode with the user's own key.
const HOSTS = new Set(['https://www.linkedin.com/*', 'https://api.anthropic.com/*']);
// Optional host access shows no install warning: Chrome asks only when the
// user picks that AI company in Settings (Google's Gemini, OpenAI). Still
// listed here, so a new one is added on purpose.
const OPTIONAL_HOSTS = new Set(['https://generativelanguage.googleapis.com/*', 'https://api.openai.com/*']);

// Content-script match patterns give host access too (and the same warning).
const MATCHES = (manifest.content_scripts || []).flatMap((cs) => cs.matches || []);

const problems = [
  ...(manifest.permissions || []).filter((p) => !NO_WARNING.has(p)).map((p) => `permission "${p}" shows an install warning`),
  ...(manifest.host_permissions || []).filter((h) => !HOSTS.has(h)).map((h) => `new host access "${h}" shows an install warning`),
  ...MATCHES.filter((m) => !HOSTS.has(m)).map((m) => `content script on "${m}" gives new host access (install warning)`),
  ...(manifest.optional_host_permissions || []).filter((h) => !OPTIONAL_HOSTS.has(h)).map((h) => `optional host access "${h}" is not one of the AI providers' APIs`),
  ...(manifest.optional_permissions || []).map((p) => `optional permission "${p}" is not expected`),
];

if (problems.length) {
  console.error('✗ Manifest would show new install warnings:\n  - ' + problems.join('\n  - '));
  console.error('Existing users would have the extension switched off until they accept. Remove it, or make it optional.');
  process.exit(1);
}
console.log(`✓ No new install warnings (${manifest.permissions.join(', ')}). Optional, asked when picked: ${(manifest.optional_host_permissions || []).join(', ') || 'none'}.`);
