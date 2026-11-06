/*
 * jasonmoss.com first-party visit + video tracking (Site Tracker).
 *
 * Added to every page automatically by the Netlify edge function (netlify/edge-functions/jm.js), and loaded on
 * checkout.jasonmoss.com and learn.jasonmoss.com through Google Tag Manager. Nothing is configured per page or per video:
 *   - page views, active time, scroll depth           (every page)
 *   - clicks on anything clickable (links, buttons)   (every page; checkout links flagged)
 *   - every Bunny video player bunny-embeds.js makes  (real audible watch time, furthest point, 5-second watch map)
 *   - identity: an email entered in any form (submitted, or sent with a button), Kit email links
 *     (?ck_subscriber_id=), Calendly bookings
 *
 * Plain ES5 on purpose: runs in every browser still in use, including old in-app browsers. Everything is wrapped
 * so a failure here can never break the page.
 *
 * Accuracy notes:
 *   - The visitor id lives in the jm_vid cookie, set by the SERVER (edge function), which Safari keeps for up to
 *     400 days (cookies written by JavaScript are capped at 7 days, or 1 day after an ad click). A copy in
 *     localStorage lets the server re-join history if the cookie is ever lost.
 *   - Pages Chrome/Safari load in the background before anyone looks (prerender, preload, background tabs) only
 *     count once they're actually shown. Back/forward-cache restores count as a new view.
 *   - Video updates carry the full state of that viewing, so a lost or repeated update can't lose or double-count.
 *     Only audible playback counts: muted autoplay, seeks and replays don't add watch time or "furthest point".
 *   - Every batch is saved in localStorage first and removed once the site confirms it. Sends use fetch, and
 *     sendBeacon while the page closes; anything unconfirmed goes out again from a later page (with its original
 *     time), and the tracker ignores events it already has.
 */
(function () {
  'use strict';
  if (window.__jmTracker) return;
  window.__jmTracker = 1;

  var VERSION = 8;
  var BUCKET_S = 5;
  var MAX_BUCKETS = 4320;
  var FLUSH_MS = 15000;
  var HIDDEN_FLUSH_MS = 60000;
  var STORE_Q = 'jm_q2';
  var STORE_VID = 'jm_vid_b';
  var ID_RE = /^[A-Za-z0-9_-]{16,48}$/;

  // ------------------------------------------------------------------ small utils
  function now() { return new Date().getTime(); }
  var perf = window.performance && performance.now ? function () { return performance.now(); } : now; // monotonic when available
  function rid(n) {
    var bytes = [], i, out = '', chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    n = n || 16;
    try {
      var a = new Uint8Array(n);
      (window.crypto || window.msCrypto).getRandomValues(a);
      for (i = 0; i < n; i++) bytes.push(a[i]);
    } catch (e) {
      for (i = 0; i < n; i++) bytes.push(Math.floor(Math.random() * 256));
    }
    for (i = 0; i < n; i++) out += chars.charAt(bytes[i] & 63);
    return out;
  }
  function ls() { try { var s = window.localStorage; var k = '__jm'; s.setItem(k, '1'); s.removeItem(k); return s; } catch (e) { return null; } }
  var store = ls();
  function getCookie(name) {
    try {
      var parts = document.cookie ? document.cookie.split(';') : [];
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i].replace(/^\s+/, '');
        if (p.indexOf(name + '=') === 0) return decodeURIComponent(p.slice(name.length + 1));
      }
    } catch (e) {}
    return null;
  }
  function closest(el, sel) {
    while (el && el.nodeType === 1) {
      var m = el.matches || el.msMatchesSelector || el.webkitMatchesSelector;
      if (m && m.call(el, sel)) return el;
      el = el.parentNode;
    }
    return null;
  }
  // The words as written (innerText would return CSS-uppercased "ENROLL NOW"), with a space between
  // separately laid-out parts (badge "A" + "Yes", "$1K" + block "per month") that textContent glues together.
  function words(node, out) {
    if (node.nodeType === 3) { out.push(node.data); return; }
    if (node.nodeType !== 1 || /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(node.tagName)) return;
    if (node.tagName === 'BR') { out.push(' '); return; }
    var d = 'inline';
    try { d = window.getComputedStyle(node).display; } catch (e) {}
    if (d === 'none') return;
    var gap = d !== 'inline' && d !== 'contents';
    if (gap) out.push(' ');
    for (var c = node.firstChild; c; c = c.nextSibling) words(c, out);
    if (gap) out.push(' ');
  }
  function text(el) {
    var shown = '';
    try { var parts = []; for (var c = el.firstChild; c; c = c.nextSibling) words(c, parts); shown = parts.join(''); } catch (e) {}
    if (!/\S/.test(shown)) shown = el.textContent || el.innerText || '';
    var t = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || shown || el.value || '';
    if (!t && el.querySelector) { var img = el.querySelector('img[alt]'); if (img) t = img.getAttribute('alt'); }
    return String(t).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').slice(0, 120);
  }
  function param(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search);
    if (!m) return null;
    try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) { return m[1]; }
  }
  function on(target, ev, fn, opts) { try { target.addEventListener(ev, fn, opts === undefined ? false : opts); } catch (e) {} }
  function safe(fn) { return function () { try { return fn.apply(this, arguments); } catch (e) { /* never break the page */ } }; }

  // ------------------------------------------------------------------ where to send
  var me = document.currentScript || document.querySelector('script[src*="/js/jm.js"]');
  var base = '';
  try { base = new URL(me.src, location.href).origin; } catch (e) { base = location.protocol + '//' + location.host; }
  var sameOrigin = base === location.protocol + '//' + location.host;
  var ENDPOINT = base + '/_jm/e';
  var CONSENT_URL = base + '/_jm/c';
  var consentMode = me && me.getAttribute ? me.getAttribute('data-c') : null; // set by the edge: g = go, r = ask first, n = declined
  var isCheckoutHost = /^checkout\./i.test(location.hostname);
  var framed = false;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }

  // ------------------------------------------------------------------ visitor id
  var vid = null, vidOrigin = 'cookie', prevVid = null;
  function resolveVid(serverVid) {
    var c = getCookie('jm_vid') || serverVid || null;
    var backup = store && !isCheckoutHost ? store.getItem(STORE_VID) : null;
    if (c && ID_RE.test(c)) {
      vid = c;
      if (backup && backup !== c && ID_RE.test(backup)) prevVid = backup; // same browser, older id: server re-joins them
    } else if (backup && ID_RE.test(backup)) {
      vid = backup; vidOrigin = 'storage';
    } else {
      vid = 's' + rid(21); vidOrigin = 'storage';
    }
    // Not on checkout pages: the id comes from the site each time there, and other scripts on those pages could read it.
    try { if (store && !isCheckoutHost) store.setItem(STORE_VID, vid); } catch (e) {}
  }

  // ------------------------------------------------------------------ queue + transport
  var q = [];
  var human = false;
  function push(e) {
    e.eid = rid(12);
    e.ts = now();
    if (human) e.h = 1;
    q.push(e);
    if (q.length >= 40) flush(false);
  }
  function payloadObj(events) {
    var p = { v: vid, o: vidOrigin, now: now(), e: events, sv: VERSION };
    if (prevVid) p.pv = prevVid; // sent with every batch from this page, so a lost beacon can't lose the re-join
    return p;
  }
  // Every batch is written to localStorage BEFORE it is sent and removed only once the site confirms it (2xx), so
  // nothing is lost when a page closes mid-send, the network drops, or the site is unreachable. A batch that never
  // got its answer is sent again from a later page; the tracker ignores events it already has (each has an id).
  function readQ() {
    if (!store) return [];
    try { var l = JSON.parse(store.getItem(STORE_Q) || '[]'); return l && l.push ? l : []; } catch (e) { return []; }
  }
  function writeQ(list) {
    if (!store) return;
    try {
      if (list.length) store.setItem(STORE_Q, JSON.stringify(list)); else store.removeItem(STORE_Q);
    } catch (e) {
      // Storage full: keep the newest half rather than nothing.
      try { store.setItem(STORE_Q, JSON.stringify(list.slice(Math.floor(list.length / 2)))); } catch (x) { try { store.removeItem(STORE_Q); } catch (y) {} }
    }
  }
  function saveBacklog(p, savedAt, key) {
    if (!store) return;
    var list = readQ();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].k === key) return;
    list.push({ k: key, t: savedAt || now(), p: p });
    while (list.length > 30) list.shift();
    writeQ(list);
  }
  function markBeaconCopy(key, at) {
    var list = readQ();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].k === key) { list[i].b = PAGE_INST; list[i].ba = at; writeQ(list); return; }
  }
  // A page's own page-close copy waits for a later page, unless this page lives on: after a minute (or once the
  // network is back) it resends it itself.
  function ownFresh(it) { return it && it.b === PAGE_INST && now() - (it.ba || 0) < 60000; }
  function dropBacklog(key) {
    if (!store || !key) return;
    var list = readQ(), out = [];
    for (var i = 0; i < list.length; i++) if (!(list[i] && list[i].k === key)) out.push(list[i]);
    if (out.length !== list.length) writeQ(out);
  }
  // 4xx = the server will never take this body: don't keep it. Network errors / 5xx = keep for later.
  function keepFor(status) { return !(status >= 400 && status < 500 && status !== 408 && status !== 429); }
  var inflight = {};
  var PAGE_INST = rid(8); // this page load: copies of its own page-close beacons are resent from a later page only
  function post(p, opts) {
    opts = opts || {};
    var key = opts.key || rid(10);
    var body = JSON.stringify(p);
    if (!opts.key) saveBacklog(p, now(), key); // new batch: saved first (a backlog item is already saved)
    inflight[key] = 1;
    function settle(ok, status) {
      delete inflight[key];
      var finished = ok || !keepFor(status); // delivered, or refused for good: either way it's done
      if (finished) dropBacklog(key);
      if (opts.done) opts.done(finished);
      else if (ok) drainSoon();
    }
    // Page closing: a beacon (the most dependable send while a page unloads). It can't report back, so the saved copy
    // stays and the next page sends it again (harmless: the tracker ignores events it already has).
    if (opts.beacon && navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }))) {
          delete inflight[key];
          // On checkout pages nothing personal is kept in storage once it's handed to the browser to send.
          if (isCheckoutHost) dropBacklog(key); else markBeaconCopy(key, now());
          return;
        }
      } catch (e) {}
    }
    if (window.fetch) {
      try {
        window.fetch(ENDPOINT, {
          method: 'POST', body: body, keepalive: !opts.noKeepalive && body.length < 30000, credentials: sameOrigin ? 'same-origin' : 'include',
          headers: { 'Content-Type': 'text/plain' },
        }).then(function (r) { settle(r.ok, r.status); }, function () { settle(false, 0); });
        return;
      } catch (e) {}
    }
    try {
      var x = new XMLHttpRequest();
      x.open('POST', ENDPOINT, true);
      x.withCredentials = !sameOrigin;
      x.setRequestHeader('Content-Type', 'text/plain');
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        settle(x.status >= 200 && x.status < 300, x.status);
      };
      x.send(body);
    } catch (e) { settle(false, 0); }
  }
  var started = false;
  function flush(beacon) {
    if (!vid || !started) return;
    snapshot();
    while (q.length) post(payloadObj(q.splice(0, 100)), { beacon: beacon });
  }
  // Saved batches go out one at a time, without keepalive (its small per-page budget is kept for page-hide sends).
  // Each is removed from storage only after the site confirms it; if this page closes mid-way, the rest wait.
  var draining = false, drainTimer = null;
  function sendBacklog() {
    if (!store || draining || !started) return;
    draining = true;
    var tried = {};
    var cutoff = now() - 7 * 864e5;
    (function next(ok) {
      if (ok === false) { draining = false; return; } // still can't get through: try again later
      var list = readQ(), keep = [], item = null, i;
      for (i = 0; i < list.length; i++) {
        var it = list[i];
        if (!(it && it.t > cutoff && it.p && it.p.e)) continue; // too old or unreadable: dropped
        if (!it.k) it.k = rid(10);
        keep.push(it);
      }
      if (keep.length !== list.length || JSON.stringify(keep) !== JSON.stringify(list)) writeQ(keep);
      for (i = 0; i < keep.length; i++) if (!tried[keep[i].k] && !inflight[keep[i].k] && !ownFresh(keep[i])) { item = keep[i]; break; }
      if (!item) { draining = false; return; }
      tried[item.k] = 1;
      item.p.now = now(); // the server dates each event by its age on this clock
      post(item.p, { noKeepalive: true, key: item.k, done: next });
    })();
  }
  // After a send succeeds, anything still waiting goes out too (e.g. a batch saved while the network was down).
  function drainSoon() {
    if (drainTimer || draining || !store) return;
    drainTimer = setTimeout(safe(function () {
      drainTimer = null;
      var list = readQ();
      for (var i = 0; i < list.length; i++) if (list[i] && !inflight[list[i].k] && !ownFresh(list[i])) { sendBacklog(); return; }
    }), 1000);
  }
  try { if (store) store.removeItem('jm_q'); } catch (e) {} // first version's backlog key (bodies without times)

  // ------------------------------------------------------------------ page view + engagement
  var pvId = null;
  var activeMs = 0, maxScroll = 0, lastAct = -1e9, lastTick = perf(), sentActive = -1, sentScroll = -1, playing = 0;
  function markHuman() {
    lastAct = perf();
    if (human) return;
    human = true;
    if (started) push({ t: 'h' });
  }
  function scrollPct() {
    try {
      var d = document.documentElement, b = document.body;
      var h = Math.max(d.scrollHeight, b ? b.scrollHeight : 0);
      var seen = (window.pageYOffset || d.scrollTop || 0) + (window.innerHeight || d.clientHeight);
      return h > 0 ? Math.min(100, Math.round((seen / h) * 100)) : 0;
    } catch (e) { return 0; }
  }
  function tick() {
    var t = perf();
    var step = t - lastTick;
    lastTick = t;
    // Active = page visible and (a real interaction in the last 30s, or audible video playing).
    if (!document.hidden && step > 0 && (t - lastAct < 30000 || playing > 0)) activeMs += Math.min(step, 5000);
  }
  function snapshot() {
    tick();
    var s = scrollPct();
    if (s > maxScroll) maxScroll = s;
    if (pvId && (activeMs !== sentActive || maxScroll !== sentScroll)) {
      sentActive = activeMs; sentScroll = maxScroll;
      q.push({ t: 'pu', eid: rid(12), ts: now(), id: pvId, a: Math.round(activeMs), s: maxScroll, h: human ? 1 : 0 });
    }
    for (var i = 0; i < videos.length; i++) videos[i].report(false);
  }
  function newPageView() {
    pvId = rid(16);
    activeMs = 0; maxScroll = 0; sentActive = -1; sentScroll = -1;
    push({ t: 'pv', id: pvId, u: location.href, ti: document.title ? document.title.slice(0, 300) : null, r: document.referrer || null, f: framed ? 1 : 0 });
  }

  // ------------------------------------------------------------------ identity
  var EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
  var sentEmails = {};
  function cleanEmail(v) { return String(v || '').replace(/\s/g, '').toLowerCase(); }
  function nameFrom(form) {
    var fn = null, ln = null;
    if (form && form.querySelector) {
      var f = form.querySelector('input[name="first_name"],input[name="fname"],input[name="firstName"],input[name="first-name"],input[autocomplete="given-name"],input[name="name"]');
      var l = form.querySelector('input[name="last_name"],input[name="lname"],input[name="lastName"],input[autocomplete="family-name"]');
      if (f && f.value) fn = String(f.value).replace(/^\s+|\s+$/g, '').split(/\s+/)[0].slice(0, 80);
      if (l && l.value) ln = String(l.value).replace(/^\s+|\s+$/g, '').slice(0, 80);
    }
    return { fn: fn, ln: ln };
  }
  // Signed in to our Learn platform: its server puts an encrypted identity token in <meta name="jm-id">. It is passed
  // on unread (only the tracker can open it). Checked on every page view, so signing in mid-visit counts too.
  var sentTk = '';
  function appIdentity() {
    var m = document.querySelector ? document.querySelector('meta[name="jm-id"]') : null;
    var tk = m && m.getAttribute('content');
    if (!tk || tk === sentTk || tk.length > 600) return;
    sentTk = tk;
    push({ t: 'id', k: 'app', tk: tk, pv: pvId });
    flush(false);
  }
  function identifyEmail(email, scope) {
    email = cleanEmail(email);
    if (!EMAIL_RE.test(email) || email.length > 254 || sentEmails[email]) return;
    sentEmails[email] = 1;
    var nm = nameFrom(scope);
    push({ t: 'id', k: 'form', em: email, fn: nm.fn, ln: nm.ln, pv: pvId });
    flush(true);
  }
  function isEmailInput(inp) {
    if (!inp || inp.tagName !== 'INPUT') return false;
    var type = (inp.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'hidden') return false;
    var name = ((inp.getAttribute('name') || '') + ' ' + (inp.id || '') + ' ' + (inp.getAttribute('autocomplete') || '')).toLowerCase();
    return type === 'email' || /e-?mail/.test(name);
  }
  function emailIn(scope) {
    if (!scope || !scope.querySelectorAll) return null;
    var inputs = scope.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      if (isEmailInput(inputs[i]) && EMAIL_RE.test(cleanEmail(inputs[i].value))) return { email: inputs[i].value, input: inputs[i] };
    }
    return null;
  }
  // The nearest container (form, or up to 6 levels up) holding an email field: covers forms that send with a button
  // and fetch instead of a real submit (the qualifier, checkout).
  function emailNear(el) {
    var form = closest(el, 'form');
    if (form) return { found: emailIn(form), scope: form };
    var node = el;
    for (var i = 0; i < 6 && node && node.parentNode; i++) {
      node = node.parentNode;
      if (node.nodeType !== 1) break;
      var f = emailIn(node);
      if (f) return { found: f, scope: node };
    }
    return { found: null, scope: null };
  }
  var submitHandler = safe(function (ev) {
    markHuman();
    var form = ev.target;
    var f = emailIn(form);
    if (f) identifyEmail(f.email, form);
  });
  // Checkout pages: the email field is often never submitted as a form. The address counts once it has settled
  // (5s after the last change, or when the page hides), so a typo corrected a moment later isn't recorded.
  var pendingEmail = null, pendingTimer = null;
  function commitPendingEmail() {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (pendingEmail) { var p = pendingEmail; pendingEmail = null; identifyEmail(p.email, p.scope); }
  }
  var changeHandler = safe(function (ev) {
    var el = ev.target;
    if (!isEmailInput(el) || !EMAIL_RE.test(cleanEmail(el.value))) return;
    pendingEmail = { email: el.value, scope: closest(el, 'form') || el.parentNode };
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(safe(commitPendingEmail), 5000);
  });
  var messageHandler = safe(function (ev) {
    if (!ev || !/^https:\/\/([a-z0-9-]+\.)?calendly\.com$/i.test(ev.origin || '')) return;
    var d = ev.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d || d.event !== 'calendly.event_scheduled' || !d.payload) return;
    var ce = d.payload.event && d.payload.event.uri, ci = d.payload.invitee && d.payload.invitee.uri;
    if (ce && ci) { markHuman(); push({ t: 'id', k: 'calendly', ce: ce, ci: ci, pv: pvId }); flush(true); }
  });
  function identityFromUrl() {
    var kid = param('ck_subscriber_id') || param('subscriber_id');
    if (kid && /^[1-9]\d{0,15}$/.test(kid)) push({ t: 'id', k: 'kit', kid: kid, pv: pvId });
    // Booking-confirmation pages carry the booking's opaque Calendly ids (?e=&i=). A URL can be shared, so this
    // counts as a weak signal (it never relabels a browser that already belongs to someone).
    var e = param('e'), i = param('i');
    if (e && i && /^[A-Za-z0-9-]{8,64}$/.test(e) && /^[A-Za-z0-9-]{8,64}$/.test(i)) push({ t: 'id', k: 'calendly', src: 'u', ce: e, ci: i, pv: pvId });
  }

  // ------------------------------------------------------------------ clicks
  var CLICKABLE = 'a[href],button,[role="button"],input[type="submit"],input[type="button"],summary,label[for]';
  var lastCheckoutClick = 0;
  var clickHandler = safe(function (ev) {
    if (ev.isTrusted === false) return; // synthetic clicks (scripts, scanners) don't count
    if (ev.type === 'auxclick' && ev.button !== 1) return;
    var el = closest(ev.target, CLICKABLE);
    if (!el || closest(el, '.plyr')) return; // video player controls are covered by video tracking
    markHuman();
    var href = el.href && typeof el.href === 'string' ? el.href : (el.getAttribute && el.getAttribute('data-href')) || null;
    var kind = el.tagName === 'A' ? 'link' : 'button';
    if (href && /^https?:\/\/checkout\.jasonmoss\.com\/checkout\//i.test(href)) { kind = 'checkout'; lastCheckoutClick = now(); }
    push({ t: 'ck', pv: pvId, k: kind, l: text(el), u: href });
    // A button that sends a form (real or fetch-based) with an email next to it: that's the visitor's email.
    if (kind === 'button' && el.tagName !== 'SUMMARY' && el.tagName !== 'LABEL') {
      var near = emailNear(el);
      if (near.found) { if (pendingEmail) { pendingEmail = null; } identifyEmail(near.found.email, near.scope); }
    }
    if (kind !== 'button' || closest(el, 'form')) flush(true); // the page may be about to change
  });

  // ------------------------------------------------------------------ videos
  // Hooks the <video> element of every player bunny-embeds.js registers (works for Plyr and the native fallback).
  var videos = [];
  function b64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    try { return window.btoa(s); } catch (e) { return ''; }
  }
  function trackVideo(entry) {
    if (!entry || entry.__jmT) return;
    var v = entry.video;
    var guid = entry.bunnyId || (v && v.getAttribute && v.getAttribute('data-bunny-id'));
    if (!v || !guid || !/^[0-9a-f-]{36}$/i.test(guid)) return;
    entry.__jmT = 1;
    var cfg = (window.JM_BUNNY_CONFIG && window.JM_BUNNY_CONFIG.videos && window.JM_BUNNY_CONFIG.videos[guid]) || {};
    var st;
    function reset() {
      st = {
        id: rid(16), guid: guid.toLowerCase(), lid: entry.videoId && entry.videoId !== guid ? String(entry.videoId).slice(0, 64) : null,
        tt: cfg.title || (entry.title ? String(entry.title).slice(0, 200) : null), watched: 0, maxPos: 0, buckets: [], plays: 0, seeks: 0, ended: 0, last: null, lastChunk: -1,
        countingPlay: false, dirty: false, sentSig: '', lastAudibleAt: -1,
      };
    }
    reset();
    function dur() { var d = Number(v.duration); return isFinite(d) && d > 0 ? d : 0; }
    // Only audible playback counts (muted autoplay previews don't): same rule as the old 50% tracker.
    function audible() { return !v.muted && v.volume > 0; }
    // `playing` (keeps the page "active") follows audible playback only.
    function syncPlaying() {
      var should = !v.paused && !v.ended && audible();
      if (should && !st.countingPlay) { st.countingPlay = true; playing++; }
      else if (!should && st.countingPlay) { st.countingPlay = false; playing = Math.max(0, playing - 1); }
    }
    function onTime() {
      var pos = Number(v.currentTime) || 0;
      if (st.last !== null && !v.paused && !v.seeking) {
        var delta = pos - st.last;
        var maxStep = 2.5 * (v.playbackRate || 1);
        if (delta > 0 && delta <= maxStep && audible()) {
          st.watched += delta;
          if (pos > st.maxPos) st.maxPos = pos; // furthest point = furthest point actually heard
          st.lastAudibleAt = pos;
          // Each 5-second chunk counts once per pass; it only counts again after playback left it and came back.
          var a = Math.floor(st.last / BUCKET_S), b = Math.floor(pos / BUCKET_S);
          for (var i = a; i <= b && i < MAX_BUCKETS; i++) {
            if (st.lastChunk !== i) { st.buckets[i] = Math.min(255, (st.buckets[i] || 0) + 1); st.lastChunk = i; }
          }
          st.dirty = true;
        }
      }
      st.last = pos;
    }
    // Resuming (or a tiny seek) inside the chunk last counted doesn't count it again.
    function rebase() {
      var pos = Number(v.currentTime) || 0;
      st.last = pos;
      if (Math.floor(pos / BUCKET_S) !== st.lastChunk) st.lastChunk = -1;
    }
    on(v, 'timeupdate', safe(onTime));
    on(v, 'play', safe(function () {
      if (audible()) { st.plays++; st.dirty = true; markHuman(); }
      rebase(); syncPlaying();
    }));
    on(v, 'pause', safe(function () { onTime(); st.last = null; syncPlaying(); report(true); }));
    on(v, 'ended', safe(function () {
      onTime();
      // "Finished" only when the last stretch was actually heard (not a muted autoplay or a scrub to the end).
      if (st.lastAudibleAt >= 0 && dur() > 0 && dur() - st.lastAudibleAt < 3 * BUCKET_S) { st.ended = 1; st.dirty = true; }
      st.last = null; syncPlaying(); report(true); flush(false);
    }));
    on(v, 'seeking', safe(function () { if (audible()) st.seeks++; st.last = null; }));
    on(v, 'seeked', safe(rebase));
    on(v, 'volumechange', safe(function () {
      if (!audible()) st.last = Number(v.currentTime) || 0;
      else if (!v.paused) { markHuman(); if (!st.plays) { st.plays = 1; st.dirty = true; } }
      syncPlaying();
    }));
    function report(force) {
      if (!st.dirty && !force) return;
      if (!(st.watched > 0)) return; // muted autoplay that nobody listened to isn't a viewing
      var sig = Math.round(st.watched) + '|' + Math.round(st.maxPos) + '|' + st.plays + '|' + st.seeks + '|' + st.ended;
      if (sig === st.sentSig) { st.dirty = false; return; }
      st.sentSig = sig;
      st.dirty = false;
      var arr = [];
      for (var i = 0; i < st.buckets.length; i++) arr.push(st.buckets[i] || 0);
      q.push({
        t: 'vv', eid: rid(12), ts: now(), h: human ? 1 : 0, id: st.id, pv: pvId, g: st.guid, lid: st.lid, tt: st.tt, d: Math.round(dur() * 10) / 10,
        w: Math.round(st.watched * 10) / 10, m: Math.round(st.maxPos * 10) / 10, b: b64(arr), pl: st.plays, sk: st.seeks,
        r: v.playbackRate || 1, en: st.ended,
      });
    }
    // A back/forward-cache restore is a new visit: the video gets a fresh viewing record too.
    function restart() { report(true); var keepPlaying = st.countingPlay; reset(); st.countingPlay = keepPlaying; }
    videos.push({ report: report, restart: restart });
  }
  // Bunny's embedded player (iframe, controlled through Bunny's player.js), as on the Learn platform. The page
  // hands each Player over: (window.JM_EMBEDS = window.JM_EMBEDS || []).push({ player, guid, title, iframe }).
  // It is wrapped to look like a <video> element, so the same counting rules apply (audible playback only).
  function embedAdapter(x) {
    var player = x.player, ls = {};
    var v = {
      duration: 0, currentTime: 0, paused: true, ended: false, seeking: false, muted: false, volume: 1, playbackRate: 1,
      addEventListener: function (ev, fn) { (ls[ev] = ls[ev] || []).push(fn); },
    };
    function emit(ev) { var l = ls[ev] || []; for (var i = 0; i < l.length; i++) l[i](); }
    function checkSound() {
      try {
        player.getMuted(safe(function (m) { var was = v.muted; v.muted = m === true || m === 'true'; if (was !== v.muted) emit('volumechange'); }));
        player.getVolume(safe(function (vol) { var n = Number(vol); if (isFinite(n)) { var was = v.volume > 0; v.volume = n; if (was !== n > 0) emit('volumechange'); } }));
      } catch (e) {}
    }
    var lastSound = 0;
    player.on('play', safe(function () { v.paused = false; v.ended = false; checkSound(); emit('play'); }));
    player.on('pause', safe(function () { if (v.paused) return; v.paused = true; emit('pause'); }));
    player.on('ended', safe(function () { v.paused = true; v.ended = true; emit('ended'); }));
    player.on('seeked', safe(function () { emit('seeking'); emit('seeked'); }));
    player.on('timeupdate', safe(function (d) {
      if (!d) return;
      var sec = Number(d.seconds), du = Number(d.duration);
      if (isFinite(du) && du > 0) v.duration = du;
      if (!isFinite(sec)) return;
      if (v.paused) { v.paused = false; v.ended = false; emit('play'); } // a play event Bunny didn't send
      v.currentTime = sec;
      if (now() - lastSound > 5000) { lastSound = now(); checkSound(); } // muted / volume changes while playing
      emit('timeupdate');
    }));
    // The app removed the player (moved to another lesson): it stopped playing.
    var gone = setInterval(safe(function () {
      if (x.iframe && !(document.documentElement && document.documentElement.contains(x.iframe))) {
        clearInterval(gone);
        if (!v.paused) { v.paused = true; emit('pause'); }
      }
    }), 2000);
    return v;
  }
  function hookEmbeds() {
    var list = (window.JM_EMBEDS = window.JM_EMBEDS || []);
    var take = safe(function (x) {
      if (!x || x.__jm || !x.player || typeof x.player.on !== 'function') return;
      x.__jm = 1;
      trackVideo({ video: embedAdapter(x), bunnyId: x.guid, title: x.title });
    });
    for (var i = 0; i < list.length; i++) take(list[i]);
    list.push = function () {
      var r = Array.prototype.push.apply(list, arguments);
      for (var j = 0; j < arguments.length; j++) take(arguments[j]);
      return r;
    };
  }

  function hookVideos() {
    var JM = (window.JM_BUNNY = window.JM_BUNNY || {});
    JM.players = JM.players || [];
    JM._cbs = JM._cbs || [];
    JM.onPlayer = JM.onPlayer || function (cb) {
      try { for (var i = 0; i < JM.players.length; i++) cb(JM.players[i]); } catch (e) {}
      JM._cbs.push(cb);
    };
    JM.onPlayer(safe(trackVideo));
  }

  // ------------------------------------------------------------------ embedded checkouts (Spiffy popups/embeds on our pages)
  // Skipped when the click that opened it was just logged. Not a human signal on its own (the server is told).
  function watchEmbeds() {
    if (!window.MutationObserver) return;
    var seen = {}, timer = null;
    function check() {
      timer = null;
      var frames = document.querySelectorAll('iframe[src*="checkout.jasonmoss.com/checkout/"]');
      for (var i = 0; i < frames.length; i++) {
        var src = frames[i].getAttribute('src') || '';
        var m = /\/checkout\/([^/?#]+)/.exec(src);
        var slug = m ? m[1] : src;
        if (seen[slug]) continue;
        seen[slug] = 1;
        if (now() - lastCheckoutClick < 15000) continue;
        push({ t: 'ck', pv: pvId, k: 'checkout', l: 'Opened checkout', u: src, auto: 1 });
        flush(false);
      }
    }
    try {
      new MutationObserver(function () { if (!timer) timer = setTimeout(safe(check), 400); })
        .observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    check();
  }

  // ------------------------------------------------------------------ start
  function begin(serverVid) {
    if (started) return;
    started = true;
    resolveVid(serverVid);
    lastTick = perf();
    newPageView();
    identityFromUrl();
    appIdentity();
    hookVideos();
    hookEmbeds();
    watchEmbeds();
    var act = safe(markHuman);
    on(document, 'pointerdown', act, true);
    on(document, 'keydown', act, true);
    on(document, 'touchstart', act, { capture: true, passive: true });
    on(window, 'wheel', act, { passive: true });
    on(window, 'scroll', safe(function () { var s = scrollPct(); if (s > maxScroll) maxScroll = s; }), { passive: true });
    on(document, 'mousemove', safe(function () { lastAct = perf(); }), { passive: true });
    on(document, 'click', clickHandler, true);
    on(document, 'auxclick', clickHandler, true);
    on(document, 'submit', submitHandler, true);
    if (isCheckoutHost) on(document, 'change', changeHandler, true); // typed-but-unsent emails only count at checkout
    on(window, 'message', messageHandler);
    on(document, 'visibilitychange', safe(function () {
      tick();
      if (document.hidden) { commitPendingEmail(); flush(true); }
    }));
    on(window, 'pagehide', safe(function () { commitPendingEmail(); flush(true); }));
    // In-page navigation (single-page apps such as Spiffy's checkout -> upsell -> thank-you steps): a new URL path
    // is a new page view. Hash-only changes (#section links) are not.
    var lastPath = location.pathname + location.search;
    var routeChanged = safe(function () {
      var p = location.pathname + location.search;
      if (p === lastPath) return;
      var from = location.protocol + '//' + location.host + lastPath;
      lastPath = p;
      commitPendingEmail();
      flush(false); // close out the previous view's time and scroll
      pvId = rid(16);
      activeMs = 0; maxScroll = 0; sentActive = -1; sentScroll = -1;
      push({ t: 'pv', id: pvId, u: location.href, ti: document.title ? document.title.slice(0, 300) : null, r: from, f: framed ? 1 : 0 });
      appIdentity();
      flush(false);
    });
    try {
      var wrap = function (name) {
        var orig = history[name];
        if (typeof orig !== 'function') return;
        history[name] = function () {
          var r = orig.apply(this, arguments);
          setTimeout(routeChanged, 0); // after the app has updated the title
          return r;
        };
      };
      wrap('pushState');
      wrap('replaceState');
    } catch (e) {}
    on(window, 'popstate', function () { setTimeout(routeChanged, 0); });
    // Back/forward cache: the page comes back exactly as it was left. That's a new view of it.
    on(window, 'pageshow', safe(function (ev) {
      if (!ev || !ev.persisted) return;
      for (var i = 0; i < videos.length; i++) videos[i].restart();
      lastTick = perf();
      newPageView();
      flush(false);
    }));
    setInterval(safe(tick), 1000);
    var lastHiddenFlush = 0;
    setInterval(safe(function () {
      if (!document.hidden) { flush(false); return; }
      // Listening in a background tab or with the screen locked: still save progress about once a minute.
      if (playing > 0 && now() - lastHiddenFlush >= HIDDEN_FLUSH_MS) { lastHiddenFlush = now(); flush(true); }
    }), FLUSH_MS);
    flush(false);
    setTimeout(safe(sendBacklog), 3000);
    on(window, 'online', safe(function () {
      // Back online: this page's own copies may never have left (a beacon queued while offline), so they go now.
      var list = readQ(), changed = false;
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].b === PAGE_INST) { list[i].ba = 0; changed = true; }
      if (changed) writeQ(list);
      setTimeout(safe(sendBacklog), 1000);
    }));
  }
  // Pages Chrome prerenders or Safari preloads, and background tabs, only count once someone actually sees them.
  function start(serverVid) {
    if (document.prerendering) {
      on(document, 'prerenderingchange', safe(function () { start(serverVid); }), { once: true });
      return;
    }
    if (document.visibilityState === 'hidden') {
      var go = safe(function () {
        if (document.visibilityState === 'hidden') return;
        document.removeEventListener('visibilitychange', go);
        begin(serverVid);
      });
      on(document, 'visibilitychange', go);
      return;
    }
    begin(serverVid);
  }

  // ------------------------------------------------------------------ consent (EU/UK visitors only; decided at the edge)
  function consentBanner(onDecide) {
    var css = '#jm-consent{position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483000;max-width:560px;margin:0 auto;background:#1F2D26;color:#F8F6F2;'
      + 'font:15px/1.55 Raleway,system-ui,sans-serif;padding:18px 20px;border-top:2px solid #C2A86C;box-shadow:0 8px 30px rgba(0,0,0,.25)}'
      + '#jm-consent p{margin:0 0 12px}#jm-consent a{color:#C2A86C}#jm-consent .jm-b{display:flex;gap:10px;flex-wrap:wrap}'
      + '#jm-consent button{font:600 12.5px/1 Raleway,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;padding:12px 18px;border:0;cursor:pointer;min-height:44px}'
      + '#jm-consent .jm-y{background:#C2A86C;color:#1D1F1E}#jm-consent .jm-n{background:transparent;color:#F8F6F2;box-shadow:inset 0 0 0 1px rgba(248,246,242,.45)}';
    var st = document.createElement('style');
    st.appendChild(document.createTextNode(css));
    var box = document.createElement('div');
    box.id = 'jm-consent';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Cookie choice');
    box.innerHTML = '<p>I&rsquo;d like to use a first-party cookie to see which pages and videos are useful, so I can make better ones. <a href="https://jasonmoss.com/privacy/">Privacy</a></p>'
      + '<div class="jm-b"><button type="button" class="jm-y">Accept</button><button type="button" class="jm-n">No thanks</button></div>';
    function decide(yes) {
      try { box.parentNode.removeChild(box); } catch (e) {}
      onDecide(yes);
    }
    box.querySelector('.jm-y').onclick = function () { decide(true); };
    box.querySelector('.jm-n').onclick = function () { decide(false); };
    (document.head || document.documentElement).appendChild(st);
    document.body.appendChild(box);
  }
  function sendConsent(yes, cb) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', CONSENT_URL + '?v=' + (yes ? '1' : '0'), true);
      x.withCredentials = true;
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        var v = null;
        try { v = JSON.parse(x.responseText).v; } catch (e) {}
        cb(v);
      };
      x.send();
    } catch (e) { cb(null); }
  }
  function askConsent() {
    var choice = getCookie('jm_consent');
    if (choice === '0') return; // declined: nothing runs
    if (choice === '1') return start();
    // Inside an iframe (the qualifier, an embedded checkout) the notice would cover the form: the page around it
    // shows the notice, and this frame starts once the visitor has accepted there.
    if (framed) {
      var waited = 0;
      var poll = setInterval(safe(function () {
        waited += 1500;
        var c = getCookie('jm_consent');
        if (c === '1') { clearInterval(poll); start(); }
        else if (c === '0' || waited > 30 * 60000) clearInterval(poll);
      }), 1500);
      return;
    }
    var show = function () {
      consentBanner(function (yes) { sendConsent(yes, function (v) { if (yes) start(v); }); });
    };
    if (document.body) show(); else on(document, 'DOMContentLoaded', safe(show));
  }
  // Loaded outside the edge (checkout pages via GTM): ask the edge whether consent is needed and for the id.
  function checkThenStart() {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', CONSENT_URL, true);
      x.withCredentials = true;
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        var r = null;
        try { r = JSON.parse(x.responseText); } catch (e) {}
        if (r && r.c === 'r') return askConsent();
        if (r && r.c === 'n') return; // declined earlier
        if (!r) return; // can't reach the site: stay quiet rather than make up an id
        start(r.v);
      };
      x.send();
    } catch (e) { /* stay quiet */ }
  }

  // A small public hook for pages that collect an email without a form (rarely needed: buttons near an email
  // field are picked up automatically).
  window.JM_TRACK = { identify: safe(function (email) { if (started) identifyEmail(email, null); }) };

  // Nothing runs while the page is still being parsed: the tracker starts right after (DOMContentLoaded), so it
  // never delays the page's own scripts, videos or forms.
  function init() {
    try {
      if (navigator.webdriver) return; // automated browsers (crawlers, test robots)
      if (consentMode === 'g') start();
      else if (consentMode === 'r') askConsent();
      else if (consentMode === 'n') return;
      else checkThenStart();
    } catch (e) { /* never break the page */ }
  }
  try {
    if (document.readyState === 'loading') on(document, 'DOMContentLoaded', safe(init));
    else init();
  } catch (e) { /* never break the page */ }
})();
