'use strict';

// sidepanel.js — the extension's UI. It runs in Chrome's side panel (or as a
// popup where the Side Panel API is missing). It only draws state: the
// background does the work and saves every step, so closing this page never
// loses a message.

// ─── State ────────────────────────────────────────────────────────────────────
const IS_POPUP      = new URLSearchParams(location.search).get('mode') === 'popup';
const RUNNING_STEPS = ['reading', 'enriching', 'writing'];
const STEP_ORDER    = { quick: ['reading', 'writing'], deep: ['reading', 'enriching', 'writing'] };
const STALE_MS      = 60 * 1000; // no heartbeat for this long = the run died
const STEP_TEXT     = {
  reading:   'Reading the profile…',
  enriching: 'Finding talking points…',
  writing:   'Writing your message…'
};

let activeTabId    = null;
let profileKey     = null;   // "/in/<slug>/" of the active tab, or null
let job            = null;   // the background's job for this profile
let peek           = null;   // quick look at the profile (name, headline)
let shownMessageId = null;   // which generated message the textarea shows
let currentMode    = 'simple';
let currentChannel = 'note'; // where the message will be sent: 'note' | 'message'
let linkedinPlan   = 'free'; // decides the note limit: 200 (free) or 300 (premium)
let peekTimer      = null;
let fitUndo        = null;   // { text, summary, ok } after "Fit to 200", until the next edit
let myProfile      = null;   // your own LinkedIn profile, for common ground
let sender         = {};     // your name and bio, for the message check
let contact        = null;   // this person's entry in your tracker, if any
let trackerFilter  = 'all';
let failedTest     = null;   // { key, provider, reason, code }: the key Test last failed with (not saved yet)
// The AI company shown in Settings. Picking one applies at once (the next
// message is written by it); each company keeps its own key.
let shownProvider  = null;
let savedKeys      = {};     // provider id → the key saved for it
let keyDrafts      = {};     // provider id → what you typed in its key box, not saved (while another is shown)
// Test results that mean AI Mode cannot work with the key until you act (as
// in background.js). The header says which; the key itself may be fine.
const KEY_PROBLEMS   = ['auth', 'billing', 'spend_limit', 'bad_key', 'model', 'region'];
const INVALID_LABELS = {
  billing: 'Billing problem', spend_limit: 'Spend limit reached', model: 'AI Mode not available', region: 'AI Mode not available',
  // Seen without asking anyone: a key that is another company's, and no OK from Chrome (yet) to reach Google or OpenAI.
  wrong_provider: 'Wrong provider', permission: 'Needs permission',
};
// The last 8 characters of a key: enough to tell keys apart, not enough to
// use one. (The same length as in background.js.)
const keyTail = (key) => String(key || '').trim().slice(-8);

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  document.documentElement.classList.add(IS_POPUP ? 'is-popup' : 'is-panel');
  initTabs();
  initModeToggle();
  initChannelToggle();
  wireSettingsEvents();
  wireCurrentEvents();
  wireRecentEvents();
  watchBrowser();
  await restoreChoices();
  ({ myProfile = null } = await storageGet(['myProfile']));
  sender = await storageGet(['userName', 'userBio']);
  await refreshActiveTab();
  await loadSettings();
  await renderTracker();
  await renderMode();
});

// ─── Free Mode or AI Mode, in the header ─────────────────────────────────────
// No key for the AI company you picked: Free Mode (a template, on this
// device, free). Your own key for it: AI Mode (its AI writes it). If the
// company refused that key last time, the badge says so, with the reason.
// So does a key that is another company's, and a company Chrome has not
// allowed the extension to reach yet. Nothing is checked over the network
// just to draw the badge.
async function renderMode() {
  const s        = await storageGet(['aiProvider', 'keyStatus', ...Providers.KEY_FIELDS]);
  const provider = Providers.get(s.aiProvider);
  const key      = String(s[provider.keyField] || '').trim();
  const owner    = Providers.keyOwner(key);
  let st;
  if (!key)                                     st = { state: 'free' };
  else if (owner && owner !== provider.id)      st = { state: 'invalid', code: 'wrong_provider', reason: Providers.wrongKeyText(owner, provider.id) };
  else if (!(await hasAccess(provider)))        st = { state: 'invalid', code: 'permission', reason: Providers.noAccessText(provider.id) };
  else if (isRefused(s.keyStatus, key, provider.id)) st = s.keyStatus;
  else                                          st = { state: 'ai' };
  renderKeyStatus(st, provider);
}

// The saved status says this key (for this company) was refused.
function isRefused(st, key, providerId) {
  return !!key && !!st && st.state === 'invalid' && st.keyTail === keyTail(key) && Providers.statusProvider(st) === providerId;
}

function renderKeyStatus(st, provider = Providers.get()) {
  const views = {
    free:    { text: '● Free Mode',     cls: 'free',     title: 'No key: messages are written from a template on this device, for free.' },
    ai:      { text: '● AI Mode',       cls: 'active',   title: `${provider.writer} writes the messages, with your own ${provider.company} key.` },
    invalid: { text: INVALID_LABELS[st.code] || 'Key not working', cls: 'inactive', title: '',
               warn: st.reason || `Your ${provider.keyLabel} was not accepted. Check it in Settings, or remove it to use Free Mode.` },
  };
  const view  = views[st.state] || views.free;
  const badge = document.getElementById('key-status');
  badge.textContent = view.text;
  badge.className   = `key-status ${view.cls}`;
  badge.title       = view.title;
  document.getElementById('no-key-warning').classList.toggle('hidden', !view.warn);
  if (view.warn) document.getElementById('key-warning-text').textContent = view.warn;
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
  if (name === 'recent') renderTracker();
}

// ─── Mode toggle ──────────────────────────────────────────────────────────────
function initModeToggle() {
  document.getElementById('mode-simple').addEventListener('click', () => setMode('simple'));
  document.getElementById('mode-deep').addEventListener('click', () => setMode('deep'));
}

function setMode(mode) {
  currentMode = mode;
  for (const [id, m] of [['mode-simple', 'simple'], ['mode-deep', 'deep']]) {
    const btn = document.getElementById(id);
    btn.classList.toggle('active', mode === m);
    btn.setAttribute('aria-checked', String(mode === m));
  }
  document.getElementById('mode-hint').textContent = mode === 'deep'
    ? 'Shows the talking points it found first, then writes.'
    : 'Writes straight away.';
  renderJob();
}

// ─── Where the message goes: connection note or message ──────────────────────
// A note is hard-capped by LinkedIn (200 free / 300 Premium), and free plans
// get only a few notes a month. A message to a connection has no tight cap.
function initChannelToggle() {
  document.querySelectorAll('[data-channel]').forEach(btn => {
    btn.addEventListener('click', () => { setChannel(btn.dataset.channel); saveChoices(); });
  });
}

function setChannel(channel) {
  currentChannel = channel === 'message' ? 'message' : 'note';
  document.querySelectorAll('[data-channel]').forEach(btn => {
    const on = btn.dataset.channel === currentChannel;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', String(on));
  });
  renderChannelHint();
  updateCharCount();
}

async function renderChannelHint() {
  const el = document.getElementById('channel-hint');
  if (currentChannel === 'message') {
    el.textContent = 'For people you are already connected with. Short messages get more replies.';
    return;
  }
  if (linkedinPlan === 'premium') {
    el.textContent = 'Up to 300 characters on Premium.';
    return;
  }
  const used  = await notesUsedThisMonth();
  const total = Limits.FREE_NOTES_PER_MONTH;
  el.textContent = used < total - 1
    ? `Up to 200 characters. LinkedIn's free plan gives only a few notes a month (made here: ${used} of ~${total}).`
    : `Notes made here this month: ${used} of ~${total}. Running out? Connect without a note, then send a Message once they accept.`;
}

async function notesUsedThisMonth() {
  const { noteUsage } = await storageGet(['noteUsage']);
  return noteUsage && noteUsage.month === Limits.monthKey() ? noteUsage.profiles.length : 0;
}

// Counted when you copy (or insert) a note, once per person per month.
async function recordNoteUsed() {
  if (currentChannel !== 'note' || !profileKey) return;
  const month = Limits.monthKey();
  const { noteUsage } = await storageGet(['noteUsage']);
  const profiles = noteUsage && noteUsage.month === month ? noteUsage.profiles : [];
  if (!profiles.includes(profileKey)) await storageSet({ noteUsage: { month, profiles: [...profiles, profileKey] } });
  renderChannelHint();
}

// ─── Follow the browser ───────────────────────────────────────────────────────
// The panel stays open while you browse, so it follows the active tab and
// LinkedIn's in-page navigation, and redraws when the background saves progress.
function watchBrowser() {
  chrome.tabs.onActivated.addListener(() => refreshActiveTab());
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId === activeTabId && (info.url || info.status === 'complete')) refreshActiveTab();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    const id = profileKey && `job:${profileKey}`;
    if (area === 'session' && id && changes[id]) {
      job = changes[id].newValue || null;
      renderJob();
    }
    if (area === 'local' && (changes.keyStatus || changes.aiProvider || Providers.KEY_FIELDS.some(f => changes[f]))) renderMode();
    // The key worked (a run, or a Test elsewhere): forget its failed Test.
    const status = area === 'local' && changes.keyStatus && changes.keyStatus.newValue;
    if (status && status.state === 'ai' && failedTest && keyTail(failedTest.key) === status.keyTail
        && failedTest.provider === Providers.statusProvider(status)) failedTest = null;
    // Settings changed in another window's panel: show the new values, so a
    // Save here does not put the old ones back. (A box you are editing here
    // keeps your edit.)
    if (area === 'local' && changes.resumeForAI) document.getElementById('resume-for-ai').checked = changes.resumeForAI.newValue === true;
    if (area === 'local') {
      // Each company's own key. The key box shows the one for the company
      // picked here.
      for (const p of Providers.LIST) {
        const change = changes[p.keyField];
        if (!change) continue;
        savedKeys[p.id] = change.newValue || '';
        const box = document.getElementById('api-key');
        if (p.id === shownProvider && box.value.trim() === String(change.oldValue || '').trim()) box.value = change.newValue || '';
      }
      // Another window's panel picked another company: show it here too.
      const picked = changes.aiProvider && Providers.get(changes.aiProvider.newValue).id;
      if (picked && picked !== shownProvider) showProvider(picked);
      for (const [key, id] of [['userName', 'user-name'], ['userBio', 'user-bio']]) {
        if (!changes[key]) continue;
        const box = document.getElementById(id);
        if (box.value.trim() === String(changes[key].oldValue || '').trim()) box.value = changes[key].newValue || '';
      }
      const name = changes.resumeFileName && changes.resumeFileName.newValue;
      const label = name || 'Click to upload or drag PDF here';
      // (This panel's own Save or Remove already shows it.)
      if (changes.resumeFileName && !pendingResume && document.getElementById('file-label').textContent !== label) {
        document.getElementById('file-label').textContent = name || 'Click to upload or drag PDF here';
        document.getElementById('file-upload-area').classList.toggle('has-file', !!name);
        document.getElementById('remove-resume-btn').classList.toggle('hidden', !name);
        const statusEl = document.getElementById('resume-status');
        statusEl.textContent = name ? `${name} saved ✓` : '';
        statusEl.className   = name ? 'resume-status success' : 'resume-status hidden';
      }
    }
    if (area === 'local' && changes.contacts) onContactsChanged(changes.contacts.newValue || {});
    if (area === 'local' && changes.myProfile) {
      myProfile = changes.myProfile.newValue || null;
      renderMeStatus();
      renderCommonGround();
    }
    if (area === 'local' && (changes.userName || changes.userBio)) {
      if (changes.userName) sender.userName = changes.userName.newValue;
      if (changes.userBio)  sender.userBio  = changes.userBio.newValue;
      renderStrength();
    }
  });
  // You allowed (or took back) the extension's access to Google's or
  // OpenAI's API: in Chrome's prompt, or later in chrome://extensions.
  if (chrome.permissions && chrome.permissions.onAdded) {
    chrome.permissions.onAdded.addListener(() => renderMode());
    chrome.permissions.onRemoved.addListener(() => renderMode());
  }
  // A run whose worker died stops sending heartbeats. Check now and then.
  setInterval(() => { if (job && RUNNING_STEPS.includes(job.step)) renderJob(); }, 10000);
}

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab ? tab.id : null;
  const key   = tab ? ProfileUrl.key(tab.url) : null;
  document.getElementById('page-warning').classList.toggle('hidden', !!key);

  if (key !== profileKey) {
    profileKey     = key;
    peek           = null;
    shownMessageId = null;
    job            = key ? await loadJob(key) : null;
    if (key !== profileKey) return; // the user moved on while we were loading
    document.getElementById('goal').value = (job && job.goal) || '';
    document.getElementById('sent-prompt').classList.add('hidden');
    contact = key ? await Tracker.find(key) : null;
    if (job) {
      if (job.channel) setChannel(job.channel);
      setMode(job.mode === 'deep' ? 'deep' : 'simple');
    }
  }
  renderJob();
  renderTrackedBanner();
  renderMeStatus();
  if (key && !(job && job.profile)) peekActiveProfile(key);
  if (key) await applyIntent(key);
}

// "Write it" in the tracker opens the person's profile and leaves a note
// here, so the panel is ready for the follow-up when the page arrives.
async function applyIntent(key) {
  const { intent } = await chrome.storage.session.get('intent');
  if (!intent || intent.profileKey !== key) return;
  await chrome.storage.session.remove('intent');
  setChannel(intent.channel || 'message');
  document.getElementById('goal').value = intent.goal || '';
  showCurrentStatus('Ready for your next message. Check the goal, then press Generate.', 'success');
}

async function loadJob(key) {
  const id = `job:${key}`;
  return (await chrome.storage.session.get(id))[id] || null;
}

// Show who you are about to message straight away, before any generation.
function peekActiveProfile(key) {
  clearTimeout(peekTimer);
  peekTimer = setTimeout(async () => {
    const res = await sendMessage({ type: 'PEEK_PROFILE', payload: { tabId: activeTabId } });
    if (key !== profileKey || !res || !res.success || !res.data) return;
    if (ProfileUrl.key(res.data.profileUrl) !== key) return; // page not updated yet
    peek = res.data;
    renderJob();
  }, 250);
}

// ─── Generate ─────────────────────────────────────────────────────────────────
function wireCurrentEvents() {
  document.getElementById('generate-btn').addEventListener('click', () => handleGenerate());
  document.getElementById('regenerate-btn').addEventListener('click', () => handleGenerate({ regenerate: true }));
  document.getElementById('copy-btn').addEventListener('click', handleCopy);
  document.getElementById('fit-btn').addEventListener('click', handleFit);
  document.getElementById('undo-fit-btn').addEventListener('click', handleUndoFit);
  document.getElementById('mark-sent-btn').addEventListener('click', handleMarkSent);
  document.getElementById('tracked-status').addEventListener('change', (e) => {
    if (profileKey) Tracker.setStatus(profileKey, e.target.value);
  });
  document.getElementById('generated-message').addEventListener('input', () => {
    fitUndo = null; // a real edit ends the "just shortened" state
    handleMessageEdited();
  });
  document.getElementById('message-type').addEventListener('change', saveChoices);
  document.getElementById('tone').addEventListener('change', saveChoices);
}

async function handleGenerate({ regenerate = false } = {}) {
  if (!profileKey || isRunning(job)) return;

  // No key needed: without one, Free Mode writes from a template.
  setBusy(true);
  const res = await sendMessage({
    type: 'START_JOB',
    payload: {
      tabId:       activeTabId,
      mode:        currentMode === 'deep' ? 'deep' : 'quick',
      channel:     currentChannel,
      maxChars:    Limits.limitFor(currentChannel, linkedinPlan),
      messageType: document.getElementById('message-type').value,
      tone:        document.getElementById('tone').value,
      goal:        document.getElementById('goal').value.trim(),
      // Your picks among the "In common" chips. On a first run the
      // background picks the strong ones itself, after reading the profile.
      useCommonGround: regenerate && job ? job.useCommonGround : undefined,
      regenerate
    }
  });
  if (!res || !res.ok) {
    setBusy(false);
    showCurrentStatus((res && res.error) || 'Could not start. Please try again.', 'error');
  }
  // From here on, progress arrives through storage changes (see watchBrowser).
}

// Save the user's own edits, so Recent and a reopened panel show them.
function handleMessageEdited() {
  updateCharCount();
  if (!job || !job.messageId) return;
  const text = document.getElementById('generated-message').value;
  job = { ...job, editedMessage: text };
  chrome.storage.session.set({ [`job:${profileKey}`]: job });
  Tracker.updateMessage(profileKey, text);
}

// ─── Make it fit ──────────────────────────────────────────────────────────────
function handleFit() {
  const ta     = document.getElementById('generated-message');
  const limit  = Limits.limitFor(currentChannel, linkedinPlan);
  const before = ta.value;
  const r      = Limits.fitToLimit(before, limit);
  if (!r.changed) return;
  const n = r.removed.length;
  fitUndo = {
    text: before,
    ok: r.fits,
    summary: r.fits
      ? `Shortened from ${before.length} to ${r.text.length} by removing ${n} sentence${n === 1 ? '' : 's'}. Please read it once.`
      : `Still ${r.text.length - limit} over after removing ${n} sentence${n === 1 ? '' : 's'}. Edit it, or try New version.`
  };
  ta.value = r.text;
  handleMessageEdited();
}

function handleUndoFit() {
  if (!fitUndo) return;
  document.getElementById('generated-message').value = fitUndo.text;
  fitUndo = null;
  handleMessageEdited();
}

function renderFitRow(st) {
  const row  = document.getElementById('fit-row');
  const btn  = document.getElementById('fit-btn');
  const undo = document.getElementById('undo-fit-btn');
  const text = document.getElementById('fit-text');
  if (fitUndo) {
    row.className    = `fit-row${fitUndo.ok ? ' ok' : ''}`;
    text.textContent = fitUndo.summary;
    btn.classList.add('hidden');
    undo.classList.remove('hidden');
    return;
  }
  const show = st.hard && st.over;
  row.className = `fit-row${show ? '' : ' hidden'}`;
  if (!show) return;
  text.textContent = `${st.count - st.limit} characters over the ${st.limit} limit for a note.`;
  btn.textContent  = `Fit to ${st.limit}`;
  btn.classList.remove('hidden');
  undo.classList.add('hidden');
}

async function restoreChoices() {
  const { lastMessageType, lastTone, lastChannel, linkedinPlan: plan } =
    await storageGet(['lastMessageType', 'lastTone', 'lastChannel', 'linkedinPlan']);
  if (lastMessageType) document.getElementById('message-type').value = lastMessageType;
  if (lastTone)        document.getElementById('tone').value = lastTone;
  linkedinPlan = plan === 'premium' ? 'premium' : 'free';
  setChannel(lastChannel || 'note');
}

function saveChoices() {
  storageSet({
    lastMessageType: document.getElementById('message-type').value,
    lastTone:        document.getElementById('tone').value,
    lastChannel:     currentChannel
  });
}

// ─── Draw the job ─────────────────────────────────────────────────────────────
function isRunning(j) {
  if (!j || !RUNNING_STEPS.includes(j.step)) return false;
  const lastSign = j.heartbeatAt || j.updatedAt || j.startedAt || 0;
  return Date.now() - lastSign < STALE_MS;
}

function renderJob() {
  const busy   = isRunning(job);
  const stale  = !!job && RUNNING_STEPS.includes(job.step) && !busy;
  const person = (job && (job.profileJSON || job.profile)) || peek;

  if (profileKey && person) renderProfileCard(person); else hideProfileCard();
  renderCommonGround();
  renderSteps(stale);

  if (job && job.enrichmentJSON) renderHooks(job.enrichmentJSON); else hideHooks();

  if (job && job.message) {
    if (shownMessageId !== job.messageId) {
      shownMessageId = job.messageId;
      fitUndo = null;
      document.getElementById('sent-prompt').classList.add('hidden');
      renderMessage(job.editedMessage != null ? job.editedMessage : job.message);
    }
  } else {
    shownMessageId = null;
    hideMessage();
  }

  if (!profileKey || !job)       clearCurrentStatus();
  else if (busy)                 showCurrentStatus(STEP_TEXT[job.step]);
  else if (stale)                showCurrentStatus('This run was interrupted. Please try again.', 'error');
  else if (job.step === 'error') showCurrentStatus(job.error ? job.error.message : 'Something went wrong.', 'error');
  else if (job.step === 'done')  showCurrentStatus(doneText(job), 'success');
  else                           clearCurrentStatus();

  setBusy(busy);
}

function doneText(j) {
  const ai  = Providers.get(j.provider); // whose AI wrote it (Anthropic's, for runs from before the choice)
  const how = { free: ' Written in Free Mode.', ai: ` Written by ${ai.writer}.` }[j.writer] || '';
  const resume = j.resumeSkipped ? ` ${ai.company} could not read your resume PDF, so it was left out. Replace or remove it in Settings.` : '';
  return `Message ready.${how}${resume}`;
}

// Steps show progress while running, and where it failed. Once a run
// succeeds they get out of the way, so the message sits higher up.
function renderSteps(stale) {
  const mode = currentMode === 'deep' ? 'deep' : 'quick';
  const show = !!job && job.mode === mode && job.step !== 'done';
  document.getElementById('steps').classList.toggle('hidden', !show);
  document.getElementById('step-enriching').classList.toggle('hidden', mode !== 'deep');
  document.querySelector('#step-writing .layer-badge').textContent = mode === 'deep' ? '3' : '2';
  if (!show) return;

  const order  = STEP_ORDER[job.mode];
  const failed = job.step === 'error' || stale;
  const at     = job.step === 'done' ? order.length : order.indexOf(failed ? (job.failedStep || job.step) : job.step);
  order.forEach((step, i) => {
    if (i < at)        setStepStatus(step, 'done', 'Done');
    else if (i === at) setStepStatus(step, failed ? 'error' : 'running', failed ? 'Failed' : 'Working…');
    else               setStepStatus(step, '', '');
  });
}

function setStepStatus(step, state, text) {
  const row = document.getElementById(`step-${step}`);
  row.querySelector('.status-dot').className = `status-dot ${state}`;
  row.querySelector('.layer-status-text').textContent = text;
}

function setBusy(on) {
  document.getElementById('generate-btn').disabled = on || !profileKey;
  document.getElementById('generate-label').textContent = on ? 'Working…' : 'Generate message';
  document.getElementById('generate-spinner').classList.toggle('hidden', !on);
  document.getElementById('regenerate-btn').disabled = on;
  document.getElementById('generated-message').readOnly = on;
  document.getElementById('close-hint').classList.toggle('hidden', !on);
}

function renderHooks(enrichmentJSON) {
  const panel = document.getElementById('hooks-panel');
  const list  = document.getElementById('hooks-list');
  list.innerHTML = '';
  const hooks = enrichmentJSON.topHooks?.length
    ? enrichmentJSON.topHooks
    : (enrichmentJSON.companyNews || []).map(n => n.relevance || n.headline).filter(Boolean);
  if (!hooks.length) { hideHooks(); return; }
  hooks.slice(0, 3).forEach(hook => {
    const d = document.createElement('div');
    d.className   = 'hook-item';
    d.textContent = hook;
    list.appendChild(d);
  });
  panel.classList.remove('hidden');
}

function hideHooks() { document.getElementById('hooks-panel').classList.add('hidden'); }

// ─── Common ground ────────────────────────────────────────────────────────────
// Found by the background right after it reads the profile. Tap a chip to
// use it or skip it; "New version" then writes with your picks.
const CG_ICONS = { school: '🎓', company: '💼', city: '📍', country: '📍', roots: '🇮🇳', skills: '🛠' };

function renderCommonGround() {
  const box   = document.getElementById('common-ground');
  const tip   = document.getElementById('cg-tip');
  const items = (job && job.profile && job.commonGround) || null;
  tip.classList.toggle('hidden', !profileKey || !!myProfile);
  box.classList.toggle('hidden', !profileKey || !myProfile || !items);
  if (!items || !myProfile) return;

  const chips = document.getElementById('cg-chips');
  chips.innerHTML = '';
  const picked = new Set(job.useCommonGround || []);
  for (const item of items) {
    const chip = document.createElement('button');
    chip.className   = 'cg-chip';
    chip.textContent = `${CG_ICONS[item.kind] || ''} ${item.label.replace(/^You (?:both|are both) /, '')}`.trim();
    chip.title       = item.label;
    chip.setAttribute('aria-pressed', String(picked.has(item.hook)));
    chip.disabled    = isRunning(job);
    chip.addEventListener('click', () => toggleCommonGround(item.hook));
    chips.appendChild(chip);
  }
  document.getElementById('cg-none').classList.toggle('hidden', items.length > 0);
}

function toggleCommonGround(hook) {
  if (!job || isRunning(job)) return;
  const picked = new Set(job.useCommonGround || []);
  if (picked.has(hook)) picked.delete(hook); else picked.add(hook);
  job = { ...job, useCommonGround: [...picked] };
  chrome.storage.session.set({ [`job:${profileKey}`]: job });
  renderCommonGround();
  renderStrength();
}

// ─── Message check ────────────────────────────────────────────────────────────
function renderStrength() {
  const box = document.getElementById('strength');
  if (!job || !job.message) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  const result = Strength.check(document.getElementById('generated-message').value, {
    channel:      currentChannel,
    limit:        Limits.limitFor(currentChannel, linkedinPlan),
    them:         job.profileJSON ? { ...job.profile, ...job.profileJSON } : job.profile,
    me:           myProfile,
    bio:          sender.userBio,
    senderName:   sender.userName,
    hooks:        (job.enrichmentJSON && job.enrichmentJSON.topHooks) || [],
    commonGround: job.useCommonGround || [],
    goal:         job.goal
  });

  const score = document.getElementById('strength-score');
  score.textContent = { strong: 'Strong', good: 'Good', weak: 'Needs work' }[result.score];
  score.className   = `strength-score ${result.score}`;

  const list = document.getElementById('strength-list');
  list.innerHTML = '';
  for (const c of result.checks) {
    const li = document.createElement('li');
    li.className   = c.ok ? 'ok' : c.warn ? 'warn' : 'fail';
    li.textContent = c.label;
    if (!c.ok && c.tip) {
      const tip = document.createElement('span');
      tip.className   = 'tip';
      tip.textContent = c.tip;
      li.appendChild(tip);
    }
    list.appendChild(li);
  }
}

// ─── Your own profile (Settings) ──────────────────────────────────────────────
function renderMeStatus() {
  const status = document.getElementById('me-status');
  const remove = document.getElementById('remove-me-btn');
  const button = document.getElementById('import-me-btn');
  button.disabled = !profileKey;
  remove.classList.toggle('hidden', !myProfile);
  if (!myProfile) {
    status.textContent = 'Not added yet. Open your own LinkedIn profile, then click the button. It lets the extension find what you have in common with people.';
    button.textContent = "Use the profile I'm on";
    return;
  }
  const date = new Date(myProfile.importedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  status.innerHTML = '';
  const name = document.createElement('strong');
  name.textContent = myProfile.name || 'Your profile';
  status.append(name, ` · added ${date}. Saved only on this device.`);
  button.textContent = 'Update from the profile I\'m on';
}

async function handleImportMe() {
  const button = document.getElementById('import-me-btn');
  button.disabled    = true;
  button.textContent = 'Reading…';
  const res = await sendMessage({ type: 'IMPORT_MY_PROFILE', payload: { tabId: activeTabId } });
  renderMeStatus();
  showSettingsStatus(res && res.ok ? `Added: ${res.name}` : ((res && res.error) || 'Could not read the profile.'), res && res.ok ? 'success' : 'error');
}

async function handleRemoveMe() {
  await new Promise(resolve => chrome.storage.local.remove('myProfile', resolve));
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function wireSettingsEvents() {
  const providerList = document.getElementById('ai-provider');
  providerList.innerHTML = Providers.LIST.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  providerList.addEventListener('change', handleProviderChange);
  document.getElementById('show-key-btn').addEventListener('click', () => setKeyShown(document.getElementById('api-key').type === 'password'));
  document.getElementById('save-settings-btn').addEventListener('click', handleSaveSettings);
  document.getElementById('validate-btn').addEventListener('click', handleTestKey);
  document.getElementById('api-key').addEventListener('keydown', e => {
    // Not while a Test is running (results could come back out of order).
    if (e.key === 'Enter' && !document.getElementById('validate-btn').disabled) handleTestKey();
  });
  document.getElementById('import-me-btn').addEventListener('click', handleImportMe);
  document.getElementById('remove-me-btn').addEventListener('click', handleRemoveMe);
  document.getElementById('remove-resume-btn').addEventListener('click', handleRemoveResume);
  // Like Remove resume next to it, this applies at once (no Save needed):
  // unticking it must stop the resume being sent straight away.
  document.getElementById('resume-for-ai').addEventListener('change', handleResumeForAI);
  // The plan changes the note limit, so it applies at once (no Save needed).
  document.getElementById('linkedin-plan').addEventListener('change', async (e) => {
    linkedinPlan = e.target.value === 'premium' ? 'premium' : 'free';
    await storageSet({ linkedinPlan });
    renderChannelHint();
    updateCharCount();
  });

  // Resume upload
  const dropArea = document.getElementById('file-upload-area');
  dropArea.addEventListener('click', () => document.getElementById('resume-upload').click());
  dropArea.addEventListener('dragover', (e) => { e.preventDefault(); dropArea.classList.add('drag-over'); });
  dropArea.addEventListener('dragleave', () => dropArea.classList.remove('drag-over'));
  dropArea.addEventListener('drop', (e) => {
    e.preventDefault();
    dropArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) processResumeFile(file);
  });
  document.getElementById('resume-upload').addEventListener('change', (e) => {
    const file = e.target.files[0];
    // Empty the picker, so picking the same file again (after Remove) still works.
    e.target.value = '';
    if (file) processResumeFile(file);
  });
}

async function loadSettings() {
  const s = await loadStoredSettings();
  document.getElementById('linkedin-plan').value = linkedinPlan;
  renderMeStatus();
  for (const p of Providers.LIST) savedKeys[p.id] = s[p.keyField] || '';
  shownProvider = null; // fill the key box from what is saved, even if a change already showed this company
  showProvider(Providers.get(s.aiProvider).id);
  if (s.userName)   document.getElementById('user-name').value   = s.userName;
  if (s.userBio)    document.getElementById('user-bio').value    = s.userBio;
  // Off unless you turned it on here (a resume kept from 3.1.0 was never
  // sent anywhere, so it is not sent now either until you say yes).
  document.getElementById('resume-for-ai').checked = s.resumeForAI === true;
  if (s.resumeFileName) {
    document.getElementById('file-label').textContent = s.resumeFileName;
    document.getElementById('file-upload-area').classList.add('has-file');
    const statusEl = document.getElementById('resume-status');
    statusEl.textContent = `${s.resumeFileName} saved ✓`;
    statusEl.className   = 'resume-status success';
    statusEl.classList.remove('hidden');
    document.getElementById('remove-resume-btn').classList.remove('hidden');
  }
}

// ─── The AI company (AI Mode) ────────────────────────────────────────────────
// Picking one applies at once, like the LinkedIn plan: the next message is
// written by its AI, with the key saved for it. Each company keeps its own
// key, so switching back and forth never loses one.
async function handleProviderChange(e) {
  const id = Providers.get(e.target.value).id;
  showProvider(id);
  await storageSet({ aiProvider: id });
}

// Show this company in Settings: its saved key (or what you typed for it
// and did not save), its words, and the key hidden again.
function showProvider(id) {
  const provider = Providers.get(id);
  const box = document.getElementById('api-key');
  if (shownProvider !== provider.id) {
    if (shownProvider) {
      // Keep what you typed for the company you leave, while it is not saved.
      if (box.value.trim() !== String(savedKeys[shownProvider] || '').trim()) keyDrafts[shownProvider] = box.value;
      else delete keyDrafts[shownProvider];
    }
    box.value = provider.id in keyDrafts ? keyDrafts[provider.id] : (savedKeys[provider.id] || '');
    delete keyDrafts[provider.id];
    // An old Test result is about another company's key.
    document.getElementById('key-validation-status').classList.add('hidden');
  }
  shownProvider = provider.id;
  document.getElementById('ai-provider').value = provider.id;
  document.getElementById('api-key-label').textContent = `${provider.keyLabel} (optional)`;
  box.placeholder = provider.placeholder;
  document.getElementById('key-hint').textContent = keyHint(provider);
  setKeyShown(false);
  // "It is sent to Google…", "…so Gemini can say…", "AI Mode: by Gemini".
  document.querySelectorAll('.ai-company').forEach(el => { el.textContent = provider.company; });
  document.querySelectorAll('.ai-writer').forEach(el => { el.textContent = provider.writer; });
}

function keyHint(p) {
  const ask = p.optional ? ` The first time you press Test or Save, Chrome asks you to let the extension reach ${p.host}.` : '';
  return `Get a key at ${p.keyPage}. It is kept only on this device, hidden like a password, and sent only to ${p.company}.${ask}`;
}

// The key is hidden like a password. "Show" lets you check what you pasted.
function setKeyShown(show) {
  const box = document.getElementById('api-key');
  const btn = document.getElementById('show-key-btn');
  box.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Hide' : 'Show';
  btn.setAttribute('aria-pressed', String(show));
  btn.setAttribute('aria-label', show ? 'Hide the key' : 'Show the key');
}

// Google's and OpenAI's APIs are optional in the manifest: Chrome asks you
// once. Anthropic's was allowed at install, as in 3.1.0.
async function hasAccess(provider) {
  if (!provider.optional) return true;
  try {
    return await chrome.permissions.contains({ origins: [provider.origin] });
  } catch (_) {
    return false;
  }
}

// Asks Chrome for access to this company's API. Call it straight from your
// click, before any await: Chrome shows its prompt only during a user
// action. Allowed already: true at once, with no prompt. Never rejects.
function requestAccess(provider) {
  if (!provider.optional) return Promise.resolve(true);
  try {
    return Promise.resolve(chrome.permissions.request({ origins: [provider.origin] })).then(Boolean, () => false);
  } catch (_) {
    return Promise.resolve(false);
  }
}

const notAllowedText = (p) => `Chrome did not allow the extension to reach ${p.company} (${p.host})`;

async function handleSaveSettings() {
  const provider   = Providers.get(document.getElementById('ai-provider').value);
  const userApiKey = document.getElementById('api-key').value.trim(); // keys are case-sensitive
  const userName   = document.getElementById('user-name').value.trim();
  const userBio    = document.getElementById('user-bio').value.trim();
  // A key that is another company's is saved as you typed it, but never
  // sent anywhere: the header says why.
  const owner    = Providers.keyOwner(userApiKey);
  const wrongKey = !!userApiKey && !!owner && owner !== provider.id;
  // Google or OpenAI: ask Chrome now, while this click still counts as yours.
  const access = userApiKey && !wrongKey && provider.optional ? requestAccess(provider) : null;

  const savePayload = { [provider.keyField]: userApiKey, userName, userBio };
  if (pendingResume) {
    // A new file is saved with the box's choice for it. (For a resume that
    // is already saved, the box saves itself, so Save leaves it alone: an
    // older panel in another window must not turn it back on.)
    savePayload.resumeBase64   = pendingResume.base64;
    savePayload.resumeFileName = pendingResume.fileName;
    savePayload.resumeForAI    = document.getElementById('resume-for-ai').checked;
    pendingResume = null;
    const statusEl = document.getElementById('resume-status');
    statusEl.textContent = 'Resume saved ✓';
    statusEl.className   = 'resume-status success';
    document.getElementById('remove-resume-btn').classList.remove('hidden');
  }
  await new Promise(resolve => chrome.storage.local.set(savePayload, resolve));
  // An empty key field means Free Mode: forget what was known about the old key.
  if (!userApiKey) await new Promise(resolve => chrome.storage.local.remove('keyStatus', resolve));
  // You pressed Test, it failed, and now you save that same key: the header
  // must not say "AI Mode" as if it works. Used once: from now on keyStatus
  // keeps it, and the background clears it when the key works.
  if (userApiKey && failedTest && failedTest.key === userApiKey && failedTest.provider === provider.id) {
    await storageSet({ keyStatus: Providers.tagStatus({ state: 'invalid', keyTail: keyTail(userApiKey), reason: failedTest.reason, code: failedTest.code, checkedAt: Date.now() }, provider.id) });
  }
  failedTest = null;
  setKeyShown(false);

  // An old "Test" result may not be true any more.
  document.getElementById('key-validation-status').classList.add('hidden');
  const allowed = access ? await access : true;
  const { keyStatus } = await storageGet(['keyStatus']);
  const stillRefused = isRefused(keyStatus, userApiKey, provider.id);
  if (!userApiKey)       showSettingsStatus('Settings saved! Free Mode is on (no key).', 'success');
  else if (wrongKey)     showSettingsStatus(`Settings saved, but AI Mode cannot work yet. ${Providers.wrongKeyText(owner, provider.id)}`, 'error');
  else if (!allowed)     showSettingsStatus(`Settings saved, but ${notAllowedText(provider)}, so AI Mode cannot use ${provider.writer} yet. Press Test and choose Allow.`, 'error');
  else if (stillRefused) showSettingsStatus('Settings saved. AI Mode is still not working: press Test to check again.', 'error');
  else                   showSettingsStatus('Settings saved! AI Mode is on.', 'success');
  await renderMode();
}

async function handleResumeForAI(e) {
  const { resumeFileName } = await storageGet(['resumeFileName']);
  // Unticking always applies at once: sending less is always safe. (This
  // holds even while a new PDF is picked but not saved yet.)
  if (!e.target.checked) {
    if (resumeFileName) await storageSet({ resumeForAI: false });
    if (pendingResume) showSettingsStatus(`Saved: your resume will not be sent. Press Save Settings to keep ${pendingResume.fileName}.`, 'success');
    else if (resumeFileName) showSettingsStatus('Saved: your resume will not be sent.', 'success');
    return;
  }
  // Ticking with a picked file that is not saved yet: Save Settings stores
  // the new file with this choice. (Saving the box now would turn on
  // sending the OLD file.)
  if (pendingResume) {
    showSettingsStatus(`Press Save Settings to save ${pendingResume.fileName} with this choice.`, 'success');
    return;
  }
  if (!resumeFileName) {
    showSettingsStatus('Upload your resume, then press Save Settings.', 'success');
    return;
  }
  await storageSet({ resumeForAI: true });
  showSettingsStatus('Saved: AI Mode will send your resume with each message.', 'success');
}

async function handleRemoveResume() {
  await new Promise(resolve => chrome.storage.local.remove(['resumeBase64', 'resumeFileName', 'resumeForAI'], resolve));
  document.getElementById('resume-upload').value = '';
  pendingResume = null;
  document.getElementById('file-label').textContent = 'Click to upload or drag PDF here';
  document.getElementById('file-upload-area').classList.remove('has-file');
  document.getElementById('resume-status').classList.add('hidden');
  document.getElementById('resume-for-ai').checked = false;
  document.getElementById('remove-resume-btn').classList.add('hidden');
  showSettingsStatus('Resume removed.', 'success');
}

// "Test" sends one tiny request, with the key, to the company you picked. A
// working key is saved at once, so AI Mode starts right away. For Google and
// OpenAI, Chrome first asks you to let the extension reach them (once).
async function handleTestKey() {
  const provider = Providers.get(document.getElementById('ai-provider').value);
  const apiKey = document.getElementById('api-key').value.trim();
  const el = document.getElementById('key-validation-status');
  if (!apiKey) {
    el.textContent = `Paste your ${provider.keyLabel} first. Leave it empty to use Free Mode.`;
    el.className   = 'key-validation-status invalid';
    return;
  }
  // Another company's key is never sent anywhere.
  const owner = Providers.keyOwner(apiKey);
  if (owner && owner !== provider.id) {
    el.textContent = `✗ ${Providers.wrongKeyText(owner, provider.id)}`;
    el.className   = 'key-validation-status invalid';
    return;
  }
  // Google or OpenAI: ask Chrome first, while this click (or Enter) still
  // counts as yours.
  const access = provider.optional ? requestAccess(provider) : null;

  const btn = document.getElementById('validate-btn');
  btn.textContent = '…';
  btn.disabled = true;
  const allowed = access ? await access : true;
  const result = allowed ? await sendMessage({ type: 'TEST_API_KEY', payload: { apiKey, provider: provider.id } }) : null;
  btn.textContent = 'Test';
  btn.disabled = false;

  // You changed the key (or the company) while the test ran: this result is
  // about another key, so it is not used (and that key is not saved).
  if (document.getElementById('api-key').value.trim() !== apiKey || shownProvider !== provider.id) return;

  if (!allowed) {
    el.textContent = `✗ ${notAllowedText(provider)}. Press Test again and choose Allow, or pick another AI provider.`;
    el.className   = 'key-validation-status invalid';
    await renderMode();
    return;
  }
  if (result && result.valid) {
    failedTest = null;
    el.textContent = '✓ Key works. AI Mode is on.';
    el.className   = 'key-validation-status valid';
    await storageSet({ [provider.keyField]: apiKey, keyStatus: Providers.tagStatus({ state: 'ai', keyTail: keyTail(apiKey), checkedAt: Date.now() }, provider.id) });
    await renderMode();
  } else {
    const reason = (result && result.reason) || 'The key did not work.';
    // Remembered for Save (see handleSaveSettings). "Busy" or "no internet"
    // says nothing about the key, so it is not remembered.
    failedTest = result && KEY_PROBLEMS.includes(result.code) ? { key: apiKey, provider: provider.id, reason, code: result.code } : null;
    el.textContent = `✗ ${reason}`;
    el.className   = 'key-validation-status invalid';
    await renderMode();
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function renderProfileCard(data) {
  const section = document.getElementById('profile-section');
  section.classList.remove('hidden');
  const name = data.name || 'Unknown';
  document.getElementById('profile-avatar').textContent  = name.charAt(0).toUpperCase();
  document.getElementById('profile-name').textContent    = name;
  document.getElementById('profile-headline').textContent = data.headline || '';
  document.getElementById('profile-company').textContent  = data.currentCompany || '';
}

function hideProfileCard() { document.getElementById('profile-section').classList.add('hidden'); }

function renderMessage(text) {
  document.getElementById('generated-message').value = text;
  document.getElementById('message-section').classList.remove('hidden');
  updateCharCount();
}

function hideMessage() { document.getElementById('message-section').classList.add('hidden'); }

// The length meter: "183 / 200" for a note, a soft target for a message.
function updateCharCount() {
  const text  = document.getElementById('generated-message').value;
  const st    = Limits.lengthState(text, currentChannel, linkedinPlan);
  const meter = document.getElementById('char-count');
  meter.textContent = st.hard ? `${st.count} / ${st.limit}` : `${st.count} chars · aim for under ${st.limit}`;
  meter.className   = `char-count${st.over ? ' over' : st.near ? ' near' : ''}`;
  renderFitRow(st);
  renderStrength();
}

async function handleCopy() {
  const text = document.getElementById('generated-message').value;
  if (!text) return;
  try { await navigator.clipboard.writeText(text); } catch(_) {
    const ta = document.getElementById('generated-message');
    ta.select(); document.execCommand('copy');
  }
  recordNoteUsed();
  // Nudge to keep the tracker honest: copying is not sending.
  if (contact && contact.status === 'drafted') document.getElementById('sent-prompt').classList.remove('hidden');
  const btn = document.getElementById('copy-btn');
  btn.textContent = '✓ Copied!';
  btn.classList.add('btn-secondary'); btn.classList.remove('btn-primary');
  setTimeout(() => {
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2"/></svg> Copy`;
    btn.classList.remove('btn-secondary'); btn.classList.add('btn-primary');
  }, 2200);
}

function showCurrentStatus(msg, type = '') {
  const el = document.getElementById('status-message');
  el.textContent = msg;
  el.className = `status-bar${type ? ' status-' + type : ''}`;
  el.classList.remove('hidden');
}

function clearCurrentStatus() {
  const el = document.getElementById('status-message');
  el.classList.add('hidden');
  el.textContent = '';
}

function showSettingsStatus(msg, type = '') {
  const el = document.getElementById('settings-status');
  el.textContent = msg;
  el.className = `status-bar${type ? ' status-' + type : ''}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2500);
}

// ─── Tracker ──────────────────────────────────────────────────────────────────
// Everyone you wrote to, their status, and what to do next.
function wireRecentEvents() {
  armTwoClick(document.getElementById('clear-recent-btn'), 'Click again to delete everyone', async () => {
    await Tracker.clear();
  });
  document.getElementById('export-csv-btn').addEventListener('click', handleExportCsv);
  document.querySelectorAll('.filter-btn').forEach(btn => btn.addEventListener('click', () => {
    trackerFilter = btn.dataset.filter;
    document.querySelectorAll('.filter-btn').forEach(b => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-checked', String(b === btn));
    });
    renderTracker();
  }));
}

async function onContactsChanged(all) {
  contact = profileKey ? (all[profileKey] || null) : null;
  renderTrackedBanner();
  renderTracker();
}

async function renderTracker() {
  const contacts = await Tracker.list();
  const now      = Date.now();
  const dueNow   = Tracker.due(contacts, now);

  const count = document.getElementById('due-count');
  count.textContent = dueNow.length ? String(dueNow.length) : '';
  count.classList.toggle('hidden', !dueNow.length);

  renderTrackerStats(Tracker.stats(contacts));

  const dueList = document.getElementById('due-list');
  dueList.innerHTML = '';
  dueNow.forEach(c => dueList.appendChild(buildContactCard(c, now)));
  document.getElementById('tracker-due').classList.toggle('hidden', !dueNow.length);

  const listEl = document.getElementById('recent-list');
  listEl.innerHTML = '';
  contacts
    .filter(c => trackerFilter === 'all' ? !dueNow.includes(c) : c.status === trackerFilter)
    .forEach(c => listEl.appendChild(buildContactCard(c, now)));

  document.getElementById('no-recent').classList.toggle('hidden', contacts.length > 0);
  document.getElementById('recent-actions').classList.toggle('hidden', !contacts.length);
  document.getElementById('tracker-filters').classList.toggle('hidden', !contacts.length);
}

function renderTrackerStats(st) {
  const el = document.getElementById('tracker-stats');
  el.classList.toggle('hidden', !st.contacted);
  if (!st.contacted) return;
  const parts = [`<strong>${st.contacted}</strong> contacted`];
  if (st.acceptRate !== null) parts.push(`<strong>${st.acceptRate}%</strong> accepted`);
  if (st.replyRate !== null)  parts.push(`<strong>${st.replyRate}%</strong> replied`);
  el.innerHTML = parts.join(' · ') + (st.best
    ? `<br>Working best for you: <strong>${esc(st.best.name)}</strong> (${st.best.replied} of ${st.best.sent} replied)`
    : '');
}

function buildContactCard(c, now) {
  const card    = document.createElement('div');
  card.className = 'contact-card';
  const step    = Tracker.nextStep(c, now);
  const message = c.message || '';
  const preview = message.substring(0, 110) + (message.length > 110 ? '…' : '');
  card.innerHTML = `
    <div class="contact-header">
      <div class="contact-info">
        <div class="contact-name">${esc(c.name || 'Unknown')}</div>
        <div class="contact-meta">${esc(statusDate(c))}${c.headline || c.company ? ' · ' + esc(c.headline || c.company) : ''}</div>
      </div>
      <select class="status-select" aria-label="Status for ${esc(c.name || 'this person')}">${statusOptions(c.status)}</select>
    </div>
    <div class="contact-next hidden"><span class="next-text"></span><button class="btn btn-sm btn-primary next-btn"></button></div>
    <div class="contact-message-preview">${esc(preview)}</div>
    <div class="contact-message-full hidden">${esc(message)}</div>
    <div class="contact-actions">
      <div class="contact-buttons">
        <button class="btn-link expand-btn">Show full message</button>
        <button class="btn-link open-btn">Open profile</button>
        <button class="btn-link remove-btn">Remove</button>
      </div>
      <button class="btn btn-sm btn-secondary copy-btn">Copy</button>
    </div>`;

  if (step) {
    const next = card.querySelector('.contact-next');
    next.classList.remove('hidden');
    next.querySelector('.next-text').textContent = step.label;
    const btn = next.querySelector('.next-btn');
    if (step.kind === 'message' || step.kind === 'followup') {
      btn.textContent = step.kind === 'message' ? 'Write the message' : 'Write a follow-up';
      btn.addEventListener('click', () => startNextMessage(c, step));
    } else {
      btn.remove();
    }
  }

  card.querySelector('.status-select').addEventListener('change', (e) => Tracker.setStatus(c.profileKey, e.target.value));
  card.querySelector('.expand-btn').addEventListener('click', (e) => {
    const full = card.querySelector('.contact-message-full');
    const show = full.classList.contains('hidden');
    full.classList.toggle('hidden', !show);
    card.querySelector('.contact-message-preview').classList.toggle('hidden', show);
    e.target.textContent = show ? 'Show less' : 'Show full message';
  });
  card.querySelector('.open-btn').addEventListener('click', () => openProfile(c.profileUrl));
  armTwoClick(card.querySelector('.remove-btn'), 'Sure? Click again', () => Tracker.remove(c.profileKey));
  card.querySelector('.copy-btn').addEventListener('click', async (e) => {
    await navigator.clipboard.writeText(message).catch(() => {});
    e.target.textContent = 'Copied!';
    setTimeout(() => { e.target.textContent = 'Copy'; }, 2200);
  });
  return card;
}

function statusOptions(current) {
  return Tracker.STATUSES
    .map(s => `<option value="${s}"${s === current ? ' selected' : ''}>${Tracker.STATUS_LABEL[s]}</option>`)
    .join('');
}

function statusDate(c) {
  const at = { drafted: c.createdAt, sent: c.sentAt, connected: c.connectedAt, replied: c.repliedAt }[c.status] || c.updatedAt;
  return `${Tracker.STATUS_LABEL[c.status] || c.status} ${new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

// "Write the message" / "Write a follow-up": open their profile, ready to go.
async function startNextMessage(c, step) {
  await chrome.storage.session.set({ intent: { profileKey: c.profileKey, channel: 'message', goal: step.goal || '' } });
  await openProfile(c.profileUrl);
  switchTab('current');
}

async function openProfile(url) {
  if (activeTabId !== null) await chrome.tabs.update(activeTabId, { url });
  else await chrome.tabs.create({ url });
}

// A destructive button asks once more before acting (no blocking popups).
function armTwoClick(btn, confirmText, action) {
  const original = btn.textContent;
  let armed = false;
  btn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      btn.textContent = confirmText;
      setTimeout(() => { armed = false; btn.textContent = original; }, 3000);
      return;
    }
    armed = false;
    btn.textContent = original;
    await action();
  });
}

async function handleExportCsv() {
  const csv  = Tracker.toCSV(await Tracker.list());
  const url  = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href     = url;
  link.download = `linkedin-outreach-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── This person, on the Current tab ──────────────────────────────────────────
// "In your tracker · Sent 12 Nov" also warns you before writing twice.
function renderTrackedBanner() {
  const box = document.getElementById('tracked-banner');
  if (!profileKey || !contact) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const last = (contact.history || [])[contact.history.length - 1];
  const seen = last && last.source === 'linkedin' && last.status === contact.status ? ' · seen on LinkedIn' : '';
  document.getElementById('tracked-text').textContent = `In your tracker · ${statusDate(contact)}${seen}`;
  document.getElementById('tracked-status').innerHTML = statusOptions(contact.status);
  const step = Tracker.nextStep(contact);
  const next = document.getElementById('tracked-next');
  next.classList.toggle('hidden', !step);
  if (step) next.textContent = step.label;
  if (contact.status !== 'drafted') document.getElementById('sent-prompt').classList.add('hidden');
}

async function handleMarkSent() {
  document.getElementById('sent-prompt').classList.add('hidden');
  if (profileKey) await Tracker.setStatus(profileKey, 'sent');
}

// ─── Chrome messaging ─────────────────────────────────────────────────────────
function sendMessage(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, success: false, error: chrome.runtime.lastError.message });
      else resolve(res);
    });
  });
}

// ─── Resume upload ────────────────────────────────────────────────────────────
let pendingResume = null;

function processResumeFile(file) {
  const statusEl  = document.getElementById('resume-status');
  const dropArea  = document.getElementById('file-upload-area');
  const fileLabel = document.getElementById('file-label');

  if (file.type !== 'application/pdf') {
    statusEl.textContent = 'Please upload a PDF file.';
    statusEl.className   = 'resume-status error';
    statusEl.classList.remove('hidden');
    return;
  }

  if (file.size > 4 * 1024 * 1024) {
    statusEl.textContent = 'File too large — max 4MB.';
    statusEl.className   = 'resume-status error';
    statusEl.classList.remove('hidden');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const base64 = e.target.result.split(',')[1];
    pendingResume = { base64, fileName: file.name };
    fileLabel.textContent = file.name;
    dropArea.classList.add('has-file');
    statusEl.textContent  = `${file.name} ready — click Save Settings to confirm.`;
    statusEl.className    = 'resume-status pending';
    statusEl.classList.remove('hidden');
  };
  reader.onerror = () => {
    statusEl.textContent = 'Error reading file.';
    statusEl.className   = 'resume-status error';
    statusEl.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

function loadStoredSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['aiProvider', ...Providers.KEY_FIELDS, 'userName','userBio','resumeBase64','resumeFileName','resumeForAI'], resolve);
  });
}

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function storageSet(items) {
  return new Promise(resolve => chrome.storage.local.set(items, resolve));
}

// Also escapes quotes: names go into attributes too (aria-label="…"), and a
// name with a " must not be able to add attributes of its own.
function esc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
