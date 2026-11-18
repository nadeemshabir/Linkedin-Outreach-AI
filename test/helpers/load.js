// Helpers to run the extension's classic (non-module) scripts inside tests.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const EXT = path.join(ROOT, 'extension');

export const read = (rel) => fs.readFileSync(path.join(EXT, rel), 'utf8');

/**
 * Run scripts in a fresh, isolated context (like a service worker).
 * Several files share one global scope, the way classic scripts do.
 */
export function runIsolated(files, globals) {
  const context = vm.createContext({ console, ...globals });
  for (const f of [].concat(files)) {
    vm.runInContext(read(f), context, { filename: f });
  }
  return context;
}

/**
 * Run scripts in the test's own global scope (the happy-dom window),
 * like <script> tags on a page. The files are joined so top-level
 * declarations are shared between them, as in a real page.
 */
export function runInPage(files) {
  const code = [].concat(files).map(read).join('\n;\n');
  (0, eval)(code);
}

/** Load an extension HTML page's <body> markup into the happy-dom document. */
export function loadPageBody(htmlFile) {
  const html = read(htmlFile);
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script[\s\S]*?<\/script>/gi, '');
  document.body.innerHTML = body;
}

export function fixture(name) {
  return fs.readFileSync(path.join(ROOT, 'test', 'fixtures', name), 'utf8');
}
