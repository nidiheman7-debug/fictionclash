// /api/vote.js
// Server-authoritative vote endpoint for Fiction Clash.
// Requires FIREBASE_SERVICE_ACCOUNT_KEY env var on Vercel (the full JSON
// key from Firebase Console > Project Settings > Service Accounts,
// stored as a single-line stringified JSON).

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

const MILESTONES = [10, 50, 100, 500, 1000, 5000, 10000];
const VOTE_XP = 5;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

async function sendMilestoneNotification(matchup, totalVotes) {
  if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) return;

  const nameA = matchup.a && matchup.a.name;
  const nameB = matchup.b && matchup.b.name;
  const title = 'Fiction Clash 🔥';
  const message = `${nameA} vs ${nameB} just hit ${totalVotes.toLocaleString()} votes! See who's winning.`;

  try {
    await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        included_segments: ['Subscribed Users'],
        headings: { en: title },
        contents: { en: message },
      }),
    });
  } catch (err) {
    // Notification failure should never fail the vote itself
    console.error('OneSignal notification failed:', err);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { matchupId, choice } = req.body || {};
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!matchupId || (choice !== 'a' && choice !== 'b')) {
    return res.status(400).json({ error: 'matchupId and choice ("a" or "b") are required' });
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

  const matchupRef = db.collection('matchups').doc(matchupId);
  const voterRef = matchupRef.collection('voters').doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const [matchupSnap, voterSnap] = await Promise.all([
        tx.get(matchupRef),
        tx.get(voterRef),
      ]);

      if (!matchupSnap.exists) {
        throw { status: 404, message: 'Matchup not found' };
      }

      const matchup = matchupSnap.data();

      if (matchup.expiresAt && matchup.expiresAt.toMillis() < Date.now()) {
        throw { status: 410, message: 'This clash has ended' };
      }

      if (voterSnap.exists) {
        throw { status: 409, message: 'You already voted on this clash' };
      }

      const field = choice === 'a' ? 'votesA' : 'votesB';
      const newVotesA = (matchup.votesA || 0) + (choice === 'a' ? 1 : 0);
      const newVotesB = (matchup.votesB || 0) + (choice === 'b' ? 1 : 0);
      const newTotal = newVotesA + newVotesB;

      const notifiedMilestones = matchup.notifiedMilestones || [];
      const crossedMilestone = MILESTONES.find(
        (m) => newTotal >= m && !notifiedMilestones.includes(m)
      );

      const updates = { [field]: admin.firestore.FieldValue.increment(1) };
      if (crossedMilestone) {
        updates.notifiedMilestones = admin.firestore.FieldValue.arrayUnion(crossedMilestone);
      }

      tx.update(matchupRef, updates);
      tx.set(voterRef, {
        votedFor: choice,
        votedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        votesA: newVotesA,
        votesB: newVotesB,
        crossedMilestone,
        matchup,
      };
    });

    if (result.crossedMilestone) {
      // Fire-and-forget: don't block the response on notification delivery
      sendMilestoneNotification(result.matchup, result.crossedMilestone);
    }

    // Award XP for the vote itself. Also handles the verified-badge
    // threshold (crossing a new 1000 points) via the shared helper —
    // bypasses Firestore rules entirely via the Admin SDK, so this is
    // the only path that can ever change `xp` or `verifiedUntil`.
    // Kept outside the vote transaction since an XP/badge hiccup should
    // never roll back or block a successful vote — but it IS awaited
    // (just wrapped so it can't fail the request) because Vercel can
    // freeze this function's execution the instant the response is
    // sent, killing any dangling un-awaited promise before it finishes
    // writing to Firestore.
    let xpResult = null;
    try {
      xpResult = await awardXp(db, uid, VOTE_XP);
    } catch (err) {
      console.error('XP award failed:', err);
    }

    return res.status(200).json({
      success: true,
      votesA: result.votesA,
      votesB: result.votesB,
      xpAwarded: xpResult ? VOTE_XP : 0,
      rank: xpResult ? xpResult.rank : null,
      badgeGranted: xpResult ? xpResult.badgeGranted : false,
      verifiedUntil: xpResult ? xpResult.verifiedUntil : null,
    });
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Vote transaction failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
