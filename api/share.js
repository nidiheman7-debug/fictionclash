// /api/share.js
// Awards one-time XP for sharing a matchup or a clip. Mirrors /api/like:
// verifies the caller's Firebase ID token, then uses a transaction keyed on
// (targetType, targetId, uid) so re-sharing the same matchup or clip never
// re-awards XP — only the first share of a given target credits SHARE_XP.

import admin from 'firebase-admin';
import { awardXp } from './lib/xp.js';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    ),
  });
}

const db = admin.firestore();

const SHARE_XP = 20;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: 'Missing auth token' });

  const { targetType, targetId } = req.body || {};
  if (!targetId || !['matchup', 'clip'].includes(targetType)) {
    return res.status(400).json({ error: 'targetType (matchup|clip) and targetId are required' });
  }

  let uid;
  try {
    ({ uid } = await admin.auth().verifyIdToken(idToken));
  } catch (err) {
    return res.status(401).json({ error: 'Invalid auth token' });
  }

  // Deterministic doc id — a transaction .get()/.set() on it is all that's
  // needed to make the credit idempotent per user per target. Custom
  // team-builder matchups pass a composed id (e.g. "Goku+Darkseid-vs-...")
  // rather than a real matchupId, which is fine — it's just a dedupe key.
  const creditId = `${targetType}_${targetId}_${uid}`.replace(/[\/\s]+/g, '-');
  const creditRef = db.collection('shareCredits').doc(creditId);

  try {
    let alreadyCredited = false;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(creditRef);
      if (snap.exists) { alreadyCredited = true; return; }
      tx.set(creditRef, {
        uid,
        targetType,
        targetId,
        creditedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // Already shared this exact matchup/clip before — no repeat XP farming.
    if (alreadyCredited) return res.status(200).json({ success: true, xpAwarded: 0 });

    // Credit is already committed above, so from here on a failure must
    // never turn into a 500 — that would make the client think the share
    // failed while the creditRef doc says otherwise, and a retry would
    // then hit alreadyCredited and silently lose the XP for good. This is
    // awaited (not fire-and-forget) because Vercel can freeze the function
    // the instant the response is sent, killing any dangling promise
    // before it finishes writing to Firestore.
    let xpResult = null;
    try {
      xpResult = await awardXp(db, uid, SHARE_XP);
    } catch (err) {
      console.error('XP award failed:', err);
    }

    return res.status(200).json({
      success: true,
      xpAwarded: xpResult ? SHARE_XP : 0,
      xp: xpResult ? xpResult.newXp : null,
      rank: xpResult ? xpResult.rank : null,
      seasonShards: xpResult ? xpResult.newShards : null,
      badgeGranted: xpResult ? xpResult.badgeGranted : false,
      verifiedUntil: xpResult ? xpResult.verifiedUntil : null,
    });
  } catch (err) {
    console.error('Share credit transaction failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
