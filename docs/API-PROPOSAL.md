# Server API: proposed changes

The v4 extension works with today's server, unchanged. While building it, I found a few things that only the server can fix. They are listed here, most valuable first. Each one is backward compatible: old clients keep working.

I could not see the server code or test with a real key, so where I say what the server does, I mean what the client code implies. Please correct me where that is wrong.

---

## 1. Send the resume once, not with every message

**Today:** every Quick and Deep request includes `resumeBase64` — up to a 4 MB PDF, about 5.3 MB as base64.

**Cost:** slow on student Wi-Fi and mobile hotspots, and if the server passes the PDF to the model each time, a large token bill per message.

**Proposal:**
- `POST /api/resume` with `{ key, resumeBase64 }` → `{ resumeId, summary }`. The server parses it once and keeps a short text summary.
- Generate requests send `resumeId` instead of `resumeBase64`. Keep accepting `resumeBase64` for old clients.

## 2. A real `context` field

**Today:** there is no field for "this is a 200-character connection note", "mention our shared university", or "the goal is a referral for the Data Analyst role".

**What v4 does meanwhile** (without risking a strict request check rejecting new top-level fields):
- Quick Mode: one clearly marked line at the end of `userBio`, plus `profileData.outreachContext`.
- Deep Mode: `enrichmentJSON.outreachContext`, and common ground first in `enrichmentJSON.topHooks`.

**Proposal:** an optional top-level field on both generate endpoints:

```json
"context": {
  "channel": "note",
  "maxChars": 200,
  "commonGround": ["We both studied at Trinity College Dublin"],
  "goal": "Referral for the Data Analyst role at Spotify"
}
```

When it is present, the server puts it in the prompt and the client stops adding the bio line. Ideally the server also checks the length and retries once if a note comes back too long.

## 3. Deep Mode does not know who the sender is

**Today:** `/api/generate/deep` gets `profileJSON`, `enrichmentJSON`, `messageType`, `tone` and `resumeBase64` — but not `userName` or `userBio`. Without a resume, the writer knows nothing about the sender.

**Proposal:** accept `userName` and `userBio` on `/deep` too (the client can start sending them as soon as the server reads them).

## 4. One error format

**Today:** `/api/validate` answers `200 { valid: false, reason }`, while generate answers `403 { error }`.

**Proposal:** every failure returns a matching HTTP status and `{ success: false, error, code }`, with codes like `invalid_key`, `quota_exceeded`, `bad_request`. v4 already maps statuses to plain-English messages, so this only makes them more precise.

## 5. `remaining` on every generate response

Deep returns `remaining`; Quick does not. Returning it from both lets the header badge ("● 17 left today") stay accurate.

## 6. Streaming for Deep Mode

The writing step is the longest wait users see. Server-sent events on `/api/generate/deep` would let the panel show the message as it is written. The panel already has the progress UI for it.

## 7. Outcome data, opt-in (the biggest long-term lever)

v4's tracker knows, per message: type, tone, channel, length, and whether the person accepted and replied. With user opt-in, an anonymous `POST /api/feedback { messageType, tone, channel, length, outcome }` (no names, no message text) would let Ark measure which prompts actually get replies, instead of guessing.

## 8. Rate-limit `/api/validate`

General hardening rather than a finding: key-check endpoints are a common brute-force target. I did not test this against your server.
