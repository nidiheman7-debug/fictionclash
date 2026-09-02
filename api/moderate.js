// /api/moderate.js
// Admin-only endpoint that approves or rejects a fan-submitted matchup or
// clip. Approving promotes the pendingMatchups/pendingClips doc into the
// live matchups/movieClips collection (with fresh createdAt/expiresAt) and
// deletes the pending doc; rejecting just deletes the pending doc. Both
// live collections reject direct client writes now (see firestore rules),
// so this Admin-SDK path is the only way a submission ever goes public.
// Requires the same FIREBASE_SERVICE_ACCOUNT_KEY env var as vote.js/comment.js.

import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    ),
  });
}

const db = admin.firestore();

// Mirrors the hardcoded ADMIN_UID in index.html and firestore rules —
// single-admin setup, so a literal UID rather than a custom-claims lookup.
const ADMIN_UID = 'SYpnHZFCVpP4ikNO2ZK6uPMuLyE2';

const LIFETIME_MS = 14 * 24 * 60 * 60 * 1000; // same 14-day TTL the old client-side code used

const PENDING_COLLECTION = { matchup: 'pendingMatchups', clip: 'pendingClips' };
const LIVE_COLLECTION = { matchup: 'matchups', clip: 'movieClips' };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { type, pendingId, action } = req.body || {};
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (type !== 'matchup' && type !== 'clip') {
    return res.status(400).json({ error: 'type must be "matchup" or "clip"' });
  }
  if (action !== 'approve' && action !== 'reject') {
    return res.status(400).json({ error: 'action must be "approve" or "reject"' });
  }
  if (!pendingId) {
    return res.status(400).json({ error: 'pendingId is required' });
  }
  if (!idToken) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired auth token' });
  }
  if (uid !== ADMIN_UID) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const pendingRef = db.collection(PENDING_COLLECTION[type]).doc(pendingId);

  try {
    const pendingSnap = await pendingRef.get();
    if (!pendingSnap.exists) {
      return res.status(404).json({ error: 'Submission not found (already moderated?)' });
    }
    const data = pendingSnap.data();

    if (action === 'reject') {
      await pendingRef.delete();
      return res.status(200).json({ success: true, action: 'reject' });
    }

    // Approve: build the live doc fresh rather than spreading `data`
    // wholesale, so a pending doc's own bookkeeping fields (submittedBy,
    // submittedByName, createdAt) never leak into the public collection
    // unless the live shape actually wants them.
    let liveData;
    if (type === 'matchup') {
      liveData = {
        a: data.a,
        b: data.b,
        votesA: 0,
        votesB: 0,
        community: true,
      };
    } else {
      liveData = {
        title: data.title,
        review: data.review,
        videoPlatform: data.videoPlatform,
        videoId: data.videoId,
        isShort: !!data.isShort,
        postedByUid: data.postedByUid,
        postedByName: data.postedByName,
        postedByAvatar: data.postedByAvatar,
      };
    }
    liveData.createdAt = admin.firestore.FieldValue.serverTimestamp();
    liveData.expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + LIFETIME_MS);

    const liveRef = db.collection(LIVE_COLLECTION[type]).doc();
    const batch = db.batch();
    batch.set(liveRef, liveData);
    batch.delete(pendingRef);
    await batch.commit();

    return res.status(200).json({ success: true, action: 'approve', liveId: liveRef.id });
  } catch (err) {
    console.error('Moderation action failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
