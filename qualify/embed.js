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

    var frame = document.createElement('iframe');
    frame.src = BASE + '?' + qs.join('&');
    frame.title = 'Book a business assessment call';
    frame.loading = 'lazy';
    frame.setAttribute('scrolling', 'no');
    frame.style.cssText =
      'width:100%;border:0;display:block;min-height:' + MIN_HEIGHT + 'px;' +
      'height:' + MIN_HEIGHT + 'px;transition:height .3s cubic-bezier(0.16,1,0.3,1);';
    host.appendChild(frame);

    window.addEventListener('message', function (e) {
      if (!e.data || typeof e.data !== 'object') return;
      if (e.source !== frame.contentWindow) return;
      if (e.data.type === 'qualify:height') {
        var h = Math.max(MIN_HEIGHT, Math.round(e.data.height) || MIN_HEIGHT);
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
})();
