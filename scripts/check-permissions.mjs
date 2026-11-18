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
// Host access that v3.0.2 already had (users accepted it then).
const HOSTS = new Set(['https://www.linkedin.com/*', 'https://linkedin-extention-production.up.railway.app/*']);

const problems = [
  ...(manifest.permissions || []).filter((p) => !NO_WARNING.has(p)).map((p) => `permission "${p}" shows an install warning`),
  ...(manifest.host_permissions || []).filter((h) => !HOSTS.has(h)).map((h) => `new host access "${h}" shows an install warning`),
];

if (problems.length) {
  console.error('✗ Manifest would show new install warnings:\n  - ' + problems.join('\n  - '));
  console.error('Existing users would have the extension switched off until they accept. Remove it, or make it optional.');
  process.exit(1);
}
console.log(`✓ No new install warnings (${manifest.permissions.join(', ')}).`);
