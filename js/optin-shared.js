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
        'before-interactive-callback': reserveTurnstile
      });
      window.addEventListener('resize', function () {
        var b = document.getElementById('cf-turnstile-box');
        if (b && b.getAttribute('data-reserved') === '1') reserveTurnstile();
      });
    }
  };

  /* ── Submit gate ────────────────────────────────────────────────────────
   * Capture phase + stopImmediatePropagation runs BEFORE the page's submit
   * handler, so nothing is sent until the visitor is verified. The widget is
   * invisible (interaction-only), so a missing token is almost always a
   * token that hasn't minted yet or has expired — not something the visitor
   * can act on. So: let field errors surface first (checkValidity), and on a
   * missing token re-run the challenge and retry the submit automatically.
   * Only ask the visitor to act if Cloudflare actually shows an interactive
   * challenge (data-reserved=1 means it painted). */
  (function () {
    var retrying = false;
    function gate(e) {
      var form = e.currentTarget;
      var tok = window.getTurnstileToken();
      if (tok) return;
      if (form && typeof form.checkValidity === 'function' && !form.checkValidity()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (retrying) return;
      retrying = true;
      try { if (window.turnstile && window.__tsWidgetId != null) window.turnstile.execute(window.__tsWidgetId); } catch (_) {}
      var waited = 0;
      var poll = setInterval(function () {
        waited += 250;
        if (window.getTurnstileToken()) {
          clearInterval(poll); retrying = false;
          if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
          else if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          return;
        }
        var b = document.getElementById('cf-turnstile-box');
        if (b && b.getAttribute('data-reserved') === '1') {
          clearInterval(poll); retrying = false;
          alert('Please complete the verification below, then submit again.');
          return;
        }
        if (waited >= 6000) {
          clearInterval(poll); retrying = false;
          alert('Verification is taking a moment — please try submitting again.');
        }
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

  /* ── Submit pipeline ──────────────────────────────────────────────────── */
  function init(config) {
    function start() {
      var form = document.querySelector(config.form || '.email-form');
      if (!form) return;
      var submitBtn = form.querySelector('.form-btn');
      var originalText = submitBtn ? submitBtn.textContent.trim() : '';
      var submitting = false;

      function setBtn(text) { if (submitBtn) submitBtn.textContent = text; }
      function restore() { submitting = false; setBtn(originalText); }

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
        setBtn('Validating…');

        // ZeroBounce email validation — fails open on timeout/outage so a
        // hiccup there can never block a real lead.
        var emailValid = true;
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
            alert(zb.reason || 'Please enter a real, non-temporary email address.');
            emailValid = false;
          }
        } catch (err) {
          console.error('ZeroBounce error or timeout:', err);
        } finally {
          clearTimeout(zbTimeout);
        }
        if (!emailValid) { restore(); return; }

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

          if (config.roezanTagId) {
            // Kit first (awaited, bounded): its response carries a short-lived
            // roezan_pass — Turnstile tokens are single-use, so the SMS call
            // reuses this server-minted pass instead of re-verifying.
            var roezanPass = '';
            try {
              var scRes = await Promise.race([
                fetch('/.netlify/functions/submit-contact', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload),
                  keepalive: true
                }),
                new Promise(function (resolve, reject) { setTimeout(function () { reject(new Error('submit-contact timeout')); }, 8000); })
              ]);
              var scData = await scRes.json();
              roezanPass = (scData && scData.roezan_pass) || '';
            } catch (err) {
              console.error('Kit submit error:', err);
            }
            if (roezanPass) {
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
              }).catch(function (err) { console.error('Roezan submit error:', err); });
            }
          } else {
            // Email-only pages: fire-and-forget; keepalive survives the redirect.
            fetch('/.netlify/functions/submit-contact', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
              keepalive: true
            }).catch(function (err) { console.error('Kit submit error:', err); });
          }

          window.location.href = config.redirect({ firstName: firstName, email: email, form: form });
        } catch (err) {
          console.error('Form submission error:', err);
          alert('Something went wrong. Please try again.');
          restore();
        }
      });
    }

    if (document.readyState !== 'loading') start(); else document.addEventListener('DOMContentLoaded', start);
  }

  window.JMOptin = { init: init, buildE164: buildE164 };
})();
