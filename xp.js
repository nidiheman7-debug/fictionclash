// /api/lib/xp.js
// Shared helper for awarding XP server-side. Any endpoint that awards XP
// (vote.js, comment.js, future contribution endpoints) should go through
// this instead of writing `xp` directly, so the verified-badge threshold
// logic lives in exactly one place.

import admin from 'firebase-admin';

export const VERIFIED_BADGE_POINTS = 1000;
export const VERIFIED_BADGE_DAYS = 30;

// Awards `delta` XP to users/{uid}. If this pushes their total across a
// new multiple of 1000, grants (or re-grants) a fresh 1-month verified
// badge — same "cross a milestone" pattern used for vote notifications.
// Runs in its own transaction so the pre-award xp value is read
// consistently even under concurrent requests.
export async function awardXp(db, uid, delta) {
  const userRef = db.collection('users').doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const currentXp = (snap.exists && snap.data().xp) || 0;
    const newXp = currentXp + delta;
    const updates = { xp: newXp };

    const crossedBadgeThreshold =
      Math.floor(newXp / VERIFIED_BADGE_POINTS) > Math.floor(currentXp / VERIFIED_BADGE_POINTS);

    let verifiedUntil = null;
    if (crossedBadgeThreshold) {
      verifiedUntil = admin.firestore.Timestamp.fromMillis(
        Date.now() + VERIFIED_BADGE_DAYS * 24 * 60 * 60 * 1000
      );
      updates.verifiedUntil = verifiedUntil;
    }

    tx.set(userRef, updates, { merge: true });
    return { newXp, badgeGranted: crossedBadgeThreshold, verifiedUntil };
  });
}
