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
  enriching: 'Finding talking points — about 20 seconds…',
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
  await checkLicenseStatus();
});

// ─── License key status in header ────────────────────────────────────────────
// The badge shows what the server says about the key, not just whether one
// is saved. The answer is cached for 10 minutes per key.
const KEY_STATUS_TTL_MS = 10 * 60 * 1000;
const UNVERIFIED_CODES  = /^(offline|timeout|bad_response|http_5\d\d)$/;

async function checkLicenseStatus() {
  const s   = await loadStoredSettings();
  const key = (s.licenseKey || '').trim();
  if (!key) { renderKeyStatus({ state: 'none' }); return; }

  const { keyStatus } = await storageGet(['keyStatus']);
  const fresh = keyStatus && keyStatus.key === key && Date.now() - keyStatus.checkedAt < KEY_STATUS_TTL_MS;
  if (fresh) { renderKeyStatus(keyStatus); return; }

  renderKeyStatus({ state: 'checking' });
  const status = toKeyStatus(key, await validateKeyWithServer(key));
  if (status.state !== 'unverified') await storageSet({ keyStatus: status });
  renderKeyStatus(status);
}

function validateKeyWithServer(key) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'VALIDATE_KEY', payload: { key } }, (res) => {
      if (chrome.runtime.lastError) resolve({ valid: false, reason: chrome.runtime.lastError.message, code: 'offline' });
      else resolve(res);
    });
  });
}

function toKeyStatus(key, result) {
  const checkedAt = Date.now();
  if (result && result.valid) return { key, state: 'valid', remaining: result.remaining, checkedAt };
  if (!result || UNVERIFIED_CODES.test(result.code || '')) {
    return { key, state: 'unverified', reason: (result && result.reason) || 'No answer from the server.', checkedAt };
  }
  return { key, state: 'invalid', reason: result.reason || 'Invalid key.', checkedAt };
}

function renderKeyStatus(st) {
  const hasCount = st.remaining !== undefined && st.remaining !== null && st.remaining !== '';
  const views = {
    none:       { text: 'No Key',       cls: 'inactive',   warn: 'No license key found. Add yours in the Settings tab.' },
    checking:   { text: 'Checking…',    cls: 'checking',   warn: null },
    valid:      { text: hasCount ? `● ${st.remaining} left today` : '● Active', cls: 'active', warn: null },
    invalid:    { text: 'Invalid key',  cls: 'inactive',   warn: `Key not accepted: ${st.reason} Check it in Settings.` },
    unverified: { text: 'Not verified', cls: 'unverified', warn: null },
  };
  const view  = views[st.state];
  const badge = document.getElementById('key-status');
  badge.textContent = view.text;
  badge.className   = `key-status ${view.cls}`;
  badge.title       = st.state === 'unverified' ? `Could not check the key: ${st.reason}` : '';
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
    ? 'Slower (about 20s). Also finds company news and talking points.'
    : 'Fast. Uses the profile page only.';
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
    ? `Up to 200 characters. Free plans get only a few notes a month (made here: ${used} of ~${total}).`
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
    if (area === 'local' && changes.keyStatus && changes.keyStatus.newValue) renderKeyStatus(changes.keyStatus.newValue);
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

  const s = await loadStoredSettings();
  if (!s.licenseKey) {
    showCurrentStatus('No license key. Add it in Settings.', 'error');
    switchTab('settings');
    return;
  }

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
    if (res && res.code === 'no_key') switchTab('settings');
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
  const left = j.remaining !== undefined && j.remaining !== null ? ` ${j.remaining} left today.` : '';
  return `Message ready.${left}`;
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
  document.getElementById('save-settings-btn').addEventListener('click', handleSaveSettings);
  document.getElementById('validate-btn').addEventListener('click', handleValidateKey);
  document.getElementById('license-key').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleValidateKey();
  });
  document.getElementById('import-me-btn').addEventListener('click', handleImportMe);
  document.getElementById('remove-me-btn').addEventListener('click', handleRemoveMe);
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
    if (file) processResumeFile(file);
  });
}

async function loadSettings() {
  const s = await loadStoredSettings();
  document.getElementById('linkedin-plan').value = linkedinPlan;
  renderMeStatus();
  if (s.licenseKey) document.getElementById('license-key').value = s.licenseKey;
  if (s.userName)   document.getElementById('user-name').value   = s.userName;
  if (s.userBio)    document.getElementById('user-bio').value    = s.userBio;
  if (s.resumeFileName) {
    document.getElementById('file-label').textContent = s.resumeFileName;
    document.getElementById('file-upload-area').classList.add('has-file');
    const statusEl = document.getElementById('resume-status');
    statusEl.textContent = `${s.resumeFileName} saved ✓`;
    statusEl.className   = 'resume-status success';
    statusEl.classList.remove('hidden');
  }
}

async function handleSaveSettings() {
  const licenseKey = document.getElementById('license-key').value.trim().toUpperCase();
  const userName   = document.getElementById('user-name').value.trim();
  const userBio    = document.getElementById('user-bio').value.trim();

  const savePayload = { licenseKey, userName, userBio };
  if (pendingResume) {
    savePayload.resumeBase64   = pendingResume.base64;
    savePayload.resumeFileName = pendingResume.fileName;
    pendingResume = null;
    const statusEl = document.getElementById('resume-status');
    statusEl.textContent = 'Resume saved ✓';
    statusEl.className   = 'resume-status success';
  }
  await new Promise(resolve => chrome.storage.local.set(savePayload, resolve));
  showSettingsStatus('Settings saved!', 'success');
  await checkLicenseStatus();
}

async function handleValidateKey() {
  const key = document.getElementById('license-key').value.trim().toUpperCase();
  if (!key) return;

  const btn = document.getElementById('validate-btn');
  btn.textContent = '…';
  btn.disabled = true;

  const result = await validateKeyWithServer(key);
  const status = toKeyStatus(key, result);

  btn.textContent = 'Verify';
  btn.disabled = false;

  const el = document.getElementById('key-validation-status');
  el.classList.remove('hidden');

  if (status.state === 'valid') {
    el.textContent = `✓ Valid key — ${result.remaining} messages remaining today`;
    el.className   = 'key-validation-status valid';
    // Auto-save the key, with the fresh status so the header needs no second check.
    const s = await loadStoredSettings();
    await storageSet({ ...s, licenseKey: key, keyStatus: status });
    await checkLicenseStatus();
  } else {
    el.textContent = `✗ ${status.reason}`;
    el.className   = 'key-validation-status invalid';
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
    chrome.storage.local.get(['licenseKey','userName','userBio','resumeBase64','resumeFileName'], resolve);
  });
}

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function storageSet(items) {
  return new Promise(resolve => chrome.storage.local.set(items, resolve));
}

function esc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
