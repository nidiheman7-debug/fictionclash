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
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setVisibleViewportHeight);
  } else {
    window.addEventListener('resize', setVisibleViewportHeight);
  }
