import { describe, it, expect } from 'vitest';
import { createFakeChrome } from '../helpers/fake-chrome.js';
import { runIsolated } from '../helpers/load.js';

function boot(chrome) {
  runIsolated('background.js', { chrome, fetch: () => {}, setTimeout, clearTimeout, setInterval, clearInterval, AbortController });
}

describe('opening the UI', () => {
  it('the toolbar icon opens the side panel when Chrome has one', () => {
    const { chrome } = createFakeChrome();
    boot(chrome);
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    expect(chrome.action.setPopup).not.toHaveBeenCalled();
  });

  it('browsers without the Side Panel API get the same page as a popup', () => {
    const { chrome } = createFakeChrome();
    delete chrome.sidePanel;
    boot(chrome);
    expect(chrome.action.setPopup).toHaveBeenCalledWith({ popup: 'sidepanel.html?mode=popup' });
  });
});
