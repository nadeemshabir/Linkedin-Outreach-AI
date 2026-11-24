// A fake browser for tests. The REAL background and the REAL side panel talk
// to each other through a fake chrome.* API, the way they do in Chrome.
// LinkedIn pages and the AI companies' APIs (AI Mode: Anthropic, Google's
// Gemini, OpenAI) are fakes each test controls. With no key in storage,
// everything runs in Free Mode and nothing is fetched at all.
import { vi } from 'vitest';
import { Window } from 'happy-dom';
import { createFakeChrome, INSTALL_HOSTS } from './fake-chrome.js';
import { runIsolated, read, pageScripts } from './load.js';

export const ANTHROPIC = 'https://api.anthropic.com';
export const GEMINI    = 'https://generativelanguage.googleapis.com';
export const OPENAI    = 'https://api.openai.com';
export const API_KEY    = 'sk-ant-test-0000';         // fake Anthropic key, for AI Mode tests
export const GEMINI_KEY = 'AIza-test-gemini-0000';    // fake Gemini key
export const OPENAI_KEY = 'sk-proj-test-openai-0000'; // fake OpenAI key
// The optional host access Google and OpenAI need (Chrome asks for it once).
export const GEMINI_ORIGIN = `${GEMINI}/*`;
export const OPENAI_ORIGIN = `${OPENAI}/*`;
export { INSTALL_HOSTS };
export const RUNNING   = ['reading', 'enriching', 'writing'];

/** A successful Messages API answer with this text. */
export function claudeReply(text, extra = {}) {
  return [200, {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
    content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, ...extra,
  }];
}

/** The text of the (last) user message in a Messages API request body. */
export function promptText(body) {
  const content = body && body.messages && body.messages[body.messages.length - 1].content;
  if (typeof content === 'string') return content;
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

/** A successful Gemini generateContent answer with this text. */
export function geminiReply(text, extra = {}) {
  return [200, {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
    modelVersion: 'gemini-3.5-flash-lite', ...extra,
  }];
}

/** The text of the (last) user turn in a Gemini request body. */
export function geminiPromptText(body) {
  const turn = body && body.contents && body.contents[body.contents.length - 1];
  return ((turn && turn.parts) || []).filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n');
}

/** A successful OpenAI Chat Completions answer with this text. */
export function openaiReply(text, extra = {}) {
  return [200, {
    id: 'chatcmpl-test', object: 'chat.completion', model: 'gpt-6-luna',
    choices: [{ index: 0, message: { role: 'assistant', content: text, refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }, ...extra,
  }];
}

/** The text of the (last) user message in an OpenAI request body. */
export function openaiPromptText(body) {
  const user = ((body && body.messages) || []).filter((m) => m.role === 'user');
  const content = user.length ? user[user.length - 1].content : '';
  if (typeof content === 'string') return content;
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// The default fakes: "OK" for the key test, else a short note to the first
// name found in the prompt's profile.
function writeBack(text) {
  if (/Reply with the single word: OK/.test(text)) return 'OK';
  const name = (text.match(/"name":\s*"([^"]+)"/) || [])[1] || 'there';
  return `Hi ${name.split(' ')[0]}! Would you be open to a quick chat?`;
}
const defaultClaude = (body) => claudeReply(writeBack(promptText(body)));
const defaultGemini = (body) => geminiReply(writeBack(geminiPromptText(body)));
const defaultOpenAI = (body) => openaiReply(writeBack(openaiPromptText(body)));

export function person(slug, name, extra = {}) {
  return {
    name,
    headline: `${name}'s headline`,
    currentCompany: 'Spotify',
    profileUrl: `https://www.linkedin.com/in/${slug}/`,
    ...extra,
  };
}

const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

/**
 * @param {object}   o
 * @param {object}   [o.local]    initial chrome.storage.local
 * @param {object}   [o.session]  initial chrome.storage.session
 * @param {Array}    [o.tabs]     [{ id, url, active }]
 * @param {object}   [o.pages]    tabId → profile the content script returns
 * @param {object}   [o.pagesByUrl] url → profile, used when a tab navigates there
 * @param {Function} [o.claude]   Anthropic fake: (body, path) → [status, json] | Response | 'hang'
 * @param {Function} [o.gemini]   Google's Gemini fake, the same way
 * @param {Function} [o.openai]   OpenAI fake, the same way
 * @param {Array}    [o.granted]  host access the extension has (default: the manifest's
 *                                host_permissions, so Google and OpenAI are not allowed yet)
 */
export function createWorld({
  local = {}, session = {}, tabs = [], pages = {}, pagesByUrl = {},
  claude = defaultClaude, gemini = defaultGemini, openai = defaultOpenAI, granted = INSTALL_HOSTS,
} = {}) {
  const { chrome, dispatchMessage } = createFakeChrome({ local, session, tabs, granted });

  chrome.tabs.query.mockImplementation(async (q = {}) =>
    tabs.filter((t) => (q.active ? t.active : true)).map((t) => ({ ...t })));

  // The content script on each LinkedIn tab.
  chrome.tabs.sendMessage.mockImplementation(async (tabId, msg) => {
    const page = pages[tabId];
    if (!page) throw new Error('Could not establish connection. Receiving end does not exist.');
    if (msg.action === 'scrapeProfile') return { success: true, data: { ...page } };
    if (msg.action === 'peekProfile') {
      return {
        success: true,
        data: { name: page.name, headline: page.headline, profileUrl: page.profileUrl, relationship: page.relationship || 'none' },
      };
    }
    return undefined;
  });

  // Messages from the panel go to the background, as in Chrome.
  chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
    const reply = dispatchMessage(msg);
    if (cb) { reply.then((r) => cb(r)); return undefined; }
    return reply;
  });

  // The AI companies' APIs (AI Mode only). Nothing else may be fetched.
  // Each call is kept as { api, url, path, body, headers }.
  const apis = [[ANTHROPIC, 'anthropic', claude], [GEMINI, 'gemini', gemini], [OPENAI, 'openai', openai]];
  const calls = [];
  const fetch = vi.fn(async (url, init = {}) => {
    const api = apis.find(([base]) => String(url).startsWith(`${base}/`));
    if (!api) throw new Error(`Unexpected fetch: ${url}`);
    const [base, name, answer] = api;
    const path = url.replace(base, '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ api: name, url, path, body, headers: { ...(init.headers || {}) } });
    const out = await answer(body, path);
    if (out === 'hang') {
      return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(abortError())));
    }
    if (out instanceof Response) return out;
    const [status, json] = out;
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  });

  runIsolated('background.js', {
    chrome, fetch, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, Response,
  });

  function navigate(tabId, url, page) {
    const tab = tabs.find((t) => t.id === tabId);
    tab.url = url;
    pages[tabId] = page || pagesByUrl[url] || pages[tabId];
    chrome.tabs.onUpdated.fns.forEach((fn) => fn(tabId, { url }, { ...tab }));
  }
  // chrome.tabs.update({ url }) navigates the tab, as in Chrome.
  chrome.tabs.update.mockImplementation(async (tabId, { url } = {}) => { if (url) navigate(tabId, url); });

  return {
    chrome,
    fetch,
    calls,
    tabs,
    pages,
    /** The user clicks another browser tab. */
    activate(tabId) {
      tabs.forEach((t) => { t.active = t.id === tabId; });
      chrome.tabs.onActivated.fns.forEach((fn) => fn({ tabId }));
    },
    /** LinkedIn moves to another page inside the same tab, without a reload. */
    navigate,
    async job(profileKey) {
      const id = `job:${profileKey}`;
      return (await chrome.storage.session.get(id))[id] || null;
    },
    /** Everyone in the tracker, most recent first. */
    async recent() {
      const { contacts = {} } = await chrome.storage.local.get('contacts');
      return Object.values(contacts).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    /** Start a job straight from the background, with no panel open. */
    start(payload) {
      return dispatchMessage({ type: 'START_JOB', payload });
    },
    /** The "✨ Write" button inside LinkedIn's box on tab `tabId` asks the background. */
    inpage(payload, tabId = 1) {
      const tab = tabs.find((t) => t.id === tabId);
      return dispatchMessage({ type: 'INPAGE_WRITE', payload }, { id: chrome.runtime.id, tab: { ...tab } });
    },
    /** How many times the background read (scrolled) the page in tab `tabId`. */
    scrapes(tabId = 1) {
      return chrome.tabs.sendMessage.mock.calls.filter(([id, m]) => id === tabId && m.action === 'scrapeProfile').length;
    },
  };
}

/**
 * Open the real side panel page (sidepanel.html + its scripts) in this world.
 * Each panel gets its own document and its own timers, like a real page, so
 * panels from earlier tests can never draw into this one. close() stops all
 * of this panel's listeners and timers, the way closing the panel would.
 */
export async function openPanel(world, { url = 'chrome-extension://test-extension-id/sidepanel.html' } = {}) {
  const win = new Window({ url });
  const doc = win.document;
  const html = read('sidepanel.html');
  doc.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script[\s\S]*?<\/script>/gi, '');

  const timers = new Set();
  const own = {
    setTimeout: (fn, ms, ...args) => {
      const id = setTimeout(() => { timers.delete(id); fn(...args); }, ms);
      timers.add(id);
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: (fn, ms, ...args) => { const id = setInterval(fn, ms, ...args); timers.add(id); return id; },
    clearInterval: (id) => { timers.delete(id); clearInterval(id); },
  };
  const navigator = { clipboard: { writeText: vi.fn(async () => {}) } };

  const events = [
    world.chrome.storage.onChanged, world.chrome.tabs.onActivated, world.chrome.tabs.onUpdated,
    world.chrome.permissions.onAdded, world.chrome.permissions.onRemoved,
  ];
  const before = events.map((e) => e.fns.length);

  // A click or key press is a user action while it is handled, as in Chrome:
  // chrome.permissions.request() works only then. It ends with the handler's
  // first `await` (the reset below runs before any code after it).
  const permissions = world.chrome.permissions;
  const userAction = () => {
    permissions.gesture = true;
    queueMicrotask(() => { permissions.gesture = false; });
  };
  win.addEventListener('click', userAction, true);
  win.addEventListener('keydown', userAction, true);

  // The page's scripts boot on DOMContentLoaded: capture that handler.
  let boot;
  const realAdd = doc.addEventListener.bind(doc);
  doc.addEventListener = (type, fn, opts) => (type === 'DOMContentLoaded' ? (boot = fn) : realAdd(type, fn, opts));
  const code = pageScripts('sidepanel.html').map(read).join('\n;\n');
  // eslint-disable-next-line no-new-func
  new Function(
    'document', 'window', 'location', 'navigator', 'chrome',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'FileReader',
    code,
  )(doc, win, win.location, navigator, world.chrome,
    own.setTimeout, own.clearTimeout, own.setInterval, own.clearInterval, win.FileReader);
  doc.addEventListener = realAdd;

  const added = [];
  await boot();
  events.forEach((e, i) => added.push(e.fns.slice(before[i])));
  await settle();

  return {
    window: win,
    document: doc,
    navigator,
    $: (id) => doc.getElementById(id),
    close() {
      events.forEach((e, i) => added[i].forEach((fn) => e.removeListener(fn)));
      timers.forEach((id) => { clearTimeout(id); clearInterval(id); });
      timers.clear();
    },
  };
}

/** Let pending promises and 0ms timers run. */
export async function settle(times = 10) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Wait until check() returns something truthy (polls with real timers). */
export async function until(check, { timeout = 3000, interval = 5 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`until(): not true after ${timeout}ms: ${check}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Fire a DOM event using the element's own window (each panel has one). */
export function fire(el, type) {
  const W = el.ownerDocument.defaultView;
  el.dispatchEvent(new W.Event(type, { bubbles: true }));
}

export function type(el, text) {
  el.value = text;
  fire(el, 'input');
}

export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
