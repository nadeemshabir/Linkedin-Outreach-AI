'use strict';

// content_script.js — runs on linkedin.com. It reads the profile page only
// when the extension asks for it (never on its own), using scraper.js.

// This file can be injected twice (see askContentScript in background.js);
// listen only once.
if (!globalThis.__outreachContentScript) {
  globalThis.__outreachContentScript = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Full read: load the lazy sections, then read everything.
    if (msg.action === 'scrapeProfile') {
      LinkedInScraper.loadLazySections(document)
        .then(() => sendResponse({ success: true, data: LinkedInScraper.scrape(document) }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // A quick look for the side panel: the top card only, no scrolling.
    if (msg.action === 'peekProfile') {
      LinkedInScraper.waitForTopCard(document).then(() => {
        const top = LinkedInScraper.readTopCard(document);
        sendResponse({
          success: true,
          data: { ...top, profileUrl: window.location.href.split('?')[0] },
        });
      });
      return true;
    }
    return undefined;
  });
}
