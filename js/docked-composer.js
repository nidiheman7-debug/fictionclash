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
    return Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
  }

  function dockCommentField(el){
    const form = el.closest('.comment-form');
    if (!form) return;
    form.classList.add('docked');
    document.body.classList.add('keyboard-open');
    // Tracks whether we've actually seen the keyboard open during this
    // dock session, so the very first reposition() call below (fired
    // before the keyboard has animated in, when its height briefly reads
    // 0) doesn't get mistaken for "the keyboard just closed" and undock
    // the bar the instant it was docked.
    let sawKeyboard = false;
    const reposition = () => {
      // Self-heal first: if focus has moved off this field by any path
      // we didn't catch (the exact-zero keyboard check below used to be
      // the only guard, and floating-point/offsetTop rounding could mean
      // the keyboard height settles at 1-3px instead of a clean 0 — never
      // tripping it, leaving the bar docked and body.keyboard-open stuck
      // forever). Checking activeElement here too closes that gap: any
      // resize event after focus has genuinely moved is now enough to
      // clean up, regardless of what the keyboard height reads.
      if (document.activeElement !== el) {
        document.body.classList.remove('keyboard-open');
        undockCommentField(form);
        return;
      }
      const phone = document.querySelector('.phone');
      if (phone) {
        const phoneRect = phone.getBoundingClientRect();
        form.style.left = phoneRect.left + 'px';
        form.style.width = phoneRect.width + 'px';
      }
      const kh = keyboardHeightPx();
      if (kh > 20) sawKeyboard = true;
      // Android's back button (and some gesture-nav setups) can dismiss
      // just the on-screen keyboard without ever blurring the input, so
      // the focusout-based cleanup below never runs. Left alone, the bar
      // stayed pinned at the last keyboard height it saw — floating in
      // the middle of the screen instead of sitting at the bottom. If the
      // keyboard we were tracking has genuinely closed, treat it the same
      // as the field losing focus. A small threshold (rather than an
      // exact kh === 0) absorbs the visualViewport rounding noise that
      // let this get stuck in the first place.
      if (sawKeyboard && kh <= 3) {
        document.activeElement === el && el.blur();
        document.body.classList.remove('keyboard-open');
        undockCommentField(form);
        return;
      }
      form.style.bottom = kh + 'px';
    };
    reposition();
    // The keyboard animates in over the next couple hundred ms, firing
    // several visualViewport resize events as it does — react to those
    // instead of a single fixed-delay guess, so the bar lands right above
    // the keyboard regardless of device/animation speed.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', reposition);
      form._undock = () => window.visualViewport.removeEventListener('resize', reposition);
    }
  }

  function undockCommentField(form){
    if (!form) return;
    form.classList.remove('docked');
    form.style.bottom = '';
    form.style.left = '';
    form.style.width = '';
    if (form._undock) { form._undock(); form._undock = null; }
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
