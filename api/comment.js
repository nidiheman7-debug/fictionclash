// /api/comment.js
// Server-authoritative comment posting for matchups. Verifies identity and
// pulls the poster's profile fields from Firestore (so a comment can't be
// spoofed to show a different name/avatar). Does NOT award XP — XP only
// comes from backing the winning side of a vote (see vote.js /
// settle-matchup.js). Requires the same FIREBASE_SERVICE_ACCOUNT_KEY env
// var as vote.js.

import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    ),
  });
}

const db = admin.firestore();

const MAX_COMMENT_LENGTH = 500;

// Mirrors APP_STICKERS in app.js — kept in sync manually since this file
// can't import from the client bundle. Free stickers, unlocked purely by
// an XP milestone (never spent), so validation here is just "does this
// id exist, and has this uid's current xp crossed its line" — no
// currency/ledger bookkeeping needed, unlike decoration/font purchases.
const APP_STICKERS = [
  { id: 'ko', requiresXp: 500 },
  { id: 'gg', requiresXp: 1000 },
  { id: 'clash', requiresXp: 1500 },
  { id: 'win', requiresXp: 2000 },
  { id: 'savage', requiresXp: 2500 },
  { id: 'facts', requiresXp: 3000 },
  { id: 'lit', requiresXp: 3500 },
  { id: 'goat', requiresXp: 4000 },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { matchupId, text, replyTo, stickerId } = req.body || {};
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  // A comment can be sticker-only now (Discord-style sticker message), so
  // text is only required when no sticker is attached.
  const trimmedText = typeof text === 'string' ? text.trim() : '';
  const requestedStickerId = typeof stickerId === 'string' && stickerId.trim() ? stickerId.trim() : null;
  if (!matchupId || (!trimmedText && !requestedStickerId)) {
    return res.status(400).json({ error: 'matchupId and text or stickerId are required' });
  }
  if (trimmedText.length > MAX_COMMENT_LENGTH) {
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
  //
  // replyToUid is the one exception: it's used below purely to address a
  // notification (whose inbox to write to), never displayed or trusted as
  // an authenticated fact about the quoted comment — so a spoofed uid at
  // worst misdirects a notification, it can't forge who a comment is
  // "from" or touch anything XP/points-bearing.
  let replyToName = null;
  let replyToText = null;
  let replyToAvatarUrl = null;
  let replyToUid = null;
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
    if (typeof replyTo.uid === 'string' && replyTo.uid.trim()) {
      replyToUid = replyTo.uid.trim();
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
    let xp = 0;
    const userSnap = await db.collection('users').doc(uid).get();
    if (userSnap.exists) {
      const u = userSnap.data();
      name = u.name || name;
      avatarUrl = u.avatarUrl || null;
      decorationId = u.equippedDecoration || null;
      xp = u.xp || 0;
    }

    // Validate the sticker server-side against the uid's actual current
    // xp — the client-side picker already only shows unlocked stickers,
    // but this is the enforcement point that stops a spoofed request from
    // attaching a still-locked sticker.
    let stickerId = null;
    if (requestedStickerId) {
      const stickerDef = APP_STICKERS.find(s => s.id === requestedStickerId);
      if (!stickerDef) {
        return res.status(400).json({ error: 'Unknown sticker' });
      }
      if (xp < stickerDef.requiresXp) {
        return res.status(403).json({ error: `Sticker locked — reach ${stickerDef.requiresXp} XP to unlock it` });
      }
      stickerId = stickerDef.id;
    }

    const commentRef = db.collection('matchupComments').doc();
    await commentRef.set({
      matchupId,
      text: trimmedText,
      stickerId,
      name,
      avatarUrl,
      decorationId,
      replyToName,
      replyToText,
      replyToAvatarUrl,
      uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Notify the person being replied to — but never for replying to your
    // own comment (self-reply, or a stale/self-targeted client payload),
    // and only if we actually resolved a uid to address the notification
    // to. Best-effort: a failure here should never fail the comment post
    // itself, since the comment already landed successfully above.
    if (replyToUid && replyToUid !== uid) {
      try {
        await db
          .collection('users')
          .doc(replyToUid)
          .collection('notifications')
          .add({
            type: 'reply',
            fromUid: uid,
            fromName: name,
            fromAvatarUrl: avatarUrl,
            text: trimmedText ? trimmedText.slice(0, 160) : (stickerId ? '[sticker]' : ''),
            matchupId,
            commentId: commentRef.id,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
      } catch (notifyErr) {
        console.error('Reply notification write failed (comment still posted):', notifyErr);
      }
    }

    // Comments no longer award XP — only backing the winning side of a
    // vote does (see vote.js / settle-matchup.js).
    return res.status(200).json({
      success: true,
      commentId: commentRef.id,
      xpAwarded: 0,
      rank: null,
      seasonShards: null,
      badgeGranted: false,
      verifiedUntil: null,
    });
  } catch (err) {
    console.error('Comment post failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
