/* Shared opt-in form infrastructure for jasonmoss.com
 *
 * One file owns everything that used to be copy-pasted across the opt-in
 * pages: the Cloudflare Turnstile loader, the submit gate, international
 * phone assembly, and the full submit pipeline (field validation ->
 * ZeroBounce -> Kit signup -> optional Roezan SMS sync -> redirect).
 *
 * A page includes this file, keeps its own markup/modal code, and calls:
 *
 *   JMOptin.init({
 *     kitTagId: 12345,                                  // required
 *     redirect: function (ctx) { return '/thanks/'; },  // required; ctx = {firstName, email, form}
 *     phone: true,                                      // page has Country Code + Phone Number fields
 *     roezanTagId: 1626,                                // also sync to Roezan (needs phone: true)
 *     validate: function (form) { return '' or 'msg' }, // extra page-specific validation
 *     extraPayload: function (form) { return {...}; },  // extra Kit payload fields (latest_ad etc.)
 *     fastRedirectMs: 1500,                              // optional: redirect this soon even if the Kit
 *                                                       // submit hasn't answered yet (see below); ignored
 *                                                       // while the revenue question is on (it needs the
 *                                                       // Kit reply's answer_pass)
 *     onSuccess: function (ctx) { ... },                 // optional: called INSTEAD of the redirect once the
 *                                                       // opt-in is captured; ctx adds {response} (the Kit
 *                                                       // submit's JSON, or null if it didn't answer) and
 *                                                       // {redirectUrl}. The page then owns navigation.
 *                                                       // Passing onSuccess without revenueQuestion turns
 *                                                       // the revenue question off; with both, the question
 *                                                       // owns navigation and onSuccess is not called.
 *     onSubmitStart: function (ctx) { ... },             // optional: fields passed local checks and the
 *                                                       // email check + Kit submit are starting ({firstName,
 *                                                       // email, form}); lets a page move on visually
 *     onSubmitFail: function () { ... },                 // optional: that attempt failed and the form is
 *                                                       // usable again (the visitor saw the usual alert)
 *     revenueQuestion: { headline, idle, going, ... },   // the two-step revenue question: ON BY DEFAULT for
 *                                                       // every form (pass false, or onSuccess without it,
 *                                                       // to turn it off). Set the
 *                                                       // copy here and style it in the page's own <style>
 *                                                       // via the --s2-* variables / .jm-s2 rules. See the
 *                                                       // "Revenue question" section below.
 *   });
 *
 * The Cloudflare api.js tag must come AFTER this file:
 *   <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstile&render=explicit" async defer></script>
 */
(function () {
  'use strict';

  /* ── Turnstile ──────────────────────────────────────────────────────────
   * Cloudflare renders the widget inside a CLOSED shadow root whose host div
   * always measures 0px tall, so the widget's real size cannot be read from
   * the DOM. Render appearance:'interaction-only' so nothing paints for
   * auto-passed visitors, and reserve the widget's KNOWN size (300x65) via
   * Cloudflare's before-interactive-callback at the moment it is about to
   * paint (grow-only, so no button jumping). */
  var TURNSTILE_SITEKEY = '0x4AAAAAADlUEkeJ6kJ-_AML';
  var TS_NAT_W = 300, TS_NAT_H = 65; // Turnstile "normal" widget nominal size

  window.__tsWidgetId = null;
  window.getTurnstileToken = function () {
    try {
      if (window.turnstile && window.__tsWidgetId !== null) {
        return window.turnstile.getResponse(window.__tsWidgetId) || '';
      }
    } catch (e) {}
    return '';
  };

  function collapseTurnstile() {
    var b = document.getElementById('cf-turnstile-box');
    if (b && b.getAttribute('data-reserved') !== '1') { b.style.height = '0'; b.style.margin = '0'; }
  }

  function reserveTurnstile() {
    try {
      var b = document.getElementById('cf-turnstile-box');
      if (!b) return;
      var form = b.closest('.email-form');
      var btn = form ? form.querySelector('.form-btn') : null;
      var prev = b.previousElementSibling;   // in-flow field above (skip the hidden honeypot)
      while (prev && (getComputedStyle(prev).position === 'absolute' || prev.offsetParent === null)) prev = prev.previousElementSibling;
      var inner = b.firstElementChild;
      var avail = b.getBoundingClientRect().width || TS_NAT_W;
      var z = TS_NAT_W > avail ? (avail / TS_NAT_W) : 1;
      if (inner) inner.style.zoom = (z < 1 ? z : '');
      b.style.display = 'flex'; b.style.alignItems = 'center'; b.style.justifyContent = 'center';
      b.style.margin = '16px auto';
      if (btn) btn.style.marginTop = '0px';
      if (prev) prev.style.marginBottom = '0px';
      // Grow-only so later calls never shrink the box mid-interaction (no jump).
      var reserved = Math.ceil(TS_NAT_H * z) + 6;
      var cur = parseInt(b.style.height, 10) || 0;
      if (reserved > cur) b.style.height = reserved + 'px';
      b.setAttribute('data-reserved', '1');
    } catch (e) {}
  }

  window.onloadTurnstile = function () {
    if (window.turnstile && document.getElementById('cf-turnstile-box')) {
      collapseTurnstile();
      window.__tsWidgetId = window.turnstile.render('#cf-turnstile-box', {
        sitekey: TURNSTILE_SITEKEY,
        appearance: 'interaction-only',
        'before-interactive-callback': reserveTurnstile,
        // A widget error or unsupported browser means no token is coming:
        // flag it so the submit gate sends without one instead of waiting.
        callback: function () { window.__tsFailed = false; },
        'error-callback': function () { window.__tsFailed = true; },
        'unsupported-callback': function () { window.__tsFailed = true; }
      });
      window.addEventListener('resize', function () {
        var b = document.getElementById('cf-turnstile-box');
        if (b && b.getAttribute('data-reserved') === '1') reserveTurnstile();
      });
    }
  };

  /* ── Submit gate ────────────────────────────────────────────────────────
   * Capture phase + stopImmediatePropagation runs BEFORE the page's submit
   * handler, so the submit waits briefly for a Turnstile token. The widget is
   * invisible (interaction-only), so a missing token is almost always one that
   * hasn't minted yet: let field errors surface first (checkValidity), re-run
   * the challenge, and resubmit as soon as the token lands.
   *
   * It never blocks a real visitor for good. Some browsers can't run Turnstile
   * at all (ad/privacy blockers, some in-app browsers, widget errors); after a
   * short wait the gate lets the submit through without a token, and the
   * server admits it through its capped tokenless lane (submit-contact.js,
   * TOKENLESS LANE). If Cloudflare shows an interactive challenge, the visitor
   * is asked once to complete it; a second click goes through regardless. */
  var TOKEN_WAIT_MS = 4000;
  (function () {
    var retrying = false;
    var bypass = false;
    var asked = false;
    function challengeShown() {
      var b = document.getElementById('cf-turnstile-box');
      return !!(b && b.getAttribute('data-reserved') === '1');
    }
    function resubmit(form) {
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
      else if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    function gate(e) {
      var form = e.currentTarget;
      if (bypass) { bypass = false; return; }
      if (window.getTurnstileToken()) return;
      if (form && typeof form.checkValidity === 'function' && !form.checkValidity()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (retrying) return;
      if (challengeShown() && !asked) {
        asked = true;
        alert('Please complete the quick verification check, then click the button again.');
        return;
      }
      retrying = true;
      var btn = form ? form.querySelector('.form-btn') : null;
      var label = btn ? btn.textContent : '';
      if (btn) btn.textContent = 'One moment…';
      if (!window.__tsFailed && !challengeShown()) {
        try { if (window.turnstile && window.__tsWidgetId != null) window.turnstile.reset(window.__tsWidgetId); } catch (_) {}
      }
      var waited = 0;
      var poll = setInterval(function () {
        waited += 250;
        var tok = window.getTurnstileToken();
        var giveUp = window.__tsFailed || waited >= TOKEN_WAIT_MS;
        if (!tok && !giveUp) return;
        clearInterval(poll);
        retrying = false;
        if (btn) btn.textContent = label;
        if (!tok) bypass = true;   // no token is coming: send without one
        resubmit(form);
      }, 250);
    }
    function wire() { document.querySelectorAll('.email-form').forEach(function (f) { f.addEventListener('submit', gate, true); }); }
    if (document.readyState !== 'loading') wire(); else document.addEventListener('DOMContentLoaded', wire);
  })();

  /* ── Phone ──────────────────────────────────────────────────────────────
   * Build an E.164 phone from the country-code dropdown + the typed number.
   * Handles common typing habits: a trunk "0" before the national number
   * (07700... outside +1), the 00 international dialing prefix, a full
   * "+44..." pasted into the field despite the dropdown, and a US number
   * typed with its leading 1. Must stay in sync with normalizePhone in
   * netlify/functions/submit-contact.js. */
  function buildE164(countryCode, phoneRaw) {
    var raw = String(phoneRaw).trim();
    var digits = raw.replace(/\D/g, '');
    if (!digits) return '';
    if (raw.charAt(0) === '+') return '+' + digits;
    if (digits.slice(0, 2) === '00') return '+' + digits.slice(2);
    if (countryCode === '1') {
      if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
    } else {
      digits = digits.replace(/^0+/, '');
    }
    return '+' + countryCode + digits;
  }

  /* ── Revenue question (two-step) ────────────────────────────────────────
   * config.revenueQuestion turns a page's opt-in into two steps. The moment
   * name + email pass the local checks, the form's card swaps (same size) to
   * one tap-to-answer question while the email check and Kit save finish in
   * the background. Codes match OPTIN_REVENUE in netlify/functions/
   * submit-contact.js; the answer goes to submit-optin-answer.js with the
   * answer_pass from the Kit save. Its default look is the original
   * /resonance-masterclass-optin/ design, which uses this component too.
   *
   * Meta Lead: fired HERE as soon as the server confirms the save (tagged or
   * queued), so someone who opts in and never answers still counts. The page
   * then goes to its usual destination with qualified=false added, which the
   * GTM thank-you Lead rule already excludes, so nobody counts twice. If the
   * pixel never loaded, the URL is left alone, so a thank-you destination
   * still gets GTM's Lead.
   * A page whose own redirect already carries qualified=false never gets a
   * page Lead.
   *
   * Meta "Qualified Lead": a custom event fired once, on top of the Lead, when a
   * confirmed opt-in taps $1K–$10K or $10K+ (QUALIFIED_ANSWERS). Ad sets can
   * optimize on it (via a custom conversion) to find earners, not just any
   * opt-in. The Stape CAPI gateway mirrors it server-side like every pixel event.
   *
   *   revenueQuestion: {                // on by default; false turns it off
   *     headline: 'One last question before your training starts',
   *     idle:     'Tap one to start your training.',
   *     going:    'Starting your training…',
   *     container: '.selector',   // card whose content swaps (default: the form's parent)
   *     progressHost: '.selector',// element whose top edge carries the bar (default: container)
   *     standalone: true          // no card around the form: the question brings its own
   *   }
   *
   * Adding it to a new form: include this file, call JMOptin.init as usual, set
   * revenueQuestion.headline/idle/going to fit the page, and give the page a
   * <style id="jm-s2-theme"> block that matches its own palette and type
   * (copy a sibling page's block as a starting point).
   */
  // Every color, font and shape is a --s2-* custom property with the Resonance
  // look as its default. A page restyles the card in its own <style>, e.g.
  //   .jm-s2 { --s2-tile-radius: 2px; --s2-sel-bg: #C2A86C; }
  // or with ordinary .jm-s2 rules; this sheet is inserted FIRST in <head>, so
  // a page's rules win any tie. The progress bar sits in the host card, OUTSIDE
  // .jm-s2 (except standalone), so style it on .jm-s2-progress itself, e.g.
  //   .jm-s2-progress { --s2-accent: #C2A86C; --s2-track: #EFE9DB; --s2-bar-h: 3px; }
  var S2_CSS = [
    '.jm-s2[hidden],.jm-s2-off{display:none!important}',
    '.jm-s2-host{position:relative}',
    '.jm-s2-swap{display:flex!important;flex-direction:column;justify-content:center}',
    '.jm-s2{width:100%;max-width:28rem;margin:0 auto;text-align:center;font-family:var(--s2-sans,"Raleway",sans-serif);box-sizing:border-box}',
    '.jm-s2 *{box-sizing:border-box}',
    '.jm-s2.is-standalone{position:relative;max-width:none;overflow:hidden;background:var(--s2-card-bg,#fff);border:var(--s2-card-border,1px solid rgba(221,219,211,.7));border-radius:var(--s2-card-radius,.375rem);box-shadow:var(--s2-card-shadow,0 1.25rem 2.75rem rgba(29,31,30,.11),0 .25rem .75rem rgba(93,93,93,.08));padding:1.75rem 1.25rem 1.125rem}',
    '.jm-s2.is-standalone .jm-s2-headline{max-width:none;margin-bottom:1rem}',
    '.jm-s2.is-standalone .jm-s2-kicker{margin-bottom:.75rem}',
    '.jm-s2-progress{display:block;position:absolute;top:0;left:0;right:0;height:var(--s2-bar-h,5px);overflow:hidden;background:var(--s2-track,#ECE6D6);border-radius:var(--s2-bar-radius,var(--s2-host-radius,0));pointer-events:none}',
    '.jm-s2-progress i{display:block;height:100%;background:var(--s2-accent,var(--gold,#B8962E));transform-origin:left center;transform:scaleX(.85);animation:jm-s2-grow .7s cubic-bezier(.22,.61,.36,1) .1s both}',
    '@keyframes jm-s2-grow{from{transform:scaleX(.5)}to{transform:scaleX(.85)}}',
    '.jm-s2 .jm-s2-kicker{display:flex;align-items:center;gap:.375rem;width:fit-content;max-width:100%;margin:0 auto .875rem;padding:.3125rem .75rem;border-radius:999px;background:var(--s2-pill-bg,#EEF2EC);font-family:var(--s2-sans,"Raleway",sans-serif);font-weight:600;font-size:.75rem;line-height:1.2;letter-spacing:0;text-transform:none;color:var(--s2-pill-ink,#2C3E2D)}',
    '.jm-s2 .jm-s2-kicker::before{content:"";flex:none;width:.4375rem;height:.4375rem;border-radius:50%;background:var(--s2-dot,#3E6B4A)}',
    '.jm-s2 .jm-s2-kicker:empty{display:none}',
    '.jm-s2 .jm-s2-headline{margin:0 auto 1.25rem;max-width:22rem;font-family:var(--s2-serif,"Libre Baskerville",Georgia,serif);font-weight:400;font-style:normal;font-size:var(--s2-headline-size,1.375rem);line-height:1.3;letter-spacing:0;text-transform:none;color:var(--s2-ink,#1D1F1E);text-wrap:balance}',
    '.jm-s2 .jm-s2-headline:focus,.jm-s2 .jm-s2-headline:focus-visible{outline:none}',
    '.jm-s2 .jm-s2-panel{margin:0 -.5rem;padding:1rem .5rem .875rem;background:var(--s2-panel-bg,#F8F5EE);border:var(--s2-panel-border,1px solid #ECE4D2);border-radius:var(--s2-panel-radius,.375rem)}',
    '.jm-s2 .jm-s2-q{display:block;margin:0 0 .75rem;font-family:var(--s2-sans,"Raleway",sans-serif);font-weight:600;font-size:.875rem;line-height:1.3;letter-spacing:0;text-transform:none;color:var(--s2-text,#2E3A2E);text-align:center;text-wrap:balance}',
    '.jm-s2 .jm-s2-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.5rem}',
    '.jm-s2 .jm-s2-opt{display:block;width:100%;height:auto;min-height:0;padding:0;margin:0;border:0;border-radius:0;background:none;box-shadow:none;font:inherit;letter-spacing:0;text-transform:none;cursor:pointer;-webkit-appearance:none;appearance:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation}',
    '.jm-s2 .jm-s2-opt span{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.125rem;text-align:center;min-height:3.5rem;padding:.6rem .25rem;border:var(--s2-tile-border,1px solid #C9BB94);border-radius:var(--s2-tile-radius,.25rem);background:var(--s2-tile-bg,#fff);box-shadow:var(--s2-tile-shadow,0 1px 2px rgba(29,31,30,.06));font-family:var(--s2-sans,"Raleway",sans-serif);color:var(--s2-text,#2E3A2E);transition:background-color .15s ease,border-color .15s ease,color .15s ease,opacity .15s ease}',
    '.jm-s2 .jm-s2-opt b{font-weight:600;font-size:.9375rem;line-height:1.2}',
    '.jm-s2 .jm-s2-opt small{font-weight:400;font-size:.75rem;line-height:1.2;color:var(--s2-muted,#6B706D);transition:color .15s ease}',
    // Mouse only: on touch screens a hover can stick to the tile that appears
    // under the finger that just pressed the submit button.
    '@media (hover:hover){.jm-s2 .jm-s2-opt:not([disabled]):hover span{border-color:var(--s2-hover,var(--s2-accent,var(--gold,#B8962E)))}}',
    '.jm-s2 .jm-s2-opt:active span{background:var(--s2-tile-active,#F3EEE2)}',
    '.jm-s2 .jm-s2-opt.is-selected span{background:var(--s2-sel-bg,#2C3E2D);border-color:var(--s2-sel-bg,#2C3E2D);color:var(--s2-sel-ink,#F7F4ED)}',
    '.jm-s2 .jm-s2-opt.is-selected small{color:var(--s2-sel-muted,rgba(247,244,237,.8))}',
    '.jm-s2 .jm-s2-opt[disabled]{cursor:default}',
    '.jm-s2 .jm-s2-opt[disabled]:not(.is-selected) span{opacity:.55}',
    '.jm-s2 .jm-s2-opt:focus,.jm-s2 .jm-s2-opt:focus-visible{outline:none}',
    '.jm-s2 .jm-s2-opt:focus-visible span{outline:2px solid var(--s2-focus,#2C3E2D);outline-offset:2px}',
    '.jm-s2 .jm-s2-note{margin:.75rem 0 0;min-height:1.3em;font-family:var(--s2-sans,"Raleway",sans-serif);font-size:.8125rem;line-height:1.3;letter-spacing:0;text-transform:none;color:var(--s2-note,#5F6461)}',
    '@media (min-width:361px){.optin-modal .jm-s2{max-width:30rem}.optin-modal .jm-s2 .jm-s2-kicker{margin-bottom:1rem}.optin-modal .jm-s2 .jm-s2-headline{font-size:var(--s2-modal-headline-size,clamp(1.375rem,5.6vw,1.6875rem));max-width:24rem;margin-bottom:1.5rem}.optin-modal .jm-s2 .jm-s2-panel{padding:1.125rem .625rem 1rem}.optin-modal .jm-s2 .jm-s2-q{font-size:.9375rem;margin-bottom:.875rem}.optin-modal .jm-s2 .jm-s2-opt span{min-height:4rem}.optin-modal .jm-s2 .jm-s2-opt b{font-size:1rem}.optin-modal .jm-s2 .jm-s2-note{margin-top:.875rem;font-size:.875rem}}',
    // A visitor's reduced-motion setting must beat every page theme (this
    // sheet loads first), hence the one !important.
    '@media (prefers-reduced-motion:reduce){.jm-s2 .jm-s2-opt span,.jm-s2 .jm-s2-opt small{transition:none!important}.jm-s2-progress i{animation:none!important;transition:none!important}}',
    '@media (max-width:380px){.jm-s2 .jm-s2-grid{gap:.4rem}.jm-s2 .jm-s2-opt b{font-size:.875rem}.jm-s2 .jm-s2-headline{font-size:1.25rem}}',
    '@media (max-width:345px){.jm-s2 .jm-s2-kicker{margin-bottom:.625rem}.jm-s2 .jm-s2-headline{font-size:1.1875rem;margin-bottom:1rem}.jm-s2 .jm-s2-note{margin-top:.625rem}.jm-s2 .jm-s2-q{font-size:.8125rem}.jm-s2 .jm-s2-opt b{font-size:.8125rem}.jm-s2 .jm-s2-opt span{padding-left:.125rem;padding-right:.125rem}.jm-s2.is-standalone{padding-left:1.125rem;padding-right:1.125rem}}'
  ].join('\n');

  var REVENUE_OPTIONS = [
    { value: 'under-1k', label: 'Under $1K' },
    { value: '1k-10k', label: '$1K–$10K' },
    { value: '10k-plus', label: '$10K+' }
  ];
  var META_PIXEL_ID = '441869284373614';
  var QUALIFIED_ANSWERS = ['1k-10k', '10k-plus']; // answers that also fire the Meta "Qualified Lead"

  function optinConfirmed(r) {
    return !!(r && r.success === true && (r.tagged === true || r.queued === true));
  }

  function createRevenueStep(opts, form) {
    opts = (opts && typeof opts === 'object') ? opts : {};
    var HEADLINE = opts.headline || 'One last question before you go';
    var NOTE_IDLE = opts.idle || 'Tap one to continue.';
    var NOTE_GOING = opts.going || 'One moment…';
    function pick(sel, fallback) {
      if (!sel) return fallback;
      if (typeof sel !== 'string') return sel;
      return form.closest(sel) || document.querySelector(sel) || fallback;
    }
    var standalone = !!opts.standalone;
    var container = standalone ? form.parentElement : pick(opts.container, form.parentElement);
    if (!container) return null;

    if (!document.getElementById('jm-s2-css')) {
      var st = document.createElement('style');
      st.id = 'jm-s2-css';
      st.textContent = S2_CSS;
      // First in <head>: the page's own stylesheet wins any tie, so each page
      // can restyle the card to match itself.
      document.head.insertBefore(st, document.head.firstChild);
    }

    // Build the card. Everything is text/escaped; no page HTML is reused.
    var el = document.createElement('div');
    el.className = 'jm-s2' + (standalone ? ' is-standalone' : '');
    el.hidden = true;
    var bar = document.createElement('div');
    bar.className = 'jm-s2-progress';
    bar.setAttribute('aria-hidden', 'true');
    bar.appendChild(document.createElement('i'));
    var kicker = document.createElement('p');
    kicker.className = 'jm-s2-kicker';
    var headline = document.createElement('h3');
    headline.className = 'jm-s2-headline';
    headline.tabIndex = -1;
    headline.textContent = HEADLINE;
    var panel = document.createElement('div');
    panel.className = 'jm-s2-panel';
    var qid = 'jm-s2-q-' + Math.random().toString(36).slice(2, 8);
    var q = document.createElement('span');
    q.className = 'jm-s2-q';
    q.id = qid;
    q.textContent = 'Where’s your business at right now?';
    var grid = document.createElement('div');
    grid.className = 'jm-s2-grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-labelledby', qid);
    var buttons = REVENUE_OPTIONS.map(function (o) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'jm-s2-opt';
      b.setAttribute('data-value', o.value);
      b.setAttribute('aria-pressed', 'false');
      var s = document.createElement('span');
      var bb = document.createElement('b'); bb.textContent = o.label;
      var sm = document.createElement('small'); sm.textContent = 'per month';
      s.appendChild(bb); s.appendChild(sm); b.appendChild(s);
      grid.appendChild(b);
      return b;
    });
    var note = document.createElement('p');
    note.className = 'jm-s2-note';
    note.setAttribute('aria-live', 'polite');
    panel.appendChild(q); panel.appendChild(grid);
    el.appendChild(kicker); el.appendChild(headline); el.appendChild(panel); el.appendChild(note);

    var progressHost = standalone ? el : pick(opts.progressHost, container);
    if (standalone) el.appendChild(bar);
    form.parentNode.insertBefore(el, form.nextSibling);
    if (!standalone && el.parentNode !== container) container.appendChild(el);

    // What step 1 shows and step 2 hides: the form alone when standalone,
    // otherwise everything in the card except the question and a close button.
    var hidden = [];
    function hideStep1() {
      hidden = [];
      var targets = standalone ? [form] : Array.prototype.slice.call(container.children);
      targets.forEach(function (c) {
        if (c === el || c.classList.contains('optin-modal-close') || c.classList.contains('jm-s2-progress')) return;
        if (c.classList.contains('jm-s2-off')) return;
        c.classList.add('jm-s2-off');
        hidden.push(c);
      });
    }
    function showStep1() { hidden.forEach(function (c) { c.classList.remove('jm-s2-off'); }); hidden = []; }

    // Flag a kicker that wrapped (long name) so a page can drop decoration
    // that only works on one line, e.g. flanking rules. Re-checked on resize.
    function flagWrap() {
      kicker.classList.remove('is-wrapped');
      try { var rg = document.createRange(); rg.selectNodeContents(kicker); kicker.classList.toggle('is-wrapped', rg.getClientRects().length > 1); } catch (e) {}
    }
    window.addEventListener('resize', function () { if (state && !el.hidden) flagWrap(); });

    var inModal = !!(container.closest && container.closest('.optin-modal'));
    var state = null;      // { email, fname, answer, done, confirmed, pass, redirectUrl, leaving, armAt, late, skipped }
    var keptAnswer = null; // survives a failed attempt so a retry goes straight through
    var leadFired = false;
    var leadAt = 0;
    var lockedHeight = '';
    var hostWasStatic = false;

    // Manual advanced matching: hand the pixel the opt-in's email (also as
    // external_id) and first name before the Lead, so Lead and Qualified Lead
    // match even when automatic matching misses the swapped-out form. The
    // pixel hashes them; the Stape gateway forwards the hashes.
    var userDataSet = false;
    function setUserData() {
      if (userDataSet || !state || typeof window.fbq !== 'function') return;
      var em = String(state.email || '').trim().toLowerCase();
      if (!em) return;
      var ud = { em: em, external_id: em };
      if (state.fname) ud.fn = state.fname.toLowerCase();
      try { window.fbq('init', META_PIXEL_ID, ud); userDataSet = true; } catch (e) {}
    }
    var qualifiedFired = false;
    function fireQualifiedLead(answer) {
      if (qualifiedFired || QUALIFIED_ANSWERS.indexOf(answer) < 0) return false;
      if (typeof window.fbq !== 'function') return false;
      var page = window.location.pathname.replace(/^\/|\/$/g, '') || 'home';
      try { window.fbq('trackCustom', 'Qualified Lead', { content_name: page, optin_revenue: answer }); qualifiedFired = true; leadAt = Date.now(); } catch (e) {}
      return qualifiedFired;
    }
    function fireLead() {
      if (leadFired) return true;
      if (typeof window.fbq !== 'function') return false;
      setUserData();
      try { window.fbq('track', 'Lead'); leadFired = true; leadAt = Date.now(); } catch (e) {}
      return leadFired;
    }
    function pixelSettled() {
      return new Promise(function (resolve) {
        var t0 = Date.now();
        (function poll() {
          var live = window.fbq && typeof window.fbq.callMethod === 'function';
          if ((live && Date.now() - leadAt >= 300) || Date.now() - t0 >= 1500) { resolve(); return; }
          setTimeout(poll, 100);
        })();
      });
    }
    function withParams(url, add) {
      try {
        var u = new URL(url, window.location.href);
        Object.keys(add).forEach(function (k) { u.searchParams.set(k, add[k]); });
        return u.origin === window.location.origin ? u.pathname + u.search + u.hash : u.toString();
      } catch (e) {
        return url + (url.indexOf('?') >= 0 ? '&' : '?') + Object.keys(add).map(function (k) { return k + '=' + encodeURIComponent(add[k]); }).join('&');
      }
    }
    function withQualifiedFalse(url) { return withParams(url, { qualified: 'false' }); }
    function setButtons(disabled) { buttons.forEach(function (b) { b.disabled = disabled; }); }
    function markSelected(value) {
      buttons.forEach(function (b) {
        var on = b.getAttribute('data-value') === value;
        b.classList.toggle('is-selected', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    function saveAnswer() {
      return fetch('/.netlify/functions/submit-optin-answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: state.email, optin_revenue: state.answer, answer_pass: state.pass }),
        keepalive: true
      });
    }

    async function leave() {
      if (!state || state.leaving || !state.done) return;
      if (!state.answer && !state.skipped) return; // the question is on screen: always wait for their tap
      state.leaving = true;
      // The save answered after the form's 8s cap: give its reply a little
      // longer so this visitor still gets their Lead and answer saved.
      if (state.late) await Promise.race([state.late, new Promise(function (r) { setTimeout(r, 3000); })]);
      var url = state.redirectUrl;
      var waits = [];
      if (state.answer && state.pass) {
        // keepalive lets the save finish after we navigate; cap the wait.
        waits.push(Promise.race([saveAnswer(), new Promise(function (r) { setTimeout(r, 1500); })]).catch(function (e) { console.error('Answer save error:', e); }));
      }
      if (state.confirmed) {
        if (fireLead()) { fireQualifiedLead(state.answer); waits.push(pixelSettled()); url = withQualifiedFalse(url); }
      } else {
        url = withQualifiedFalse(url); // the save wasn't confirmed: never count a Lead
      }
      // The answer rides along so a call qualifier on the destination page
      // doesn't ask the same question again (qualify/embed.js forwards it).
      if (state.answer) url = withParams(url, { rev: state.answer });
      await Promise.all(waits);
      window.location.href = url;
    }

    function choose(value) {
      keptAnswer = value;
      state.answer = value;
      markSelected(value);
      setButtons(true);
      note.textContent = NOTE_GOING;
      leave();
    }

    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!state || state.answer || state.skipped) return;
        // The middle tile can sit where the submit button was: ignore stray
        // repeat taps that land on it as the card swaps. Each early tap
        // pushes the window out, so only a deliberate tap counts.
        if (Date.now() < state.armAt) { state.armAt = Date.now() + 700; return; }
        choose(btn.getAttribute('data-value'));
      });
    });

    // Closing the pop-up while the question is up means "skip it": the opt-in
    // is already saved, so carry on to the page's usual destination.
    function skip() {
      if (!state || state.answer || state.skipped || state.leaving) return;
      state.skipped = true;
      setButtons(true);
      note.textContent = NOTE_GOING;
      leave();
    }
    if (inModal) {
      var modal = container.closest('.optin-modal');
      var modalOpen = function () { return modal.classList.contains('is-open'); };
      document.addEventListener('click', function (e) {
        if (!state || el.hidden || !modalOpen()) return;
        var t = e.target;
        var closeBtn = t && t.closest ? t.closest('.optin-modal-close') : null;
        if ((closeBtn && modal.contains(closeBtn)) || t === modal) {
          e.preventDefault(); e.stopImmediatePropagation(); skip();
        }
      }, true);
      document.addEventListener('keydown', function (e) {
        if (!state || el.hidden || e.key !== 'Escape' || !modalOpen()) return;
        e.preventDefault(); e.stopImmediatePropagation(); skip();
      }, true);
    }

    return {
      engaged: function () { return !!state; },
      show: function (email, firstName) {
        // First name for "Almost there, X": a long hyphenated name keeps its
        // first part; anything still over 20 characters falls back to no name.
        var fname = String(firstName || '').trim().split(/\s+/)[0] || '';
        if (fname.length > 20) fname = fname.split('-')[0];
        if (fname.length > 20) fname = '';
        state = { email: email, fname: fname, answer: keptAnswer, done: false, confirmed: false, pass: null, redirectUrl: null, leaving: false, armAt: Date.now() + 700, late: null, skipped: false };
        if (!standalone) {
          lockedHeight = container.style.minHeight;
          container.style.minHeight = container.getBoundingClientRect().height + 'px'; // same-size card (unrounded)
          container.classList.add('jm-s2-swap');
        }
        hostWasStatic = progressHost !== el && getComputedStyle(progressHost).position === 'static';
        if (hostWasStatic) progressHost.classList.add('jm-s2-host');
        if (progressHost !== el) {
          var r = getComputedStyle(progressHost).borderTopLeftRadius || '0px';
          bar.style.setProperty('--s2-host-radius', r + ' ' + r + ' 0 0'); // a page can override with --s2-bar-radius
          // First child: anything positioned later in the card (a close
          // button that hangs over the edge) paints on top of the bar.
          progressHost.insertBefore(bar, progressHost.firstChild);
        }
        var h1 = form.getBoundingClientRect().height;
        // Standalone: same width as the form it replaces (measured before hiding it).
        if (standalone) el.style.maxWidth = Math.round(form.getBoundingClientRect().width) + 'px';
        hideStep1();
        kicker.textContent = 'Almost there' + (state.fname ? ', ' + state.fname : '');
        markSelected(keptAnswer);
        setButtons(!!keptAnswer);
        note.textContent = keptAnswer ? NOTE_GOING : NOTE_IDLE;
        el.hidden = false;
        if (standalone) el.style.minHeight = h1 + 'px';
        flagWrap();
        // The pop-up was closed while Turnstile / the email check ran: nobody
        // will see the question, so carry on to the destination once saved.
        if (inModal && !container.closest('.optin-modal').classList.contains('is-open')) {
          state.skipped = true;
          setButtons(true);
          note.textContent = NOTE_GOING;
        }
        try { headline.focus({ preventScroll: true }); } catch (e) {}
        setTimeout(function () {
          var target = standalone ? el : container;
          var box = target.getBoundingClientRect();
          if (box.top < 0 || box.bottom > window.innerHeight) {
            // A card taller than the screen lines up its top (bar + close
            // button visible) instead of being centred off both edges.
            var tall = box.height > window.innerHeight;
            try { target.scrollIntoView({ block: tall ? 'start' : 'center', behavior: 'instant' }); } // 'instant' throws on older Safari
            catch (e) { target.scrollIntoView(tall); }
          }
        }, 30);
      },
      reset: function () {
        state = null;
        el.hidden = true;
        el.style.minHeight = '';
        el.style.maxWidth = '';
        if (bar.parentNode && bar.parentNode !== el) bar.parentNode.removeChild(bar);
        if (hostWasStatic) progressHost.classList.remove('jm-s2-host');
        if (!standalone) {
          container.classList.remove('jm-s2-swap');
          container.style.minHeight = lockedHeight;
        }
        showStep1();
        var emailInput = form.querySelector('input[name="E-mail"]');
        if (emailInput) { try { emailInput.focus(); } catch (e) {} }
      },
      optedIn: function (ctx) {
        // A page whose own redirect already excludes this lead (qualified=false,
        // e.g. an unqualified answer it asked itself) never gets a page Lead.
        var pageExcluded = /[?&]qualified=false(?:[&#]|$)/.test(ctx.redirectUrl || '');
        var confirmed = optinConfirmed(ctx.response) && !pageExcluded;
        if (!state) { // no question on screen (shouldn't happen): just go
          var url = ctx.redirectUrl;
          if (confirmed && fireLead()) { pixelSettled().then(function () { window.location.href = withQualifiedFalse(url); }); }
          else if (confirmed) window.location.href = url;
          else window.location.href = withQualifiedFalse(url);
          return;
        }
        state.done = true;
        state.confirmed = confirmed;
        // The pass only lets us save the answer; the Lead stays gated on a
        // confirmed save (an un-retaggable returning contact gets a pass).
        state.pass = (ctx.response && ctx.response.success === true && ctx.response.answer_pass) || null;
        state.redirectUrl = ctx.redirectUrl;
        if (confirmed) fireLead();
        if (!ctx.response && ctx.late) {
          var s = state;
          s.late = ctx.late.then(function (r) {
            s.late = null;
            if (r && r.success === true && r.answer_pass && !s.pass) s.pass = r.answer_pass;
            if (optinConfirmed(r) && !s.confirmed && !pageExcluded) { s.confirmed = true; fireLead(); }
          });
        }
        leave();
      }
    };
  }

  /* ── Submit pipeline ──────────────────────────────────────────────────── */
  function init(config) {
    var rqStep = null; // the shared revenue question (on by default; see rqOn below)
    // Hands off to the revenue question or the page's onSuccess (two-step
    // forms), or redirects.
    function finish(ctx, response, late) {
      var url = config.redirect(ctx);
      if (rqStep) {
        rqStep.optedIn({ response: response || null, redirectUrl: url, late: late || null, email: ctx.email });
      } else if (config.onSuccess) {
        // late: when the 8s cap won, the still-running save's eventual JSON
        // (or null), so a two-step page that's still on screen can use it.
        config.onSuccess({ firstName: ctx.firstName, email: ctx.email, form: ctx.form, response: response || null, redirectUrl: url, late: late || null });
      } else {
        window.location.href = url;
      }
    }

    function start() {
      var form = document.querySelector(config.form || '.email-form');
      if (!form) return;
      var submitBtn = form.querySelector('.form-btn');
      var originalText = submitBtn ? submitBtn.textContent.trim() : '';
      var submitting = false;

      // On by default for every opt-in; a page opts out with revenueQuestion:false
      // (or by handling the flow itself with onSuccess).
      var rqOn = config.revenueQuestion !== false && !(config.onSuccess && !config.revenueQuestion);
      if (rqOn) {
        try { rqStep = createRevenueStep(config.revenueQuestion, form); } catch (e) { console.error('Revenue question setup error:', e); rqStep = null; }
        if (rqStep) {
          // Warm the functions on first engagement so cold starts don't land
          // on the visitor's wait (OPTIONS returns before doing any work).
          var warmed = false;
          form.addEventListener('focusin', function () {
            if (warmed) return;
            warmed = true;
            ['verify-email', 'submit-contact', 'submit-optin-answer'].forEach(function (fn) {
              try { fetch('/.netlify/functions/' + fn, { method: 'OPTIONS', keepalive: true }).catch(function () {}); } catch (e) {}
            });
          });
          // Back from the destination restores this page from the bfcache with
          // the question frozen mid-flow; reload so it starts fresh.
          window.addEventListener('pageshow', function (e) { if (e.persisted && rqStep && rqStep.engaged()) window.location.reload(); });
        }
      }

      function setBtn(text) { if (submitBtn) submitBtn.textContent = text; }
      var started = false;
      // A failure after onSubmitStart: put the form back first, then explain,
      // so the message never sits over a swapped-out card. Pages without the
      // hook keep the original alert-then-restore order.
      function fail(msg) {
        if (started && (config.onSubmitFail || rqStep)) {
          restore();
          setTimeout(function () { alert(msg); }, 60);
        } else {
          alert(msg);
          restore();
        }
      }
      function restore() {
        submitting = false;
        setBtn(originalText);
        if (started) {
          started = false;
          if (rqStep) { try { rqStep.reset(); } catch (e) {} }
          if (config.onSubmitFail) { try { config.onSubmitFail(); } catch (e) {} }
        }
      }

      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (submitting) return;

        // Pages vary between name="First Name" and name="First name".
        var firstName = (form.querySelector('input[name="First Name"], input[name="First name"]') || { value: '' }).value.trim();
        var emailInput = form.querySelector('input[name="E-mail"]');
        var email = emailInput ? emailInput.value.trim() : '';

        if (!firstName) { alert('Please enter your first name.'); return; }
        if (!email) { alert('Please enter your email address.'); return; }
        if (emailInput && !emailInput.checkValidity()) { alert('Please enter a valid email address.'); return; }

        var phone = '';
        if (config.phone) {
          var ccField = form.querySelector('select[name="Country Code"]');
          var countryCode = ccField ? ccField.value.replace(/\D/g, '') : '1';
          var phoneRaw = (form.querySelector('input[name="Phone Number"]') || { value: '' }).value.trim();
          if (!countryCode) { alert('Please select your country code.'); return; }
          if (phoneRaw.replace(/\D/g, '').length < 6) { alert('Please enter a valid phone number.'); return; }
          phone = buildE164(countryCode, phoneRaw);
        }

        if (config.validate) {
          var err = config.validate(form);
          if (err) { alert(err); return; }
        }

        submitting = true;
        if (config.onSubmitStart || rqStep) {
          started = true;
          // Before the button label changes: a wrapped label shrinking to one
          // line would make the same-size card lock short.
          if (rqStep) { try { rqStep.show(email, firstName); } catch (e) { console.error('Revenue question error:', e); } }
          if (config.onSubmitStart) { try { config.onSubmitStart({ firstName: firstName, email: email, form: form }); } catch (e) {} }
        }
        setBtn('Validating…');

        // ZeroBounce email validation — fails open on timeout/outage so a
        // hiccup there can never block a real lead.
        var emailValid = true;
        var zbMsg = '';
        var controller = new AbortController();
        var zbTimeout = setTimeout(function () { controller.abort(); }, 4000);
        try {
          var zbRes = await fetch('/.netlify/functions/verify-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email }),
            signal: controller.signal
          });
          var zb = await zbRes.json();
          if (!zb.valid) {
            zbMsg = zb.reason || 'Please enter a real, non-temporary email address.';
            emailValid = false;
          }
        } catch (err) {
          console.error('ZeroBounce error or timeout:', err);
        } finally {
          clearTimeout(zbTimeout);
        }
        if (!emailValid) { fail(zbMsg); return; }

        setBtn('Submitting…');
        try {
          var honeypot = (form.querySelector('input[name="website"]') || {}).value || '';
          var payload = {
            email: email,
            first_name: firstName,
            tag_id: config.kitTagId
          };
          if (phone) payload.phone = phone;
          if (config.extraPayload) {
            var extra = config.extraPayload(form) || {};
            for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k]; }
          }
          payload.turnstile_token = window.getTurnstileToken();
          payload.website = honeypot;

          // Await the Kit submit (bounded) in every case:
          //  - fetch keepalive alone is unsupported in Firefox < 133, where an
          //    immediate redirect cancels the in-flight POST (silent lead loss)
          //  - a definite server rejection (4xx: expired token, bot guard)
          //    means the lead was NOT captured — faking success by redirecting
          //    to the thank-you page would strand a real visitor.
          // Network errors / timeouts / 5xx still fail open to the redirect:
          // never block a lead on our own infrastructure hiccups.
          var scRes = null;
          var scData = null;
          // fastRedirectMs: pages that don't need the Kit response (no Roezan
          // pass, no attribution readback) can stop waiting after this many ms.
          // By then the request has long been sent, so the function completes
          // server-side regardless; only the 4xx retry prompt is forfeited when
          // the server is slower than this, and rejections normally answer in
          // well under a second because they short-circuit before any Kit call.
          // (Off with the revenue question: it needs the response's answer_pass.)
          var fastMs = (!rqStep && typeof config.fastRedirectMs === 'number' && config.fastRedirectMs > 0) ? config.fastRedirectMs : 0;
          var fastRedirect = false;
          var submitFetch = null;
          try {
            submitFetch = fetch('/.netlify/functions/submit-contact', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
              keepalive: true
            });
            var racers = [
              submitFetch,
              new Promise(function (resolve, reject) { setTimeout(function () { reject(new Error('submit-contact timeout')); }, 8000); })
            ];
            if (fastMs) racers.push(new Promise(function (resolve) { setTimeout(function () { resolve('fast'); }, fastMs); }));
            var raced = await Promise.race(racers);
            if (raced === 'fast') {
              fastRedirect = true;
            } else {
              scRes = raced;
              try { scData = await scRes.json(); } catch (e) {}
            }
          } catch (err) {
            console.error('Kit submit error:', err);
          }
          if (fastRedirect) {
            finish({ firstName: firstName, email: email, form: form }, null);
            return;
          }

          if (scRes && scRes.status === 403 && scData && scData.error === 'verification_required') {
            // No token and the server's tokenless lane is closed (its daily
            // cap is full, e.g. during a bot flood). Ask for the challenge.
            try { if (window.turnstile && window.__tsWidgetId != null) window.turnstile.reset(window.__tsWidgetId); } catch (e) {}
            fail("We couldn't verify your browser. Please complete the verification check if one appears, or try again in a few minutes.");
            return;
          }
          if (scRes && scRes.status >= 400 && scRes.status < 500) {
            // Rejected outright (most often an expired Turnstile token after
            // idling on the form). Re-run the invisible widget so the next
            // click carries a fresh token, and let the visitor retry.
            try { if (window.turnstile && window.__tsWidgetId != null) window.turnstile.reset(window.__tsWidgetId); } catch (e) {}
            fail("That didn't go through — please click the button again.");
            return;
          }

          if (config.roezanTagId) {
            // roezan_pass from the Kit response replaces a second Turnstile
            // run (tokens are single-use). Await bounded so Firefox can't
            // cancel it on redirect; a Roezan hiccup never blocks the visitor.
            var roezanPass = (scData && scData.roezan_pass) || '';
            if (roezanPass) {
              try {
                await Promise.race([
                  fetch('/.netlify/functions/submit-roezan-contact', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      email: email,
                      first_name: firstName,
                      phone: phone,
                      tag_id: config.roezanTagId,
                      roezan_pass: roezanPass,
                      website: honeypot
                    }),
                    keepalive: true
                  }),
                  new Promise(function (resolve, reject) { setTimeout(function () { reject(new Error('roezan timeout')); }, 2500); })
                ]);
              } catch (err) {
                console.error('Roezan submit error:', err);
              }
            }
          }

          var late = (!scRes && submitFetch && (config.onSuccess || rqStep))
            ? submitFetch.then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
            : null;
          if (late && config.roezanTagId) {
            // The visitor is still on the question, so a late Kit reply can
            // still carry the Roezan pass: sync the phone then.
            late = late.then(function (data) {
              var lp = data && data.roezan_pass;
              if (lp) {
                try {
                  fetch('/.netlify/functions/submit-roezan-contact', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: email, first_name: firstName, phone: phone, tag_id: config.roezanTagId, roezan_pass: lp, website: honeypot }),
                    keepalive: true
                  }).catch(function (err) { console.error('Roezan submit error:', err); });
                } catch (err) {}
              }
              return data;
            });
          }
          finish({ firstName: firstName, email: email, form: form }, scData, late);
        } catch (err) {
          console.error('Form submission error:', err);
          fail('Something went wrong. Please try again.');
        }
      });
    }

    if (document.readyState !== 'loading') start(); else document.addEventListener('DOMContentLoaded', start);
  }

  window.JMOptin = { init: init, buildE164: buildE164, __test: { optinConfirmed: optinConfirmed } };
})();
