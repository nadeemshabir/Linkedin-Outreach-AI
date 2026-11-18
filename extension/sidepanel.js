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
let peekTimer      = null;

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  document.documentElement.classList.add(IS_POPUP ? 'is-popup' : 'is-panel');
  initTabs();
  initModeToggle();
  wireSettingsEvents();
  wireCurrentEvents();
  wireRecentEvents();
  watchBrowser();
  await restoreChoices();
  await refreshActiveTab();
  await loadSettings();
  await renderRecentContacts();
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
  if (name === 'recent') renderRecentContacts();
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
    if (area === 'local' && changes.recentContacts) renderRecentContacts();
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
    if (job) setMode(job.mode === 'deep' ? 'deep' : 'simple');
  }
  renderJob();
  if (key && !(job && job.profile)) peekActiveProfile(key);
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
  document.getElementById('generated-message').addEventListener('input', handleMessageEdited);
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
      messageType: document.getElementById('message-type').value,
      tone:        document.getElementById('tone').value,
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
  Cache.updateMessage(job.profileUrl, text);
}

async function restoreChoices() {
  const { lastMessageType, lastTone } = await storageGet(['lastMessageType', 'lastTone']);
  if (lastMessageType) document.getElementById('message-type').value = lastMessageType;
  if (lastTone)        document.getElementById('tone').value = lastTone;
}

function saveChoices() {
  storageSet({
    lastMessageType: document.getElementById('message-type').value,
    lastTone:        document.getElementById('tone').value
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
  renderSteps(stale);

  if (job && job.enrichmentJSON) renderHooks(job.enrichmentJSON); else hideHooks();

  if (job && job.message) {
    if (shownMessageId !== job.messageId) {
      shownMessageId = job.messageId;
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

function renderSteps(stale) {
  const mode = currentMode === 'deep' ? 'deep' : 'quick';
  const show = !!job && job.mode === mode;
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

// ─── Settings ─────────────────────────────────────────────────────────────────
function wireSettingsEvents() {
  document.getElementById('save-settings-btn').addEventListener('click', handleSaveSettings);
  document.getElementById('validate-btn').addEventListener('click', handleValidateKey);
  document.getElementById('license-key').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleValidateKey();
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
function updateCharCount() {
  document.getElementById('char-count').textContent = `${document.getElementById('generated-message').value.length} chars`;
}

async function handleCopy() {
  const text = document.getElementById('generated-message').value;
  if (!text) return;
  try { await navigator.clipboard.writeText(text); } catch(_) {
    const ta = document.getElementById('generated-message');
    ta.select(); document.execCommand('copy');
  }
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

// ─── Recent contacts ──────────────────────────────────────────────────────────
function wireRecentEvents() {
  document.getElementById('clear-recent-btn').addEventListener('click', async () => {
    await Cache.clearContacts();
    renderRecentContacts();
  });
}

async function renderRecentContacts() {
  const contacts  = await Cache.getContacts();
  const listEl    = document.getElementById('recent-list');
  const emptyEl   = document.getElementById('no-recent');
  const actionsEl = document.getElementById('recent-actions');
  listEl.innerHTML = '';
  if (contacts.length === 0) {
    emptyEl.classList.remove('hidden'); actionsEl.classList.add('hidden'); return;
  }
  emptyEl.classList.add('hidden'); actionsEl.classList.remove('hidden');
  contacts.forEach((c, i) => listEl.appendChild(buildContactCard(c, i)));
}

function buildContactCard(contact, idx) {
  const card = document.createElement('div');
  card.className = 'contact-card';
  const date    = new Date(contact.timestamp).toLocaleDateString('en-US', { month:'short', day:'numeric' });
  const preview = (contact.message || '').substring(0, 110) + ((contact.message || '').length > 110 ? '…' : '');
  card.innerHTML = `
    <div class="contact-header">
      <div class="contact-info">
        <div class="contact-name">${esc(contact.name||'Unknown')}</div>
        <div class="contact-meta">${esc(contact.headline||contact.company||'')}</div>
      </div>
      <div class="contact-date">${esc(date)}</div>
    </div>
    <div class="contact-message-preview" id="prev-${idx}">${esc(preview)}</div>
    <div class="contact-message-full hidden" id="full-${idx}">${esc(contact.message||'')}</div>
    <div class="contact-actions">
      <button class="btn-link" id="expand-${idx}">Show full message</button>
      <button class="btn btn-sm btn-primary" id="copy-c-${idx}">Copy</button>
    </div>`;

  card.querySelector(`#expand-${idx}`).addEventListener('click', () => {
    const isHidden = card.querySelector(`#full-${idx}`).classList.contains('hidden');
    card.querySelector(`#prev-${idx}`).classList.toggle('hidden', isHidden);
    card.querySelector(`#full-${idx}`).classList.toggle('hidden', !isHidden);
    card.querySelector(`#expand-${idx}`).textContent = isHidden ? 'Show less' : 'Show full message';
  });

  card.querySelector(`#copy-c-${idx}`).addEventListener('click', async () => {
    await navigator.clipboard.writeText(contact.message || '').catch(() => {});
    const btn = card.querySelector(`#copy-c-${idx}`);
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2200);
  });

  return card;
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
