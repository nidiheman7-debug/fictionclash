// /api/clip-comment.js
// Server-authoritative comment posting for movie clips. Same pattern as
// comment.js (matchup comments): verifies identity, pulls the poster's
// profile fields from Firestore server-side, and awards XP. Requires the
// same FIREBASE_SERVICE_ACCOUNT_KEY env var as vote.js/comment.js.

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

const CLIP_COMMENT_XP = 5;
const MAX_COMMENT_LENGTH = 500;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { clipId, text, replyTo } = req.body || {};
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!clipId || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'clipId and text are required' });
  }
  if (text.trim().length > MAX_COMMENT_LENGTH) {
    return res.status(400).json({ error: `Comment too long (max ${MAX_COMMENT_LENGTH} chars)` });
  }
  // See comment.js for why this is trusted-but-sanitized rather than
  // re-fetched from the original comment — purely a decorative quoted
  // preview, same treatment as Discord's own reply UI.
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
    const clipSnap = await db.collection('movieClips').doc(clipId).get();
    if (!clipSnap.exists) {
      return res.status(404).json({ error: 'Clip not found' });
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

    const commentRef = db.collection('movieClips').doc(clipId).collection('comments').doc();
    await commentRef.set({
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

    // Awaited (not fire-and-forget) so Vercel can't freeze this function
    // before the XP write lands — see vote.js/comment.js for the same fix.
    let xpResult = null;
    try {
      xpResult = await awardXp(db, uid, CLIP_COMMENT_XP);
    } catch (err) {
      console.error('XP award failed:', err);
    }

    return res.status(200).json({
      success: true,
      commentId: commentRef.id,
      xpAwarded: xpResult ? CLIP_COMMENT_XP : 0,
      rank: xpResult ? xpResult.rank : null,
    });
  } catch (err) {
    console.error('Clip comment post failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
