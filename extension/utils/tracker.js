'use strict';

// Tracker — everyone you have written to, and what happened next.
// (Grew out of the old "last 5 contacts" cache.) Stored in
// chrome.storage.local under "contacts", keyed by profile ("/in/<slug>/").
//
// Status:  drafted → sent → connected → replied
//   drafted    a message was written, not sent yet
//   sent       you sent the note (or message)
//   connected  they accepted your invite
//   replied    they wrote back

const Tracker = (() => {
  const KEY        = 'contacts';
  const LEGACY_KEY = 'recentContacts'; // v3's "last 5 contacts"
  const MAX        = 500;
  const DAY        = 24 * 60 * 60 * 1000;
  const STATUSES   = ['drafted', 'sent', 'connected', 'replied'];
  const STATUS_LABEL = { drafted: 'Drafted', sent: 'Sent', connected: 'Connected', replied: 'Replied' };

  const get = (keys) => new Promise(resolve => chrome.storage.local.get(keys, resolve));
  const set = (items) => new Promise(resolve => chrome.storage.local.set(items, resolve));

  function keyOf(profileUrl) {
    const m = String(profileUrl || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
    if (!m) return null;
    let slug = m[1];
    try { slug = decodeURIComponent(slug); } catch (_) { /* keep */ }
    return `/in/${slug.toLowerCase()}/`;
  }

  // v3 kept the last 5 drafts in "recentContacts". Bring them over once.
  // The old key is left as it was, so going back to v3 still works.
  function migrate(legacy) {
    const contacts = {};
    for (const c of legacy || []) {
      const profileKey = keyOf(c.profileUrl);
      if (!profileKey || contacts[profileKey]) continue;
      const at = c.timestamp || Date.now();
      contacts[profileKey] = {
        profileKey,
        profileUrl: `https://www.linkedin.com${profileKey}`,
        name: c.name || 'Unknown', headline: c.headline || '', company: c.company || '',
        message: c.message || '', edited: !!c.edited, channel: null,
        status: 'drafted', createdAt: at, updatedAt: at,
        history: [{ status: 'drafted', at, source: 'imported' }]
      };
    }
    return contacts;
  }

  // Reading never writes. Until the first change, v3's list is shown through
  // migrate(); the first change saves it as "contacts". (A write-back here
  // could overwrite a contact saved by the background in the meantime.)
  async function all() {
    const data = await get([KEY, LEGACY_KEY]);
    return data[KEY] || migrate(data[LEGACY_KEY]);
  }

  async function list() {
    return Object.values(await all()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function find(profileKey) {
    return (await all())[profileKey] || null;
  }

  async function write(contacts) {
    // Keep it bounded: drop the oldest beyond MAX.
    const keep = Object.values(contacts).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX);
    await set({ [KEY]: Object.fromEntries(keep.map(c => [c.profileKey, c])) });
  }

  // A new draft for someone. Keeps their status if you already sent something.
  async function saveDraft(d) {
    const contacts = await all();
    const now  = Date.now();
    const prev = contacts[d.profileKey];
    contacts[d.profileKey] = {
      ...(prev || { createdAt: now, status: 'drafted', history: [{ status: 'drafted', at: now, source: 'auto' }] }),
      profileKey:  d.profileKey,
      profileUrl:  d.profileUrl,
      name:        d.name || (prev && prev.name) || 'Unknown',
      headline:    d.headline || (prev && prev.headline) || '',
      company:     d.company || (prev && prev.company) || '',
      message:     d.message,
      edited:      false,
      channel:     d.channel || (prev && prev.channel) || null,
      messageType: d.messageType || null,
      tone:        d.tone || null,
      updatedAt:   now
    };
    await write(contacts);
    return contacts[d.profileKey];
  }

  // Your own edits over the AI draft.
  async function updateMessage(profileKey, message) {
    const contacts = await all();
    if (!contacts[profileKey]) return;
    contacts[profileKey] = { ...contacts[profileKey], message, edited: true, updatedAt: Date.now() };
    await write(contacts);
  }

  async function setStatus(profileKey, status, source = 'you') {
    if (!STATUSES.includes(status)) return null;
    const contacts = await all();
    const c = contacts[profileKey];
    if (!c || c.status === status) return c || null;
    const now = Date.now();
    const stamp = { sent: 'sentAt', connected: 'connectedAt', replied: 'repliedAt' }[status];
    contacts[profileKey] = {
      ...c,
      status,
      ...(stamp ? { [stamp]: now } : {}),
      updatedAt: now,
      history: [...(c.history || []), { status, at: now, source }]
    };
    await write(contacts);
    return contacts[profileKey];
  }

  async function remove(profileKey) {
    const contacts = await all();
    delete contacts[profileKey];
    await set({ [KEY]: contacts });
  }

  async function clear() {
    await set({ [KEY]: {} });
  }

  // ── What to do next ────────────────────────────────────────────────────────
  // due: true means it is time to act (counted on the toolbar badge).
  function nextStep(c, now = Date.now()) {
    const first = String(c.name || 'They').split(/\s+/)[0];
    const days  = (t) => (t ? (now - t) / DAY : 0);
    // `goal` tells the writer what this next message is for. The panel and
    // the in-page "✨ Write" button both use it.
    if (c.status === 'connected') {
      return {
        due: true, kind: 'message', label: `${first} accepted your invite. Now send your message.`,
        goal: 'They just accepted my connection request. Thank them in a few words, then make my ask.',
      };
    }
    if (c.status === 'sent' && c.channel === 'message' && days(c.sentAt) >= 5) {
      return {
        due: true, kind: 'followup', label: `No reply from ${first} in ${Math.floor(days(c.sentAt))} days. Send a short follow-up.`,
        goal: 'Polite follow-up: they have not replied to my last message yet. Keep it short and easy to answer.',
      };
    }
    if (c.status === 'sent' && c.channel !== 'message' && days(c.sentAt) >= 14) {
      return { due: false, kind: 'waiting', label: `${first} has not accepted in 2 weeks. Many people never check invites.` };
    }
    if (c.status === 'drafted' && days(c.updatedAt) >= 2) {
      return { due: false, kind: 'unsent', label: 'Drafted but not sent yet.' };
    }
    return null;
  }

  function due(contacts, now = Date.now()) {
    return contacts.filter(c => { const s = nextStep(c, now); return s && s.due; });
  }

  // ── What works for you ─────────────────────────────────────────────────────
  function stats(contacts) {
    const reached  = contacts.filter(c => c.status !== 'drafted');
    const notes    = reached.filter(c => c.channel !== 'message');
    const accepted = notes.filter(c => c.status === 'connected' || c.status === 'replied');
    const replied  = reached.filter(c => c.status === 'replied');
    const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);

    // Best message type + tone: only once at least two of them have 3+ sent,
    // so there is really something to compare.
    const groups = {};
    for (const c of reached) {
      if (!c.messageType || !c.tone) continue;
      const g = (groups[`${c.messageType} · ${c.tone}`] ||= { sent: 0, replied: 0 });
      g.sent += 1;
      if (c.status === 'replied') g.replied += 1;
    }
    const comparable = Object.entries(groups)
      .filter(([, g]) => g.sent >= 3)
      .map(([name, g]) => ({ name, ...g, rate: pct(g.replied, g.sent) }))
      .sort((a, b) => b.rate - a.rate || b.sent - a.sent);
    const best = comparable.length >= 2 && comparable[0].replied > 0 ? comparable[0] : null;

    return {
      contacted: reached.length,
      accepted: accepted.length, acceptRate: pct(accepted.length, notes.length),
      replied: replied.length,   replyRate: pct(replied.length, reached.length),
      best
    };
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  function toCSV(contacts) {
    const cols = ['Name', 'Profile URL', 'Headline', 'Company', 'Status', 'Sent as', 'Message type', 'Tone',
      'Created', 'Sent', 'Connected', 'Replied', 'Message'];
    const date = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');
    const cell = (v) => {
      const s = String(v == null ? '' : v);
      // Quote every cell; stop spreadsheet formulas ("=...") from running.
      return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
    };
    const rows = contacts.map(c => [c.name, c.profileUrl, c.headline, c.company, STATUS_LABEL[c.status] || c.status,
      c.channel === 'message' ? 'Message' : c.channel === 'note' ? 'Connection note' : '', c.messageType, c.tone,
      date(c.createdAt), date(c.sentAt), date(c.connectedAt), date(c.repliedAt), c.message]);
    return [cols, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  }

  return {
    STATUSES, STATUS_LABEL, keyOf, migrate, all, list, find, saveDraft, updateMessage, setStatus, remove, clear,
    nextStep, due, stats, toCSV
  };
})();
