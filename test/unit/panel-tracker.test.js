// The tracker, as the user sees it: real panel + real background (Phase 5).
// Messages are written in Free Mode here (no key), so nothing is fetched.
import { describe, it, expect } from 'vitest';
import { createWorld, openPanel, person, until, settle, fire } from '../helpers/world.js';

const AOIFE = person('aoife', 'Aoife Murphy');
const LIAM  = person('liam', 'Liam Byrne');

function world(opts = {}) {
  return createWorld({
    local: opts.local || {},
    tabs: [{ id: 1, url: (opts.startOn || AOIFE).profileUrl, active: true }],
    pages: { 1: opts.startOn || AOIFE },
    pagesByUrl: { [AOIFE.profileUrl]: AOIFE, [LIAM.profileUrl]: LIAM },
  });
}

// Aoife accepted your invite. You are on Liam's profile, with the tracker open.
async function aoifeAccepted() {
  const w = world({ startOn: LIAM });
  const now = Date.now();
  await w.chrome.storage.local.set({
    contacts: {
      '/in/aoife/': {
        profileKey: '/in/aoife/', profileUrl: AOIFE.profileUrl, name: 'Aoife Murphy', message: 'Hi Aoife',
        channel: 'note', status: 'connected', createdAt: now, updatedAt: now, connectedAt: now, history: [],
      },
    },
  });
  const panel = await openPanel(w);
  panel.$('tabbtn-recent').click();
  await until(() => cards(panel, 'due-list').length === 1);
  return { w, panel };
}

async function generate(panel) {
  panel.$('generate-btn').click();
  await until(() => !panel.$('message-section').classList.contains('hidden'));
  await settle();
}

const cards = (panel, listId = 'recent-list') => [...panel.$(listId).querySelectorAll('.contact-card')];
const statusOf = (card) => card.querySelector('.status-select').value;

describe('tracker', () => {
  it('a generated message puts the person in the tracker, and the panel says so', async () => {
    const panel = await openPanel(world());
    await generate(panel);
    await until(() => !panel.$('tracked-banner').classList.contains('hidden'));
    expect(panel.$('tracked-text').textContent).toMatch(/^In your tracker · Drafted \w{3} \d{1,2}$/);

    const [card] = cards(panel);
    expect(card.querySelector('.contact-name').textContent).toBe('Aoife Murphy');
    expect(statusOf(card)).toBe('drafted');
  });

  it('copy → "Mark as sent" → the status changes everywhere', async () => {
    const w = world();
    const panel = await openPanel(w);
    await generate(panel);
    await until(() => !panel.$('tracked-banner').classList.contains('hidden'));

    panel.$('copy-btn').click();
    await settle();
    expect(panel.$('sent-prompt').classList.contains('hidden')).toBe(false);
    panel.$('mark-sent-btn').click();

    await until(() => panel.$('tracked-text').textContent.startsWith('In your tracker · Sent'));
    expect(panel.$('sent-prompt').classList.contains('hidden')).toBe(true);
    expect(statusOf(cards(panel)[0])).toBe('sent');
    expect((await w.recent())[0]).toMatchObject({ status: 'sent', sentAt: expect.any(Number) });
  });

  it('accepted → "Due now", a count on the tab, and the toolbar badge', async () => {
    const w = world();
    const panel = await openPanel(w);
    await generate(panel);
    await until(() => cards(panel).length === 1);

    const select = cards(panel)[0].querySelector('.status-select');
    select.value = 'connected';
    fire(select, 'change');

    await until(() => cards(panel, 'due-list').length === 1);
    const due = cards(panel, 'due-list')[0];
    expect(due.querySelector('.next-text').textContent).toBe('Aoife accepted your invite. Now send your message.');
    expect(due.querySelector('.next-btn').textContent).toBe('Write the message');
    expect(panel.$('due-count').textContent).toBe('1');
    await until(() => w.chrome.action.setBadgeText.mock.calls.some(([a]) => a.text === '1'));
  });

  it('"Write the message" opens their profile, ready for a message with a goal', async () => {
    const { w, panel } = await aoifeAccepted();
    cards(panel, 'due-list')[0].querySelector('.next-btn').click();
    await until(() => panel.$('profile-name').textContent === 'Aoife Murphy');
    await until(() => panel.$('goal').value !== '');
    expect(w.chrome.tabs.update).toHaveBeenCalledWith(1, { url: AOIFE.profileUrl });
    expect(panel.$('tab-current').classList.contains('active')).toBe(true);
    expect(panel.$('channel-message').getAttribute('aria-checked')).toBe('true');
    expect(panel.$('goal').value).toMatch(/accepted my connection request/);
  });

  it('then Generate (Free Mode) thanks them for connecting, and does not ask to connect again', async () => {
    const { w, panel } = await aoifeAccepted();
    cards(panel, 'due-list')[0].querySelector('.next-btn').click();
    await until(() => panel.$('goal').value !== '');
    panel.$('generate-btn').click();
    await until(() => panel.$('status-message').textContent === 'Message ready. Written in Free Mode.');

    const message = panel.$('generated-message').value;
    expect(message).toMatch(/^Hi Aoife,\s+Thanks for connecting!/);
    expect(message).not.toMatch(/accepted my connection request/i); // the goal is an instruction, not text to paste
    expect(message).not.toMatch(/open to connecting/i);              // you are connected already
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('shows your numbers once you have sent something', async () => {
    const now = Date.now();
    const c = (slug, status, extra = {}) => ({
      profileKey: `/in/${slug}/`, profileUrl: `https://www.linkedin.com/in/${slug}/`, name: slug, message: 'x',
      channel: 'note', messageType: 'Referral', tone: 'Casual', status, createdAt: now, updatedAt: now, history: [], ...extra,
    });
    const formal = { messageType: 'Networking', tone: 'Formal' };
    const panel = await openPanel(world({
      local: {
        contacts: {
          '/in/a/': c('a', 'replied'), '/in/b/': c('b', 'replied'), '/in/c/': c('c', 'sent'), '/in/d/': c('d', 'drafted'),
          '/in/e/': c('e', 'sent', formal), '/in/f/': c('f', 'sent', formal), '/in/g/': c('g', 'connected', formal),
        },
      },
    }));
    expect(panel.$('tracker-stats').textContent).toBe(
      '6 contacted · 50% accepted · 33% replied' + 'Working best for you: Referral · Casual (2 of 3 replied)');
  });

  it('a name with quote marks is shown as it is, and cannot add anything to its card', async () => {
    const now = Date.now();
    const drafted = (slug, name) => ({
      profileKey: `/in/${slug}/`, profileUrl: `https://www.linkedin.com/in/${slug}/`, name, message: 'Hi',
      channel: 'note', status: 'drafted', createdAt: now, updatedAt: now, history: [],
    });
    // Anyone can put quote marks in their LinkedIn name. Both people are made up.
    const NICKNAME = 'Niamh "Nia" O\'Connor';
    const CRAFTED  = 'Ciara" style="position:fixed;inset:0;opacity:0';
    const panel = await openPanel(world({
      local: { contacts: { '/in/niamh/': drafted('niamh', NICKNAME), '/in/ciara/': drafted('ciara', CRAFTED) } },
    }));

    const selectFor = Object.fromEntries(cards(panel).map((card) =>
      [card.querySelector('.contact-name').textContent, card.querySelector('.status-select')]));
    expect(Object.keys(selectFor).sort()).toEqual([CRAFTED, NICKNAME].sort());
    expect(selectFor[NICKNAME].getAttribute('aria-label')).toBe(`Status for ${NICKNAME}`);
    expect(selectFor[CRAFTED].getAttribute('aria-label')).toBe(`Status for ${CRAFTED}`);
    // The " in the name did not end the label, so it could not add a style of its own.
    expect(selectFor[CRAFTED].hasAttribute('style')).toBe(false);
    expect(selectFor[CRAFTED].getAttributeNames().sort()).toEqual(['aria-label', 'class']);
  });

  it("brings over v3's Recent list on first open", async () => {
    const panel = await openPanel(world({
      local: { recentContacts: [{ profileUrl: LIAM.profileUrl, name: 'Liam Byrne', message: 'Old draft', timestamp: 1700000000000 }] },
    }));
    const [card] = cards(panel);
    expect(card.querySelector('.contact-name').textContent).toBe('Liam Byrne');
    expect(statusOf(card)).toBe('drafted');
  });

  describe('status updates itself from the profile page', () => {
    const tracked = (status, channel = 'note') => ({
      '/in/aoife/': {
        profileKey: '/in/aoife/', profileUrl: AOIFE.profileUrl, name: 'Aoife Murphy', message: 'Hi Aoife',
        channel, status, createdAt: Date.now(), updatedAt: Date.now(), history: [{ status, at: Date.now(), source: 'you' }],
      },
    });
    function onPage(relationship, contacts) {
      return createWorld({
        local: { contacts },
        tabs: [{ id: 1, url: AOIFE.profileUrl, active: true }],
        pages: { 1: { ...AOIFE, relationship } },
      });
    }

    it('a "Pending" invite on their profile marks your note as sent', async () => {
      const w = onPage('pending', tracked('drafted'));
      const panel = await openPanel(w);
      await until(() => panel.$('tracked-text').textContent.includes('Sent'));
      expect(panel.$('tracked-text').textContent).toMatch(/· seen on LinkedIn$/);
      const [c] = await w.recent();
      expect(c.history.at(-1)).toMatchObject({ status: 'sent', source: 'linkedin' });
    });

    it('once they accept ("1st"), it says to send your message now', async () => {
      const w = onPage('connected', tracked('sent'));
      const panel = await openPanel(w);
      await until(() => panel.$('tracked-next').textContent === 'Aoife accepted your invite. Now send your message.');
      expect((await w.recent())[0].status).toBe('connected');
    });

    it('never moves backwards, and leaves people you messaged alone', async () => {
      let w = onPage('connected', tracked('replied'));
      await openPanel(w);
      await settle(30);
      expect((await w.recent())[0].status).toBe('replied');

      w = onPage('connected', tracked('sent', 'message'));
      await openPanel(w);
      await settle(30);
      expect((await w.recent())[0].status).toBe('sent');
    });
  });

  it('"Clear all" needs a second click', async () => {
    const w = world();
    const panel = await openPanel(w);
    await generate(panel);
    await until(() => cards(panel).length === 1);

    panel.$('clear-recent-btn').click();
    await settle();
    expect(cards(panel)).toHaveLength(1);
    expect(panel.$('clear-recent-btn').textContent).toBe('Click again to delete everyone');
    panel.$('clear-recent-btn').click();
    await until(() => cards(panel).length === 0);
    expect(panel.$('no-recent').classList.contains('hidden')).toBe(false);
  });
});
