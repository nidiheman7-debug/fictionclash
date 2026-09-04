// /api/sitemap.js
// Dynamically generates sitemap.xml from every matchup in Firestore, so
// deep-link matchup URLs (?matchup=<pairKey>) actually get crawled instead
// of only the bare homepage — the static sitemap.xml only ever listed "/".
// Requires the same FIREBASE_SERVICE_ACCOUNT_KEY env var as vote.js/etc.

import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    ),
  });
}

const db = admin.firestore();
const SITE_URL = 'https://fictionclash.vercel.app';

// Mirrors matchupPairKey() in index.html EXACTLY (same lowercase + sort +
// join logic). Any drift here means a sitemap URL that 404s-in-spirit —
// Googlebot follows it, the SPA can't find a matching matchup, and the
// crawl is wasted.
function matchupPairKey(m) {
  const keyA = `${m.a.name.toLowerCase()}|${(m.a.version || '').toLowerCase()}`;
  const keyB = `${m.b.name.toLowerCase()}|${(m.b.version || '').toLowerCase()}`;
  return [keyA, keyB].sort().join('~');
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default async function handler(req, res) {
  try {
    const matchupsSnap = await db.collection('matchups').get();

    const urls = [
      { loc: `${SITE_URL}/`, changefreq: 'daily', priority: '1.0' },
    ];

    matchupsSnap.forEach((doc) => {
      const m = doc.data();
      // Skip malformed docs rather than let one bad doc break the whole
      // file — Google discards the ENTIRE sitemap on invalid XML, so one
      // matchup missing m.a.name would otherwise take every URL down with it.
      if (!m || !m.a || !m.b || !m.a.name || !m.b.name) return;

      const key = matchupPairKey(m);
      const lastmod =
        m.createdAt && typeof m.createdAt.toDate === 'function'
          ? m.createdAt.toDate().toISOString()
          : undefined;

      urls.push({
        loc: `${SITE_URL}/?matchup=${encodeURIComponent(key)}`,
        changefreq: 'weekly',
        priority: '0.8',
        lastmod,
      });
    });

    // Clips: ?clip=<clipId>, plain Firestore doc id, no slug transform.
    // Only include ones that actually resolve — tryOpenSharedClip() in
    // index.html bails out (silently, no error shown) on any clip whose
    // data-video-src ends up empty, which happens whenever a doc has
    // neither videoId nor the legacy youtubeId field (this currently
    // includes file-type/base64 clips, since those never populate
    // videoId). Submitting those to Google would just be a dead deep-link.
    const clipsSnap = await db.collection('movieClips').get();
    clipsSnap.forEach((doc) => {
      const c = doc.data();
      if (!c) return;
      if (c.expiresAt && typeof c.expiresAt.toMillis === 'function' && c.expiresAt.toMillis() < Date.now()) return;
      const videoId = c.videoId || c.youtubeId;
      if (!videoId) return;

      const lastmod =
        c.createdAt && typeof c.createdAt.toDate === 'function'
          ? c.createdAt.toDate().toISOString()
          : undefined;

      urls.push({
        loc: `${SITE_URL}/?clip=${encodeURIComponent(doc.id)}`,
        changefreq: 'weekly',
        priority: '0.7',
        lastmod,
      });
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${escapeXml(u.loc)}</loc>
${u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : ''}    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`
  )
  .join('\n')}
</urlset>`;

    res.setHeader('Content-Type', 'application/xml');
    // Cache at the edge so Googlebot crawls don't hit Firestore every
    // time, but still refresh often enough that new matchups surface fast.
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    return res.status(200).send(xml);
  } catch (err) {
    console.error('Sitemap generation failed:', err);
    return res.status(500).send('Error generating sitemap');
  }
}
