window.OneSignalDeferred = window.OneSignalDeferred || [];
  window.OneSignalDeferred.push(async function(OneSignal) {
    await OneSignal.init({
      appId: "ae58917f-ed36-4d89-8132-70174db86312",
      // Uses the same /sw.js already registered for offline caching —
      // OneSignal's own push-handling code is merged into that file via
      // importScripts(), so this one worker does both jobs.
      serviceWorkerParam: { scope: '/' },
      serviceWorkerPath: '/sw.js'
    });
  });
