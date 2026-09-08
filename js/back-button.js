// Makes the Android hardware/gesture back button close whatever modal is
// currently open, instead of exiting the app straight to the home screen —
// probably the single biggest "this is just a website" tell in a TWA.
// Every .modal-overlay already closes itself via its own outside-tap
// handler (checking event.target === overlay — see app.js), so rather than
// reimplementing each modal's own close/cleanup logic here, a fabricated
// click directly on the overlay element triggers that exact same code path.
//
// Nested modals (e.g. tapping a comment's avatar opens the profile card on
// top of the still-open comments sheet) are handled with a real stack, so
// back always closes the TOPMOST (most recently opened) modal first, then
// the one under it, then finally exits — matching how a native app's back
// stack behaves.
(function(){
  const overlays = Array.from(document.querySelectorAll('.modal-overlay'));
  if (!overlays.length) return;

  const openStack = []; // overlays currently open, oldest first
  let suppressPush = false; // true while consuming a stale history entry left by a non-back close
  let suppressPop = false;  // true while OUR OWN popstate handler is closing a modal

  overlays.forEach(overlay => {
    const observer = new MutationObserver(() => {
      const isShown = overlay.classList.contains('show');
      const idx = openStack.indexOf(overlay);
      if (isShown && idx === -1) {
        openStack.push(overlay);
        // A modal just opened through normal app code — give the back
        // button somewhere to "land" on. The URL itself never changes,
        // this just adds a history entry.
        if (!suppressPush) history.pushState({ modalOverlay: overlay.id || true }, '', location.href);
      } else if (!isShown && idx !== -1) {
        openStack.splice(idx, 1);
        // Closed via its own button or an outside tap rather than the back
        // button — the history entry pushed for it is now stale. Consume
        // it with a silent back step so it doesn't take a second back press
        // (on a now-irrelevant entry) to actually leave the app later.
        if (!suppressPop) { suppressPush = true; history.back(); }
      }
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
  });

  window.addEventListener('popstate', () => {
    suppressPush = false; // any history.back() we triggered above has now landed
    const top = openStack[openStack.length - 1];
    if (!top) return; // nothing open — let back navigate/exit the app as normal
    suppressPop = true;
    top.click(); // event.target === top, so this runs that modal's real close handler
    suppressPop = false;
  });
})();
