'use strict';

// background.js — the extension's engine.
// Since Ark's 3.1.0 there is no Ark server and no license key. The message is
// written in one of two ways:
//   Free Mode (no key): from a template, on this device (utils/writer.js)
//   AI Mode: by the AI company the user picked in Settings (Anthropic,
//            Google or OpenAI, see utils/providers.js), with the user's OWN
//            API key for it, called directly from here (the key never goes
//            anywhere else)
//
// The background owns every generation "job":
//   read the profile → (Deep Mode: find talking points) → write the message.
// Each step is saved in chrome.storage.session, so closing the side panel
// never loses work. The panel only draws the saved state.

importScripts('utils/profile-url.js', 'utils/limits.js', 'utils/common-ground.js', 'utils/tracker.js', 'utils/writer.js', 'utils/providers.js');

// AI Mode. Each company's small, fast model: very cheap for a student paying
// with their own key. A bigger model writes better, but costs far more.
// Thinking is turned off (or as low as it goes) for each: a short note needs
// none, and thinking counts against the output limit, so a note could come
// back cut off (3.1.0's 400-token messages could).
//
// Anthropic. Ark's 3.1.0 chose Claude Haiku 5.5. To change the model, change
// the thinking setting with it:
//   Haiku 5.5:  { type: 'disabled' }
//   Sonnet 5.5: { type: 'between_tools' }
//   Opus 5.5:   null (thinking cannot be turned off; lower the effort instead)
const ANTHROPIC_URL      = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL    = 'claude-haiku-5-5';
const ANTHROPIC_THINKING = { type: 'disabled' };
// Google. Gemini 3.5 Flash-Lite (stable). Its thinking cannot be turned off;
// MINIMAL is the lowest level ("little to no thinking"). Gemini 3 and later
// take thinkingLevel; older models took thinkingBudget instead.
const GEMINI_URL      = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL    = 'gemini-3.5-flash-lite';
const GEMINI_THINKING = { thinkingLevel: 'MINIMAL' };
// OpenAI. GPT-6 Luna, OpenAI's model for cheap, high-volume work. It is a
// reasoning model: reasoning_effort 'none' turns the reasoning off.
const OPENAI_URL       = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL     = 'gpt-6-luna';
const OPENAI_REASONING = 'none';

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
// chrome.storage.local holds your API keys and your resume. By default,
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
// use any more. AI Mode uses the user's own key (see utils/providers.js).
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
    resumeSkipped: !!job.resumeSkipped,
    // In AI Mode: the company whose AI wrote it ("Google could not read the PDF").
    ...(job.writer === 'ai' && { aiCompany: Providers.get(job.provider).company })
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

  let apiKey   = '';              // the key this run used (if a 401 comes back, it is this key)
  let provider = Providers.get(); // and whose key it is
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
    provider = Providers.get(settings.aiProvider);
    apiKey   = String(settings[provider.keyField] || '').trim();
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
      // The resume goes to the AI only if you said yes in Settings. (3.1.0
      // kept a resume but never sent it, so an update must not start to.)
      const resume = settings.resumeForAI === true && settings.resumeBase64 ? settings.resumeBase64 : null;
      const out = await writeWithAI(provider, apiKey, brief, resume);
      job.message       = out.text;
      job.resumeSkipped = out.resumeSkipped;
      job.provider      = provider.id;
    } else {
      job.message = Writer.local(brief);
    }
    job.writer    = apiKey ? 'ai' : 'free';
    job.messageId = Date.now();
    // Bookkeeping first, so "done" really means done.
    await saveToTracker(job).catch(() => {});
    if (apiKey && await isSavedKey(apiKey, provider.id)) await noteKeyWorks(apiKey, provider.id).catch(() => {});
    job.step       = 'done';
    job.finishedAt = Date.now();
    await end();
  } catch (err) {
    job.failedStep = job.step;
    job.step       = 'error';
    job.error      = { message: err.message, code: err.code || null };
    // Only about the key you have now: a slow run with your old key (or with
    // the company you picked before) must not mark (or clear) the key you
    // pasted since.
    if (KEY_PROBLEMS.has(err.code) && await isSavedKey(apiKey, provider.id)) await noteKeyRejected(err.message, apiKey, err.code, provider.id).catch(() => {});
    await end();
  }
}

// AI Mode: the AI you picked writes it, with your own key. Instructions go
// in the system prompt; the profile goes in the message, marked as someone
// else's text. The resume (only if you turned that on) goes first, as a PDF.
async function writeWithAI(provider, apiKey, brief, resumeBase64) {
  const write = async (resume) => {
    const { system, user } = Writer.prompt({ ...brief, hasResume: !!resume });
    const timeoutMs = AI_TIMEOUT_MS + (resume ? RESUME_EXTRA_MS : 0);
    return Writer.cleanReply(await callAI(provider, apiKey, { system, text: user, resume, maxTokens: 1024, timeoutMs }));
  };

  let text;
  let resumeSkipped = false;
  try {
    text = await write(resumeBase64);
  } catch (err) {
    // A resume makes every request bigger, so on a slow connection it can
    // be what runs out the time limit. Say so.
    if (resumeBase64 && err.code === 'timeout') {
      throw aiError(`${err.message.replace(/ Please try again\.$/, '')} Your resume is sent with each message, which makes it slower: try again, or untick "Use my resume in AI Mode" in Settings.`, 'timeout');
    }
    // The AIs read only standard PDFs (no password, not a renamed file), and
    // a model may not take PDFs at all. If the request is refused because of
    // the resume, write it without.
    if (!resumeBase64 || !['bad_request', 'too_large'].includes(err.code)) throw err;
    text = await write(null);
    resumeSkipped = true;
  }
  if (!text) throw aiError(`${provider.writer} sent back an empty message. Please try again.`, 'empty');
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

// ─── Your own API key (AI Mode) ──────────────────────────────────────────────
// "Test" sends a tiny real request to the company you picked, so a key with
// no credit left is caught too (a cheaper check of the key alone would pass
// it). The panel asks Chrome for access to Google's or OpenAI's API first.
async function testApiKey({ apiKey, provider: providerId }) {
  const provider = Providers.get(providerId);
  const key = String(apiKey || '').trim();
  if (!key) return { valid: false, reason: 'Paste your key first.', code: 'empty' };
  let failure = null;
  try {
    await callAI(provider, key, { text: 'Reply with the single word: OK', plain: true, maxTokens: 16 });
  } catch (err) {
    // Cut off at the tiny limit: the key was accepted all the same.
    if (err.code !== 'max_tokens') failure = err;
  }
  if (!failure) {
    // Only for the saved key. A new key that works is saved by the panel,
    // with its status, if the panel is still open and the box still holds it.
    if (await isSavedKey(key, provider.id)) await noteKeyWorks(key, provider.id).catch(() => {});
    return { valid: true };
  }
  // A failed test of the saved key also changes the badge ("Key not
  // working"…). A new key that fails is not saved yet: the panel remembers
  // the failure, for when you press Save.
  if (KEY_PROBLEMS.has(failure.code) && await isSavedKey(key, provider.id)) await noteKeyRejected(failure.message, key, failure.code, provider.id).catch(() => {});
  return { valid: false, reason: failure.message, code: failure.code || null };
}

// Failures that mean AI Mode cannot work with this key until you act: a
// refused key, no credit, a spend limit, a key with a character that cannot
// be in a key, a key that cannot use the model, or a company that does not
// offer its API where you are. ("Busy" or "no internet" says nothing about
// the key. A key for another company, or no access from Chrome yet, is
// shown by the panel without asking anyone, so it is not saved here.)
const KEY_PROBLEMS = new Set(['auth', 'billing', 'spend_limit', 'bad_key', 'model', 'region']);

// Is `key` the key saved for `providerId`, and is that the company picked
// now? Never throws: if storage cannot be read, the key is treated as not
// saved (nothing is marked), and the run still ends normally.
async function isSavedKey(key, providerId) {
  try {
    const provider = Providers.get(providerId);
    const saved = await chrome.storage.local.get(['aiProvider', provider.keyField]);
    return !!key && Providers.get(saved.aiProvider).id === provider.id
      && String(saved[provider.keyField] || '').trim() === String(key).trim();
  } catch (_) {
    return false;
  }
}

// The panel's badge: "AI Mode", or what stops it ("Key not working",
// "Billing problem", "Spend limit reached", "AI Mode not available") with
// the reason. Only the key's last 8 characters are kept here, to know which
// key it is about. (Anthropic keys end in "AA", so 4 were too few.) The
// panel uses the same length. For Google and OpenAI keys, the status also
// says whose key it is (Providers.tagStatus).
const keyTail = (key) => String(key || '').trim().slice(-8);

async function noteKeyWorks(key, providerId) {
  await chrome.storage.local.set({ keyStatus: Providers.tagStatus({ state: 'ai', keyTail: keyTail(key), checkedAt: Date.now() }, providerId) });
}

// `key` is the key the failed request used. Callers check first that it is
// still the saved key (you may have pasted another one in the meantime).
async function noteKeyRejected(reason, key, code, providerId) {
  await chrome.storage.local.set({ keyStatus: Providers.tagStatus({ state: 'invalid', keyTail: keyTail(key), reason, code: code || null, checkedAt: Date.now() }, providerId) });
}

// ─── Calling the AI ──────────────────────────────────────────────────────────
// One place for every request, whichever company you picked: a time limit,
// safe JSON reading, and error messages a student can understand. Each
// company has its own request shape, reply shape and errors (APIS, below).
//   text:   the user message (the prompt)
//   resume: base64 PDF, sent before the text (only if you turned that on)
//   plain:  the text alone, not in content blocks (the key Test)
async function callAI(provider, apiKey, { system, text, resume = null, plain = false, maxTokens, timeoutMs = AI_TIMEOUT_MS }) {
  // A key can only hold plain characters. A curly quote or an invisible space
  // from copying would make the request fail before it is sent, and look
  // like "no internet".
  if (!/^[!-~]+$/.test(apiKey)) {
    throw aiError(`Your key has a character that cannot be in a key (often a curly quote or an invisible space from copying). Copy it again from ${provider.keyPage}.`, 'bad_key');
  }
  // Never send one company's key to another (an OpenAI key, with Gemini
  // picked, would otherwise go to Google).
  const owner = Providers.keyOwner(apiKey);
  if (owner && owner !== provider.id) throw aiError(Providers.wrongKeyText(owner, provider.id), 'wrong_provider');
  // Google and OpenAI need your OK in Chrome first (asked by the panel's
  // Test and Save). Without it, the request would fail like "no internet".
  if (provider.optional && !(await hasAccess(provider))) throw aiError(Providers.noAccessText(provider.id), 'permission');

  const api = APIS[provider.id];
  const { url, headers, body } = api.request(apiKey, { system, text, resume, plain, maxTokens });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let raw;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    raw = await res.text();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw aiError(`${provider.writer} took too long (over ${Math.round(timeoutMs / 1000)}s). Please try again.`, 'timeout');
    }
    throw aiError(`Could not reach ${provider.company}. Check your internet connection.`, 'offline');
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }
  if (!res.ok) {
    const [message, code] = api.error(res.status, data);
    throw aiError(message, code);
  }
  if (!data || typeof data !== 'object') throw unexpectedReply(provider);
  return api.read(data, provider);
}

// Is Chrome letting the extension reach this company's API? Anthropic's is
// in the manifest's host_permissions (as in 3.1.0); Google's and OpenAI's
// are optional, granted when you press Test or Save with them picked.
async function hasAccess(provider) {
  if (!provider.optional) return true;
  try {
    return await chrome.permissions.contains({ origins: [provider.origin] });
  } catch (_) {
    return false;
  }
}

// The same three answers from every company, in its own words.
const unexpectedReply = (p) => aiError(`${p.company} sent an unexpected reply. Please try again.`, 'bad_response');
const declined        = (p) => aiError(`${p.writer} declined to write this one. Try again, or remove your key in Settings to use Free Mode.`, 'refusal');
const cutOff          = (p) => aiError(`${p.writer} stopped before it finished. Please try again.`, 'max_tokens');

// ─── Anthropic (Claude): the Messages API ────────────────────────────────────
// Called straight from the extension with the user's own key; the extra
// header tells Anthropic that is intended.
function anthropicRequest(apiKey, { system, text, resume, plain, maxTokens }) {
  let content = text;
  if (!plain) {
    content = [];
    if (resume) {
      content.push({ type: 'document', title: 'My resume (the sender)', source: { type: 'base64', media_type: 'application/pdf', data: resume } });
    }
    content.push({ type: 'text', text });
  }
  const body = {
    model:      ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    messages:   [{ role: 'user', content }]
  };
  if (ANTHROPIC_THINKING) body.thinking = ANTHROPIC_THINKING;
  if (system) body.system = system;
  return {
    url: ANTHROPIC_URL,
    headers: {
      'content-type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body
  };
}

function anthropicRead(data, provider) {
  if (!Array.isArray(data.content)) throw unexpectedReply(provider);
  if (data.stop_reason === 'refusal') throw declined(provider);
  const out = data.content.filter(b => b && b.type === 'text').map(b => b.text).join('').trim();
  if (!out && data.stop_reason === 'max_tokens') throw cutOff(provider);
  return out;
}

// [message, code]. Anthropic's own reason is passed on wherever "try again"
// would not help (a billing problem, a spend limit, a refused request).
function anthropicError(status, data) {
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

// ─── Google (Gemini): generateContent ────────────────────────────────────────
// The key goes in a header, not in the URL (where it could end up in logs).
function geminiRequest(apiKey, { system, text, resume, maxTokens }) {
  const parts = [];
  if (resume) parts.push({ inlineData: { mimeType: 'application/pdf', data: resume } });
  parts.push({ text });
  const body = {
    contents: [{ role: 'user', parts }],
    // No temperature: newer Gemini models ignore it or refuse it.
    generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: GEMINI_THINKING }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  return {
    url: `${GEMINI_URL}/${GEMINI_MODEL}:generateContent`,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body
  };
}

// Gemini stops for safety or copyright reasons with these.
const GEMINI_DECLINED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

function geminiRead(data, provider) {
  const candidate = Array.isArray(data.candidates) ? data.candidates[0] : null;
  if (!candidate) {
    // The prompt itself was blocked: no answer at all.
    if (data.promptFeedback && data.promptFeedback.blockReason) throw declined(provider);
    throw unexpectedReply(provider);
  }
  const parts = candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  // Thoughts (if any came back) are not the message.
  const out = parts.filter(p => p && !p.thought && typeof p.text === 'string').map(p => p.text).join('').trim();
  if (!out && candidate.finishReason === 'MAX_TOKENS') throw cutOff(provider);
  if (!out && GEMINI_DECLINED.has(candidate.finishReason)) throw declined(provider);
  return out;
}

// [message, code]. Google's errors have a gRPC status ("INVALID_ARGUMENT")
// and sometimes a reason in `details` ("API_KEY_INVALID"). A bad key comes
// back as a 400, not a 401, so it is checked first.
function geminiError(status, data) {
  const error  = (data && data.error) || {};
  const reason = typeof error.message === 'string' ? error.message : '';
  const kinds  = [error.status, typeof error.code === 'string' ? error.code : '',
    ...(Array.isArray(error.details) ? error.details.map(d => d && d.reason) : [])].filter(k => typeof k === 'string').join(' ');
  if (status === 401 || /\bAPI_KEY_/.test(kinds) || /\bauthentication\b/.test(kinds) || /API key (not valid|expired)/i.test(reason)) {
    return ['Your Gemini API key was not accepted. Check it in Settings, or remove it to use Free Mode.', 'auth'];
  }
  if (/location is not supported|not available in your (country|region)|unsupported (country|location|region)/i.test(reason)) {
    return [`Google said: ${reason} Remove your key to use Free Mode, or pick another AI provider.`, 'region'];
  }
  if (status === 402 || (status === 400 && /FAILED_PRECONDITION|failed_precondition/.test(kinds) && /billing/i.test(reason))) {
    return [`Google could not bill your account${reason ? `: ${reason}` : '.'} Check billing at aistudio.google.com, or remove your key to use Free Mode.`, 'billing'];
  }
  if (status === 403) return [`Your Gemini key is not allowed to do this${reason ? `: ${reason}` : '.'}`, 'auth'];
  if (status === 404) return [`Your Google account cannot use the model ${GEMINI_MODEL}. Remove your key to use Free Mode, or update the extension.`, 'model'];
  if (status === 413) return ['The request was too large for Google (often a large resume PDF).', 'too_large'];
  // Google's 429 covers both "too many per minute" and "daily free limit used
  // up"; its own text is long and full of links, so it is not shown.
  if (status === 429) return ["Too many requests to Gemini right now, or your key's daily limit is used up. Wait a minute, then try again.", 'rate_limit'];
  if (status >= 500) return ['Gemini is busy right now. Please try again in a minute.', 'busy'];
  if (status === 400 && reason) return [`Google said: ${reason}`, 'bad_request'];
  if (status >= 400 && status < 500 && reason) return [`Google said: ${reason}`, `http_${status}`];
  return [`The request to Google failed (error ${status}). Please try again.`, `http_${status}`];
}

// ─── OpenAI (GPT): Chat Completions ──────────────────────────────────────────
function openaiRequest(apiKey, { system, text, resume, plain, maxTokens }) {
  const messages = [];
  // "developer" is what newer OpenAI models call the system prompt.
  if (system) messages.push({ role: 'developer', content: system });
  let content = text;
  if (!plain) {
    content = [];
    if (resume) content.push({ type: 'file', file: { filename: 'my-resume.pdf', file_data: `data:application/pdf;base64,${resume}` } });
    content.push({ type: 'text', text });
  }
  messages.push({ role: 'user', content });
  return {
    url: OPENAI_URL,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: {
      model: OPENAI_MODEL,
      messages,
      // The limit counts reasoning too, so reasoning is off.
      max_completion_tokens: maxTokens,
      reasoning_effort: OPENAI_REASONING
    }
  };
}

function openaiRead(data, provider) {
  if (!Array.isArray(data.choices)) throw unexpectedReply(provider);
  const choice  = data.choices[0] || {};
  const message = choice.message || {};
  if (message.refusal) throw declined(provider);
  const out = typeof message.content === 'string' ? message.content.trim() : '';
  if (!out && choice.finish_reason === 'length') throw cutOff(provider);
  if (!out && choice.finish_reason === 'content_filter') throw declined(provider);
  return out;
}

// OpenAI's codes for "no money left" and for a spend limit you (or OpenAI) set.
const OPENAI_BILLING      = new Set(['insufficient_quota', 'credit_balance_exhausted', 'billing_hard_limit_reached', 'billing_not_active']);
const OPENAI_SPEND_LIMITS = new Set(['organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded']);

// [message, code]. A 429 can be "too many requests" or "no credit left":
// OpenAI's error code tells them apart.
function openaiError(status, data) {
  const error  = (data && data.error) || {};
  const reason = typeof error.message === 'string' ? error.message : '';
  const code   = typeof error.code === 'string' ? error.code : '';
  if (status === 401) return ['Your OpenAI API key was not accepted. Check it in Settings, or remove it to use Free Mode.', 'auth'];
  if (OPENAI_BILLING.has(code) || error.type === 'insufficient_quota') {
    return [`OpenAI said: ${reason || 'your account has no credit left.'} Check Billing at platform.openai.com, or remove your key to use Free Mode.`, 'billing'];
  }
  if (OPENAI_SPEND_LIMITS.has(code)) return [`OpenAI said: ${reason || 'your spend limit is reached.'}`, 'spend_limit'];
  if (code === 'unsupported_country_region_territory' || (status === 403 && /country|region|territory/i.test(reason))) {
    return [`OpenAI said: ${reason || 'Country, region, or territory not supported.'} Remove your key to use Free Mode, or pick another AI provider.`, 'region'];
  }
  if (status === 403) return [`Your OpenAI key is not allowed to do this${reason ? `: ${reason}` : '.'}`, 'auth'];
  if (status === 404 || code === 'model_not_found') {
    return [`Your OpenAI account cannot use the model ${OPENAI_MODEL}. Remove your key to use Free Mode, or update the extension.`, 'model'];
  }
  if (status === 413) return ['The request was too large for OpenAI (often a large resume PDF).', 'too_large'];
  if (status === 429) return ['Too many requests to OpenAI right now. Wait a minute, then try again.', 'rate_limit'];
  if (status >= 500) return ['OpenAI is busy right now. Please try again in a minute.', 'busy'];
  if (status === 400 && reason) return [`OpenAI said: ${reason}`, 'bad_request'];
  if (status >= 400 && status < 500 && reason) return [`OpenAI said: ${reason}`, `http_${status}`];
  return [`The request to OpenAI failed (error ${status}). Please try again.`, `http_${status}`];
}

const APIS = {
  anthropic: { request: anthropicRequest, read: anthropicRead, error: anthropicError },
  gemini:    { request: geminiRequest,    read: geminiRead,    error: geminiError },
  openai:    { request: openaiRequest,    read: openaiRead,    error: openaiError }
};

function aiError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['userName', 'userBio', 'resumeBase64', 'resumeForAI', 'aiProvider', ...Providers.KEY_FIELDS], resolve);
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
