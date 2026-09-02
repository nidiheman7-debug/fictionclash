// /api/lib/xp.js
// Shared helper for awarding XP server-side. Any endpoint that awards XP
// (vote.js, comment.js, like.js, clip-comment.js) should go through this
// instead of writing `xp` directly, so the verified-badge threshold logic
// and weekly-leaderboard bookkeeping live in exactly one place.

import admin from 'firebase-admin';

export const VERIFIED_BADGE_POINTS = 1000;
export const VERIFIED_BADGE_DAYS = 30;

// Awards `delta` XP to users/{uid}, both to the lifetime `xp` total and to
// `weeklyXp` (zeroed out every Monday by /api/reset-weekly-xp — see that
// file for the schedule). If this pushes the lifetime total across a new
// multiple of 1000, grants (or re-grants) a fresh 1-month verified badge.
// Runs in its own transaction so the pre-award values are read
// consistently even under concurrent requests.
export async function awardXp(db, uid, delta) {
  const userRef = db.collection('users').doc(uid);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const currentXp = (snap.exists && snap.data().xp) || 0;
    const currentWeeklyXp = (snap.exists && snap.data().weeklyXp) || 0;
    const newXp = currentXp + delta;
    const newWeeklyXp = currentWeeklyXp + delta;
    const updates = { xp: newXp, weeklyXp: newWeeklyXp };

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
    return { newXp, newWeeklyXp, badgeGranted: crossedBadgeThreshold, verifiedUntil };
  });

  // All-time rank: 1 + however many users have strictly more lifetime XP.
  // Best-effort — a failure here shouldn't undo or fail the XP award
  // itself, so a null rank just means the caller's "You're now #N" toast
  // skips that line rather than showing something wrong.
  let rank = null;
  try {
    const aggSnap = await db.collection('users').where('xp', '>', result.newXp).count().get();
    rank = aggSnap.data().count + 1;
  } catch (err) {
    console.error('Rank computation failed:', err);
  }

  return { ...result, rank };
}
