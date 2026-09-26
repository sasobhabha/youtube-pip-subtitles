/** popup.js — popup UI logic */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const openBtn = $('openBtn');

  const DEFAULTS = { fs: 18, bg: true };

  // ------------------------------------------------------------ settings

  chrome.storage.sync.get(DEFAULTS).then((s) => {
    $('fs').value = s.fs;
    $('bg').checked = s.bg;
  });

  $('fs').addEventListener('input', (e) => save({ fs: Number(e.target.value) }));
  $('bg').addEventListener('change', (e) => save({ bg: e.target.checked }));

  function save(patch) {
    chrome.storage.sync.set(patch);
  }

  // ------------------------------------------------------------ open PiP

  openBtn.addEventListener('click', async () => {
    openBtn.disabled = true;
    statusEl.textContent = 'Opening…';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const isYT = tab?.url && /^https:\/\/(www|m)\.youtube\.com\//.test(tab.url);
      if (!isYT) {
        statusEl.textContent = 'Open a YouTube video or Short first.';
        return;
      }
      const resp = await chrome.runtime.sendMessage({ type: 'openPiP' });
      if (resp?.ok && resp.closed) {
        statusEl.textContent = 'PiP window closed.';
      } else if (resp?.ok && resp.needsClick) {
        statusEl.textContent = 'Click anywhere on the YouTube page to open it.';
      } else if (resp?.ok) {
        statusEl.textContent = 'PiP window opened ✓';
      } else {
        statusEl.textContent = resp?.error || 'Failed to open PiP.';
      }
    } catch (e) {
      statusEl.textContent = 'Error: ' + (e?.message || e);
    } finally {
      openBtn.disabled = false;
    }
  });

  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    const isYT = tab?.url && /^https:\/\/(www|m)\.youtube\.com\//.test(tab.url);
    if (!isYT) statusEl.textContent = 'Open a YouTube video or Short first.';
  });
})();
