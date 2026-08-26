/* Call Qualifier — embed helper
 *
 * Drop this on any page that should show the qualifier:
 *
 *   <div data-qualify-source="apply"></div>
 *   <script src="https://jasonmoss.com/qualify/embed.js" async></script>
 *
 * The data-qualify-source value is passed straight through to the widget and
 * ends up on the Kit record (qualify_source) and on the Calendly booking as
 * utm_source, so every booking is attributable to the page it came from.
 *
 * Optional attributes: data-qualify-medium, data-qualify-campaign.
 * The iframe resizes itself as the person moves through the questions.
 */
(function () {
  'use strict';

  var BASE = 'https://jasonmoss.com/qualify/';
  var MIN_HEIGHT = 520;

  function mount(host) {
    if (host.getAttribute('data-qualify-mounted')) return;
    host.setAttribute('data-qualify-mounted', '1');

    var source = host.getAttribute('data-qualify-source') || 'embed';
    var qs = ['source=' + encodeURIComponent(source)];
    var medium = host.getAttribute('data-qualify-medium');
    var campaign = host.getAttribute('data-qualify-campaign');
    if (medium) qs.push('utm_medium=' + encodeURIComponent(medium));
    if (campaign) qs.push('utm_campaign=' + encodeURIComponent(campaign));

    // Forward the host page's own UTMs into the widget, so an ad or email link
    // landing on the page still attributes the booking. data-qualify-* wins,
    // and utm_source never overrides the per-page source above.
    try {
      var pageQs = new URLSearchParams(window.location.search);
      ['utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function (k) {
        var v = pageQs.get(k);
        // qs is an array of "key=value" strings, so only the prefix test below
        // does real work here.
        if (v && !qs.some(function (x) { return x.indexOf(k + '=') === 0; })) {
          qs.push(k + '=' + encodeURIComponent(v.slice(0, 120)));
        }
      });
    } catch (e) {}

    var frame = document.createElement('iframe');
    frame.src = BASE + '?' + qs.join('&');
    frame.title = 'Book a business assessment call';
    frame.loading = 'lazy';
    frame.setAttribute('scrolling', 'no');
    // No height transition: an animating height can be left mid-flight (a
    // throttled/backgrounded tab never advances it), which pins the frame at
    // its old value and clips the widget. Snapping is also less distracting.
    frame.style.cssText =
      'width:100%;border:0;display:block;min-height:' + MIN_HEIGHT + 'px;' +
      'height:' + MIN_HEIGHT + 'px;';
    host.appendChild(frame);

    var lastApplied = 0;
    window.addEventListener('message', function (e) {
      if (!e.data || typeof e.data !== 'object') return;
      if (e.source !== frame.contentWindow) return;
      if (e.origin !== new URL(BASE).origin) return;
      if (e.data.type === 'qualify:height') {
        var h = Math.max(MIN_HEIGHT, Math.round(e.data.height) || MIN_HEIGHT);
        // Never re-apply the same height: resizing the frame fires a resize
        // inside it, which reports again. Without this the pair can oscillate.
        if (h === lastApplied) return;
        lastApplied = h;
        frame.style.height = h + 'px';
      }
      if (e.data.type === 'qualify:booked' && window.dataLayer) {
        window.dataLayer.push({ event: 'qualifier_booked', qualifier_source: e.data.source });
      }
    });
  }

  function boot() {
    var hosts = document.querySelectorAll('[data-qualify-source]');
    for (var i = 0; i < hosts.length; i++) mount(hosts[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Some pages build their booking section in JS after this script has run
  // (the quiz results page renders from the answers). Watch for hosts that
  // appear later so those still get a widget. mount() is idempotent.
  if (window.MutationObserver) {
    try {
      new MutationObserver(boot).observe(document.documentElement, {
        childList: true, subtree: true
      });
    } catch (e) {}
  }
})();
