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
 * Optional attributes: data-qualify-medium, data-qualify-campaign,
 * data-qualify-min-height (px, default 520; lower it when the first question is short).
 * The iframe resizes itself as the person moves through the questions.
 */
(function () {
  'use strict';

  // Production always serves the widget from jasonmoss.com. A Netlify deploy
  // preview of this site serves its own copy, so a change can be tested there
  // end to end before it ships.
  var ORIGIN = /^[a-z0-9-]+--jasonmoss\.netlify\.app$/i.test(window.location.hostname)
    ? window.location.origin : 'https://jasonmoss.com';
  var BASE = ORIGIN + '/qualify/';
  var MIN_HEIGHT = 520;

  // ---------------------------------------------------------------- prefill
  // Name and email for the widget's Launchpad contact screen and the Calendly
  // booking form, so people we already know don't type them again. Sources,
  // newest wins:
  //   1. this page's URL: ?email= (opt-in pages pass it) and ?name= /
  //      ?first_name= (Kit email links can carry them via Liquid);
  //   2. a Kit email link's ?ck_subscriber_id=, looked up server-side
  //      (netlify/functions/qualify-prefill.js returns first name + email);
  //   3. what this browser gave us before (an opt-in form, an earlier lookup,
  //      the widget's own contact form), kept in localStorage for PREFILL_TTL.
  // Shared with js/optin-shared.js and qualify/index.html (same key + shape).
  // Nothing personal goes into the iframe URL: it is handed over by
  // postMessage, to our own origin only.
  var PREFILL_KEY = 'jm_prefill';
  var PREFILL_TTL = 30 * 24 * 3600 * 1000;
  var LOOKUP_FN = ORIGIN + '/.netlify/functions/qualify-prefill';
  var EMAIL_OK = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>]+\.[^\s@<>]{2,}$/;

  function cleanEmail(v) {
    var e = String(v == null ? '' : v).replace(/\s/g, '').toLowerCase();
    return e.length <= 254 && EMAIL_OK.test(e) ? e : '';
  }
  // Unrendered Liquid ({{ subscriber.first_name }}), markup and junk are dropped.
  function cleanName(v) {
    var s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    if (!s || s.length > 60 || /[<>{}%@\\]|https?:/i.test(s)) return '';
    return s;
  }
  function readStore() {
    try {
      var d = JSON.parse(localStorage.getItem(PREFILL_KEY) || 'null');
      if (!d || typeof d !== 'object' || !(Date.now() - (d.t || 0) < PREFILL_TTL)) return null;
      var out = { email: cleanEmail(d.email), first_name: cleanName(d.first_name), last_name: cleanName(d.last_name),
                  kid: /^[1-9]\d{0,15}$/.test(d.kid || '') ? d.kid : '' };
      return out.email ? out : null;
    } catch (e) { return null; }
  }
  function writeStore(d) {
    try {
      localStorage.setItem(PREFILL_KEY, JSON.stringify({ v: 1, email: d.email, first_name: d.first_name || '',
        last_name: d.last_name || '', kid: d.kid || '', t: Date.now() }));
    } catch (e) {}
  }

  // The site's tracker (js/jm.js) removes Kit's id parameters from the address
  // bar as soon as it loads, so a shared link never carries the reader's
  // identity. That can happen before this script runs, so the parameters are
  // read from the navigation's original URL as well as the current one.
  function pageParams() {
    var cur = new URLSearchParams(window.location.search), orig = null;
    try {
      var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
      if (nav && nav.name) {
        var u = new URL(nav.name);
        if (u.pathname === window.location.pathname) orig = u.searchParams;
      }
    } catch (e) {}
    return function (k) { return (cur.get(k) || (orig && orig.get(k)) || '').slice(0, 200); };
  }

  var prefill = { data: null, pending: false };
  var frames = [];
  function sendPrefill(frame) {
    try {
      frame.contentWindow.postMessage({ type: 'qualify:prefill', data: prefill.data, pending: prefill.pending }, ORIGIN);
    } catch (e) {}
  }
  function broadcastPrefill() { for (var i = 0; i < frames.length; i++) sendPrefill(frames[i]); }

  (function resolvePrefill() {
    var get;
    try { get = pageParams(); } catch (e) { return; }
    var cur = readStore();
    var urlEmail = cleanEmail(get('email'));
    var urlFirst = cleanName(get('first_name') || get('fname') || get('firstname') || get('name'));
    var urlLast = cleanName(get('last_name') || get('lname') || get('lastname'));
    var changed = false;
    if (urlEmail) {
      // A different address is a different person: drop what we held for the old one.
      if (!cur || cur.email !== urlEmail) cur = { email: urlEmail, first_name: '', last_name: '', kid: '' };
      if (urlFirst) cur.first_name = urlFirst;
      if (urlLast) cur.last_name = urlLast;
      changed = true;
    } else if (cur && urlFirst && !cur.first_name) {
      cur.first_name = urlFirst; changed = true;
    }
    if (changed) writeStore(cur);
    prefill.data = cur;

    var kid = get('ck_subscriber_id') || get('subscriber_id');
    var sh = get('sh_kit').toLowerCase();
    if (!/^[1-9]\d{0,15}$/.test(kid)) return;
    // Already looked this subscriber up in this browser and nothing newer
    // replaced it: no need to ask again.
    if (cur && cur.kid === kid) return;
    if (!window.fetch) return;
    prefill.pending = true;
    var done = false;
    function finish(res) {
      if (done) return;
      done = true;
      prefill.pending = false;
      var email = res && cleanEmail(res.email);
      if (email) {
        var base = readStore() || prefill.data;
        var next = (base && base.email === email) ? base : { email: email, first_name: '', last_name: '' };
        next.first_name = cleanName(res.first_name) || next.first_name || '';
        next.kid = kid;
        writeStore(next);
        prefill.data = next;
      }
      broadcastPrefill();
    }
    // Never hold the widget up for long: past this, it goes on without.
    setTimeout(function () { finish(null); }, 4000);
    try {
      fetch(LOOKUP_FN, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(/^[0-9a-f]{64}$/.test(sh) ? { kid: kid, sh: sh } : { kid: kid })
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(finish, function () { finish(null); });
    } catch (e) { finish(null); }
  })();

  function mount(host) {
    if (host.getAttribute('data-qualify-mounted')) return;
    host.setAttribute('data-qualify-mounted', '1');

    var source = host.getAttribute('data-qualify-source') || 'embed';
    var minHeight = parseInt(host.getAttribute('data-qualify-min-height'), 10) || MIN_HEIGHT;
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

    // The answer from a two-step opt-in's revenue question (rev), so the
    // widget doesn't ask the same question again.
    try {
      var rev = new URLSearchParams(window.location.search).get('rev');
      if (rev === 'under-1k' || rev === '1k-10k' || rev === '10k-plus') qs.push('rev=' + rev);
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
      'width:100%;border:0;display:block;min-height:' + minHeight + 'px;' +
      'height:' + minHeight + 'px;';
    host.appendChild(frame);
    frames.push(frame);

    var lastApplied = 0;
    window.addEventListener('message', function (e) {
      if (!e.data || typeof e.data !== 'object') return;
      if (e.source !== frame.contentWindow) return;
      if (e.origin !== ORIGIN) return;
      // The widget asks once it has loaded; answer with what we have (and
      // whether a Kit lookup is still on its way).
      if (e.data.type === 'qualify:hello') { sendPrefill(frame); return; }
      if (e.data.type === 'qualify:height') {
        var h = Math.max(minHeight, Math.round(e.data.height) || minHeight);
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
