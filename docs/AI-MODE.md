# How messages are written (Free Mode and AI Mode)

Since 3.1.0 there is no server and no license key. v4 keeps that: everything runs inside the extension.

| | Free Mode | AI Mode |
|---|---|---|
| **When** | No key in Settings (the default) | You pick an AI provider in Settings (Anthropic, Google or OpenAI) and paste your **own** API key from it |
| **Who writes** | A template, on your device | Claude (`claude-haiku-5-5`), Gemini (`gemini-3.5-flash-lite`) or GPT (`gpt-6-luna`), called straight from the extension |
| **Cost** | Free | The company you picked charges your account: well under a cent per message |
| **What leaves your device** | Nothing | Only when you generate, and only to the company you picked (`api.anthropic.com`, `generativelanguage.googleapis.com` or `api.openai.com`), with your key: the profile you are viewing, your name, bio and goal, what you have in common (from your own profile), and your resume if you ticked "Use my resume in AI Mode" |

Both modes get the same facts: the profile, where the message goes (a connection note of 200 or 300 characters, or a message), type, tone, your goal, what you have in common, and up to 3 talking points from the profile. The code is in [`extension/utils/writer.js`](../extension/utils/writer.js) (what to write) and [`extension/background.js`](../extension/background.js) (the call to the AI).

## Free Mode

A template, but a careful one:

- **The right name.** 3.1.0 took the first word of whatever name the old reader returned. On today's LinkedIn that is the notification count, so it wrote **"Hi (3),"**. v4's reader returns the real name, and the writer also skips a count, a title ("Dr.", "Prof.", "CA", "Smt.", "Md.") or initials ("K.", "S.K."). With no name left, it says "Hello,".
- **Never over LinkedIn's limit.** A note is built to fit 200 characters (300 on Premium) from whole parts: if it is too long, the writer drops your intro first, then shortens the post quote, then uses their role instead. A question is never cut. 3.1.0's note could be longer than LinkedIn allows.
- **Never a word cut in half.** 3.1.0 quoted posts like "…ranking mod…". v4 quotes the post's first sentence, or cuts at a word and adds "…". A dot in "J.P. Morgan", "U.S. Bank" or a list's "1." does not end the sentence.
- **No links, hashtags or sad news in a quote.** Hashtags at the end are left out, and the quote stops before a link. A post with common words for a layoff, an illness or a death ("laid off", "made redundant", "passed away", "died", "R.I.P.") is never quoted. The list errs on the safe side: a happy post it skips only means another opener.
- **Your own words, whole.** "A bit about me:" uses the first sentence of your bio, or nothing. It is never cut short, and "Analyst at J.P. Morgan." stays whole.
- **Common ground first.** "I see we both studied at Trinity College Dublin." is the strongest opener two strangers can have. It stays first when you press **New version**, so a line you just picked is used.
- **Your goal becomes the question.** For example:
  - "Referral for the Data Analyst role at Spotify" → "…would you consider referring me for the Data Analyst role at Spotify?"
  - "Looking for data roles in Dublin" → "…a short chat about data roles in Dublin?"
  - "Ask about her team" → "…a short chat about your team?"

  A goal that reads like a sentence or a question ("Saw your talk at PyData", "How did you get into data?") is left out of the question. A template cannot understand every sentence, so it can still get some goals wrong: read the question before you send. AI Mode always gets all of your goal.
- **The right question.** A message goes to someone you are already connected with, so it never asks them to connect. The type is remembered from last time, so the goal wins when they disagree: a goal about advice gets a chat, even when the type says Referral. "Referring me for …" only ever names a role, and "exploring … together" only names something to work on.
- **Follow-ups make sense.** When the tracker says someone accepted, the message starts "Thanks for connecting!" instead of pasting the tracker's instruction into it. A follow-up keeps what you added to the tracker's goal (a role, a referral).
- **"New version" changes something.** A template gives the same text every time. So each new version asks in other words, and moves on to the next thing about them. A line you picked under **In common** stays first.

## Picking the AI provider

**Settings → AI provider** has three choices: **Anthropic (Claude)**, **Google (Gemini)** and **OpenAI (GPT)**. Anthropic is the default, as before there was a choice. Picking one applies at once.

- **Each company keeps its own key.** Switch to Gemini and back, and your Anthropic key is still there. Anthropic's key keeps the name 3.1.0 saved it under (`userApiKey`), so a key saved before the update keeps working. The others are `geminiApiKey` and `openaiApiKey`.
- **The key is hidden like a password**, with a **Show** / **Hide** button next to it.
- **A key only ever goes to its own company.** Keys start differently: `sk-ant-` is Anthropic's, `AIza` is Google's, and any other `sk-` key is OpenAI's. If the key in the box looks like another company's, nothing is sent. **Test** says so ("This looks like an OpenAI API key, but the AI provider in Settings is Google (Gemini)…"), and so does the header (**Wrong provider**).
- **Chrome asks before Google or OpenAI can be reached.** Anthropic's API is in the manifest's `host_permissions`, as in 3.1.0. Google's and OpenAI's are `optional_host_permissions`: they show no warning at install, and an update is never switched off waiting for you to accept something new. The first time you press **Test** or **Save** with Google or OpenAI picked, Chrome asks you to allow it. Until you do, the header says **Needs permission**, and nothing is sent.

What each company gets:

| | Anthropic | Google | OpenAI |
|---|---|---|---|
| **Address** | `POST https://api.anthropic.com/v1/messages` | `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent` | `POST https://api.openai.com/v1/chat/completions` |
| **Your key goes in** | the `x-api-key` header | the `x-goog-api-key` header (never in the address, where it could end up in logs) | the `Authorization: Bearer …` header |
| **Model** | `claude-haiku-5-5` | `gemini-3.5-flash-lite` | `gpt-6-luna` |
| **Thinking** | off (`thinking: {type: "disabled"}`) | as low as it goes (`thinkingLevel: "MINIMAL"`; it cannot be turned off) | off (`reasoning_effort: "none"`) |
| **Your resume (if ticked)** | a `document` block | an `inlineData` part (`application/pdf`) | a `file` part (`data:application/pdf;base64,…`) |

## AI Mode

What v4 sends to the AI, and why:

- **The real limit.** A free connection note allows 200 characters. 3.1.0 asked for "under 600 characters" for every message, so LinkedIn could not take the note. v4 asks for about 15% under the real limit (models often write a bit more than asked), and says "no sign-off" for notes (LinkedIn shows your name). The panel's meter and **Fit to 200** are the safety net.
- **No thinking for a short note.** Claude Haiku 5.5 thinks before it answers by default, and that thinking counts against `max_tokens`. 3.1.0 allowed only 400 tokens, so a message could come back cut off or empty. v4 turns thinking off (or as low as it goes, for Gemini; see the table above), allows 1,024 tokens, and checks why the AI stopped: it declined (Claude's `refusal`, Gemini's `SAFETY` and similar, OpenAI's `refusal` or `content_filter`), or it ran out of room (`max_tokens`, `MAX_TOKENS`, `length`).
- **Everything from LinkedIn is marked as someone else's text.** Your instructions and your own words (goal, name, bio) go first. The profile, the talking points and the common ground go in tagged blocks (`<profile>`, `<talking_points>`, `<common_ground>`), with every `<` inside them escaped, so a profile cannot close its block and look like an instruction. A last line says to use those blocks as information only and ignore any instructions in them. (Anyone can write anything in their LinkedIn About.)
- **"Do not invent facts."** The prompt says so, and the panel's fact-check flags names in the draft that no source backs up.
- **Your resume, only if you say so.** 3.1.0 still asked for a resume but never sent it anywhere. v4 can send it to Claude as a PDF, so the message can say what you have to offer. But it does so only after you tick **Use my resume in AI Mode** in Settings. Ticking or unticking it applies at once. A resume kept from 3.1.0 is not sent until you tick it. The PDF is labelled as yours. If the company cannot read it (a password, or a renamed file), the message is written without it, and the panel (or the bar in LinkedIn's box) says so. **Remove resume** deletes it. (OpenAI's model page does not say whether `gpt-6-luna` takes PDFs. If OpenAI refuses the resume, the same thing happens: the message is written without it, and you are told.)
- **Plain errors.** Each problem gets one clear sentence, never a raw error:
  - a wrong key, or a key from an organization that blocks browser calls
  - a billing problem, or no credit left
  - a spend limit
  - too many requests, or the company is busy (for Gemini, also "your key's daily limit is used up")
  - the company does not offer its API in your country (Google, OpenAI)
  - no internet
  - a key pasted with a curly quote
  - the time limit: 30 seconds, 60 with a resume

  When trying again would not help, it also shows the company's own reason.
- **The header tells the truth.** When AI Mode cannot work until you act, the badge says why, with the reason under it: **Key not working** (a refused key), **Billing problem** (no credit, a declined card), **Spend limit reached**, **AI Mode not available** (the account cannot use the model, or the company does not offer its API where you are), **Wrong provider** (the key is another company's), or **Needs permission** (Chrome has not allowed Google or OpenAI yet). It is only about the key you have now, for the company picked now: a slow request with your old key, or with the company you picked before, cannot mark, or clear, a new one. A key that failed **Test** is not called "on" when you then press Save.
- **Test checks for real.** The **Test** button sends one tiny request to the company you picked, so a key with no credit left is caught too.
- **Your keys stay out of LinkedIn's pages.** The keys and the resume are saved in `chrome.storage.local`, as in 3.1.0. LinkedIn's own scripts could never read that. But by default, the scripts an extension runs on linkedin.com can. v4's never need to, so the extension locks it to its own pages (`setAccessLevel: TRUSTED_CONTEXTS`). A test in real Chromium (`test/e2e/storage-lock.spec.js`) runs a script where the extension's own scripts run on a LinkedIn page (Chrome's "isolated world" for content scripts). That script now gets "Access to storage is not allowed from this context." (A Chrome that cannot lock local storage refuses the call. Then those scripts can still read it, as in 3.1.0.)

Each call is a plain `fetch` to the address in the table above. For Anthropic it also sends `anthropic-version: 2023-06-01` and `anthropic-dangerous-direct-browser-access: true` (Anthropic's switch for calls made from a browser with the user's own key). The extension has no build step, so it bundles none of the companies' JavaScript SDKs; 3.1.0 calls Anthropic's API the same way.

**Cost, roughly:** Claude Haiku 5.5 costs $0.10 per million input tokens and $0.50 per million output tokens. One message is about 1,000 to 2,000 input tokens (a few thousand more with a resume) and about 100 output tokens: around $0.0002 to $0.001. OpenAI's `gpt-6-luna` has the same list price ($0.10 in, $0.50 out per million tokens). For `gemini-3.5-flash-lite`, Google's small low-cost model, see Google's pricing page.

**Each company's model is set in one place** in `background.js`: `ANTHROPIC_MODEL`, `GEMINI_MODEL` and `OPENAI_MODEL`, each with its thinking setting next to it (another model may need another setting, as the comments there say). The list of companies (names, key fields, addresses) is in [`extension/utils/providers.js`](../extension/utils/providers.js). Haiku 5.5 is the model 3.1.0 chose: fast and very cheap for a student paying with their own key. A larger model would write better messages, at many times the cost.

## If a server is added later

Asking every student for their own API key is the weakest part of 3.1.0's design: most students do not have one. A small server could hold one shared key instead (students never see it), set a daily limit per user, and keep everything above. Ideas from the old server that would still matter then:

1. **Send the resume once** and keep a short summary, instead of sending the PDF with every message.
2. **Stream the message** so it appears as it is written.
3. **Outcome data, opt-in:** the tracker knows each message's type, tone, length, and whether the person accepted and replied. With the user's consent, anonymous counts (no names, no text) would show which messages actually get replies.
4. **Rate-limit any key-check endpoint**, a common brute-force target.
