// /api/comment.js
// Server-authoritative comment posting for matchups. Verifies identity,
// pulls the poster's profile fields from Firestore (so a comment can't be
// spoofed to show a different name/avatar), and awards XP toward the
// verified badge. Requires the same FIREBASE_SERVICE_ACCOUNT_KEY env var
// as vote.js.

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

const COMMENT_XP = 10;
const MAX_COMMENT_LENGTH = 500;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { matchupId, text, replyTo } = req.body || {};
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!matchupId || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'matchupId and text are required' });
  }
  if (text.trim().length > MAX_COMMENT_LENGTH) {
    return res.status(400).json({ error: `Comment too long (max ${MAX_COMMENT_LENGTH} chars)` });
  }
  // replyTo is a lightweight, denormalized snapshot of the comment being
  // replied to (name + a short text snippet) captured at reply time —
  // NOT a live reference to the original comment's id. This is a purely
  // decorative quoted preview (same as Discord's own reply UI shows even
  // after the original message is later edited/deleted), so it's fine to
  // trust the client's copy rather than re-fetching the original comment
  // server-side; it's sanitized and length-capped the same as any other
  // free-text field here, not treated as an authenticated fact.
  let replyToName = null;
  let replyToText = null;
  let replyToAvatarUrl = null;
  if (replyTo && typeof replyTo === 'object') {
    if (typeof replyTo.name === 'string' && replyTo.name.trim()) {
      replyToName = replyTo.name.trim().slice(0, 60);
    }
    if (typeof replyTo.text === 'string' && replyTo.text.trim()) {
      replyToText = replyTo.text.trim().slice(0, 120);
    }
    // Same size ceiling comments already accept for a poster's own
    // avatarUrl elsewhere in this file — a data-URL avatar is already
    // this large sitting on the original comment, so this isn't a new
    // size class, just carrying the same value one comment further.
    if (typeof replyTo.avatarUrl === 'string' && replyTo.avatarUrl.length < 500000) {
      replyToAvatarUrl = replyTo.avatarUrl;
    }
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

  try {
    const matchupSnap = await db.collection('matchups').doc(matchupId).get();
    if (!matchupSnap.exists) {
      return res.status(404).json({ error: 'Matchup not found' });
    }

    // Pull the poster's current profile fields server-side rather than
    // trusting whatever the client sends, so a comment's name/avatar/
    // decoration can't be spoofed to impersonate someone else.
    let name = 'User';
    let avatarUrl = null;
    let decorationId = null;
    const userSnap = await db.collection('users').doc(uid).get();
    if (userSnap.exists) {
      const u = userSnap.data();
      name = u.name || name;
      avatarUrl = u.avatarUrl || null;
      decorationId = u.equippedDecoration || null;
    }

    const commentRef = db.collection('matchupComments').doc();
    await commentRef.set({
      matchupId,
      text: text.trim(),
      name,
      avatarUrl,
      decorationId,
      replyToName,
      replyToText,
      replyToAvatarUrl,
      uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Awarded (and awaited) here rather than fired-and-forgotten: a
    // comment should never FAIL because XP hiccuped, so failures are
    // swallowed — but the write itself must be awaited, because Vercel
    // can freeze this function's execution the instant the response is
    // sent, killing any dangling un-awaited promise before it finishes
    // writing to Firestore.
    let xpResult = null;
    try {
      xpResult = await awardXp(db, uid, COMMENT_XP);
    } catch (err) {
      console.error('XP award failed:', err);
    }

    return res.status(200).json({
      success: true,
      commentId: commentRef.id,
      xpAwarded: xpResult ? COMMENT_XP : 0,
      rank: xpResult ? xpResult.rank : null,
      seasonShards: xpResult ? xpResult.newShards : null,
      badgeGranted: xpResult ? xpResult.badgeGranted : false,
      verifiedUntil: xpResult ? xpResult.verifiedUntil : null,
    });
  } catch (err) {
    console.error('Comment post failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
