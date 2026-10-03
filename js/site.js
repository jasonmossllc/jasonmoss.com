// Shared behaviour for the main site pages (home, podcast, breakthroughs).
// Mobile menu: full-screen overlay opened from the header menu button.
(function () {
  var btn = document.getElementById('menuBtn');
  var menu = document.getElementById('mobileMenu');
  var close = document.getElementById('menuClose');
  if (!btn || !menu) return;

  function setOpen(open) {
    if (open) menu.removeAttribute('hidden'); else menu.setAttribute('hidden', '');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.style.overflow = open ? 'hidden' : '';
    if (open && close) close.focus(); else if (!open) btn.focus();
  }

  btn.addEventListener('click', function () { setOpen(true); });
  if (close) close.addEventListener('click', function () { setOpen(false); });
  menu.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () { setOpen(false); });
  });
  document.addEventListener('keydown', function (e) {
    if (menu.hasAttribute('hidden')) return;
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key !== 'Tab') return;
    // keep keyboard focus inside the open menu
    var f = menu.querySelectorAll('a[href], button');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
})();
