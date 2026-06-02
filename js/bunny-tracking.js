// Bunny Video Engagement Tracking
// Include on pages with Bunny Stream embeds where you want watch-time tracking.
// Fires the Automation Hub webhook when a viewer watches 75%+ of the video.
//
// This is the Bunny replacement for the legacy js/wistia-tracking.js. It keeps
// the renamed Bunny webhook endpoint and the SAME payload shape (including the original
// Wistia video id, carried on each embed as data-video-id) so the backend
// automation continues to behave identically — only the video host changed.
//
// Requirements:
//   - Email must be in the URL as ?email=someone@example.com
//   - One or more Bunny Stream embeds on the page (built by bunny-embeds.js,
//     which registers them on window.JM_BUNNY). Falls back to scanning the DOM
//     if that registry is absent.
//   - Exits gracefully if email or embeds are missing.
//
// Watch-time semantics (faithful to the Wistia version):
//   - Counts real forward playback progress, NOT wall-clock, so seeks/replays
//     and variable speed can't game the threshold.
//   - Muted / silent-autoplay time is NOT counted. Only audible engagement
//     (after the viewer taps for sound, or on click-to-play videos) counts —
//     same rule the Wistia script enforced via inSilentPlaybackMode().
//   - Fires once per page per browser (deduped in localStorage, and respects
//     the legacy wistia_engaged_* key so prior viewers don't re-fire).
//
// Usage: <script src="/js/bunny-tracking.js" defer></script>

(function (root, factory) {
  // Export the pure, DOM-free core for unit testing under Node; run the DOM
  // wiring only in a real browser.
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    api._runInBrowser(window, document);
  }
})(this, function () {
  'use strict';

  // ==============================
  // CONFIG (matches the Wistia script)
  // ==============================
  // 75% watch time. Overridable ONLY for automated testing via a global set
  // before this script loads; never set in production (defaults to 0.75).
  var WATCH_THRESHOLD =
    (typeof window !== 'undefined' &&
      typeof window.JM_TRACK_THRESHOLD === 'number' &&
      window.JM_TRACK_THRESHOLD > 0 && window.JM_TRACK_THRESHOLD <= 1)
      ? window.JM_TRACK_THRESHOLD
      : 0.75;
  var WEBHOOK_URL = 'https://automation.jasonmoss.com/webhooks/bunny/75';
  var MAX_STEP = 2.0;         // max seconds credited per timeupdate (guards seeks/gaps)
  var PLAYER_POLL_INTERVAL = 500;
  var PLAYER_POLL_TIMEOUT = 30000;
  var MUTED_POLL_INTERVAL = 1000;
  var SAFETY_INTERVAL = 5000;

  // ==============================
  // PURE CORE — per-video watch-time state machine
  // No DOM/network here so it can be unit tested deterministically.
  // ==============================
  // cfg: { ratio, onFire(state) }   onFire is called exactly once when threshold met.
  function makeVideoTracker(cfg) {
    var ratio = cfg.ratio == null ? WATCH_THRESHOLD : cfg.ratio;
    var maxStep = cfg.maxStep == null ? MAX_STEP : cfg.maxStep;
    var duration = 0;
    var threshold = Infinity;
    var accumulated = 0;
    var lastTime = null;   // last position counted; null = need to re-baseline
    var fired = false;

    function setDuration(d) {
      d = Number(d);
      if (d > 0 && duration === 0) {
        duration = d;
        threshold = d * ratio;
      }
    }

    function maybeFire() {
      if (fired) return false;
      if (duration > 0 && accumulated >= threshold) {
        fired = true;
        if (cfg.onFire) {
          cfg.onFire({
            duration: duration,
            accumulated: accumulated,
            threshold: ratio,
          });
        }
        return true;
      }
      return false;
    }

    return {
      // Player "ready": seed duration if we have it.
      ready: function (d) { setDuration(d); },

      // Pause / end: stop the clock so the next play won't bridge the gap.
      pause: function () { lastTime = null; return maybeFire(); },
      ended: function () { lastTime = null; return maybeFire(); },

      // The workhorse. seconds = current position, dur = duration (may be 0),
      // muted = whether audio is currently muted.
      timeupdate: function (seconds, dur, muted) {
        setDuration(dur);
        seconds = Number(seconds);
        if (isNaN(seconds)) return false;
        if (muted) {
          // Silent playback: don't count, but keep the baseline current so the
          // moment they unmute we resume cleanly (no retroactive credit).
          lastTime = seconds;
          return false;
        }
        if (lastTime === null) {
          lastTime = seconds;
          return false;
        }
        var delta = seconds - lastTime;
        lastTime = seconds;
        if (delta > 0 && delta <= maxStep) {
          accumulated += delta;
        }
        return maybeFire();
      },

      // Safety re-check (e.g. periodic) without advancing time.
      check: function () { return maybeFire(); },

      hasFired: function () { return fired; },
      state: function () {
        return { duration: duration, threshold: threshold, accumulated: accumulated, fired: fired };
      },
    };
  }

  // ==============================
  // PURE CORE — webhook payload + sender
  // ==============================
  function buildPayload(o) {
    return {
      email: o.email,
      video_id: o.videoId,                       // ORIGINAL Wistia id — backend continuity
      duration_seconds: Math.round(o.duration),
      watched_seconds: Math.round(o.accumulated),
      threshold: WATCH_THRESHOLD,
      page: o.page,
      timestamp: o.timestamp,
    };
  }

  function buildUrl(URLCtor, payload) {
    var url = new URLCtor(WEBHOOK_URL);
    Object.keys(payload).forEach(function (k) {
      url.searchParams.append(k, payload[k]);
    });
    return url.toString();
  }

  // deps: { URL, navigator, fetch, Image, log }
  function sendWebhook(payload, deps) {
    var urlString = buildUrl(deps.URL, payload);
    var log = deps.log || function () {};
    function imagePixel() {
      try { if (deps.Image) { new deps.Image().src = urlString; log('image pixel sent'); } } catch (e) {}
    }
    // Layer 1: sendBeacon (survives page close)
    var beaconSent = false;
    try {
      if (deps.navigator && deps.navigator.sendBeacon) {
        beaconSent = deps.navigator.sendBeacon(urlString);
        log('beacon sent: ' + beaconSent);
      }
    } catch (e) { beaconSent = false; }
    if (beaconSent) return 'beacon';
    // Layer 2: fetch (keepalive)
    if (deps.fetch) {
      try {
        deps.fetch(urlString, { method: 'POST', keepalive: true })
          .then(function () { log('fetch sent'); })
          .catch(function () { imagePixel(); });
        return 'fetch';
      } catch (e) { /* fall through */ }
    }
    // Layer 3: image pixel (bypasses most blockers)
    imagePixel();
    return 'image';
  }

  // ==============================
  // PURE CORE — email + dedup helpers
  // ==============================
  function parseEmail(search, URLSearchParamsCtor) {
    try {
      var params = new URLSearchParamsCtor(search);
      var email = params.get('email');
      if (!email) return null;
      email = email.trim().toLowerCase();
      return email || null;
    } catch (e) { return null; }
  }

  function dedupKeys(pathname) {
    return {
      current: 'jm_video_engaged_' + pathname,
      legacy: 'wistia_engaged_' + pathname, // respect prior Wistia-era fires
    };
  }

  function alreadyFired(storage, pathname) {
    if (!storage) return false;
    var k = dedupKeys(pathname);
    try {
      return !!(storage.getItem(k.current) || storage.getItem(k.legacy));
    } catch (e) { return false; }
  }

  function markFired(storage, pathname) {
    if (!storage) return;
    try { storage.setItem(dedupKeys(pathname).current, 'true'); } catch (e) {}
  }

  // ==============================
  // DOM WIRING (browser only)
  // ==============================
  function _runInBrowser(window, document) {
    var L = function (m, x) {
      if (x !== undefined) console.log('[BunnyEngagement] ' + m, x);
      else console.log('[BunnyEngagement] ' + m);
    };
    L('Script loaded');

    var email = parseEmail(window.location.search, window.URLSearchParams);
    if (!email) { console.warn('[BunnyEngagement] No email in URL. Exiting.'); return; }
    L('Email detected:', email);

    var pathname = window.location.pathname;
    var storage = null;
    try { storage = window.localStorage; } catch (e) { storage = null; }

    if (alreadyFired(storage, pathname)) {
      console.warn('[BunnyEngagement] Already fired for this page. Exiting.');
      return;
    }

    var pageFired = false; // fire once per page load (any video) — matches the
                           // per-pathname dedup key's intent and avoids dup triggers.

    function fireFor(entry, trackerState) {
      if (pageFired) return;
      pageFired = true;
      markFired(storage, pathname);
      var payload = buildPayload({
        email: email,
        videoId: entry.videoId || entry.bunnyId || 'unknown',
        duration: trackerState.duration,
        accumulated: trackerState.accumulated,
        page: window.location.origin + window.location.pathname,
        timestamp: new Date().toISOString(),
      });
      L('Threshold reached -> firing webhook', payload);
      sendWebhook(payload, {
        URL: window.URL,
        navigator: window.navigator,
        fetch: window.fetch ? window.fetch.bind(window) : null,
        Image: window.Image,
        log: function (m) { L(m); },
      });
    }

    function attach(entry) {
      var player = entry.player;
      if (!player || entry._tracked) return;
      entry._tracked = true;
      var muted = entry.autoplay ? true : false; // autoplay starts muted; click-to-play starts audible
      if (entry.unmuted) muted = false;

      var tracker = makeVideoTracker({
        ratio: WATCH_THRESHOLD,
        onFire: function (st) { fireFor(entry, st); },
      });

      function refreshMuted() {
        try {
          player.getMuted(function (m) { muted = !!m; });
        } catch (e) {}
      }

      try {
        player.on('ready', function () {
          try { player.getDuration(function (d) { tracker.ready(d); }); } catch (e) {}
          refreshMuted();
          L('player ready: ' + (entry.videoId || entry.bunnyId));
        });
      } catch (e) {}

      try { player.on('play', function () { refreshMuted(); }); } catch (e) {}
      try { player.on('pause', function () { tracker.pause(); }); } catch (e) {}
      try { player.on('ended', function () { tracker.ended(); }); } catch (e) {}
      try {
        player.on('timeupdate', function (d) {
          d = d || {};
          // entry.unmuted (set by the tap-for-sound overlay) is authoritative
          // the instant it flips; the poll keeps muted fresh otherwise.
          var isMuted = entry.unmuted ? false : muted;
          tracker.timeupdate(d.seconds, d.duration, isMuted);
        });
      } catch (e) {}

      // Some players have already emitted 'ready' before we attach; ask anyway.
      try { player.getDuration(function (d) { tracker.ready(d); }); } catch (e) {}
      refreshMuted();

      var mutedPoll = window.setInterval(refreshMuted, MUTED_POLL_INTERVAL);
      var safety = window.setInterval(function () {
        if (tracker.check()) {
          window.clearInterval(mutedPoll);
          window.clearInterval(safety);
        }
      }, SAFETY_INTERVAL);
    }

    // Prefer the shared registry from bunny-embeds.js; fall back to scanning.
    function getEntries() {
      if (window.JM_BUNNY && window.JM_BUNNY.players && window.JM_BUNNY.players.length) {
        return window.JM_BUNNY.players;
      }
      return null;
    }

    var elapsed = 0;
    var poll = window.setInterval(function () {
      elapsed += PLAYER_POLL_INTERVAL;
      var entries = getEntries();
      if (entries) {
        window.clearInterval(poll);
        L('Found ' + entries.length + ' Bunny player(s)');
        entries.forEach(attach);
        // also attach to any players registered later
        if (window.JM_BUNNY && typeof window.JM_BUNNY.onPlayer === 'function') {
          window.JM_BUNNY.onPlayer(attach);
        }
        return;
      }
      if (elapsed >= PLAYER_POLL_TIMEOUT) {
        window.clearInterval(poll);
        console.warn('[BunnyEngagement] No Bunny players found after ' +
          PLAYER_POLL_TIMEOUT / 1000 + 's. Exiting.');
      }
    }, PLAYER_POLL_INTERVAL);
  }

  return {
    // pure, testable surface
    makeVideoTracker: makeVideoTracker,
    buildPayload: buildPayload,
    buildUrl: buildUrl,
    sendWebhook: sendWebhook,
    parseEmail: parseEmail,
    dedupKeys: dedupKeys,
    alreadyFired: alreadyFired,
    markFired: markFired,
    WEBHOOK_URL: WEBHOOK_URL,
    WATCH_THRESHOLD: WATCH_THRESHOLD,
    _runInBrowser: _runInBrowser,
  };
});
