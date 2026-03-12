// Wistia Video Engagement Tracking
// Include on pages with Wistia embeds where you want watch-time tracking.
// Fires a Zapier webhook when a viewer watches 75%+ of the video.
//
// Requirements:
//   - Email must be in the URL as ?email=someone@example.com
//   - Wistia embed(s) on the page
//   - Script exits gracefully if either is missing
//
// Usage: <script src="/js/wistia-tracking.js"></script>

(function () {
  // ==============================
  // CONFIG
  // ==============================
  var WATCH_THRESHOLD = 0.75; // 75% watch time
  var ZAPIER_WEBHOOK_URL =
    'https://hooks.zapier.com/hooks/catch/1992870/ug3nc28/';

  console.log('[Engagement] Script loaded');

  // ==============================
  // GET EMAIL FROM URL
  // ==============================
  var params = new URLSearchParams(window.location.search);
  var email = params.get('email');

  if (!email) {
    console.warn('[Engagement] No email in URL. Exiting.');
    return;
  }

  email = email.trim().toLowerCase();
  console.log('[Engagement] Email detected:', email);

  // ==============================
  // PREVENT DOUBLE FIRING
  // ==============================
  var firedKey = 'wistia_engaged_' + window.location.pathname;
  if (localStorage.getItem(firedKey)) {
    console.warn('[Engagement] Already fired for this page. Exiting.');
    return;
  }

  // ==============================
  // LOAD WISTIA API
  // ==============================
  window._wq = window._wq || [];

  if (
    !document.querySelector(
      'script[src*="fast.wistia.net/assets/external/E-v1.js"]'
    )
  ) {
    console.log('[Engagement] Loading Wistia API');
    var s = document.createElement('script');
    s.src = 'https://fast.wistia.net/assets/external/E-v1.js';
    s.async = true;
    document.head.appendChild(s);
  }

  // ==============================
  // WISTIA HOOK
  // ==============================
  window._wq.push({
    id: '_all',
    onReady: function (video) {
      var duration = video.duration();
      var thresholdSeconds = duration * WATCH_THRESHOLD;

      console.log('[Engagement] Video ready:', video.hashedId());
      console.log('[Engagement] Duration:', Math.round(duration), 'sec');
      console.log(
        '[Engagement] Threshold:',
        Math.round(thresholdSeconds),
        'sec'
      );

      var accumulated = 0;
      var playStart = null;
      var fired = false;

      function isTabVisible() {
        return document.visibilityState === 'visible';
      }

      function updateAccumulated() {
        if (playStart && isTabVisible()) {
          var delta = (Date.now() - playStart) / 1000;
          accumulated += delta;
          playStart = Date.now();
        }
      }

      function fireWebhook() {
        if (fired || accumulated < thresholdSeconds) return;
        fired = true;
        localStorage.setItem(firedKey, 'true');

        console.log(
          '[Engagement] Threshold reached:',
          Math.round(accumulated),
          'sec'
        );

        var payload = {
          email: email,
          video_id: video.hashedId(),
          duration_seconds: Math.round(duration),
          watched_seconds: Math.round(accumulated),
          threshold: WATCH_THRESHOLD,
          page: window.location.pathname,
          timestamp: new Date().toISOString(),
        };

        // Build Zapier URL with query params
        var url = new URL(ZAPIER_WEBHOOK_URL);
        Object.keys(payload).forEach(function (key) {
          url.searchParams.append(key, payload[key]);
        });

        if (navigator.sendBeacon) {
          navigator.sendBeacon(url.toString());
          console.log('[Engagement] Beacon sent', payload);
        } else {
          fetch(url.toString(), { method: 'POST', keepalive: true })
            .then(function () {
              console.log('[Engagement] Fetch fallback sent');
            })
            .catch(function (err) {
              console.error('[Engagement] Webhook failed', err);
            });
        }
      }

      // ==============================
      // VIDEO EVENTS
      // ==============================
      video.bind('play', function () {
        if (!isTabVisible()) {
          console.log('[Engagement] play ignored (tab hidden)');
          return;
        }
        playStart = Date.now();
        console.log('[Engagement] play');
      });

      video.bind('pause', function () {
        updateAccumulated();
        playStart = null;
        console.log(
          '[Engagement] pause | watched:',
          Math.round(accumulated)
        );
        fireWebhook();
      });

      video.bind('end', function () {
        updateAccumulated();
        playStart = null;
        console.log('[Engagement] end | watched:', Math.round(accumulated));
        fireWebhook();
      });

      // ==============================
      // SAFETY CHECK LOOP
      // ==============================
      setInterval(function () {
        if (playStart && !fired && isTabVisible()) {
          updateAccumulated();
          console.log(
            '[Engagement] watching:',
            Math.round(accumulated)
          );
          fireWebhook();
        }
      }, 5000);
    },
  });
})();
