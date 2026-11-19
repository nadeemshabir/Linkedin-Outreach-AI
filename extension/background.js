'use strict';

// background.js — the extension's engine.
// Since Ark's 3.1.0 there is no Ark server and no license key. The message is
// written in one of two ways:
//   Free Mode (no key): from a template, on this device (utils/writer.js)
//   AI Mode: by Claude, with the user's OWN Anthropic API key, called directly
//            from here (the key never goes anywhere else)
//
// The background owns every generation "job":
//   read the profile → (Deep Mode: find talking points) → write the message.
// Each step is saved in chrome.storage.session, so closing the side panel
// never loses work. The panel only draws the saved state.

importScripts('utils/profile-url.js', 'utils/limits.js', 'utils/common-ground.js', 'utils/tracker.js', 'utils/writer.js');

// AI Mode. Ark's 3.1.0 chose Claude Haiku 5.5: fast, and very cheap for a
// student paying with their own key. A bigger model writes better, but costs
// far more. To change the model, change the thinking setting with it:
//   Haiku 5.5:  { type: 'disabled' } (a short note needs no thinking, and
//               thinking would use up max_tokens)
//   Sonnet 5.5: { type: 'between_tools' }
//   Opus 5.5:   null (thinking cannot be turned off; lower the effort instead)
const ANTHROPIC_URL      = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL    = 'claude-haiku-5-5';
const ANTHROPIC_THINKING = { type: 'disabled' };
const AI_TIMEOUT_MS      = 30000;
const RESUME_EXTRA_MS    = 30000; // a resume PDF takes longer to upload

const RUNNING_STEPS = ['reading', 'enriching', 'writing'];
const HEARTBEAT_MS  = 15000;
const running = new Set(); // profile keys with a job running in this worker
const runs    = new Map(); // profile key → that run's promise (to wait for it)

// ─── Toolbar icon opens the side panel ────────────────────────────────────────
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else {
  // Browsers without the Side Panel API get the same page as a popup.
  chrome.action.setPopup({ popup: 'sidepanel.html?mode=popup' });
}

// ─── Your key and resume stay out of LinkedIn's pages ────────────────────────
// chrome.storage.local holds your Anthropic key and your resume. By default,
// the scripts this extension runs on linkedin.com could read it too. They
// never need to, so only the extension's own pages and this worker may.
// Set each time the worker starts. (A Chrome that cannot do this for local
// storage refuses the call; then it stays as in 3.1.0.)
if (chrome.storage.local.setAccessLevel) {
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
}

// A job that was running when Chrome stopped this worker can never finish.
// Mark it, so the panel offers "try again" instead of spinning forever.
const ready = markInterruptedJobs();

// ─── Follow-up badge ──────────────────────────────────────────────────────────
// The toolbar icon shows how many follow-ups are due ("Aoife accepted, now
// send your message"). Re-checked hourly, since "due" depends on time.
chrome.alarms.get('followups').then(a => a || chrome.alarms.create('followups', { periodInMinutes: 60 }));
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'followups') updateBadge(); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.contacts) updateBadge(); });
chrome.runtime.onInstalled.addListener(() => {
  Tracker.all().then(updateBadge); // moves v3's Recent over
  forgetLicenseKey();
});

// Keys from before 3.1.0 (Ark's license key and its server status) are of no
// use any more. AI Mode uses the user's own Anthropic key (userApiKey).
async function forgetLicenseKey() {
  try {
    const { keyStatus } = await chrome.storage.local.get('keyStatus');
    await chrome.storage.local.remove(keyStatus && 'key' in keyStatus ? ['licenseKey', 'keyStatus'] : ['licenseKey']);
  } catch (_) { /* nothing to clean up */ }
}
updateBadge();

async function updateBadge() {
  try {
    const n = Tracker.due(await Tracker.list()).length;
    await chrome.action.setBadgeText({ text: n ? String(n) : '' });
    if (n) await chrome.action.setBadgeBackgroundColor({ color: '#1A56DB' });
    await chrome.action.setTitle({ title: n ? `LinkedIn Outreach AI · ${n} follow-up${n === 1 ? '' : 's'} due` : 'LinkedIn Outreach AI' });
  } catch (_) { /* the badge is a nice-to-have */ }
}

// ─── Router ───────────────────────────────────────────────────────────────────
// Content scripts run inside LinkedIn's pages, so their messages are treated
// as untrusted: they may only ask for INPAGE_WRITE, for their own tab. The
// rest is for the side panel (an extension page, which has no sender.tab).
const PANEL_ONLY = new Set(['START_JOB', 'PEEK_PROFILE', 'IMPORT_MY_PROFILE', 'TEST_API_KEY']);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || (PANEL_ONLY.has(message.type) && sender && sender.tab)) return undefined;

  if (message.type === 'START_JOB') {
    startJob(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === 'PEEK_PROFILE') {
    peekProfile(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === 'IMPORT_MY_PROFILE') {
    importMyProfile(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === 'TEST_API_KEY') {
    testApiKey(message.payload || {}).then(sendResponse);
    return true;
  }

  // From the "Write with Ark" button inside LinkedIn's own note/message box.
  // It may only write for the tab it is in.
  if (message.type === 'INPAGE_WRITE') {
    inpageWrite({ ...(message.payload || {}), tabId: sender && sender.tab ? sender.tab.id : null }).then(sendResponse);
    return true;
  }
});

// ─── Jobs ─────────────────────────────────────────────────────────────────────
async function startJob({ tabId, mode, channel, maxChars, messageType, tone, goal, useCommonGround, regenerate = false, variant }) {
  await ready;
  const tab        = await getTab(tabId);
  const profileKey = tab && ProfileUrl.key(tab.url);
  if (!profileKey) return { ok: false, error: 'Open a LinkedIn profile first.' };
  if (running.has(profileKey)) return { ok: false, error: 'Already working on this profile.' };

  // "New version" reuses what we already know and only rewrites the message.
  const prev = regenerate ? await getJob(profileKey) : null;
  const job = {
    profileKey,
    profileUrl:     ProfileUrl.canonical(profileKey),
    tabId,
    mode:           mode === 'deep' ? 'deep' : 'quick',
    channel:        channel === 'note' ? 'note' : 'message',
    maxChars:       Number(maxChars) > 0 ? Number(maxChars) : null,
    messageType,
    tone,
    goal:           String(goal || '').trim().slice(0, 200),
    useCommonGround: Array.isArray(useCommonGround) ? useCommonGround : (prev ? prev.useCommonGround : null),
    step:           'reading',
    profile:        prev ? prev.profile : null,
    enrichmentJSON: prev ? prev.enrichmentJSON : null,
    // Keep showing the previous draft until the new one arrives.
    message:        prev ? prev.message : null,
    messageId:      prev ? prev.messageId : null,
    // Free Mode is a template: "New version" moves on to other wording.
    variant:        Number.isInteger(variant) ? variant : (prev ? (prev.variant || 0) + 1 : 0),
    error:          null,
    startedAt:      Date.now()
  };
  job.step = firstStep(job);

  running.add(profileKey);
  await saveJob(job);
  const run = runJob(job).catch(() => {}); // runJob records its own errors on the job
  runs.set(profileKey, run);
  run.then(() => { if (runs.get(profileKey) === run) runs.delete(profileKey); });
  return { ok: true, profileKey };
}

// Wait until no run is going for this profile (in this worker).
async function whileRunning(profileKey) {
  while (running.has(profileKey)) await (runs.get(profileKey) || delay(50));
}

// ─── "Write with Ark" inside LinkedIn's own boxes ────────────────────────────
// The button in LinkedIn's note / message box (inpage.js) asks for a draft
// here. It shares the side panel's job, so both always show the same draft:
//   - a finished draft for this person and this kind of box: handed over at
//     once, with your edits from the panel if you made any
//   - a run already going: wait for it
//   - otherwise: a Quick run with your last choices. If this person was read
//     before, it reuses that, so the page is not scrolled again.
// A note is fitted to the box's own limit before it is handed over.
async function inpageWrite({ tabId, channel, maxChars }) {
  await ready;
  const tab        = await getTab(tabId);
  const profileKey = tab && ProfileUrl.key(tab.url);
  if (!profileKey) return { ok: false, error: 'Open their LinkedIn profile first.' };
  channel = channel === 'note' ? 'note' : 'message';

  await whileRunning(profileKey);
  let job = await getJob(profileKey);
  const reused = isDraftFor(job, channel);

  if (!reused) {
    const prefs   = await chrome.storage.local.get(['lastMessageType', 'lastTone', 'linkedinPlan']);
    const contact = channel === 'message' ? await Tracker.find(profileKey) : null;
    const next    = contact && Tracker.nextStep(contact);
    const started = await startJob({
      tabId,
      mode:        'quick',
      channel,
      maxChars:    channel === 'note' ? (maxChars || Limits.limitFor('note', prefs.linkedinPlan)) : Limits.MESSAGE_SUGGESTED,
      messageType: (job && job.messageType) || prefs.lastMessageType || 'Networking',
      tone:        (job && job.tone) || prefs.lastTone || 'Neutral',
      // Your goal for this person, if you set one in the panel for this kind
      // of message; else what the tracker says comes next ("they accepted").
      goal:        (job && job.channel === channel && job.goal) || (next && next.goal) || '',
      regenerate:  !!(job && job.profile), // reuse what was read; not a "New version"
      variant:     0
    });
    if (!started.ok) return started;
    await whileRunning(profileKey);
    job = await getJob(profileKey);
    if (!job || job.step !== 'done') {
      const error = job && job.error;
      // On linkedin.com, "Settings" would read as LinkedIn's own settings.
      const message = ((error && error.message) || 'Could not write it. Please try again.')
        .replace('in Settings', "in the extension's Settings (click its icon in Chrome's toolbar)");
      return { ok: false, error: message, code: error && error.code };
    }
  }

  const draft = job.editedMessage || job.message;
  const limit = channel === 'note' ? (maxChars || job.maxChars || Limits.NOTE_LIMIT.free) : null;
  const fit   = limit ? Limits.fitToLimit(draft, limit) : null;
  if (channel === 'note') await recordNoteUsed(profileKey).catch(() => {});
  return {
    ok:      true,
    message: fit ? fit.text : draft,
    reused,
    limit,
    fit:     fit && { changed: fit.changed, fits: fit.fits, removed: fit.removed.length },
    // The bar says so, as the side panel does: you may never open the panel.
    resumeSkipped: !!job.resumeSkipped
  };
}

function isDraftFor(job, channel) {
  return !!(job && job.step === 'done' && job.channel === channel && (job.editedMessage || job.message));
}

// Free plans get only a few notes a month. A note put into LinkedIn's box
// counts once per person per month, the same as copying it in the panel.
async function recordNoteUsed(profileKey) {
  const month = Limits.monthKey();
  const { noteUsage } = await chrome.storage.local.get('noteUsage');
  const profiles = noteUsage && noteUsage.month === month ? noteUsage.profiles : [];
  if (!profiles.includes(profileKey)) await chrome.storage.local.set({ noteUsage: { month, profiles: [...profiles, profileKey] } });
}

function firstStep(job) {
  if (!job.profile) return 'reading';
  if (job.mode === 'deep' && !job.enrichmentJSON) return 'enriching';
  return 'writing';
}

async function runJob(job) {
  // Chrome stops a worker that is idle for 30s. Calling an extension API
  // (here: saving the job) resets that timer, and the heartbeat also tells
  // the panel the run is still alive.
  const heartbeat = setInterval(() => { job.heartbeatAt = Date.now(); saveJob(job); }, HEARTBEAT_MS);

  // Ending a run: stop the heartbeat and free this profile for the next run
  // BEFORE saving the final state. The moment the panel sees "done" or
  // "error", the user can press "New version", and that must not be refused.
  const end = async () => {
    clearInterval(heartbeat);
    running.delete(job.profileKey);
    await saveJob(job);
  };

  let apiKey = ''; // the key this run used (if a 401 comes back, it is this key)
  try {
    if (!job.profile) {
      await setStep(job, 'reading');
      job.profile = await scrapeTab(job.tabId, job.profileKey);
      await syncStatusFromPage(job.profileKey, job.profile.relationship).catch(() => {});
    }

    // What you have in common (needs your own profile, added in Settings).
    // On a first run, use the strong matches; after that, the user's picks.
    const { myProfile } = await chrome.storage.local.get('myProfile');
    job.commonGround = CommonGround.find(myProfile, job.profile);
    const hooks = job.commonGround.map(c => c.hook);
    job.useCommonGround = Array.isArray(job.useCommonGround)
      ? job.useCommonGround.filter(h => hooks.includes(h))
      : CommonGround.defaultPick(job.commonGround);

    // Talking points from the profile. Deep Mode shows them first (as Ark's
    // 3.1.0 does); both modes give them to the writer.
    if (job.mode === 'deep' && !job.enrichmentJSON) {
      await setStep(job, 'enriching');
      job.enrichmentJSON = { topHooks: Writer.hooks(job.profile), companyNews: [] };
    }
    const points = (job.enrichmentJSON && job.enrichmentJSON.topHooks) || Writer.hooks(job.profile);

    await setStep(job, 'writing');
    const settings = await getSettings();
    apiKey = String(settings.userApiKey || '').trim();
    const brief = {
      profile:      job.profile,
      channel:      job.channel,
      maxChars:     job.maxChars,
      messageType:  job.messageType,
      tone:         job.tone,
      goal:         job.goal,
      commonGround: job.useCommonGround || [],
      hooks:        points,
      sender:       { userName: settings.userName, userBio: settings.userBio },
      variant:      job.variant || 0
    };
    if (apiKey) {
      // The resume goes to Anthropic only if you said yes in Settings. (3.1.0
      // kept a resume but never sent it, so an update must not start to.)
      const resume = settings.resumeForAI === true && settings.resumeBase64 ? settings.resumeBase64 : null;
      const out = await writeWithClaude(apiKey, brief, resume);
      job.message       = out.text;
      job.resumeSkipped = out.resumeSkipped;
    } else {
      job.message = Writer.local(brief);
    }
    job.writer    = apiKey ? 'ai' : 'free';
    job.messageId = Date.now();
    // Bookkeeping first, so "done" really means done.
    await saveToTracker(job).catch(() => {});
    if (apiKey && await isSavedKey(apiKey)) await noteKeyWorks(apiKey).catch(() => {});
    job.step       = 'done';
    job.finishedAt = Date.now();
    await end();
  } catch (err) {
    job.failedStep = job.step;
    job.step       = 'error';
    job.error      = { message: err.message, code: err.code || null };
    // Only about the key you have now: a slow run with your old key must not
    // mark (or clear) the key you pasted since.
    if (KEY_PROBLEMS.has(err.code) && await isSavedKey(apiKey)) await noteKeyRejected(err.message, apiKey, err.code).catch(() => {});
    await end();
  }
}

// AI Mode: Claude writes it, with the user's own key. Instructions go in the
// system prompt; the profile goes in the message, marked as someone else's
// text. The resume (only if you turned that on) goes first, as a PDF.
async function writeWithClaude(apiKey, brief, resumeBase64) {
  const write = async (resume) => {
    const { system, user } = Writer.prompt({ ...brief, hasResume: !!resume });
    const content = [];
    if (resume) {
      content.push({ type: 'document', title: 'My resume (the sender)', source: { type: 'base64', media_type: 'application/pdf', data: resume } });
    }
    content.push({ type: 'text', text: user });
    const timeoutMs = AI_TIMEOUT_MS + (resume ? RESUME_EXTRA_MS : 0);
    return Writer.cleanReply(await callClaude(apiKey, { system, content, maxTokens: 1024, timeoutMs }));
  };

  let text;
  let resumeSkipped = false;
  try {
    text = await write(resumeBase64);
  } catch (err) {
    // A resume makes every request bigger, so on a slow connection it can
    // be what runs out the time limit. Say so.
    if (resumeBase64 && err.code === 'timeout') {
      throw claudeError(`${err.message.replace(/ Please try again\.$/, '')} Your resume is sent with each message, which makes it slower: try again, or untick "Use my resume in AI Mode" in Settings.`, 'timeout');
    }
    // Anthropic reads only standard PDFs (no password, not a renamed file).
    // If it refuses the request because of the resume, write it without.
    if (!resumeBase64 || !['bad_request', 'too_large'].includes(err.code)) throw err;
    text = await write(null);
    resumeSkipped = true;
  }
  if (!text) throw claudeError('Claude sent back an empty message. Please try again.', 'empty');
  return { text, resumeSkipped };
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

// Saved here, not in the panel, so it happens even if the panel is closed.
async function saveToTracker(job) {
  const p = job.profile || {};
  await Tracker.saveDraft({
    profileKey:  job.profileKey,
    profileUrl:  job.profileUrl,
    name:        p.name || (job.profile && job.profile.name) || 'Unknown',
    headline:    p.headline || '',
    company:     p.currentCompany || '',
    message:     job.message,
    channel:     job.channel,
    messageType: job.messageType,
    tone:        job.tone
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
    const profileKey = tab && ProfileUrl.key(tab.url);
    if (!profileKey) return { success: false };
    const res = await askContentScript(tabId, { action: 'peekProfile' });
    if (res && res.success && res.data) await syncStatusFromPage(profileKey, res.data.relationship).catch(() => {});
    return res;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// The profile page shows how you stand with someone: a "Pending" button
// means your invite is waiting; "· 1st" means they accepted. Move the
// tracker forward to match - never backwards, and only for people you
// reached with a connection note (for a message, "1st" was true all along).
const STATUS_ORDER = ['drafted', 'sent', 'connected', 'replied'];
async function syncStatusFromPage(profileKey, relationship) {
  const target = { pending: 'sent', connected: 'connected' }[relationship];
  if (!target) return;
  const contact = await Tracker.find(profileKey);
  if (!contact || contact.channel === 'message') return;
  if (STATUS_ORDER.indexOf(target) > STATUS_ORDER.indexOf(contact.status)) {
    await Tracker.setStatus(profileKey, target, 'linkedin');
  }
}

// Your own profile, read once from your LinkedIn page, for common ground.
// Saved only in this browser (chrome.storage.local). In AI Mode, the common
// ground found with it ("We both studied at …") goes into the prompt.
async function importMyProfile({ tabId }) {
  try {
    const tab        = await getTab(tabId);
    const profileKey = tab && ProfileUrl.key(tab.url);
    if (!profileKey) return { ok: false, error: 'Open your own LinkedIn profile first.' };
    const profile = await scrapeTab(tabId, profileKey);
    await chrome.storage.local.set({
      myProfile: { ...profile, profileUrl: ProfileUrl.canonical(profileKey), importedAt: Date.now() }
    });
    return { ok: true, name: profile.name };
  } catch (err) {
    return { ok: false, error: err.message };
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

// ─── Your own Anthropic key (AI Mode) ────────────────────────────────────────
// "Test" sends a tiny real request, so a key with no credit left is caught
// too (a cheaper check of the key alone would pass it).
async function testApiKey({ apiKey }) {
  const key = String(apiKey || '').trim();
  if (!key) return { valid: false, reason: 'Paste your key first.', code: 'empty' };
  try {
    await callClaude(key, { content: 'Reply with the single word: OK', maxTokens: 16 });
    // Only for the saved key. A new key that works is saved by the panel,
    // with its status, if the panel is still open and the box still holds it.
    if (await isSavedKey(key)) await noteKeyWorks(key).catch(() => {});
    return { valid: true };
  } catch (err) {
    // A failed test of the saved key also changes the badge ("Key not
    // working"…). A new key that fails is not saved yet: the panel remembers
    // the failure, for when you press Save.
    if (KEY_PROBLEMS.has(err.code) && await isSavedKey(key)) await noteKeyRejected(err.message, key, err.code).catch(() => {});
    return { valid: false, reason: err.message, code: err.code || null };
  }
}

// Failures that mean AI Mode cannot work with this key until you act: a
// refused key, no credit, a spend limit, a key with a character that cannot
// be in a key, or a key that cannot use the model. ("Busy" or "no internet"
// says nothing about the key.)
const KEY_PROBLEMS = new Set(['auth', 'billing', 'spend_limit', 'bad_key', 'model']);

// Never throws: if storage cannot be read, the key is treated as not saved
// (nothing is marked), and the run still ends normally.
async function isSavedKey(key) {
  try {
    const { userApiKey } = await chrome.storage.local.get('userApiKey');
    return !!key && String(userApiKey || '').trim() === String(key).trim();
  } catch (_) {
    return false;
  }
}

// The panel's badge: "AI Mode", or what stops it ("Key not working",
// "Billing problem", "Spend limit reached", "AI Mode not available") with
// the reason. Only the key's last 8 characters are kept here, to know which
// key it is about. (Anthropic keys end in "AA", so 4 were too few.) The
// panel uses the same length.
const keyTail = (key) => String(key || '').trim().slice(-8);

async function noteKeyWorks(key) {
  await chrome.storage.local.set({ keyStatus: { state: 'ai', keyTail: keyTail(key), checkedAt: Date.now() } });
}

// `key` is the key the failed request used. Callers check first that it is
// still the saved key (you may have pasted another one in the meantime).
async function noteKeyRejected(reason, key, code) {
  await chrome.storage.local.set({ keyStatus: { state: 'invalid', keyTail: keyTail(key), reason, code: code || null, checkedAt: Date.now() } });
}

// ─── Calling Claude ──────────────────────────────────────────────────────────
// One place for every request: a time limit, safe JSON reading, and error
// messages a student can understand. Called straight from the extension with
// the user's own key; the extra header tells Anthropic that is intended.
async function callClaude(apiKey, { system, content, maxTokens, timeoutMs = AI_TIMEOUT_MS }) {
  // A key can only hold plain characters. A curly quote or an invisible space
  // from copying would make the request fail before it is sent, and look
  // like "no internet".
  if (!/^[!-~]+$/.test(apiKey)) {
    throw claudeError('Your key has a character that cannot be in a key (often a curly quote or an invisible space from copying). Copy it again from console.anthropic.com.', 'bad_key');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const body = {
    model:      ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    messages:   [{ role: 'user', content }]
  };
  // A short note needs no long thinking, and thinking would use up
  // max_tokens (3.1.0's 400-token messages could come back cut off).
  if (ANTHROPIC_THINKING) body.thinking = ANTHROPIC_THINKING;
  if (system) body.system = system;

  let res;
  let text;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method:  'POST',
      headers: {
        'content-type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body:   JSON.stringify(body),
      signal: controller.signal
    });
    text = await res.text();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw claudeError(`Claude took too long (over ${Math.round(timeoutMs / 1000)}s). Please try again.`, 'timeout');
    }
    throw claudeError('Could not reach Anthropic. Check your internet connection.', 'offline');
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!res.ok) {
    const [message, code] = friendlyClaudeError(res.status, data);
    throw claudeError(message, code);
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.content)) {
    throw claudeError('Anthropic sent an unexpected reply. Please try again.', 'bad_response');
  }
  if (data.stop_reason === 'refusal') {
    throw claudeError('Claude declined to write this one. Try again, or remove your key in Settings to use Free Mode.', 'refusal');
  }
  const out = data.content.filter(b => b && b.type === 'text').map(b => b.text).join('').trim();
  if (!out && data.stop_reason === 'max_tokens') {
    throw claudeError('Claude stopped before it finished. Please try again.', 'max_tokens');
  }
  return out;
}

// [message, code]. Anthropic's own reason is passed on wherever "try again"
// would not help (a billing problem, a spend limit, a refused request).
function friendlyClaudeError(status, data) {
  const error  = (data && data.error) || {};
  const reason = typeof error.message === 'string' ? error.message : '';
  if (status === 401 && /^CORS requests are not allowed/i.test(reason)) {
    return ['Your Anthropic organization does not allow calls from a browser extension. Use a key from a personal account at console.anthropic.com, or remove the key to use Free Mode.', 'auth'];
  }
  if (status === 401) return ['Your Anthropic API key was not accepted. Check it in Settings, or remove it to use Free Mode.', 'auth'];
  if (status === 402) {
    return [`Anthropic could not bill your account${reason ? `: ${reason}` : '.'} Check Plans & Billing at console.anthropic.com, or remove your key to use Free Mode.`, 'billing'];
  }
  if (status === 403) return [`Your Anthropic key is not allowed to do this${reason ? `: ${reason}` : '.'}`, 'auth'];
  if (status === 404) return [`Your Anthropic account cannot use the model ${ANTHROPIC_MODEL}. Remove your key to use Free Mode, or update the extension.`, 'model'];
  if (status === 413) return ['The request was too large for Anthropic (often a large resume PDF).', 'too_large'];
  if (status === 429 && error.details && error.details.error_code === 'enforced_spend_limit_reached') {
    return [`Anthropic said: ${reason || 'your spend limit is reached.'}`, 'spend_limit'];
  }
  if (status === 429) return ['Too many requests to Anthropic right now. Wait a minute, then try again.', 'rate_limit'];
  if (status === 529 || status >= 500) return ['Anthropic is busy right now. Please try again in a minute.', 'busy'];
  // No credit left comes back as a 400: "Your credit balance is too low…".
  if (status === 400 && /credit balance/i.test(reason)) {
    return [`Anthropic said: ${reason} Or remove your key to use Free Mode.`, 'billing'];
  }
  if (status === 400 && reason) return [`Anthropic said: ${reason}`, 'bad_request'];
  if (status >= 400 && status < 500 && reason) return [`Anthropic said: ${reason}`, `http_${status}`];
  return [`The request to Anthropic failed (error ${status}). Please try again.`, `http_${status}`];
}

function claudeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['userName', 'userBio', 'resumeBase64', 'resumeForAI', 'userApiKey'], resolve);
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
