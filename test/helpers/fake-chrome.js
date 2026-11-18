// A small in-memory stand-in for the chrome.* extension APIs.
// Good enough to run the extension's scripts in unit tests.
import { vi } from 'vitest';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function makeEvent() {
  const fns = [];
  return {
    fns,
    addListener: (fn) => fns.push(fn),
    removeListener: (fn) => { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
    hasListener: (fn) => fns.includes(fn),
  };
}

function makeStorageArea(data, areaName, onChanged) {
  return {
    data,
    get(keys, cb) {
      let out = {};
      if (keys == null) out = clone(data);
      else if (typeof keys === 'string') { if (keys in data) out[keys] = clone(data[keys]); }
      else if (Array.isArray(keys)) keys.forEach((k) => { if (k in data) out[k] = clone(data[k]); });
      else Object.entries(keys).forEach(([k, def]) => { out[k] = k in data ? clone(data[k]) : def; });
      if (cb) { queueMicrotask(() => cb(out)); return undefined; }
      return Promise.resolve(out);
    },
    set(obj, cb) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: clone(data[k]), newValue: clone(v) };
        data[k] = clone(v);
      }
      onChanged.fns.forEach((fn) => fn(changes, areaName));
      if (cb) { queueMicrotask(cb); return undefined; }
      return Promise.resolve();
    },
    remove(keys, cb) {
      const changes = {};
      [].concat(keys).forEach((k) => {
        if (k in data) { changes[k] = { oldValue: clone(data[k]) }; delete data[k]; }
      });
      onChanged.fns.forEach((fn) => fn(changes, areaName));
      if (cb) { queueMicrotask(cb); return undefined; }
      return Promise.resolve();
    },
  };
}

/**
 * @param {object} opts
 * @param {object} [opts.local]   initial chrome.storage.local data
 * @param {object} [opts.session] initial chrome.storage.session data
 * @param {Array}  [opts.tabs]    what chrome.tabs.query returns
 */
export function createFakeChrome({ local = {}, session = {}, tabs = [] } = {}) {
  const onMessage = makeEvent();
  const onChanged = makeEvent();

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: undefined,
      onMessage,
      onInstalled: makeEvent(),
      onStartup: makeEvent(),
      getURL: (p) => `chrome-extension://test-extension-id/${p}`,
      // Replace in a test to fake answers from another extension context.
      sendMessage: vi.fn(),
    },
    storage: {
      local: makeStorageArea(local, 'local', onChanged),
      session: makeStorageArea(session, 'session', onChanged),
      onChanged,
    },
    tabs: {
      query: vi.fn(async () => tabs),
      sendMessage: vi.fn(),
      onUpdated: makeEvent(),
      onActivated: makeEvent(),
      onRemoved: makeEvent(),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      setPopup: vi.fn(async () => {}),
    },
    sidePanel: {
      setPanelBehavior: vi.fn(async () => {}),
      setOptions: vi.fn(async () => {}),
      open: vi.fn(async () => {}),
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      onAlarm: makeEvent(),
    },
  };

  /**
   * Deliver a message to this context's runtime.onMessage listeners,
   * the way Chrome would deliver one from another context.
   * Resolves with whatever the listener passes to sendResponse.
   */
  function dispatchMessage(message, sender = { id: chrome.runtime.id }) {
    return new Promise((resolve) => {
      let async = false;
      for (const fn of onMessage.fns) {
        const ret = fn(message, sender, resolve);
        if (ret === true) async = true;
      }
      if (!async) resolve(undefined);
    });
  }

  return { chrome, dispatchMessage };
}
