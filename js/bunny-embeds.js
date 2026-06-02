// Bunny Stream embed initializer for jasonmoss.com
// ------------------------------------------------
// Replaces Wistia's client-side player behaviors with the Bunny equivalent:
//   - Loads Player.js once and wraps every Bunny iframe (iframe[data-bunny-id]).
//   - For autoplay-muted videos, draws a "Tap for sound" overlay that unmutes
//     on tap — the same affordance Wistia's clickForSound provided.
//   - Registers every player on window.JM_BUNNY so bunny-tracking.js (loaded
//     only on tracking pages) can hook in without creating duplicate players.
//
// Captions default-on and player color are handled by the embed URL
// (?captions=<lang>) and the Bunny library skin, not here.
//
// Usage: <script src="/js/bunny-embeds.js" defer></script>

(function () {
  'use strict';
  var PLAYERJS_SRC = 'https://assets.mediadelivery.net/playerjs/playerjs-latest.min.js';

  // ---- shared registry --------------------------------------------------
  var JM = (window.JM_BUNNY = window.JM_BUNNY || { players: [], _cbs: [] });
  JM.players = JM.players || [];
  JM._cbs = JM._cbs || [];
  // onPlayer(cb): replay existing players to cb, then call cb for future ones.
  JM.onPlayer = function (cb) {
    try { JM.players.forEach(function (p) { cb(p); }); } catch (e) {}
    JM._cbs.push(cb);
  };
  function registerPlayer(entry) {
    JM.players.push(entry);
    JM._cbs.forEach(function (cb) { try { cb(entry); } catch (e) {} });
  }

  // ---- one-time styles --------------------------------------------------
  function injectStyles(document) {
    if (document.getElementById('jm-bunny-styles')) return;
    // Understated, Wistia-style "Click for sound" prompt: small neutral pill in
    // the lower-left. The whole video is the click target (click anywhere to
    // unmute). Subtle on purpose — Wistia's clickForSound is not a loud overlay.
    var css =
      '.jm-tap-sound{position:absolute;inset:0;z-index:3;display:flex;align-items:flex-end;' +
      'justify-content:flex-start;cursor:pointer;border:0;padding:0;margin:0;background:transparent;' +
      '-webkit-tap-highlight-color:transparent;}' +
      '.jm-tap-sound__pill{display:inline-flex;align-items:center;gap:.45em;margin:0 0 5.5% 3.5%;' +
      'padding:.5em .8em;border-radius:5px;background:rgba(20,20,22,.68);color:#fff;' +
      'font:500 clamp(11px,1.3vw,14px)/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
      'letter-spacing:.01em;box-shadow:0 2px 10px rgba(0,0,0,.28);' +
      'transition:opacity .25s,background .2s;}' +
      '.jm-tap-sound:hover .jm-tap-sound__pill{background:rgba(20,20,22,.85);}' +
      '.jm-tap-sound__icon{width:1em;height:1em;flex:0 0 auto;fill:#fff;}' +
      '.jm-tap-sound.is-hiding{opacity:0;pointer-events:none;}';
    var style = document.createElement('style');
    style.id = 'jm-bunny-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  var SPEAKER_SVG =
    '<svg class="jm-tap-sound__icon" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23z"/>' +
    '</svg>';

  function addTapForSound(document, entry) {
    if (entry.overlay && entry.overlay.parentNode) return; // idempotent: 'ready' can fire more than once
    var iframe = entry.iframe;
    var parent = iframe.parentNode;
    if (!parent) return;
    // overlay needs a positioned container
    var pos = (window.getComputedStyle ? getComputedStyle(parent).position : parent.style.position);
    if (pos === 'static' || !pos) parent.style.position = 'relative';

    var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    var label = isTouch ? 'Tap for sound' : 'Click for sound';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jm-tap-sound';
    btn.setAttribute('aria-label', label);
    btn.innerHTML = '<span class="jm-tap-sound__pill">' + SPEAKER_SVG + '<span>' + label + '</span></span>';
    entry.overlay = btn;

    // Remove every overlay in this container (covers any duplicate from
    // repeated 'ready') and mark the video as unmuted for the tracker.
    function retire() {
      entry.unmuted = true;
      var overlays = parent.querySelectorAll('.jm-tap-sound');
      Array.prototype.forEach.call(overlays, function (o) { o.classList.add('is-hiding'); });
      window.setTimeout(function () {
        var olds = parent.querySelectorAll('.jm-tap-sound');
        Array.prototype.forEach.call(olds, function (o) { if (o.parentNode) o.parentNode.removeChild(o); });
      }, 280);
    }
    // User tapped the prompt: turn sound on, then retire the overlay.
    function unmute() {
      if (entry.unmuted) return;
      try { entry.player.play(); } catch (e) {}
      try { entry.player.unmute(); } catch (e) {}
      try { entry.player.setVolume(100); } catch (e) {}
      retire();
    }
    btn.addEventListener('click', unmute);
    parent.appendChild(btn);

    // If the video is already playing with sound (e.g. a returning viewer whose
    // player remembered their unmute preference, or native-control unmute), the
    // prompt is pointless — retire it. Poll briefly to catch a play we missed.
    function checkAlreadyAudible() {
      if (entry.unmuted) return;
      try { entry.player.getMuted(function (m) { if (m === false) retire(); }); } catch (e) {}
    }
    try { entry.player.on('play', checkAlreadyAudible); } catch (e) {}
    var checks = 0;
    var iv = window.setInterval(function () {
      checks++;
      if (entry.unmuted || checks > 6) { window.clearInterval(iv); return; }
      checkAlreadyAudible();
    }, 800);
  }

  // ---- init -------------------------------------------------------------
  function initOne(document, iframe) {
    if (iframe.__jmInit) return;
    iframe.__jmInit = true;
    var entry = {
      iframe: iframe,
      bunnyId: iframe.getAttribute('data-bunny-id') || null,
      videoId: iframe.getAttribute('data-video-id') || null,
      autoplay: iframe.getAttribute('data-autoplay') === 'true',
      unmuted: false,
      player: null,
    };
    try {
      entry.player = new window.playerjs.Player(iframe);
    } catch (e) {
      // Player.js missing/failed: still register a stub so tracking can no-op,
      // and skip the overlay (native controls still allow unmuting).
      registerPlayer(entry);
      return;
    }
    if (entry.autoplay) {
      entry.player.on('ready', function () { addTapForSound(document, entry); });
      // ready may have already fired before we attached; draw it anyway shortly.
      window.setTimeout(function () { if (!entry.overlay) addTapForSound(document, entry); }, 1200);
    }
    registerPlayer(entry);
  }

  function initAll() {
    var document = window.document;
    injectStyles(document);
    var iframes = document.querySelectorAll('iframe[data-bunny-id]');
    Array.prototype.forEach.call(iframes, function (f) { initOne(document, f); });
  }

  function start() {
    if (window.playerjs) { initAll(); return; }
    var existing = document.querySelector('script[src*="playerjs"]');
    if (existing) {
      existing.addEventListener('load', initAll);
      // in case it's already loaded
      if (window.playerjs) initAll();
      return;
    }
    var s = document.createElement('script');
    s.src = PLAYERJS_SRC;
    s.async = true;
    s.onload = initAll;
    s.onerror = function () {
      // Player.js failed: register stubs so the page still works (native player).
      console.warn('[JM_BUNNY] Player.js failed to load; using native player only.');
      var iframes = document.querySelectorAll('iframe[data-bunny-id]');
      Array.prototype.forEach.call(iframes, function (f) {
        if (f.__jmInit) return; f.__jmInit = true;
        registerPlayer({ iframe: f, bunnyId: f.getAttribute('data-bunny-id'),
          videoId: f.getAttribute('data-video-id'),
          autoplay: f.getAttribute('data-autoplay') === 'true', unmuted: false, player: null });
      });
    };
    document.head.appendChild(s);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
