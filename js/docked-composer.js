// Facebook-style docked composer: tapping ANY comment field (hero card,
  // a clip card, or the full comments sheet) pins its comment-form to the
  // bottom of the phone, right above the on-screen keyboard, instead of
  // just scrolling it into view where it sat in the page. See the
  // .comment-form.docked rule for why .phone/.modal-overlay being the
  // containing block is what makes a plain `bottom:0` work for every case.
  function isCommentField(el){
    return !!(el && el.matches && el.matches('.comment-form .clip-field'));
  }

  // How tall the on-screen keyboard currently is, in px. With
  // interactive-widget=overlays-content the keyboard overlays the page
  // instead of resizing it, so window.innerHeight stays constant while
  // visualViewport.height shrinks by roughly the keyboard's height — the
  // gap between the two (adjusted for any page scroll via offsetTop) IS
  // the keyboard height. This is viewport math only (no .phone sizing
  // assumptions baked in), which is what actually lines the bar up flush
  // with the keyboard instead of leaving a gap above it.
  function keyboardHeightPx(){
    if (!window.visualViewport) return 0;
    const kh = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;
    // Guard against transient nonsense (NaN, a wildly negative reading
    // mid-animation, or — if some browser's window.innerHeight quietly
    // shrinks too, despite the overlays-content meta tag — a value bigger
    // than the screen itself, which would fling the bar off the top).
    if (!Number.isFinite(kh)) return 0;
    return Math.max(0, Math.min(kh, window.innerHeight * 0.75));
  }

  // Some Android WebViews / Samsung Internet builds fire visualViewport's
  // `resize` event late, or not at all, while the keyboard animates in —
  // leaving keyboardHeightPx() stuck reading a stale (often 0) value even
  // though the keyboard is genuinely up, which pins the composer at
  // literal bottom:0 — i.e. behind the keyboard, invisible. Polling every
  // animation frame reads the *current* geometry directly instead of
  // waiting for a notification that might not come, so the bar self-heals
  // within a frame regardless of whether the event fired. Only runs while
  // a comment field is actually focused (see dockCommentField/undock),
  // so the cost is bounded to the moment someone's actively commenting.
  function watchKeyboard(el, form, onDone){
    let rafId = null;
    let lastKh = -1;
    let peakKh = 0;
    const tick = () => {
      // Self-heal: if focus moved off this field by any path we didn't
      // catch elsewhere, stop and undock rather than polling forever.
      if (document.activeElement !== el) { onDone(); return; }
      const kh = keyboardHeightPx();
      if (kh > peakKh) peakKh = kh;
      // "Closed" is judged relative to the tallest reading we've actually
      // seen this session, not an absolute near-zero px value. An earlier
      // version used a flat `kh <= 3` threshold, which assumes the
      // no-keyboard baseline is exactly 0 — but some browsers/WebViews
      // report a small, persistent nonzero gap even with the keyboard
      // fully closed (browser-chrome collapse, rounding, etc). That
      // constant offset sat just above the flat threshold and never
      // tripped it, which is exactly what left the bar permanently
      // docked mid-screen with body.keyboard-open stuck (hiding the
      // bottom nav) — the bug in the "floating input, huge blank gaps,
      // no bottom nav" screenshot. Requiring a real drop from the peak
      // adapts to whatever that device's baseline actually is.
      if (peakKh > 40 && kh < peakKh * 0.25) { el.blur(); onDone(); return; }
      if (kh !== lastKh) {
        form.style.bottom = kh + 'px';
        lastKh = kh;
      }
      rafId = requestAnimationFrame(tick);
    };
    tick();
    return () => { if (rafId != null) cancelAnimationFrame(rafId); };
  }

  // The browser's native "scroll the focused input into view" doesn't
  // only move window/document (which snapScrollToOrigin in
  // viewport-height.js already handles) — it can just as easily scroll
  // .phone-scroll or an open modal's own internal list, since those are
  // real overflow:auto containers. Left alone, that's exactly what reads
  // as "the page drags up too high and won't come back down": the list
  // scrolls itself near-empty trying to hoist the input above a keyboard
  // whose real height it doesn't know about yet. This snapshots every
  // scrollable container that matters right as a comment field is
  // focused, then forces them back for the next few frames — covering
  // both the initial native jump and the keyboard's own open animation,
  // without touching scroll positions once the user is actually typing.
  function lockScrollPositions(){
    // .phone is included alongside the two real scroll containers because
    // a mobile browser's native "scroll focused input into view" behavior
    // can assign scrollTop on it directly even though it's overflow:hidden
    // and was never meant to scroll — see the matching note in
    // viewport-height.js. Left unguarded here, that's what let the full
    // comments sheet's header (and its back button) get clipped out of
    // view the instant the composer's input was focused.
    const scrollers = [
      document.querySelector('.phone'),
      document.querySelector('.phone-scroll'),
      document.getElementById('commentsModalList')
    ].filter(Boolean);
    if (!scrollers.length) return () => {};
    const snapshot = scrollers.map(el => ({ el, top: el.scrollTop }));
    let frames = 0;
    let rafId = null;
    const restore = () => {
      snapshot.forEach(s => { if (s.el.scrollTop !== s.top) s.el.scrollTop = s.top; });
      frames++;
      // ~20 frames covers the native scroll-into-view jump AND the
      // keyboard's own slide-in animation on slower devices; after that
      // we back off so a user's own deliberate scroll (once they're
      // settled into typing) isn't fought.
      if (frames < 20) rafId = requestAnimationFrame(restore);
    };
    restore();
    return () => { if (rafId != null) cancelAnimationFrame(rafId); };
  }

  function dockCommentField(el){
    const form = el.closest('.comment-form');
    if (!form) return;
    form.classList.add('docked');
    document.body.classList.add('keyboard-open');
    // One immediate call plus one on the next frame catches the native
    // scroll-into-view before it has a chance to leave the page shifted;
    // lockScrollPositions then keeps correcting it for the frames after.
    if (window.snapScrollToOrigin) {
      window.snapScrollToOrigin();
      requestAnimationFrame(window.snapScrollToOrigin);
    }
    const stopScrollLock = lockScrollPositions();
    const stopKeyboardWatch = watchKeyboard(el, form, () => {
      document.body.classList.remove('keyboard-open');
      undockCommentField(form);
    });
    form._undock = () => { stopScrollLock(); stopKeyboardWatch(); };
    // Cosmetic left/width match to .phone's own edges (so the bar doesn't
    // span the full browser window on the desktop preview) — doesn't
    // affect vertical positioning, which is entirely the keyboard watch's
    // job above.
    const phone = document.querySelector('.phone');
    if (phone) {
      const phoneRect = phone.getBoundingClientRect();
      form.style.left = phoneRect.left + 'px';
      form.style.width = phoneRect.width + 'px';
    }
  }

  function undockCommentField(form){
    if (!form) return;
    form.classList.remove('docked');
    form.style.bottom = '';
    form.style.left = '';
    form.style.width = '';
    if (form._undock) { form._undock(); form._undock = null; }
    // Same reasoning as on dock: the keyboard closing can leave the page
    // (or an inner scroller) shifted a beat after we've stopped watching.
    if (window.snapScrollToOrigin) {
      window.snapScrollToOrigin();
      requestAnimationFrame(window.snapScrollToOrigin);
    }
  }

  document.addEventListener('focusin', event => {
    if (!isCommentField(event.target)) return;
    dockCommentField(event.target);
  });
  document.addEventListener('focusout', event => {
    if (!isCommentField(event.target)) return;
    const form = event.target.closest('.comment-form');
    // A tap on the send icon blurs the input a beat before its own click
    // handler runs — the short delay (and re-check) stops the bar from
    // undocking in between, and still undocks once focus genuinely
    // leaves every comment field.
    setTimeout(() => {
      if (!isCommentField(document.activeElement)) {
        document.body.classList.remove('keyboard-open');
        undockCommentField(form);
      }
    }, 50);
  });

  // Belt-and-suspenders: if body.keyboard-open is ever still set with no
  // comment field actually focused (whatever the cause — a missed resize
  // event, a modal closed out from under the docked bar, anything not
  // anticipated above), clear it the next time the tab becomes visible
  // again rather than leaving the whole app's modals distorted until a
  // hard reload.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (document.body.classList.contains('keyboard-open') && !isCommentField(document.activeElement)) {
      document.body.classList.remove('keyboard-open');
      document.querySelectorAll('.comment-form.docked').forEach(undockCommentField);
    }
  });

  // Hard safety net, independent of focus/keyboard events entirely: any
  // modal (comments sheet included) can be closed by a path that never
  // blurs its input first — a custom "back" button just hides the sheet
  // via CSS (removes .show), it doesn't call .blur(). If that happens
  // while a comment field inside it is still focused, every fix above is
  // watching for a focus change or a keyboard-height change that never
  // comes, and the bar is left floating over whatever's behind the now-
  // closed modal — this is the exact "input stuck mid-screen, huge blank
  // gaps, no bottom nav" bug. Watching every .modal-overlay's own `show`
  // class directly sidesteps all of that: the instant one closes, force-
  // blur and force-undock, no matter which code path closed it or what
  // the keyboard-height math currently thinks.
  const modalCloseObserver = new MutationObserver(mutations => {
    for (const { target } of mutations) {
      if (!(target instanceof Element) || target.classList.contains('show')) continue;
      if (isCommentField(document.activeElement) && target.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      target.querySelectorAll('.comment-form.docked').forEach(form => {
        document.body.classList.remove('keyboard-open');
        undockCommentField(form);
      });
    }
  });
  document.querySelectorAll('.modal-overlay').forEach(el => {
    modalCloseObserver.observe(el, { attributes: true, attributeFilter: ['class'] });
  });
