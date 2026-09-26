/**
 * background.js — MV3 service worker
 * Responsibilities:
 *  - Route "openPiP" from popup / keyboard shortcut to the active YouTube tab
 *  - Execute a probe in the page's MAIN world to read ytInitialPlayerResponse
 *    (content scripts run in an isolated world and cannot see page JS globals)
 */

// ---------------------------------------------------------------- shortcuts

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-pip') return;
  openPipInActiveTab();
});

// ---------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'openPiP') {
    openPipInActiveTab().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }

  // Content script asks for the page's player response (caption tracks).
  if (msg?.type === 'GET_PLAYER_RESPONSE') {
    (async () => {
      const tabId = sender?.tab?.id;
      if (tabId == null) return sendResponse({ ok: false, error: 'no tab' });
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          injectImmediately: true,
          func: readPlayerResponse,
        });
        // res.result is a plain JSON-derived object → structured-clone safe
        return sendResponse({ ok: true, playerResponse: res?.result ?? null });
      } catch (e) {
        return sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  return undefined;
});

// ---------------------------------------------------------------- helpers

async function openPipInActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: 'No active tab' };

  if (!tab.url || !/^https:\/\/(www|m)\.youtube\.com\//.test(tab.url)) {
    return { ok: false, error: 'Not a YouTube tab' };
  }

  // Ensure the content script is present (it may not be if the tab loaded
  // before the extension was installed/reloaded).
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'CHECK_PING' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  }

  const resp = await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_PIP' });
  return resp || { ok: false, error: 'No response from content script' };
}

/**
 * Runs in the page's MAIN world. YouTube exposes the player response as a page
 * global; the shorts player also exposes getPlayerResponse() on its element.
 * @returns {object | null} the ytInitialPlayerResponse object, or null
 */
function readPlayerResponse() {
  try {
    let pr = window.ytInitialPlayerResponse || null;
    const player = document.querySelector('#movie_player, #shorts-player');
    if (player && typeof player.getPlayerResponse === 'function') {
      const live = player.getPlayerResponse();
      // Prefer the live one when it has captions (it reflects the current clip).
      if (live && live.captions) pr = live;
    }
    return pr;
  } catch {
    return null;
  }
}
