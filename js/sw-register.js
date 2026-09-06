// Register the service worker for offline app-shell caching + installability.
  // Wrapped in a feature check and try/catch so it never breaks the app on
  // browsers/contexts that don't support it.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(err => {
        console.warn('Service worker registration failed:', err);
      });
    });
  }

  // ---------- install button ----------
  // Chrome/Edge/most Android browsers fire beforeinstallprompt but suppress
  // their own mini-infobar unless the site calls preventDefault() and shows
  // its own UI — this is what puts a real button in the header (like
  // Omega Prep's download icon) instead of relying on a buried browser menu.
  // iOS Safari never fires this event at all (no programmatic install there),
  // so the button just stays hidden on iOS — nothing for it to do.
  //
  // Once installed, the button hides for the rest of that session via
  // markInstalled(). What it must NOT do is treat that as permanent gospel:
  // an earlier version also gated future 'beforeinstallprompt' events on a
  // persisted localStorage flag, which meant that after someone installed,
  // then genuinely UNINSTALLED, the button stayed hidden forever — the
  // stale flag out-ranked the browser's own live signal that it was
  // installable again. Fixed by only trusting two things: the live
  // display-mode check (can't go stale, since it reflects how the page is
  // running right now), and the mere fact that 'beforeinstallprompt' fired
  // at all — the browser only fires that when it currently considers the
  // app installable, which is a stronger and fresher signal than anything
  // we could cache ourselves.
  const installBtn = document.getElementById('installBtn');
  let deferredInstallPrompt = null;

  function isRunningInstalled(){
    return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true; // iOS home-screen launch
  }

  function markInstalled(){
    localStorage.setItem('fcInstalled', '1');
    installBtn.hidden = true;
    deferredInstallPrompt = null;
  }

  // Hide immediately if we're literally running as the installed app right
  // now (e.g. opened from the home screen icon) — this is a live check, so
  // unlike a stored flag it can never go stale.
  if (isRunningInstalled()) {
    installBtn.hidden = true;
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    // The browser firing this at all means it currently thinks the app is
    // installable — trust that over any old local flag, and clear the flag
    // since it's now proven wrong (this is exactly what happens right
    // after someone uninstalls).
    localStorage.removeItem('fcInstalled');
    deferredInstallPrompt = event;
    installBtn.hidden = false;
  });

  installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    installBtn.hidden = true;
    deferredInstallPrompt.prompt();
    try {
      await deferredInstallPrompt.userChoice;
    } catch (err) {
      // user dismissed — fine, just clear the stored prompt below
    }
    deferredInstallPrompt = null;
  });

  window.addEventListener('appinstalled', markInstalled);
