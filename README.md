# LinkedIn Outreach AI — v4

An improved version of Ark's LinkedIn outreach extension.
**Not a rewrite:** same plain JavaScript, same Ark server and API, no framework.
Commit [`f8f21ec`](../../commit/f8f21ec) is the original v3.0.2 exactly as received; every change after it is a small, tested commit.

> In one line: v3 writes a message in a popup. v4 helps you get a reply — it stays next to LinkedIn, never loses your work, knows LinkedIn's limits, checks the draft before you send it, and reminds you to follow up.

## What changed

| | v3.0.2 (before) | v4 (now) |
|---|---|---|
| **Where it lives** | Popup that closes when you click the page | Side panel that stays open and follows you from profile to profile |
| **Losing work** | Close the popup mid-run → result and quota lost | The background owns each run; close and reopen, the message is there |
| **Deep Mode** | Two buttons; the second one hidden below the fold | One click, with progress in plain words |
| **Length** | Plain "413 chars" counter | Knows a connection note is 200 chars (300 Premium): live meter, **Fit to 200**, note budget |
| **Personal touch** | — | **Common ground**: same school, employer, city, "both studied in India" |
| **Quality** | — | **Message check**: specific? clear ask? cliché opener? and a **fact-check** for names no source backs up |
| **After sending** | "Last 5 contacts" | **Tracker**: Drafted → Sent → Connected → Replied, follow-ups due, reply rates, CSV |
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

Two more bugs were found in v4's own new code by its tests (a lock race in the job runner, and a migration write-back race), and fixed before shipping. Details are in the commit messages.

## Try it

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the **`extension/`** folder.
2. Click the toolbar icon. The side panel opens.
3. **Settings** → paste your `ARK-…` license key → **Verify**.
   Optional: open your own LinkedIn profile and click **Use the profile I'm on** (for common ground).
4. Open any LinkedIn profile → **Generate message**.

## Run the tests

```bash
npm install
npm test                        # unit tests: the real panel + background, in a fake browser
npx playwright install chromium
npm run test:e2e                # the real extension in Chromium, LinkedIn and server faked
npm run check:permissions       # fails if the manifest would show a new install warning
npm run screenshots             # side-panel screenshots into docs/screenshots/
```

No LinkedIn account or license key is needed for any of these: LinkedIn pages and Ark's server are local fakes, and all other network traffic is blocked.

## How it is built

| File | Job |
|---|---|
| `extension/background.js` | Runs each generation as a **job** and saves every step in `chrome.storage.session`. Talks to Ark's server. |
| `extension/sidepanel.*` | The UI. Draws whatever state is saved; holds no work of its own. |
| `extension/content_script.js` | Reads the LinkedIn page — only when asked, never in the background. |
| `extension/utils/limits.js` | LinkedIn length limits and "Fit to 200". |
| `extension/utils/strength.js` | The message check and fact-check. |
| `extension/utils/common-ground.js` | What you and the other person share. |
| `extension/utils/tracker.js` | Statuses, next steps, stats, CSV. (Grew out of `utils/cache.js`.) |
| `test/` | `unit/` (Vitest + happy-dom, real code), `e2e/` (Playwright, real extension). |

## Privacy, safety and permissions

- **You always press Send.** The extension never sends, connects or messages on LinkedIn for you. No bulk actions, no crawling. (Automation gets LinkedIn accounts restricted — a disaster for a student's job search.)
- **No new data leaves your laptop.** The tracker and your own profile live in `chrome.storage.local`. The extension calls the same Ark endpoints as before; extra context (length limit, common ground, goal) travels inside fields the server already reads.
- **Fewer permissions.** `tabs` removed. Added only `sidePanel` and `alarms`, which show no install warning — so updating does not switch the extension off for existing users. CI enforces this.

## Not done yet / known limits

- **Not yet run against Ark's live server.** It needs a test license key. All tests use a fake server that follows the real API's request and response shapes.
- **Not yet checked on today's live LinkedIn page.** The scraper fixes are tested on sample pages laid out the way the v3 scraper expects.
- **Server-side improvements** (send the resume once, a proper `context` field, streaming) need Ark's backend. They are written up in [docs/API-PROPOSAL.md](docs/API-PROPOSAL.md), not faked on the client.
