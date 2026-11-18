'use strict';

// background.js — Extension backend (calls YOUR server, not OpenAI/Anthropic directly)
// All AI happens server-side. Extension only sends data + serial key.

const SERVER_URL = 'https://linkedin-extention-production.up.railway.app';

// How long each call may take before we give up and tell the user.
// Deep Mode enrichment usually takes ~20s, so its limit is generous.
const TIMEOUT_MS = { validate: 15000, quick: 60000, enrich: 120000, deep: 90000 };

// ─── Router ───────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.action === 'scrapeProfile') {
    handleScrapeProfile(sendResponse);
    return true;
  }

  if (message.action === 'generateMessage') {
    handleQuickGenerate(message.data, sendResponse);
    return true;
  }

  if (message.type === 'VALIDATE_KEY') {
    handleValidateKey(message.payload, sendResponse);
    return true;
  }

  if (message.type === 'RUN_ENRICH') {
    handleEnrich(message.payload, sendResponse);
    return true;
  }

  if (message.type === 'RUN_GENERATE') {
    handleDeepGenerate(message.payload, sendResponse);
    return true;
  }
});

// ─── Scrape profile from active tab ───────────────────────────────────────────
async function handleScrapeProfile(sendResponse) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab  = tabs[0];
    if (!tab) throw new Error('No active tab found.');
    if (!tab.url || !tab.url.includes('linkedin.com')) {
      throw new Error('Please navigate to a LinkedIn profile page first.');
    }

    let result;
    try {
      result = await chrome.tabs.sendMessage(tab.id, { action: 'scrapeProfile' });
    } catch (_) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_script.js'] });
      await delay(400);
      result = await chrome.tabs.sendMessage(tab.id, { action: 'scrapeProfile' });
    }

    if (!result?.success) throw new Error(result?.error || 'Scrape failed.');
    sendResponse({ success: true, data: result.data });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ─── Validate serial key ───────────────────────────────────────────────────────
async function handleValidateKey({ key }, sendResponse) {
  try {
    const data = await callServer('/api/validate', { key }, TIMEOUT_MS.validate);
    sendResponse(data);
  } catch (err) {
    sendResponse({ valid: false, reason: err.message, code: err.code });
  }
}

// ─── Quick Mode generate ───────────────────────────────────────────────────────
async function handleQuickGenerate(data, sendResponse) {
  try {
    const { profileData, settings, messageType, tone } = data;
    const key = await getStoredKey();
    if (!key) throw new Error('No license key found. Add it in Settings.');

    const result = await callServer('/api/generate/quick', {
      key,
      profileData,
      messageType,
      tone,
      userName:     settings.userName,
      userBio:      settings.userBio,
      resumeBase64: settings.resumeBase64 || null
    }, TIMEOUT_MS.quick);

    if (!result.success) throw new Error(result.error || 'Generation failed.');
    sendResponse({ success: true, generatedMessage: result.message });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ─── Deep Mode enrich (L1 + L2) ───────────────────────────────────────────────
async function handleEnrich({ rawProfileData }, sendResponse) {
  try {
    const key = await getStoredKey();
    if (!key) throw new Error('No license key found. Add it in Settings.');

    const result = await callServer('/api/generate/enrich', { key, rawProfileData }, TIMEOUT_MS.enrich);

    if (!result.success) throw new Error(result.error || 'Enrichment failed.');
    sendResponse({ status: 'enrich_complete', profileJSON: result.profileJSON, enrichmentJSON: result.enrichmentJSON });
  } catch (err) {
    sendResponse({ status: 'error', error: err.message });
  }
}

// ─── Deep Mode generate (L3) ──────────────────────────────────────────────────
async function handleDeepGenerate({ profileJSON, enrichmentJSON, messageType, tone }, sendResponse) {
  try {
    const key = await getStoredKey();
    const settings = await new Promise(resolve => chrome.storage.local.get(['resumeBase64'], resolve));
    if (!key) throw new Error('No license key found. Add it in Settings.');

    const result = await callServer('/api/generate/deep', {
      key, profileJSON, enrichmentJSON, messageType, tone, resumeBase64: settings.resumeBase64 || null
    }, TIMEOUT_MS.deep);

    if (!result.success) throw new Error(result.error || 'Generation failed.');
    sendResponse({ status: 'generate_complete', generatedMessage: result.message, remaining: result.remaining });
  } catch (err) {
    sendResponse({ status: 'error', error: err.message });
  }
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
