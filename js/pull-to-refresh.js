// Pull-to-refresh for .phone-scroll.
//
// overscroll-behavior-y:contain on .phone-scroll (see styles.css) already
// blocks the browser's own native pull-to-refresh from firing on this
// element, which is why one has to be built by hand here — plain
// touchstart/touchmove/touchend on the scroll container, no library.
//
// Gesture only starts if: the scroll container is at scrollTop 0, the
// touch didn't start inside an open modal sheet or the reels overlay, and
// the resulting drag is more vertical than horizontal (so it doesn't fight
// horizontally-swipeable things like the quick-actions ring or vote cards).
// Past the release threshold, this does a full location.reload() — the
// simplest way to guarantee every section (matchups, movies hub, news,
// team, account) actually gets fresh data, since a plain in-place re-fetch
// would need per-tab wiring this file has no visibility into.
(function () {
  var scroller = document.querySelector('.phone-scroll');
  var indicator = document.getElementById('ptrIndicator');
  if (!scroller || !indicator) return;

  var THRESHOLD = 70; // px of (dampened) pull needed to trigger a reload
  var MAX_PULL = 100; // indicator height caps out here regardless of drag distance

  var startX = 0, startY = 0, tracking = false, dragging = false, released = false;

  function eligibleStart(target) {
    if (document.querySelector('.modal-overlay.show')) return false;
    var reels = document.getElementById('reelsOverlay');
    if (reels && reels.contains(target)) return false;
    return scroller.scrollTop <= 0;
  }

  function setPull(px) {
    var progress = Math.min(px / THRESHOLD, 1);
    indicator.style.setProperty('--ptr-pull', String(progress));
    indicator.style.height = Math.min(px, MAX_PULL) + 'px';
  }

  function reset() {
    indicator.classList.remove('pulling', 'loading');
    indicator.style.removeProperty('height');
    indicator.style.setProperty('--ptr-pull', '0');
    tracking = false;
    dragging = false;
    released = false;
  }

  scroller.addEventListener('touchstart', function (e) {
    if (!e.touches || e.touches.length !== 1) return;
    if (!eligibleStart(e.target)) { tracking = false; return; }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
    dragging = false;
    released = false;
  }, { passive: true });

  scroller.addEventListener('touchmove', function (e) {
    if (!tracking || released || !e.touches || e.touches.length !== 1) return;
    var dx = e.touches[0].clientX - startX;
    var dy = e.touches[0].clientY - startY;

    if (!dragging) {
      // Decide once, on first meaningful movement, whether this is "our"
      // gesture — a mostly-vertical downward pull — or something else
      // (horizontal swipe, or scrolling that's already moved off scrollTop 0).
      if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
      if (Math.abs(dy) <= Math.abs(dx) || dy <= 0 || scroller.scrollTop > 0) {
        tracking = false;
        return;
      }
      dragging = true;
      indicator.classList.add('pulling');
    }

    if (dy <= 0) { setPull(0); return; }
    // Resistance curve so the indicator fights back harder the further
    // it's pulled, instead of tracking the finger 1:1.
    var damped = Math.sqrt(dy) * 6;
    setPull(damped);
    // Only preventDefault once we're sure this is a pull-to-refresh drag
    // and not a normal scroll — otherwise this would block scrolling
    // everywhere else on the page.
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  scroller.addEventListener('touchend', function () {
    if (!dragging) { reset(); return; }
    var progress = parseFloat(indicator.style.getPropertyValue('--ptr-pull')) || 0;
    released = true;
    indicator.classList.remove('pulling');
    if (progress >= 1) {
      indicator.classList.add('loading');
      indicator.style.height = '44px';
      indicator.style.setProperty('--ptr-pull', '1');
      setTimeout(function () { location.reload(); }, 300);
    } else {
      reset();
    }
  }, { passive: true });

  scroller.addEventListener('touchcancel', function () {
    if (!indicator.classList.contains('loading')) reset();
  }, { passive: true });
})();
