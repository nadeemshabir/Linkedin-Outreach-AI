import { describe, it, expect, beforeEach } from 'vitest';
import { createFakeChrome } from '../helpers/fake-chrome.js';
import { exportFrom } from '../helpers/load.js';

const Tracker = exportFrom('utils/tracker.js', 'Tracker');
const DAY = 24 * 60 * 60 * 1000;

let chrome;
beforeEach(() => {
  ({ chrome } = createFakeChrome());
  globalThis.chrome = chrome;
});

const draft = (slug, extra = {}) => ({
  profileKey: `/in/${slug}/`, profileUrl: `https://www.linkedin.com/in/${slug}/`,
  name: `${slug[0].toUpperCase()}${slug.slice(1)} Test`, headline: 'Data Scientist', company: 'Spotify',
  message: `Hi ${slug}`, channel: 'note', messageType: 'Referral', tone: 'Casual', ...extra,
});

describe('moving over from v3', () => {
  it('turns the old "last 5 contacts" into tracked drafts, and keeps the old data', async () => {
    const legacy = [
      { profileUrl: 'https://www.linkedin.com/in/Aoife-M/', name: 'Aoife', headline: 'DS', company: 'Spotify', message: 'Hi Aoife', timestamp: 1700000000000 },
      { profileUrl: 'https://www.linkedin.com/in/liam/', name: 'Liam', message: 'Hi Liam', timestamp: 1690000000000 },
      { profileUrl: '', name: 'Broken', message: 'x', timestamp: 1 }, // v3 Deep Mode bug: no URL
    ];
    await chrome.storage.local.set({ recentContacts: legacy });
    const list = await Tracker.list();
    expect(list.map((c) => [c.profileKey, c.status, c.message])).toEqual([
      ['/in/aoife-m/', 'drafted', 'Hi Aoife'],
      ['/in/liam/', 'drafted', 'Hi Liam'],
    ]);
    expect((await chrome.storage.local.get('recentContacts')).recentContacts).toEqual(legacy);
  });

  it('reading never writes, so it cannot overwrite a contact saved meanwhile', async () => {
    await chrome.storage.local.set({ recentContacts: [{ profileUrl: 'https://www.linkedin.com/in/liam/', name: 'Liam', message: 'x', timestamp: 1 }] });
    const writes = [];
    const realSet = chrome.storage.local.set;
    chrome.storage.local.set = (items, cb) => { writes.push(Object.keys(items)); return realSet(items, cb); };
    await Tracker.list();
    await Tracker.find('/in/liam/');
    expect(writes).toEqual([]);
    // The first real change saves the migrated list together with the change.
    await Tracker.setStatus('/in/liam/', 'sent');
    expect(Object.keys((await chrome.storage.local.get('contacts')).contacts)).toEqual(['/in/liam/']);
  });
});

describe('statuses', () => {
  it('drafted → sent → connected → replied, with dates and history', async () => {
    await Tracker.saveDraft(draft('aoife'));
    await Tracker.setStatus('/in/aoife/', 'sent');
    await Tracker.setStatus('/in/aoife/', 'connected', 'auto');
    const c = await Tracker.setStatus('/in/aoife/', 'replied');
    expect(c.status).toBe('replied');
    expect(c.sentAt && c.connectedAt && c.repliedAt).toBeTruthy();
    expect(c.history.map((h) => `${h.status}/${h.source}`)).toEqual(['drafted/auto', 'sent/you', 'connected/auto', 'replied/you']);
  });

  it('a new draft for someone you already wrote to keeps their status', async () => {
    await Tracker.saveDraft(draft('aoife'));
    await Tracker.setStatus('/in/aoife/', 'connected');
    await Tracker.saveDraft(draft('aoife', { message: 'Follow-up', channel: 'message' }));
    const c = await Tracker.find('/in/aoife/');
    expect(c).toMatchObject({ status: 'connected', message: 'Follow-up', channel: 'message' });
  });

  it('edits are kept and marked', async () => {
    await Tracker.saveDraft(draft('aoife'));
    await Tracker.updateMessage('/in/aoife/', 'My own words');
    expect(await Tracker.find('/in/aoife/')).toMatchObject({ message: 'My own words', edited: true });
  });
});

describe('next step', () => {
  const now = Date.UTC(2026, 10, 18);
  const c = (o) => ({ name: 'Aoife Murphy', channel: 'note', status: 'sent', updatedAt: now, ...o });

  it('accepted → time to send the real message', () => {
    expect(Tracker.nextStep(c({ status: 'connected' }), now)).toEqual({
      due: true, kind: 'message', label: 'Aoife accepted your invite. Now send your message.',
      goal: 'They just accepted my connection request. Thank them in a few words, then make my ask.',
    });
  });

  it('a message with no reply after 5 days → follow up', () => {
    expect(Tracker.nextStep(c({ channel: 'message', sentAt: now - 4 * DAY }), now)).toBeNull();
    expect(Tracker.nextStep(c({ channel: 'message', sentAt: now - 6 * DAY }), now))
      .toMatchObject({ due: true, kind: 'followup', label: 'No reply from Aoife in 6 days. Send a short follow-up.' });
  });

  it('an invite with no answer is not nagged about (you cannot message them yet)', () => {
    expect(Tracker.nextStep(c({ sentAt: now - 20 * DAY }), now)).toMatchObject({ due: false, kind: 'waiting' });
  });

  it('replied → nothing to do', () => {
    expect(Tracker.nextStep(c({ status: 'replied' }), now)).toBeNull();
  });

  it('the badge counts only what is due', () => {
    const list = [c({ status: 'connected' }), c({ channel: 'message', sentAt: now - 9 * DAY }), c({ sentAt: now - 20 * DAY }), c({ status: 'replied' })];
    expect(Tracker.due(list, now)).toHaveLength(2);
  });
});

describe('what works for you', () => {
  it('accept and reply rates, and the best type + tone once there is enough data', () => {
    const s = (o) => ({ messageType: 'Referral', tone: 'Casual', channel: 'note', ...o });
    const list = [
      s({ status: 'replied' }), s({ status: 'replied' }), s({ status: 'sent' }),
      s({ messageType: 'Networking', tone: 'Formal', status: 'connected' }),
      s({ messageType: 'Networking', tone: 'Formal', status: 'sent' }),
      s({ messageType: 'Networking', tone: 'Formal', status: 'replied' }),
      s({ status: 'drafted' }),
    ];
    expect(Tracker.stats(list)).toEqual({
      contacted: 6, accepted: 4, acceptRate: 67, replied: 3, replyRate: 50,
      best: { name: 'Referral · Casual', sent: 3, replied: 2, rate: 67 },
    });
  });

  it('no "best" when there is nothing to compare it with', () => {
    const s = (status) => ({ messageType: 'Referral', tone: 'Casual', channel: 'note', status });
    expect(Tracker.stats([s('replied'), s('replied'), s('sent')]).best).toBeNull();
  });

  it('no data, no fake numbers', () => {
    expect(Tracker.stats([])).toEqual({ contacted: 0, accepted: 0, acceptRate: null, replied: 0, replyRate: null, best: null });
  });
});

describe('CSV export', () => {
  it('quotes everything and defuses spreadsheet formulas', () => {
    const csv = Tracker.toCSV([{ name: '=HYPERLINK("x")', profileUrl: 'u', status: 'sent', channel: 'note', message: 'Hi "Aoife",\nthanks', createdAt: Date.UTC(2026, 10, 1), sentAt: Date.UTC(2026, 10, 2) }]);
    const [header, row] = csv.split('\r\n');
    expect(header).toBe('"Name","Profile URL","Headline","Company","Status","Sent as","Message type","Tone","Created","Sent","Connected","Replied","Message"');
    expect(row).toBe('"\'=HYPERLINK(""x"")","u","","","Sent","Connection note","","","2026-11-01","2026-11-02","","","Hi ""Aoife"",\nthanks"');
  });
});
