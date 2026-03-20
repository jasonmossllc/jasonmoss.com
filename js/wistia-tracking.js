// Wistia Video Engagement Tracking
// Include on pages with Wistia embeds where you want watch-time tracking.
// Fires a Zapier webhook when a viewer watches 75%+ of the video.
//
// Requirements:
//   - Email must be in the URL as ?email=someone@example.com
//   - Wistia embed(s) on the page (iframe or div-based)
//   - Script exits gracefully if either is missing
//
// Supports:
//   - Instapage lazy-loaded iframes (data-src → src)
//   - Normal Wistia iframe embeds
//   - Standard div-based Wistia embeds
//
// Usage: <script src="/js/wistia-tracking.js"></script>

(function () {
  // ==============================
  // CONFIG
  // ==============================
  var WATCH_THRESHOLD = 0.75; // 75% watch time
  var ZAPIER_WEBHOOK_URL =
    'https://hooks.zapier.com/hooks/catch/1992870/ug3nc28/';
  var WISTIA_POLL_INTERVAL = 500; // ms between checks for Wistia embed
  var WISTIA_POLL_TIMEOUT = 30000; // stop polling after 30s if no embed found

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

  try {
    if (localStorage.getItem(firedKey)) {
      console.warn('[Engagement] Already fired for this page. Exiting.');
      return;
    }
  } catch (e) {
    // localStorage unavailable (private browsing on old iOS Safari, etc.)
    // Continue — worst case the webhook fires again on reload
  }

  // ==============================
  // WAIT FOR WISTIA EMBED TO EXIST
  // Handles: Instapage lazy iframes (data-src → src),
  //          normal iframes, and div-based standard embeds
  // ==============================
  function waitForWistia(callback) {
    var elapsed = 0;
    var check = setInterval(function () {
      elapsed += WISTIA_POLL_INTERVAL;

      // Instapage lazy iframe or normal iframe
      var iframe = document.querySelector('iframe[name="wistia_embed"]');
      var iframeReady =
        iframe && iframe.src && iframe.src.indexOf('wistia') > -1;

      // Standard div-based Wistia embed
      var divEmbed = document.querySelector('div[class*="wistia_embed"]');

      if (iframeReady || divEmbed) {
        clearInterval(check);
        console.log('[Engagement] Wistia embed found');
        callback();
        return;
      }

      if (elapsed >= WISTIA_POLL_TIMEOUT) {
        clearInterval(check);
        console.warn(
          '[Engagement] No Wistia embed found after ' +
            WISTIA_POLL_TIMEOUT / 1000 +
            's. Exiting.'
        );
      }
    }, WISTIA_POLL_INTERVAL);
  }

  waitForWistia(function () {
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

        function updateAccumulated() {
          if (playStart) {
            var delta = (Date.now() - playStart) / 1000;
            accumulated += delta;
            playStart = Date.now();
          }
        }

        function sendToZapier() {
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

          var urlString = url.toString();

          // Layer 1: sendBeacon (survives page close)
          var beaconSent = false;
          if (navigator.sendBeacon) {
            beaconSent = navigator.sendBeacon(urlString);
            console.log('[Engagement] Beacon sent:', beaconSent);
          }

          // Layer 2: fetch fallback (if beacon unavailable or blocked)
          if (!beaconSent) {
            fetch(urlString, { method: 'POST', keepalive: true })
              .then(function () {
                console.log('[Engagement] Fetch fallback sent');
              })
              .catch(function () {
                // Layer 3: image pixel (bypasses most ad blockers)
                console.log('[Engagement] Fetch blocked, trying image pixel');
                new Image().src = urlString;
              });
          }
        }

        function fireWebhook() {
          if (fired || accumulated < thresholdSeconds) return;

          fired = true;

          try {
            localStorage.setItem(firedKey, 'true');
          } catch (e) {
            // localStorage unavailable — webhook still fires,
            // just won't be deduplicated on reload
          }

          console.log(
            '[Engagement] Threshold reached:',
            Math.round(accumulated),
            'sec'
          );

          sendToZapier();
        }

        // ==============================
        // VIDEO EVENTS
        // ==============================
        video.bind('play', function () {
          updateAccumulated(); // capture any untracked time if play fires twice
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
          if (playStart && !fired) {
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
  });
})();
