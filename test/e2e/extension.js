// Playwright fixtures that load the real, unpacked extension into Chromium.
// Nothing leaves the machine:
//   - LinkedIn pages are local test pages, served by Playwright's request
//     routing
//   - AI Mode talks to a fake of Anthropic's Messages API (fakeClaude), set
//     up by each test that needs it
//   - every other request is blocked, and its URL is kept in `blocked`, so a
//     Free Mode test can check that nothing even tried to leave
import { test as base, chromium, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const EXTENSION_DIR = path.join(ROOT, 'extension');
export const ANTHROPIC = 'https://api.anthropic.com';
export const API_KEY = 'sk-ant-test-0000'; // fake, for AI Mode tests. Never a real key.

export const test = base.extend({
  // The URLs of the requests the block rule stopped, in this test.
  // eslint-disable-next-line no-empty-pattern
  blocked: async ({}, use) => {
    await use([]);
  },

  context: async ({ blocked }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', // new headless mode, which supports extensions
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    // Block anything that would leave the machine, unless a test routes it.
    // (A route added later wins, so a test's own routes come first.)
    await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => {
      blocked.push(route.request().url());
      return route.abort();
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
});

/** Serve a local HTML file (or string) at a LinkedIn URL. */
export async function serveLinkedInPage(context, url, htmlOrFixture) {
  const body = htmlOrFixture.trim().startsWith('<')
    ? htmlOrFixture
    : fs.readFileSync(path.join(ROOT, 'test', 'fixtures', htmlOrFixture), 'utf8');
  await context.route(url, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body }));
}

// ─── A fake of Anthropic's Messages API (AI Mode) ────────────────────────────

/** A Messages API reply with this text, in the shape Anthropic sends. */
export function claudeReply(text, extra = {}) {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 }, ...extra,
  };
}

/** The text of the user's message in a Messages API request body. */
export function promptText(body) {
  const content = body && body.messages && body.messages[body.messages.length - 1].content;
  if (typeof content === 'string') return content;
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

/**
 * Answers POST https://api.anthropic.com/v1/messages with the text that
 * write(body) returns. If write(body) returns { status, error } instead,
 * the answer is that error, in the shape Anthropic sends:
 *   { status: 400, error: { type: 'invalid_request_error', message: '…' } }
 * Every request is kept in `calls` as { method, path, headers, body }.
 * With { hold: true }, answers wait until release() is called.
 */
export async function fakeClaude(context, write, { hold = false } = {}) {
  const calls = [];
  let release = () => {};
  const gate = hold ? new Promise((resolve) => { release = resolve; }) : null;
  await context.route(`${ANTHROPIC}/**`, async (route) => {
    const req = route.request();
    const call = { method: req.method(), path: new URL(req.url()).pathname, headers: await req.allHeaders(), body: req.postDataJSON() };
    calls.push(call);
    if (call.method !== 'POST' || call.path !== '/v1/messages') {
      const error = { type: 'error', error: { type: 'not_found_error', message: 'Not found' } };
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify(error) });
      return;
    }
    if (gate) await gate;
    const answer = write(call.body);
    if (answer && typeof answer === 'object') {
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: answer.error }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(claudeReply(answer)) });
  });
  return { calls, release: () => release() };
}

export { expect };
