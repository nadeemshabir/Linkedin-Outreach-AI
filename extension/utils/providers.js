'use strict';

// providers.js — the AI companies AI Mode can use, with the user's OWN key.
// One list for the background (which calls them) and the side panel (where
// you pick one, in Settings). Free Mode needs none of this.
//
// Each company keeps its own key, so you can switch back and forth without
// pasting it again. Anthropic's key keeps the name 3.1.0 gave it
// (userApiKey), so a key saved before there was a choice still works.
//
// Anthropic's API is in the manifest's host_permissions, as in 3.1.0.
// Google's and OpenAI's are optional_host_permissions: Chrome asks once, the
// first time you press Test or Save with that company picked. So the
// extension asks for nothing new at install, and an update is never
// switched off waiting for you to accept a new permission.
globalThis.Providers = globalThis.Providers || (() => {
  const LIST = [
    {
      id:          'anthropic',
      name:        'Anthropic (Claude)',  // in the Settings list
      company:     'Anthropic',
      writer:      'Claude',               // "Written by Claude."
      keyLabel:    'Anthropic API key',
      keyField:    'userApiKey',
      keyPage:     'console.anthropic.com',
      placeholder: 'sk-ant-…',
      host:        'api.anthropic.com',
      optional:    false,
    },
    {
      id:          'gemini',
      name:        'Google (Gemini)',
      company:     'Google',
      writer:      'Gemini',
      keyLabel:    'Gemini API key',
      keyField:    'geminiApiKey',
      keyPage:     'aistudio.google.com',
      placeholder: 'AIza…',
      host:        'generativelanguage.googleapis.com',
      optional:    true,
    },
    {
      id:          'openai',
      name:        'OpenAI (GPT)',
      company:     'OpenAI',
      writer:      'GPT',
      keyLabel:    'OpenAI API key',
      keyField:    'openaiApiKey',
      keyPage:     'platform.openai.com',
      placeholder: 'sk-…',
      host:        'api.openai.com',
      optional:    true,
    },
  ].map((p) => Object.freeze({ ...p, origin: `https://${p.host}/*` }));

  // Before there was a choice, AI Mode always used Anthropic.
  const DEFAULT = 'anthropic';
  const BY_ID = Object.fromEntries(LIST.map((p) => [p.id, p]));

  /** The provider with this id. Anything else (nothing saved yet, an old value) is Anthropic. */
  const get = (id) => BY_ID[id] || BY_ID[DEFAULT];

  /**
   * Whose key this looks like, from how it starts, or null when it is not
   * clear. Used so a key is never sent to the wrong company: an OpenAI key
   * pasted with Gemini picked is caught here, and never reaches Google.
   */
  function keyOwner(key) {
    const k = String(key || '').trim();
    if (/^sk-ant-/.test(k)) return 'anthropic';
    if (/^AIza/.test(k))    return 'gemini';
    if (/^sk-/.test(k))     return 'openai';
    return null;
  }

  const article = (word) => (/^[AEIOU]/.test(word) ? 'an' : 'a');

  /** The key in the box is another company's ("This looks like an OpenAI API key, but …"). */
  function wrongKeyText(ownerId, providerId) {
    const owner = get(ownerId);
    const picked = get(providerId);
    return `This looks like ${article(owner.keyLabel)} ${owner.keyLabel}, but the AI provider in Settings is ${picked.name}. ` +
      `Pick ${owner.name} there, or paste ${article(picked.keyLabel)} ${picked.keyLabel}.`;
  }

  /** Chrome has not let the extension reach this company's API (yet). */
  function noAccessText(providerId) {
    const p = get(providerId);
    return `Chrome has not allowed the extension to reach ${p.company} (${p.host}) yet. ` +
      'Press Test in Settings and choose Allow, or remove the key to use Free Mode.';
  }

  // keyStatus (the header's "AI Mode", "Key not working"…) says which
  // company's key it is about. For Anthropic it says nothing: every status
  // saved before there was a choice is about an Anthropic key, and keeps its
  // shape.
  const tagStatus = (status, providerId) => (get(providerId).id === DEFAULT ? status : { ...status, provider: get(providerId).id });
  const statusProvider = (status) => get(status && status.provider).id;

  return {
    LIST,
    DEFAULT,
    KEY_FIELDS: LIST.map((p) => p.keyField),
    get,
    keyOwner,
    wrongKeyText,
    noAccessText,
    tagStatus,
    statusProvider,
  };
})();
