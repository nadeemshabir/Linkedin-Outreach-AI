# Scraper benchmark

The original v3.0.2 scraper (commit `f8f21ec`, run unchanged) against scraper v2, in real Chromium,
on 8 made-up profiles built with the structure of LinkedIn's 2026 profile page
(see `test/fixtures/`). Run it yourself: `npm run bench`.

## Fresh visit (you open a profile and click the extension right away)

| Field | v3.0.2 | v2 |
|---|---:|---:|
| Name | 0% | 100% |
| Headline | 0% | 100% |
| Location | 0% | 100% |
| About | 13% | 100% |
| Jobs (title + company) | 0% | 100% |
| Schools | 0% | 100% |
| Skills (F1) | 0% | 100% |
| Posts | 50% | 100% |
| **Overall** | 8% | 100% |

## After you scrolled the whole page yourself

| Field | v3.0.2 | v2 |
|---|---:|---:|
| Name | 0% | 100% |
| Headline | 0% | 100% |
| Location | 0% | 100% |
| About | 13% | 100% |
| Jobs (title + company) | 42% | 100% |
| Schools | 100% | 100% |
| Skills (F1) | 79% | 100% |
| Posts | 50% | 100% |
| **Overall** | 36% | 100% |

## Why v3 scores so low

- The page scrolls inside `<main>`, so v3's `window.scrollTo` does nothing: on a fresh visit,
  Experience, Education and Skills never load.
- There is no `<h1>`: v3 takes the name from the page title, notification count included
  ("(3) Aoife Murphy"), and finds no headline or location.
- About is one span with `<br>` line breaks, which v3 skips; v3 reads the "used at…" lines
  under each skill as skills; and in Activity it reads the author's headline as a post.

The same failures were confirmed on live LinkedIn profiles (Nov 2026). Those results are
described in the write-up; no real profile data is stored in this repo.
