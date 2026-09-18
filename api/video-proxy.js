// /api/video-proxy.js
// Streams a clip video from Firebase Storage back through OUR OWN domain,
// so the browser sees it as a same-origin request.
//
// Why this exists: the service worker needs to read a video's actual
// bytes to cache it for offline playback, and reading a cross-origin
// response's body requires the far side (Firebase Storage / Google Cloud
// Storage) to send CORS headers back — which means going into Google
// Cloud Console and configuring that manually. Proxying it through here
// instead sidesteps that entirely: same-origin responses never need
// CORS, so there's nothing to configure on the Storage bucket at all.
//
// This has to be an Edge Function (not a normal Node serverless
// function) specifically because normal Vercel serverless functions cap
// response bodies at 4.5MB — far too small for a video clip. Edge
// Functions stream the response through instead of buffering the whole
// thing in memory, so clip size isn't limited by this proxy.
export const config = { runtime: 'edge' };

export default async function handler(request) {
  const { searchParams } = new URL(request.url);
  const target = searchParams.get('url');

  // Only ever proxy Firebase Storage URLs — never an arbitrary site, or
  // this becomes an open proxy anyone could abuse to fetch/relay
  // whatever they want through your domain.
  if (!target || !target.startsWith('https://firebasestorage.googleapis.com/')) {
    return new Response('Invalid url', { status: 400 });
  }

  let upstream;
  try {
    upstream = await fetch(target);
  } catch (err) {
    return new Response('Upstream fetch failed', { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response('Upstream fetch failed', { status: upstream.status || 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
      // Long-lived cache — clip files are immutable once uploaded (a new
      // upload gets a new Storage path, never overwrites the old one).
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
