/**
 * content.js — runs on youtube.com (ISOLATED world)
 *
 * Flow:
 *  1. Find the active HTML5 video (watch page or Shorts).
 *  2. Ask the background worker to read ytInitialPlayerResponse (MAIN world)
 *     for the caption track baseUrl.
 *  3. Fetch the srv3 XML, convert to cues.
 *  4. Open a Document PiP window: move the <video> into it + overlay <div>
 *     rendering the current cue, driven by video timeupdate.
 *  5. Restore the video to its original spot when the PiP window closes.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------ state

  /** @type {null | {pipWin: Window, video: HTMLVideoElement, prevNext: Node|null, prevParent: Node|null, cleanup: Array<() => void>}} */
  let active = null;
  let booting = false;
  /** @type {null | {cleanup: () => void}} */
  let catcher = null;

  // ------------------------------------------------------------ messaging

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'CHECK_PING') {
      sendResponse({ ok: true });
      return undefined;
    }
    if (msg?.type === 'OPEN_PIP') {
      openPip()
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true; // keep channel open for async response
    }
    return undefined;
  });

  // ------------------------------------------------------------ main

  async function openPip() {
    if (active) {
      // Toggle behavior: shortcut/button while open closes the PiP window.
      try { active.pipWin.close(); } catch { /* already closing */ }
      return { ok: true, closed: true };
    }
    if (booting) return { ok: false, error: 'Already opening' };

    // If the page still has transient user activation (e.g. the user just
    // clicked pause), we can open the PiP window right away.
    if (navigator.userActivation?.isActive) {
      booting = true;
      try {
        return await openPipFromActivation();
      } catch (e) {
        if (!/user activation/i.test(String(e))) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      } finally {
        booting = false;
      }
    }

    // Otherwise: requestWindow() needs a fresh click IN the page — extension
    // popup clicks and keyboard shortcuts don't grant it. Arm a click catcher.
    armActivationCatcher();
    return { ok: true, needsClick: true };
  }

  /**
   * Must be invoked from a real user-gesture task: the requestWindow() call
   * happens synchronously before any await, preserving the activation.
   */
  async function openPipFromActivation() {
    const video = pickVideo();
    if (!video) throw new Error('No video found on this page');

    const pip = await openPipWindow(video);
    if (!pip) throw new Error('Could not open Document PiP window');

    const disposeVideoUi = moveVideoIntoPip(pip, video);

    const settings = await chrome.storage.sync.get({ fs: 18, bg: true });

    // Primary source: mirror YouTube's own caption renderer (works on Shorts
    // and ASR with zero network). Fetched tracks remain as fallback data.
    const mirroring = await enableNativeCaptions();
    const { cues, note } = await loadCaptions();
    const overlay = buildOverlay(pip, video, cues, settings, note, mirroring);
    const unsub = onSettingsChange(overlay.applySettings);
    active.cleanup = [overlay.dispose, unsub, disposeVideoUi];
    return { ok: true, cueCount: cues.length, hasCaptions: cues.length > 0 || mirroring, mirroring };
  }

  /**
   * Shows a small in-page pill; the next click in the page grants the user
   * activation that Document PiP requires.
   */
  function armActivationCatcher() {
    if (catcher || active) return;

    const banner = document.createElement('div');
    banner.textContent = '▶  Click to open PiP with subtitles · Esc to cancel';
    banner.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:8%', 'transform:translateX(-50%)',
      'background:#0f0f0f', 'color:#fff', 'padding:12px 20px',
      'border:1px solid rgba(255,255,255,.18)', 'border-radius:24px',
      'font:500 14px/1 Roboto, Arial, sans-serif', 'box-shadow:0 4px 18px rgba(0,0,0,.45)',
      'cursor:pointer', 'z-index:2147483647', 'white-space:nowrap',
    ].join(';');
    (document.documentElement || document.body).append(banner);

    let engaging = false;
    const engage = (ev) => {
      if (ev) {
        // Keep YouTube from treating this click as play/pause or navigation.
        ev.stopPropagation();
        ev.preventDefault();
      }
      if (engaging || active) return;
      engaging = true;
      openPipFromActivation()
        .then(() => disarm())
        .catch((e) => {
          console.warn('[yt-pip-subs]', e);
          engaging = false; // stay armed so the next click can retry
          if (!/user activation/i.test(String(e))) {
            banner.textContent = '⚠ ' + ((e && e.message) || e);
            setTimeout(disarm, 4000);
          }
        });
    };

    const onPointerDown = (ev) => engage(ev);
    const onKey = (ev) => {
      if (ev.key === 'Escape') disarm();
    };

    // pointerdown first (fast path); click as backup activation event.
    const onClick = (ev) => engage(ev);
    window.addEventListener('pointerdown', onPointerDown, { capture: true, once: true });
    window.addEventListener('click', onClick, { capture: true, once: true });
    window.addEventListener('keydown', onKey, { capture: true });
    const timer = setTimeout(disarm, 20000);

    function disarm() {
      clearTimeout(timer);
      banner.remove();
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('click', onClick, { capture: true });
      window.removeEventListener('keydown', onKey, { capture: true });
      catcher = null;
    }

    catcher = { cleanup: disarm };
  }

  /**
   * Subscribes to settings changes while the PiP window is open.
   * @param {(s: object) => void} cb
   * @returns {() => void} unsubscribe
   */
  function onSettingsChange(cb) {
    const listener = (changes, area) => {
      if (area !== 'sync') return;
      cb({
        fs: Number(changes.fs?.newValue ?? 18),
        bg: Boolean(changes.bg?.newValue ?? true),
      });
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  function pickVideo() {
    // Watch pages use html5-main-video; Shorts render per-reel <video>s.
    let v = document.querySelector('video.html5-main-video');
    if (v instanceof HTMLVideoElement && v.readyState > 0) return v;

    for (const s of document.querySelectorAll('ytd-reel-video-renderer video')) {
      if (s instanceof HTMLVideoElement && !s.closest('[hidden]') && s.readyState > 0) return s;
    }
    v = document.querySelector('#shorts-player video, ytd-player video, video');
    return v instanceof HTMLVideoElement ? v : null;
  }

  // ------------------------------------------------------------ captions

  /**
   * Multi-strategy caption loading. Returns cues plus a human-readable note
   * when they could not be loaded, shown in the PiP window for debugging.
   */
  async function loadCaptions() {
    const notes = [];
    try {
      // Strategy 1: the page's own player response (best on watch pages).
      const resp = await chrome.runtime.sendMessage({ type: 'GET_PLAYER_RESPONSE' });
      const tracks = resp?.playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      if (tracks.length) {
        const cues = await fetchTrackCues(pickTrack(tracks));
        if (cues.length) return { cues, note: '' };
        notes.push('track fetch failed');
      } else {
        notes.push('no tracks in page player response');
      }
    } catch (e) {
      notes.push('page probe failed');
    }

    try {
      // Strategy 2/3: InnerTube API — works on Shorts and when the page global
      // is stale/absent. ANDROID client needs no proof-of-origin token.
      const videoId = getVideoId();
      if (!videoId) return { cues: [], note: 'no video id' };
      for (const client of [
        { clientName: 'WEB', clientVersion: '2.20240726.00.00' },
        { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30 },
      ]) {
        try {
          const pr = await innertubePlayer(videoId, client);
          const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          if (!tracks.length) continue;
          const cues = await fetchTrackCues(pickTrack(tracks));
          if (cues.length) return { cues, note: '' };
        } catch { /* try next client */ }
      }
      notes.push('no tracks via InnerTube');
    } catch (e) {
      notes.push('innertube failed');
    }

    const note = notes.join('; ');
    console.warn('[yt-pip-subs] no captions:', note);
    return { cues: [], note };
  }

  function getVideoId() {
    const u = new URL(location.href);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/shorts\/([\w-]{5,})/);
    if (m) return m[1];
    return u.searchParams.get('v');
  }

  async function innertubePlayer(videoId, client) {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: client.clientName === 'WEB' ? 'include' : 'omit',
      body: JSON.stringify({ context: { client }, videoId }),
    });
    if (!res.ok) throw new Error(`innertube ${res.status}`);
    return res.json();
  }

  /** Fetches one caption track, preferring srv3 XML, falling back to json3. */
  async function fetchTrackCues(track) {
    for (const fmt of ['srv3', 'json3']) {
      try {
        const url = new URL(track.baseUrl, location.origin);
        url.searchParams.set('fmt', fmt);
        const res = await fetch(url.href, { credentials: 'include' });
        if (!res.ok) continue;
        const body = await res.text();
        if (fmt === 'srv3') {
          const xml = new DOMParser().parseFromString(body, 'text/xml');
          if (!xml.querySelector('parsererror')) {
            const cues = parseSrv3(xml);
            if (cues.length) return cues;
          }
        } else {
          const cues = parseJson3(JSON.parse(body));
          if (cues.length) return cues;
        }
      } catch { /* try next format */ }
    }
    return [];
  }

  function pickTrack(tracks) {
    const ui = (chrome.i18n?.getUILanguage?.() || navigator.language || 'en').toLowerCase();
    const lang = ui.split('-')[0];
    // Prefer manual captions in the UI language over ASR; then anything else.
    const scored = tracks.map((t) => {
      const tl = (t.languageCode || '').toLowerCase();
      let s = tl === lang ? 2 : tl.startsWith(lang) ? 1 : 0;
      if (t.kind === 'asr') s -= 0.5;
      if (typeof t.vssId === 'string' && t.vssId.startsWith(`.${lang}`)) s += 0.25;
      return { t, s };
    });
    scored.sort((a, b) => b.s - a.s);
    return scored[0].t;
  }

  // ------------------------------------------------------------ srv3 parsing

  /**
   * Converts YouTube's srv3 XML into flat cues sorted by start time.
   * Word-level <s> spans are merged into the cue's plain text.
   * @param {Document} xml
   * @returns {Array<{t:number,d:number,text:string}>}
   */
  function parseSrv3(xml) {
    const cues = [];
    for (const p of xml.getElementsByTagName('p')) {
      const t = Number(p.getAttribute('t') || 0) / 1000;
      const d = Number(p.getAttribute('d') || 0) / 1000;
      const text = (p.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) cues.push({ t, d, text });
    }
    cues.sort((a, b) => a.t - b.t);
    return cues;
  }

  // ------------------------------------------------------------ PiP window

  async function openPipWindow(video) {
    const dpip = /** @type {any} */ (window).documentPictureInPicture;
    if (!dpip) {
      throw new Error('Document Picture-in-Picture needs Chrome 116+');
    }
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    const width = Math.min(854, Math.max(320, Math.round(video.clientWidth || 640)));
    const height = Math.min(480, Math.round(width / aspect));
    return dpip.requestWindow({ width, height, disallowReturnToOpener: false });
  }

  function moveVideoIntoPip(pip, video) {
    const prevParent = video.parentNode;
    const prevNext = video.nextSibling;
    const wasPlaying = !video.paused && !video.ended;
    pip.document.body.style.cssText = 'margin:0;background:#000;overflow:hidden;';
    pip.document.body.append(video);
    video.style.width = '100%';
    video.style.maxHeight = '100vh';
    video.style.display = 'block';
    active = { pipWin: pip, video, prevParent, prevNext, cleanup: [] };

    // Adopting a media element into another document can pause it — resume.
    if (wasPlaying) {
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => { /* needs gesture */ });
    }

    // No native controls in the PiP window: click the video to play/pause.
    const onToggle = () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    };
    video.addEventListener('click', onToggle);

    pip.addEventListener('pagehide', restoreVideo, { once: true });
    try {
      pip.document.title = document.title || 'YouTube PiP';
    } catch { /* title may be restricted */ }

    return () => video.removeEventListener('click', onToggle);
  }

  function restoreVideo() {
    if (!active) return;
    const { video, prevParent, prevNext, cleanup } = active;
    for (const fn of cleanup) {
      try { fn(); } catch { /* best effort */ }
    }
    try {
      video.style.width = '';
      video.style.maxHeight = '';
      video.style.display = '';
      if (prevParent) {
        if (prevNext) prevParent.insertBefore(video, prevNext);
        else prevParent.append(video);
      }
    } catch (e) {
      console.warn('[yt-pip-subs] restore failed', e);
    }
    active = null;
  }

  /**
   * Turns on YouTube's own captions (equivalent to pressing "c") so the
   * native caption renderer becomes observable, then waits for it to
   * actually produce a segment.
   * @returns {Promise<boolean>} true when mirroring is available
   */
  function enableNativeCaptions() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearInterval(iv);
        document.removeEventListener('keydown', onKey, true);
        resolve(ok);
      };
      const pressC = () => {
        // YouTube binds shortcut keys at the document/player level.
        const target =
          document.activeElement && document.activeElement !== document.body
            ? document.activeElement
            : document.querySelector('#movie_player') || document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true, cancelable: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key: 'c', code: 'KeyC', bubbles: true, cancelable: true }));
      };
      const iv = setInterval(() => {
        if (document.querySelector('.ytp-caption-segment, .caption-window')) finish(true);
        else pressC();
      }, 700);
      pressC();
      setTimeout(() => finish(false), 3000);
      const onKey = (e) => {
        if (e.key === 'Escape') finish(false);
      };
      document.addEventListener('keydown', onKey, true);
    });
  }

  /**
   * Mirrors YouTube's native caption renderer (.ytp-caption-segment) into the
   * PiP overlay. True when a native caption was mirrored this tick.
   * @param {HTMLElement} box
   * @returns {boolean}
   */
  function mirrorNativeCaptions(box) {
    const segments = document.querySelectorAll('.ytp-caption-segment');
    if (!segments.length) {
      box.style.display = 'none';
      return false;
    }
    let text = '';
    segments.forEach((s) => {
      text += (s.textContent || '') + '\n';
    });
    text = text.replace(/[ \t]+\n/g, '\n').trim();
    if (!text) {
      box.style.display = 'none';
      return false;
    }
    box.textContent = text;
    box.style.display = 'block';
    return true;
  }

  // ------------------------------------------------------------ overlay

  /**
   * Renders the cue matching the video's current time into an overlay box.
   * @returns {{dispose: () => void, applySettings: (s: object) => void}}
   */
  function buildOverlay(pip, video, cues, settings, note, mirroring) {
    const doc = pip.document;
    const box = doc.createElement('div');
    box.style.cssText = [
      'position:absolute', 'left:50%', 'bottom:6%', 'transform:translateX(-50%)',
      'max-width:86%', 'padding:6px 12px', 'background:rgba(8,8,8,.82)',
      'color:#fff', 'font:600 18px/1.35 Roboto, Arial, sans-serif',
      'text-align:center', 'border-radius:6px', 'pointer-events:none',
      'text-shadow:0 0 4px rgba(0,0,0,.9)', 'display:none',
      'z-index:2147483647', 'white-space:pre-wrap',
    ].join(';');
    doc.body.append(box);
    applySettings(box, settings);

    // Prefer the live mirror of YouTube's native renderer; fall back to the
    // pre-fetched cue list when mirroring is unavailable.
    const render = () => {
      if (mirroring && mirrorNativeCaptions(box)) return;
      const cue = findCue(cues, video.currentTime);
      if (!cue) {
        box.style.display = 'none';
        return;
      }
      box.textContent = cue.text;
      box.style.display = 'block';
    };

    video.addEventListener('timeupdate', render);
    video.addEventListener('seeked', render);
    video.addEventListener('play', render);
    video.addEventListener('pause', render);
    const offEvents = () => {
      video.removeEventListener('timeupdate', render);
      video.removeEventListener('seeked', render);
      video.removeEventListener('play', render);
      video.removeEventListener('pause', render);
    };

    if (!cues.length && !mirroring) {
      box.textContent = note ? `No captions (${note})` : 'No captions available for this video';
      box.style.display = 'block';
      const t = setTimeout(() => { box.style.display = 'none'; }, 6000);
      return {
        dispose: () => { clearTimeout(t); offEvents(); box.remove(); },
        applySettings: () => {},
      };
    }

    // Event listeners handle snappy seeks, but a poll in the PiP window is the
    // reliable driver: its timers are never throttled (the window is always
    // visible), unlike the hidden opener tab, and media events can be dropped
    // for elements adopted across documents.
    const poll = pip.setInterval(render, 200);
    render();

    return {
      dispose: () => {
        pip.clearInterval(poll);
        offEvents();
        box.remove();
      },
      applySettings: (s) => applySettings(box, s),
    };
  }

/** Fallback parser for the json3 caption format. */
  function parseJson3(j) {
    const cues = (j?.events || [])
      .filter((e) => Array.isArray(e.segs))
      .map((e) => ({
        t: (e.tStartMs || 0) / 1000,
        d: (e.dDurationMs || 0) / 1000,
        text: e.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim(),
      }))
      .filter((c) => c.text);
    cues.sort((a, b) => a.t - b.t);
    return cues;
  }

  function findCue(cues, t) {
    let lo = 0;
    let hi = cues.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].t <= t) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (best < 0) return null;
    const c = cues[best];
    return t <= c.t + (c.d > 0 ? c.d : 3) ? c : null;
  }

  function applySettings(box, s) {
    if (!box) return;
    if (s.fs) box.style.fontSize = `${s.fs}px`;
    box.style.background = s.bg === false ? 'transparent' : 'rgba(8,8,8,.82)';
  }
})();
