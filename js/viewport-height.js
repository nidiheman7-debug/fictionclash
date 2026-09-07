// Keep a live "actually visible height" CSS var, since the keyboard now
  // overlays the page (interactive-widget=overlays-content) instead of
  // resizing it — so 100dvh no longer shrinks when the keyboard opens, but
  // visualViewport.height still does. Bottom sheets (comments, leaderboard,
  // etc.) read --vvh to cap their own height to the space actually visible
  // above the keyboard, instead of relying on the browser to scroll a
  // position:absolute sheet into view, which is what was dragging the
  // whole page around before.
  function setVisibleViewportHeight(){
    const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--vvh', h + 'px');
  }
  setVisibleViewportHeight();

  // Nothing in this app ever intends html/body to scroll or pan — .phone-scroll
  // is the only real scroll container (see the overflow:hidden rules on
  // html/body in styles.css). But with interactive-widget=overlays-content,
  // some mobile browsers still run their own native "scroll the focused
  // input into view" behavior, which can shift the layout viewport's scroll
  // position and/or the visual viewport's offsetTop without anything in our
  // own code asking for it. Once that happens, the top of the page slides up
  // out of view and stays there — nothing was resetting it back to (0,0).
  // This snaps it back on any scroll or visualViewport change, so a stray
  // native scroll never has anywhere to "stick".
  function snapScrollToOrigin(){
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }
    if (document.documentElement.scrollTop !== 0) document.documentElement.scrollTop = 0;
    if (document.body.scrollTop !== 0) document.body.scrollTop = 0;
  }
  window.addEventListener('scroll', snapScrollToOrigin, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('scroll', snapScrollToOrigin);
  }
  // Exposed so docked-composer.js can also call this proactively right at
  // focus time and right after undocking, instead of only reacting once a
  // stray scroll has already happened.
  window.snapScrollToOrigin = snapScrollToOrigin;

  // visualViewport fires a resize event for more than just the keyboard —
  // mobile Chrome/Safari also fire it as the address bar hides/shows
  // during ordinary scrolling. Writing a custom property straight from
  // that handler meant every scroll tick forced a style recalc on every
  // .modal-sheet-tall (they read --vvh for max-height), which is real,
  // avoidable jank on a page with any tall sheet open. Coalescing bursts
  // into one write per animation frame keeps the value just as current
  // for the keyboard case it actually exists for, without the per-tick
  // cost during plain scrolling.
  let vvhFrame = null;
  function queueVisibleViewportHeight(){
    if (vvhFrame != null) return;
    vvhFrame = requestAnimationFrame(() => {
      vvhFrame = null;
      setVisibleViewportHeight();
    });
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', queueVisibleViewportHeight);
  } else {
    window.addEventListener('resize', queueVisibleViewportHeight);
  }
