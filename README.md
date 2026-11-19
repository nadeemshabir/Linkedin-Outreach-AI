# LinkedIn Outreach AI — v4

An improved version of Ark's LinkedIn outreach extension.
**Not a rewrite:** same plain JavaScript, same Ark server and API, no framework.
Commit [`f8f21ec`](../../commit/f8f21ec) is the original v3.0.2 exactly as received; every change after it is a small, tested commit.

> In one line: v3 writes a message in a popup. v4 helps you get a reply — it reads today's LinkedIn correctly, writes straight into LinkedIn's own note box, never loses your work, knows LinkedIn's limits, checks the draft before you send it, and reminds you to follow up.

**The biggest finding:** on LinkedIn's 2026 profile page, v3 reads almost nothing. Run unchanged on a live profile, it sent the AI a name with the notification count stuck on (like "(6) Jane Doe") and an empty profile, so every "personalized" message was generic. v4's new reader gets every field. See [Reading LinkedIn](#reading-linkedin-v3-vs-v4).

<p>
  <img src="docs/screenshots/panel-4-quick-done.png" width="260" alt="Side panel: a draft with the 200-character meter, Fit to 200, common ground and the message check">
  <img src="docs/screenshots/panel-7-tracker.png" width="260" alt="Tracker: follow-ups due, statuses and reply rates">
</p>
<img src="docs/screenshots/inpage-2-note-written.png" width="560" alt="Write a note to Aoife, inside LinkedIn's Add a note box: the note is fitted to 200 characters and Send is left to you">

<sub>The real extension in Chromium (`npm run screenshots`). The LinkedIn page is a test page that copies the structure of LinkedIn's 2026 profile page; the person and the messages are made up.</sub>

## What changed

| | v3.0.2 (before) | v4 (now) |
|---|---|---|
| **Reading the profile** | On today's LinkedIn: name with "(6)" in front, everything else empty | Every field, checked on live profiles; your scroll position is put back |
| **Writing where you type** | Copy from the popup, paste into LinkedIn | **✨ Write a note to Aoife** inside LinkedIn's own "Add a note" / message box; fitted to the box's limit; you press Send |
| **Where it lives** | Popup that closes when you click the page | Side panel that stays open and follows you from profile to profile |
| **Losing work** | Close the popup mid-run → result and quota lost | The background owns each run; close and reopen, the message is there |
| **Deep Mode** | Two buttons; the second one hidden below the fold | One click, with progress in plain words |
| **Length** | Plain "413 chars" counter | Knows a connection note is 200 chars (300 Premium): live meter, **Fit to 200**, note budget |
| **Personal touch** | — | **Common ground**: same school, employer, city, "both studied in India" |
| **Quality** | — | **Message check**: specific? clear ask? cliché opener? and a **fact-check** for names no source backs up |
| **After sending** | "Last 5 contacts" | **Tracker**: Drafted → Sent → Connected → Replied, follow-ups due, reply rates, CSV. Moves itself forward when a profile shows "Pending" or "1st" |
| **Key status** | "● Active" for any saved text | Real status from the server: "● 17 left today" / "Invalid key" |
| **Errors** | `Unexpected token '<'…`, endless spinner | Plain-English errors and time limits |
| **Install warning** | "Read your browsing history" (`tabs`) | Removed; no new warnings (guarded in CI) |

Bugs fixed, each with a test that failed before the fix:

| # | Bug | Commit |
|---|---|---|
| B1 | Job titles like "**Mar**keting Manager", "**Jun**ior Analyst" were skipped as dates | `c54e744` |
| B2 | Only Indian locations recognised: jobs in London or Toronto shifted the whole job list | `c54e744` |
| B3 | Popup taller than Chrome's 600px limit | `6321e56` |
| B4 | Deep Mode's second button hidden below the fold | `0d31f92` |
| B5 | "● Active" shown for keys the server rejects | `a3dce6e` |
| B6 | Closing the popup lost the run, the message and the used quota | `0d31f92` |
| B7 | Edits and "Regenerate" never reached Recent; Deep Mode contacts could overwrite each other | `eac5e6e` |
| B8 | Server error pages shown as raw JSON parse errors | `35b8e1b` |
| B9 | No time limit on server calls | `35b8e1b` |
| B10 | Unused `tabs` permission (install warning) | `2356afc` |
| B11 | Dead code in the background | `2356afc` |
| B12 | On the 2026 page: name read from the tab title with the notification count (like "(6) Jane Doe"); no headline or location (there is no `<h1>` any more) | `d362953` |
| B13 | On the 2026 page: Experience, Education and Skills never load, because v3 scrolls the window and the page now scrolls an inner box | `d362953` |
| B14 | On the 2026 page: About skipped, junk "skills", the person's own headline read as a "post" | `d362953` |

Two more bugs were found in v4's own new code by its tests (a lock race in the job runner, and a migration write-back race), and fixed before shipping. Details are in the commit messages.

## Reading LinkedIn: v3 vs v4

Checked by hand on live LinkedIn (Nov 2026), on a public figure's profile and on the author's own: v3, run unchanged, got the name wrong and left everything else empty; v4 read every field, including several roles at one company, in 1.5–2.3 seconds.

Measured with `npm run bench`: the original v3 code against v4's reader, in real Chromium, on 8 made-up profiles built with the live page's structure ([full table](docs/benchmark.md)).

| Fields read correctly | v3.0.2 | v4 |
|---|---:|---:|
| You open a profile and click right away | 8% | 100% |
| You scrolled the whole page yourself first | 36% | 100% |

Read the 100% with care: the test pages copy the structure that v4's reader was built from, so they cannot surprise it. The live checks are the stronger evidence. What the test pages are good for is keeping it that way: if a change breaks a field, a test fails.

## Try it

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the **`extension/`** folder.
2. Click the toolbar icon. The side panel opens.
3. **Settings** → paste your `ARK-…` license key → **Verify**.
   Optional: open your own LinkedIn profile and click **Use the profile I'm on** (for common ground).
4. Open any LinkedIn profile → **Generate message**.
5. Or write straight into LinkedIn: on a profile, click **Connect → Add a note** (or **Message**). A **✨ Write a note to …** button appears inside LinkedIn's box. Click it, read the note, then press LinkedIn's **Send** yourself.

**No license key or LinkedIn account?** Run `npm install`, then `npm run demo`. It opens the real extension in a Chromium window, on two test profiles (made-up people, LinkedIn's 2026 page structure) with a fake Ark server that gives example answers. Every other site is blocked. Open the side panel from the extension's toolbar icon (under the puzzle-piece button).

## Run the tests

```bash
npm install
npm test                        # unit tests: the real panel + background, in a fake browser
npx playwright install chromium
npm run test:e2e                # the real extension in Chromium, LinkedIn and server faked
npm run check:permissions       # fails if the manifest would show a new install warning
npm run bench                   # v3's page reader against v4's, on 8 test profiles
npm run screenshots             # side-panel screenshots into docs/screenshots/
```

No LinkedIn account or license key is needed for any of these: LinkedIn pages and Ark's server are local fakes, and all other network traffic is blocked.

## How it is built

| File | Job |
|---|---|
| `extension/background.js` | Runs each generation as a **job** and saves every step in `chrome.storage.session`. Talks to Ark's server. |
| `extension/sidepanel.*` | The UI. Draws whatever state is saved; holds no work of its own. |
| `extension/scraper.js` | Reads a 2026 LinkedIn profile: finds parts by stable test ids and headings, never by class names; loads the lazy sections by scrolling LinkedIn's inner box, then puts your scroll back. |
| `extension/content_script.js` | Answers the background's "read this page" requests — only when asked. |
| `extension/inpage.js` | The **✨ Write with Ark** button inside LinkedIn's note and message boxes. |
| `extension/utils/limits.js` | LinkedIn length limits and "Fit to 200". |
| `extension/utils/strength.js` | The message check and fact-check. |
| `extension/utils/common-ground.js` | What you and the other person share. |
| `extension/utils/tracker.js` | Statuses, next steps, stats, CSV. (Grew out of `utils/cache.js`.) |
| `test/` | `unit/` (Vitest + happy-dom, real code), `e2e/` (Playwright, real extension). |

## Privacy, safety and permissions

- **You always press Send.** The extension never sends, connects or messages on LinkedIn for you. No bulk actions, no crawling. (Automation gets LinkedIn accounts restricted — a disaster for a student's job search.) The in-page button only writes into a box you opened, only when you click it, and never presses Send; a test checks that no Send is ever pressed.
- **It checks who the box is for.** If the open chat is with someone else, or you clicked Connect on someone in "People you may know", the button says so and writes nothing — so a note written for one person never lands in an invite to another.
- **It leaves LinkedIn's page alone.** The button lives in its own small bar (its own shadow root) inside LinkedIn's box; no LinkedIn element is changed or restyled. LinkedIn's page can see that bar, so it can tell the extension is installed — as with any extension that adds a button to a page.
- **No new data leaves your laptop.** The tracker and your own profile live in `chrome.storage.local`. The extension calls the same Ark endpoints as before; extra context (length limit, common ground, goal) travels inside fields the server already reads.
- **Fewer permissions.** `tabs` removed. Added only `sidePanel` and `alarms`, which show no install warning — so updating does not switch the extension off for existing users. CI enforces this.

## Not done yet / known limits

- **Not yet run against Ark's live server.** It needs a test license key. All tests use a fake server that follows the real API's request and response shapes.
- **Checked on live LinkedIn (Nov 2026):** the page reader, on two profiles; the message box's structure (inside a shadow root); the "Invite <Name> to connect" labels.
- **Not yet checked on live LinkedIn:** the 2026 "Add a note" box itself (the button finds it by role and wording: a dialog about a note or invitation with a text box), and a real click on the in-page button (that needs a license key and a real chat or invite). Both are tested in real Chromium on pages that copy LinkedIn's structure.
- **English LinkedIn only, for the in-page button.** It looks for words like "Messaging", "note", "Invite … to connect". In another language it may not appear; the side panel still works.
- **The in-page button always uses Quick Mode** (it should be fast). For Deep Mode, use the side panel — both share the same draft.
- **Server-side improvements** (send the resume once, a proper `context` field, streaming) need Ark's backend. They are written up in [docs/API-PROPOSAL.md](docs/API-PROPOSAL.md), not faked on the client.
