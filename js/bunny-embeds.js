// Bunny + Plyr video initializer for jasonmoss.com
// ------------------------------------------------------------------
// Turns every <video class="jm-player" data-bunny-id="…"> on the page into a
// self-hosted Plyr player that streams the Bunny HLS rendition. This replaces
// the Bunny iframe embed so we get Wistia-parity behavior we control directly:
//
//   • Captions that SCALE with the player size (container-query units), styled
//     like Wistia (bigger, thinner, translucent background). Pulled live from
//     Bunny's CDN — never stored in the repo.
//   • Autoplay videos start muted with captions ON; a top-right "Click for
//     sound" prompt (the whole frame is the click target) unmutes and turns
//     captions OFF — exactly how Wistia's clickForSound behaved.
//   • Chapter markers on the scrubber (from window.JM_BUNNY_CONFIG, generated
//     from Bunny by scripts/build-bunny-config.mjs).
//   • Gold player theme (#c2a86c) matching the brand.
//
// Every player is registered on window.JM_BUNNY so js/bunny-tracking.js (loaded
// only on tracking pages) can hook in unchanged: each entry exposes a small
// Player.js-compatible adapter over the Plyr instance.
//
// This file self-bootstraps its dependencies (Plyr + hls.js + the config),
// so a page only needs the <video> markup plus:
//     <script src="/js/bunny-embeds.js" defer></script>
//
// Adding a new video later: upload to the Bunny Website library, run
//     node scripts/build-bunny-config.mjs
// and drop a <video class="jm-player" data-bunny-id="<guid>" data-video-id="…"
//     data-autoplay="true|false"> on the page. No other code changes.

(function () {
  'use strict';

  // ---- shared registry (defined synchronously, before any async load) -------
  // bunny-tracking.js is loaded `async` and may run BEFORE this file finishes
  // bootstrapping, so the registry contract must exist immediately and be
  // order-independent. Both files create a compatible JM_BUNNY defensively.
  var JM = (window.JM_BUNNY = window.JM_BUNNY || {});
  JM.players = JM.players || [];
  JM._cbs = JM._cbs || [];
  // onPlayer(cb): replay existing players to cb, then call cb for future ones.
  JM.onPlayer = JM.onPlayer || function (cb) {
    try { JM.players.forEach(function (p) { cb(p); }); } catch (e) {}
    JM._cbs.push(cb);
  };
  function registerPlayer(entry) {
    JM.players.push(entry);
    JM._cbs.forEach(function (cb) { try { cb(entry); } catch (e) {} });
  }

  // ---- self-hosted asset paths ----------------------------------------------
  var VENDOR = '/js/vendor/';
  var PLYR_CSS = VENDOR + 'plyr.css';
  var PLYR_JS = VENDOR + 'plyr.min.js';
  var PLYR_SVG = VENDOR + 'plyr.svg';
  var HLS_JS = VENDOR + 'hls.min.js';
  var CONFIG_JS = '/js/bunny-config.js';

  var SPEAKER_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23z"/>' +
    '</svg>';

  // ---- one-time styles -------------------------------------------------------
  function ensureStylesheet(href) {
    var links = document.getElementsByTagName('link');
    for (var i = 0; i < links.length; i++) {
      if (links[i].href && links[i].href.indexOf(href) !== -1) return;
    }
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    document.head.appendChild(l);
  }

  function injectStyles() {
    ensureStylesheet(PLYR_CSS);
    if (document.getElementById('jm-bunny-styles')) return;
    var css =
      // Constrain the BARE <video> to fill its box from the very first paint —
      // before Plyr wraps it. Otherwise, the instant hls.js attaches, the
      // element briefly takes the stream's intrinsic 1920x1080 size and flashes
      // huge for a moment until Plyr + the .jm-plyr rules below kick in.
      'video.jm-player{position:absolute;top:0;left:0;width:100%;height:100%;' +
      'object-fit:cover;background:#000;display:block;}' +
      // Fill the same positioned 16:9 / fixed box the iframe used to occupy.
      '.jm-plyr.plyr{position:absolute;top:0;left:0;width:100%;height:100%;' +
      'container-type:inline-size;border-radius:inherit;overflow:hidden;' +
      '--plyr-color-main:#c2a86c;--plyr-video-control-color:#fff;' +
      '--plyr-video-control-color-hover:#fff;--plyr-range-thumb-background:#c2a86c;' +
      '--plyr-range-fill-background:#c2a86c;--plyr-video-background:#000;' +
      '--plyr-menu-background:rgba(20,20,22,.92);--plyr-menu-color:#fff;}' +
      '.jm-plyr.plyr .plyr__video-wrapper{position:absolute!important;top:0;left:0;' +
      'width:100%!important;height:100%!important;padding:0!important;background:#000;}' +
      // cover (not contain): fill the frame edge-to-edge so a slightly-off-16:9
      // page box never shows black bars. The crop on a near-16:9 box is <2% —
      // imperceptible — and matches how Wistia filled its frames.
      '.jm-plyr.plyr video{position:absolute!important;top:0;left:0;' +
      'width:100%!important;height:100%!important;object-fit:cover;}' +
      // Wistia-style captions that SCALE with the player width (cqw).
      '.jm-plyr .plyr__captions{font-size:clamp(11px,4.4cqw,22px)!important;' +
      'padding:0 0 1.6%!important;}' +
      '.jm-plyr .plyr__caption{background:rgba(0,0,0,.55)!important;color:#fff!important;' +
      'font-weight:400!important;line-height:1.35!important;padding:.1em .45em!important;' +
      'box-decoration-break:clone;-webkit-box-decoration-break:clone;}' +
      // "Click for sound": visible pill in the TOP-RIGHT, whole frame is the
      // click target. Scales with the player (cqw). Mirrors Wistia clickForSound.
      '.jm-cfs{position:absolute;inset:0;z-index:10;display:flex;align-items:flex-start;' +
      'justify-content:flex-end;cursor:pointer;border:0;padding:0;margin:0;' +
      'background:transparent;-webkit-tap-highlight-color:transparent;}' +
      '.jm-cfs__pill{margin:3.5%;display:inline-flex;align-items:center;gap:.45em;' +
      'padding:.55em .9em;border-radius:6px;background:rgba(20,20,22,.72);color:#fff;' +
      'font:600 clamp(12px,3.4cqw,17px)/1 -apple-system,BlinkMacSystemFont,"Segoe UI",' +
      'Roboto,Helvetica,Arial,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.35);' +
      'transition:background .2s;}' +
      '.jm-cfs:hover .jm-cfs__pill{background:rgba(20,20,22,.9);}' +
      '.jm-cfs__pill svg{width:1.05em;height:1.05em;fill:#fff;flex:0 0 auto;}' +
      '.jm-cfs.is-hiding{opacity:0;pointer-events:none;transition:opacity .25s;}' +
      // Poster (thumbnail shown before play): fill the frame like the video, so
      // a non-16:9-exact box never letterboxes the thumbnail with black bars.
      '.jm-plyr .plyr__poster{background-size:cover!important;}' +
      // Seek tooltip: let long text wrap instead of overflowing its bubble.
      '.jm-plyr .plyr__tooltip{white-space:normal!important;width:max-content!important;' +
      'max-width:min(80cqw,260px)!important;line-height:1.3!important;}' +
      // --- Interactive chapter markers (Wistia-like) ---------------------------
      // A layer over the scrubber; only the dots are interactive (the bar still
      // seeks normally between them). Each dot has a WIDE invisible hit area so
      // you don\'t need pixel-perfect hover, grows on hover (snap feel), shows
      // its title, and seeks to that chapter on click.
      // NB: rules scoped under .jm-plyr so they beat Plyr\'s ".plyr button{width:auto}".
      '.jm-plyr .jm-chaps{position:absolute;inset:0;pointer-events:none;z-index:4;}' +
      '.jm-plyr .jm-chap{position:absolute;top:50%;width:18px!important;height:18px!important;' +
      'margin:-9px 0 0 -9px;padding:0;border:0;background:transparent;cursor:pointer;' +
      'pointer-events:auto;flex:none;}' +
      '.jm-plyr .jm-chap::before{content:"";position:absolute;top:50%;left:50%;width:7px;height:7px;' +
      'transform:translate(-50%,-50%);border-radius:50%;background:#fff;' +
      'box-shadow:0 0 0 1px rgba(0,0,0,.5);transition:transform .12s,background .12s;}' +
      '.jm-plyr .jm-chap:hover::before,.jm-plyr .jm-chap:focus-visible::before{transform:translate(-50%,-50%) scale(1.7);background:#c2a86c;}' +
      '.jm-plyr .jm-chap-tip{position:absolute;bottom:calc(100% + 12px);transform:translateX(-50%);' +
      'background:rgba(20,20,22,.94);color:#fff;padding:.42em .6em;border-radius:5px;' +
      'font:600 clamp(11px,3cqw,14px)/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
      'white-space:normal;width:max-content;max-width:min(70cqw,240px);text-align:center;' +
      'pointer-events:none;opacity:0;transition:opacity .14s;box-shadow:0 2px 12px rgba(0,0,0,.4);}' +
      '.jm-chap-tip.is-visible{opacity:1;}';
    var style = document.createElement('style');
    style.id = 'jm-bunny-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Apply a quality choice from Plyr's menu to the hls.js stream.
  // q === 0 -> Auto (let hls.js ABR pick); otherwise pin to the matching height.
  function setHlsQuality(hls, q) {
    if (!hls || !hls.levels) return;
    if (!q) { hls.currentLevel = -1; return; } // -1 = ABR auto
    for (var i = 0; i < hls.levels.length; i++) {
      if (hls.levels[i].height === q) { hls.currentLevel = i; return; }
    }
  }

  // Render an interactive chapter layer on the scrubber: wider hit area than a
  // bare dot (looser hover), grows + labels on hover, seeks to the chapter on
  // click. Replaces Plyr's tiny non-interactive markers. Chapters at t<=0 are
  // skipped (the start is the default first chapter, like Wistia/Bunny).
  function enhanceChapters(plyr, chapters) {
    var progress = plyr.elements && plyr.elements.progress;
    if (!progress) return;
    var pts = chapters.filter(function (c) { return c.time > 0; });
    if (!pts.length) return;

    function build() {
      var d = durationOf(plyr);
      if (!d || !isFinite(d)) return false;
      if (progress.querySelector('.jm-chaps')) return true; // build once
      var layer = document.createElement('div');
      layer.className = 'jm-chaps';
      var tip = document.createElement('span');
      tip.className = 'jm-chap-tip';
      pts.forEach(function (ch) {
        var pct = Math.max(0, Math.min(100, (ch.time / d) * 100));
        var dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'jm-chap';
        dot.style.left = pct + '%';
        dot.setAttribute('aria-label', 'Chapter: ' + ch.label);
        dot.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          try { plyr.currentTime = ch.time; } catch (x) {}
        });
        function show() {
          tip.textContent = ch.label;
          tip.style.left = pct + '%';
          tip.style.transform = 'translateX(-50%)';
          tip.classList.add('is-visible');
          // keep the bubble inside the scrubber bounds at the edges
          try {
            var pr = progress.getBoundingClientRect();
            var tr = tip.getBoundingClientRect();
            var over = tr.right > pr.right ? tr.right - pr.right
              : (tr.left < pr.left ? tr.left - pr.left : 0);
            if (over) tip.style.transform = 'translateX(calc(-50% - ' + over + 'px))';
          } catch (x) {}
        }
        function hide() { tip.classList.remove('is-visible'); }
        dot.addEventListener('pointerenter', show);
        dot.addEventListener('pointerleave', hide);
        dot.addEventListener('focus', show);
        dot.addEventListener('blur', hide);
        layer.appendChild(dot);
      });
      layer.appendChild(tip);
      progress.appendChild(layer);
      return true;
    }

    if (!build()) {
      var tries = 0;
      var iv = window.setInterval(function () {
        tries++;
        if (build() || tries > 24) window.clearInterval(iv);
      }, 250);
    }
  }

  // ---- Plyr -> Player.js-compatible adapter (so bunny-tracking.js is unchanged)
  function durationOf(p) {
    return (p.media && p.media.duration) || p.duration || 0;
  }
  function adapter(p) {
    return {
      on: function (ev, cb) {
        try {
          if (ev === 'timeupdate') {
            p.on('timeupdate', function () { cb({ seconds: p.currentTime, duration: durationOf(p) }); });
          } else if (ev === 'ready') {
            if (p.ready) { cb(); } else { p.on('ready', function () { cb(); }); }
          } else {
            p.on(ev, function () { cb(); });
          }
        } catch (e) {}
      },
      getMuted: function (cb) { try { cb(!!p.muted); } catch (e) { cb(false); } },
      getDuration: function (cb) { try { cb(durationOf(p)); } catch (e) { cb(0); } },
      getCurrentTime: function (cb) { try { cb(p.currentTime); } catch (e) { cb(0); } },
      play: function () { try { var r = p.play(); if (r && r.catch) r.catch(function () {}); } catch (e) {} },
      pause: function () { try { p.pause(); } catch (e) {} },
      mute: function () { try { p.muted = true; } catch (e) {} },
      unmute: function () { try { p.muted = false; } catch (e) {} },
      setVolume: function (v) { try { p.volume = (v || 0) / 100; } catch (e) {} },
    };
  }

  // ---- per-video init --------------------------------------------------------
  function initOne(video) {
    if (video.__jmInit) return;
    video.__jmInit = true;

    var CFG = window.JM_BUNNY_CONFIG || { cdn: '', videos: {} };
    var cdn = CFG.cdn;
    var guid = video.getAttribute('data-bunny-id');
    if (!guid || !cdn) { return; }
    var cfg = (CFG.videos || {})[guid] || {};
    var videoId = video.getAttribute('data-video-id') || cfg.videoId || guid;
    var autoplay = video.getAttribute('data-autoplay') === 'true';
    var lang = cfg.captions || null;

    var hlsUrl = 'https://' + cdn + '/' + guid + '/playlist.m3u8';
    var capUrl = lang ? 'https://' + cdn + '/' + guid + '/captions/' + lang + '.vtt' : null;
    var poster = cfg.poster ? 'https://' + cdn + '/' + guid + '/' + cfg.poster : null;
    var markers = (cfg.chapters || []).map(function (c) { return { time: c.time, label: c.label }; });
    // Testimonials get a MINIMAL player — no control/play bar, just a big play
    // button + tap-to-toggle. Identified by the Bunny title containing
    // "testimonial" (page-independent; the .testimonial-video container class
    // isn't used on every page).
    var minimal = /testimonial/i.test(cfg.title || '');

    video.setAttribute('playsinline', '');
    video.setAttribute('crossorigin', 'anonymous');
    video.setAttribute('preload', autoplay ? 'auto' : 'metadata');
    if (poster) video.setAttribute('poster', poster);
    if (autoplay) { video.muted = true; video.setAttribute('muted', ''); }

    var entry = {
      iframe: null, video: video, bunnyId: guid, videoId: videoId,
      autoplay: autoplay, unmuted: !autoplay, player: null, plyr: null, overlay: null,
    };
    var built = false;

    function buildPlyr() {
      if (built) return; built = true;

      // Quality selector from the hls.js renditions. 0 == "Auto" (ABR): hls.js
      // adapts to the viewer's bandwidth and (via capLevelToPlayerSize) the
      // display size, so it serves the best quality that fits — no waste. The
      // viewer can still force a specific height from the menu. Native-HLS
      // (Safari) has no selectable levels — the OS handles ABR there.
      var hls = entry.hls;
      var qualityOpts = null;
      if (hls && hls.levels && hls.levels.length) {
        var heights = hls.levels.map(function (l) { return l.height; }).filter(Boolean);
        heights = heights.filter(function (h, i) { return heights.indexOf(h) === i; })
          .sort(function (a, b) { return b - a; });
        if (heights.length > 1) {
          qualityOpts = {
            default: 0,
            options: [0].concat(heights),
            forced: true,
            onChange: function (q) { setHlsQuality(hls, q); },
          };
        }
      }
      var useQuality = !minimal && !!qualityOpts;
      var settingsMenu = minimal ? [] : (useQuality ? ['captions', 'quality', 'speed'] : ['captions', 'speed']);

      var plyrOpts = {
        // Don't persist/restore volume·muted·captions·speed across players or
        // page loads. Plyr's default localStorage (one shared 'plyr' key) made
        // non-autoplay videos randomly inherit a previous (autoplay) video's
        // muted + captions-on state — different on every load. With storage
        // off, every player honors its explicit config deterministically.
        storage: { enabled: false },
        autoplay: autoplay,
        muted: autoplay,
        // Tap the video frame to play/pause — Plyr's built-in behavior, no
        // custom handler. For autoplay videos the click-for-sound overlay
        // sits on top and handles the FIRST tap (unmute, stopPropagation);
        // once it retires, taps fall through to Plyr's native clickToPlay.
        clickToPlay: true,
        hideControls: true,
        resetOnEnd: !autoplay,
        captions: { active: autoplay, language: lang || 'en', update: true },
        controls: minimal
          ? ['play-large']
          : ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'captions', 'settings', 'fullscreen'],
        settings: settingsMenu,
        i18n: { qualityLabel: { 0: 'Auto' } },
        // Plyr's own markers are tiny + non-interactive; we render our own
        // chapter layer (enhanceChapters) with a wider hit area + click-to-seek.
        markers: { enabled: false, points: [] },
        iconUrl: PLYR_SVG,
        blankVideo: '', // never used (HLS attached directly); avoid cdn.plyr.io fetch
        ratio: null, // the surrounding box already enforces 16:9
        tooltips: { controls: true, seek: true },
        keyboard: { focused: true, global: false },
      };
      // Only set `quality` when there is a real menu to show. Passing
      // `quality: undefined` overrides Plyr's default and crashes its
      // getQualityOptions (reads config.quality.forced). Omit it instead.
      if (useQuality) { plyrOpts.quality = qualityOpts; }

      var plyr;
      try {
        plyr = new window.Plyr(video, plyrOpts);
      } catch (e) {
        // Plyr failed: register a stub so tracking no-ops, native <video> still plays.
        entry.player = null;
        registerPlayer(entry);
        return;
      }
      entry.plyr = plyr;
      entry.player = adapter(plyr);
      try { plyr.elements.container.classList.add('jm-plyr'); } catch (e) {}

      if (autoplay) {
        plyr.on('ready', function () {
          try { plyr.muted = true; } catch (e) {}
          try { plyr.toggleCaptions(true); } catch (e) {} // captions ON while muted-autoplaying
          try { var r = plyr.play(); if (r && r.catch) r.catch(function () {}); } catch (e) {}
        });
        addClickForSound(plyr, entry);
      }
      // Interactive chapter markers (wider hit area + click-to-seek). Minimal
      // (testimonial) players have no scrubber, so skip them.
      if (!minimal && markers.length) { enhanceChapters(plyr, markers); }
      registerPlayer(entry);
    }

    // Attach the caption track as a same-origin Blob URL. hls.js + a *cross-origin*
    // <track> silently fails to load cues, so we fetch the VTT (CORS-enabled on
    // Bunny's CDN) and feed it via a blob — still native <track> rendering, no
    // custom caption layer, nothing stored in the repo.
    function withCaptionTrack(done) {
      if (!capUrl) { done(); return; }
      fetch(capUrl)
        .then(function (r) { return r.ok ? r.text() : null; })
        .then(function (vtt) {
          if (vtt) {
            var tr = document.createElement('track');
            tr.kind = 'captions';
            tr.label = 'English';
            tr.srclang = lang;
            // Never mark the track `default`: a default track renders natively
            // ("showing") and fights Plyr's own caption management. Plyr is the
            // single controller — it activates captions via the config/toggle below.
            tr.default = false;
            try { tr.src = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })); } catch (e) {}
            video.appendChild(tr);
          }
        })
        .catch(function () {})
        .then(done, done);
    }

    // ---- HLS source ----------------------------------------------------------
    if (window.Hls && window.Hls.isSupported()) {
      // capLevelToPlayerSize: in Auto mode, never fetch a rendition larger than
      // the player's on-screen size — maximizes quality for the actual display
      // while not wasting the viewer's bandwidth (e.g. a 300px testimonial won't
      // pull 1080p). Re-evaluates on resize/fullscreen, so quality scales up
      // when the player grows. startLevel:-1 lets ABR pick the opening level.
      var hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90,
        capLevelToPlayerSize: true,
        startLevel: -1,
      });
      entry.hls = hls;
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, function () { withCaptionTrack(buildPlyr); });
      hls.on(window.Hls.Events.ERROR, function (ev, data) {
        if (!data || !data.fatal) return;
        try {
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) { hls.startLoad(); }
          else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); }
          else { hls.destroy(); }
        } catch (e) {}
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari / iOS: native HLS.
      video.src = hlsUrl;
      withCaptionTrack(buildPlyr);
    } else {
      // Last resort — let the browser try the URL directly.
      video.src = hlsUrl;
      withCaptionTrack(buildPlyr);
    }
  }

  // ---- "Click for sound" overlay (autoplay videos only) ----------------------
  function addClickForSound(plyr, entry) {
    if (entry.overlay) return;
    var container = (plyr.elements && plyr.elements.container) || entry.video.parentNode;
    if (!container) return;
    var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    var label = (isTouch ? 'Tap' : 'Click') + ' for sound';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jm-cfs';
    btn.setAttribute('aria-label', label);
    btn.innerHTML = '<span class="jm-cfs__pill">' + SPEAKER_SVG + '<span>' + label + '</span></span>';
    entry.overlay = btn;

    function retire() {
      entry.unmuted = true;
      btn.classList.add('is-hiding');
      window.setTimeout(function () { if (btn.parentNode) btn.parentNode.removeChild(btn); }, 300);
    }
    function unmute(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      try { plyr.muted = false; } catch (x) {}
      try { plyr.volume = 1; } catch (x) {}
      try { plyr.currentTime = 0; } catch (x) {} // restart from the beginning with sound
      try { var r = plyr.play(); if (r && r.catch) r.catch(function () {}); } catch (x) {}
      try { plyr.toggleCaptions(false); } catch (x) {}
      retire();
    }
    btn.addEventListener('click', unmute);
    container.appendChild(btn);

    // If sound comes on by some means OTHER than the overlay (e.g. the keyboard
    // shortcut while the player is focused), turn captions off and retire the
    // prompt too. Gated by `armed`: Plyr/HLS emit volume + mute events during
    // init, and reacting to those would wrongly retire the prompt before the
    // viewer ever interacts. We only arm after init has settled (the overlay
    // covers the native controls, so there is no genuine unmute before then).
    var armed = false;
    window.setTimeout(function () { armed = true; }, 1500);
    plyr.on('volumechange', function () {
      if (armed && !plyr.muted && !entry.unmuted) {
        entry.unmuted = true;
        try { plyr.toggleCaptions(false); } catch (e) {}
        if (btn.parentNode) retire();
      }
    });
  }

  // ---- init all + bootstrap deps --------------------------------------------
  function initAll() {
    injectStyles();
    var vids = document.querySelectorAll('video.jm-player');
    Array.prototype.forEach.call(vids, function (v) { initOne(v); });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-jm-src="' + src + '"]');
      if (existing) { existing.addEventListener('load', resolve); existing.addEventListener('error', reject); return; }
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.setAttribute('data-jm-src', src);
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function boot() {
    injectStyles(); // get the stylesheet in early to avoid a flash
    var need = [];
    if (!window.Hls) need.push(loadScript(HLS_JS));
    if (!window.Plyr) need.push(loadScript(PLYR_JS));
    if (!window.JM_BUNNY_CONFIG) need.push(loadScript(CONFIG_JS));
    Promise.all(need).then(initAll).catch(function (err) {
      // If a dependency fails, still register stubs so the page degrades to the
      // native <video> element rather than a blank box, and tracking no-ops.
      console.warn('[JM_BUNNY] dependency load failed; using native video.', err);
      var vids = document.querySelectorAll('video.jm-player');
      Array.prototype.forEach.call(vids, function (v) {
        if (v.__jmInit) return; v.__jmInit = true;
        var CFG = window.JM_BUNNY_CONFIG || { cdn: '', videos: {} };
        var guid = v.getAttribute('data-bunny-id');
        if (CFG.cdn && guid) { v.src = 'https://' + CFG.cdn + '/' + guid + '/playlist.m3u8'; v.controls = true; }
        registerPlayer({
          video: v, bunnyId: guid, videoId: v.getAttribute('data-video-id') || guid,
          autoplay: v.getAttribute('data-autoplay') === 'true', unmuted: false, player: null,
        });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
