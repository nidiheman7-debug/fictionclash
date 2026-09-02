// /api/reset-weekly-xp.js
// Triggered by Vercel Cron every Monday at 00:00 UTC (see vercel.json) to
// zero out `weeklyXp` on every user, so the Weekly leaderboard tab starts
// fresh each week. Requires the same FIREBASE_SERVICE_ACCOUNT_KEY env var
// as the other /api endpoints, plus a CRON_SECRET env var — Vercel Cron
// automatically sends `Authorization: Bearer $CRON_SECRET` on scheduled
// invocations once that env var is set, which is what keeps this from
// being a public "reset everyone's weekly score" endpoint.

import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    ),
  });
}

const db = admin.firestore();

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Only touch users who actually have a nonzero weeklyXp — skips
    // needless writes (and needless reads-with-no-effect) for accounts
    // that didn't do anything this week.
    const snap = await db.collection('users').where('weeklyXp', '>', 0).get();

    // Firestore batches cap out at 500 writes, so chunk it.
    const docs = snap.docs;
    let resetCount = 0;
    for (let i = 0; i < docs.length; i += 500) {
      const batch = db.batch();
      docs.slice(i, i + 500).forEach((docSnap) => {
        batch.set(docSnap.ref, { weeklyXp: 0 }, { merge: true });
      });
      await batch.commit();
      resetCount += Math.min(500, docs.length - i);
    }

    return res.status(200).json({ success: true, resetCount });
  } catch (err) {
    console.error('Weekly XP reset failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
