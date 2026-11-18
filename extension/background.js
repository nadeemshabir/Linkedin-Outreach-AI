'use strict';

// background.js — the extension's engine.
// It calls Ark's server, never OpenAI/Anthropic directly. All AI runs
// server-side; the extension only sends profile data + the license key.
//
// The background owns every generation "job":
//   read the profile → (Deep Mode: find talking points) → write the message.
// Each step is saved in chrome.storage.session, so closing the side panel
// never loses work. The panel only draws the saved state.

importScripts('utils/profile-url.js', 'utils/cache.js');

const SERVER_URL = 'https://linkedin-extention-production.up.railway.app';

// How long each call may take before we give up and tell the user.
// Deep Mode enrichment usually takes ~20s, so its limit is generous.
const TIMEOUT_MS = { validate: 15000, quick: 60000, enrich: 120000, deep: 90000 };

const RUNNING_STEPS = ['reading', 'enriching', 'writing'];
const HEARTBEAT_MS  = 15000;
const running = new Set(); // profile keys with a job running in this worker

// ─── Toolbar icon opens the side panel ────────────────────────────────────────
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else {
  // Browsers without the Side Panel API get the same page as a popup.
  chrome.action.setPopup({ popup: 'sidepanel.html?mode=popup' });
}

// A job that was running when Chrome stopped this worker can never finish.
// Mark it, so the panel offers "try again" instead of spinning forever.
const ready = markInterruptedJobs();

// ─── Router ───────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'START_JOB') {
    startJob(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === 'PEEK_PROFILE') {
    peekProfile(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === 'VALIDATE_KEY') {
    handleValidateKey(message.payload, sendResponse);
    return true;
  }
});

// ─── Jobs ─────────────────────────────────────────────────────────────────────
async function startJob({ tabId, mode, messageType, tone, regenerate = false }) {
  await ready;
  const tab        = await getTab(tabId);
  const profileKey = tab && ProfileUrl.key(tab.url);
  if (!profileKey) return { ok: false, error: 'Open a LinkedIn profile first.' };
  if (running.has(profileKey)) return { ok: false, error: 'Already working on this profile.' };

  const licenseKey = await getStoredKey();
  if (!licenseKey) return { ok: false, error: 'No license key found. Add it in Settings.', code: 'no_key' };

  // "New version" reuses what we already know and only rewrites the message.
  const prev = regenerate ? await getJob(profileKey) : null;
  const job = {
    profileKey,
    profileUrl:     ProfileUrl.canonical(profileKey),
    tabId,
    mode:           mode === 'deep' ? 'deep' : 'quick',
    messageType,
    tone,
    step:           'reading',
    profile:        prev ? prev.profile : null,
    profileJSON:    prev ? prev.profileJSON : null,
    enrichmentJSON: prev ? prev.enrichmentJSON : null,
    // Keep showing the previous draft until the new one arrives.
    message:        prev ? prev.message : null,
    messageId:      prev ? prev.messageId : null,
    error:          null,
    startedAt:      Date.now()
  };
  job.step = firstStep(job);

  running.add(profileKey);
  await saveJob(job);
  runJob(job, licenseKey).finally(() => running.delete(profileKey));
  return { ok: true, profileKey };
}

function firstStep(job) {
  if (!job.profile) return 'reading';
  if (job.mode === 'deep' && !job.enrichmentJSON) return 'enriching';
  return 'writing';
}

async function runJob(job, licenseKey) {
  // Chrome stops a worker that is idle for 30s. Calling an extension API
  // (here: saving the job) resets that timer, and the heartbeat also tells
  // the panel the run is still alive.
  const heartbeat = setInterval(() => { job.heartbeatAt = Date.now(); saveJob(job); }, HEARTBEAT_MS);
  try {
    if (!job.profile) {
      await setStep(job, 'reading');
      job.profile = await scrapeTab(job.tabId, job.profileKey);
    }

    const settings = await getSettings();
    let result;

    if (job.mode === 'deep') {
      if (!job.enrichmentJSON) {
        await setStep(job, 'enriching');
        const enriched = await callServer('/api/generate/enrich', { key: licenseKey, rawProfileData: job.profile }, TIMEOUT_MS.enrich);
        if (!enriched.success) throw new Error(enriched.error || 'Enrichment failed.');
        job.profileJSON    = enriched.profileJSON;
        job.enrichmentJSON = enriched.enrichmentJSON;
      }
      await setStep(job, 'writing');
      result = await callServer('/api/generate/deep', {
        key:            licenseKey,
        profileJSON:    job.profileJSON,
        enrichmentJSON: job.enrichmentJSON,
        messageType:    job.messageType,
        tone:           job.tone,
        resumeBase64:   settings.resumeBase64 || null
      }, TIMEOUT_MS.deep);
    } else {
      await setStep(job, 'writing');
      result = await callServer('/api/generate/quick', {
        key:          licenseKey,
        profileData:  job.profile,
        messageType:  job.messageType,
        tone:         job.tone,
        userName:     settings.userName,
        userBio:      settings.userBio,
        resumeBase64: settings.resumeBase64 || null
      }, TIMEOUT_MS.quick);
    }

    if (!result.success) throw new Error(result.error || 'Generation failed.');
    job.message    = result.message;
    job.messageId  = Date.now();
    job.remaining  = result.remaining;
    job.step       = 'done';
    job.finishedAt = Date.now();
    await saveJob(job);
    await saveToRecent(job);
    await noteRemaining(result.remaining);
  } catch (err) {
    job.failedStep = job.step;
    job.step       = 'error';
    job.error      = { message: err.message, code: err.code || null };
    await saveJob(job);
    if (err.code === 'http_401' || err.code === 'http_403') await noteKeyRejected(err.message);
  } finally {
    clearInterval(heartbeat);
  }
}

const jobId = (profileKey) => `job:${profileKey}`;

async function getJob(profileKey) {
  const id = jobId(profileKey);
  return (await chrome.storage.session.get(id))[id] || null;
}

function saveJob(job) {
  job.updatedAt = Date.now();
  return chrome.storage.session.set({ [jobId(job.profileKey)]: job });
}

async function setStep(job, step) {
  job.step = step;
  await saveJob(job);
}

async function markInterruptedJobs() {
  const all = await chrome.storage.session.get(null);
  const updates = {};
  for (const [id, job] of Object.entries(all)) {
    if (id.startsWith('job:') && job && RUNNING_STEPS.includes(job.step)) {
      updates[id] = {
        ...job,
        failedStep: job.step,
        step:       'error',
        error:      { message: 'This run was interrupted. Please try again.', code: 'interrupted' },
        updatedAt:  Date.now()
      };
    }
  }
  if (Object.keys(updates).length) await chrome.storage.session.set(updates);
}

// The side panel's Recent tab, saved here so it happens even if the panel is closed.
async function saveToRecent(job) {
  const p = job.profileJSON || job.profile || {};
  await Cache.addContact({
    profileUrl: job.profileUrl,
    name:       p.name || (job.profile && job.profile.name) || 'Unknown',
    headline:   p.headline || '',
    company:    p.currentCompany || '',
    message:    job.message,
    timestamp:  Date.now()
  });
}

// ─── Reading the LinkedIn page ────────────────────────────────────────────────
async function scrapeTab(tabId, profileKey) {
  const tab = await getTab(tabId);
  if (!tab) throw new Error('That tab was closed.');
  if (ProfileUrl.key(tab.url) !== profileKey) {
    throw new Error('The tab moved to another page. Open the profile and try again.');
  }
  const result = await askContentScript(tabId, { action: 'scrapeProfile' });
  if (!result?.success) throw new Error(result?.error || 'Could not read the profile.');
  return result.data;
}

// A quick look (name + headline) for the panel, without scrolling the page.
async function peekProfile({ tabId }) {
  try {
    const tab = await getTab(tabId);
    if (!tab || !ProfileUrl.key(tab.url)) return { success: false };
    return await askContentScript(tabId, { action: 'peekProfile' });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function askContentScript(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    // The tab was open before the extension was installed or updated.
    const files = chrome.runtime.getManifest().content_scripts[0].js;
    await chrome.scripting.executeScript({ target: { tabId }, files });
    await delay(400);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function getTab(tabId) {
  if (typeof tabId !== 'number') return Promise.resolve(null);
  return chrome.tabs.get(tabId).catch(() => null);
}

// ─── License key ──────────────────────────────────────────────────────────────
async function handleValidateKey({ key }, sendResponse) {
  try {
    const data = await callServer('/api/validate', { key }, TIMEOUT_MS.validate);
    sendResponse(data);
  } catch (err) {
    sendResponse({ valid: false, reason: err.message, code: err.code });
  }
}

// Keep the panel's key badge honest after each generation.
async function noteKeyRejected(reason) {
  const key = await getStoredKey();
  await chrome.storage.local.set({ keyStatus: { key, state: 'invalid', reason, checkedAt: Date.now() } });
}

async function noteRemaining(remaining) {
  if (remaining === undefined || remaining === null) return;
  const { keyStatus } = await chrome.storage.local.get('keyStatus');
  if (!keyStatus || keyStatus.state !== 'valid') return;
  await chrome.storage.local.set({ keyStatus: { ...keyStatus, remaining } });
}

// ─── Server calls ─────────────────────────────────────────────────────────────
// One place for every request: a time limit, safe JSON reading, and
// error messages a student can understand (never "Unexpected token <").
async function callServer(path, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let text;
  try {
    res = await fetch(`${SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    text = await res.text();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw serverError(`The server took too long (over ${Math.round(timeoutMs / 1000)}s). Please try again.`, 'timeout');
    }
    throw serverError('Could not reach the server. Check your internet connection.', 'offline');
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }

  if (!res.ok) throw serverError(friendlyHttpError(res.status, data), `http_${res.status}`);
  if (!data || typeof data !== 'object') {
    throw serverError('The server sent an unexpected reply. Please try again.', 'bad_response');
  }
  return data;
}

function friendlyHttpError(status, data) {
  const reason = data && (data.error || data.reason);
  if (status >= 500) return 'The server is having trouble right now. Please try again in a minute.';
  if (status === 429) return reason || 'Daily limit reached. It resets tomorrow.';
  if (status === 401 || status === 403) return reason || 'Your license key was not accepted. Check it in Settings.';
  return reason || `The request failed (error ${status}). Please try again.`;
}

function serverError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getStoredKey() {
  return new Promise(resolve => {
    chrome.storage.local.get(['licenseKey'], result => resolve(result.licenseKey || ''));
  });
}

function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['userName', 'userBio', 'resumeBase64'], resolve);
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
