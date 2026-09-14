import {
    GoogleAuthProvider,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    onAuthStateChanged,
    signOut
  } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
  import {
    doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, deleteField, increment, arrayUnion, runTransaction, collection, onSnapshot,
    query, where, orderBy, limit, serverTimestamp, Timestamp, getCountFromServer
  } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

  const auth = window.firebaseAuth;

  // ---------- boot loading screen ----------
  // Shown from first paint (it's plain HTML/CSS above the fold, no JS
  // needed to appear). Hidden once we hear back from Firebase auth, since
  // that's the first real signal the app has connected to anything — with
  // a timeout fallback so a slow/offline connection never blocks it forever.
  const appLoadingScreen = document.getElementById('appLoadingScreen');
  let appLoadingScreenHidden = false;
  function hideAppLoadingScreen(){
    if (appLoadingScreenHidden || !appLoadingScreen) return;
    appLoadingScreenHidden = true;
    appLoadingScreen.classList.add('is-hidden');
    setTimeout(() => appLoadingScreen.remove(), 600);
  }
  setTimeout(hideAppLoadingScreen, 4000);

  // The one account allowed to actually delete matchups/clips from
  // Firestore for everyone. Find your UID in Firebase Console →
  // Authentication → Users → your row → "User UID" column, then paste it
  // here. Until it's filled in, nobody gets real deletes — everyone
  // (including you) just gets the local "hide from my feed" behavior.
  const ADMIN_UID = 'SYpnHZFCVpP4ikNO2ZK6uPMuLyE2';
  function isAdmin(){
    return !!(auth.currentUser && auth.currentUser.uid === ADMIN_UID);
  }

  // Shared "add sticker" icon markup for every comment composer's toggle
  // button (hero card, full comments sheet, and each dynamically-built
  // clip card) — defined once up top since the clip card template below
  // needs it long before the sticker catalog itself is declared further
  // down this file.
  const STICKER_TOGGLE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12.5V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h5.5"/><path d="M20 12.5 13.5 19H13a1.5 1.5 0 0 1-1.5-1.5v-.5A6 6 0 0 1 17.5 11h.5a2 2 0 0 1 2 1.5Z"/></svg>`;
  const db = window.firebaseDb;
  const googleProvider = new GoogleAuthProvider();

  // Turns any string into a safe Firestore document ID / Storage path
  // segment (character names, matchup keys, etc. can contain spaces,
  // parentheses, slashes...).
  function safeId(value){
    return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  }

  // ---------- theme mode (Dark / Light / Device) ----------
  // Chosen from Settings ▸ Appearance ▸ Theme (#themeModeTabs) — the
  // header icon this used to be is gone; see index.html's inline boot
  // script for the pre-paint version of this same logic (it can't call
  // into this file since it runs before app.js loads).
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  // Keeps the status bar (the strip behind the clock/battery icons, both in
  // the browser tab and the installed PWA) matching the current theme
  // instead of being stuck on one fixed color.
  function syncStatusBarColor(){
    if (!themeColorMeta) return;
    const isLight = document.body.classList.contains('light');
    themeColorMeta.setAttribute('content', isLight ? '#f1f1ef' : '#1c1d23');
  }
  const THEME_MODES = ['dark', 'light', 'device'];
  let themeMode = THEME_MODES.includes(localStorage.getItem('fictionClashThemeMode'))
    ? localStorage.getItem('fictionClashThemeMode')
    : 'dark'; // Dark is the app's default — see the boot script's migration note.
  const deviceThemeQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function resolveIsLight(mode){
    if (mode === 'light') return true;
    if (mode === 'device') return !!(deviceThemeQuery && deviceThemeQuery.matches);
    return false; // 'dark'
  }
  // Called on a tab click, and also whenever the season changes (since a
  // season can force dark regardless of the chosen mode — see below).
  function applyThemeMode(mode){
    if (!THEME_MODES.includes(mode)) return;
    themeMode = mode;
    // A dark/light/device pick is pure UI state, not tracking — it belongs
    // with the other "essential" writes (votes, profile, sign-in) rather
    // than behind the cookie-consent gate, or it silently fails to persist
    // for anyone who hasn't explicitly hit "Accept" on that banner and
    // snaps back to the default on the next load.
    try { localStorage.setItem('fictionClashThemeMode', mode); } catch (err) {}
    document.querySelectorAll('#themeModeTabs [data-theme-mode]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeMode === mode);
    });
    const seasonLocks = !!SEASONS_LOCK_LIGHT[activeSeasonId];
    if (seasonLocks && mode !== 'dark') {
      showToast('Saved — but light mode stays off during ' + (SEASONS[activeSeasonId]?.label || 'this season'));
    }
    const isLight = seasonLocks ? false : resolveIsLight(mode);
    if (isLight !== document.body.classList.contains('light')) {
      document.body.classList.toggle('light', isLight);
      applyTheme(currentThemeName);
    }
    syncStatusBarColor();
  }
  document.querySelectorAll('#themeModeTabs [data-theme-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeMode === themeMode);
    btn.addEventListener('click', () => applyThemeMode(btn.dataset.themeMode));
  });
  // "Device" mode stays live — if the phone's own light/dark setting
  // changes while the app is open, follow it immediately.
  if (deviceThemeQuery && deviceThemeQuery.addEventListener) {
    deviceThemeQuery.addEventListener('change', () => {
      if (themeMode === 'device') applyThemeMode('device');
    });
  }
  // Called whenever the active season changes (including on first load).
  // Anime/Horror season forces dark mode for its duration; leaving the
  // season restores whatever mode the user actually has chosen (or the
  // dark default, if they never touched it).
  function applySeasonLightLock(seasonId){
    const locksLight = !!SEASONS_LOCK_LIGHT[seasonId];
    const isLight = locksLight ? false : resolveIsLight(themeMode);
    if (isLight !== document.body.classList.contains('light')) {
      document.body.classList.toggle('light', isLight);
      applyTheme(currentThemeName);
    }
    syncStatusBarColor();
  }
  syncStatusBarColor(); // set it correctly for whatever theme loads by default

  // ---------- toast helper ----------
  const toastEl = document.getElementById('toast');
  let toastTimer;
  function showToast(msg){
    toastEl.className = 'toast';
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  // Shown after voting/commenting/liking instead of the plain text toast,
  // whenever the server actually awarded XP and returned a rank — gives
  // the "+10 XP 🎉 You're now #23 → View Leaderboard" feedback that makes
  // the leaderboard part of the moment-to-moment loop, not just a page
  // someone occasionally checks. Falls back to a plain toast if `rank`
  // came back null (best-effort computation on the server — see xp.js).
  function showXpToast(xpAwarded, rank){
    if (!xpAwarded) return;
    if (rank == null) { showToast(`+${xpAwarded} XP`); return; }
    toastEl.className = 'toast interactive';
    toastEl.innerHTML = `<span class="toast-xp-line">+${xpAwarded} XP 🎉 You're now #${rank}</span><span class="toast-rank-link">View Leaderboard →</span>`;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
  }
  toastEl.addEventListener('click', (e) => {
    if (!e.target.closest('.toast-rank-link')) return;
    toastEl.classList.remove('show');
    document.getElementById('qaLeaderboard').click();
  });

  // ---------- spinner helper ----------
  // Shows a spinner inside a button while an async action runs, then
  // restores the button's original content once it resolves (or rejects).
  function withSpinner(btn, loadingLabel, action, delay = 350){
    if (btn.disabled) return;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span><span>${loadingLabel}</span>`;
    setTimeout(async () => {
      try {
        await action();
      } finally {
        btn.innerHTML = original;
        btn.disabled = false;
      }
    }, delay);
  }

  // ---------- AI character analysis (Gemini, via /api/character-analysis) ----------
  // Shared by AI Power Scout (hero), Compare Characters, and Team Builder's
  // AI feat check — one endpoint, one response shape, three consumers.
  // Falls back to the local hand-tuned aiStatsProfiles/featProfiles maps if
  // the API call fails for any reason (not deployed yet, rate limited, no
  // network) so none of the three features ever hard-break.
  const aiAnalysisCache = {}; // cacheKey -> parsed response

  function clampStat(n){
    const num = Math.round(Number(n));
    return Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : 70;
  }

  async function fetchCharacterAnalysis(names, question){
    const cacheKey = `${names.map(n => n.trim().toLowerCase()).sort().join('||')}::${(question || '').trim().toLowerCase()}`;
    if (aiAnalysisCache[cacheKey]) return aiAnalysisCache[cacheKey];
    // Match the server's own 9s deadline (see character-analysis.js) so a
    // stuck request never leaves the button spinning far longer than the
    // server would ever actually take to respond.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch('/api/character-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characters: names, question: question || undefined }),
        signal: controller.signal
      });
      if (!res.ok) throw new Error('AI analysis request failed: ' + res.status);
      const data = await res.json();
      if (!data || typeof data !== 'object' || !data.characters) throw new Error('Unexpected AI response shape');
      aiAnalysisCache[cacheKey] = data;
      return data;
    } catch (err) {
      console.warn('AI analysis unavailable, falling back to local ratings:', err);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---------- matchup data ----------
  // Built-in matchups/clips have no Firestore doc of their own (they're
  // hardcoded in this file), so admin can't just deleteDoc() them the way
  // community submissions get deleted. Instead, admin deleting one of
  // these writes its key into this single shared doc — every client
  // (including admin's own other devices) listens to it live and filters
  // matching built-ins out of view, so it's a real "gone for everyone"
  // delete, not just a per-device hide.
  const globallyHiddenMatchupKeys = new Set();
  const globallyHiddenClipIds = new Set();

  // ---------- cookie / local-storage consent ----------
  // Fiction Clash has no third-party ads or analytics trackers, but it does
  // use localStorage (and Firebase's own sign-in session storage) — which
  // the cookie/ePrivacy rules this banner is for treat the same as cookies.
  // "Essential" storage (votes, hidden items, uploads, profile, sign-in,
  // and this consent flag itself) is needed to deliver something the user
  // explicitly asked for, so it's written regardless of this choice — same
  // legal basis most sites use to skip a consent prompt for a shopping
  // cart. Only the purely optional/preference writes below are gated.
  const COOKIE_CONSENT_KEY = 'fictionClashCookieConsent'; // 'accepted' | 'rejected'
  function getCookieConsent(){
    try { return localStorage.getItem(COOKIE_CONSENT_KEY); } catch (err) { return null; }
  }
  function setCookieConsent(value){
    try { localStorage.setItem(COOKIE_CONSENT_KEY, value); } catch (err) {}
  }
  function nonEssentialStorageAllowed(){
    return getCookieConsent() === 'accepted';
  }
  function applyCookieConsentChoice(value){
    setCookieConsent(value);
    cookieBanner.hidden = true;
    renderCookiePolicyStatus();
    showToast(value === 'accepted' ? 'Preferences saved — thanks!' : 'Only essential storage will be used');
  }
  function applyGlobalHiddenBuiltins(){
    let heroNeedsRerender = false;
    for (let i = matchups.length - 1; i >= 0; i--) {
      if (globallyHiddenMatchupKeys.has(matchupPairKey(matchups[i]))) {
        if (i === activeIdx) heroNeedsRerender = true;
        matchups.splice(i, 1);
        if (i < activeIdx) activeIdx--;
      }
    }
    if (matchups.length && activeIdx >= matchups.length) activeIdx = matchups.length - 1;
    if (heroNeedsRerender || matchups.length === 0) renderHero();
    renderTrendScroll();
    globallyHiddenClipIds.forEach(clipId => {
      const card = clipFeed?.querySelector(`.clip-card[data-clip-id="${clipId}"]`);
      if (card) { deactivateCanvasFx(card); card.remove(); }
    });
  }
  onSnapshot(doc(db, 'appConfig', 'hiddenBuiltins'), snap => {
    const data = snap.exists() ? snap.data() : {};
    globallyHiddenMatchupKeys.clear();
    (data.matchupKeys || []).forEach(k => globallyHiddenMatchupKeys.add(k));
    globallyHiddenClipIds.clear();
    (data.clipIds || []).forEach(id => globallyHiddenClipIds.add(id));
    applyGlobalHiddenBuiltins();
  }, err => console.error('Hidden-builtins listener failed', err));

  // ---------- Seasons: full app reskins (colors/art/font), rotated by an
  // admin flag in appConfig/activeSeason. Each entry here is pure data —
  // adding season #2 later is a config addition, not new code. The CSS
  // side (body.season-<id> rules) lives in the <style> block above and
  // must exist for any id added here, or applySeason() just adds a class
  // that does nothing.
  // Every new matchup gets a 48h blind-voting window by default now (see
  // /api/moderate.js for where this actually needs to be read at
  // creation time — that file wasn't available here, so the auto-default
  // on brand-new matchups isn't wired in yet; this constant just drives
  // the admin bulk-apply action and the per-matchup timer input's default
  // below, both of which work today).
  const DEFAULT_REVEAL_HOURS = 48;

  // Inline SVG padlock — used in place of the 🔒 emoji for blind-voting's
  // "results reveal in..." state, so it renders consistently across
  // platforms/fonts instead of however each OS draws the lock emoji.
  // currentColor so it always matches .vote-reveal-state's text color.
  const REVEAL_LOCK_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;vertical-align:-1px;"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

  const SEASONS = {
    anime: {
      id: 'anime',
      label: 'Anime Season',
      bodyClass: 'season-anime',
      bannerAsset: '/public/seasons/anime/store-banner.png?v=2',
      currencyLabel: 'Shards',
      // The below three drive the share-card canvas (drawBattleCardShell),
      // which can't read CSS variables — literal values pulled out of what
      // used to be hardcoded isAnime branches, so a new season is a data
      // addition here too, not a new canvas branch.
      currencyIcon: '/public/seasons/anime/shard-icon.png',
      cardArt: '/public/seasons/anime/battle-card-bg.jpg',
      cardAccentColor: '#C8C8C8',
      cardGlowRgb: '200,200,200',
    },
    horror: {
      id: 'horror',
      label: 'Horror Season',
      bodyClass: 'season-horror',
      bannerAsset: '/public/seasons/horror/store-banner.png?v=1',
      currencyLabel: 'Skulls',
      currencyIcon: '/public/seasons/horror/skull-icon.svg',
      cardArt: '/public/seasons/horror/battle-card-bg.jpg',
      cardAccentColor: '#FF1B3C',
      cardGlowRgb: '139,0,0',
    },
    // Crossverse Season — a Hollywood-crossover event (the kind of "who
    // wins" showdown the whole app already runs on: Marvel, DC, Mortal
    // Kombat and friends), so the reskin itself avoids naming any single
    // studio/franchise directly — gold-statuette + red-carpet premiere
    // styling reads as "big movie event" without borrowing anyone's IP.
    // Users are still free to label their own submitted characters with
    // whatever source they like (see submitSourceA/B) — that's unchanged.
    crossverse: {
      id: 'crossverse',
      label: 'Crossverse Season',
      bodyClass: 'season-crossverse',
      bannerAsset: '/public/seasons/crossverse/store-banner.png?v=1',
      currencyLabel: 'Reels',
      currencyIcon: '/public/seasons/crossverse/reel-icon.svg',
      cardArt: '/public/seasons/crossverse/battle-card-bg.jpg',
      cardAccentColor: '#FFD54A',
      cardGlowRgb: '255,213,74',
    },
  };

  let activeSeasonId = null;

  // Anime Season and Horror Season both cancel light mode for as long as
  // they're live — the app runs dark-only. Kept as a lookup (rather than
  // an `=== 'anime' || === 'horror'` check scattered around) so a future
  // season can opt in/out of the same lock in one place.
  const SEASONS_LOCK_LIGHT = { anime: true, horror: true, crossverse: true };

  function applySeason(seasonId){
    // Strip every season body-class before applying the new one, so
    // switching (or clearing) the active season never leaves a stale
    // reskin layered underneath the new one.
    Object.values(SEASONS).forEach(s => document.body.classList.remove(s.bodyClass));
    const season = seasonId ? SEASONS[seasonId] : null;
    if (season) document.body.classList.add(season.bodyClass);
    const seasonChanged = activeSeasonId !== (season ? season.id : null);
    activeSeasonId = season ? season.id : null;

    // Mirror the season into localStorage so index.html's synchronous boot
    // script can guess right on the *next* load, before Firebase has even
    // connected — otherwise every reload would flash light-mode-on for a
    // moment during a season. Cleared (not just left stale) once the
    // season ends, so a later normal load doesn't wrongly lock light mode.
    if (nonEssentialStorageAllowed()) {
      if (season) localStorage.setItem('fictionClashLastSeason', season.id);
      else localStorage.removeItem('fictionClashLastSeason');
    }

    // Not gated on seasonChanged — this also has to run on the very first
    // call (page load), to correct a wrong guess from the inline boot
    // script's cached season (e.g. a season that ended while offline).
    applySeasonLightLock(season ? season.id : null);
    recomputeSeasonShards();
    if (typeof renderCustomizationStore === 'function') renderCustomizationStore();
    if (typeof updateLeaderboardSeasonAvailability === 'function') updateLeaderboardSeasonAvailability();
    // The matchups onSnapshot listener only filters docs AS THEY ARRIVE —
    // anything already sitting in the `matchups` array from before the
    // season changed (or before it was known) needs a fresh, filtered
    // rebuild, both for someone loading the app for the first time after
    // a season went live and for an admin flipping it on/off while people
    // already have the app open.
    if (seasonChanged && typeof resyncMatchupsForSeason === 'function') resyncMatchupsForSeason();
  }

  onSnapshot(doc(db, 'appConfig', 'activeSeason'), snap => {
    const data = snap.exists() ? snap.data() : {};
    applySeason(data.seasonId || null);
    renderSeasonAdminControls();
  }, err => console.error('Active-season listener failed', err));

  // ---------- admin: turn seasons on/off ----------
  // Writes straight to appConfig/activeSeason — the same doc every client's
  // onSnapshot listener above is already watching, so a toggle here goes
  // live for everyone the moment the write lands. No Cloud Function needed.
  const adminSeasonCard = document.getElementById('adminSeasonCard');
  const seasonAdminList = document.getElementById('seasonAdminList');
  function updateSeasonCardVisibility(){
    if (adminSeasonCard) adminSeasonCard.classList.toggle('hidden', !isAdmin());
    document.getElementById('settingsAdminGroup')?.classList.toggle('hidden', !isAdmin());
  }
  function renderSeasonAdminControls(){
    updateSeasonCardVisibility();
    if (!seasonAdminList || !isAdmin()) return;
    seasonAdminList.innerHTML = Object.values(SEASONS).map(season => {
      const isLive = activeSeasonId === season.id;
      return `
        <div class="admin-report-row" data-season-id="${season.id}">
          <div class="admin-report-info">
            <b>${escapeHtml(season.label)}</b>
            <span>${isLive ? 'Live now — visible to everyone' : 'Not live'}</span>
          </div>
          <div class="admin-report-actions">
            <button type="button" class="${isLive ? 'danger' : ''}" data-season-action="${isLive ? 'deactivate' : 'activate'}">${isLive ? 'Turn off' : 'Turn on'}</button>
          </div>
        </div>
      `;
    }).join('');
  }
  if (seasonAdminList) {
    seasonAdminList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-season-action]');
      if (!btn) return;
      const row = btn.closest('[data-season-id]');
      const seasonId = row?.dataset.seasonId;
      const season = seasonId ? SEASONS[seasonId] : null;
      if (!season) return;
      const activating = btn.dataset.seasonAction === 'activate';
      btn.disabled = true;
      setDoc(doc(db, 'appConfig', 'activeSeason'), { seasonId: activating ? seasonId : null })
        .then(() => showToast(activating ? `${season.label} is now live` : `${season.label} turned off`))
        .catch(err => {
          console.error('Season toggle failed', err);
          showToast('Could not update season — try again');
          btn.disabled = false;
        });
      // No need to manually re-enable/re-render on success — the
      // onSnapshot listener above fires from our own write and calls
      // renderSeasonAdminControls(), which redraws this row.
    });
  }

  // ---------- admin: tag matchups with a season category ----------
  // Deliberately a SEPARATE, unfiltered listener from the main matchups
  // one above — that one hides anything not tagged for the active season,
  // which would make it impossible for an admin to ever find and tag the
  // very matchups that need tagging. This one always shows everything,
  // admin-only, regardless of what season (if any) is currently live.
  const adminMatchupCategoryCard = document.getElementById('adminMatchupCategoryCard');
  const matchupCategoryList = document.getElementById('matchupCategoryList');
  let adminAllMatchups = [];
  function updateMatchupCategoryCardVisibility(){
    if (adminMatchupCategoryCard) adminMatchupCategoryCard.classList.toggle('hidden', !isAdmin());
  }
  function renderMatchupCategoryList(){
    updateMatchupCategoryCardVisibility();
    if (!matchupCategoryList || !isAdmin()) return;
    matchupCategoryList.innerHTML = adminAllMatchups.map(m => {
      const revealAtMs = m.revealAt ? m.revealAt.toMillis() : null;
      const revealStatus = !revealAtMs ? 'No reveal timer — results are always visible'
        : revealAtMs > Date.now() ? `Blind until ${new Date(revealAtMs).toLocaleString()}`
        : `Revealed${m.resultsSettled ? ' · XP paid out' : ' · settling…'}`;
      return `
      <div class="admin-report-row admin-matchup-row" data-matchup-id="${m.docId}">
        <div class="admin-report-info">
          <b>${escapeHtml(m.a.name)} vs ${escapeHtml(m.b.name)}</b>
          <span>${m.category ? SEASONS[m.category]?.label || m.category : 'Untagged'}</span>
          <span>${revealStatus}</span>
        </div>
        <div class="admin-report-actions">
          <select data-category-select>
            <option value="">— Untagged —</option>
            ${Object.values(SEASONS).map(s => `<option value="${s.id}" ${m.category === s.id ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
          </select>
          <input type="number" min="1" step="1" placeholder="Hrs" value="${DEFAULT_REVEAL_HOURS}" class="admin-reveal-hours" data-reveal-hours>
          <button type="button" data-reveal-action="set">Blind vote for N hrs</button>
          ${revealAtMs ? '<button type="button" class="danger" data-reveal-action="clear">Clear timer</button>' : ''}
        </div>
      </div>
    `;
    }).join('');
  }
  // "Apply 48h... to every matchup without one" — the retroactive half of
  // making blind-voting the default: catches every matchup that predates
  // (or otherwise missed) whatever auto-applies revealAt at creation, in
  // one pass instead of clicking "Blind vote for 48 hrs" on each row by
  // hand. Straight sequential updateDoc calls rather than a writeBatch —
  // simpler, and fine at the matchup counts this app has today; would be
  // worth batching if that list ever gets into the hundreds.
  const bulkRevealBtn = document.getElementById('bulkRevealBtn');
  if (bulkRevealBtn) {
    bulkRevealBtn.addEventListener('click', async () => {
      const targets = adminAllMatchups.filter(m => !m.revealAt);
      if (!targets.length) { showToast('Every matchup already has a timer'); return; }
      bulkRevealBtn.disabled = true;
      bulkRevealBtn.textContent = `Applying to ${targets.length}…`;
      const revealAt = Timestamp.fromMillis(Date.now() + DEFAULT_REVEAL_HOURS * 3600000);
      let succeeded = 0;
      for (const m of targets) {
        try {
          await updateDoc(doc(db, 'matchups', m.docId), { revealAt });
          succeeded++;
        } catch (err) {
          console.error('Bulk reveal-timer apply failed for', m.docId, err);
        }
      }
      showToast(`Applied ${DEFAULT_REVEAL_HOURS}h timer to ${succeeded}/${targets.length} matchups`);
      bulkRevealBtn.disabled = false;
      bulkRevealBtn.textContent = 'Apply 48h blind timer to every matchup without one';
    });
  }
  // Was previously an unconditional collection-wide onSnapshot attached at
  // load time for every visitor — a second full read of 'matchups' on top
  // of the main feed listener below, doing a full array rebuild + filter
  // on every change even though renderMatchupCategoryList() immediately
  // bails out for non-admins. Now attached/detached alongside the other
  // admin-only listeners in refreshModerationListeners(), so it only ever
  // runs for the admin account.
  let unsubAdminMatchupCategories = null;
  function refreshAdminMatchupCategoryListener(){
    if (unsubAdminMatchupCategories) { unsubAdminMatchupCategories(); unsubAdminMatchupCategories = null; }
    if (!isAdmin()) { adminAllMatchups = []; renderMatchupCategoryList(); return; }
    unsubAdminMatchupCategories = onSnapshot(query(collection(db, 'matchups'), orderBy('createdAt', 'asc')), snapshot => {
      // Same expiresAt check the public feed uses (see resyncMatchupsForSeason)
      // — without it, expired matchups (invisible everywhere else, but never
      // actually deleted from Firestore — see the TTL note near expiresAt)
      // just sat here forever, piling up in Settings long after they'd
      // stopped being anything an admin needs to tag or manage.
      adminAllMatchups = snapshot.docs
        .filter(d => d.data().a && d.data().b)
        .filter(d => !(d.data().expiresAt && d.data().expiresAt.toMillis() < Date.now()))
        .map(d => ({ docId: d.id, a: d.data().a, b: d.data().b, category: d.data().category || null, revealAt: d.data().revealAt || null, resultsSettled: !!d.data().resultsSettled }));
      renderMatchupCategoryList();
    }, err => console.error('Admin matchup-category listener failed', err));
  }
  if (matchupCategoryList) {
    matchupCategoryList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-reveal-action]');
      if (!btn) return;
      const row = btn.closest('[data-matchup-id]');
      const matchupId = row?.dataset.matchupId;
      if (!matchupId) return;
      if (btn.dataset.revealAction === 'clear') {
        btn.disabled = true;
        updateDoc(doc(db, 'matchups', matchupId), { revealAt: deleteField() })
          .then(() => showToast('Reveal timer cleared — results visible again'))
          .catch(err => { console.error('Clear reveal timer failed', err); showToast('Could not clear timer — try again'); btn.disabled = false; });
        return;
      }
      const hoursInput = row.querySelector('[data-reveal-hours]');
      const hours = parseFloat(hoursInput?.value);
      if (!hours || hours <= 0) { showToast('Enter how many hours first'); return; }
      btn.disabled = true;
      updateDoc(doc(db, 'matchups', matchupId), { revealAt: Timestamp.fromMillis(Date.now() + hours * 3600000) })
        .then(() => showToast(`Blind voting for ${hours}h — results reveal then`))
        .catch(err => { console.error('Set reveal timer failed', err); showToast('Could not set timer — try again'); })
        .finally(() => { btn.disabled = false; });
    });
  }
  if (matchupCategoryList) {
    matchupCategoryList.addEventListener('change', (e) => {
      const select = e.target.closest('[data-category-select]');
      if (!select) return;
      const row = select.closest('[data-matchup-id]');
      const matchupId = row?.dataset.matchupId;
      if (!matchupId) return;
      const newCategory = select.value;
      select.disabled = true;
      updateDoc(doc(db, 'matchups', matchupId), newCategory ? { category: newCategory } : { category: deleteField() })
        .then(() => showToast(newCategory ? `Tagged as ${SEASONS[newCategory]?.label || newCategory}` : 'Untagged'))
        .catch(err => {
          console.error('Matchup category update failed', err);
          showToast('Could not update category — try again');
        })
        .finally(() => { select.disabled = false; });
    });
  }

  // No hardcoded seed matchups anymore — every matchup shown comes from
  // the 'matchups' Firestore collection via the onSnapshot listener below.
  // Starts empty; renderHero() and renderTrendScroll() both handle the
  // zero-matchups case until the first one streams in.
  const matchups = [];
  let activeIdx = 0;
  const VOTED_STATE_KEY = 'fictionClashVotedState';
  const VOTE_DELTA_KEY = 'fictionClashVoteDeltas'; // extra votes this browser cast on built-in (non-Firestore) matchups
  const HIDDEN_MATCHUPS_KEY = 'fictionClashHiddenMatchups'; // matchups this browser chose to hide from its own feed
  // ---------- per-account vote state ----------
  // votedState/voteDeltas used to live under one flat localStorage key
  // shared by the whole browser, with no account scoping — voting as one
  // account permanently marked a matchup "voted" for every other account
  // that ever signed into the same browser afterward, silently blocking
  // their vote (castVote() below just returns early on an already-"voted"
  // key). Scoped per uid now, same idea as how likes are already handled
  // per-account elsewhere in this file.
  function voteStorageUid(){ return (auth.currentUser && auth.currentUser.uid) || 'anon'; }
  function votedStateStorageKey(){ return `${VOTED_STATE_KEY}:${voteStorageUid()}`; }
  function voteDeltaStorageKey(){ return `${VOTE_DELTA_KEY}:${voteStorageUid()}`; }
  let votedState = {}; // matchupKey -> 'a' | 'b', for whichever account is currently active
  let voteDeltas = {}; // matchupKey -> {a:n,b:n}, for whichever account is currently active
  // Reloads both from this account's own scoped storage, seeding from the
  // old flat (pre-fix) key the first time a given scope is seen empty —
  // so upgrading doesn't just wipe today's session's vote history outright.
  // The old flat key is left in place rather than deleted, since it may
  // still hold state relevant to other accounts on this browser that
  // haven't been signed into (and thus migrated) yet.
  function loadScopedVoteState(){
    const votedKey = votedStateStorageKey();
    let votedRaw = localStorage.getItem(votedKey);
    if (votedRaw === null) {
      const legacy = localStorage.getItem(VOTED_STATE_KEY);
      if (legacy !== null) localStorage.setItem(votedKey, legacy);
      votedRaw = legacy;
    }
    const deltaKey = voteDeltaStorageKey();
    let deltaRaw = localStorage.getItem(deltaKey);
    if (deltaRaw === null) {
      const legacy = localStorage.getItem(VOTE_DELTA_KEY);
      if (legacy !== null) localStorage.setItem(deltaKey, legacy);
      deltaRaw = legacy;
    }
    votedState = JSON.parse(votedRaw || '{}');
    voteDeltas = JSON.parse(deltaRaw || '{}');
  }
  loadScopedVoteState(); // initial (signed-out/"anon") scope — onAuthStateChanged reloads this once the real account is known
  const hiddenMatchupKeys = new Set(JSON.parse(localStorage.getItem(HIDDEN_MATCHUPS_KEY) || '[]'));
  function hideMatchupLocally(m){
    hiddenMatchupKeys.add(matchupPairKey(m));
    localStorage.setItem(HIDDEN_MATCHUPS_KEY, JSON.stringify([...hiddenMatchupKeys]));
  }
  // Re-apply any votes this browser previously cast on the built-in matchups
  // (they have no Firestore doc to persist to, so localStorage is their
  // only record — otherwise a refresh would silently wipe them too).
  matchups.forEach(m => {
    const delta = voteDeltas[matchupPairKey(m)];
    if (delta) { m.votesA += delta.a || 0; m.votesB += delta.b || 0; }
  });
  // Drop any built-in matchups this browser chose to hide previously —
  // community matchups get the same treatment where they're fetched below.
  for (let i = matchups.length - 1; i >= 0; i--) {
    if (hiddenMatchupKeys.has(matchupPairKey(matchups[i]))) matchups.splice(i, 1);
  }

  // A character's "version" (e.g. Base, Ultra Instinct, Six Paths Sage Mode)
  // is kept separate from `name` on purpose: `name` stays the plain
  // character name so avatar lookups and stat lookups still match
  // correctly regardless of which version someone picked.
  function charLabel(char){
    return char.version ? `${char.name} (${char.version})` : char.name;
  }

  const heroAvatarA = document.getElementById('heroAvatarA');
  const heroAvatarB = document.getElementById('heroAvatarB');
  const heroAvatarReportA = document.getElementById('heroAvatarReportA');
  const heroAvatarReportB = document.getElementById('heroAvatarReportB');
  const heroNameA = document.getElementById('heroNameA');
  const heroNameB = document.getElementById('heroNameB');
  const heroSubA = document.getElementById('heroSubA');
  const heroSubB = document.getElementById('heroSubB');
  const heroVoteCount = document.getElementById('heroVoteCount');
  const voteRow = document.getElementById('voteRow');
  const voteBtnA = document.getElementById('voteBtnA');
  const voteBtnB = document.getElementById('voteBtnB');
  const voteBar = document.getElementById('voteBar');
  const votePctA = document.getElementById('votePctA');
  const votePctB = document.getElementById('votePctB');
  const voteRevealState = document.getElementById('voteRevealState');
  const aiStatsButton = document.getElementById('aiStatsButton');
  const aiStatsResult = document.getElementById('aiStatsResult');
  const aiStatsCreditsEl = document.getElementById('aiStatsCredits');

  // Same real-Gemini-call concern as Team Builder's AI feat check (see
  // AI_FEATS_CREDIT_LIMIT below), just for the hero "CHECK STATS" button —
  // capped at 5 PER ACCOUNT PER DAY. Tracked in Firestore (not local JS
  // state), so a refresh can't reset it: users/{uid}/statsCredits/{YYYY-MM-DD}
  // (UTC date), one doc per day. Firestore rules enforce the +1-per-write,
  // max-5 ceiling server-side — this client code is the UI, not the gate.
  const AI_STATS_CREDIT_LIMIT = 5;
  async function peekAiStatsCredits(){
    if (!auth.currentUser) return AI_STATS_CREDIT_LIMIT;
    try {
      const snap = await getDoc(doc(db, 'users', auth.currentUser.uid, 'statsCredits', todayKey()));
      const used = snap.exists() ? (snap.data().count || 0) : 0;
      return Math.max(0, AI_STATS_CREDIT_LIMIT - used);
    } catch (err) {
      console.error('Could not read AI stats credits', err);
      return AI_STATS_CREDIT_LIMIT; // fail open on read errors — the write-time check below is the real gate
    }
  }
  async function spendAiStatsCredit(){
    const ref = doc(db, 'users', auth.currentUser.uid, 'statsCredits', todayKey());
    try {
      const snap = await getDoc(ref);
      const used = snap.exists() ? (snap.data().count || 0) : 0;
      if (used >= AI_STATS_CREDIT_LIMIT) return false;
      if (snap.exists()) {
        await updateDoc(ref, { count: used + 1 });
      } else {
        await setDoc(ref, { count: 1 });
      }
      return true;
    } catch (err) {
      // Previously uncaught — a rules gap or any other write failure here
      // threw all the way up through the aiStatsButton click handler with
      // no toast and no console message from our own code, which is
      // exactly what made the credit-limit feature look like it broke
      // the whole "CHECK STATS" button. Surfacing this explicitly so a
      // future permissions issue is visible instead of a silent dead end.
      console.error('Could not spend AI stats credit', err);
      showToast('Could not verify AI stats usage — try again in a moment');
      return null; // distinct from false (limit reached) — caller shouldn't also show the "limit reached" toast on top of this one
    }
  }
  async function refreshAiStatsCreditsDisplay(){
    if (!aiStatsCreditsEl) return;
    if (!auth.currentUser) {
      aiStatsCreditsEl.textContent = `Sign in for AI stats`;
      aiStatsCreditsEl.classList.remove('exhausted');
      if (aiStatsButton) aiStatsButton.disabled = false; // let the click handler prompt sign-in rather than blocking here
      return;
    }
    const remaining = await peekAiStatsCredits();
    aiStatsCreditsEl.textContent = remaining > 0
      ? `${remaining}/${AI_STATS_CREDIT_LIMIT} today`
      : `Resets midnight UTC`;
    aiStatsCreditsEl.classList.toggle('exhausted', remaining <= 0);
  }
  const aiStatsProfiles = {
    'Gojo Satoru':[96,98,94,91], 'Saitama':[100,100,100,76],
    'Goku':[98,97,95,94], 'Vegeta':[97,96,93,90],
    'Naruto':[91,89,88,92], 'Sasuke Uchiha':[89,91,84,93],
    'Itachi Uchiha':[82,88,75,98], 'Kakashi Hatake':[78,85,74,94],
    'Monkey D. Luffy':[93,90,92,85], 'Roronoa Zoro':[90,86,85,83],
    'Ichigo Kurosaki':[92,90,87,86], 'Levi Ackerman':[79,94,73,91],
    'Eren Yeager':[90,80,89,80], 'All Might':[95,88,93,89],
    'Izuku Midoriya':[84,86,78,87], 'Light Yagami':[20,20,20,99],
    'Edward Elric':[76,74,72,90], 'Natsu Dragneel':[88,82,86,74],
    'Killua Zoldyck':[80,96,75,88], 'Gon Freecss':[85,88,80,76],
    'Meliodas':[97,93,96,85], 'Rimuru Tempest':[94,89,95,88],
    'Spider-Man':[85,90,80,89], 'Iron Man':[88,84,86,96],
    'Thor':[97,86,96,80], 'Hulk':[99,65,98,58],
    'Captain America':[83,80,85,92], 'Wolverine':[87,79,97,82],
    'Deadpool':[80,78,95,70], 'Thanos':[99,78,98,90],
    'Doctor Strange':[60,70,72,97], 'Scarlet Witch':[96,72,80,84],
    'Magneto':[85,65,78,93], 'Venom':[90,82,90,72],
    'Batman':[72,68,62,99], 'Superman':[99,97,99,86],
    'Wonder Woman':[93,85,90,88], 'The Flash':[70,100,75,80],
    'Joker':[40,45,50,92], 'Aquaman':[92,84,90,75],
    'Darkseid':[98,80,99,88], 'Green Lantern':[86,88,82,84],
    'Master Chief':[82,79,88,90], 'Kratos':[95,80,92,84],
    'Link':[80,83,78,85], 'Sephiroth':[93,95,88,91],
    'Dante':[86,90,84,80], 'Geralt of Rivia':[78,82,80,90],
    'Solid Snake':[68,75,72,95], 'Doom Slayer':[94,88,96,78],
    'John Wick':[69,82,70,95], 'Jack Sparrow':[52,60,58,86],
    'Neo':[89,93,85,87], 'Darth Vader':[91,78,90,89],
    'Yoda':[75,86,72,97], 'James Bond':[62,68,64,90],
    'The Terminator':[93,72,97,75], 'Ellen Ripley':[58,64,66,88],
    'Rocky Balboa':[80,62,88,79]
  };
  function avatarUrl(name, initials){
    const colors = ['#B4881F','#385C4B','#6B3F69','#315A78','#77552D','#514A7A'];
    const color = colors[name.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="60" fill="${color}"/><circle cx="60" cy="47" r="23" fill="#f1d2bc"/><path d="M24 111c4-26 18-39 36-39s32 13 36 39" fill="#171717"/><path d="M35 45c3-23 47-30 54 2-10-8-28-9-54-2z" fill="#171717"/><text x="60" y="105" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif" font-size="15" font-weight="700">${initials}</text></svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  }

  // Shrinks + re-encodes an image file into a small JPEG data URL, small
  // enough to store directly inside a Firestore document/field (no
  // Firebase Storage bucket required — works on the free Spark plan).
  function compressImageToDataUrl(file, maxDim = 220, quality = 0.72){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
          else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => reject(new Error('Could not decode image'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
  }

  // ---------- character avatars (upload-only, no external API) ----------
  // User-uploaded pictures for specific characters -- set via the camera
  // icon on the hero card. These are the ONLY source of a "real" photo;
  // there is no Wikipedia (or any other) lookup anymore. Anything without
  // an uploaded picture just uses the generated placeholder avatar.
  const CHARACTER_AVATARS_STORAGE_KEY = 'fictionClashCharacterAvatars';
  let characterAvatarOverrides = {};
  try { characterAvatarOverrides = JSON.parse(localStorage.getItem(CHARACTER_AVATARS_STORAGE_KEY) || '{}'); } catch (err) { characterAvatarOverrides = {}; }

  function avatarOverrideKey(name, version){
    return version ? `${name}|${version}` : name;
  }
  // Which avatar keys are currently hidden pending review (reportCount hit
  // the auto-hide threshold). Populated from Firestore alongside the
  // pictures themselves, so a flagged picture disappears everywhere at once.
  const AVATAR_REPORT_HIDE_THRESHOLD = 3;
  let hiddenAvatarKeys = {};
  function getCharacterAvatarOverride(name, version){
    const key = avatarOverrideKey(name, version);
    if (hiddenAvatarKeys[key]) return null;
    return characterAvatarOverrides[key] || null;
  }
  function persistCharacterAvatarOverridesLocally(){
    try { localStorage.setItem(CHARACTER_AVATARS_STORAGE_KEY, JSON.stringify(characterAvatarOverrides)); } catch (err) {}
  }
  // Re-paints every place a character photo can appear once new overrides
  // arrive from Firestore (hero card, trend scroll, leaderboard, team list).
  function refreshAllCharacterPhotos(){
    renderHero();
    if (typeof renderTrendScroll === 'function') renderTrendScroll();
    document.querySelectorAll('img[data-char-photo]').forEach(img => {
      const name = img.getAttribute('data-char-photo');
      const version = img.getAttribute('data-char-version') || undefined;
      const uploaded = getCharacterAvatarOverride(name, version);
      if (uploaded) img.src = uploaded;
    });
  }
  // Sets the override locally (instant paint) and saves a compressed copy
  // straight into Firestore (no Firebase Storage bucket needed — this
  // works on the free Spark plan) so every browser sees it. `file` is the
  // original File object; `dataUrl` is the uncompressed FileReader
  // preview shown immediately while compression runs in the background.
  function setCharacterAvatarOverride(name, version, dataUrl, file){
    const key = avatarOverrideKey(name, version);
    characterAvatarOverrides[key] = dataUrl;
    persistCharacterAvatarOverridesLocally();
    if (!file) return;
    compressImageToDataUrl(file)
      .then(compressed => setDoc(doc(db, 'characterAvatars', safeId(key)), {
        url: compressed, name, version: version || '', updatedAt: serverTimestamp(),
        // Who uploaded it + moderation state — the report/takedown system
        // below reads and writes these same fields.
        uploadedBy: (auth.currentUser && auth.currentUser.uid) || 'anonymous',
        reportCount: 0, hidden: false
      }))
      .catch(err => { console.error('Character avatar sync failed', err); showToast('Picture saved locally, but sync to other browsers failed'); });
  }

  // Real-time: any character picture uploaded from any browser lands here.
  // Also carries moderation state (reportCount/hidden) so a flagged picture
  // is hidden the same way on every device, not just the one that flagged it.
  onSnapshot(collection(db, 'characterAvatars'), snapshot => {
    let changed = false;
    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      const key = avatarOverrideKey(data.name, data.version);
      if (characterAvatarOverrides[key] !== data.url) {
        characterAvatarOverrides[key] = data.url;
        changed = true;
      }
      const shouldHide = !!data.hidden || (data.reportCount || 0) >= AVATAR_REPORT_HIDE_THRESHOLD;
      if (!!hiddenAvatarKeys[key] !== shouldHide) {
        if (shouldHide) hiddenAvatarKeys[key] = true; else delete hiddenAvatarKeys[key];
        changed = true;
      }
    });
    if (changed) {
      persistCharacterAvatarOverridesLocally();
      refreshAllCharacterPhotos();
    }
    renderAdminReports(snapshot);
  }, err => console.error('Character avatar listener failed', err));

  // Renders the uploaded picture if one exists for this character, or the
  // generated placeholder otherwise -- no network call either way.
  function setAvatarPhoto(el, name, initials, altSuffix, hint, version){
    const uploaded = getCharacterAvatarOverride(name, version);
    const src = uploaded || avatarUrl(name, initials);
    el.innerHTML = `<img src="${src}" alt="${name}${altSuffix || ''}">`;
  }

  // For photos rendered via innerHTML template strings (compare tool,
  // leaderboard, team list): mark the <img> with data-char-photo="Name"
  // and optionally data-char-version="Version", and call this after
  // inserting the HTML to upgrade placeholders to any uploaded picture.
  function hydrateCharacterPhotos(root){
    root.querySelectorAll('img[data-char-photo]').forEach(img => {
      const name = img.getAttribute('data-char-photo');
      const version = img.getAttribute('data-char-version') || undefined;
      const uploaded = getCharacterAvatarOverride(name, version);
      if (uploaded) img.src = uploaded;
    });
  }

  // Applies the CURRENT VIEWER's own equipped decoration/font to the two
  // matchup hero avatars and character names. This is a personal skin, not
  // a per-character one: character avatars are shared community pictures
  // (looked up by name+version via getCharacterAvatarOverride), so nobody
  // "owns" them the way an account owns its own avatar. Rather than writing
  // a decoration onto a character for everyone to see (which would need
  // ownership rules and moderation, same as the report button above already
  // has to handle for uploaded photos), this just re-skins how the CURRENT
  // signed-in user sees every character avatar, client-side only — nothing
  // is written to Firestore and nobody else's view changes.
  // Resolves which decoration id should show on one character avatar for
  // the current viewer: an explicit per-character choice (including an
  // explicit "none") wins; otherwise it falls back to whatever the viewer
  // has globally equipped on their profile.
  function resolveCharacterDecoration(name, version){
    const key = avatarOverrideKey(name, version);
    if (Object.prototype.hasOwnProperty.call(characterDecorations, key)) {
      const chosen = characterDecorations[key];
      return chosen === 'none' ? null : chosen;
    }
    return equippedDecoration;
  }

  function renderHeroCharacterCosmetics(){
    const m = matchups[activeIdx];
    applyDecorationToContainer(heroAvatarA, m ? resolveCharacterDecoration(m.a.name, m.a.version) : equippedDecoration);
    applyDecorationToContainer(heroAvatarB, m ? resolveCharacterDecoration(m.b.name, m.b.version) : equippedDecoration);
    const font = fontById(equippedFont);
    [heroNameA, heroNameB].forEach(el => {
      PROFILE_FONTS.forEach(f => el.classList.remove(f.cls));
      if (font) el.classList.add(font.cls);
    });
  }

  function renderHero(){
    const m = matchups[activeIdx];
    const heroCardWrapper = document.getElementById('heroCard');
    const heroSkeleton = document.getElementById('heroSkeleton');
    if (!m) {
      // No matchups yet (fresh install, or Firestore hasn't synced its
      // first one in) — hide the hero card and show its shimmering
      // skeleton instead of crashing on undefined character data.
      // renderHero() runs again automatically once a matchup streams in
      // (see the matchups onSnapshot handler).
      if (heroCardWrapper) heroCardWrapper.hidden = true;
      if (heroSkeleton) heroSkeleton.hidden = false;
      return;
    }
    if (heroCardWrapper) heroCardWrapper.hidden = false;
    if (heroSkeleton) heroSkeleton.hidden = true;
    setAvatarPhoto(heroAvatarA, m.a.name, m.a.initials, ' avatar', m.a.hint, m.a.version);
    setAvatarPhoto(heroAvatarB, m.b.name, m.b.initials, ' avatar', m.b.hint, m.b.version);
    renderHeroCharacterCosmetics();
    // Only user-uploaded pictures can be reported — no point flagging a
    // generated placeholder that isn't anyone's artwork.
    heroAvatarReportA.hidden = !getCharacterAvatarOverride(m.a.name, m.a.version);
    heroAvatarReportB.hidden = !getCharacterAvatarOverride(m.b.name, m.b.version);
    heroNameA.textContent = m.a.name.toUpperCase();
    heroNameB.textContent = m.b.name.toUpperCase();
    heroSubA.textContent = m.a.sub;
    heroSubB.textContent = m.b.sub;
    // If it's the same character in both slots (a version-vs-version grudge
    // match like Base Goku vs Ultra Instinct Goku), the vote buttons need
    // the version in the label too, or they'd read identically.
    const sameBase = m.a.name.toLowerCase() === m.b.name.toLowerCase();
    voteBtnA.textContent = (sameBase && m.a.version) ? `${m.a.name.split(' ')[0]} (${m.a.version})` : m.a.name.split(' ')[0];
    voteBtnB.textContent = (sameBase && m.b.version) ? `${m.b.name.split(' ')[0]} (${m.b.version})` : m.b.name.split(' ')[0];
    aiStatsResult.innerHTML = 'AI-powered strength, speed, durability &amp; battle IQ snapshot.';
    updatePercentages();
    const voted = votedState[votedStateKey(m)];
    voteRow.classList.toggle('voted', !!voted);
    voteBtnA.classList.toggle('picked', voted === 'a');
    voteBtnB.classList.toggle('picked', voted === 'b');
    renderHeroSocial();
  }

  // ---------- hero card like + share ----------
  // Wired once, outside renderHero, since renderHero runs on every
  // matchup switch — re-attaching a listener each time would stack up
  // duplicate handlers. heroLikeKey is updated by renderHeroSocial()
  // and read fresh by the click handler below via closure.
  const heroLikeBtn = document.getElementById('heroLikeBtn');
  const heroLikeCountEl = document.getElementById('heroLikeCount');
  const heroShareBtn = document.getElementById('heroShareBtn');
  let heroLikeKey = '';

  function renderHeroLikeButton(){
    heroLikeBtn.classList.toggle('liked', likedByCurrentUser(heroLikeKey));
    heroLikeCountEl.textContent = formatLikeCount(likeDisplayCount(heroLikeKey));
  }

  function renderHeroSocial(){
    const m = matchups[activeIdx];
    if (!m) return;
    heroLikeKey = 'matchup:' + matchupPairKey(m);
    // Seed a starting count from vote totals so a popular matchup doesn't
    // just show "0" before its like doc exists — this is cosmetic only,
    // it's never written to Firestore and never counts as a "like" from
    // any account.
    if (!(heroLikeKey in baseSeedCounts)) {
      baseSeedCounts[heroLikeKey] = Math.round((m.votesA + m.votesB) * 0.08);
    }
    likeRenderers[heroLikeKey] = renderHeroLikeButton;
    renderHeroLikeButton();
    // IMPORTANT: comments are keyed by the matchup's real Firestore doc id
    // (m.docId), NOT heroLikeKey — heroLikeKey is a composite
    // "matchup:<pairKey>" string used only for the separate likes/
    // subsystem. /api/comment looks the matchup up by doc(db,'matchups')
    // .doc(matchupId), so passing heroLikeKey there always 404'd
    // ("Matchup not found"), which is why comments were failing and
    // the +5 comment XP was never actually being awarded.
    wireHeroComments(m.docId || '');
  }

  heroLikeBtn.addEventListener('click', () => toggleLike(heroLikeKey));

  let heroCardBusy = false;
  heroShareBtn.addEventListener('click', async () => {
    const m = matchups[activeIdx];
    if (!m || heroCardBusy) return;
    heroCardBusy = true;
    const originalLabel = heroShareBtn.querySelector('span:last-child').textContent;
    heroShareBtn.querySelector('span:last-child').textContent = '…';
    try {
      const url = buildShareUrl('matchup', matchupPairKey(m));
      const canvas = await buildMatchupBattleCard(m, url);
      await shareOrDownloadCard(canvas, {
        filename: `fictionclash-${m.a.name}-vs-${m.b.name}.png`.toLowerCase().replace(/[^a-z0-9.]+/g, '-'),
        title: `${m.a.name} vs ${m.b.name} — Fiction Clash`,
        text: `Who actually wins: ${m.a.name} or ${m.b.name}? Cast your vote on Fiction Clash.`,
        url,
        onShared: () => awardShareXp('matchup', matchupPairKey(m))
      });
    } catch (err) {
      console.error('Battle card share failed', err);
      // Never leave the user with nothing to share — fall back to the
      // plain link if the canvas/image pipeline throws for any reason.
      shareLink({
        title: `${m.a.name} vs ${m.b.name} — Fiction Clash`,
        text: `Who actually wins: ${m.a.name} or ${m.b.name}? Cast your vote on Fiction Clash.`,
        url: buildShareUrl('matchup', matchupPairKey(m)),
        onShared: () => awardShareXp('matchup', matchupPairKey(m))
      });
    } finally {
      heroShareBtn.querySelector('span:last-child').textContent = originalLabel;
      heroCardBusy = false;
    }
  });

  // ---------- hero card comments ----------
  // Deliberately a FLAT top-level collection ('matchupComments' with a
  // matchupId field) instead of a subcollection nested under each matchup
  // doc. Matchups get cleared out periodically straight from the Firestore
  // console — a flat collection means that cleanup is one filtered
  // query (matchupId == ...) in the console, instead of having to open
  // each matchup doc individually to find and clear its own subcollection.
  // Comments left behind after a matchup is cleared are otherwise orphaned
  // data that still costs reads/storage even though nothing shows them.
  const heroCommentsList = document.getElementById('heroCommentsList');
  const heroCommentForm = document.getElementById('heroCommentForm');
  const heroCommentInput = document.getElementById('heroCommentInput');
  let heroCommentsUnsubscribe = null;
  let heroReactionsUnsubscribe = null;
  let heroCommentsMatchupId = '';
  // Only the last 2 comments render inline on the hero card — this object
  // is the "thread" handed to the shared see-all sheet (see
  // renderCommentsPreview / openCommentsModal below), which keeps the full
  // list and knows how to post back to /api/comment.
  const heroCommentsThread = { type: 'hero', commentsFor: '', label: 'All comments on this matchup.', docs: [], form: heroCommentForm };

  function wireHeroComments(matchupId){
    if (matchupId === heroCommentsMatchupId) return; // already watching this matchup — avoid re-subscribing
    if (heroCommentsUnsubscribe) { heroCommentsUnsubscribe(); heroCommentsUnsubscribe = null; }
    if (heroReactionsUnsubscribe) { heroReactionsUnsubscribe(); heroReactionsUnsubscribe = null; }
    heroCommentsMatchupId = matchupId;
    heroCommentsThread.commentsFor = matchupId;
    heroCommentsThread._reactions = null;
    // Genuinely a different thread (new matchup) — a full teardown is
    // correct here, unlike the snapshot-driven re-renders further down
    // (see reconcileKeyedList), but still needs to stop any running
    // particle-effect canvases before their elements go, and drop the
    // stale keyed-element map so the next renderCommentsPreview() call
    // for this list starts from a clean slate instead of holding
    // references to elements that no longer exist.
    deactivateCanvasFx(heroCommentsList);
    heroCommentsList.innerHTML = '';
    heroCommentsList._keyedEls = null;
    heroCommentsList.classList.remove('scrollable');
    if (!matchupId) return;
    // Deliberately NOT combining where() + orderBy() in the same query —
    // that combination requires a composite index to be created in the
    // Firestore console first, and without it Firestore just fails the
    // listener silently (comments post fine, but never render). Filtering
    // by matchupId alone needs no extra index; comments are re-sorted by
    // createdAt here instead, which is trivial for a single matchup's
    // comment count.
    heroCommentsUnsubscribe = onSnapshot(
      query(collection(db, 'matchupComments'), where('matchupId', '==', matchupId)),
      snapshot => {
        const docs = snapshot.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
        renderCommentsPreview(heroCommentsList, docs, heroCommentsThread);
      },
      err => {
        console.error('Matchup comments listener failed', err);
        showToast('Could not load comments — try again');
      }
    );
    heroReactionsUnsubscribe = watchReactionsFor(matchupId, heroCommentsThread, heroCommentsList);
  }

  // Shared by the hero card's own form and the "see all" sheet when it's
  // open on this matchup's thread.
  async function postHeroComment(text, sourceForm){
    const user = auth.currentUser;
    if (!user) { requireSignIn('Sign in to comment'); return; }
    // navigator.vibrate only fires within a live user-activation window —
    // by the time the awaited fetch below resolves that window has long
    // since expired, so a post-await haptic() call silently does nothing.
    // Firing it here, still inside the click handler's own synchronous
    // call stack, is the only place in this function guaranteed to work.
    haptic('tap');
    const matchupId = heroCommentsMatchupId;
    const replyTarget = sourceForm?._replyTarget || null;
    const stickerId = sourceForm?._attachedSticker || null;
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify({ matchupId, text, replyTo: replyTarget, stickerId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Comment failed');
      setReplyTarget(sourceForm, null);
      if (sourceForm) clearAttachedSticker(sourceForm);
      // Comments no longer award XP server-side — only bump locally if
      // the server actually sent xpAwarded (kept for forward-compat).
      if (data.xpAwarded) {
        currentUserXp += data.xpAwarded;
        currentUserWeeklyXp += data.xpAwarded;
        renderVerifiedProgress();
      }
      showXpToast(data.xpAwarded, data.rank);
    } catch (err) {
      console.error('Matchup comment post failed', err);
      showToast('Could not post comment — try again');
      throw err;
    }
  }

  heroCommentForm.addEventListener('submit', async event => {
    event.preventDefault();
    const text = heroCommentInput.value.trim();
    if (!text && !heroCommentForm._attachedSticker) return;
    heroCommentInput.value = '';
    postHeroComment(text, heroCommentForm).catch(() => { heroCommentInput.value = text; });
  });

  const heroDeleteBtn = document.getElementById('heroDeleteBtn');
  heroDeleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = activeIdx;
    const m = matchups[idx];
    if (!m || matchups.length <= 1) return; // keep at least one matchup visible
    if (isAdmin() && m.docId) {
      // Admin account, community matchup — this actually deletes the doc
      // from Firestore, so it disappears for every visitor, not just this browser.
      if (!confirm(`Delete ${m.a.name} vs ${m.b.name} for everyone? This can't be undone.`)) return;
      deleteDoc(doc(db, 'matchups', m.docId)).catch(err => {
        console.error('Delete failed', err);
        showToast('Could not delete — try again');
      });
      // The list/hero update themselves when the onSnapshot 'removed' event arrives.
      return;
    }
    if (isAdmin() && !m.docId) {
      // Admin account, built-in matchup — there's no Firestore doc to
      // delete (it's hardcoded in the app), so instead its key gets added
      // to the shared hiddenBuiltins doc. Every client, including this
      // one, is listening to that doc and will filter it out — a real
      // delete-for-everyone, not just a local hide.
      if (!confirm(`Remove ${m.a.name} vs ${m.b.name} for everyone? This is a built-in matchup, so it'll be hidden from all users everywhere, not just this device. This can't be undone.`)) return;
      setDoc(doc(db, 'appConfig', 'hiddenBuiltins'), { matchupKeys: arrayUnion(matchupPairKey(m)) }, { merge: true }).catch(err => {
        console.error('Global hide failed', err);
        showToast('Could not remove — try again');
      });
      // The list/hero update themselves once the hiddenBuiltins listener picks this up.
      return;
    }
    if (!confirm(`Hide ${m.a.name} vs ${m.b.name} from your feed? It'll stay visible to everyone else — you just won't see it on this device unless you clear your browser data.`)) return;
    // This only affects what renders on this browser — the Firestore doc
    // (if any) is never touched, so nothing changes for anyone else.
    hideMatchupLocally(m);
    matchups.splice(idx, 1);
    activeIdx = Math.min(idx, matchups.length - 1);
    renderTrendScroll();
    renderHero();
    showToast('Hidden from your feed');
  });


  // ---------- per-character decoration picker (personal skin, per matchup) ----------
  const heroDecorateBtn = document.getElementById('heroDecorateBtn');
  const heroDecorateOverlay = document.getElementById('heroDecorateOverlay');
  const heroDecorateClose = document.getElementById('heroDecorateClose');
  const heroDecorateNameA = document.getElementById('heroDecorateNameA');
  const heroDecorateNameB = document.getElementById('heroDecorateNameB');
  const heroDecorateGridA = document.getElementById('heroDecorateGridA');
  const heroDecorateGridB = document.getElementById('heroDecorateGridB');

  function heroDecorateSwatchInner(id){
    if (id === 'none') return '—';
    if (id === null) return '✦';
    return profileDecorationMarkup(id);
  }

  function renderHeroDecorateGrid(gridEl, name, version){
    const key = avatarOverrideKey(name, version);
    const current = Object.prototype.hasOwnProperty.call(characterDecorations, key) ? characterDecorations[key] : null;
    const options = [
      { id: null, label: 'Default' },
      { id: 'none', label: 'None' },
      ...unlockedDecorations.map(id => ({ id, label: decorationById(id)?.name || id }))
    ];
    gridEl.innerHTML = options.map(opt => `
      <div class="hero-decorate-item${current === opt.id ? ' selected' : ''}" data-deco-id="${opt.id === null ? '' : opt.id}">
        <div class="hero-decorate-swatch">${heroDecorateSwatchInner(opt.id)}</div>
        <div class="hero-decorate-label">${escapeHtml(opt.label)}</div>
      </div>`).join('')
      + (unlockedDecorations.length === 0 ? `<div class="hero-decorate-empty-hint">Redeem decorations in the Avatar Store to add more options here.</div>` : '');
    gridEl.querySelectorAll('[data-deco-id]').forEach(item => {
      item.addEventListener('click', () => {
        const raw = item.dataset.decoId;
        setCharacterDecoration(name, version, raw === '' ? null : raw);
      });
    });
  }

  async function setCharacterDecoration(name, version, decorationId){
    const user = auth.currentUser;
    if (!user) { requireSignIn('Sign in to customize character decorations'); return; }
    const key = avatarOverrideKey(name, version);
    const next = { ...characterDecorations };
    if (decorationId === null) delete next[key]; else next[key] = decorationId;
    try {
      await updateDoc(doc(db, 'users', user.uid), { characterDecorations: next });
      characterDecorations = next;
      renderHeroCharacterCosmetics();
      renderHeroDecorateGrid(heroDecorateGridA, matchups[activeIdx].a.name, matchups[activeIdx].a.version);
      renderHeroDecorateGrid(heroDecorateGridB, matchups[activeIdx].b.name, matchups[activeIdx].b.version);
    } catch (err) {
      console.error('Character decoration save failed', err);
      showToast('Could not save — try again');
    }
  }

  function openHeroDecorateModal(){
    if (!auth.currentUser) { requireSignIn('Sign in to customize character decorations'); return; }
    const m = matchups[activeIdx];
    if (!m) return;
    heroDecorateNameA.textContent = m.a.name;
    heroDecorateNameB.textContent = m.b.name;
    renderHeroDecorateGrid(heroDecorateGridA, m.a.name, m.a.version);
    renderHeroDecorateGrid(heroDecorateGridB, m.b.name, m.b.version);
    heroDecorateOverlay.classList.add('show');
  }
  heroDecorateBtn.addEventListener('click', (e) => { e.stopPropagation(); openHeroDecorateModal(); });
  heroDecorateClose.addEventListener('click', () => heroDecorateOverlay.classList.remove('show'));
  heroDecorateOverlay.addEventListener('click', (e) => { if (e.target === heroDecorateOverlay) heroDecorateOverlay.classList.remove('show'); });

  // ---------- per-character avatar upload ----------
  const heroAvatarEditA = document.getElementById('heroAvatarEditA');
  const heroAvatarEditB = document.getElementById('heroAvatarEditB');
  const charAvatarFile = document.getElementById('charAvatarFile');
  let pendingAvatarChar = null; // { name, version } — which character the next file picked applies to

  function openCharAvatarUpload(side){
    const m = matchups[activeIdx];
    if (!m) return;
    const char = side === 'a' ? m.a : m.b;
    pendingAvatarChar = { name: char.name, version: char.version };
    // Gate every upload behind the consent modal instead of opening the
    // file picker directly — this is what makes the checkbox agreement
    // active/per-upload rather than a passive footer link nobody reads.
    avatarConsentCheck.checked = false;
    avatarConsentOverlay.classList.add('show');
  }
  heroAvatarEditA.addEventListener('click', (e) => { e.stopPropagation(); openCharAvatarUpload('a'); });
  heroAvatarEditB.addEventListener('click', (e) => { e.stopPropagation(); openCharAvatarUpload('b'); });

  // ---------- upload consent modal ----------
  const avatarConsentOverlay = document.getElementById('avatarConsentOverlay');
  const avatarConsentCheck = document.getElementById('avatarConsentCheck');
  const avatarConsentSubmit = document.getElementById('avatarConsentSubmit');
  const avatarConsentCancel = document.getElementById('avatarConsentCancel');
  avatarConsentSubmit.addEventListener('click', () => {
    if (!avatarConsentCheck.checked) {
      showToast('Please confirm the box before uploading');
      return;
    }
    avatarConsentOverlay.classList.remove('show');
    charAvatarFile.click();
  });
  avatarConsentCancel.addEventListener('click', () => {
    avatarConsentOverlay.classList.remove('show');
    pendingAvatarChar = null;
  });
  avatarConsentOverlay.addEventListener('click', (e) => {
    if (e.target === avatarConsentOverlay) { avatarConsentOverlay.classList.remove('show'); pendingAvatarChar = null; }
  });

  // ---------- content policy modal ----------
  const contentPolicyOverlay = document.getElementById('contentPolicyOverlay');
  function openContentPolicy(){ contentPolicyOverlay.classList.add('show'); }
  document.getElementById('openContentPolicyBtn').addEventListener('click', openContentPolicy);
  document.getElementById('openPolicyFromConsent').addEventListener('click', (e) => { e.preventDefault(); openContentPolicy(); });
  document.getElementById('contentPolicyClose').addEventListener('click', () => contentPolicyOverlay.classList.remove('show'));
  contentPolicyOverlay.addEventListener('click', (e) => { if (e.target === contentPolicyOverlay) contentPolicyOverlay.classList.remove('show'); });

  // ---------- cookie policy modal + consent banner ----------
  const cookieBanner = document.getElementById('cookieBanner');
  const cookiePolicyOverlay = document.getElementById('cookiePolicyOverlay');
  const cookiePolicyStatus = document.getElementById('cookiePolicyStatus');
  function renderCookiePolicyStatus(){
    const c = getCookieConsent();
    cookiePolicyStatus.textContent = c === 'accepted'
      ? 'Your current choice: accepted all storage.'
      : c === 'rejected'
        ? 'Your current choice: essential storage only.'
        : "You haven't made a choice yet.";
  }
  function openCookiePolicy(){ renderCookiePolicyStatus(); cookiePolicyOverlay.classList.add('show'); }
  document.getElementById('openCookiePolicyBtn').addEventListener('click', openCookiePolicy);
  document.getElementById('cookieBannerPolicyLink').addEventListener('click', (e) => { e.preventDefault(); openCookiePolicy(); });
  document.getElementById('cookiePolicyClose').addEventListener('click', () => cookiePolicyOverlay.classList.remove('show'));
  cookiePolicyOverlay.addEventListener('click', (e) => { if (e.target === cookiePolicyOverlay) cookiePolicyOverlay.classList.remove('show'); });

  // ---------- open source licenses ----------
  // Same open/close pattern as the two policy modals above. The license
  // text itself is fetched once from a static file on the server (not
  // inlined into index.html — it's several thousand lines) and cached in
  // memory so re-opening this later in the same session doesn't re-fetch.
  const licensesOverlay = document.getElementById('licensesOverlay');
  const licensesText = document.getElementById('licensesText');
  let licensesLoaded = false;
  function openLicenses(){
    licensesOverlay.classList.add('show');
    if (licensesLoaded) return;
    fetch('/open-source-licenses.txt')
      .then(res => { if (!res.ok) throw new Error('Not found'); return res.text(); })
      .then(text => { licensesText.textContent = text; licensesLoaded = true; })
      .catch(err => {
        console.error('Licenses fetch failed', err);
        licensesText.textContent = "Couldn't load licenses right now — please try again.";
      });
  }
  document.getElementById('openLicensesBtn').addEventListener('click', openLicenses);
  document.getElementById('licensesClose').addEventListener('click', () => licensesOverlay.classList.remove('show'));
  licensesOverlay.addEventListener('click', (e) => { if (e.target === licensesOverlay) licensesOverlay.classList.remove('show'); });
  document.getElementById('cookieAcceptBtn').addEventListener('click', () => applyCookieConsentChoice('accepted'));
  document.getElementById('cookieRejectBtn').addEventListener('click', () => applyCookieConsentChoice('rejected'));
  document.getElementById('cookiePolicyAccept').addEventListener('click', () => applyCookieConsentChoice('accepted'));
  document.getElementById('cookiePolicyReject').addEventListener('click', () => applyCookieConsentChoice('rejected'));
  // Shown once per browser until a choice is made either way — same "never
  // block browsing" spirit as the first-visit intro overlay just below.
  if (!getCookieConsent()) cookieBanner.hidden = false;


  // ---------- report a picture ----------
  const reportAvatarOverlay = document.getElementById('reportAvatarOverlay');
  const reportReasonRow = document.getElementById('reportReasonRow');
  const reportAvatarSubmit = document.getElementById('reportAvatarSubmit');
  const reportAvatarClose = document.getElementById('reportAvatarClose');
  let pendingReportChar = null; // { name, version, key }
  let selectedReportReason = null;

  function openReportAvatar(side){
    const m = matchups[activeIdx];
    if (!m) return;
    const char = side === 'a' ? m.a : m.b;
    pendingReportChar = { name: char.name, version: char.version, key: avatarOverrideKey(char.name, char.version) };
    selectedReportReason = null;
    reportReasonRow.querySelectorAll('.report-reason-btn').forEach(btn => btn.classList.remove('selected'));
    document.getElementById('reportAvatarSub').textContent = `Reporting the picture for ${char.name}`;
    reportAvatarOverlay.classList.add('show');
  }
  heroAvatarReportA.addEventListener('click', (e) => { e.stopPropagation(); openReportAvatar('a'); });
  heroAvatarReportB.addEventListener('click', (e) => { e.stopPropagation(); openReportAvatar('b'); });

  reportReasonRow.addEventListener('click', (e) => {
    const btn = e.target.closest('.report-reason-btn');
    if (!btn) return;
    reportReasonRow.querySelectorAll('.report-reason-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedReportReason = btn.dataset.reason;
  });

  reportAvatarSubmit.addEventListener('click', () => {
    if (!pendingReportChar) return;
    if (!selectedReportReason) { showToast('Pick a reason first'); return; }
    const { name, version, key } = pendingReportChar;
    const avatarDocId = safeId(key);
    withSpinner(reportAvatarSubmit, 'SUBMIT REPORT', () => {
      // Log the report for the admin queue, and bump the counter on the
      // avatar doc itself — the onSnapshot listener above auto-hides it
      // everywhere once that counter crosses the threshold.
      return Promise.all([
        addDoc(collection(db, 'avatarReports'), {
          avatarKey: key, name, version: version || '', reason: selectedReportReason,
          reporterUid: (auth.currentUser && auth.currentUser.uid) || 'anonymous',
          createdAt: serverTimestamp()
        }),
        updateDoc(doc(db, 'characterAvatars', avatarDocId), { reportCount: increment(1) }).catch(() => {})
      ]).then(() => {
        reportAvatarOverlay.classList.remove('show');
        pendingReportChar = null;
        showToast('Thanks — we\'ll review this picture');
      }).catch(err => {
        console.error('Report failed', err);
        showToast('Could not submit the report — try again');
      });
    }, 0);
  });
  reportAvatarClose.addEventListener('click', () => { reportAvatarOverlay.classList.remove('show'); pendingReportChar = null; });
  reportAvatarOverlay.addEventListener('click', (e) => { if (e.target === reportAvatarOverlay) { reportAvatarOverlay.classList.remove('show'); pendingReportChar = null; } });

  // ---------- admin: review flagged pictures ----------
  const adminReportsCard = document.getElementById('adminReportsCard');
  const adminReportsList = document.getElementById('adminReportsList');
  function renderAdminReports(snapshot){
    if (!isAdmin()) { adminReportsCard.classList.add('hidden'); return; }
    const flagged = [];
    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      if ((data.reportCount || 0) > 0) flagged.push({ id: docSnap.id, ...data });
    });
    adminReportsCard.classList.toggle('hidden', flagged.length === 0);
    adminReportsList.innerHTML = flagged.map(item => `
      <div class="admin-report-row" data-doc-id="${item.id}">
        <img src="${item.url}" alt="${escapeHtml(item.name)}">
        <div class="admin-report-info">
          <b>${escapeHtml(item.name)}${item.version ? ` (${escapeHtml(item.version)})` : ''}</b>
          <span>${item.reportCount} report${item.reportCount === 1 ? '' : 's'}${item.hidden ? ' · hidden' : ''}</span>
        </div>
        <div class="admin-report-actions">
          <button data-action="dismiss">Dismiss</button>
          <button data-action="remove" class="danger">Remove</button>
        </div>
      </div>`).join('');
  }
  adminReportsList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const row = btn.closest('.admin-report-row');
    const docId = row.dataset.docId;
    if (btn.dataset.action === 'remove') {
      // Rights-holder-style takedown: delete the picture doc entirely so
      // it falls back to the placeholder avatar for everyone.
      deleteDoc(doc(db, 'characterAvatars', docId)).catch(err => console.error('Avatar removal failed', err));
    } else {
      // False alarm — clear the report count so it stops showing as flagged.
      updateDoc(doc(db, 'characterAvatars', docId), { reportCount: 0, hidden: false }).catch(err => console.error('Dismiss failed', err));
    }
  });

  // ---------- admin: review pending matchups & clips ----------
  const adminModerationCard = document.getElementById('adminModerationCard');
  const pendingMatchupsList = document.getElementById('pendingMatchupsList');
  const pendingClipsList = document.getElementById('pendingClipsList');
  function updateModerationCardVisibility(){
    adminModerationCard.classList.toggle('hidden', !isAdmin());
  }
  function renderPendingMatchups(snapshot){
    updateModerationCardVisibility();
    const rows = [];
    snapshot.forEach(docSnap => rows.push({ id: docSnap.id, ...docSnap.data() }));
    pendingMatchupsList.innerHTML = rows.length ? rows.map(item => `
      <div class="admin-report-row" data-doc-id="${item.id}" data-push-title="New matchup" data-push-body="${escapeHtml(item.a.name)} vs ${escapeHtml(item.b.name)}">
        <div class="admin-report-info">
          <b>${escapeHtml(charLabel(item.a))} vs ${escapeHtml(charLabel(item.b))}</b>
          <span>submitted by ${escapeHtml(item.submittedByName || 'unknown')}</span>
          <span>${item.category ? SEASONS[item.category]?.label || item.category : 'Untagged'}${item.category ? ' — the season live when this was submitted' : ' — no season was live at submission'}</span>
        </div>
        <div class="admin-report-actions">
          <!-- Defaults to whatever season was live at submission time (see
               the pendingMatchups write in the submit form) — an admin can
               still change it here before approving, so the matchup that
               actually goes live carries whichever season tag was chosen
               at approval time, not just whatever was auto-captured earlier. -->
          <select data-pending-category-select>
            <option value="">— Untagged —</option>
            ${Object.values(SEASONS).map(s => `<option value="${s.id}" ${item.category === s.id ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
          </select>
          <button data-action="reject" class="danger">Reject</button>
          <button data-action="approve">Approve</button>
        </div>
      </div>`).join('') : `<p style="font-size:11px;color:var(--muted);">Nothing pending.</p>`;
  }
  function renderPendingClips(snapshot){
    updateModerationCardVisibility();
    const rows = [];
    snapshot.forEach(docSnap => rows.push({ id: docSnap.id, ...docSnap.data() }));
    pendingClipsList.innerHTML = rows.length ? rows.map(item => `
      <div class="admin-report-row" data-doc-id="${item.id}" data-push-title="New clip posted" data-push-body="${escapeHtml(item.title || 'A new clip')}">
        <div class="admin-report-info">
          <b>${escapeHtml(item.title)}</b>
          <span>by ${escapeHtml(item.postedByName || 'unknown')} · ${escapeHtml(item.videoPlatform)}</span>
        </div>
        <div class="admin-report-actions">
          <button data-action="reject" class="danger">Reject</button>
          <button data-action="approve">Approve</button>
        </div>
      </div>`).join('') : `<p style="font-size:11px;color:var(--muted);">Nothing pending.</p>`;
  }
  // Approve/reject both go through /api/moderate (Admin SDK) rather than
  // touching Firestore directly — the client can't write to `matchups` or
  // `movieClips` at all anymore (see rules), and can't be trusted to
  // delete its own way out of the pending queue either, since anyone with
  // devtools open could otherwise "moderate" their own submission in.
  // `extra` carries fields that should ride along with the action itself
  // (right now: the chosen `category` on a matchup approval) rather than
  // being written to the pending doc directly beforehand.
  async function moderatePending(type, pendingId, action, btn, pushTitle, pushBody, extra){
    const user = auth.currentUser;
    if (!user) return;
    btn.disabled = true;
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/moderate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify({ type, pendingId, action, ...(extra || {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Moderation action failed');
      // The admin's own click is the one and only place a real device push
      // should fire for this matchup/clip — this runs once, right here,
      // never from the `matchups`/`movieClips` onSnapshot listeners (those
      // fire in every connected visitor's browser and only drive the
      // in-app bell via pushNotification()).
      if (action === 'approve' && pushTitle) sendOneSignalPush(pushTitle, pushBody);
    } catch (err) {
      console.error('Moderation action failed', err);
      showToast('Could not complete that action — try again');
      btn.disabled = false;
    }
  }
  pendingMatchupsList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const row = btn.closest('.admin-report-row');
    // Only meaningful for 'approve' — /api/moderate ignores it for 'reject',
    // but reading it here either way is harmless.
    const categorySelect = row.querySelector('[data-pending-category-select]');
    const category = categorySelect ? categorySelect.value : '';
    moderatePending('matchup', row.dataset.docId, btn.dataset.action, btn, row.dataset.pushTitle, row.dataset.pushBody, { category: category || null });
  });
  pendingClipsList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const row = btn.closest('.admin-report-row');
    moderatePending('clip', row.dataset.docId, btn.dataset.action, btn, row.dataset.pushTitle, row.dataset.pushBody);
  });
  let unsubPendingMatchups = null;
  let unsubPendingClips = null;
  // Only the admin account can ever read these collections (see rules) —
  // an unfiltered query from anyone else would get rejected outright,
  // since Firestore can't guarantee a per-document "is this my own
  // submission" rule holds across a whole collection listener. So these
  // listeners are only ever attached for the admin account, from
  // onAuthStateChanged below, and detached the moment that's no longer true.
  function refreshModerationListeners(){
    if (unsubPendingMatchups) { unsubPendingMatchups(); unsubPendingMatchups = null; }
    if (unsubPendingClips) { unsubPendingClips(); unsubPendingClips = null; }
    updateSeasonCardVisibility();
    if (typeof updateMatchupCategoryCardVisibility === 'function') updateMatchupCategoryCardVisibility();
    if (typeof refreshAdminMatchupCategoryListener === 'function') refreshAdminMatchupCategoryListener();
    if (!isAdmin()) { updateModerationCardVisibility(); return; }
    unsubPendingMatchups = onSnapshot(query(collection(db, 'pendingMatchups'), orderBy('createdAt', 'asc')), renderPendingMatchups, err => console.error('Pending matchups listener failed', err));
    unsubPendingClips = onSnapshot(query(collection(db, 'pendingClips'), orderBy('createdAt', 'asc')), renderPendingClips, err => console.error('Pending clips listener failed', err));
  }

  charAvatarFile.addEventListener('change', () => {
    const file = charAvatarFile.files[0];
    if (!file || !pendingAvatarChar) { charAvatarFile.value = ''; return; }
    if (!file.type.startsWith('image/')) {
      showToast('Please choose an image file');
      charAvatarFile.value = '';
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      showToast('Image must be under 4MB');
      charAvatarFile.value = '';
      return;
    }
    const { name, version } = pendingAvatarChar;
    const reader = new FileReader();
    reader.onload = () => {
      setCharacterAvatarOverride(name, version, reader.result, file);
      charAvatarFile.value = '';
      pendingAvatarChar = null;
      renderHero(); // picks up the new picture immediately for this matchup
      showToast(`Picture saved for ${name}`);
    };
    reader.onerror = () => {
      showToast('Could not read that image');
      charAvatarFile.value = '';
      pendingAvatarChar = null;
    };
    reader.readAsDataURL(file);
  });

  aiStatsButton.addEventListener('click', () => {
    if (!auth.currentUser) { showToast('Sign in to use AI stats'); return; }
    heroAnalyzing = true; // pause auto-rotate for as long as they're looking at this breakdown
    scheduleHeroRotate(); // clears the pending rotation (no-ops the reschedule, since heroAnalyzing is now true)
    withSpinner(aiStatsButton, 'THINKING…', async () => {
      const granted = await spendAiStatsCredit();
      if (granted === null) return; // error toast already shown by spendAiStatsCredit
      if (!granted) {
        showToast('Daily AI stats limit reached — resets at midnight UTC');
        refreshAiStatsCreditsDisplay();
        return;
      }
      const m = matchups[activeIdx];
      const labelA = charLabel(m.a);
      const labelB = charLabel(m.b);
      const data = await fetchCharacterAnalysis([labelA, labelB]);
      const entryA = data && data.characters && (data.characters[labelA] || data.characters[m.a.name]);
      const entryB = data && data.characters && (data.characters[labelB] || data.characters[m.b.name]);
      const statsA = entryA
        ? [clampStat(entryA.strength), clampStat(entryA.speed), clampStat(entryA.durability), clampStat(entryA.battleIQ)]
        : (aiStatsProfiles[m.a.name] || [70,70,70,70]);
      const statsB = entryB
        ? [clampStat(entryB.strength), clampStat(entryB.speed), clampStat(entryB.durability), clampStat(entryB.battleIQ)]
        : (aiStatsProfiles[m.b.name] || [70,70,70,70]);
      const labels = ['Strength', 'Speed', 'Durability', 'Battle IQ'];
      const bars = labels.map((label, index) => `
        <div class="ai-stat-row">
          <span>${label}</span>
          <div class="ai-stat-track">
            <div class="ai-stat-fill-a" style="width:${statsA[index]}%"></div>
            <div class="ai-stat-fill-b" style="width:${statsB[index]}%"></div>
          </div>
          <span>${statsA[index]} · ${statsB[index]}</span>
        </div>`).join('');
      const verdict = data && data.verdict
        ? escapeHtml(data.verdict)
        : (() => {
            const avgA = Math.round(statsA.reduce((sum, v) => sum + v, 0) / statsA.length);
            const avgB = Math.round(statsB.reduce((sum, v) => sum + v, 0) / statsB.length);
            return avgA === avgB ? 'This matchup is too close to call.' : `${avgA > avgB ? labelA : labelB} has the higher overall stat profile.`;
          })();
      const analysisA = entryA && entryA.analysis ? `<p><b>${escapeHtml(labelA)}:</b> ${escapeHtml(entryA.analysis)}</p>` : '';
      const analysisB = entryB && entryB.analysis ? `<p><b>${escapeHtml(labelB)}:</b> ${escapeHtml(entryB.analysis)}</p>` : '';
      aiStatsResult.innerHTML = `<strong>${escapeHtml(labelA)} vs ${escapeHtml(labelB)}</strong>${verdict}<div class="ai-stat-bars">${bars}</div>${analysisA}${analysisB}`;
      showToast(data ? 'AI stats generated' : 'AI unavailable — showing saved ratings');
      refreshAiStatsCreditsDisplay();
    });
  });

  // "2h 14m" / "45s" — coarse on purpose, this is a countdown label, not a
  // stopwatch; re-derived fresh every tick rather than cached anywhere.
  function formatRevealCountdown(msLeft){
    const totalSec = Math.max(0, Math.ceil(msLeft / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  // Any signed-in viewer's browser can be the one that "flips the switch"
  // once a matchup's reveal timer runs out — /api/settle-matchup is
  // idempotent (resultsSettled is claimed atomically server-side via a
  // transaction before any XP goes out), so it's safe to fire this from
  // whoever happens to load the matchup right after expiry rather than
  // needing a dedicated background job. The real tradeoff this accepts:
  // there's no queue/retry behind it, so if the payout loop itself times
  // out partway through a very large voter list, the remaining winners
  // silently don't get paid (resultsSettled is already true by then, to
  // guarantee nobody's ever paid twice) — fine at today's vote counts,
  // worth revisiting for a real job queue once matchups regularly pull
  // hundreds+ voters. See settle-matchup.js for the full reasoning.
  const settleAttempted = new Set();
  async function triggerSettleIfNeeded(m){
    if (!m.docId || !m.revealAt || m.resultsSettled) return;
    if (m.revealAt.toMillis() > Date.now()) return;
    if (settleAttempted.has(m.docId)) return;
    settleAttempted.add(m.docId);
    const user = auth.currentUser;
    if (!user) { settleAttempted.delete(m.docId); return; } // try again once signed in
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/settle-matchup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify({ matchupId: m.docId }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data) {
        m.resultsSettled = true;
        m.winningSide = data.winningSide;
        if (matchups[activeIdx] === m) updatePercentages();
        // Same in-app bell used for "new matchup"/"new clip" above — fires
        // once per client, whichever one happens to be the one that trips
        // the settle (see triggerSettleIfNeeded's callers/comment for why
        // this is lazy/client-triggered rather than a scheduled job).
        if (data.winningSide && data.winningSide !== 'tie') {
          const winnerName = (data.winningSide === 'a' ? m.a : m.b).name;
          const loserName = (data.winningSide === 'a' ? m.b : m.a).name;
          pushNotification('matchup', `${winnerName} wins!`, `${winnerName} beat ${loserName} — results are in`, m.docId);
        }
      }
    } catch (err) {
      console.error('Settle trigger failed', err);
      settleAttempted.delete(m.docId); // allow a retry on a later tick/view
    }
  }

  // A visible marker ON the winning avatar itself, not just the text line
  // below the bar — a glowing ring around the circle plus a small badge
  // that pops in once. Toggled every updatePercentages() call so it's
  // always in sync with the current matchup (setAvatarPhoto wipes the
  // avatar's innerHTML — badge included — on every matchup switch, so
  // there's nothing extra to clean up when moving off a settled one).
  function setHeroWinnerBadge(container, isWinner){
    container.classList.toggle('winner-ring', isWinner);
    const existing = container.querySelector('.hero-winner-badge');
    if (isWinner && !existing) {
      container.insertAdjacentHTML('beforeend', '<span class="hero-winner-badge">🏆 Winner</span>');
    } else if (!isWinner && existing) {
      existing.remove();
    }
  }

  function updatePercentages(){
    const m = matchups[activeIdx];
    const total = m.votesA + m.votesB;
    heroVoteCount.textContent = total.toLocaleString();
    const pctA = total === 0 ? 50 : Math.round((m.votesA / total) * 100);
    const pctB = 100 - pctA;
    voteBar.style.width = pctA + '%';
    votePctA.textContent = `${pctA}% ${m.a.name.split(' ')[0]}`;
    votePctB.textContent = `${pctB}% ${m.b.name.split(' ')[0]}`;

    // Blind voting: while revealAt is set and still in the future, hide
    // the live split entirely instead of just fuzzing it — showing a
    // rounded/delayed percentage is still information, and the entire
    // point of this mode is that nobody can see which side is ahead
    // until the timer's up. Voting itself stays open; only the numbers
    // are hidden (see vote.js for the matching server-side close-at-
    // revealAt check, which is the part that actually enforces this).
    const blind = !!(m.revealAt && m.revealAt.toMillis() > Date.now());
    voteBar.parentElement.hidden = blind;
    votePctA.parentElement.hidden = blind;
    if (blind) {
      voteRevealState.hidden = false;
      voteRevealState.classList.remove('winner');
      voteRevealState.innerHTML = `${REVEAL_LOCK_SVG}Results reveal in ${formatRevealCountdown(m.revealAt.toMillis() - Date.now())}`;
      setHeroWinnerBadge(heroAvatarA, false);
      setHeroWinnerBadge(heroAvatarB, false);
    } else if (m.revealAt && m.winningSide && m.winningSide !== 'tie') {
      // Just revealed (or was already settled the last time this matchup
      // loaded) — call out the winner for a beat rather than jumping
      // straight to a bare percentage bar with no context.
      const winnerName = (m.winningSide === 'a' ? m.a : m.b).name.split(' ')[0];
      voteRevealState.hidden = false;
      voteRevealState.classList.add('winner');
      voteRevealState.textContent = `🏆 ${winnerName} won — XP paid out to backers`;
      setHeroWinnerBadge(heroAvatarA, m.winningSide === 'a');
      setHeroWinnerBadge(heroAvatarB, m.winningSide === 'b');
    } else {
      voteRevealState.hidden = true;
      setHeroWinnerBadge(heroAvatarA, false);
      setHeroWinnerBadge(heroAvatarB, false);
    }
    if (m.revealAt && !blind) triggerSettleIfNeeded(m);
  }

  async function castVote(side){
    const m = matchups[activeIdx];
    const key = votedStateKey(m);
    if (votedState[key]) return; // already voted on this matchup
    haptic('tap');

    if (m.docId) {
      // Community matchup — server-authoritative vote via /api/vote.
      // The backend verifies the user's identity, blocks duplicate
      // votes, and is the only thing allowed to write votesA/votesB
      // in Firestore (see security rules), so we never trust a
      // client-side increment here.
      const user = auth.currentUser;
      if (!user) { showToast('Please sign in to vote'); return; }

      // Lock the UI immediately so a double-tap can't fire two requests
      // while we wait on the network.
      votedState[key] = side;
      localStorage.setItem(votedStateStorageKey(), JSON.stringify(votedState));
      voteRow.classList.add('voted');
      voteBtnA.classList.toggle('picked', side === 'a');
      voteBtnB.classList.toggle('picked', side === 'b');

      try {
        const idToken = await user.getIdToken();
        const res = await fetch('/api/vote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
          body: JSON.stringify({ matchupId: m.docId, choice: side }),
        });
        const data = await res.json();
        if (!res.ok) {
          // Rejected (already voted, clash ended, etc.) — undo the local lock.
          delete votedState[key];
          localStorage.setItem(votedStateStorageKey(), JSON.stringify(votedState));
          voteRow.classList.remove('voted');
          voteBtnA.classList.remove('picked');
          voteBtnB.classList.remove('picked');
          showToast(data.error || 'Vote failed, please try again');
          return;
        }
        m.votesA = data.votesA;
        m.votesB = data.votesB;
        // Voting itself no longer awards XP — win-only now, paid out
        // later by /api/settle-matchup once the reveal timer passes.
        // Only bump locally if the server actually sent xpAwarded.
        if (data.xpAwarded) {
          currentUserXp += data.xpAwarded;
          currentUserWeeklyXp += data.xpAwarded;
          renderVerifiedProgress();
        }
        showXpToast(data.xpAwarded, data.rank);
      } catch (err) {
        console.error('Vote sync failed', err);
        delete votedState[key];
        localStorage.setItem(votedStateStorageKey(), JSON.stringify(votedState));
        voteRow.classList.remove('voted');
        voteBtnA.classList.remove('picked');
        voteBtnB.classList.remove('picked');
        showToast('Vote failed, check your connection and try again');
        return;
      }
    } else {
      // Built-in matchup — no Firestore doc, so remember the extra vote
      // in this browser's localStorage or it'd be lost on refresh.
      if (side === 'a') m.votesA++; else m.votesB++;
      votedState[key] = side;
      localStorage.setItem(votedStateStorageKey(), JSON.stringify(votedState));
      const delta = voteDeltas[key] || { a: 0, b: 0 };
      delta[side]++;
      voteDeltas[key] = delta;
      localStorage.setItem(voteDeltaStorageKey(), JSON.stringify(voteDeltas));
      voteRow.classList.add('voted');
      voteBtnA.classList.toggle('picked', side === 'a');
      voteBtnB.classList.toggle('picked', side === 'b');
    }

    updatePercentages();
    const pickedName = side === 'a' ? m.a.name.split(' ')[0] : m.b.name.split(' ')[0];
    showToast(`Vote locked in for ${pickedName}`);
  }

  voteBtnA.addEventListener('click', () => castVote('a'));
  voteBtnB.addEventListener('click', () => castVote('b'));

  // ---------- quick action: vote now ----------
  document.getElementById('qaVote').addEventListener('click', () => {
    const heroGroup = document.getElementById('heroCard');
    heroGroup.scrollIntoView({ behavior:'smooth', block:'center' });
    // #heroCard is now a plain layout wrapper around three stacked cards
    // (matchup / stats / social+comments) rather than the visual card
    // itself — the pulse ring's box-shadow needs a border-radius'd
    // element to look right, so it targets the actual matchup card
    // (the first .hero child) instead of the wrapper.
    const pulseTarget = heroGroup.querySelector('.hero') || heroGroup;
    pulseTarget.classList.remove('pulse');
    void pulseTarget.offsetWidth; // restart animation if clicked again quickly
    pulseTarget.classList.add('pulse');
  });

  // ---------- quick action: compare characters ----------
  const compareOverlay = document.getElementById('compareOverlay');
  const compareCharA = document.getElementById('compareCharA');
  const compareCharB = document.getElementById('compareCharB');
  const compareSubmit = document.getElementById('compareSubmit');
  const compareResult = document.getElementById('compareResult');
  const compareClose = document.getElementById('compareClose');
  const rosterNames = Object.keys(aiStatsProfiles).sort();

  function initialsFor(name){
    return name.split(/\s+/).map(part => part[0]).join('').slice(0,2).toUpperCase();
  }

  document.getElementById('qaCompare').addEventListener('click', () => {
    compareCharA.value = '';
    compareCharB.value = '';
    compareResult.hidden = true;
    compareOverlay.classList.add('show');
  });
  compareClose.addEventListener('click', () => compareOverlay.classList.remove('show'));
  compareOverlay.addEventListener('click', event => {
    if (event.target === compareOverlay) compareOverlay.classList.remove('show');
  });

  compareSubmit.addEventListener('click', () => {
    const nameA = compareCharA.value.trim();
    const nameB = compareCharB.value.trim();
    if (!nameA || !nameB) {
      showToast('Enter both characters');
      return;
    }
    if (nameA.toLowerCase() === nameB.toLowerCase()) {
      showToast('Pick two different characters');
      return;
    }
    withSpinner(compareSubmit, 'COMPARING…', async () => {
      const data = await fetchCharacterAnalysis([nameA, nameB]);
      const entryA = data && data.characters && data.characters[nameA];
      const entryB = data && data.characters && data.characters[nameB];
      const statsA = entryA
        ? [clampStat(entryA.strength), clampStat(entryA.speed), clampStat(entryA.durability), clampStat(entryA.battleIQ)]
        : (aiStatsProfiles[nameA] || [70,70,70,70]);
      const statsB = entryB
        ? [clampStat(entryB.strength), clampStat(entryB.speed), clampStat(entryB.durability), clampStat(entryB.battleIQ)]
        : (aiStatsProfiles[nameB] || [70,70,70,70]);
      const labels = ['Strength', 'Speed', 'Durability', 'Battle IQ'];
      const bars = labels.map((label, i) => `
        <div class="ai-stat-row">
          <span>${label}</span>
          <div class="ai-stat-track">
            <div class="ai-stat-fill-a" style="width:${statsA[i]}%"></div>
            <div class="ai-stat-fill-b" style="width:${statsB[i]}%"></div>
          </div>
          <span>${statsA[i]} · ${statsB[i]}</span>
        </div>`).join('');
      let note;
      if (data && data.verdict) {
        note = escapeHtml(data.verdict);
      } else {
        const avgA = Math.round(statsA.reduce((sum, v) => sum + v, 0) / statsA.length);
        const avgB = Math.round(statsB.reduce((sum, v) => sum + v, 0) / statsB.length);
        const verdict = avgA === avgB ? 'This one is too close to call.' : `${avgA > avgB ? nameA : nameB} has the higher overall stat profile.`;
        const knownA = Object.prototype.hasOwnProperty.call(aiStatsProfiles, nameA);
        const knownB = Object.prototype.hasOwnProperty.call(aiStatsProfiles, nameB);
        note = knownA && knownB
          ? `${verdict} AI ratings are unavailable right now — showing saved baseline ratings instead.`
          : `AI ratings are unavailable right now, and there's no saved profile yet for ${[!knownA ? nameA : null, !knownB ? nameB : null].filter(Boolean).join(' and ')} — showing a flat baseline. Try again in a moment.`;
      }
      const analysisA = entryA && entryA.analysis ? `<p><b>${escapeHtml(nameA)}:</b> ${escapeHtml(entryA.analysis)}</p>` : '';
      const analysisB = entryB && entryB.analysis ? `<p><b>${escapeHtml(nameB)}:</b> ${escapeHtml(entryB.analysis)}</p>` : '';
      compareResult.hidden = false;
      compareResult.innerHTML = `
        <div class="compare-heads">
          <div class="compare-head"><img data-char-photo="${escapeHtml(nameA)}" src="${avatarUrl(nameA, initialsFor(nameA))}" alt=""><span>${escapeHtml(nameA)}</span></div>
          <div class="compare-head"><img data-char-photo="${escapeHtml(nameB)}" src="${avatarUrl(nameB, initialsFor(nameB))}" alt=""><span>${escapeHtml(nameB)}</span></div>
        </div>
        <div class="ai-stat-bars">${bars}</div>
        <div class="compare-verdict">${note}</div>${analysisA}${analysisB}`;
      hydrateCharacterPhotos(compareResult);
    }, 300);
  });

  // ---------- quick action: clash leaderboard ----------
  const leaderboardOverlay = document.getElementById('leaderboardOverlay');
  const leaderboardList = document.getElementById('leaderboardList');
  const leaderboardClose = document.getElementById('leaderboardClose');
  const yourRankCard = document.getElementById('yourRankCard');
  const yourRankNum = document.getElementById('yourRankNum');
  const yourRankName = document.getElementById('yourRankName');
  const yourRankXp = document.getElementById('yourRankXp');
  const yourRankGap = document.getElementById('yourRankGap');
  const leaderboardTabWeekly = document.getElementById('leaderboardTabWeekly');
  const leaderboardTabAllTime = document.getElementById('leaderboardTabAllTime');
  const leaderboardTabSeason = document.getElementById('leaderboardTabSeason');
  let activeLeaderboardField = 'weeklyXp'; // 'weeklyXp' (resets every Monday, see /api/reset-weekly-xp), 'xp' (lifetime), or 'seasonShards' (active season only)

  // Display unit for a leaderboard field — everything's "XP" except the
  // season currency, which shows its own season-specific label.
  function leaderboardUnitLabel(field){
    if (field === 'seasonShards') return (activeSeasonId && SEASONS[activeSeasonId]?.currencyLabel) || 'Shards';
    return 'XP';
  }

  // The 'seasonShards' tab is displayed generically, but the real
  // Firestore field is namespaced per season (seasonShards.<id> — see
  // api/lib/xp.js), so queries/reads need the resolved path, not the
  // bare tab name. Falls back to the bare field for xp/weeklyXp.
  function leaderboardQueryField(field){
    return field === 'seasonShards' && activeSeasonId ? `seasonShards.${activeSeasonId}` : field;
  }

  // Top players by the given field — `xp` (lifetime, awarded server-side
  // via /api/vote, /api/comment, /api/like, /api/clip-comment) or
  // `weeklyXp` (same awards, zeroed out every Monday). Firestore rules
  // make users/{uid} publicly readable, so a straight orderBy desc query
  // works without any extra grants.
  async function fetchTopUsers(field){
    const queryField = leaderboardQueryField(field);
    const snap = await getDocs(
      query(collection(db, 'users'), orderBy(queryField, 'desc'), limit(50))
    );
    return snap.docs
      .map(d => ({ uid: d.id, ...d.data() }))
      .filter(u => (fieldPath(u, queryField) || 0) > 0);
  }

  // Renders the "Your Rank" card at the top of the sheet. If the signed-in
  // user is inside the fetched top 50 their position/value comes straight
  // from that list; otherwise a single count query finds their real rank
  // without having to fetch the whole collection. Also shows how much XP
  // separates them from breaking into the top 10 (or from #1, if they're
  // already there) — the "+45 XP to reach #10" hook.
  async function renderYourRank(field, ranked){
    const user = auth.currentUser;
    if (!user) { yourRankCard.classList.add('hidden'); return; }

    const queryField = leaderboardQueryField(field);
    const myValue = field === 'xp' ? currentUserXp : field === 'seasonShards' ? seasonShards : currentUserWeeklyXp;
    let rank;
    const idx = ranked.findIndex(u => u.uid === user.uid);
    if (idx !== -1) {
      rank = idx + 1;
    } else if (myValue > 0) {
      try {
        const aggSnap = await getCountFromServer(query(collection(db, 'users'), where(queryField, '>', myValue)));
        rank = aggSnap.data().count + 1;
      } catch (err) {
        console.error('Your-rank lookup failed', err);
        yourRankCard.classList.add('hidden');
        return;
      }
    } else {
      // No XP of this kind yet — nothing to rank.
      yourRankCard.classList.add('hidden');
      return;
    }

    const identity = currentUserIdentity();
    yourRankCard.classList.remove('hidden');
    yourRankNum.textContent = `#${rank}`;
    yourRankName.textContent = (identity && identity.name) || 'You';
    yourRankXp.textContent = `${myValue.toLocaleString()} ${leaderboardUnitLabel(field)}`;

    if (rank <= 1) {
      yourRankGap.textContent = "You're #1!";
    } else if (rank <= 10) {
      const topValue = ranked[0] ? (fieldPath(ranked[0], queryField) || 0) : myValue;
      const gap = topValue - myValue;
      yourRankGap.textContent = gap > 0 ? `+${gap.toLocaleString()} ${leaderboardUnitLabel(field)} to reach #1` : '';
    } else if (ranked[9]) {
      const gap = (fieldPath(ranked[9], queryField) || 0) - myValue + 1;
      yourRankGap.textContent = gap > 0 ? `+${gap.toLocaleString()} ${leaderboardUnitLabel(field)} to reach #10` : '';
    } else {
      yourRankGap.textContent = '';
    }
  }

  async function renderLeaderboard(){
    const field = activeLeaderboardField;
    let ranked;
    try {
      ranked = await fetchTopUsers(field);
    } catch (err) {
      console.error('Leaderboard fetch failed:', err);
      leaderboardList.innerHTML = `<div class="leaderboard-loading">Couldn't load the leaderboard — try again in a moment.</div>`;
      yourRankCard.classList.add('hidden');
      return;
    }

    renderYourRank(field, ranked);

    if (!ranked.length) {
      leaderboardList.innerHTML = `<div class="leaderboard-loading">No ranked players yet — be the first to earn XP!</div>`;
      return;
    }

    const medals = ['🥇','🥈','🥉'];
    leaderboardList.innerHTML = ranked.map((entry, index) => `
      <div class="leaderboard-row ${index < 3 ? 'top' + (index + 1) : ''}">
        <div class="leaderboard-rank">${medals[index] || (index + 1)}</div>
        <div class="leaderboard-avatar" data-uid="${escapeHtml(entry.uid)}" data-name="${escapeHtml(entry.name || '')}" data-avatar="${escapeHtml(entry.avatarUrl || '')}">${commentAvatarHtml(entry.name || 'User', entry.avatarUrl)}</div>
        <div class="leaderboard-info">
          <div class="leaderboard-name">${escapeHtml(entry.name || 'User')}<span class="verified-badge" title="Verified" style="display:none;">${VERIFIED_BADGE_SVG}</span></div>
        </div>
        <div class="leaderboard-votes">${(fieldPath(entry, leaderboardQueryField(field)) || 0).toLocaleString()}<br>${leaderboardUnitLabel(field).toLowerCase()}</div>
      </div>`).join('');

    leaderboardList.querySelectorAll('.leaderboard-row').forEach((row, index) => {
      const entry = ranked[index];
      attachVerifiedBadge(row.querySelector('.verified-badge'), entry.uid);
      attachDecoration(row.querySelector('.leaderboard-avatar'), entry.uid);
    });
  }

  function switchLeaderboardTab(field){
    if (field === activeLeaderboardField) return;
    activeLeaderboardField = field;
    leaderboardTabWeekly.classList.toggle('active', field === 'weeklyXp');
    leaderboardTabAllTime.classList.toggle('active', field === 'xp');
    leaderboardTabSeason.classList.toggle('active', field === 'seasonShards');
    leaderboardList.innerHTML = `<div class="leaderboard-loading"><span class="btn-spinner" style="border-color:var(--line);border-top-color:var(--accent);"></span>Loading rankings…</div>`;
    renderLeaderboard();
  }
  leaderboardTabWeekly.addEventListener('click', () => switchLeaderboardTab('weeklyXp'));
  leaderboardTabAllTime.addEventListener('click', () => switchLeaderboardTab('xp'));
  leaderboardTabSeason.addEventListener('click', () => switchLeaderboardTab('seasonShards'));

  // While a season is live, the leaderboard becomes season-only: Weekly/
  // All Time hide, the Season tab (labeled with the season's own name)
  // takes over and becomes the active view. When the season ends, it
  // reverts to the normal Weekly/All Time leaderboard. Called from
  // applySeason() so this stays in sync with the live admin toggle.
  function updateLeaderboardSeasonAvailability(){
    const season = activeSeasonId ? SEASONS[activeSeasonId] : null;
    leaderboardTabSeason.classList.toggle('hidden', !season);
    leaderboardTabWeekly.classList.toggle('hidden', !!season);
    leaderboardTabAllTime.classList.toggle('hidden', !!season);
    if (season) {
      leaderboardTabSeason.textContent = season.label.toUpperCase();
      if (activeLeaderboardField !== 'seasonShards') {
        activeLeaderboardField = 'seasonShards';
        leaderboardTabSeason.classList.add('active');
        leaderboardTabWeekly.classList.remove('active');
        leaderboardTabAllTime.classList.remove('active');
        if (leaderboardOverlay.classList.contains('show')) renderLeaderboard();
      }
    } else if (activeLeaderboardField === 'seasonShards') {
      activeLeaderboardField = 'weeklyXp';
      leaderboardTabWeekly.classList.add('active');
      leaderboardTabSeason.classList.remove('active');
      if (leaderboardOverlay.classList.contains('show')) renderLeaderboard();
    }
  }

  document.getElementById('qaLeaderboard').addEventListener('click', () => {
    leaderboardOverlay.classList.add('show');
    leaderboardList.innerHTML = `<div class="leaderboard-loading"><span class="btn-spinner" style="border-color:var(--line);border-top-color:var(--accent);"></span>Loading rankings…</div>`;
    renderLeaderboard();
  });
  leaderboardClose.addEventListener('click', () => leaderboardOverlay.classList.remove('show'));
  leaderboardOverlay.addEventListener('click', event => {
    if (event.target === leaderboardOverlay) leaderboardOverlay.classList.remove('show');
  });

  // ---------- quick action: submit a matchup ----------
  const submitOverlay = document.getElementById('submitOverlay');
  const submitCharA = document.getElementById('submitCharA');
  const submitCharB = document.getElementById('submitCharB');
  const submitSourceA = document.getElementById('submitSourceA');
  const submitSourceB = document.getElementById('submitSourceB');
  const submitVersionA = document.getElementById('submitVersionA');
  const submitVersionB = document.getElementById('submitVersionB');
  const submitMatchupBtn = document.getElementById('submitMatchupBtn');
  const characterSuggestions = document.getElementById('characterSuggestions');
  const submitAvatarFileA = document.getElementById('submitAvatarFileA');
  const submitAvatarFileB = document.getElementById('submitAvatarFileB');
  const submitAvatarPreviewA = document.getElementById('submitAvatarPreviewA');
  const submitAvatarPreviewB = document.getElementById('submitAvatarPreviewB');
  let pendingSubmitAvatarA = null; // { file, dataUrl } | null
  let pendingSubmitAvatarB = null;

  // Wires a submit-modal photo picker to a { file, dataUrl } holder and its preview thumbnail.
  function wireSubmitAvatarPicker(fileInput, previewEl, setPending){
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        showToast('Please choose an image file');
        fileInput.value = '';
        return;
      }
      if (file.size > 4 * 1024 * 1024) {
        showToast('Image must be under 4MB');
        fileInput.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setPending({ file, dataUrl: reader.result });
        previewEl.innerHTML = `<img src="${reader.result}" alt="">`;
      };
      reader.onerror = () => showToast('Could not read that image');
      reader.readAsDataURL(file);
    });
  }
  wireSubmitAvatarPicker(submitAvatarFileA, submitAvatarPreviewA, val => { pendingSubmitAvatarA = val; });
  wireSubmitAvatarPicker(submitAvatarFileB, submitAvatarPreviewB, val => { pendingSubmitAvatarB = val; });

  function refreshCharacterSuggestions(){
    const names = new Set(rosterNames);
    matchups.forEach(m => { names.add(m.a.name); names.add(m.b.name); });
    characterSuggestions.innerHTML = [...names].sort().map(name => `<option value="${escapeHtml(name)}"></option>`).join('');
  }
  refreshCharacterSuggestions();

  document.getElementById('submitMatchupLink').addEventListener('click', () => {
    submitCharA.value = '';
    submitCharB.value = '';
    submitSourceA.value = '';
    submitSourceB.value = '';
    submitVersionA.value = '';
    submitVersionB.value = '';
    submitAvatarFileA.value = '';
    submitAvatarFileB.value = '';
    pendingSubmitAvatarA = null;
    pendingSubmitAvatarB = null;
    submitAvatarPreviewA.innerHTML = '＋ Photo';
    submitAvatarPreviewB.innerHTML = '＋ Photo';
    refreshCharacterSuggestions();
    submitOverlay.classList.add('show');
  });
  document.getElementById('submitClose').addEventListener('click', () => submitOverlay.classList.remove('show'));
  submitOverlay.addEventListener('click', event => {
    if (event.target === submitOverlay) submitOverlay.classList.remove('show');
  });

  submitMatchupBtn.addEventListener('click', () => {
    const nameA = submitCharA.value.trim();
    const nameB = submitCharB.value.trim();
    const sourceA = submitSourceA.value.trim();
    const sourceB = submitSourceB.value.trim();
    const versionA = submitVersionA.value.trim();
    const versionB = submitVersionB.value.trim();
    if (!nameA || !nameB) {
      showToast('Enter both characters');
      return;
    }
    // Same character is allowed if the versions differ (Base Goku vs Ultra
    // Instinct Goku is a legit matchup) — only block a true exact duplicate.
    if (nameA.toLowerCase() === nameB.toLowerCase() && versionA.toLowerCase() === versionB.toLowerCase()) {
      showToast(versionA ? 'Pick two different versions' : 'Pick two different characters, or add a version');
      return;
    }
    const keyA = `${nameA.toLowerCase()}|${versionA.toLowerCase()}`;
    const keyB = `${nameB.toLowerCase()}|${versionB.toLowerCase()}`;
    const duplicate = matchups.some(m => {
      const mKeyA = `${m.a.name.toLowerCase()}|${(m.a.version || '').toLowerCase()}`;
      const mKeyB = `${m.b.name.toLowerCase()}|${(m.b.version || '').toLowerCase()}`;
      return (mKeyA === keyA && mKeyB === keyB) || (mKeyA === keyB && mKeyB === keyA);
    });
    if (duplicate) {
      showToast('That matchup already exists — vote on it below');
      submitOverlay.classList.remove('show');
      return;
    }
    withSpinner(submitMatchupBtn, 'SUBMITTING…', () => {
      // `sourceA`/`sourceB` (an optional franchise/source label like
      // "Marvel" or "DC") is purely a display detail now — it's combined
      // with the version into `sub`, shown under the character's name.
      // It no longer feeds any lookup since avatars are upload-only.
      const subA = [versionA, sourceA].filter(Boolean).join(' · ') || 'Fan Submission';
      const subB = [versionB, sourceB].filter(Boolean).join(' · ') || 'Fan Submission';
      const identity = currentUserIdentity();
      if (!identity) { requireSignIn('Sign in to submit a matchup'); return; }
      const newMatchup = {
        a: { name: nameA, version: versionA, sub: subA, initials: initialsFor(nameA) },
        b: { name: nameB, version: versionB, sub: subB, initials: initialsFor(nameB) },
        votesA: 0, votesB: 0, community: true,
        submittedBy: identity.uid, submittedByName: identity.name,
        // Auto-scope the submission to whatever season (if any) is live
        // right now, so an approved matchup lands already tagged instead
        // of defaulting to untagged — which, now that untagged matchups
        // are hidden while any season is live (see isOutOfSeason above),
        // would otherwise mean it's invisible until an admin manually
        // tags it from Settings. An admin can still retag or clear this
        // from the Matchup categories list after approval.
        ...(activeSeasonId ? { category: activeSeasonId } : {}),
      };
      // Apply any photos picked in the submit form the same way the
      // hero-card camera icon does — instant local paint, then a
      // compressed copy synced to Firestore so it shows up everywhere.
      // Avatars are shown regardless of moderation status since they're a
      // shared per-character resource, not tied to this specific matchup.
      if (pendingSubmitAvatarA) setCharacterAvatarOverride(nameA, versionA, pendingSubmitAvatarA.dataUrl, pendingSubmitAvatarA.file);
      if (pendingSubmitAvatarB) setCharacterAvatarOverride(nameB, versionB, pendingSubmitAvatarB.dataUrl, pendingSubmitAvatarB.file);
      submitOverlay.classList.remove('show');
      // Goes to a review queue, not straight onto the public matchups list
      // (that collection now rejects direct client writes — see rules).
      // An admin approves/rejects from the moderation panel in Account,
      // which is what actually creates the live "matchups" doc.
      addDoc(collection(db, 'pendingMatchups'), {
        ...newMatchup,
        createdAt: serverTimestamp()
      })
        .then(() => showToast(`${charLabel(newMatchup.a)} vs ${charLabel(newMatchup.b)} submitted — pending review`))
        .catch(err => { console.error('Matchup submission failed', err); showToast('Could not submit that matchup — try again'); });
    }, 700);
  });

  // Same "same characters + same versions, either order" key used by the
  // duplicate check above, reused so the Firestore listener never adds a
  // matchup that's already in `matchups` (including the one we just
  // optimistically pushed ourselves).
  function matchupPairKey(m){
    const keyA = `${m.a.name.toLowerCase()}|${(m.a.version || '').toLowerCase()}`;
    const keyB = `${m.b.name.toLowerCase()}|${(m.b.version || '').toLowerCase()}`;
    return [keyA, keyB].sort().join('~');
  }

  // Voting is remembered per matchup DOCUMENT, not per character pairing.
  // A built-in matchup has no docId, so it still falls back to the
  // pairKey — but any community matchup uses its docId instead. This
  // matters because an admin can delete a community matchup and later
  // get a fresh one approved with the exact same character pairing;
  // without this, every browser that had already voted on the deleted
  // matchup would find its old pairKey-keyed "already voted" entry still
  // sitting in localStorage and be silently locked out of voting on the
  // brand-new doc forever — castVote() returns before ever calling
  // /api/vote, so no error shows, it just looks like voting is broken.
  function votedStateKey(m){
    return m.docId ? `id:${m.docId}` : `key:${matchupPairKey(m)}`;
  }

  // Real-time: community matchups submitted from any browser land here,
  // and disappear for everyone the moment anyone deletes them.
  let matchupsSynced = false; // true once the initial replay-everything snapshot has finished
  const trendLoadingMore = document.getElementById('trendLoadingMore');
  trendLoadingMore.classList.add('show'); // visible until the first snapshot resolves, however fast that is
  // Rebuilds `matchups` from a fresh Firestore read, applying the current
  // season filter to every doc — not just newly-arrived ones. Called from
  // applySeason() whenever the active season actually changes, so a live
  // toggle (or a page load that resolves the season after matchups have
  // already streamed in) doesn't leave stale out-of-season matchups sitting
  // in the array, or miss ones that should now be visible.
  // Season-exclusive visibility rule (single source of truth — see the
  // three call sites below). The old inline check here was
  // `data.category && data.category !== activeSeasonId`, which only ever
  // hides a matchup tagged for a DIFFERENT season — an untagged matchup
  // (falsy category) short-circuits that check and shows unconditionally,
  // in every season AND on the default/no-season site. That contradicted
  // the Settings copy ("Untagged matchups are hidden while any season is
  // live" — see #adminMatchupCategoryCard in index.html) and is why fresh,
  // not-yet-tagged matchups were showing up everywhere instead of staying
  // scoped to whichever season they belong to.
  // Correct rule, both directions:
  //  - A season IS live: show only matchups tagged for THAT season.
  //    Untagged and other-season matchups are both hidden.
  //  - NO season is live: show only untagged matchups. Season-tagged
  //    matchups stay exclusive to their own season and hide otherwise.
  function isOutOfSeason(category){
    return activeSeasonId ? category !== activeSeasonId : !!category;
  }

  async function resyncMatchupsForSeason(){
    let snap;
    try {
      snap = await getDocs(query(collection(db, 'matchups'), orderBy('createdAt', 'asc')));
    } catch (err) {
      console.error('Season matchup resync failed', err);
      return;
    }
    const currentPairKey = matchups[activeIdx] ? matchupPairKey(matchups[activeIdx]) : null;
    matchups.length = 0;
    snap.forEach(docSnap => {
      const data = docSnap.data();
      if (!data.a || !data.b) return;
      if (data.expiresAt && data.expiresAt.toMillis() < Date.now()) return;
      if (hiddenMatchupKeys.has(matchupPairKey(data))) return;
      if (isOutOfSeason(data.category || null)) return;
      matchups.push({ a: data.a, b: data.b, votesA: data.votesA || 0, votesB: data.votesB || 0, community: true, docId: docSnap.id, category: data.category || null, revealAt: data.revealAt || null, resultsSettled: !!data.resultsSettled, winningSide: data.winningSide || null });
    });
    // Try to keep whatever was on screen still on screen if it survived
    // the filter; otherwise fall back to the start of the (new) list
    // rather than an index that may now point at something else entirely.
    const preservedIdx = currentPairKey ? matchups.findIndex(m => matchupPairKey(m) === currentPairKey) : -1;
    activeIdx = preservedIdx !== -1 ? preservedIdx : 0;
    renderTrendScroll();
    renderHero();
  }

  onSnapshot(query(collection(db, 'matchups'), orderBy('createdAt', 'asc')), snapshot => {
    let listChanged = false;
    let heroNeedsRefresh = false;
    const wasEmpty = matchups.length === 0;
    snapshot.docChanges().forEach(change => {
      const docSnap = change.doc;
      if (change.type === 'removed') {
        const idx = matchups.findIndex(m => m.docId === docSnap.id);
        if (idx !== -1) {
          matchups.splice(idx, 1);
          if (activeIdx >= matchups.length) activeIdx = matchups.length - 1;
          else if (idx < activeIdx) activeIdx--;
          listChanged = true;
          if (idx === activeIdx || idx <= activeIdx) heroNeedsRefresh = true;
        }
        return;
      }
      // 'modified' fires for vote-count edits (deliberately ignored below —
      // those are synced by the dedicated per-doc listener instead) but
      // also for the fields an admin can change after creation: category
      // (season tagging), revealAt/resultsSettled/winningSide (blind-vote
      // timer). Those DO need to be picked up live — otherwise tagging a
      // matchup for the season that's currently live never actually makes
      // it appear (or disappear, if retagged away) until something else
      // happens to trigger a full resyncMatchupsForSeason().
      if (change.type === 'modified') {
        const data = docSnap.data();
        if (!data.a || !data.b) return;
        const idx = matchups.findIndex(m => m.docId === docSnap.id);
        const expired = data.expiresAt && data.expiresAt.toMillis() < Date.now();
        const hiddenLocally = hiddenMatchupKeys.has(matchupPairKey(data));
        const outOfSeason = isOutOfSeason(data.category || null);
        const shouldShow = !expired && !hiddenLocally && !outOfSeason;
        if (!shouldShow) {
          if (idx !== -1) {
            matchups.splice(idx, 1);
            if (activeIdx >= matchups.length) activeIdx = matchups.length - 1;
            else if (idx < activeIdx) activeIdx--;
            listChanged = true;
            if (idx === activeIdx || idx <= activeIdx) heroNeedsRefresh = true;
          }
          return;
        }
        if (idx === -1) {
          // Just became eligible under the live season filter (e.g. newly
          // tagged for the season that's now active) — bring it into view
          // the same way a fresh 'added' event would.
          matchups.push({ a: data.a, b: data.b, votesA: data.votesA || 0, votesB: data.votesB || 0, community: true, docId: docSnap.id, category: data.category || null, revealAt: data.revealAt || null, resultsSettled: !!data.resultsSettled, winningSide: data.winningSide || null });
          listChanged = true;
          return;
        }
        // Already showing — refresh only the admin-editable fields;
        // votesA/votesB stay untouched here, same as before.
        const m = matchups[idx];
        m.category = data.category || null;
        m.revealAt = data.revealAt || null;
        m.resultsSettled = !!data.resultsSettled;
        m.winningSide = data.winningSide || null;
        if (idx === activeIdx) heroNeedsRefresh = true;
        return;
      }
      if (change.type !== 'added') return;
      const data = docSnap.data();
      if (!data.a || !data.b) return;
      // TTL policies need the Blaze plan, so we can't have Firestore
      // physically delete expired docs — instead just skip showing
      // anything already past its expiresAt. The doc itself stays in
      // the database (small storage footprint, well within Spark's
      // free 1 GiB), it just stops appearing in the app.
      if (data.expiresAt && data.expiresAt.toMillis() < Date.now()) return;
      // This browser chose to hide this exact matchup before — respect
      // that even though the doc is still live in Firestore for everyone else.
      if (hiddenMatchupKeys.has(matchupPairKey(data))) return;
      // Season-exclusive filtering, both directions — see isOutOfSeason()
      // above for the actual rule and why it isn't a plain
      // `data.category && data.category !== activeSeasonId` check.
      if (isOutOfSeason(data.category || null)) return;
      const existingMatchup = matchups.find(m => matchupPairKey(m) === matchupPairKey(data));
      if (existingMatchup) {
        // Already showing locally (e.g. the one we just optimistically
        // pushed on submit) — just attach the Firestore doc id so votes
        // and deletes on it can be written back, without duplicating the card.
        if (!existingMatchup.docId) {
          existingMatchup.docId = docSnap.id;
          // If this is the matchup currently on screen, its comment box
          // was disabled (no docId to post against yet) — rewire it now
          // that a real id exists, instead of leaving it dead until the
          // user switches away and back.
          if (matchups[activeIdx] === existingMatchup) wireHeroComments(existingMatchup.docId);
        }
        return;
      }
      matchups.push({ a: data.a, b: data.b, votesA: data.votesA || 0, votesB: data.votesB || 0, community: true, docId: docSnap.id, category: data.category || null, revealAt: data.revealAt || null, resultsSettled: !!data.resultsSettled, winningSide: data.winningSide || null });
      listChanged = true;
      if (matchupsSynced) pushNotification('matchup', 'New matchup', `${data.a.name} vs ${data.b.name}`, docSnap.id);
    });
    matchupsSynced = true;
    trendLoadingMore.classList.remove('show');
    if (!listChanged && matchups.length === 0) renderTrendScroll(); // clears the skeleton cards even with nothing to show
    if (listChanged) { renderTrendScroll(); refreshCharacterSuggestions(); }
    // wasEmpty case covers going from zero matchups (no hardcoded seed
    // data anymore) to the first one ever streaming in — heroNeedsRefresh
    // alone only catches the 'removed' path above.
    if (heroNeedsRefresh || (wasEmpty && matchups.length > 0)) renderHero();
    tryOpenSharedMatchup();
  }, err => console.error('Matchup listener failed', err));

  // Deep-link support: a shared matchup URL looks like ?matchup=<pairKey>.
  // Built-in matchups are present immediately; community ones stream in
  // async above, so this is safe to call repeatedly — it only acts once,
  // then gets out of the way.
  let sharedMatchupHandled = false;
  function tryOpenSharedMatchup(){
    if (sharedMatchupHandled) return;
    const key = new URLSearchParams(location.search).get('matchup');
    if (!key) { sharedMatchupHandled = true; return; }
    const idx = matchups.findIndex(m => matchupPairKey(m) === key);
    if (idx === -1) return; // might still be loading (community matchup) — try again on the next snapshot
    sharedMatchupHandled = true;
    activeIdx = idx;
    renderHero();
    renderTrendScroll();
    document.getElementById('heroCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  tryOpenSharedMatchup(); // covers built-in matchups, which are already loaded at this point

  // ---------- trending clashes (dynamic, includes user-submitted matchups) ----------
  const trendScroll = document.getElementById('trendScroll');
  // 3 shimmering placeholder cards shown until the first matchup streams
  // in — there's no hardcoded seed data anymore, so without this the
  // strip would just be blank on a fresh load.
  const TREND_SKELETON_HTML = Array.from({ length: 3 }).map(() => `
      <div class="trend-card skeleton">
        <div class="trend-vs">
          <div class="mini-avatar hi skeleton-block"></div>
          <div class="mini-vs">VS</div>
          <div class="mini-avatar lo skeleton-block"></div>
        </div>
        <div class="skel-line skeleton-block" style="width:90%;height:9px;margin:0;"></div>
        <div class="skel-line skeleton-block" style="width:60%;height:8px;margin-top:6px;"></div>
      </div>`).join('');
  function renderTrendScroll(){
    if (matchups.length === 0) {
      // Still nothing at all: while the listener is still doing its first
      // sync, show shimmering placeholders; once synced and truly empty,
      // drop the shimmer for a plain empty state instead of animating forever.
      trendScroll.innerHTML = matchupsSynced
        ? '<div class="comments-modal-empty" style="padding:18px 20px;">No matchups yet — be the first to submit one.</div>'
        : TREND_SKELETON_HTML;
      return;
    }
    trendScroll.innerHTML = matchups.map((m, idx) => {
      const sameBase = m.a.name.toLowerCase() === m.b.name.toLowerCase();
      const labelA = (sameBase && m.a.version) ? `${m.a.name.split(' ')[0]} (${m.a.version})` : m.a.name.split(' ')[0];
      const labelB = (sameBase && m.b.version) ? `${m.b.name.split(' ')[0]} (${m.b.version})` : m.b.name.split(' ')[0];
      return `
      <div class="trend-card ${idx === activeIdx ? 'active-card' : ''}" data-matchup="${idx}">
        <div class="trend-vs">
          <div class="mini-avatar hi">${escapeHtml(m.a.initials)}</div>
          <div class="mini-vs">VS</div>
          <div class="mini-avatar lo">${escapeHtml(m.b.initials)}</div>
        </div>
        <div class="trend-label">${escapeHtml(labelA)} vs ${escapeHtml(labelB)}</div>
        <div class="trend-votes">${(m.votesA + m.votesB).toLocaleString()} votes${m.community ? ' · Community' : m.botGenerated ? ' · Bot Pick' : ''}</div>
      </div>`;
    }).join('');
  }
  renderTrendScroll();

  // Just moves the .active-card class between the two affected cards
  // instead of tearing down and rebuilding the entire strip's HTML —
  // picking a different matchup doesn't change which cards exist or what
  // they say, only which one is highlighted, so a full innerHTML rebuild
  // (via renderTrendScroll()) was doing a lot of unnecessary layout/paint
  // work on every tap. Falls back to a full render if the DOM doesn't
  // have a matching card for some reason (e.g. list is out of sync).
  function updateTrendScrollActiveCard(){
    const current = trendScroll.querySelector('.trend-card.active-card');
    if (current) current.classList.remove('active-card');
    const next = trendScroll.querySelector(`.trend-card[data-matchup="${activeIdx}"]`);
    if (next) next.classList.add('active-card');
    else renderTrendScroll();
  }

  trendScroll.addEventListener('click', event => {
    const card = event.target.closest('.trend-card');
    if (!card) return;
    activeIdx = parseInt(card.dataset.matchup, 10);
    heroAnalyzing = false; // picking a different matchup means they're done with the old one's analysis
    heroCommentsActive = false; // ...and with its comments, too
    updateTrendScrollActiveCard();
    renderHero();
    document.getElementById('heroCard').scrollIntoView({ behavior:'smooth', block:'start' });
  });

  document.getElementById('seeAllLink').addEventListener('click', () => {
    showToast('More clashes coming soon');
  });

  // ---------- hero auto-rotate ----------
  // The featured matchup used to just sit on whatever was first in the
  // list forever. This cycles it through every matchup automatically,
  // and backs off the moment someone actually touches it — a vote, a
  // manual pick from the trend row, checking AI stats, or the tab going
  // into the background — so nothing changes out from under them.
  const HERO_ROTATE_MS = 45000;
  const heroCardEl = document.getElementById('heroCard');
  let heroRotateTimer = null;
  // True while someone's actively looking at an AI stats breakdown for the
  // current matchup — auto-rotate stays fully off (not just delayed) until
  // they pick a different matchup themselves, so it can't switch out from
  // under them mid-read no matter how long they take.
  let heroAnalyzing = false;
  // Same idea, but for reading or writing comments on the current matchup:
  // the full "see all comments" sheet (paused for as long as it's open on
  // this matchup) and the quick inline reply box on the hero card itself.
  // Resumes once they close the sheet, step away from the inline box, or
  // switch matchups themselves — it shouldn't switch out from under someone
  // mid-conversation any more than it should mid AI-stats-read.
  let heroCommentsActive = false;
  heroCommentInput.addEventListener('focus', () => { heroCommentsActive = true; scheduleHeroRotate(); });
  heroCommentInput.addEventListener('blur', () => { heroCommentsActive = false; scheduleHeroRotate(); });

  function scheduleHeroRotate(){
    clearTimeout(heroRotateTimer);
    if (heroAnalyzing || heroCommentsActive) return; // paused for AI analysis or comments — resumes on manual matchup switch / closing the sheet / leaving the reply box
    if (matchups.length < 2) return; // nothing to flex between
    heroRotateTimer = setTimeout(() => {
      if (document.hidden) { scheduleHeroRotate(); return; } // tab not visible — just reschedule, don't burn a cycle
      activeIdx = (activeIdx + 1) % matchups.length;
      updateTrendScrollActiveCard();
      renderHero();
      scheduleHeroRotate();
    }, HERO_ROTATE_MS);
  }
  scheduleHeroRotate();

  // Any manual interaction resets the clock so auto-rotate never fights
  // something the person just did.
  heroCardEl.addEventListener('pointerdown', scheduleHeroRotate);
  trendScroll.addEventListener('click', scheduleHeroRotate);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleHeroRotate(); });

  // ---------- movie clips ----------
  const moviesSection = document.getElementById('moviesSection');
  const clipUploaderOverlay = document.getElementById('clipUploaderOverlay');
  const openClipUploader = document.getElementById('openClipUploader');
  const clipUploaderClose = document.getElementById('clipUploaderClose');
  openClipUploader.addEventListener('click', () => clipUploaderOverlay.classList.add('show'));
  clipUploaderClose.addEventListener('click', () => clipUploaderOverlay.classList.remove('show'));
  clipUploaderOverlay.addEventListener('click', event => {
    if (event.target === clipUploaderOverlay) clipUploaderOverlay.classList.remove('show');
  });
  const clipYoutubeUrl = document.getElementById('clipYoutubeUrl');
  const clipFileName = document.getElementById('clipFileName');
  const clipTitle = document.getElementById('clipTitle');
  const clipReview = document.getElementById('clipReview');
  const publishClip = document.getElementById('publishClip');
  const clipFeed = document.getElementById('clipFeed');

  // ---------- like + share (shared by the matchup hero card and video clips) ----------
  // Likes are now ACCOUNT-based, not device-based: "have I liked this" is
  // determined by whether the signed-in user's uid appears in that target's
  // like doc, not by anything stored in localStorage. That means the same
  // account sees the same liked/unliked state on every phone/browser it
  // signs into, and switching accounts on one device shows that account's
  // own like state instead of whatever the previous account left behind.
  //
  // Data model: 'likes/{key}' doc has a `uids` map, e.g. { uid1: true,
  // uid2: true }. The displayed count is baseSeedCounts[key] (a cosmetic
  // starting number so a popular matchup doesn't show "0" before anyone's
  // liked it for real) PLUS the number of uids actually in the doc — so
  // the real, verifiable per-account count only ever grows from genuine
  // distinct accounts liking it.
  const baseSeedCounts = {}; // key -> cosmetic starting count (local only, never written to Firestore)
  let remoteLikeUids = {}; // key -> { uid: true, ... }, filled in by Firestore
  const confirmedLikeKeys = new Set(); // keys that actually have a Firestore doc already
  const likeRenderers = {}; // key -> function that repaints whatever button(s) show that key

  function formatLikeCount(n){
    if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
    return String(Math.max(0, n));
  }

  function likeDisplayCount(key){
    return (baseSeedCounts[key] || 0) + Object.keys(remoteLikeUids[key] || {}).length;
  }

  function likedByCurrentUser(key){
    const user = auth.currentUser;
    return !!(user && remoteLikeUids[key] && remoteLikeUids[key][user.uid]);
  }

  // Re-paints every currently-wired like button — used after sign-in/out,
  // since whether a given key shows as "liked" depends on which account
  // (if any) is currently signed in.
  function renderAllLikeButtons(){
    Object.values(likeRenderers).forEach(render => render());
  }

  async function toggleLike(key){
    const user = auth.currentUser;
    if (!user) { requireSignIn('Sign in to like'); return; }
    const uid = user.uid;
    // key is "matchup:<pairKey>" or "clip:<clipId>" — split once, since a
    // pairKey/clipId could itself contain no further colons we need to keep.
    const sepIndex = key.indexOf(':');
    const targetType = key.slice(0, sepIndex);
    const targetId = key.slice(sepIndex + 1);

    const previousUids = remoteLikeUids[key] || {};
    const liked = !previousUids[uid];
    haptic('tap');
    const nextUids = { ...previousUids };
    if (liked) nextUids[uid] = true; else delete nextUids[uid];
    remoteLikeUids[key] = nextUids;
    if (likeRenderers[key]) likeRenderers[key]();

    // Server-authoritative toggle via /api/like — verifies identity and
    // enforces one uid per like. No longer awards XP (win-only now).
    // Direct Firestore writes to `likes/{id}` are rejected by the
    // security rules.
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`${PAYMENT_API_BASE}/api/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify({ targetType, targetId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Like failed');
      // Optimistic local bump so the progress bar feels live — the server
      // already awarded the real XP for a first-time like (xpAwarded is 0
      // for an unlike or a re-like that was already credited once).
      if (data.xpAwarded) {
        currentUserXp += data.xpAwarded;
        currentUserWeeklyXp += data.xpAwarded;
        renderVerifiedProgress();
        showXpToast(data.xpAwarded, data.rank);
      }
    } catch (err) {
      console.error('Like sync failed', err);
      // The optimistic bump above never actually landed on the server —
      // undo it so this account doesn't end up stuck showing a "liked"
      // state and an inflated count that only it can see. Without this,
      // a failed write (permission error, offline, blocked request) looks
      // exactly like a successful like that never synced.
      remoteLikeUids[key] = previousUids;
      if (likeRenderers[key]) likeRenderers[key]();
      showToast('Could not save like — try again');
    }
  }

  // Builds a link that lands the receiver directly on the specific
  // matchup or clip that was shared, instead of just the app's home
  // screen. Matchups are identified by their pairKey (works for both
  // built-in and community matchups, since built-ins have no Firestore
  // docId), clips by their clipId (Firestore docId, or the built-in
  // demo id). Strips any existing query/hash so old share params never
  // stack up on a re-share.
  function buildShareUrl(kind, id){
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set(kind, id);
    return url.toString();
  }

  // Opens the device's native share sheet (all installed apps: WhatsApp,
  // Messenger, X, Instagram, Mail, etc. — whatever the OS offers), falling
  // back to copying the link when the Web Share API isn't available
  // (mainly desktop browsers).
  async function shareLink({ title, text, url, onShared }){
    let shared = false;
    if (navigator.share) {
      try { await navigator.share({ title, text, url }); shared = true; } catch (err) { /* user cancelled — ignore */ }
    } else {
      try {
        await navigator.clipboard.writeText(url);
        showToast('Link copied!');
        shared = true;
      } catch (err) {
        showToast('Could not copy link');
      }
    }
    if (shared) {
      if (onShared) await onShared();
    }
    return shared;
  }

  // ---------- shareable "battle card" images ----------
  // Turns a matchup or a custom team build into a single self-contained
  // PNG (branded, sized for feeds) instead of a bare link, so a Reddit/
  // Discord post actually shows something instead of a plain URL preview.
  // Character art here is always either our own generated placeholder SVG
  // or a data: URL the user already uploaded through the existing avatar
  // flow — never a fetched third-party image — so nothing new is pulled
  // in from off-site, and the canvas is never tainted by cross-origin
  // pixels (a hard requirement for canvas.toBlob to work at all).
  const BATTLE_CARD_W = 1080, BATTLE_CARD_H = 1080;

  function loadImageEl(src){
    return new Promise(resolve => {
      if (!src) { resolve(null); return; }
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function roundRectPath(ctx, x, y, w, h, r){
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCardAvatar(ctx, img, cx, cy, r, initials){
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (img) {
      const scale = Math.max((r * 2) / img.width, (r * 2) / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    } else {
      ctx.fillStyle = '#3a3b42';
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 ${Math.round(r * 0.55)}px 'Rajdhani', sans-serif`;
      ctx.fillText(initials || '?', cx, cy + 2);
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.stroke();
  }

  // Async because a live-season path has to await the hero art before it
  // can draw anything — callers must `await` this now (both do). Reads
  // its art/colors from the active season's own SEASONS entry, so adding
  // a season here is a config addition, not a new canvas branch.
  async function drawBattleCardShell(ctx, w, h, kicker){
    const activeSeason = activeSeasonId ? SEASONS[activeSeasonId] : null;
    const heroImgPath = activeSeason ? activeSeason.cardArt : null;
    const heroImg = heroImgPath ? await loadImageEl(heroImgPath) : null;
    if (heroImgPath && !heroImg) {
      console.warn(`Battle card art failed to load from ${heroImgPath} — falling back to the plain background. Check the file is actually deployed at that path (open the URL directly in a tab to confirm it 200s).`);
    }

    if (heroImg) {
      // Cover-fit crop, same math as the CSS `background-size:cover` used
      // for the phone frame itself, so the art reads consistently.
      const scale = Math.max(w / heroImg.width, h / heroImg.height);
      const iw = heroImg.width * scale, ih = heroImg.height * scale;
      ctx.drawImage(heroImg, (w - iw) / 2, (h - ih) / 2, iw, ih);
      ctx.fillStyle = 'rgba(8,10,22,.5)'; // deep night-navy, matches the torii art's sky
      ctx.fillRect(0, 0, w, h);
    } else {
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#2b2c33');
      bg.addColorStop(1, '#17181d');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
    }

    const glowRgb = activeSeason ? activeSeason.cardGlowRgb : '228,169,41'; // warm lantern-gold outside any season
    const glow = ctx.createRadialGradient(w / 2, h * 0.22, 10, w / 2, h * 0.22, w * 0.65);
    glow.addColorStop(0, `rgba(${glowRgb},.28)`);
    glow.addColorStop(1, `rgba(${glowRgb},0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = 'center';
    ctx.fillStyle = activeSeason ? activeSeason.cardAccentColor : '#E4A929';
    ctx.font = `700 34px 'Rajdhani', sans-serif`;
    ctx.fillText('FICTION CLASH', w / 2, 96);
    ctx.fillStyle = '#999';
    ctx.font = `700 16px 'Instrument Sans', sans-serif`;
    ctx.letterSpacing = '1px';
    ctx.fillText(kicker || 'VOTE · COMPARE · SETTLE IT', w / 2, 126);
    ctx.letterSpacing = '0px';
  }

  function drawBattleCardFooter(ctx, w, h, url){
    ctx.fillStyle = 'rgba(255,255,255,.07)';
    ctx.fillRect(0, h - 110, w, 110);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = `700 26px 'Rajdhani', sans-serif`;
    ctx.fillText('Cast your vote at Fiction Clash', w / 2, h - 58);
    ctx.fillStyle = '#999';
    ctx.font = `600 16px 'Martian Mono', monospace`;
    ctx.fillText((url || '').replace(/^https?:\/\//, ''), w / 2, h - 26);
  }

  // Waits for the two brand fonts the card leans on hardest so canvas text
  // doesn't silently fall back to a system serif on the very first share
  // of a session (fonts loaded via the @import above can still be mid-flight).
  async function ensureCardFontsReady(){
    if (!document.fonts || !document.fonts.load) return;
    try {
      await Promise.all([
        document.fonts.load("700 34px 'Rajdhani'"),
        document.fonts.load("700 16px 'Instrument Sans'"),
        document.fonts.load("600 16px 'Martian Mono'")
      ]);
    } catch (err) { /* best-effort — card still renders with fallback fonts */ }
  }

  async function buildMatchupBattleCard(m, shareUrl){
    await ensureCardFontsReady();
    const canvas = document.createElement('canvas');
    canvas.width = BATTLE_CARD_W;
    canvas.height = BATTLE_CARD_H;
    const ctx = canvas.getContext('2d');
    await drawBattleCardShell(ctx, canvas.width, canvas.height, 'TODAY\u2019S MATCHUP');

    const total = (m.votesA || 0) + (m.votesB || 0);
    const pctA = total === 0 ? 50 : Math.round((m.votesA / total) * 100);
    const pctB = 100 - pctA;

    const [imgA, imgB] = await Promise.all([
      loadImageEl(getCharacterAvatarOverride(m.a.name, m.a.version) || avatarUrl(m.a.name, m.a.initials)),
      loadImageEl(getCharacterAvatarOverride(m.b.name, m.b.version) || avatarUrl(m.b.name, m.b.initials))
    ]);

    const cy = 400, r = 210;
    drawCardAvatar(ctx, imgA, canvas.width * 0.28, cy, r, m.a.initials);
    drawCardAvatar(ctx, imgB, canvas.width * 0.72, cy, r, m.b.initials);

    ctx.fillStyle = '#E4A929';
    ctx.beginPath();
    ctx.arc(canvas.width / 2, cy, 58, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0A0806';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 36px 'Rajdhani', sans-serif`;
    ctx.fillText('VS', canvas.width / 2, cy + 3);
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = '#fff';
    ctx.font = `700 30px 'Rajdhani', sans-serif`;
    wrapCenteredText(ctx, m.a.name.toUpperCase(), canvas.width * 0.28, cy + r + 52, canvas.width * 0.42, 34);
    wrapCenteredText(ctx, m.b.name.toUpperCase(), canvas.width * 0.72, cy + r + 52, canvas.width * 0.42, 34);

    const barY = cy + r + 150, barW = canvas.width - 160, barX = 80, barH = 28;
    ctx.fillStyle = '#3a3b42';
    roundRectPath(ctx, barX, barY, barW, barH, 14);
    ctx.fill();
    ctx.fillStyle = '#E4A929';
    roundRectPath(ctx, barX, barY, Math.max(barH, barW * (pctA / 100)), barH, 14);
    ctx.fill();

    ctx.font = `700 22px 'Rajdhani', sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(`${pctA}%`, barX, barY - 14);
    ctx.textAlign = 'right';
    ctx.fillText(`${pctB}%`, barX + barW, barY - 14);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#999';
    ctx.font = `600 16px 'Martian Mono', monospace`;
    ctx.fillText(`${total.toLocaleString()} vote${total === 1 ? '' : 's'} so far`, canvas.width / 2, barY + 54);

    drawBattleCardFooter(ctx, canvas.width, canvas.height, shareUrl);
    return canvas;
  }

  // Generic word-wrap: measures against ctx's *currently set* font, so
  // callers must set ctx.font before calling this (and again before
  // drawing, if drawing happens in a separate pass on a different canvas).
  function computeWrappedLines(ctx, text, maxWidth, maxLines = Infinity){
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    words.forEach(word => {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    });
    if (line) lines.push(line);
    return lines.slice(0, maxLines);
  }

  // Simple centered word-wrap for labels under an avatar (name, caption).
  function wrapCenteredText(ctx, text, cx, startY, maxWidth, lineHeight, maxLines = 2){
    ctx.textAlign = 'center';
    computeWrappedLines(ctx, text, maxWidth, maxLines).forEach((l, i) => ctx.fillText(l, cx, startY + i * lineHeight));
  }

  // Draws a team's fighters as a slightly-overlapping row of avatar circles
  // (front fighter drawn last so it sits on top), centered on cx.
  async function drawAvatarCluster(ctx, names, cx, cy, r){
    const spacing = r * 1.15;
    const entries = await Promise.all(names.map(async name => {
      const initials = name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
      const img = await loadImageEl(getCharacterAvatarOverride(name) || avatarUrl(name, initials));
      return { img, initials };
    }));
    entries.forEach((entry, i) => {
      const x = cx + (i - (entries.length - 1) / 2) * spacing;
      drawCardAvatar(ctx, entry.img, x, cy, r, entry.initials);
    });
  }

  // Builds the team-builder battle card: two overlapping avatar clusters
  // facing off, with an optional AI Power Scout verdict underneath when
  // `report` (the last successful AI feat-check result) is passed in.
  async function buildTeamBattleCard(teamsState, shareUrl, report){
    await ensureCardFontsReady();
    const maxCount = Math.max(teamsState.alpha.length, teamsState.omega.length, 1);
    const r = maxCount > 2 ? 60 : 78;
    const clusterY = 260;
    const alphaCaption = teamsState.alpha.join(', ');
    const omegaCaption = teamsState.omega.join(', ');
    const captionMaxWidth = BATTLE_CARD_W * 0.42;
    const captionTop = clusterY + r + 40;
    const captionLineHeight = 26;

    // Measurement pass on a throwaway canvas — we need final line counts
    // (captions + optional verdict paragraph) before we know how tall the
    // real canvas should be, and font metrics require a live 2D context.
    const mctx = document.createElement('canvas').getContext('2d');
    mctx.font = `700 20px 'Instrument Sans', sans-serif`;
    const alphaLines = computeWrappedLines(mctx, alphaCaption, captionMaxWidth, 2);
    const omegaLines = computeWrappedLines(mctx, omegaCaption, captionMaxWidth, 2);
    const captionBottom = captionTop + Math.max(alphaLines.length, omegaLines.length, 1) * captionLineHeight;

    let verdictLines = [];
    let verdictTop = captionBottom;
    if (report && report.verdict) {
      mctx.font = `500 22px 'Instrument Sans', sans-serif`;
      verdictLines = computeWrappedLines(mctx, report.verdict, BATTLE_CARD_W - 160, 10);
      verdictTop = captionBottom + 76;
    }
    const contentBottom = verdictLines.length ? verdictTop + verdictLines.length * 30 : captionBottom;
    const canvasHeight = Math.round(contentBottom + 150);

    const canvas = document.createElement('canvas');
    canvas.width = BATTLE_CARD_W;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');
    await drawBattleCardShell(ctx, canvas.width, canvas.height, report ? 'AI POWER SCOUT VERDICT' : 'CUSTOM TEAM MATCHUP');

    const alphaCx = canvas.width * 0.26, omegaCx = canvas.width * 0.74;
    await drawAvatarCluster(ctx, teamsState.alpha, alphaCx, clusterY, r);
    await drawAvatarCluster(ctx, teamsState.omega, omegaCx, clusterY, r);

    ctx.fillStyle = '#E4A929';
    ctx.beginPath();
    ctx.arc(canvas.width / 2, clusterY, 58, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0A0806';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 36px 'Rajdhani', sans-serif`;
    ctx.fillText('VS', canvas.width / 2, clusterY + 3);
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = '#E4A929';
    ctx.font = `700 20px 'Rajdhani', sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('TEAM ALPHA', alphaCx, clusterY - r - 24);
    ctx.fillText('TEAM OMEGA', omegaCx, clusterY - r - 24);

    ctx.fillStyle = '#fff';
    ctx.font = `700 20px 'Instrument Sans', sans-serif`;
    alphaLines.forEach((l, i) => ctx.fillText(l, alphaCx, captionTop + i * captionLineHeight));
    omegaLines.forEach((l, i) => ctx.fillText(l, omegaCx, captionTop + i * captionLineHeight));

    if (verdictLines.length) {
      ctx.strokeStyle = 'rgba(255,255,255,.12)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(80, captionBottom + 24);
      ctx.lineTo(canvas.width - 80, captionBottom + 24);
      ctx.stroke();

      ctx.fillStyle = '#E4A929';
      ctx.font = `700 18px 'Rajdhani', sans-serif`;
      ctx.fillText('AI VERDICT', canvas.width / 2, captionBottom + 56);

      ctx.fillStyle = '#fff';
      ctx.font = `500 22px 'Instrument Sans', sans-serif`;
      verdictLines.forEach((l, i) => ctx.fillText(l, canvas.width / 2, verdictTop + i * 30));
    }

    drawBattleCardFooter(ctx, canvas.width, canvas.height, shareUrl);
    return canvas;
  }

  // Shares the rendered card as an actual image file wherever the OS share
  // sheet supports files (Reddit and Discord's own apps both accept an
  // image this way); falls back to downloading the PNG + copying the link
  // on browsers that can only share text (mainly desktop).
  async function shareOrDownloadCard(canvas, { filename, title, text, url, onShared }){
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.95));
    if (!blob) { showToast('Could not generate the battle card'); return; }
    const file = new File([blob], filename, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title, text: `${text}\n${url}` });
        if (onShared) await onShared();
        return;
      } catch (err) { return; /* user cancelled the share sheet */ }
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    try {
      await navigator.clipboard.writeText(url);
      showToast('Battle card downloaded — link copied too!');
    } catch (err) {
      showToast('Battle card downloaded!');
    }
    if (onShared) await onShared();
  }

  // Server-authoritative XP for sharing a matchup or a clip, via /api/share
  // — same shape as toggleLike's /api/like call. Awards once per unique
  // (targetType, targetId) per user; re-sharing the same matchup/clip just
  // returns xpAwarded: 0. Never blocks or throws into the caller's share
  // flow — sharing itself should always succeed even if the XP call fails
  // or the user isn't signed in.
  async function awardShareXp(targetType, targetId){
    const user = auth.currentUser;
    if (!user || !targetId) return;
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify({ targetType, targetId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Share XP failed');
      if (data.xpAwarded) {
        currentUserXp += data.xpAwarded;
        currentUserWeeklyXp += data.xpAwarded;
        renderVerifiedProgress();
        showXpToast(data.xpAwarded, data.rank);
      }
    } catch (err) {
      console.error('Share XP award failed', err);
    }
  }

  // Wires a clip card's like + share buttons. Safe to call more than once
  // per card id — it just re-registers the renderer + listeners.
  function wireClipSocial(id, card, baseLikeCount){
    const likeBtn = card.querySelector('.like-btn');
    const shareBtn = card.querySelector('.share-btn');
    if (!likeBtn || !shareBtn) return;
    const countEl = likeBtn.querySelector('.like-count');
    const key = 'clip:' + id;
    if (!(key in baseSeedCounts)) baseSeedCounts[key] = baseLikeCount;
    function renderLike(){
      likeBtn.classList.toggle('liked', likedByCurrentUser(key));
      countEl.textContent = formatLikeCount(likeDisplayCount(key));
    }
    // Also keeps the reels overlay's own like button in sync, on the rare
    // chance this same clip is open there when the like state changes.
    likeRenderers[key] = () => { renderLike(); if (reelsLikeKey === key) renderReelsLikeButton(); };
    renderLike();
    likeBtn.addEventListener('click', () => toggleLike(key));
    shareBtn.addEventListener('click', () => {
      const title = card.querySelector('h3')?.textContent || 'A clip on Fiction Clash';
      shareLink({ title, text: title, url: buildShareUrl('clip', id), onShared: () => awardShareXp('clip', id) });
    });
  }

  // ---------- full-screen reels-style clip player ----------
  // The only place a clip's video/YouTube embed is ever actually mounted.
  // Cards themselves only ever show a static poster + play button — so
  // opening a new clip always tears down whatever was playing before,
  // making it structurally impossible for two clips to play at once.
  const reelsOverlay = document.getElementById('reelsOverlay');
  const reelsMedia = document.getElementById('reelsMedia');
  const reelsCloseBtn = document.getElementById('reelsCloseBtn');
  const reelsLikeBtn = document.getElementById('reelsLikeBtn');
  const reelsLikeCount = document.getElementById('reelsLikeCount');
  const reelsCommentBtn = document.getElementById('reelsCommentBtn');
  const reelsShareBtn = document.getElementById('reelsShareBtn');
  const reelsTitle = document.getElementById('reelsTitle');
  const reelsMeta = document.getElementById('reelsMeta');
  let reelsLikeKey = '';
  let reelsClipCard = null;

  function renderReelsLikeButton(){
    if (!reelsLikeKey) return;
    reelsLikeBtn.classList.toggle('liked', likedByCurrentUser(reelsLikeKey));
    reelsLikeCount.textContent = formatLikeCount(likeDisplayCount(reelsLikeKey));
  }

  function closeReelsPlayer(){
    reelsOverlay.classList.remove('show');
    reelsMedia.innerHTML = ''; // actually tears down the player so it stops playing
    reelsMedia.classList.remove('switching');
    reelsLikeKey = '';
    reelsClipCard = null;
    // Release the scroll lock applied when the player opened.
    document.querySelector('.phone-scroll').style.overflow = '';
  }

  function renderReelsMedia(type, src){
    reelsMedia.innerHTML = type === 'youtube'
      ? `<iframe src="https://www.youtube.com/embed/${src}?autoplay=1&playsinline=1" title="Clip" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`
      : `<video src="${src}" autoplay playsinline controls></video>`;
  }

  function openReelsPlayer(thumb){
    const card = thumb.closest('.clip-card');
    if (!card) return;
    const clipId = card.dataset.clipId;
    const type = thumb.dataset.videoType;
    const src = thumb.dataset.videoSrc;
    if (!src) return; // demo placeholder cards with no real video yet
    const isAlreadyOpen = reelsOverlay.classList.contains('show');
    if (isAlreadyOpen) {
      // Switching between clips while the player is already open — fade
      // the old one out, swap the source, then fade the new one in,
      // instead of an instant hard cut.
      reelsMedia.classList.add('switching');
      setTimeout(() => {
        renderReelsMedia(type, src);
        reelsMedia.classList.remove('switching');
      }, 160);
    } else {
      renderReelsMedia(type, src);
      // Prevent the page underneath this fixed overlay from also
      // scrolling/bouncing while a swipe gesture plays out on top of it.
      document.querySelector('.phone-scroll').style.overflow = 'hidden';
    }
    reelsTitle.textContent = card.querySelector('h3')?.textContent || '';
    reelsMeta.textContent = card.querySelector('.clip-meta span')?.textContent || '';
    reelsLikeKey = 'clip:' + clipId;
    reelsClipCard = card;
    renderReelsLikeButton();
    reelsOverlay.classList.add('show');
  }

  clipFeed.addEventListener('click', event => {
    const playBtn = event.target.closest('.clip-play-btn');
    if (!playBtn) return;
    openReelsPlayer(playBtn.closest('.clip-thumb'));
  });

  // ---------- reels swipe-to-scroll (next/previous clip) ----------
  // Only clips with an actual video attached count as "playable" — the
  // still-empty demo cards are skipped so swiping never lands on a dead
  // player. Recomputed on every swipe (not cached) so newly-posted clips
  // are included without needing the overlay to be reopened.
  function getPlayableThumbs(){
    return Array.from(clipFeed.querySelectorAll('.clip-thumb')).filter(t => t.dataset.videoSrc);
  }
  function goToAdjacentClip(direction){
    const thumbs = getPlayableThumbs();
    const currentThumb = reelsClipCard ? reelsClipCard.querySelector('.clip-thumb') : null;
    const idx = thumbs.indexOf(currentThumb);
    if (idx === -1) return;
    const nextThumb = thumbs[idx + direction];
    if (nextThumb) openReelsPlayer(nextThumb);
  }
  let reelsTouchStartY = 0;
  const reelsSwipeCatcher = document.getElementById('reelsSwipeCatcher');
  reelsSwipeCatcher.addEventListener('touchstart', event => {
    reelsTouchStartY = event.touches[0].clientY;
  }, { passive: true });
  // Not passive — this is what actually stops the browser from treating
  // the drag as a native scroll/bounce on whatever's underneath the fixed
  // overlay, which previously made one swipe direction feel fine and the
  // other feel like it was scrolling the wrong thing.
  reelsSwipeCatcher.addEventListener('touchmove', event => {
    event.preventDefault();
  }, { passive: false });
  reelsSwipeCatcher.addEventListener('touchend', event => {
    const deltaY = reelsTouchStartY - event.changedTouches[0].clientY;
    if (Math.abs(deltaY) < 50) return; // a tap, not a deliberate swipe
    goToAdjacentClip(deltaY > 0 ? 1 : -1); // swipe up = next clip, swipe down = previous
  }, { passive: true });
  // Desktop equivalent: mouse-wheel/trackpad scroll while the player is open.
  let reelsWheelLocked = false;
  reelsSwipeCatcher.addEventListener('wheel', event => {
    if (reelsWheelLocked) return;
    reelsWheelLocked = true;
    goToAdjacentClip(event.deltaY > 0 ? 1 : -1);
    setTimeout(() => { reelsWheelLocked = false; }, 450); // debounce so one scroll gesture = one clip
  }, { passive: true });

  reelsCloseBtn.addEventListener('click', closeReelsPlayer);
  reelsLikeBtn.addEventListener('click', () => toggleLike(reelsLikeKey));
  reelsShareBtn.addEventListener('click', () => {
    if (!reelsClipCard) return;
    const title = reelsClipCard.querySelector('h3')?.textContent || 'A clip on Fiction Clash';
    const clipId = reelsClipCard.dataset.clipId;
    shareLink({ title, text: title, url: buildShareUrl('clip', clipId), onShared: () => awardShareXp('clip', clipId) });
  });
  reelsCommentBtn.addEventListener('click', () => {
    if (!reelsClipCard) return;
    const card = reelsClipCard;
    closeReelsPlayer();
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.querySelector('.comment-form input')?.focus();
  });

  // Real-time: a like tapped on any device updates this doc, which every
  // other visitor is subscribed to here, so the count and "liked" state
  // move for everyone without a page refresh — same pattern as the
  // matchups/movieClips feeds.
  onSnapshot(collection(db, 'likes'), snapshot => {
    snapshot.docChanges().forEach(change => {
      const key = change.doc.id;
      if (change.type === 'removed') { confirmedLikeKeys.delete(key); remoteLikeUids[key] = {}; if (likeRenderers[key]) likeRenderers[key](); return; }
      confirmedLikeKeys.add(key);
      remoteLikeUids[key] = change.doc.data().uids || {};
      if (likeRenderers[key]) likeRenderers[key]();
    });
  }, err => console.error('Likes listener failed', err));


  // Pulls the 11-character video ID out of any common YouTube URL shape
  // (watch?v=, youtu.be/, shorts/, embed/), or accepts a bare ID typed in.
  // Also flags whether the link was specifically a /shorts/ URL — that's
  // the signal that the underlying video is actually vertical, which is
  // what makes it fill the reels player instead of letterboxing.
  function extractYoutubeId(input){
    const value = (input || '').trim();
    if (!value) return null;
    if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
    const match = value.match(/(?:youtube\.com\/watch\?[^#]*\bv=|youtube\.com\/shorts\/|youtube\.com\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  }
  function isYoutubeShortsLink(input){
    return /youtube\.com\/shorts\//.test((input || '').trim());
  }

  // Figures out which platform a pasted link belongs to and returns its ID,
  // or null if it isn't a recognizable YouTube link.
  function parseClipLink(input){
    const youtubeId = extractYoutubeId(input);
    if (youtubeId) return { platform: 'youtube', id: youtubeId, isShort: isYoutubeShortsLink(input) };
    return null;
  }

  clipYoutubeUrl.addEventListener('input', () => {
    const raw = clipYoutubeUrl.value;
    const parsed = parseClipLink(raw);
    if (parsed && parsed.isShort) clipFileName.textContent = `Looks good — this'll fill the reels view properly`;
    else if (parsed) clipFileName.textContent = `Works, but it's a regular video — it may show with black bars in reels view. A youtube.com/shorts/ link looks best.`;
    else if (raw.trim()) clipFileName.textContent = "That doesn't look like a YouTube link";
    else clipFileName.textContent = 'Paste a YouTube Shorts link for best results';
  });


  function escapeHtml(value){
    return value.replace(/[&<>"']/g, char => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;'
    }[char]));
  }

  // Short, subtle vibration feedback on key actions (vote, like, comment
  // sent, redeem) — one of the cheapest "feels native" wins in a TWA.
  // navigator.vibrate is Android/Chrome-only and silently does nothing on
  // iOS Safari or if the user has vibration disabled, so this is always
  // safe to call and never needs its own feature check at the call site.
  // A couple of named patterns cover every case actually used below:
  // 'tap' for an instant action (vote, like), 'success' for something that
  // took a round trip and paid off (comment posted, item redeemed).
  function haptic(kind){
    if (!navigator.vibrate) return;
    try {
      navigator.vibrate(kind === 'success' ? [12, 40, 12] : 12);
    } catch (err) { /* vibration is a nicety — never worth surfacing an error for */ }
  }

  // Returns {uid, name, avatarUrl, decorationId} for the signed-in user (using their
  // saved profile name/picture where set), or null if signed out. A real
  // account is required to comment/post so the name + picture attached to
  // a comment are meaningful on every browser, not just this one.
  function currentUserIdentity(){
    const user = auth.currentUser;
    if (!user) return null;
    const name = profileName.value.trim() || user.displayName || (user.email ? user.email.split('@')[0] : 'You');
    // Accept either an http(s) URL or a compressed data URL (small enough
    // to embed safely) — but never an uncompressed multi-MB preview.
    const usable = avatarDataUrl && (avatarDataUrl.startsWith('http') || avatarDataUrl.length < 400000);
    return {
      uid: user.uid,
      name,
      avatarUrl: usable ? avatarDataUrl : (user.photoURL || ''),
      decorationId: decorationById(equippedDecoration) ? equippedDecoration : null
    };
  }

  function requireSignIn(message){
    showToast(message || 'Sign in to continue');
    signinOverlay.classList.add('show');
  }

  function commentAvatarHtml(name, avatarUrl){
    const initials = (name || 'You').trim().split(/\s+/).map(part => part[0]).join('').slice(0,2).toUpperCase() || 'YU';
    return avatarUrl ? `<img src="${avatarUrl}" alt="${escapeHtml(name)}">` : escapeHtml(initials);
  }

  // Discord-style reply: a small dismissible bar above whichever form is
  // actively composing, showing who/what is being replied to. Stored
  // directly on the form element (form._replyTarget) rather than in a
  // shared variable, since several forms can exist at once (the hero
  // card's own box, the "see all" sheet, and one per clip card) and each
  // needs to track its own in-progress reply independently.
  function setReplyTarget(form, target, focusField = true){
    if (!form) return;
    form._replyTarget = target;
    let bar = form.querySelector('.reply-target-bar');
    if (!target) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'reply-target-bar';
      form.insertBefore(bar, form.firstChild);
    }
    bar.innerHTML = `<span class="reply-target-info"><span class="reply-quote-avatar">${commentAvatarHtml(target.name, target.avatarUrl)}</span><span>Replying to <b>${escapeHtml(target.name)}</b>: ${escapeHtml(target.text)}</span></span><button type="button" class="reply-target-clear" aria-label="Cancel reply">&times;</button>`;
    bar.querySelector('.reply-target-clear').addEventListener('click', () => setReplyTarget(form, null));
    // Skippable: when this call is opening the full comments page for the
    // first time, that page schedules its own focus once its slide-in
    // transition and content render are actually done (see
    // openCommentsModal's setTimeout below). Focusing here too, on top of
    // that, raced the keyboard-docking logic against a page that hadn't
    // finished laying itself out yet, and the composer landed in the
    // wrong spot as a result.
    if (focusField) form.querySelector('input')?.focus();
  }

  // Reconciles listEl's children against `items` in place — reusing any
  // element already rendered for a key instead of tearing the whole list
  // down and rebuilding it from scratch on every Firestore snapshot.
  // Before this, renderCommentsPreview/renderCommentsModalList did
  // `listEl.innerHTML = ''` on every single update (including ones caused
  // by someone ELSE'S comment landing elsewhere in the same thread), which
  // meant every visible comment avatar re-ran its decoration/font lookups,
  // and — worse — any equipped particle-effect decoration
  // (attachDecoration → applyDecorationToContainer → activateCanvasFx)
  // started a brand-new canvas + requestAnimationFrame loop while the OLD
  // canvas, still referenced by AvatarEffect.instances, never got a
  // matching deactivateCanvasFx() call because it was destroyed via
  // innerHTML wipe rather than being removed element-by-element. Those
  // orphaned rAF loops just kept accumulating for the rest of the session,
  // each one costing a tick + a draw every frame — which is exactly the
  // kind of thing that would make the app measurably less smooth the more
  // it's used (and adding threaded replies made comments update more
  // often, so it got worse, not "just yesterday's imagination"). Reusing
  // untouched comment elements avoids all of that: their canvases, cached
  // decoration/font lookups, and reply click-handlers all stay exactly as
  // they were, and only genuinely new/removed comments touch the DOM.
  function reconcileKeyedList(listEl, items, getKey, createEl){
    let keyedEls = listEl._keyedEls;
    if (!keyedEls) { keyedEls = new Map(); listEl._keyedEls = keyedEls; }
    const seen = new Set();
    let prevNode = null;
    items.forEach(item => {
      const key = getKey(item);
      seen.add(key);
      let el = keyedEls.get(key);
      if (!el) {
        el = createEl(item);
        keyedEls.set(key, el);
      }
      const afterNode = prevNode ? prevNode.nextSibling : listEl.firstChild;
      if (afterNode !== el) listEl.insertBefore(el, afterNode);
      prevNode = el;
    });
    keyedEls.forEach((el, key) => {
      if (seen.has(key)) return;
      deactivateCanvasFx(el); // stop any running particle-effect canvas before it's torn out
      el.remove();
      keyedEls.delete(key);
    });
  }

  function renderCommentEl(data, thread, onReply){
    const el = document.createElement('div');
    el.className = 'comment';
    el.dataset.commentId = data.id || '';
    el.dataset.parentType = thread?.type === 'clip' ? 'clip' : 'matchup';
    el.dataset.parentId = thread?.commentsFor || '';
    const replyQuote = data.replyToName
      ? `<div class="comment-reply-quote"><span class="reply-connector"></span><span class="reply-quote-avatar">${commentAvatarHtml(data.replyToName, data.replyToAvatarUrl)}</span><span>Replying to <b>${escapeHtml(data.replyToName)}</b>: ${escapeHtml(data.replyToText || '')}</span></div>`
      : '';
    const stickerMarkup = data.stickerId
      ? `<span class="comment-sticker">${stickerHtml(data.stickerId)}</span>`
      : '';
    // Reaction pills are filled in and kept live by refreshReactionPills()
    // (see the reactions listener below) rather than rendered here — this
    // element just needs to exist so that pass has somewhere to write to,
    // and the "React" button itself never needs to be re-rendered on a
    // reaction update the way the pills next to it do.
    el.innerHTML = `<div class="comment-avatar" data-uid="${escapeHtml(data.uid || '')}" data-name="${escapeHtml(data.name || '')}" data-avatar="${escapeHtml(data.avatarUrl || '')}">${commentAvatarHtml(data.name, data.avatarUrl)}</div><div class="comment-body">${replyQuote}<b>${escapeHtml(data.name || 'You')}<span class="verified-badge" title="Verified" style="display:none;">${VERIFIED_BADGE_SVG}</span></b><span>${escapeHtml(data.text || '')}</span>${stickerMarkup}<div class="comment-actions-row"><button type="button" class="comment-reply-btn">Reply</button><button type="button" class="comment-react-btn" aria-label="React with a sticker">${STICKER_TOGGLE_ICON}</button><span class="comment-reactions"></span></div></div>`;
    attachVerifiedBadge(el.querySelector('.verified-badge'), data.uid);
    attachDecoration(el.querySelector('.comment-avatar'), data.uid);
    attachFont(el.querySelector('.comment-body b'), data.uid);
    attachLiveIdentity(data.uid, el.querySelector('.comment-body b'), el.querySelector('.comment-avatar'));
    if (onReply) {
      el.querySelector('.comment-reply-btn').addEventListener('click', () => {
        // Truncated to keep the quoted snippet compact — matches how
        // Discord's own reply preview clips long messages.
        const snippet = (data.text || '').length > 80 ? data.text.slice(0, 80) + '…' : (data.text || '');
        onReply(data.name || 'User', snippet, data.avatarUrl || null, data.uid || null);
      });
    }
    return el;
  }

  // ---------- comments: 2-visible preview + shared "see all" sheet ----------
  // Every comment thread on the board (the hero matchup card, and each
  // clip card) only ever shows its most recent 2 comments inline — full
  // history lives one tap away in #commentsModalOverlay instead of pushing
  // the whole feed down as a thread grows, which is what was making long
  // posts feel heavy to scroll past.
  const COMMENTS_PREVIEW_LIMIT = 2;
  const commentsModalOverlay = document.getElementById('commentsModalOverlay');
  const commentsModalList = document.getElementById('commentsModalList');
  const commentsModalSub = document.getElementById('commentsModalSub');
  const commentsModalForm = document.getElementById('commentsModalForm');
  const commentsModalInput = document.getElementById('commentsModalInput');
  const commentsModalClose = document.getElementById('commentsModalClose');
  const commentsTabComments = document.getElementById('commentsTabComments');
  const commentsTabReplies = document.getElementById('commentsTabReplies');
  let openCommentsThread = null; // the thread object currently shown in the sheet, if any
  // Which half of the sheet is showing — top-level comments, or replies
  // (anything with a replyToName). Kept separate so a growing reply thread
  // never lengthens the comments list the input sits under.
  let commentsModalTab = 'comments';

  function switchCommentsTab(tab){
    commentsModalTab = tab;
    commentsTabComments.classList.toggle('active', tab === 'comments');
    commentsTabReplies.classList.toggle('active', tab === 'replies');
    renderCommentsModalList();
  }
  commentsTabComments.addEventListener('click', () => switchCommentsTab('comments'));
  commentsTabReplies.addEventListener('click', () => switchCommentsTab('replies'));

  // `thread` is a small { type, commentsFor, label, docs } object owned by
  // whoever's watching this comment collection (hero card or a clip card).
  // Renders the capped preview into `listEl` and keeps `thread.docs`
  // current so the sheet has the full list ready the moment it's opened.
  // Stable identity for a comment doc, used to decide whether a snapshot
  // update touches a given comment at all. Firestore's own doc id is used
  // when present; the fallback only fires for stray callers that haven't
  // been updated to carry `id` through (kept so a missing id degrades to
  // "always re-render this one" instead of throwing).
  function commentKey(data){
    return data.id || `${data.uid || ''}:${data.createdAt?.toMillis?.() || ''}:${data.text || ''}`;
  }

  function renderCommentsPreview(listEl, docs, thread){
    thread.docs = docs;
    // Replying from the compact 2-comment preview opens the full sheet
    // instead of composing right there — that tiny inline box is meant
    // for a quick top-level comment, not for holding a quoted reply bar
    // on top of an already-cramped card.
    // Only top-level comments belong in this inline "Conversation" preview —
    // replies live exclusively behind the Replies tab in the full sheet
    // (see switchCommentsTab/renderCommentsModalList below). Without this
    // filter, `docs` is the full comments+replies list, so whichever two
    // items happened to be posted most recently could easily be replies,
    // making them show up inline here even though they belong in their own
    // tab — filter them out before slicing to the last two.
    const preview = docs.filter(data => !data.replyToName).slice(-COMMENTS_PREVIEW_LIMIT);
    reconcileKeyedList(listEl, preview, commentKey, data => renderCommentEl(data, thread, (name, text, avatarUrl, uid) => {
      openCommentsModal(thread);
      switchCommentsTab('replies');
      setReplyTarget(commentsModalForm, { name, text, avatarUrl, uid }, false);
    }));
    listEl.classList.remove('scrollable'); // capped at 2 — never tall enough to need its own scroll now
    let moreBtn = listEl.nextElementSibling;
    if (!moreBtn || !moreBtn.classList.contains('see-more-comments')) {
      moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'see-more-comments';
      moreBtn.addEventListener('click', () => openCommentsModal(thread));
      listEl.after(moreBtn);
    }
    if (docs.length > COMMENTS_PREVIEW_LIMIT) {
      moreBtn.textContent = `See all ${docs.length} comments`;
      moreBtn.style.display = '';
    } else {
      moreBtn.style.display = 'none';
    }
    // Sheet is already open on this exact thread (e.g. a new comment just
    // streamed in) — keep it live instead of waiting for a re-open.
    if (openCommentsThread === thread) renderCommentsModalList();
  }

  function renderCommentsModalList(){
    const allDocs = openCommentsThread ? openCommentsThread.docs : [];
    const docs = allDocs.filter(data => commentsModalTab === 'replies' ? !!data.replyToName : !data.replyToName);
    if (!docs.length) {
      // Empty state replaces the list wholesale — nothing here to preserve
      // a diff against, and it also drops any stale keyed-element map from
      // a previous non-empty render of this same list/tab.
      commentsModalList._keyedEls?.forEach(el => deactivateCanvasFx(el));
      commentsModalList._keyedEls = null;
      commentsModalList.innerHTML = commentsModalTab === 'replies'
        ? '<div class="comments-modal-empty">No replies yet.</div>'
        : '<div class="comments-modal-empty">No comments yet — be the first.</div>';
      return;
    }
    // Clears any leftover placeholder before reconciling in the real
    // comments — must match BOTH states openCommentsModal/this function
    // can leave behind: the initial ".comments-modal-loading" spinner
    // (written synchronously when the sheet opens, before docs are known)
    // and ".comments-modal-empty" (written by the branch above). Missing
    // either one leaves it as an untracked, un-keyed node that
    // reconcileKeyedList never touches — it just gets pushed below the
    // real comments and sits there permanently instead of disappearing.
    if (commentsModalList.querySelector('.comments-modal-empty, .comments-modal-loading')) commentsModalList.innerHTML = '';
    // Only auto-stick to the bottom if the person was already reading the
    // latest message (or the list just opened) — otherwise a comment
    // landing elsewhere in a long thread would yank them away from
    // whatever they were reading, on top of previously re-rendering the
    // whole list every time.
    const wasNearBottom = commentsModalList.scrollHeight - commentsModalList.scrollTop - commentsModalList.clientHeight < 60;
    reconcileKeyedList(commentsModalList, docs, commentKey, data => renderCommentEl(data, openCommentsThread, (name, text, avatarUrl, uid) => {
      // Replying jumps to the Replies tab — that's where the composed
      // reply will land once posted, and where the quote thread lives,
      // instead of nesting it back into the comments list it was opened from.
      switchCommentsTab('replies');
      setReplyTarget(commentsModalForm, { name, text, avatarUrl, uid });
    }));
    if (wasNearBottom) commentsModalList.scrollTop = commentsModalList.scrollHeight;
  }

  // Scrolls a specific comment/reply into view inside the sheet and gives
  // it a brief highlight flash — used by the reply-notification click
  // handler below so tapping "X replied to you" lands on the actual reply
  // instead of just opening the sheet at the top. Polls for a bit instead
  // of assuming the comment is already rendered: the sheet's list is
  // filled in asynchronously (Firestore listener + the tab switch's own
  // re-render), so the element may not exist in the DOM yet on the first
  // check.
  function highlightModalComment(commentId){
    if (!commentId) return;
    let attempts = 0;
    const tryFind = () => {
      const el = commentsModalList.querySelector(`.comment[data-comment-id="${CSS.escape(commentId)}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('comment-highlight');
        setTimeout(() => el.classList.remove('comment-highlight'), 2200);
      } else if (attempts < 12) {
        attempts++;
        setTimeout(tryFind, 200);
      }
    };
    tryFind();
  }
  function openCommentsModal(thread){
    openCommentsThread = thread;
    commentsModalTab = 'comments';
    commentsTabComments.classList.add('active');
    commentsTabReplies.classList.remove('active');
    commentsModalSub.textContent = thread.label || 'All comments on this post.';
    commentsModalForm.dataset.commentsFor = thread.commentsFor || '';
    commentsModalForm.dataset.commentsType = thread.type;
    // Reading/replying in the full sheet shouldn't have the hero card
    // switch to a different matchup underneath them — same pause as
    // checking AI stats, for as long as the sheet is open on this thread.
    if (thread.type === 'hero') { heroCommentsActive = true; scheduleHeroRotate(); }
    // Show a spinner first, then swap in the real list a beat later —
    // same loading-then-content pattern as the leaderboard sheet — instead
    // of the list flashing in empty/blank while the sheet is still sliding up.
    commentsModalList.innerHTML = '<div class="comments-modal-loading"><span class="btn-spinner" style="border-color:var(--line);border-top-color:var(--accent);"></span>Loading comments…</div>';
    commentsModalOverlay.classList.add('show');
    requestAnimationFrame(() => requestAnimationFrame(renderCommentsModalList));
    // Lock the page underneath while the sheet is open — same pattern as
    // the reels player. Without this, focusing the input below pulls the
    // still-scrollable page behind it along for the ride: the browser
    // scrolls the nearest scroll container (.phone-scroll) to bring the
    // input into view, which fights the sheet's own slide-up transform and
    // leaves the sheet stranded near the top with a blank void beneath it.
    document.querySelector('.phone-scroll').style.overflow = 'hidden';
    // Wait for the .25s slide-up transition to finish before focusing —
    // focusing mid-transition is what triggers that scroll fight, and it
    // also pops the keyboard before the sheet has settled into place.
    setTimeout(() => commentsModalInput.focus(), 300);
  }
  function closeCommentsModal(){
    commentsModalOverlay.classList.remove('show');
    openCommentsThread = null;
    setReplyTarget(commentsModalForm, null);
    document.querySelector('.phone-scroll').style.overflow = '';
    // The sheet can close while its input still has focus (e.g. tapping
    // "Back" right after typing) — blur() alone only starts an async
    // focusout, so also force the docked-composer cleanup directly here
    // rather than hoping that event lands. Without this, the input kept
    // logical focus, the global focusout listener that undocks the
    // composer never fired, and the fixed-position comment bar was left
    // floating — at whatever height the keyboard last measured — on top
    // of whatever screen opened next.
    if (document.activeElement === commentsModalInput) commentsModalInput.blur();
    document.body.classList.remove('keyboard-open');
    undockCommentField(commentsModalForm);
    // Done reading/replying — safe for the hero card to resume rotating
    // again (no-op if this was a clip thread, since it was never paused).
    heroCommentsActive = false;
    scheduleHeroRotate();
  }
  commentsModalClose.addEventListener('click', closeCommentsModal);
  commentsModalOverlay.addEventListener('click', event => {
    if (event.target === commentsModalOverlay) closeCommentsModal();
  });

  // ---------- profile card (Discord-style) ----------
  // Opened by tapping any comment or leaderboard avatar — shows that
  // account's current picture, name, decoration, verified badge, and bio.
  // Everything except the bio is already cached by the helpers above; the
  // bio itself is fetched fresh each time the card opens since it's not
  // otherwise kept in memory anywhere.
  const userProfileOverlay = document.getElementById('userProfileOverlay');
  const userProfileBanner = document.getElementById('userProfileBanner');
  const userProfileAvatar = document.getElementById('userProfileAvatar');
  const userProfileNameText = document.getElementById('userProfileNameText');
  const userProfileVerified = document.getElementById('userProfileVerified');
  const userProfileHandle = document.getElementById('userProfileHandle');
  const userProfileLoading = document.getElementById('userProfileLoading');
  const userProfileBio = document.getElementById('userProfileBio');
  const userProfileBioText = document.getElementById('userProfileBioText');
  const userProfileCardFxCanvas = document.getElementById('userProfileCardFxCanvas');

  function closeUserProfileCard(){
    userProfileOverlay.classList.remove('show');
    // Stop the card-fx loop when the sheet closes, same contract as every
    // other card-fx-canvas — no point animating an offscreen canvas.
    if (userProfileCardFxCanvas) deactivateCardFx(userProfileCardFxCanvas.parentElement);
  }
  document.getElementById('userProfileClose').addEventListener('click', closeUserProfileCard);
  userProfileOverlay.addEventListener('click', event => {
    if (event.target === userProfileOverlay) closeUserProfileCard();
  });

  // `fallback` carries whatever the triggering avatar already had on hand
  // (name/avatarUrl from the comment or leaderboard row) so the card has
  // something to show instantly, before the Firestore doc comes back.
  function openUserProfileCard(uid, fallback){
    if (!uid) return;
    fallback = fallback || {};
    // Set once, lazily, on first open — by now the rest of the script
    // (including the VERIFIED_BADGE_SVG constant, declared further down)
    // has finished running, so it's safe to read here.
    if (!userProfileVerified.innerHTML) userProfileVerified.innerHTML = VERIFIED_BADGE_SVG;
    if (userProfileBanner) userProfileBanner.style.backgroundImage = '';
    userProfileAvatar.className = 'user-profile-avatar';
    userProfileAvatar.innerHTML = commentAvatarHtml(fallback.name, fallback.avatarUrl);
    userProfileNameText.textContent = fallback.name || 'User';
    PROFILE_FONTS.forEach(font => userProfileNameText.classList.remove(font.cls));
    userProfileHandle.textContent = '';
    userProfileVerified.style.display = 'none';
    userProfileBio.hidden = true;
    userProfileBioText.textContent = '';
    userProfileLoading.style.display = 'block';
    if (userProfileCardFxCanvas) {
      deactivateCardFx(userProfileCardFxCanvas.parentElement);
      delete userProfileCardFxCanvas.dataset.fxType;
    }
    attachDecoration(userProfileAvatar, uid);
    attachFont(userProfileNameText, uid);
    attachVerifiedBadge(userProfileVerified, uid);
    userProfileOverlay.classList.add('show');
    getDoc(doc(db, 'users', uid)).then(snap => {
      if (!snap.exists()) { userProfileLoading.textContent = 'This account no longer exists.'; return; }
      const data = snap.data();
      userProfileLoading.style.display = 'none';
      if (data.name) userProfileNameText.textContent = data.name;
      if (data.handle) userProfileHandle.textContent = data.handle;
      if (data.avatarUrl) userProfileAvatar.innerHTML = commentAvatarHtml(data.name, data.avatarUrl);
      if (userProfileBanner) {
        userProfileBanner.style.backgroundImage = data.coverPhotoUrl
          ? `linear-gradient(to bottom, rgba(10,8,6,0) 55%, rgba(10,8,6,.75) 100%), url('${data.coverPhotoUrl}')`
          : '';
      }
      // Re-apply the decoration on top of the freshly-set avatar markup
      // above, since setting .innerHTML just now would have wiped it out.
      attachDecoration(userProfileAvatar, uid);
      // Full card customization: this account's equipped name font and
      // card effect, straight from the doc we already have in hand —
      // no need for the separate uid-keyed caches used elsewhere.
      PROFILE_FONTS.forEach(font => userProfileNameText.classList.remove(font.cls));
      const nameFont = fontById(data.equippedFont);
      if (nameFont) userProfileNameText.classList.add(nameFont.cls);
      if (userProfileCardFxCanvas) {
        deactivateCardFx(userProfileCardFxCanvas.parentElement);
        const effect = cardEffectById(data.equippedCardEffect);
        if (effect) {
          userProfileCardFxCanvas.dataset.fxType = effect.canvasType;
          activateCardFx(userProfileCardFxCanvas.parentElement);
        } else {
          delete userProfileCardFxCanvas.dataset.fxType;
        }
      }
      const bio = (data.bio || '').trim();
      userProfileBio.hidden = false;
      userProfileBioText.textContent = bio;
      userProfileBioText.className = bio ? '' : 'user-profile-bio-empty';
      if (!bio) userProfileBioText.textContent = 'No bio yet.';
    }).catch(err => {
      console.error('Profile card load failed', err);
      userProfileLoading.textContent = 'Could not load this profile.';
    });
  }

  // Event delegation — comments and leaderboard rows are re-rendered
  // constantly (new comments streaming in, leaderboard refreshes), so
  // binding once on a stable ancestor beats re-attaching a listener to
  // every avatar every time the list redraws.
  document.addEventListener('click', event => {
    const avatar = event.target.closest('.comment-avatar[data-uid], .leaderboard-avatar[data-uid]');
    if (!avatar || !avatar.dataset.uid) return;
    openUserProfileCard(avatar.dataset.uid, { name: avatar.dataset.name, avatarUrl: avatar.dataset.avatar });
  });
  commentsModalForm.addEventListener('submit', event => {
    event.preventDefault();
    if (commentsModalForm.dataset.commentsType === 'hero') {
      const text = commentsModalInput.value.trim();
      if (!text && !commentsModalForm._attachedSticker) return;
      commentsModalInput.value = '';
      postHeroComment(text, commentsModalForm).catch(() => { commentsModalInput.value = text; });
    } else {
      // Clip threads: addComment() reads dataset.commentsFor plus the
      // form's own input (reading, clearing, and restoring it on failure
      // itself), so it works fine on this sheet's form even though it
      // isn't nested inside a .clip-card.
      addComment(commentsModalForm);
    }
  });

  // Live-syncs one clip's comment thread from Firestore. Safe to call more
  // than once for the same clipId/form pair (guarded by a flag on the form).
  const wiredCommentForms = new WeakSet();
  const commentUnsubscribes = new Map(); // clipId -> unsubscribe fn, closed on delete so it stops costing reads
  const reactionUnsubscribes = new Map(); // clipId -> reactions unsubscribe fn, same lifecycle as commentUnsubscribes
  const clipCommentThreads = new Map(); // clipId -> thread object, so a reply notification can reopen the right sheet
  function wireClipComments(clipId, form){
    if (!clipId || wiredCommentForms.has(form)) return;
    wiredCommentForms.add(form);
    // Comments live in a wrapper just before the form, not loose in the
    // card, so the preview-cap logic has a single element to render into —
    // same pattern as the hero card.
    let list = form.previousElementSibling;
    if (!list || !list.classList.contains('hero-comments-list')) {
      list = document.createElement('div');
      list.className = 'hero-comments-list';
      form.parentNode.insertBefore(list, form);
    }
    const thread = { type: 'clip', commentsFor: clipId, label: 'All comments on this clip.', docs: [], form };
    clipCommentThreads.set(clipId, thread);
    const unsubscribe = onSnapshot(
      query(collection(db, 'movieClips', clipId, 'comments'), orderBy('createdAt', 'asc')),
      snapshot => {
        const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        renderCommentsPreview(list, docs, thread);
      },
      err => console.error('Comments listener failed', err)
    );
    commentUnsubscribes.set(clipId, unsubscribe);
    reactionUnsubscribes.set(clipId, watchReactionsFor(clipId, thread, list));
  }

  async function addComment(form){
    const clipId = form.dataset.commentsFor;
    const input = form.querySelector('input');
    const text = input.value.trim();
    const stickerId = form._attachedSticker || null;
    if (!text && !stickerId) return;
    const user = auth.currentUser;
    if (!user) { requireSignIn('Sign in to comment'); return; }
    const replyTarget = form._replyTarget || null;
    input.value = '';
    // See postHeroComment above — navigator.vibrate needs live user
    // activation, which the awaited fetch below outlives, so this has to
    // fire here rather than after the response comes back.
    haptic('tap');
    // Server-authoritative post via /api/clip-comment — verifies identity
    // and pulls the poster's real profile fields server-side. No longer
    // awards XP (win-only now). Direct Firestore writes to this
    // subcollection are rejected by the security rules.
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/clip-comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify({ clipId, text, replyTo: replyTarget, stickerId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Comment failed');
      setReplyTarget(form, null);
      clearAttachedSticker(form);
      // Only bump locally if the server actually sent xpAwarded.
      if (data.xpAwarded) {
        currentUserXp += data.xpAwarded;
        currentUserWeeklyXp += data.xpAwarded;
        renderVerifiedProgress();
      }
      showXpToast(data.xpAwarded, data.rank);
    } catch (err) {
      console.error('Comment post failed', err);
      input.value = text;
      showToast('Could not post comment — try again');
    }
  }

  clipFeed.addEventListener('submit', event => {
    event.preventDefault();
    addComment(event.target);
  });

  // Wire up the three built-in demo clips' comment threads immediately.
  clipFeed.querySelectorAll('.comment-form[data-comments-for]').forEach(form => {
    wireClipComments(form.dataset.commentsFor, form);
  });

  // Same for their like/share buttons, seeded with a starting count each
  // so they don't just read "0" before anyone's tapped one.
  const CLIP_BASE_LIKES = { featured: 142, hallway: 89, twist: 203 };
  clipFeed.querySelectorAll('.clip-card[data-clip-id]').forEach(card => {
    const id = card.dataset.clipId;
    wireClipSocial(id, card, CLIP_BASE_LIKES[id] || 0);
  });

  // Deep-link support: a shared clip URL looks like ?clip=<clipId>. Built-in
  // demo clips are in the DOM immediately; community clips stream in async
  // below, so this is safe to call repeatedly — it only acts once, then
  // gets out of the way. Opens the Movies Hub (reusing the same nav-item
  // click the person would use manually) and drops straight into the reels player.
  let sharedClipHandled = false;
  function tryOpenSharedClip(){
    if (sharedClipHandled) return;
    const id = new URLSearchParams(location.search).get('clip');
    if (!id) { sharedClipHandled = true; return; }
    const card = clipFeed.querySelector(`.clip-card[data-clip-id="${id}"]`);
    if (!card) return; // might still be streaming in (community clip) — try again on the next snapshot
    const thumb = card.querySelector('.clip-thumb');
    if (!thumb || !thumb.dataset.videoSrc) { sharedClipHandled = true; return; } // demo card, no real video yet
    sharedClipHandled = true;
    const moviesNav = document.querySelector('.nav-item[data-nav="Movies"]');
    if (moviesNav) moviesNav.click();
    openReelsPlayer(thumb);
  }
  tryOpenSharedClip(); // covers built-in demo clips, already in the DOM at this point

  publishClip.addEventListener('click', async () => {
    const rawLink = clipYoutubeUrl.value;
    const parsed = parseClipLink(rawLink);
    const title = clipTitle.value.trim();
    const review = clipReview.value.trim();
    if (!parsed) {
      showToast('Paste a valid YouTube link first');
      return;
    }
    if (!title || !review) {
      showToast('Add a title and review');
      return;
    }
    const identity = currentUserIdentity();
    if (!identity) { requireSignIn('Sign in to post a clip'); return; }
    withSpinner(publishClip, 'SUBMITTING…', () => {
      // Goes to a review queue, not straight onto the public movieClips
      // list (that collection now rejects direct client writes — see
      // rules). An admin approves/rejects from the moderation panel in
      // Account, which is what actually creates the live "movieClips" doc.
      addDoc(collection(db, 'pendingClips'), {
        title, review, videoPlatform: parsed.platform, videoId: parsed.id, isShort: !!parsed.isShort,
        postedByUid: identity.uid, postedByName: identity.name, postedByAvatar: identity.avatarUrl,
        createdAt: serverTimestamp()
      })
        .then(() => {
          clipYoutubeUrl.value = '';
          clipFileName.textContent = 'Paste a YouTube Shorts link for best results';
          clipTitle.value = '';
          clipReview.value = '';
          clipUploaderOverlay.classList.remove('show');
          showToast('Clip submitted — pending review');
        })
        .catch(err => {
          console.error('Clip submission failed', err);
          showToast('Could not submit that clip — check your connection and try again');
        });
    }, 500);
  });

  // Real-time: community-posted clips (from any browser) render here,
  // newest first, above the three built-in demo clips.
  const renderedClipIds = new Set();
  const HIDDEN_CLIPS_KEY = 'fictionClashHiddenClips'; // clips (including built-in demo ones) this browser chose to hide
  const hiddenClipIds = new Set(JSON.parse(localStorage.getItem(HIDDEN_CLIPS_KEY) || '[]'));
  // The 3 built-in demo clips have no Firestore doc, so apply any
  // previously-hidden choice for them directly against their markup.
  hiddenClipIds.forEach(id => {
    const card = clipFeed.querySelector(`.clip-card[data-clip-id="${id}"]`);
    if (card) card.remove();
  });

  // 2 shimmering placeholder cards shown until the first clip streams in —
  // there's no hardcoded seed video anymore, so without this the Movies
  // Hub would just be blank on a fresh load. Cleared the moment either a
  // real clip arrives or the listener finishes synced-and-empty.
  const CLIP_SKELETON_HTML = `<article class="clip-card skeleton" data-skeleton="1">
      <div class="skel-thumb skeleton-block"></div>
      <h3 class="skel-h3 skeleton-block"></h3>
      <div class="skel-p skeleton-block"></div>
      <div class="skel-p short skeleton-block"></div>
    </article>`;
  clipFeed.insertAdjacentHTML('beforeend', CLIP_SKELETON_HTML + CLIP_SKELETON_HTML);
  function clearClipSkeletons(){
    clipFeed.querySelectorAll('.clip-card.skeleton').forEach(el => el.remove());
  }

  let clipsSynced = false; // true once the initial replay-everything snapshot has finished
  const clipFeedLoadingMore = document.getElementById('clipFeedLoadingMore');
  clipFeedLoadingMore.classList.add('show'); // visible until the first snapshot resolves, however fast that is
  onSnapshot(
    query(collection(db, 'movieClips'), orderBy('createdAt', 'desc')),
    snapshot => {
      const changes = snapshot.docChanges();
      if (changes.some(c => c.type === 'added')) clearClipSkeletons();
      changes.filter(c => c.type === 'removed').forEach(change => {
        const id = change.doc.id;
        renderedClipIds.delete(id);
        const card = clipFeed.querySelector(`.clip-card[data-clip-id="${id}"]`);
        if (card) { deactivateCanvasFx(card); card.remove(); } // stop any comment avatar's particle-effect canvas before the card goes
        const unsubscribe = commentUnsubscribes.get(id);
        if (unsubscribe) { unsubscribe(); commentUnsubscribes.delete(id); }
        const reactionUnsub = reactionUnsubscribes.get(id);
        if (reactionUnsub) { reactionUnsub(); reactionUnsubscribes.delete(id); }
      });
      // The query is already newest-first, but clipFeed.prepend() puts
      // each new card at the very top as it's processed — so looping
      // through an "added" batch in query order (newest → oldest) ends up
      // flipping the visual order, since the oldest one in the batch gets
      // prepended LAST and lands above everything else. Reversing the
      // batch before prepending fixes it: the oldest of the batch goes in
      // first, then progressively newer ones land on top of it, so the
      // final stack reads newest-first exactly like the query intended.
      changes.filter(c => c.type === 'added').reverse().forEach(change => {
        const id = change.doc.id;
        if (renderedClipIds.has(id)) return;
        {
          const data = change.doc.data();
          // Same TTL workaround as matchups — no Blaze plan means no
          // Firestore-side auto-delete, so just don't render clips
          // that are already past their expiresAt.
          if (data.expiresAt && data.expiresAt.toMillis() < Date.now()) return;
          // This browser hid this clip before — Firestore still has it
          // for everyone else, we just don't render it here.
          if (hiddenClipIds.has(id)) return;
          const card = document.createElement('article');
          card.className = 'clip-card';
          card.dataset.clipId = id;
          // videoPlatform/videoId is the current field pair; youtubeId is
          // kept as a fallback so clips posted before this field existed
          // still render correctly.
          const platform = data.videoPlatform || (data.youtubeId ? 'youtube' : '');
          const videoId = escapeHtml(data.videoId || data.youtubeId || '');
          const posterStyle = platform === 'youtube'
            ? ` style="background-image:url('https://img.youtube.com/vi/${videoId}/hqdefault.jpg')"`
            : '';
          card.innerHTML = `
            <div class="clip-thumb" data-video-type="${platform}" data-video-src="${videoId}" data-is-short="${!!data.isShort}"${posterStyle}>
              <button type="button" class="clip-play-btn" aria-label="Play video">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              </button>
            </div>
            <h3>${escapeHtml(data.title || '')}</h3>
            <p class="clip-review">${escapeHtml(data.review || '')}</p>
            <div class="clip-meta"><span class="clip-posted-by">Posted by ${escapeHtml(data.postedByName || 'A fan')}</span><button type="button" class="clip-delete-btn" data-hide-clip="${id}">Hide</button></div>
            <div class="social-row">
              <button class="social-btn like-btn" type="button" aria-label="Like this clip">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>
                <span class="like-count">0</span>
              </button>
              <button class="social-btn share-btn" type="button" aria-label="Share this clip">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/></svg>
                <span>Share</span>
              </button>
            </div>
            <div class="comments-title"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg><span>Conversation</span></div>
            <div class="hero-comments-list"></div>
            <form class="comment-form" data-comments-for="${id}">
              <button type="button" class="sticker-toggle-btn" aria-label="Add sticker">${STICKER_TOGGLE_ICON}</button>
              <input class="clip-field" type="text" placeholder="Add your comment..." aria-label="Add your comment">
              <button type="submit" aria-label="Post comment"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg></button>
            </form>`;
          clipFeed.prepend(card);
          wireClipComments(id, card.querySelector('.comment-form'));
          wireClipSocial(id, card, 0);
          renderedClipIds.add(id);
          // Same live-lookup treatment as comments — refresh the poster's
          // name here too if it's changed since this clip was posted.
          if (data.postedByUid) {
            getLiveNameAvatar(data.postedByUid).then(info => {
              if (info && info.name) card.querySelector('.clip-posted-by').textContent = `Posted by ${info.name}`;
            });
          }
          if (clipsSynced) pushNotification('clip', 'New clip posted', data.title || 'A new clip', id);
        }
      });
      clipsSynced = true;
      clipFeedLoadingMore.classList.remove('show');
      if (renderedClipIds.size === 0) {
        clearClipSkeletons();
        if (!clipFeed.querySelector('.clips-empty-state')) {
          clipFeed.insertAdjacentHTML('beforeend', '<div class="comments-modal-empty clips-empty-state">No clips yet — be the first to post one.</div>');
        }
      } else {
        clipFeed.querySelector('.clips-empty-state')?.remove();
      }
      tryOpenSharedClip();
    },
    err => console.error('Movie clips listener failed', err)
  );

  // "Hide" only affects this browser — it removes the card locally and
  // remembers the choice in localStorage, but never touches Firestore, so
  // the clip stays fully visible to everyone else.
  // No hardcoded clips exist anymore (every clip has a real Firestore doc),
  // so this stays empty — kept only so the admin-delete branch below still
  // has somewhere to check, in case built-ins ever come back.
  const BUILT_IN_CLIP_IDS = new Set();
  clipFeed.addEventListener('click', event => {
    const btn = event.target.closest('[data-hide-clip]');
    if (!btn) return;
    const clipId = btn.dataset.hideClip;
    if (isAdmin() && !BUILT_IN_CLIP_IDS.has(clipId)) {
      // Admin account, community clip — actually deletes the doc from
      // Firestore, so the clip disappears for every visitor, not just this browser.
      if (!confirm('Delete this clip for everyone? This can\'t be undone.')) return;
      deleteDoc(doc(db, 'movieClips', clipId)).catch(err => {
        console.error('Clip delete failed', err);
        showToast('Could not delete — try again');
      });
      // Card removal + comment-listener cleanup happen via the onSnapshot 'removed' handler.
      return;
    }
    if (isAdmin() && BUILT_IN_CLIP_IDS.has(clipId)) {
      // Admin account, built-in clip — there's no Firestore doc to delete
      // (it's hardcoded in the app), so instead its id gets added to the
      // shared hiddenBuiltins doc. Every client, including this one, is
      // listening to that doc and will remove the card — a real
      // delete-for-everyone, not just a local hide.
      if (!confirm('Remove this clip for everyone? This is a built-in clip, so it\'ll be hidden from all users everywhere, not just this device. This can\'t be undone.')) return;
      setDoc(doc(db, 'appConfig', 'hiddenBuiltins'), { clipIds: arrayUnion(clipId) }, { merge: true }).catch(err => {
        console.error('Global hide failed', err);
        showToast('Could not remove — try again');
      });
      // The card removes itself once the hiddenBuiltins listener picks this up.
      return;
    }
    if (!confirm("Hide this clip from your feed? It'll stay visible to everyone else.")) return;
    hiddenClipIds.add(clipId);
    localStorage.setItem(HIDDEN_CLIPS_KEY, JSON.stringify([...hiddenClipIds]));
    const card = clipFeed.querySelector(`.clip-card[data-clip-id="${clipId}"]`);
    if (card) { deactivateCanvasFx(card); card.remove(); }
    renderedClipIds.delete(clipId);
    // Stop listening to this clip's comments on this browser too, since we
    // don't need live updates for something we're not showing anymore.
    const unsubscribe = commentUnsubscribes.get(clipId);
    if (unsubscribe) { unsubscribe(); commentUnsubscribes.delete(clipId); }
    showToast('Hidden from your feed');
  });


  // ---------- news hub ----------
  const newsSection = document.getElementById('newsSection');
  const newsDateEl = document.getElementById('newsDate');
  if (newsDateEl) {
    const today = new Date();
    const weekday = today.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
    const month = today.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
    newsDateEl.innerHTML = `${weekday}<br>${month} ${today.getDate()}`;
  }
  const newsFeed = document.getElementById('newsFeed');
  const newsFeedHeading = document.getElementById('newsFeedHeading');

  // Used as: (1) an offline/error fallback if /api/news fails, and
  // (2) what's shown instantly while the real fetch is in flight, so the
  // tab never looks empty. Real stories, once loaded, replace these.
  const fallbackNewsStories = {
    'Music': [
      { tag: 'MUSIC · NEW RELEASE', title: "The albums bringing a little more colour to this week's playlist", time: '2H', url: null },
      { tag: 'MUSIC · CULTURE', title: 'Why intimate live sessions are having a moment again', time: '5H', url: null }
    ],
    'Latest Movies': [
      { tag: 'LATEST MOVIES · TRAILERS', title: 'The new trailers turning heads this week', time: '1H', url: null },
      { tag: 'LATEST MOVIES · WATCHLIST', title: 'Five new releases to add to your weekend watchlist', time: '4H', url: null }
    ],
    'Football': [
      { tag: 'FOOTBALL · TRANSFERS', title: 'The moves reshaping the season before kickoff', time: '38M', url: null },
      { tag: 'FOOTBALL · MATCHDAY', title: 'Three fixtures that could define the weekend', time: '3H', url: null }
    ],
    'Discovery': [
      { tag: 'DISCOVERY · PEOPLE', title: 'The creators turning curiosity into a daily practice', time: '2H', url: null },
      { tag: 'DISCOVERY · PLACES', title: 'A different way to explore the city this weekend', time: '6H', url: null }
    ]
  };

  const newsCache = {}; // category -> stories array, so switching tabs back and forth doesn't re-fetch

  function timeAgo(isoLike){
    if (!isoLike) return '';
    // NewsData.io returns "YYYY-MM-DD HH:MM:SS" (UTC, no "Z") — make it parseable.
    const date = new Date(isoLike.includes('T') ? isoLike : `${isoLike.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return '';
    const minutes = Math.max(1, Math.round((Date.now() - date.getTime()) / 60000));
    if (minutes < 60) return `${minutes}M`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}H`;
    return `${Math.round(hours / 24)}D`;
  }

  function renderNewsStories(stories){
    newsFeed.innerHTML = stories.map(story => {
      const inner = `
        <div style="flex:1;min-width:0;">
          <div class="story-tag">${escapeHtml(story.tag)}</div>
          <h4>${escapeHtml(story.title)}</h4>
        </div>
        <div class="story-time">${escapeHtml(story.time)}</div>`;
      return story.url
        ? `<a class="news-story" href="${escapeHtml(story.url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
        : `<article class="news-story">${inner}</article>`;
    }).join('');
  }

  async function loadNewsCategory(name){
    if (newsCache[name]) {
      renderNewsStories(newsCache[name]);
      return;
    }
    // Show fallback immediately so the tab isn't blank while the real fetch runs.
    renderNewsStories(fallbackNewsStories[name] || []);
    try {
      const res = await fetch(`/api/news?category=${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error('News request failed: ' + res.status);
      const data = await res.json();
      const stories = Array.isArray(data.stories) ? data.stories : [];
      if (stories.length === 0) throw new Error('No stories returned');
      const formatted = stories.map(s => ({ tag: s.tag, title: s.title, url: s.url, time: timeAgo(s.publishedAt) || '' }));
      newsCache[name] = formatted;
      // Only swap in the real stories if the user hasn't since switched tabs.
      if (newsFeedHeading.textContent === name) renderNewsStories(formatted);
    } catch (err) {
      console.warn(`News unavailable for "${name}", showing offline stories:`, err);
      // Fallback is already rendered above — nothing further to do.
    }
  }

  document.querySelectorAll('.news-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.newsCategory;
      document.querySelectorAll('.news-tab').forEach(item => item.classList.remove('selected'));
      tab.classList.add('selected');
      newsFeedHeading.textContent = name;
      loadNewsCategory(name);
    });
  });
  loadNewsCategory('Music'); // matches the tab marked "selected" by default in the HTML

  // ---------- team builder ----------
  const teamSection = document.getElementById('teamSection');
  const teamAlphaList = document.getElementById('teamAlphaList');
  const teamOmegaList = document.getElementById('teamOmegaList');
  const teamPickHint = document.getElementById('teamPickHint');
  const teamResult = document.getElementById('teamResult');
  const aiFeatsForm = document.getElementById('aiFeatsForm');
  const aiFeatsQuestion = document.getElementById('aiFeatsQuestion');
  const aiFeatsResult = document.getElementById('aiFeatsResult');
  const aiFeatsCreditsEl = document.getElementById('aiFeatsCredits');
  const shareAiFeatsCardBtn = document.getElementById('shareAiFeatsCard');
  const characterSearch = document.getElementById('characterSearch');
  const characterSearchInput = document.getElementById('characterSearchInput');
  const characterSearchNote = document.getElementById('characterSearchNote');
  const teams = { alpha: [], omega: [] };
  // The AI verdict card needs the exact roster + wording from the last
  // successful analysis — kept separate from `teams` so editing the roster
  // afterwards doesn't let a stale verdict get shared against a build it
  // was never actually run on (see renderTeams(), which clears this).
  let lastAiFeatsReport = null;

  // Each AI feat check is a real Gemini call, so this caps it at 3 PER
  // ACCOUNT PER DAY — not per team roster, since swapping a fighter
  // shouldn't reset the clock. Tracked in Firestore, not a local JS
  // variable, so refreshing the page can't reset it: the count lives on
  // users/{uid}/featCredits/{YYYY-MM-DD} (UTC date), one doc per day, and
  // Firestore rules (not just this client code) enforce the +1-per-write,
  // max-3 ceiling server-side.
  const AI_FEATS_CREDIT_LIMIT = 3;
  function todayKey(){
    return new Date().toISOString().slice(0, 10); // UTC date — same reset moment for everyone, no timezone edge cases
  }
  // Reads today's used count without spending a credit — used to paint
  // the counter correctly on load/sign-in without every glance at the
  // screen costing a write.
  async function peekAiFeatsCredits(){
    if (!auth.currentUser) return AI_FEATS_CREDIT_LIMIT;
    try {
      const snap = await getDoc(doc(db, 'users', auth.currentUser.uid, 'featCredits', todayKey()));
      const used = snap.exists() ? (snap.data().count || 0) : 0;
      return Math.max(0, AI_FEATS_CREDIT_LIMIT - used);
    } catch (err) {
      console.error('Could not read AI feat check credits', err);
      return AI_FEATS_CREDIT_LIMIT; // fail open on read errors — the write-time check below is the real gate
    }
  }
  // Attempts to spend one of today's credits. Returns true if allowed
  // (and already recorded the spend), false if today's quota is used up.
  // The Firestore rules only accept a write that increments by exactly 1
  // and never exceeds the limit, so this can't be spoofed from devtools.
  async function spendAiFeatsCredit(){
    const ref = doc(db, 'users', auth.currentUser.uid, 'featCredits', todayKey());
    const snap = await getDoc(ref);
    const used = snap.exists() ? (snap.data().count || 0) : 0;
    if (used >= AI_FEATS_CREDIT_LIMIT) return false;
    if (snap.exists()) {
      await updateDoc(ref, { count: used + 1 });
    } else {
      await setDoc(ref, { count: 1 });
    }
    return true;
  }
  let activeTeam = 'alpha';
  const featProfiles = {
    'Gojo Satoru':'Infinity-level defense, limitless space manipulation, and domain expansion.',
    'Saitama':'Overwhelming physical strength, extreme speed, and near-limitless durability.',
    'Goku':'Ultra-fast combat reactions, energy projection, and transformations that scale dramatically.',
    'Vegeta':'Relentless power growth, energy blasts, and elite hand-to-hand technique.',
    'Naruto':'Large chakra reserves, shadow clones, sensory abilities, and high battle adaptability.',
    'Sasuke Uchiha':'Sharingan precognition, elemental jutsu, and lightning-fast strikes.',
    'Itachi Uchiha':'Genjutsu mastery, tactical foresight, and precise long-range ninjutsu.',
    'Kakashi Hatake':'Copied techniques, sharp battlefield reading, and versatile jutsu repertoire.',
    'Monkey D. Luffy':'Elastic-body combat, escalating gear transformations, and relentless resolve.',
    'Roronoa Zoro':'Three-blade swordsmanship, immense pain tolerance, and disciplined focus.',
    'Ichigo Kurosaki':'Spirit-blade combat, rapid power escalation, and hybrid fighting forms.',
    'Levi Ackerman':'Elite close-quarters technique, extraordinary agility, and precision under pressure.',
    'Eren Yeager':'Titan transformations, immense raw power, and unpredictable tactics.',
    'All Might':'Explosive superhuman strength, high-speed strikes, and commanding battlefield presence.',
    'Izuku Midoriya':'Inherited power scaling, full-body enhancement, and creative technique combos.',
    'Light Yagami':'Manipulation, long-term planning, and a supernatural killing method rather than brute force.',
    'Edward Elric':'Instant alchemical construction, adaptable tactics, and reinforced prosthetic limb combat.',
    'Natsu Dragneel':'Fire-based offense, high heat resistance, and escalating dragon-force power.',
    'Killua Zoldyck':'Electrified speed, assassin-trained reflexes, and precise close-range strikes.',
    'Gon Freecss':'Enhanced strength bursts, sharp instincts, and rapid on-the-fly power growth.',
    'Meliodas':'Counter-based power scaling, demon-form strength, and near-unkillable resilience.',
    'Rimuru Tempest':'Shape-shifting, skill absorption, and adaptable elemental and physical combat.',
    'Spider-Man':'Wall-crawling agility, precognitive "spider-sense," and enhanced strength-to-size ratio.',
    'Iron Man':'Advanced powered armor, versatile weapon systems, and rapid tactical engineering.',
    'Thor':'Godly strength, lightning manipulation, and a legendary enchanted hammer.',
    'Hulk':'Escalating rage-fueled strength, near-limitless durability, and regeneration.',
    'Captain America':'Peak human physicality, elite tactics, and a nearly indestructible shield.',
    'Wolverine':'Rapid healing factor, retractable claws, and heightened animal senses.',
    'Deadpool':'Extreme regeneration, unpredictable combat style, and high pain tolerance.',
    'Thanos':'Immense raw strength, durability, and reality-altering artifact combat.',
    'Doctor Strange':'Reality-bending magic, dimensional travel, and precognitive strategy.',
    'Scarlet Witch':'Reality-warping chaos magic and telekinetic-level power output.',
    'Magneto':'Mastery over magnetism, metal manipulation, and large-scale battlefield control.',
    'Venom':'Symbiote-enhanced strength, shape-shifting attacks, and rapid regeneration.',
    'Batman':'Peak human conditioning, tactical preparation, detective skill, and specialized gear.',
    'Superman':'Near-invulnerability, flight, immense strength, and multiple energy-based powers.',
    'Wonder Woman':'Superhuman strength and speed, combat mastery, and exceptional resilience.',
    'The Flash':'Extreme superhuman speed, rapid reflexes, and time-bending movement.',
    'Joker':'Unpredictable tactics, psychological manipulation, and improvised weaponry.',
    'Aquaman':'Ocean-scale strength, aquatic command, and enhanced durability underwater.',
    'Darkseid':'Godlike strength, Omega Beam attacks, and near-absolute durability.',
    'Green Lantern':'Willpower-fueled energy constructs and versatile ring-based offense.',
    'Master Chief':'Powered exosuit strength, elite tactical training, and heavy weapon proficiency.',
    'Kratos':'Godly strength, brutal weapon mastery, and relentless close-combat aggression.',
    'Link':'Versatile arsenal, precise swordplay, and resourceful puzzle-driven combat.',
    'Sephiroth':'Blade mastery, powerful magic, and overwhelming speed in close combat.',
    'Dante':'Stylish acrobatic combat, demon-hunting weaponry, and rapid weapon-switching.',
    'Geralt of Rivia':'Monster-hunting swordplay, alchemical potions, and tactical magic signs.',
    'Solid Snake':'Elite stealth tactics, tactical espionage skill, and improvised field equipment.',
    'Doom Slayer':'Overwhelming heavy weaponry, relentless aggression, and demon-killing endurance.',
    'John Wick':'Exceptional accuracy, close-combat skill, endurance, and tactical improvisation.',
    'Jack Sparrow':'Unpredictable improvisation, cunning escapes, and surprisingly sharp swordplay.',
    'Neo':'Reality-bending martial arts, enhanced perception, and rapid combat adaptation.',
    'Darth Vader':'Powerful telekinetic Force abilities and disciplined lightsaber combat.',
    'Yoda':'Masterful Force control, agile lightsaber technique, and centuries of tactical wisdom.',
    'James Bond':'Elite marksmanship, sharp improvisation, and high-stakes tactical composure.',
    'The Terminator':'Relentless durability, precise combat programming, and mechanical strength.',
    'Ellen Ripley':'Resourceful survival instincts, heavy equipment use, and steady nerve under pressure.',
    'Rocky Balboa':'Elite boxing endurance, powerful punching output, and relentless will to keep fighting.'
  };

  function renderTeams(){
    // Roster just changed, so any previously generated AI verdict no longer
    // matches — hide its share button rather than let someone share a
    // verdict for fighters that are no longer in the build.
    lastAiFeatsReport = null;
    shareAiFeatsCardBtn.hidden = true;
    const render = (list, team) => {
      list.innerHTML = teams[team].map((name, index) =>
        `<li><span class="team-character"><img data-char-photo="${escapeHtml(name)}" src="${avatarUrl(name, name.split(/\s+/).map(part => part[0]).join('').slice(0,2).toUpperCase())}" alt=""><span>${escapeHtml(name)}</span></span><button type="button" data-remove-team="${team}" data-remove-index="${index}" aria-label="Remove ${escapeHtml(name)}">×</button></li>`
      ).join('');
      hydrateCharacterPhotos(list);
    };
    render(teamAlphaList, 'alpha');
    render(teamOmegaList, 'omega');
    document.querySelectorAll('.character-chip').forEach(chip => {
      chip.classList.toggle('used', teams.alpha.includes(chip.dataset.character) || teams.omega.includes(chip.dataset.character));
    });
    teamPickHint.textContent = activeTeam === 'alpha' ? 'Adding to Alpha' : 'Adding to Omega';
    refreshAiFeatsCreditsDisplay();
  }

  // Repaints the credits line/button state for today's account-level
  // quota. Read-only — never spends a credit itself. Doesn't depend on
  // the current team roster anymore (limit is per account per day now).
  async function refreshAiFeatsCreditsDisplay(){
    if (!aiFeatsCreditsEl) return;
    const submitBtn = aiFeatsForm?.querySelector('button[type="submit"]');
    if (!auth.currentUser) {
      aiFeatsCreditsEl.textContent = `Sign in for AI checks`;
      aiFeatsCreditsEl.classList.remove('exhausted');
      if (submitBtn) submitBtn.disabled = false; // let the submit handler prompt sign-in rather than blocking here
      return;
    }
    const remaining = await peekAiFeatsCredits();
    aiFeatsCreditsEl.textContent = remaining > 0
      ? `${remaining}/${AI_FEATS_CREDIT_LIMIT} today`
      : `Resets midnight UTC`;
    aiFeatsCreditsEl.classList.toggle('exhausted', remaining === 0);
    if (submitBtn) submitBtn.disabled = remaining === 0;
  }

  characterSearch.addEventListener('submit', event => {
    event.preventDefault();
    const query = characterSearchInput.value.trim();
    const normalized = query.toLowerCase();
    document.querySelectorAll('.character-chip').forEach(chip => {
      chip.style.display = !normalized || chip.dataset.character.toLowerCase().includes(normalized) ? '' : 'none';
    });
    if (!query) {
      characterSearchNote.textContent = 'Search the presets or type any character name to add your own.';
      return;
    }
    if (teams[activeTeam].length >= 3) {
      showToast('Each team can have up to 3 fighters');
      return;
    }
    const preset = [...document.querySelectorAll('.character-chip')].find(chip => chip.dataset.character.toLowerCase() === normalized);
    const character = preset ? preset.dataset.character : query;
    if (teams.alpha.concat(teams.omega).some(name => name.toLowerCase() === character.toLowerCase())) {
      showToast('That character is already selected');
      return;
    }
    teams[activeTeam].push(character);
    characterSearchInput.value = '';
    characterSearchNote.textContent = `${character} added to ${activeTeam === 'alpha' ? 'Team Alpha' : 'Team Omega'}.`;
    document.querySelectorAll('.character-chip').forEach(chip => chip.style.display = '');
    renderTeams();
  });

  document.querySelectorAll('.team-slot').forEach((slot, index) => {
    slot.addEventListener('click', event => {
      if (event.target.closest('button')) return;
      activeTeam = index === 0 ? 'alpha' : 'omega';
      document.querySelectorAll('.team-slot').forEach(item => item.classList.remove('active'));
      slot.classList.add('active');
      renderTeams();
    });
  });
  document.querySelector('.team-slot').classList.add('active');

  document.querySelectorAll('.character-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      if (teams[activeTeam].length >= 3) {
        showToast('Each team can have up to 3 fighters');
        return;
      }
      teams[activeTeam].push(chip.dataset.character);
      renderTeams();
    });
  });

  document.getElementById('teamBuilder')?.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-team]');
    if (!button) return;
    const team = button.dataset.removeTeam;
    teams[team].splice(Number(button.dataset.removeIndex), 1);
    renderTeams();
  });

  const shareTeamCardBtn = document.getElementById('shareTeamCard');
  document.getElementById('assembleTeams').addEventListener('click', () => {
    if (!teams.alpha.length || !teams.omega.length) {
      showToast('Choose fighters for both teams');
      return;
    }
    teamResult.hidden = false;
    teamResult.innerHTML = `<strong>${teams.alpha.join(' · ')} vs ${teams.omega.join(' · ')}</strong>Matchup assembled. Tap the cards above to keep editing your lineups.`;
    shareTeamCardBtn.hidden = false;
  });
  document.getElementById('clearTeams').addEventListener('click', () => {
    teams.alpha.length = 0;
    teams.omega.length = 0;
    teamResult.hidden = true;
    shareTeamCardBtn.hidden = true;
    renderTeams(); // also refreshes the credits line for the now-empty roster
  });

  let teamCardBusy = false;
  shareTeamCardBtn.addEventListener('click', async () => {
    if (!teams.alpha.length || !teams.omega.length || teamCardBusy) return;
    teamCardBusy = true;
    const shareTeamCardLabel = shareTeamCardBtn.querySelector('span');
    const original = shareTeamCardLabel.textContent;
    shareTeamCardLabel.textContent = 'BUILDING CARD…';
    try {
      // Custom team builds aren't saved matchups, so there's no deep-link
      // for them — the card links back to the app itself, which is the
      // whole point (the image does the promoting, the link brings people
      // in to build their own).
      const url = new URL(location.href);
      url.search = '';
      url.hash = '';
      const shareUrl = url.toString();
      const canvas = await buildTeamBattleCard(teams, shareUrl);
      const customId = `${teams.alpha.join('+')}-vs-${teams.omega.join('+')}`;
      await shareOrDownloadCard(canvas, {
        filename: 'fictionclash-custom-matchup.png',
        title: 'My custom matchup — Fiction Clash',
        text: `${teams.alpha.join(' & ')} vs ${teams.omega.join(' & ')} — build your own matchup on Fiction Clash.`,
        url: shareUrl,
        onShared: () => awardShareXp('matchup', customId)
      });
    } catch (err) {
      console.error('Team battle card failed', err);
      showToast('Could not build the battle card — try again');
    } finally {
      shareTeamCardLabel.textContent = original;
      teamCardBusy = false;
    }
  });

  aiFeatsForm.addEventListener('submit', event => {
    event.preventDefault();
    const question = aiFeatsQuestion.value.trim() || 'Compare the strongest feats from both teams.';
    if (!teams.alpha.length || !teams.omega.length) {
      showToast('Choose fighters for both teams first');
      return;
    }
    if (!auth.currentUser) {
      requireSignIn('Sign in to use AI feat checks');
      return;
    }
    const analyseBtn = aiFeatsForm.querySelector('button[type="submit"]');
    withSpinner(analyseBtn, 'ANALYSING…', async () => {
      const allNames = [...teams.alpha, ...teams.omega];
      let credited;
      try {
        credited = await spendAiFeatsCredit();
      } catch (err) {
        console.error('Could not check AI feat check credits', err);
        showToast('Could not verify AI check credits — try again');
        return;
      }
      if (!credited) {
        showToast('No AI checks left today — resets at midnight UTC');
        refreshAiFeatsCreditsDisplay();
        return;
      }
      refreshAiFeatsCreditsDisplay();
      const data = await fetchCharacterAnalysis(allNames, question);
      const profile = name => {
        const entry = data && data.characters && data.characters[name];
        if (entry && entry.analysis) return entry.analysis;
        return featProfiles[name] || 'No verified profile loaded yet — evaluate this character from the specific source and version you mean.';
      };
      const alpha = teams.alpha.map(name => `<b>${escapeHtml(name)}</b>: ${escapeHtml(profile(name))}`).join('<br>');
      const omega = teams.omega.map(name => `<b>${escapeHtml(name)}</b>: ${escapeHtml(profile(name))}`).join('<br>');
      const rawVerdict = (data && data.verdict)
        ? data.verdict
        : 'AI analysis is unavailable right now — showing saved profiles where available. Verdict depends on versions, conditions, and whether cross-universe abilities are equalized.';
      const verdict = escapeHtml(rawVerdict);
      aiFeatsResult.hidden = false;
      aiFeatsResult.innerHTML = `<strong>AI feat check</strong><span><b>Question:</b> ${escapeHtml(question)}</span><br><br><b>Team Alpha</b><br>${alpha}<br><br><b>Team Omega</b><br>${omega}<br><br><span style="color:var(--muted)">${verdict}</span>`;
      // Snapshot the exact roster this verdict was generated for, so the
      // share button can't be used after the roster's been edited further.
      lastAiFeatsReport = { alpha: [...teams.alpha], omega: [...teams.omega], verdict: rawVerdict };
      shareAiFeatsCardBtn.hidden = false;
    }, 300);
  });

  let aiFeatsCardBusy = false;
  shareAiFeatsCardBtn.addEventListener('click', async () => {
    if (!lastAiFeatsReport || aiFeatsCardBusy) return;
    aiFeatsCardBusy = true;
    const shareAiFeatsCardLabel = shareAiFeatsCardBtn.querySelector('span');
    const original = shareAiFeatsCardLabel.textContent;
    shareAiFeatsCardLabel.textContent = 'BUILDING CARD…';
    try {
      const url = new URL(location.href);
      url.search = '';
      url.hash = '';
      const shareUrl = url.toString();
      const canvas = await buildTeamBattleCard(
        { alpha: lastAiFeatsReport.alpha, omega: lastAiFeatsReport.omega },
        shareUrl,
        lastAiFeatsReport
      );
      const customId = `${lastAiFeatsReport.alpha.join('+')}-vs-${lastAiFeatsReport.omega.join('+')}`;
      await shareOrDownloadCard(canvas, {
        filename: 'fictionclash-ai-verdict.png',
        title: 'AI Power Scout verdict — Fiction Clash',
        text: `${lastAiFeatsReport.alpha.join(' & ')} vs ${lastAiFeatsReport.omega.join(' & ')} — see who the AI picked on Fiction Clash.`,
        url: shareUrl,
        onShared: () => awardShareXp('matchup', customId)
      });
    } catch (err) {
      console.error('AI verdict card failed', err);
      showToast('Could not build the battle card — try again');
    } finally {
      shareAiFeatsCardLabel.textContent = original;
      aiFeatsCardBusy = false;
    }
  });

  renderTeams();

  // ---------- app theme ----------
  const accentThemes = {
    gold:  { ember:'#E4A929', emberDim:'#6B4A0E', navy:'#141008', navyGlow:'#2a2214' },
    blue:  { ember:'#1E4FE0', emberDim:'#0F1D6B', navy:'#0A1454', navyGlow:'#16225e' },
    green: { ember:'#2E9E5B', emberDim:'#155C32', navy:'#0A1F12', navyGlow:'#15351f' },
    red:   { ember:'#D6432E', emberDim:'#7A241A', navy:'#1A0A08', navyGlow:'#331410' },
    cyan:  { ember:'#22D3D8', emberDim:'#0E5C60', navy:'#04191b', navyGlow:'#0d2e30' },
    purple:{ ember:'#9B4FE0', emberDim:'#4B1F73', navy:'#160A24', navyGlow:'#2b1442' },
    crimson:{ ember:'#FF1414', emberDim:'#5C0000', navy:'#180000', navyGlow:'#330000' },
    // Fire & Ice keeps --ember/--ember-dim on the warm side (borders, the
    // "hi" avatar ring, anywhere a single accent still applies) while the
    // theme-fireice body class above swaps --accent-bg to the two-tone
    // gradient and --accent to the fused blend. --ember-dim borrows the
    // cyan theme's dim tone so the "lo" side of paired UI (e.g. the second
    // avatar in a matchup) reads as the cool half of the pairing.
    fireice:{ ember:'#E4A929', emberDim:'#0E5C60', navy:'#0d1f1f', navyGlow:'#1c2e2e' },
    // Mono needs separate light/dark accents — a near-white accent disappears
    // on the light theme's cream background, and a near-black one would
    // disappear on the dark theme's black background.
    mono: {
      dark:  { ember:'#E5E5E5', emberDim:'#4A4A4A', navy:'#141414', navyGlow:'#2a2a2a' },
      light: { ember:'#2A2A2A', emberDim:'#8A8A8A', navy:'#1c1c1c', navyGlow:'#3a3a3a' }
    }
  };
  const themeSwatchRow = document.getElementById('themeSwatchRow');
  let currentThemeName = 'mono';
  function applyTheme(name){
    currentThemeName = name;
    const isLight = document.body.classList.contains('light');
    const entry = accentThemes[name] || accentThemes.gold;
    const theme = name === 'mono' ? (isLight ? entry.light : entry.dark) : entry;
    const root = document.documentElement.style;
    root.setProperty('--ember', theme.ember);
    root.setProperty('--ember-dim', theme.emberDim);
    root.setProperty('--navy', theme.navy);
    document.body.classList.toggle('theme-fireice', name === 'fireice');
    document.querySelectorAll('.theme-swatch').forEach(sw => sw.classList.toggle('active', sw.dataset.theme === name));
    // Same reasoning as applyThemeMode above — an accent color pick is UI
    // state, not tracking, so it's written unconditionally rather than
    // gated behind cookie consent (which silently dropped it before,
    // making the app snap back to the mono/black-white default on reload).
    try { localStorage.setItem('fictionClashTheme', name); } catch (err) {}
  }
  themeSwatchRow.addEventListener('click', event => {
    const swatch = event.target.closest('.theme-swatch');
    if (!swatch) return;
    applyTheme(swatch.dataset.theme);
    showToast(`${swatch.title} theme applied`);
  });
  applyTheme(localStorage.getItem('fictionClashTheme') || 'mono');

  // ---------- account ----------
  const accountSection = document.getElementById('accountSection');
  const accountAvatar = document.getElementById('accountAvatar');
  const accountDisplayName = document.getElementById('accountDisplayNameText');
  const accountDisplayHandle = document.getElementById('accountDisplayHandle');
  const themeStoreOverlay = document.getElementById('themeStoreOverlay');
  const themeStoreLauncher = document.getElementById('themeStoreLauncher');
  const themeStoreClose = document.getElementById('themeStoreClose');
  themeStoreLauncher.addEventListener('click', () => themeStoreOverlay.classList.add('show'));
  document.getElementById('themeStoreTeaserBtn')?.addEventListener('click', () => themeStoreOverlay.classList.add('show'));
  themeStoreClose.addEventListener('click', () => themeStoreOverlay.classList.remove('show'));
  themeStoreOverlay.addEventListener('click', event => {
    if (event.target === themeStoreOverlay) themeStoreOverlay.classList.remove('show');
  });

  // Settings — gear icon on the Account page opens the full-page settings
  // screen everything else (sign-in, notifications, personalize, content
  // & privacy, admin tools) now lives in. Same open/close pattern as
  // every other modal-sheet-full in the app.
  const settingsOverlay = document.getElementById('settingsOverlay');
  const settingsLauncher = document.getElementById('settingsLauncher');
  const settingsClose = document.getElementById('settingsClose');
  settingsLauncher.addEventListener('click', () => settingsOverlay.classList.add('show'));
  settingsClose.addEventListener('click', () => settingsOverlay.classList.remove('show'));
  settingsOverlay.addEventListener('click', event => {
    if (event.target === settingsOverlay) settingsOverlay.classList.remove('show');
  });

  // Avatar Store — shop icon on the Account page opens the decorations/
  // fonts store in its own full-page screen.
  const avatarStoreOverlay = document.getElementById('avatarStoreOverlay');
  const avatarStoreLauncher = document.getElementById('avatarStoreLauncher');
  const avatarStoreClose = document.getElementById('avatarStoreClose');
  avatarStoreLauncher.addEventListener('click', () => avatarStoreOverlay.classList.add('show'));
  avatarStoreClose.addEventListener('click', () => avatarStoreOverlay.classList.remove('show'));
  avatarStoreOverlay.addEventListener('click', event => {
    if (event.target === avatarStoreOverlay) avatarStoreOverlay.classList.remove('show');
  });

  // Tapping the badge or the progress line explains how to earn/keep it.
  const verifiedInfoOverlay = document.getElementById('verifiedInfoOverlay');
  const verifiedInfoClose = document.getElementById('verifiedInfoClose');
  function openVerifiedInfo(){ verifiedInfoOverlay.classList.add('show'); }
  document.getElementById('accountVerifiedBadge').addEventListener('click', openVerifiedInfo);
  document.getElementById('verifiedProgressText').addEventListener('click', openVerifiedInfo);
  verifiedInfoClose.addEventListener('click', () => verifiedInfoOverlay.classList.remove('show'));
  // Paid verified-badge renewal: priced at a real $3.61/week (the current
  // conversion of the 5,000 NGN/week Nidi quoted). The backend converts
  // that $3.61 to naira at the live rate at checkout time and charges
  // that (see api/create-payment.js).
  document.getElementById('verifiedRenewBuy').addEventListener('click', async () => {
    const user = auth.currentUser;
    if (!user) { requireSignIn('Sign in to renew your verified badge'); return; }
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`${PAYMENT_API_BASE}/api/create-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify({ itemType: 'badge', returnUrl: location.href.split('?')[0] }),
      });
      const data = await res.json();
      if (!res.ok) { showToast('Could not start checkout'); return; }
      location.href = data.authorization_url;
    } catch (err) {
      console.error('Badge renewal purchase failed', err);
      showToast('Could not start checkout');
    }
  });
  verifiedInfoOverlay.addEventListener('click', event => {
    if (event.target === verifiedInfoOverlay) verifiedInfoOverlay.classList.remove('show');
  });
  const accountEmail = document.getElementById('accountEmail');
  const profileName = document.getElementById('profileName');
  const profileHandle = document.getElementById('profileHandle');
  const profileBio = document.getElementById('profileBio');
  const avatarEditBtn = document.getElementById('avatarEditBtn');
  const avatarFile = document.getElementById('avatarFile');
  const removeAvatarBtn = document.getElementById('removeAvatarBtn');
  let avatarDataUrl = '';
  let coverPhotoDataUrl = '';
  let clashPoints = 0;
  // seasonShardsRaw is the full { seasonId: amount } map as stored in
  // Firestore (see api/lib/xp.js). seasonShards is the derived, display-
  // ready balance for WHICHEVER season is currently active — recomputed
  // by recomputeSeasonShards() below whenever either changes, so a
  // newly-activated season correctly shows 0 until shards are earned
  // into its own key, instead of carrying over another season's total.
  let seasonShardsRaw = {};
  let seasonShards = 0;
  function recomputeSeasonShards(){
    seasonShards = (seasonShardsRaw && typeof seasonShardsRaw === 'object' && activeSeasonId)
      ? Number(seasonShardsRaw[activeSeasonId] || 0)
      : 0;
  }
  // Reads a possibly-nested field off a plain object by dot path, e.g.
  // fieldPath(data, 'seasonShards.horror') — used because Firestore doc
  // data comes back as real nested objects, not flattened dot-keys, even
  // though query field paths themselves use dot notation.
  function fieldPath(obj, path){
    return path.split('.').reduce((o, k) => (o && typeof o === 'object') ? o[k] : undefined, obj);
  }
  let shareCount = 0;
  let unlockedDecorations = [];
  let unlockedFonts = [];
  let unlockedCardEffects = []; // only ever holds premium card effects — requiresXp ones are never "owned", just gated live on currentUserXp
  let equippedDecoration = null;
  let equippedFont = null;
  let equippedCardEffect = null;
  // Per-character decoration overrides for the CURRENT viewer only — keyed
  // the same way as character avatar photos (avatarOverrideKey: name, or
  // "name|version" for a versioned character like Base Goku vs Ultra
  // Instinct Goku). A key that's absent means "inherit whatever's globally
  // equipped"; a key present with value 'none' means "explicitly no
  // decoration on this character even if one is equipped globally" — those
  // are different states, so absence and 'none' can't be collapsed into one.
  let characterDecorations = {};

  // ---------- canvas-based avatar FX effects ----------
  // Ported verbatim from avatar-effects-canvas-preview.html (the standalone
  // particle-physics preview) — the AvatarEffect class itself is unchanged.
  // Each instance owns one <canvas> and joins a single shared
  // requestAnimationFrame loop (AvatarEffect._globalTick) so having many
  // decorated avatars on screen at once (feed, comments, store grid) still
  // costs only one rAF callback, not one per avatar.
  // Avatar decorations read calmer at a slower pace on the website/TWA,
  // but should run at their original full speed once there's a native
  // app build — rather than re-tuning every effect's individual speed
  // constants a third time, this scales the one shared clock every
  // AvatarEffect instance reads from (this.time / dt), so the slowdown
  // (or lack of it) applies uniformly to all of them, present and future.
  // The native app shell should set `window.FICTION_CLASH_NATIVE_APP = true`
  // before this script loads (e.g. injected JS in its WebView, or however
  // it distinguishes itself) to opt back into full speed.
  const IS_NATIVE_APP = typeof window !== 'undefined' && !!window.FICTION_CLASH_NATIVE_APP;
  const AVATAR_FX_SPEED = IS_NATIVE_APP ? 1 : 0.4;

  class AvatarEffect {
    static instances = new Set();
    static rafId = null;
    static lastTime = 0;
    // Final Six horror decorations: bespoke hand-authored animations, not a
    // good fit for the generic particle lifecycle above (recursive branching
    // roots, a crawling spider, blinking eyes...) — each renders itself
    // directly from this.time every frame instead of going through
    // _createParticle/_update/_draw's particle loop. See _initCustom /
    // _drawCustomFrame near destroy() for the implementation. The five
    // Crossverse badges below share the same mechanism but lean the
    // opposite direction on purpose — "almost static" emblems (a shield,
    // a lightning bolt, a crown...) with only a slow glint/sway/twinkle,
    // deliberately calmer than the Final Six's busy particle work.
    // Original generic hero iconography throughout (a plain star-shield,
    // a plain bolt, a cape ribbon, a crown, a "VS" burst) — nothing here
    // is any specific franchise's trademarked logo/symbol.
    static CUSTOM_TYPES = new Set(['raven-curse', 'lord-of-dead', 'watcher-ring', 'black-widow', 'styx-spirits', 'creeping-roots', 'legend-shield', 'vs-impact', 'hero-cape', 'voltage-bolt', 'champions-crown']);

    static _globalTick(timestamp) {
      if (!AvatarEffect.lastTime) AvatarEffect.lastTime = timestamp;
      const dt = Math.min((timestamp - AvatarEffect.lastTime) / 1000, 0.1) * AVATAR_FX_SPEED;
      AvatarEffect.lastTime = timestamp;

      for (const instance of AvatarEffect.instances) {
        // visible defaults true and is only set false by the shared
        // canvasFxVisibilityObserver below while the canvas is scrolled
        // off-screen — skipping update+draw here (not destroying the
        // instance) so particles resume mid-animation instead of
        // restarting once it scrolls back into view.
        if (instance.active && instance.visible !== false) {
          instance._update(dt);
          instance._draw();
        }
      }

      if (AvatarEffect.instances.size > 0) {
        AvatarEffect.rafId = requestAnimationFrame(AvatarEffect._globalTick);
      } else {
        AvatarEffect.rafId = null;
      }
    }

    constructor(canvas, type, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.type = type;
      this.active = true;
      this.visible = true;

      this.width = canvas.width || 80;
      this.height = canvas.height || 80;
      this.center = { x: this.width / 2, y: this.height / 2 };
      // sized so effects sit right at (and slightly overlap) the avatar edge, like Discord's own decorations
      this.radius = options.radius || Math.min(this.width, this.height) * 0.32;

      this.maxParticles = options.maxParticles || 26;
      this.particles = [];
      this.time = Math.random() * 10;
      if (AvatarEffect.CUSTOM_TYPES.has(type)) this._initCustom();
      else this._initParticles();

      AvatarEffect.instances.add(this);
      if (!AvatarEffect.rafId) {
        AvatarEffect.lastTime = performance.now();
        AvatarEffect.rafId = requestAnimationFrame(AvatarEffect._globalTick);
      }
    }

    _initParticles() {
      for (let i = 0; i < this.maxParticles; i++) {
        const p = this._createParticle(i);
        if (Number.isFinite(p.maxAge)) p.age = Math.random() * p.maxAge;
        this.particles.push(p);
      }
    }

    // ---------- particle creation ----------
    _createParticle(index) {
      const angle = Math.random() * Math.PI * 2;
      const r = this.radius + (Math.random() - 0.5) * 4;
      const x = this.center.x + Math.cos(angle) * r;
      const y = this.center.y + Math.sin(angle) * r;

      switch (this.type) {
        case 'flame': {
          // emitted all the way around the ring — real fire boils up from every side and gathers/overlaps toward the top
          const fa = Math.random() * Math.PI * 2;
          const fx = this.center.x + Math.cos(fa) * this.radius;
          const fy = this.center.y + Math.sin(fa) * this.radius;
          const outwardSpeed = 1.5 + Math.random() * 2.5;
          const vx = Math.cos(fa) * outwardSpeed + (Math.random() - 0.5) * 3;
          const vy = -(10 + Math.random() * 14) + Math.sin(fa) * 2;
          return { x: fx, y: fy, vx, vy, size: 5 + Math.random() * 6, maxAge: 0.6 + Math.random() * 0.55, age: 0,
            swirl: (Math.random() - 0.5) * 16, flickerSeed: Math.random() * Math.PI * 2, flickerFreq: 9 + Math.random() * 8 };
        }
        case 'air': {
          const angularSpeed = (0.6 + Math.random() * 0.5) * (Math.random() > 0.5 ? 1 : -1);
          return { angle, angularSpeed, baseRadius: this.radius + (Math.random() - 0.5) * 10,
            wobbleAmp: 4 + Math.random() * 5, wobbleFreq: 2 + Math.random() * 2, wobblePhase: Math.random() * Math.PI * 2,
            streak: 8 + Math.random() * 10, size: 1 + Math.random(), maxAge: 1 + Math.random() * 1.2, age: 0,
            prevX: x, prevY: y, x, y };
        }
        case 'energy': {
          const isBolt = Math.random() > 0.85;
          if (isBolt) {
            const pts = [];
            const steps = 4;
            for (let i = 0; i <= steps; i++) {
              const rr = (this.radius * i) / steps;
              pts.push({ x: this.center.x + Math.cos(angle) * rr + (Math.random() - 0.5) * 6, y: this.center.y + Math.sin(angle) * rr + (Math.random() - 0.5) * 6 });
            }
            return { subType: 'bolt', points: pts, maxAge: 0.12 + Math.random() * 0.1, age: 0, x, y };
          }
          const outwardSpeed = 14 + Math.random() * 16;
          return { subType: 'spark', x, y, vx: Math.cos(angle) * outwardSpeed, vy: Math.sin(angle) * outwardSpeed,
            size: 1.5 + Math.random() * 2.5, maxAge: 0.25 + Math.random() * 0.35, age: 0 };
        }
        case 'toxic': {
          const isDrip = Math.random() > 0.75;
          return { subType: isDrip ? 'drip' : 'bubble', x, y,
            vx: (Math.random() - 0.5) * 3, vy: isDrip ? 10 + Math.random() * 8 : -(6 + Math.random() * 8),
            wobbleFreq: 3 + Math.random() * 2, wobblePhase: Math.random() * Math.PI * 2,
            size: isDrip ? 2 + Math.random() * 2 : 2.5 + Math.random() * 3.5, maxAge: 0.8 + Math.random() * 0.8, age: 0 };
        }
        case 'portal': {
          return { angle, angularSpeed: 2 + Math.random() * 2, startRadius: this.radius + Math.random() * 6,
            size: 1.5 + Math.random() * 2, maxAge: 0.9 + Math.random() * 0.6, age: 0, x, y };
        }
        case 'reaper': {
          const orbitSpeed = (0.35 + Math.random() * 0.3) * (Math.random() > 0.5 ? 1 : -1);
          return { subType: 'skull', angle, orbitSpeed, orbitRadius: this.radius + (Math.random() - 0.5) * 8,
            bobPhase: Math.random() * Math.PI * 2, bobFreq: 0.8 + Math.random() * 0.8, bobAmp: 2.5 + Math.random() * 3,
            size: 5 + Math.random() * 3.5, maxAge: 2.4 + Math.random() * 2, age: 0, x, y };
        }
        case 'dragonballs': {
          const idx = (typeof index === 'number') ? index : Math.floor(Math.random() * 7);
          const baseAngle = (idx / 7) * Math.PI * 2;
          const orbitRadius = this.radius * (1.08 + (idx % 2 === 0 ? 0.06 : -0.05));
          return { subType: 'ball', angle: baseAngle, orbitSpeed: 0.16 + (idx % 3) * 0.018,
            orbitRadius, bobPhase: idx * 0.9, bobAmp: 2 + (idx % 3), size: 7,
            starCount: idx + 1, age: 0, maxAge: Infinity, x, y };
        }
        case 'star_struck': {
          const isCloud = Math.random() > 0.7;
          if (isCloud) {
            return { subType: 'cloud', angle, angularSpeed: 0.05 + Math.random() * 0.05,
              orbitRadius: this.radius * (1.1 + Math.random() * 0.12), size: 5 + Math.random() * 4,
              wobblePhase: Math.random() * Math.PI * 2, age: 0, maxAge: Infinity, x, y };
          }
          return { subType: 'star', angle, orbitRadius: this.radius * (0.75 + Math.random() * 0.45),
            size: 1 + Math.random() * 1.4, twinklePhase: Math.random() * Math.PI * 2,
            twinkleFreq: 2 + Math.random() * 3, age: 0, maxAge: Infinity, x, y };
        }
        default:
          return { x, y, vx: 0, vy: 0, size: 3, maxAge: 1, age: 0 };
      }
    }

    // ---------- physics update ----------
    _update(dt) {
      this.time += dt;
      if (AvatarEffect.CUSTOM_TYPES.has(this.type)) return; // custom types render straight from this.time in _draw
      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        p.age += dt;
        if (p.age >= p.maxAge) { this.particles[i] = this._createParticle(); continue; }

        switch (this.type) {
          case 'flame':
            p.vy -= 14 * dt; // buoyancy — accelerates upward as it rises, like real convective fire
            p.x += (p.vx + Math.sin(p.age * 7 + p.flickerSeed) * (p.swirl * 0.5)) * dt;
            p.y += p.vy * dt;
            break;
          case 'air': {
            p.prevX = p.x; p.prevY = p.y;
            p.angle += p.angularSpeed * dt;
            const r = p.baseRadius + Math.sin(p.age * p.wobbleFreq + p.wobblePhase) * p.wobbleAmp;
            p.x = this.center.x + Math.cos(p.angle) * r;
            p.y = this.center.y + Math.sin(p.angle) * r;
            break;
          }
          case 'energy':
            if (p.subType === 'spark') { p.vx *= 0.9; p.vy *= 0.9; p.x += p.vx * dt; p.y += p.vy * dt; }
            break;
          case 'toxic':
            p.x += (p.vx + Math.sin(p.age * p.wobbleFreq + p.wobblePhase) * 6) * dt;
            p.y += p.vy * dt;
            break;
          case 'portal': {
            p.angle += p.angularSpeed * dt;
            const t = p.age / p.maxAge;
            const r = p.startRadius * (1 - t);
            p.x = this.center.x + Math.cos(p.angle) * r;
            p.y = this.center.y + Math.sin(p.angle) * r;
            break;
          }
          case 'reaper': {
            p.angle += p.orbitSpeed * dt;
            const r = p.orbitRadius + Math.sin(p.age * p.bobFreq + p.bobPhase) * p.bobAmp;
            p.x = this.center.x + Math.cos(p.angle) * r;
            p.y = this.center.y + Math.sin(p.angle) * r;
            break;
          }
          case 'dragonballs': {
            p.angle += p.orbitSpeed * dt;
            const r = p.orbitRadius + Math.sin(p.age * 0.7 + p.bobPhase) * p.bobAmp;
            p.x = this.center.x + Math.cos(p.angle) * r;
            p.y = this.center.y + Math.sin(p.angle) * r;
            break;
          }
          case 'star_struck': {
            if (p.subType === 'cloud') {
              p.angle += p.angularSpeed * dt;
              const r = p.orbitRadius + Math.sin(p.age * 0.5 + p.wobblePhase) * 3;
              p.x = this.center.x + Math.cos(p.angle) * r;
              p.y = this.center.y + Math.sin(p.angle) * r;
            } else {
              p.angle += 0.035 * dt;
              p.x = this.center.x + Math.cos(p.angle) * p.orbitRadius;
              p.y = this.center.y + Math.sin(p.angle) * p.orbitRadius;
              p.twinklePhase += dt * p.twinkleFreq;
            }
            break;
          }
        }
      }
    }

    // ---------- drawing ----------
    _draw() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.width, this.height);

      if (AvatarEffect.CUSTOM_TYPES.has(this.type)) { this._drawCustomFrame(); return; }

      if (this.type === 'star_struck') { this._drawStarStruckRing(); }
      if (this.type === 'flame') { this._drawFlameGlow(); }

      ctx.globalCompositeOperation = (this.type === 'reaper' || this.type === 'dragonballs') ? 'source-over' : 'lighter';

      for (const p of this.particles) {
        const progress = p.age / p.maxAge;
        const fade = Math.sin(Math.min(progress, 1) * Math.PI);

        switch (this.type) {
          case 'flame': {
            // Colors here cool continuously with progress (white-hot to
            // red), so unlike _softCircle this can't cache on alpha
            // alone — instead the gradient is baked once per quantized
            // progress step (32 steps: fine enough that the cooling
            // looks continuous, coarse enough that a flame's ~1s
            // lifetime only ever needs a handful of distinct sprites).
            // Size, flicker, and position still vary per particle per
            // frame via drawImage's placement/scale, same as before.
            const flicker = 0.7 + 0.3 * Math.sin(p.age * p.flickerFreq + p.flickerSeed);
            const size = Math.max(0.4, p.size * (1 - progress * 0.55) * flicker);
            const bucket = Math.round(Math.min(progress, 1) * AvatarEffect.FLAME_SPRITE_STEPS);
            const sprite = AvatarEffect._flameSprite(bucket);
            ctx.drawImage(sprite, p.x - size, p.y - size, size * 2, size * 2);
            break;
          }
          case 'air': {
            ctx.strokeStyle = `rgba(235,240,247,${fade * 0.5})`;
            ctx.lineWidth = p.size;
            ctx.beginPath(); ctx.moveTo(p.prevX, p.prevY); ctx.lineTo(p.x, p.y); ctx.stroke();
            break;
          }
          case 'energy':
            if (p.subType === 'bolt') { ctx.strokeStyle = `rgba(255,246,207,${1 - progress})`; ctx.lineWidth = 1.4; ctx.beginPath(); p.points.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)); ctx.stroke(); }
            else this._softCircle(p.x, p.y, p.size * (1 - progress * 0.5), `rgba(255,210,61,${fade})`);
            break;
          case 'toxic':
            if (p.subType === 'drip') this._filledCircle(p.x, p.y, p.size, `rgba(150,200,60,${(1 - progress) * 0.8})`);
            else { this._ringCircle(p.x, p.y, p.size, `rgba(200,255,138,${fade * 0.8})`); }
            break;
          case 'portal':
            this._filledCircle(p.x, p.y, p.size * (1 - progress * 0.4), `rgba(217,194,255,${fade * 0.9})`);
            break;
          case 'reaper':
            this._drawSkull(p.x, p.y, p.size, fade * 0.85);
            break;
          case 'dragonballs':
            this._drawDragonBall(p.x, p.y, p.size, p.starCount, 1);
            break;
          case 'star_struck':
            if (p.subType === 'cloud') this._softCircle(p.x, p.y, p.size, 'rgba(210,225,245,0.35)');
            else {
              const tw = 0.4 + 0.6 * Math.abs(Math.sin(p.twinklePhase));
              this._diamond(p.x, p.y, p.size * (0.8 + tw * 0.4), `rgba(255,255,255,${tw})`);
            }
            break;
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // ---------- draw helpers ----------
    _filledCircle(x, y, r, color) { const ctx = this.ctx; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, Math.max(0.1, r), 0, Math.PI * 2); ctx.fill(); }
    // Cache of pre-rendered flame sprites, one per quantized progress
    // step (see the 'flame' case in _draw for why this needs a bucketed
    // cache rather than the single-sprite-plus-globalAlpha trick used
    // by _softCircle below: the flame's color itself cools from white
    // to red across a particle's lifetime, not just its opacity).
    static FLAME_SPRITE_STEPS = 32;
    static _flameSprites = new Map();
    static _flameSprite(bucket) {
      let sprite = AvatarEffect._flameSprites.get(bucket);
      if (sprite) return sprite;
      const progress = bucket / AvatarEffect.FLAME_SPRITE_STEPS;
      const coolFade = 1 - Math.min(progress, 1);
      const g = Math.max(0, 200 - progress * 160);
      const b = Math.max(0, 80 - progress * 80);
      const SIZE = 64;
      const c = document.createElement('canvas');
      c.width = c.height = SIZE;
      const sctx = c.getContext('2d');
      const grad = sctx.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE / 2);
      grad.addColorStop(0, `rgba(255,${250 - progress * 60},${200 - progress * 180},${coolFade * 0.95})`);
      grad.addColorStop(0.45, `rgba(255,${g},${b},${coolFade * 0.75})`);
      grad.addColorStop(1, 'rgba(200,20,40,0)');
      sctx.fillStyle = grad;
      sctx.beginPath(); sctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2); sctx.fill();
      AvatarEffect._flameSprites.set(bucket, c);
      return c;
    }
    // Cache of pre-rendered soft-circle sprites, one per base RGB color
    // (shared across every AvatarEffect instance/type, since the same
    // handful of hues — flame orange, energy yellow, toxic green, portal
    // purple, star_struck white — get reused constantly). Each sprite is
    // a radial gradient baked once from rgba(r,g,b,1) at center to
    // rgba(r,g,b,0) at the edge; per-particle fade is applied afterward
    // via ctx.globalAlpha rather than recomputing the gradient, which is
    // visually identical (globalAlpha scales every stop's alpha
    // uniformly, exactly what re-baking the gradient at a lower peak
    // alpha would do) but replaces a createRadialGradient() call per
    // particle per frame with one cheap drawImage().
    static _softCircleSprites = new Map();
    static _softCircleSprite(r, g, b) {
      const key = `${r},${g},${b}`;
      let sprite = AvatarEffect._softCircleSprites.get(key);
      if (sprite) return sprite;
      const SIZE = 64; // reference resolution; drawImage scales to actual particle size
      const c = document.createElement('canvas');
      c.width = c.height = SIZE;
      const sctx = c.getContext('2d');
      const grad = sctx.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE / 2);
      grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      sctx.fillStyle = grad;
      sctx.beginPath(); sctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2); sctx.fill();
      AvatarEffect._softCircleSprites.set(key, c);
      return c;
    }
    _softCircle(x, y, r, color) {
      const ctx = this.ctx;
      const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)/.exec(color);
      if (!match) {
        // Unexpected color format (shouldn't happen with current call
        // sites) — fall back to the original per-frame gradient so
        // nothing silently fails to render.
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, color); g.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        return;
      }
      const [, rr, gg, bb, aa] = match;
      const alpha = aa === undefined ? 1 : parseFloat(aa);
      const sprite = AvatarEffect._softCircleSprite(rr, gg, bb);
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = prevAlpha * alpha;
      ctx.drawImage(sprite, x - r, y - r, r * 2, r * 2);
      ctx.globalAlpha = prevAlpha;
    }
    _ringCircle(x, y, r, color) { const ctx = this.ctx; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.25, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); }
    _diamond(x, y, size, color) { const ctx = this.ctx; ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x, y - size * 1.5); ctx.lineTo(x + size * 0.8, y); ctx.lineTo(x, y + size * 1.5); ctx.lineTo(x - size * 0.8, y); ctx.closePath(); ctx.fill(); }

    _drawFlameGlow() {
      const ctx = this.ctx;
      const cx = this.center.x, cy = this.center.y;
      // slow "breathing" pulse so the fire's light swells and settles instead of sitting static
      const pulse = 0.75 + 0.25 * (0.5 + 0.5 * Math.sin(this.time * 1.4));

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this._softCircle(cx, cy, this.radius * 1.2 * pulse, `rgba(255,110,30,${0.16 * pulse})`);
      this._softCircle(cx, cy - this.radius * 0.35, this.radius * 0.95 * pulse, `rgba(255,190,70,${0.13 * pulse})`);

      // hot base glow right at the avatar edge, like coals underneath the flame
      for (let pass = 0; pass < 3; pass++) {
        ctx.beginPath();
        ctx.arc(cx, cy, this.radius * (0.97 - pass * 0.04), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,200,120,${0.2 - pass * 0.05})`;
        ctx.lineWidth = 2 + pass * 2;
        ctx.stroke();
      }
      ctx.restore();
    }

    _drawStarStruckRing() {
      const ctx = this.ctx;
      const cx = this.center.x, cy = this.center.y;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this._softCircle(cx, cy, this.radius * 1.5, 'rgba(140,150,210,0.10)');

      // crescent moon fixed near the top of the ring, like a badge on the frame, overlapping the avatar edge
      const moonR = this.radius * 0.3;
      const moonX = cx, moonY = cy - this.radius * 0.92;
      this._softCircle(moonX, moonY, moonR * 1.9, 'rgba(255,255,240,0.28)');

      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#f5f3e8';
      ctx.beginPath();
      ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2);
      ctx.fill();

      // punch out a crescent by cutting a shifted circle from the moon disc
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(moonX + moonR * 0.55, moonY - moonR * 0.18, moonR * 0.92, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    }

    _drawSkull(x, y, size, alpha) {
      const ctx = this.ctx;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.fillStyle = '#e7e7f0';
      ctx.beginPath();
      ctx.arc(x, y - size * 0.1, size, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y + size * 0.5, size * 0.5, 0, Math.PI);
      ctx.fill();
      ctx.fillStyle = '#141018';
      ctx.beginPath();
      ctx.arc(x - size * 0.36, y - size * 0.15, size * 0.24, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x + size * 0.36, y - size * 0.15, size * 0.24, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, y + size * 0.05);
      ctx.lineTo(x - size * 0.11, y + size * 0.32);
      ctx.lineTo(x + size * 0.11, y + size * 0.32);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    _drawDragonBall(x, y, size, starCount, alpha) {
      const ctx = this.ctx;
      ctx.save();
      ctx.globalAlpha = alpha;

      // soft glow behind the orb
      this._softCircle(x, y, size * 1.8, 'rgba(255,150,40,0.16)');

      // glossy orange sphere body
      const grad = ctx.createRadialGradient(x - size * 0.35, y - size * 0.4, size * 0.1, x, y, size);
      grad.addColorStop(0, '#fff3d6');
      grad.addColorStop(0.28, '#ffb347');
      grad.addColorStop(0.7, '#ff8c1a');
      grad.addColorStop(1, '#c85e00');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(140,55,0,0.45)';
      ctx.lineWidth = 0.6;
      ctx.stroke();

      // red star cluster at center, count matches the ball's number (1-7)
      ctx.fillStyle = '#df2130';
      for (const pos of this._starClusterPositions(starCount, size * 0.34)) {
        this._tinyStar(x + pos.x, y + pos.y, size * 0.17);
      }

      ctx.restore();
    }

    _tinyStar(x, y, r) {
      const ctx = this.ctx;
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const outerA = (Math.PI * 2 * i) / 5 - Math.PI / 2;
        const innerA = outerA + Math.PI / 5;
        const ox = x + Math.cos(outerA) * r, oy = y + Math.sin(outerA) * r;
        const ix = x + Math.cos(innerA) * r * 0.45, iy = y + Math.sin(innerA) * r * 0.45;
        i === 0 ? ctx.moveTo(ox, oy) : ctx.lineTo(ox, oy);
        ctx.lineTo(ix, iy);
      }
      ctx.closePath();
      ctx.fill();
    }

    _starClusterPositions(count, spread) {
      if (count <= 1) return [{ x: 0, y: 0 }];
      const pts = [];
      for (let i = 0; i < count; i++) {
        const a = (Math.PI * 2 * i) / count;
        pts.push({ x: Math.cos(a) * spread * 0.6, y: Math.sin(a) * spread * 0.6 });
      }
      return pts;
    }

    // =====================================================================
    // Final Six — custom (non-particle) canvas decorations
    // Ported from the standalone preview (avatar radius 80 / orbit radii
    // ~88-120 on a 340px canvas). this._s scales those absolute pixel
    // values against this.radius so the effect sits correctly on whatever
    // canvas size the decoration is rendered at (equipped avatar vs. the
    // small store-preview canvas).
    // =====================================================================
    _initCustom() {
      this._s = this.radius / 80;
      switch (this.type) {
        case 'raven-curse':
          this._ravens = [0, 1, 2].map(i => ({ offset: i * (Math.PI * 2 / 3), trail: [] }));
          break;
        case 'lord-of-dead':
          this._smoke = this._makeSmokeField(22, Math.PI * 1.05, Math.PI * 1.95, this.radius * 1.1);
          this._wisps = [];
          break;
        case 'watcher-ring':
          this._eyes = Array.from({ length: 6 }, (_, i) => ({ angle: i * (Math.PI * 2 / 6), blinkOffset: Math.random() * 10, tilt: (Math.random() - 0.5) * 0.4 }));
          break;
        case 'black-widow':
          break;
        case 'styx-spirits':
          this._smoke = this._makeSmokeField(34, 0, Math.PI * 2, this.radius);
          this._wisps = [];
          break;
        case 'creeping-roots':
          this._trunks = this._buildRootTrunks(this._s);
          this._rootPhase = Math.random();
          break;
        case 'legend-shield':
        case 'vs-impact':
        case 'hero-cape':
        case 'voltage-bolt':
        case 'champions-crown':
          // Just a random time offset so several people wearing the same
          // badge don't all glint/twinkle/crackle in perfect unison.
          this._badgePhase = Math.random() * 6000;
          break;
      }
    }

    _drawCustomFrame() {
      const t = this.time * 1000; // these were all tuned against a ms timestamp
      switch (this.type) {
        case 'raven-curse': this._drawRavenCurse(t); break;
        case 'lord-of-dead': this._drawLordOfDead(t); break;
        case 'watcher-ring': this._drawWatcherRing(t); break;
        case 'black-widow': this._drawBlackWidow(t); break;
        case 'styx-spirits': this._drawStyxSpirits(t); break;
        case 'creeping-roots': this._drawCreepingRoots(t); break;
        case 'legend-shield': this._drawLegendShield(t + this._badgePhase); break;
        case 'vs-impact': this._drawVsImpact(t + this._badgePhase); break;
        case 'hero-cape': this._drawHeroCape(t + this._badgePhase); break;
        case 'voltage-bolt': this._drawVoltageBolt(t + this._badgePhase); break;
        case 'champions-crown': this._drawChampionsCrown(t + this._badgePhase); break;
      }
    }

    // ---- shared smoke/mist field + drifting glow-dot wisp helpers ----
    _makeSmokeField(n, angleMin, angleMax, baseRadius) {
      return Array.from({ length: n }, () => ({
        baseAngle: angleMin + Math.random() * (angleMax - angleMin),
        drift: (Math.random() * 0.00006 + 0.000015) * (Math.random() < 0.5 ? 1 : -1),
        baseRadius: baseRadius + Math.random() * 10 - 5,
        ampR: 3 + Math.random() * 5,
        freqR: 0.00018 + Math.random() * 0.00035,
        phaseR: Math.random() * 100,
        size: (18 + Math.random() * 18) * this._s,
        pulseFreq: 0.0006 + Math.random() * 0.0009,
        phasePulse: Math.random() * 100,
        face: Math.random() < 0.18
      }));
    }
    _drawSmokePuff(x, y, size, alpha, color) {
      const ctx = this.ctx;
      const g = ctx.createRadialGradient(x, y, 0, x, y, size);
      g.addColorStop(0, `rgba(${color},${alpha})`);
      g.addColorStop(0.55, `rgba(${color},${alpha * 0.35})`);
      g.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();
    }
    _drawTinyWraithFace(x, y, scale, alpha) {
      const ctx = this.ctx;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(5,20,22,0.9)';
      ctx.beginPath(); ctx.arc(x - 1.6 * scale, y, 0.9 * scale, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 1.6 * scale, y, 0.9 * scale, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(x, y + 2.6 * scale, 0.8 * scale, 1.4 * scale, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    _drawSmokeFieldFrame(field, t, color, blurPx) {
      const ctx = this.ctx, CX = this.center.x, CY = this.center.y;
      ctx.save();
      ctx.filter = `blur(${blurPx}px)`;
      ctx.globalCompositeOperation = 'lighter';
      field.forEach(p => {
        const angle = p.baseAngle + t * p.drift;
        const r = p.baseRadius + Math.sin(t * p.freqR + p.phaseR) * p.ampR;
        const x = CX + Math.cos(angle) * r, y = CY + Math.sin(angle) * r;
        const alpha = 0.3 + Math.sin(t * p.pulseFreq + p.phasePulse) * 0.08;
        this._drawSmokePuff(x, y, p.size, Math.max(0.08, alpha), color);
      });
      ctx.filter = 'none';
      ctx.restore();
      field.forEach(p => {
        if (!p.face) return;
        const angle = p.baseAngle + t * p.drift;
        const r = p.baseRadius + Math.sin(t * p.freqR + p.phaseR) * p.ampR;
        const x = CX + Math.cos(angle) * r, y = CY + Math.sin(angle) * r;
        const alpha = 0.3 + Math.sin(t * 0.0018 + p.phasePulse) * 0.25;
        this._drawTinyWraithFace(x, y, p.size * 0.14, Math.max(0, alpha));
      });
    }
    _stepWisp(p, dt) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; return p.life > 0; }
    _drawWisp(p) {
      const ctx = this.ctx;
      const a = Math.max(0, p.life / p.maxLife) * p.alphaMul;
      ctx.globalAlpha = a;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
      g.addColorStop(0, `rgba(${p.color},${a})`); g.addColorStop(1, `rgba(${p.color},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // ---- 1. Raven's Curse ----
    _drawRavenCurse(t) {
      const ctx = this.ctx, CX = this.center.x, CY = this.center.y, k = this._s;
      const orbitR = this.radius * 1.18;
      this._ravens.forEach(rv => {
        const ang = t * 0.00035 + rv.offset;
        const x = CX + Math.cos(ang) * orbitR, y = CY + Math.sin(ang) * orbitR * 0.85;
        rv.trail.push({ x, y, life: 0.4, maxLife: 0.4 });
        rv.trail = rv.trail.filter(p => { p.life -= 0.012; return p.life > 0; });
        ctx.globalCompositeOperation = 'lighter';
        rv.trail.forEach(p => {
          ctx.globalAlpha = (p.life / p.maxLife) * 0.15; ctx.fillStyle = '#7a5ea8';
          ctx.beginPath(); ctx.arc(p.x, p.y, 6 * k, 0, Math.PI * 2); ctx.fill();
        });
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        const flap = Math.sin(t * 0.008 + rv.offset * 3);
        const heading = ang + Math.PI / 2;
        ctx.save(); ctx.translate(x, y); ctx.rotate(heading); ctx.scale(k, k);
        ctx.shadowColor = 'rgba(90,60,140,0.6)'; ctx.shadowBlur = 6;
        this._drawRavenShape(flap);
        ctx.restore();
      });
    }
    _drawRavenShape(flap) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(0, -4); ctx.quadraticCurveTo(6, 0, 0, 5); ctx.quadraticCurveTo(-6, 0, 0, -4);
      ctx.fillStyle = '#0c0a0d'; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, -1); ctx.quadraticCurveTo(14, -4 - flap * 10, 22, 1 - flap * 4); ctx.quadraticCurveTo(10, 2, 0, 2);
      ctx.fillStyle = '#0c0a0d'; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, -1); ctx.quadraticCurveTo(-14, -4 - flap * 10, -22, 1 - flap * 4); ctx.quadraticCurveTo(-10, 2, 0, 2);
      ctx.fillStyle = '#0c0a0d'; ctx.fill();
    }

    // ---- 2. Lord of the Dead ----
    _drawLordOfDead(t) {
      const ctx = this.ctx, CX = this.center.x, CY = this.center.y, k = this._s;
      this._drawSmokeFieldFrame(this._smoke, t, '220,60,50', 8);
      const positions = [
        { a: 0.62, s: 0.85 }, { a: 0.85, s: 1.0 }, { a: 1.1, s: 1.05 },
        { a: 1.35, s: 1.0 }, { a: 1.6, s: 0.85 }, { a: 1.85, s: 0.75 }
      ];
      positions.forEach((p, i) => {
        const bob = Math.sin(t * 0.0015 + i) * 1.5 * k;
        const x = CX + Math.cos(Math.PI * p.a) * this.radius * 0.95;
        const y = CY + Math.sin(Math.PI * p.a) * this.radius * 0.95 * 0.9 + bob;
        ctx.save(); ctx.translate(x, y); ctx.scale(k, k); this._drawLordSkull(p.s, t, i * 1.7); ctx.restore();
      });
      if (Math.random() < 0.15) {
        const a = Math.PI * 0.15 + Math.random() * Math.PI * 0.7;
        this._wisps.push({ x: CX + Math.cos(a) * this.radius * 0.9, y: CY + Math.sin(a) * this.radius * 0.9,
          vx: (Math.random() - 0.5) * 2.5, vy: -(6 + Math.random() * 5), life: 1.6, maxLife: 1.6, size: 3 * k, color: '220,70,60', alphaMul: 0.55 });
      }
      this._wisps = this._wisps.filter(p => this._stepWisp(p, 0.04));
      ctx.globalCompositeOperation = 'lighter';
      this._wisps.forEach(p => this._drawWisp(p));
      ctx.globalCompositeOperation = 'source-over';
    }
    _drawLordSkull(s, t, seed) {
      const ctx = this.ctx;
      ctx.save(); ctx.scale(s, s);
      ctx.beginPath();
      ctx.arc(0, -2, 9, Math.PI, 0);
      ctx.lineTo(6, 8); ctx.lineTo(3, 6); ctx.lineTo(0, 9); ctx.lineTo(-3, 6); ctx.lineTo(-6, 8);
      ctx.closePath();
      ctx.fillStyle = '#cfc6b8';
      ctx.fill();
      ctx.strokeStyle = 'rgba(40,30,25,0.6)';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(-1, -10); ctx.lineTo(1, -4); ctx.lineTo(-1, 0); ctx.lineTo(2, 5);
      ctx.stroke();
      const pulse = 0.65 + Math.sin(t * 0.005 + seed) * 0.35;
      ctx.globalCompositeOperation = 'lighter';
      [-3.5, 3.5].forEach(dx => {
        const g = ctx.createRadialGradient(dx, -2, 0, dx, -2, 4.5);
        g.addColorStop(0, `rgba(255,40,30,${pulse})`);
        g.addColorStop(0.5, `rgba(200,10,10,${pulse * 0.6})`);
        g.addColorStop(1, 'rgba(120,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(dx, -2, 4.5, 0, Math.PI * 2); ctx.fill();
      });
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#0a0605';
      ctx.beginPath(); ctx.arc(-3.5, -2, 2.1, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(3.5, -2, 2.1, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(255,70,50,${pulse})`;
      ctx.beginPath(); ctx.arc(-3.5, -2, 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(3.5, -2, 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#cfc6b8';
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 2.2 - 0.8, 7); ctx.lineTo(i * 2.2 + 0.8, 7); ctx.lineTo(i * 2.2, 9.5);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }

    // ---- 3. Watcher's Ring ----
    _drawWatcherRing(t) {
      const ctx = this.ctx, CX = this.center.x, CY = this.center.y, k = this._s;
      this._eyes.forEach(e => {
        const ex = CX + Math.cos(e.angle) * this.radius * 1.12, ey = CY + Math.sin(e.angle) * this.radius * 1.12;
        const blinkPhase = Math.abs(Math.sin(t * 0.0015 + e.blinkOffset));
        const openness = blinkPhase > 0.96 ? 0.06 : 1;
        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(e.angle + Math.PI / 2 + e.tilt * 0.3);
        ctx.scale(k, k);
        ctx.shadowColor = 'rgba(255,140,50,0.35)'; ctx.shadowBlur = 5;
        this._drawRealEye(openness);
        ctx.restore();
      });
    }
    // The eye artwork below (sclera, iris, pupil, highlight, lid shadow,
    // lashes) never varies frame to frame — no color or shape here
    // depends on time or particle state, only the blink squash (which
    // is a transform the caller already applies). So unlike _softCircle
    // or the flame sprites above, this needs exactly one cached sprite,
    // ever, reused by every eye on every Watcher's Ring. 2x supersampled
    // so it stays crisp when drawImage scales it back to the small size
    // it renders at on an avatar.
    static _realEyeSprite = null;
    static _getRealEyeSprite() {
      if (AvatarEffect._realEyeSprite) return AvatarEffect._realEyeSprite;
      const SCALE = 2;
      // Local coordinate bounds of the artwork below: x in [-11,11],
      // y in [-7,6.5] (the lid ellipse reaches the highest point).
      // Padded slightly to [-12,12] / [-7,7].
      const W = 24, H = 14;
      const c = document.createElement('canvas');
      c.width = W * SCALE; c.height = H * SCALE;
      const sctx = c.getContext('2d');
      sctx.scale(SCALE, SCALE);
      sctx.translate(W / 2, H / 2); // local (0,0) -> center of the sprite
      sctx.beginPath();
      sctx.ellipse(0, 0, 11, 6.5, 0, 0, Math.PI * 2);
      const scleraG = sctx.createRadialGradient(0, 0, 1, 0, 0, 11);
      scleraG.addColorStop(0, '#efe7da');
      scleraG.addColorStop(1, '#cfc2b0');
      sctx.fillStyle = scleraG;
      sctx.fill();
      sctx.strokeStyle = 'rgba(150,30,30,0.35)';
      sctx.lineWidth = 0.4;
      sctx.beginPath(); sctx.moveTo(-9, 1); sctx.quadraticCurveTo(-5, 3, -2, 0.5); sctx.stroke();
      sctx.beginPath(); sctx.moveTo(8, -1); sctx.quadraticCurveTo(4, 2, 1.5, 0.5); sctx.stroke();
      sctx.beginPath(); sctx.moveTo(-6, -3); sctx.quadraticCurveTo(-3, -1, -0.5, -0.5); sctx.stroke();
      const irisG = sctx.createRadialGradient(0, 0, 0.5, 0, 0, 4.4);
      irisG.addColorStop(0, '#ffb347');
      irisG.addColorStop(0.55, '#a8420f');
      irisG.addColorStop(1, '#3a1305');
      sctx.fillStyle = irisG;
      sctx.beginPath(); sctx.arc(0, 0, 4.4, 0, Math.PI * 2); sctx.fill();
      sctx.fillStyle = '#050302';
      sctx.beginPath(); sctx.arc(0, 0, 2, 0, Math.PI * 2); sctx.fill();
      sctx.fillStyle = 'rgba(255,255,255,0.85)';
      sctx.beginPath(); sctx.arc(-1.3, -1.3, 0.9, 0, Math.PI * 2); sctx.fill();
      sctx.beginPath();
      sctx.ellipse(0, -3.4, 11.5, 3.6, 0, 0, Math.PI * 2);
      const lidG = sctx.createLinearGradient(0, -7, 0, 0);
      lidG.addColorStop(0, 'rgba(0,0,0,0.55)');
      lidG.addColorStop(1, 'rgba(0,0,0,0)');
      sctx.fillStyle = lidG;
      sctx.fill();
      sctx.beginPath(); sctx.ellipse(0, 0, 11, 6.5, 0, 0, Math.PI * 2);
      sctx.lineWidth = 0.7; sctx.strokeStyle = 'rgba(10,8,6,0.7)'; sctx.stroke();
      AvatarEffect._realEyeSprite = { canvas: c, w: W, h: H };
      return AvatarEffect._realEyeSprite;
    }
    _drawRealEye(blink) {
      const ctx = this.ctx;
      const sprite = AvatarEffect._getRealEyeSprite();
      ctx.save();
      ctx.scale(1, blink);
      ctx.drawImage(sprite.canvas, -sprite.w / 2, -sprite.h / 2, sprite.w, sprite.h);
      ctx.restore();
    }


    // ---- 4. Black Widow ----
    _drawBlackWidow(t) {
      const ctx = this.ctx, CX = this.center.x, CY = this.center.y, k = this._s, radius = this.radius * 1.15;
      ctx.strokeStyle = 'rgba(200,200,210,0.12)';
      ctx.lineWidth = 0.6;
      for (let i = 0; i < 10; i++) {
        const a1 = i * (Math.PI * 2 / 10), a2 = a1 + Math.PI * 0.7;
        ctx.beginPath();
        ctx.moveTo(CX + Math.cos(a1) * radius, CY + Math.sin(a1) * radius);
        ctx.lineTo(CX + Math.cos(a2) * radius, CY + Math.sin(a2) * radius);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(200,200,210,0.16)';
      ctx.beginPath(); ctx.arc(CX, CY, radius, 0, Math.PI * 2); ctx.stroke();
      const crawlAngle = t * 0.00015;
      const x = CX + Math.cos(crawlAngle) * radius, y = CY + Math.sin(crawlAngle) * radius;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(crawlAngle + Math.PI / 2);
      ctx.scale(k, k);
      this._drawSpider(t * 0.013);
      ctx.restore();
    }
    _drawSpider(legPhase) {
      const ctx = this.ctx;
      ctx.strokeStyle = '#0d0a0b'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
      for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < 4; i++) {
          const baseAngle = side * (0.5 + i * 0.35);
          const wiggle = Math.sin(legPhase + i * 1.3) * 0.15;
          const kneeX = Math.cos(baseAngle + wiggle) * 14, kneeY = Math.sin(baseAngle + wiggle) * 8 - 2;
          const footX = Math.cos(baseAngle + wiggle) * 24, footY = Math.sin(baseAngle + wiggle) * 20 - 4;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.quadraticCurveTo(kneeX, kneeY, footX, footY);
          ctx.stroke();
        }
      }
      ctx.beginPath(); ctx.ellipse(0, 7, 8, 9, 0, 0, Math.PI * 2);
      const bg = ctx.createRadialGradient(0, 4, 1, 0, 7, 10);
      bg.addColorStop(0, '#2a2224'); bg.addColorStop(1, '#0a0708');
      ctx.fillStyle = bg; ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(200,20,20,0.85)';
      ctx.beginPath();
      ctx.moveTo(0, 3); ctx.lineTo(3, 7); ctx.lineTo(0, 11); ctx.lineTo(-3, 7); ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.beginPath(); ctx.ellipse(0, -4, 5, 5, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#0f0b0c'; ctx.fill();
      ctx.fillStyle = '#d43a2a';
      ctx.shadowColor = '#d43a2a'; ctx.shadowBlur = 4;
      [[-1.6, -5], [1.6, -5], [-2.6, -3], [2.6, -3]].forEach(([dx, dy]) => {
        ctx.beginPath(); ctx.arc(dx, dy, 0.7, 0, Math.PI * 2); ctx.fill();
      });
      ctx.shadowBlur = 0;
    }

    // ---- 5. Styx Spirits ----
    _drawStyxSpirits(t) {
      const ctx = this.ctx, CX = this.center.x, CY = this.center.y, k = this._s;
      this._drawSmokeFieldFrame(this._smoke, t, '90,220,225', 8);
      if (Math.random() < 0.3) {
        const a = Math.random() * Math.PI * 2;
        this._wisps.push({ x: CX + Math.cos(a) * this.radius, y: CY + Math.sin(a) * this.radius,
          vx: (Math.random() - 0.5) * 3.5, vy: (Math.random() - 0.5) * 3.5, life: 1.4, maxLife: 1.4, size: 3 * k, color: '110,210,230', alphaMul: 0.5 });
      }
      this._wisps = this._wisps.filter(p => this._stepWisp(p, 0.045));
      ctx.globalCompositeOperation = 'lighter';
      this._wisps.forEach(p => this._drawWisp(p));
      ctx.globalCompositeOperation = 'source-over';
    }

    // ---- 6. Creeping Roots ----
    _bezierPoint(p0, p1, p2, tt) {
      const mt = 1 - tt;
      return { x: mt * mt * p0.x + 2 * mt * tt * p1.x + tt * tt * p2.x, y: mt * mt * p0.y + 2 * mt * tt * p1.y + tt * tt * p2.y };
    }
    _bezierTangentAngle(p0, p1, p2, tt) {
      const dx = 2 * (1 - tt) * (p1.x - p0.x) + 2 * tt * (p2.x - p1.x);
      const dy = 2 * (1 - tt) * (p1.y - p0.y) + 2 * tt * (p2.y - p1.y);
      return Math.atan2(dy, dx);
    }
    _easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }
    _segmentFromEdge(angle, curl, len) {
      const CX = this.center.x, CY = this.center.y, edgeR = this.radius;
      const p0 = { x: CX + Math.cos(angle) * edgeR, y: CY + Math.sin(angle) * edgeR };
      const midAngle = angle + curl * 0.4;
      const midR = edgeR - len * 0.55;
      const p1 = { x: CX + Math.cos(midAngle) * midR, y: CY + Math.sin(midAngle) * midR };
      const endAngle = angle + curl;
      const endR = Math.max(4, edgeR - len);
      const p2 = { x: CX + Math.cos(endAngle) * endR, y: CY + Math.sin(endAngle) * endR };
      return [p0, p1, p2];
    }
    _segmentFrom(start, dirAngle, curl, len) {
      const midAngle = dirAngle + curl * 0.4;
      const p1 = { x: start.x + Math.cos(midAngle) * len * 0.5, y: start.y + Math.sin(midAngle) * len * 0.5 };
      const endAngle = dirAngle + curl;
      const p2 = { x: start.x + Math.cos(endAngle) * len, y: start.y + Math.sin(endAngle) * len };
      return [{ x: start.x, y: start.y }, p1, p2];
    }
    _buildRootTrunks(s) {
      const N_TRUNKS = 6;
      return Array.from({ length: N_TRUNKS }, (_, i) => {
        const angle = i * (Math.PI * 2 / N_TRUNKS) + (Math.random() - 0.5) * 0.35;
        const curl = (Math.random() - 0.5) * 1.0;
        const len = (58 + Math.random() * 30) * s;
        const [p0, p1, p2] = this._segmentFromEdge(angle, curl, len);
        const seg = { p0, p1, p2, width: 4.6 * s, growStart: 0, growEnd: 0.5, children: [] };
        const nChild = 1 + (Math.random() < 0.7 ? 1 : 0);
        for (let c = 0; c < nChild; c++) {
          const attachT = 0.4 + Math.random() * 0.35;
          const attachPt = this._bezierPoint(p0, p1, p2, attachT);
          const tangent = this._bezierTangentAngle(p0, p1, p2, attachT);
          const bAngle = tangent + (Math.random() < 0.5 ? 1 : -1) * (0.6 + Math.random() * 0.5);
          const bCurl = (Math.random() - 0.5) * 0.9;
          const bLen = len * (0.5 + Math.random() * 0.25);
          const [q0, q1, q2] = this._segmentFrom(attachPt, bAngle, bCurl, bLen);
          const child = { p0: q0, p1: q1, p2: q2, width: 2.4 * s,
            growStart: 0.35 + attachT * 0.15, growEnd: 0.35 + attachT * 0.15 + 0.4, children: [] };
          if (Math.random() < 0.55) {
            const gT = 0.4 + Math.random() * 0.3;
            const gPt = this._bezierPoint(q0, q1, q2, gT);
            const gTangent = this._bezierTangentAngle(q0, q1, q2, gT);
            const gAngle = gTangent + (Math.random() < 0.5 ? 1 : -1) * (0.7 + Math.random() * 0.4);
            const gCurl = (Math.random() - 0.5) * 0.8;
            const gLen = bLen * 0.5;
            const [r0, r1, r2] = this._segmentFrom(gPt, gAngle, gCurl, gLen);
            child.children.push({ p0: r0, p1: r1, p2: r2, width: 1.3 * s,
              growStart: Math.min(0.85, child.growEnd * 0.75), growEnd: Math.min(0.98, child.growEnd * 0.75 + 0.25), children: [] });
          }
          seg.children.push(child);
        }
        return { angle, tip: seg.p2, seg };
      });
    }
    _drawTaperedSegment(p0, p1, p2, progress, baseWidth, colorDark, colorLight) {
      const ctx = this.ctx;
      if (progress <= 0.001) return;
      const steps = 22;
      const nSteps = Math.max(1, Math.floor(progress * steps));
      for (let i = 0; i < nSteps; i++) {
        const tt0 = i / steps, tt1 = (i + 1) / steps;
        const a = this._bezierPoint(p0, p1, p2, tt0);
        const b = this._bezierPoint(p0, p1, p2, tt1);
        const w = Math.max(0.5, baseWidth * (1 - tt0 * 0.8));
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.lineWidth = w; ctx.lineCap = 'round';
        ctx.strokeStyle = tt0 < 0.55 ? colorDark : colorLight;
        ctx.stroke();
      }
      if (progress > 0.04 && progress < 0.97) {
        const tip = this._bezierPoint(p0, p1, p2, Math.min(0.999, progress));
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, 4.5);
        g.addColorStop(0, 'rgba(160,20,10,0.5)');
        g.addColorStop(1, 'rgba(160,20,10,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(tip.x, tip.y, 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }
    _drawSegRecursive(seg, localT, HOLD_END) {
      const rawWindow = seg.growEnd > seg.growStart ? (localT - seg.growStart) / (seg.growEnd - seg.growStart) : 1;
      const growFrac = this._easeOutCubic(Math.max(0, Math.min(1, rawWindow)));
      let progress = growFrac;
      if (localT > HOLD_END) {
        const retreat = Math.max(0, 1 - (localT - HOLD_END) / (1 - HOLD_END));
        progress = growFrac * retreat;
      }
      this._drawTaperedSegment(seg.p0, seg.p1, seg.p2, progress, seg.width, '#1c1410', '#3b2a1e');
      seg.children.forEach(child => this._drawSegRecursive(child, localT, HOLD_END));
    }
    _drawCreepingRoots(t) {
      const ctx = this.ctx, CX = this.center.x, CY = this.center.y;
      const CYCLE = 20000, GROW_END = 0.55, HOLD_END = 0.82;
      const cycleLocal = ((t / CYCLE) + this._rootPhase) % 1;
      this._trunks.forEach(({ seg }) => this._drawSegRecursive(seg, cycleLocal, HOLD_END));
      for (let i = 0; i < this._trunks.length; i++) {
        const a = this._trunks[i], b = this._trunks[(i + 1) % this._trunks.length];
        if (cycleLocal >= GROW_END * 0.7) {
          const midAngle = (a.angle + b.angle) / 2;
          const pull = 34 * this._s;
          const mid = { x: CX + Math.cos(midAngle) * pull, y: CY + Math.sin(midAngle) * pull };
          let connProgress = 1;
          if (cycleLocal < GROW_END) connProgress = Math.max(0, (cycleLocal - GROW_END * 0.7) / (GROW_END * 0.3));
          else if (cycleLocal > HOLD_END) connProgress = Math.max(0, 1 - (cycleLocal - HOLD_END) / (1 - HOLD_END));
          this._drawTaperedSegment(a.tip, mid, b.tip, connProgress, 1.1 * this._s, '#1c1410', '#2e2118');
        }
      }
    }

    // ---- shared 5-point star path (used by Legend Shield's center mark) ----
    _drawStarPath(cx, cy, points, outerR, innerR) {
      const ctx = this.ctx;
      ctx.beginPath();
      for (let i = 0; i < points * 2; i++) {
        const rad = i % 2 === 0 ? outerR : innerR;
        const a = (Math.PI / points) * i - Math.PI / 2;
        const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }

    // A plain star-shield badge sitting at the bottom edge, like a worn
    // medal — no orbiting or particles, just a slow breathing scale and a
    // gold glint sweeping across it.
    _drawLegendShield(t) {
      const ctx = this.ctx, CX = this.center.x, CY = this.center.y, s = this._s, r = this.radius;
      const cx = CX, cy = CY + r * 0.78;
      const breathe = 1 + Math.sin(t * 0.0009) * 0.035;
      const w = 15 * s * breathe, h = 18 * s * breathe;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.beginPath();
      ctx.moveTo(0, -h);
      ctx.lineTo(w, -h * 0.35);
      ctx.lineTo(w * 0.75, h * 0.55);
      ctx.lineTo(0, h);
      ctx.lineTo(-w * 0.75, h * 0.55);
      ctx.lineTo(-w, -h * 0.35);
      ctx.closePath();
      const shinePos = (Math.sin(t * 0.0005) + 1) / 2;
      const grad = ctx.createLinearGradient(-w, -h, w, h);
      grad.addColorStop(Math.max(0, shinePos - 0.25), '#8a6a1e');
      grad.addColorStop(shinePos, '#FFE9A8');
      grad.addColorStop(Math.min(1, shinePos + 0.25), '#8a6a1e');
      ctx.fillStyle = grad;
      ctx.shadowColor = 'rgba(255,213,74,0.5)'; ctx.shadowBlur = 5 * s;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1 * s; ctx.strokeStyle = 'rgba(20,14,4,0.7)'; ctx.stroke();
      ctx.fillStyle = '#1a1206';
      this._drawStarPath(0, -h * 0.05, 5, 4 * s, 1.8 * s);
      ctx.fill();
      ctx.restore();
    }

    // A "VS" impact badge with a handful of static-ish radiating lines —
    // this app's whole identity is head-to-head matchups, so this is the
    // one badge that's explicitly app-themed rather than generic-hero.
    _drawVsImpact(t) {
      const ctx = this.ctx, CX = this.center.x, CY = this.center.y, s = this._s, r = this.radius;
      const pulse = 0.85 + Math.sin(t * 0.0012) * 0.15;
      const rays = 10;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < rays; i++) {
        const a = (i / rays) * Math.PI * 2 + t * 0.00006;
        const len = r * (1.05 + (i % 2 === 0 ? 0.18 : 0.06)) * pulse;
        const x1 = CX + Math.cos(a) * r * 0.9, y1 = CY + Math.sin(a) * r * 0.9;
        const x2 = CX + Math.cos(a) * len, y2 = CY + Math.sin(a) * len;
        ctx.strokeStyle = `rgba(255,213,74,${0.28 * pulse})`;
        ctx.lineWidth = (i % 2 === 0 ? 2.2 : 1.2) * s;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
      ctx.restore();
      const bx = CX, by = CY + r * 0.82;
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(Math.sin(t * 0.0007) * 0.04);
      const bw = 13 * s, bh = 9 * s;
      ctx.beginPath();
      ctx.ellipse(0, 0, bw, bh, 0, 0, Math.PI * 2);
      const g = ctx.createLinearGradient(-bw, 0, bw, 0);
      g.addColorStop(0, '#7a0c1e'); g.addColorStop(0.5, '#E8B923'); g.addColorStop(1, '#7a0c1e');
      ctx.fillStyle = g;
      ctx.shadowColor = 'rgba(184,16,42,0.6)'; ctx.shadowBlur = 5 * s;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1 * s; ctx.strokeStyle = 'rgba(20,10,4,0.75)'; ctx.stroke();
      ctx.fillStyle = '#0d0705';
      ctx.font = `900 ${9 * s}px Arial, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('VS', 0, 0.5 * s);
      ctx.restore();
    }

    // Two cape ribbons anchored to the ring's upper sides and flaring
    // outward/down — anchored AT the ring edge and flowing away from
    // center, so (unlike a full cape shape) it can never cross in front
    // of the avatar photo itself. Slow sway only, no other motion.
    _drawHeroCape(t) {
      const ctx = this.ctx, CX = this.center.x, CY = this.center.y, s = this._s, r = this.radius;
      const sway = Math.sin(t * 0.0006) * 0.12;
      [-1, 1].forEach(side => {
        const baseAngle = side * 0.95 + Math.PI * 0.5;
        const ax = CX + Math.cos(baseAngle) * r, ay = CY + Math.sin(baseAngle) * r;
        const midAngle = baseAngle + side * 0.3 + sway * side * 0.6;
        const mx = CX + Math.cos(midAngle) * r * 1.15, my = CY + Math.sin(midAngle) * r * 1.15;
        const flowAngle = baseAngle + side * 0.55 + sway * side;
        const tx = CX + Math.cos(flowAngle) * r * 1.55, ty = CY + Math.sin(flowAngle) * r * 1.55;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(mx, my, tx, ty);
        ctx.lineWidth = 5 * s;
        ctx.lineCap = 'round';
        const g = ctx.createLinearGradient(ax, ay, tx, ty);
        g.addColorStop(0, 'rgba(184,16,42,0.75)');
        g.addColorStop(1, 'rgba(120,8,20,0.15)');
        ctx.strokeStyle = g;
        ctx.stroke();
      });
    }

    // A bolt badge on the upper-right that's static almost all the time,
    // with an occasional bright crackle rather than continuous motion.
    _drawVoltageBolt(t) {
      const ctx = this.ctx, CX = this.center.x, CY = this.center.y, s = this._s, r = this.radius;
      const angle = -Math.PI * 0.32;
      const bx = CX + Math.cos(angle) * r * 0.92, by = CY + Math.sin(angle) * r * 0.92;
      const crackle = Math.sin(t * 0.003) > 0.85 ? 1 : 0.55 + Math.sin(t * 0.0015) * 0.15;
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(0.35);
      ctx.scale(s, s);
      ctx.beginPath();
      ctx.moveTo(2, -11); ctx.lineTo(-6, 1); ctx.lineTo(-1, 1); ctx.lineTo(-3, 11);
      ctx.lineTo(7, -2); ctx.lineTo(2, -2); ctx.closePath();
      ctx.fillStyle = `rgba(255,224,120,${crackle})`;
      ctx.shadowColor = `rgba(255,213,74,${crackle})`; ctx.shadowBlur = 7;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 0.8; ctx.strokeStyle = 'rgba(120,80,10,0.6)'; ctx.stroke();
      ctx.restore();
    }

    // A crown sitting at the top edge — static aside from three softly
    // twinkling gems (staggered phase) and a slow gold shine sweep.
    _drawChampionsCrown(t) {
      const ctx = this.ctx, CX = this.center.x, CY = this.center.y, s = this._s, r = this.radius;
      ctx.save();
      ctx.translate(CX, CY - r * 0.85);
      ctx.scale(s, s);
      const shinePos = (Math.sin(t * 0.0004) + 1) / 2;
      ctx.beginPath();
      ctx.moveTo(-11, 5); ctx.lineTo(-11, -3); ctx.lineTo(-6, 3); ctx.lineTo(-3.5, -7);
      ctx.lineTo(0, 2); ctx.lineTo(3.5, -7); ctx.lineTo(6, 3); ctx.lineTo(11, -3);
      ctx.lineTo(11, 5); ctx.closePath();
      const g = ctx.createLinearGradient(-11, 0, 11, 0);
      g.addColorStop(Math.max(0, shinePos - 0.3), '#9a7418');
      g.addColorStop(shinePos, '#FFE9A8');
      g.addColorStop(Math.min(1, shinePos + 0.3), '#9a7418');
      ctx.fillStyle = g;
      ctx.shadowColor = 'rgba(255,213,74,0.5)'; ctx.shadowBlur = 5;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 0.7; ctx.strokeStyle = 'rgba(20,14,4,0.7)'; ctx.stroke();
      [[-3.5, -6], [0, 1], [3.5, -6]].forEach(([gx, gy], i) => {
        const twinkle = 0.5 + Math.sin(t * 0.0025 + i * 2) * 0.5;
        ctx.fillStyle = `rgba(184,16,42,${0.6 + twinkle * 0.4})`;
        ctx.beginPath(); ctx.arc(gx, gy, 1.3, 0, Math.PI * 2); ctx.fill();
      });
      ctx.restore();
    }

    destroy() { this.active = false; AvatarEffect.instances.delete(this); this.ctx.clearRect(0, 0, this.width, this.height); }
  }

  // Finds any not-yet-activated canvas.avatar-fx-canvas elements under root
  // and starts their AvatarEffect. Safe to call repeatedly — canvases that
  // already have a running effect (canvas._avatarFx) are skipped.
  function activateCanvasFx(root){
    if (!root) return;
    root.querySelectorAll('canvas.avatar-fx-canvas').forEach(canvas => {
      if (canvas._avatarFx || !canvas.dataset.fxType) return;
      const opts = {};
      const mp = Number(canvas.dataset.fxParticles);
      if (mp) opts.maxParticles = mp;
      canvas._avatarFx = new AvatarEffect(canvas, canvas.dataset.fxType, opts);
      watchCanvasFxVisibility(canvas);
    });
  }
  // Stops and detaches any running AvatarEffect under root before its
  // canvas gets removed/replaced — otherwise the shared rAF loop keeps
  // ticking an instance whose canvas is no longer in the document.
  function deactivateCanvasFx(root){
    if (!root) return;
    root.querySelectorAll('canvas.avatar-fx-canvas').forEach(canvas => {
      if (canvas._avatarFx) { canvas._avatarFx.destroy(); canvas._avatarFx = null; }
      unwatchCanvasFxVisibility(canvas);
    });
  }

  // ---------------------------------------------------------------------
  // Card effects — a separate, much simpler engine from AvatarEffect.
  // AvatarEffect is built entirely around orbiting a ring (this.center /
  // this.radius), which fits avatar decorations but not a rectangular
  // full-card overlay. Card effects are plain per-canvas rAF loops instead
  // (same shape as the makeAurora/makeEmber/makeMeteor sample engine),
  // each one self-contained so a canvas can be destroyed independently.
  // All active canvases share a single throttled requestAnimationFrame
  // loop (see cardFxRegistry below) instead of one rAF per canvas — with
  // several previews visible at once in the Theme Store grid plus the
  // equipped one on the real card, that was N independent callbacks each
  // doing a full clear+redraw every browser frame, which is real jank on
  // slower phones. One shared loop, capped to ~30fps (plenty smooth for
  // slow-moving decorative overlays like these), cuts that down a lot.
  // ---------------------------------------------------------------------
  const prefersReducedMotionCardFx = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // User-facing "Animation quality" setting (Settings > Appearance) — see
  // applyFxQualityTier(). OS-level prefers-reduced-motion always wins over
  // whatever tier is picked (prefersReducedMotionCardFx above already
  // skips activation entirely in that case) — this only controls how
  // rich the effect is when it's running at all.
  const FX_QUALITY_TIERS = {
    saver: { fps: 18, meteorCount: 3, vineCount: 2 },
    balanced: { fps: 30, meteorCount: 5, vineCount: 4 },
    high: { fps: 60, meteorCount: 8, vineCount: 6 },
  };
  let fxQualityTier = FX_QUALITY_TIERS[localStorage.getItem('fictionClashFxTier')] ? localStorage.getItem('fictionClashFxTier') : 'balanced';
  let cardFxFrameInterval = 1000 / FX_QUALITY_TIERS[fxQualityTier].fps;
  const cardFxRegistry = new Set();
  let cardFxSharedRaf = null;
  let cardFxLastFrameTime = 0;
  function cardFxSharedTick(ts){
    cardFxSharedRaf = requestAnimationFrame(cardFxSharedTick);
    if (ts - cardFxLastFrameTime < cardFxFrameInterval) return;
    const dt = Math.min((ts - (cardFxLastFrameTime || ts)) / 1000, 0.1);
    cardFxLastFrameTime = ts;
    cardFxRegistry.forEach(entry => {
      if (entry.visible !== false) entry.draw(entry.ctx, ts / 1000, dt);
    });
  }
  function ensureCardFxLoopRunning(){
    if (cardFxSharedRaf == null) cardFxSharedRaf = requestAnimationFrame(cardFxSharedTick);
  }
  function stopCardFxLoopIfIdle(){
    if (cardFxRegistry.size === 0 && cardFxSharedRaf != null) {
      cancelAnimationFrame(cardFxSharedRaf);
      cardFxSharedRaf = null;
    }
  }
  // Pause both shared canvas-FX rAF loops (avatar decorations + card-fx)
  // while the tab/app is backgrounded. Browsers already throttle
  // background rAF on their own, but cancelling outright avoids the
  // wasted draw calls entirely, and clearing the lastTime/lastFrameTime
  // state means the first frame back computes a fresh, small delta
  // instead of one huge dt built up over however long the tab was
  // hidden (each loop's dt is already clamped to 0.1s as a backstop,
  // but resetting is cleaner than relying on the clamp).
  function pauseCanvasFxLoops(){
    if (AvatarEffect.rafId != null) { cancelAnimationFrame(AvatarEffect.rafId); AvatarEffect.rafId = null; }
    AvatarEffect.lastTime = 0;
    if (cardFxSharedRaf != null) { cancelAnimationFrame(cardFxSharedRaf); cardFxSharedRaf = null; }
    cardFxLastFrameTime = 0;
  }
  function resumeCanvasFxLoops(){
    if (AvatarEffect.instances.size > 0 && AvatarEffect.rafId == null) {
      AvatarEffect.lastTime = performance.now();
      AvatarEffect.rafId = requestAnimationFrame(AvatarEffect._globalTick);
    }
    if (cardFxRegistry.size > 0 && cardFxSharedRaf == null) {
      cardFxSharedRaf = requestAnimationFrame(cardFxSharedTick);
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseCanvasFxLoops();
    else resumeCanvasFxLoops();
  });
  // Changing tiers restarts any card-fx canvases currently on screen so
  // they pick up the new particle counts/fps immediately, instead of
  // only applying next time each one happens to remount.
  function applyFxQualityTier(tier){
    if (!FX_QUALITY_TIERS[tier]) return;
    fxQualityTier = tier;
    localStorage.setItem('fictionClashFxTier', tier);
    cardFxFrameInterval = 1000 / FX_QUALITY_TIERS[tier].fps;
    document.querySelectorAll('#fxQualityTabs [data-fx-tier]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.fxTier === tier);
    });
    document.querySelectorAll('canvas.card-fx-canvas').forEach(canvas => {
      if (canvas._cardFx) {
        const root = canvas.parentElement;
        canvas._cardFx.stop();
        canvas._cardFx = null;
        activateCardFx(root);
      }
    });
  }
  document.querySelectorAll('#fxQualityTabs [data-fx-tier]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.fxTier === fxQualityTier);
    btn.addEventListener('click', () => applyFxQualityTier(btn.dataset.fxTier));
  });

  // ---------- performance: pause animated profile-deco FX when offscreen ----------
  // The SVG/border decorations (.profile-deco / .profile-deco-fx /
  // .profile-deco-fx-web — hellflame, web-trap, voltage, frostbite,
  // bloodfang, solar-orbit, web-slinger, kryptonian, dark-knight,
  // thunderstrike, plus the plain glow borders) each run their own
  // always-on CSS `animation`, several combined with `filter:
  // blur()/drop-shadow()`. Unlike AvatarEffect's canvas particles, that
  // combo isn't compositor-only — the browser repaints the element every
  // animated frame — and unlike the canvas effects, nothing here was
  // pausing them off-screen, scaling them with the FX-quality tier, or
  // respecting prefers-reduced-motion. Since the same equipped decoration
  // can render simultaneously anywhere it's shown (a comment avatar, the
  // account header, a feed card), a busy comment thread could have several
  // of these animating at once with nothing throttling them — this is
  // likely the biggest single contributor to general (not scroll- or
  // screen-specific) sluggishness. Mirrors the activate/deactivateCanvasFx
  // pattern above, just pausing via animation-play-state instead of
  // tearing a canvas down.
  const DECO_FX_SELECTOR = '.profile-deco, .profile-deco-fx, .profile-deco-fx-web';
  let decoFxDisabled = prefersReducedMotionCardFx || fxQualityTier === 'saver';
  const decoFxObserver = ('IntersectionObserver' in window) ? new IntersectionObserver(entries => {
    entries.forEach(entry => {
      entry.target.style.animationPlayState = (entry.isIntersecting && !decoFxDisabled) ? 'running' : 'paused';
    });
  }, { rootMargin: '80px' }) : null;
  // Marks an element as watched so repeated calls (e.g. the mutation
  // observer firing on unrelated sibling inserts) don't re-observe it.
  function watchDecoFxEl(el){
    if (el._decoFxWatched) return;
    el._decoFxWatched = true;
    if (decoFxDisabled) { el.style.animationPlayState = 'paused'; return; }
    if (decoFxObserver) decoFxObserver.observe(el);
  }
  // Finds every not-yet-watched decoration under (or including) root.
  function watchDecoFx(root){
    if (!root || root.nodeType !== 1) return;
    if (root.matches?.(DECO_FX_SELECTOR)) watchDecoFxEl(root);
    root.querySelectorAll?.(DECO_FX_SELECTOR).forEach(watchDecoFxEl);
  }
  // Decorations get inserted via innerHTML at many different call sites
  // (comments streaming in live, the hero card, account header, store
  // grid) — rather than adding a watchDecoFx() call at every one of them,
  // a single mutation observer on the whole app catches every decoration
  // the moment it's attached to the page, wherever that happens.
  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(node => watchDecoFx(node));
    }
  }).observe(document.body, { childList: true, subtree: true });
  watchDecoFx(document.body); // catch anything already on the page at load

  // Re-applies immediately when the quality tier changes (a "Saver" pick
  // should stop these right away, not just for decorations rendered from
  // then on) — folds into the existing applyFxQualityTier() rather than a
  // second tier-change hook.
  const _applyFxQualityTierBase = applyFxQualityTier;
  applyFxQualityTier = function(tier){
    _applyFxQualityTierBase(tier);
    decoFxDisabled = prefersReducedMotionCardFx || fxQualityTier === 'saver';
    document.querySelectorAll(DECO_FX_SELECTOR).forEach(el => {
      el.style.animationPlayState = decoFxDisabled ? 'paused' : (decoFxObserver ? '' : 'running');
      if (decoFxObserver && !decoFxDisabled) decoFxObserver.observe(el); // safe to re-observe an already-observed element
    });
  };

  // ---------- performance: pause canvas particle FX when scrolled offscreen ----------
  // decoFxObserver above only covers the CSS-animated .profile-deco
  // elements. AvatarEffect instances and card-fx entries are separate
  // engines driven by their own shared rAF loops, and neither was
  // checking on-screen visibility — a comment avatar's particle
  // decoration, or an equipped card effect, kept doing a full
  // update+draw every frame for as long as its canvas stayed mounted,
  // even scrolled far out of view in a long comment thread or feed.
  // One shared observer for both canvas types, toggling a `visible`
  // flag consulted in each tick loop (see AvatarEffect._globalTick and
  // cardFxSharedTick) rather than destroying anything, so effects
  // resume mid-animation instead of restarting when scrolled back in.
  const canvasFxVisibilityObserver = ('IntersectionObserver' in window) ? new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const canvas = entry.target;
      const fx = canvas._avatarFx || canvas._cardFx?.entry;
      if (fx) fx.visible = entry.isIntersecting;
    });
  }, { rootMargin: '150px' }) : null;
  function watchCanvasFxVisibility(canvas){
    if (canvasFxVisibilityObserver) canvasFxVisibilityObserver.observe(canvas);
  }
  function unwatchCanvasFxVisibility(canvas){
    if (canvasFxVisibilityObserver) canvasFxVisibilityObserver.unobserve(canvas);
  }

  // Meteor card effect: the trail and glow-halo gradients below never
  // change color, and since the fall direction (dx/dy) is a single fixed
  // constant shared by every rock — not something rolled per-rock — they
  // never change orientation either. Only trail length and glow radius
  // vary, and only once, at spawn. So both bake to a single reference
  // sprite, shared by every meteor across every instance of this effect,
  // instead of allocating a fresh gradient per rock per frame.
  const METEOR_DX = -0.62, METEOR_DY = 0.78;
  const METEOR_ANGLE = Math.atan2(METEOR_DY, METEOR_DX);
  let meteorTrailSprite = null;
  function getMeteorTrailSprite(){
    if (meteorTrailSprite) return meteorTrailSprite;
    const LEN = 64, THICK = 8; // reference size; drawImage stretches non-uniformly per rock (safe here since the gradient only varies along length, not thickness)
    const c = document.createElement('canvas');
    c.width = LEN; c.height = THICK;
    const sctx = c.getContext('2d');
    const grad = sctx.createLinearGradient(0, 0, LEN, 0);
    grad.addColorStop(0, 'rgba(255,140,80,0)');
    grad.addColorStop(1, 'rgba(255,225,180,.85)');
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, LEN, THICK);
    meteorTrailSprite = { canvas: c };
    return meteorTrailSprite;
  }
  let meteorGlowSprite = null;
  function getMeteorGlowSprite(){
    if (meteorGlowSprite) return meteorGlowSprite;
    const SIZE = 64; // reference diameter (radius = SIZE/2)
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const sctx = c.getContext('2d');
    const grad = sctx.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE / 2);
    grad.addColorStop(0, 'rgba(255,190,120,.55)');
    grad.addColorStop(1, 'rgba(255,190,120,0)');
    sctx.fillStyle = grad;
    sctx.beginPath(); sctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2); sctx.fill();
    meteorGlowSprite = { canvas: c };
    return meteorGlowSprite;
  }

  function makeMeteorCardFx(w, h){
    const dx = METEOR_DX, dy = METEOR_DY;
    function spawn(atRandomPoint){
      const speed = Math.random() * 2.4 + 2.6;
      return {
        x: atRandomPoint ? Math.random() * w * 1.4 : w * 0.9 + Math.random() * w * 0.5,
        y: atRandomPoint ? Math.random() * h * 1.4 - h * 0.4 : -20 - Math.random() * 40,
        speed, size: Math.random() * 1.5 + 1.3, trail: Math.random() * 22 + 18,
        spin: Math.random() * Math.PI * 2, spinSpeed: (Math.random() - 0.5) * 0.3
      };
    }
    const rocks = Array.from({ length: FX_QUALITY_TIERS[fxQualityTier].meteorCount }, () => spawn(true));
    const trailSprite = getMeteorTrailSprite();
    const glowSprite = getMeteorGlowSprite();
    return function draw(ctx){
      ctx.clearRect(0, 0, w, h);
      rocks.forEach(m => {
        m.x += dx * m.speed; m.y += dy * m.speed; m.spin += m.spinSpeed;
        if (m.y > h + 30 || m.x < -30) Object.assign(m, spawn(false));
        const tx = m.x - dx * m.trail, ty = m.y - dy * m.trail;
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(METEOR_ANGLE);
        ctx.drawImage(trailSprite.canvas, 0, -m.size / 2, m.trail, m.size);
        ctx.restore();
        // A small radial-gradient halo stands in for the glow that
        // ctx.shadowBlur used to give the meteor head — shadowBlur is one
        // of the more expensive canvas ops (it's a real per-pixel blur,
        // recomputed every frame for every rock), where this is just one
        // more cached sprite drawn at the rock's current size/position.
        ctx.save();
        ctx.translate(m.x, m.y); ctx.rotate(m.spin);
        ctx.drawImage(glowSprite.canvas, -m.size * 3, -m.size * 3, m.size * 6, m.size * 6);
        ctx.fillStyle = '#ffdca8';
        ctx.beginPath(); ctx.arc(0, 0, m.size * 1.6, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      });
    };
  }


  // Vines creep in from all four edges toward the middle, sprouting a
  // few leaves as they grow, then wilt/fade and re-sprout from a new
  // point — a slow, looping "reclaiming the card" cycle rather than a
  // one-shot grow. Each vine is a hand-drawn curved stem (quadratic
  // control point bowed sideways) built up point-by-point as t advances.
  function makePlantsCardFx(w, h){
    const edgePoint = () => {
      const edge = Math.floor(Math.random() * 4);
      if (edge === 0) return { x: Math.random() * w, y: -4, nx: 0, ny: 1 };
      if (edge === 1) return { x: w + 4, y: Math.random() * h, nx: -1, ny: 0 };
      if (edge === 2) return { x: Math.random() * w, y: h + 4, nx: 0, ny: -1 };
      return { x: -4, y: Math.random() * h, nx: 1, ny: 0 };
    };
    function spawnVine(){
      const start = edgePoint();
      const reach = Math.min(w, h) * (0.28 + Math.random() * 0.22);
      const bow = (Math.random() - 0.5) * reach * 0.7;
      const perpX = -start.ny, perpY = start.nx;
      return {
        x0: start.x, y0: start.y,
        cx: start.x + start.nx * reach * 0.5 + perpX * bow,
        cy: start.y + start.ny * reach * 0.5 + perpY * bow,
        x1: start.x + start.nx * reach, y1: start.y + start.ny * reach,
        leafCount: 3 + Math.floor(Math.random() * 3),
        growSpeed: 0.16 + Math.random() * 0.1,
        holdTime: 2 + Math.random() * 2,
        t: 0, phase: 'grow', hold: 0
      };
    }
    function bez(v, t){
      const mt = 1 - t;
      return {
        x: mt * mt * v.x0 + 2 * mt * t * v.cx + t * t * v.x1,
        y: mt * mt * v.y0 + 2 * mt * t * v.cy + t * t * v.y1
      };
    }
    // Vine count and bezier step resolution both scale with the chosen
    // animation-quality tier (see FX_QUALITY_TIERS above).
    const steps = fxQualityTier === 'high' ? 20 : fxQualityTier === 'saver' ? 8 : 12;
    const vines = Array.from({ length: FX_QUALITY_TIERS[fxQualityTier].vineCount }, () => Object.assign(spawnVine(), { t: Math.random() }));
    return function draw(ctx, _t, dt){
      ctx.clearRect(0, 0, w, h);
      vines.forEach(v => {
        if (v.phase === 'grow') {
          v.t = Math.min(1, v.t + v.growSpeed * dt);
          if (v.t >= 1) v.phase = 'hold';
        } else if (v.phase === 'hold') {
          v.hold += dt;
          if (v.hold >= v.holdTime) v.phase = 'fade';
        } else if (v.phase === 'fade') {
          v.t = Math.max(0, v.t - v.growSpeed * 0.6 * dt);
          if (v.t <= 0) Object.assign(v, spawnVine());
        }

        const alpha = v.phase === 'fade' ? Math.max(0, v.t) : Math.min(1, v.t * 1.4);
        ctx.strokeStyle = `rgba(120,220,110,${0.75 * alpha})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const st = (i / steps) * v.t;
          const p = bez(v, st);
          i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();

        for (let i = 1; i <= v.leafCount; i++) {
          const lt = (i / (v.leafCount + 1)) * v.t;
          if (lt <= 0 || lt > v.t) continue;
          const p = bez(v, lt);
          const p2 = bez(v, Math.min(1, lt + 0.02));
          const ang = Math.atan2(p2.y - p.y, p2.x - p.x) + (i % 2 === 0 ? 1 : -1) * 1.1;
          const leafSize = 5 + (i % 3);
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(ang);
          ctx.fillStyle = `rgba(150,235,120,${0.7 * alpha})`;
          ctx.beginPath();
          ctx.ellipse(leafSize * 0.6, 0, leafSize, leafSize * 0.45, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });
    };
  }

  // ---------- Abyssal Depths (underwater) ----------
  // Unlike the other card effects, this one is meant to actually tint the
  // whole card (banner, avatar, text) rather than just glow behind it — see
  // the .card-fx-canvas.submerged CSS rule toggled in activateCardFx below,
  // which raises this canvas above the avatar/name and switches it to
  // mix-blend-mode:normal plus a light backdrop-filter blur.
  function makeUnderwaterCardFx(w, h){
    function spawnBubble(randomY){
      return {
        x: Math.random() * w,
        y: randomY ? Math.random() * h : h + 10,
        r: Math.random() * 3 + 1.5,
        vy: Math.random() * 0.6 + 0.4,
        wobble: Math.random() * Math.PI * 2,
        wobbleSpeed: Math.random() * 0.05 + 0.02,
        alpha: Math.random() * 0.35 + 0.35
      };
    }
    function spawnFish(){
      const dir = Math.random() < 0.5 ? 1 : -1;
      return {
        x: Math.random() * w,
        yBase: h * (0.2 + Math.random() * 0.65),
        bob: Math.random() * Math.PI * 2,
        bobSpeed: Math.random() * 0.02 + 0.015,
        size: Math.random() * 5 + 6,
        speed: (Math.random() * 0.4 + 0.35) * dir,
        dir,
        tail: Math.random() * Math.PI * 2,
        hue: [178, 190, 40, 200][Math.floor(Math.random() * 4)],
        alpha: Math.random() * 0.25 + 0.55
      };
    }
    const bubbles = Array.from({ length: 16 }, () => spawnBubble(true));
    const fish = Array.from({ length: 5 }, spawnFish);
    const causticBands = Array.from({ length: 3 }, (_, i) => ({
      hue: 190 + i * 10,
      phase: Math.random() * Math.PI * 2,
      speed: 0.18 + i * 0.05,
      yBase: h * (0.2 + i * 0.28),
      amp: h * 0.10
    }));
    const motes = Array.from({ length: 14 }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: Math.random() * 1.2 + 0.4,
      driftX: (Math.random() - 0.5) * 0.15,
      driftY: (Math.random() - 0.5) * 0.1,
      tw: Math.random() * Math.PI * 2
    }));

    function spawnJelly(randomY){
      return {
        x: Math.random() * w,
        y: randomY ? Math.random() * h : h + 20,
        bell: Math.random() * 6 + 8,
        pulsePhase: Math.random() * Math.PI * 2,
        pulseSpeed: Math.random() * 0.03 + 0.025,
        driftPhase: Math.random() * Math.PI * 2,
        driftAmp: Math.random() * 6 + 4,
        vy: Math.random() * 0.12 + 0.08,
        tentacles: 5 + Math.floor(Math.random() * 3),
        hue: [300, 320, 275][Math.floor(Math.random() * 3)],
        alpha: Math.random() * 0.2 + 0.4
      };
    }
    const jellies = Array.from({ length: 3 }, () => spawnJelly(true));

    const octopus = {
      x: w * 0.5, y: h * 0.86,
      dir: 1, speed: 0.16,
      mantle: Math.min(w, h) * 0.075,
      hue: 14, alpha: 0.62
    };

    function drawFish(ctx, f){
      ctx.save();
      ctx.translate(f.x, f.yBase + Math.sin(f.bob) * 6);
      ctx.scale(f.dir, 1);
      ctx.globalAlpha = f.alpha;
      const tailSwing = Math.sin(f.tail) * 0.5;
      ctx.fillStyle = `hsla(${f.hue},55%,55%,0.9)`;
      ctx.beginPath();
      ctx.moveTo(-f.size * 0.9, 0);
      ctx.lineTo(-f.size * 1.6, -f.size * 0.55 + tailSwing * f.size * 0.4);
      ctx.lineTo(-f.size * 1.6, f.size * 0.55 + tailSwing * f.size * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, 0, f.size, f.size * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(10,20,20,0.8)';
      ctx.beginPath();
      ctx.arc(f.size * 0.55, -f.size * 0.08, f.size * 0.11, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function drawJelly(ctx, j, t){
      const pulse = Math.sin(j.pulsePhase + t * j.pulseSpeed * 10);
      const bellW = j.bell * (1 + pulse * 0.16);
      const bellH = j.bell * 0.72 * (1 - pulse * 0.12);
      const x = j.x + Math.sin(j.driftPhase + t * 0.15) * j.driftAmp;

      ctx.save();
      ctx.translate(x, j.y);
      ctx.globalAlpha = j.alpha;

      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, bellW * 2.6);
      glow.addColorStop(0, `hsla(${j.hue},70%,78%,0.3)`);
      glow.addColorStop(1, `hsla(${j.hue},70%,78%,0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, bellW * 2.6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `hsla(${j.hue},55%,82%,0.55)`;
      ctx.beginPath();
      ctx.arc(0, 0, bellW, Math.PI, Math.PI * 2);
      const fringeSegs = 8;
      for (let s = 0; s <= fringeSegs; s++) {
        const fx = bellW - (2 * bellW * s / fringeSegs);
        const wob = Math.sin(t * 2 + s + j.pulsePhase) * bellH * 0.1;
        ctx.lineTo(fx, bellH * 0.15 + wob);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = `hsla(${j.hue},40%,90%,0.25)`;
      ctx.lineWidth = 0.6;
      for (let k = -1; k <= 1; k++) {
        ctx.beginPath();
        ctx.moveTo(0, -bellH * 0.1);
        ctx.lineTo(k * bellW * 0.55, bellH * 0.1);
        ctx.stroke();
      }

      ctx.strokeStyle = `hsla(${j.hue},45%,85%,0.45)`;
      ctx.lineWidth = 1;
      for (let k = 0; k < j.tentacles; k++) {
        const tx = -bellW * 0.6 + (1.2 * bellW * k / Math.max(j.tentacles - 1, 1));
        const len = bellW * 1.9;
        let px = tx, py = bellH * 0.2;
        ctx.beginPath();
        ctx.moveTo(px, py);
        const segs2 = 5;
        for (let s = 1; s <= segs2; s++) {
          const progress = s / segs2;
          const wave = Math.sin(t * 1.6 + k * 1.3 + progress * 4) * 4 * progress;
          const nx = tx + wave;
          const ny = bellH * 0.2 + len * progress;
          ctx.quadraticCurveTo(px, py, (px + nx) / 2, (py + ny) / 2);
          px = nx; py = ny;
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawOctopus(ctx, o, t){
      ctx.save();
      ctx.translate(o.x, o.y);
      ctx.scale(o.dir, 1);
      ctx.globalAlpha = o.alpha;

      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath();
      ctx.ellipse(0, o.mantle * 1.15, o.mantle * 1.3, o.mantle * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `hsla(${o.hue},45%,32%,0.75)`;
      ctx.lineCap = 'round';
      for (let l = 0; l < 8; l++) {
        const baseAngle = (Math.PI / 2) + (l - 3.5) * 0.16;
        const legLen = o.mantle * 1.9;
        ctx.lineWidth = 2.4 - (l % 4) * 0.2;
        let px = 0, py = o.mantle * 0.35;
        ctx.beginPath();
        ctx.moveTo(px, py);
        const segs = 4;
        for (let s = 1; s <= segs; s++) {
          const prog = s / segs;
          const wig = Math.sin(t * 2.6 + l * 0.8 + prog * 3) * 4 * prog;
          const nx = Math.cos(baseAngle) * legLen * prog + wig;
          const ny = o.mantle * 0.35 + Math.sin(baseAngle) * legLen * prog * 0.55;
          ctx.quadraticCurveTo(px, py, (px + nx) / 2, (py + ny) / 2);
          px = nx; py = ny;
        }
        ctx.stroke();
      }

      const grad = ctx.createRadialGradient(-o.mantle * 0.3, -o.mantle * 0.35, 1, 0, 0, o.mantle * 1.3);
      grad.addColorStop(0, `hsla(${o.hue},50%,48%,0.92)`);
      grad.addColorStop(1, `hsla(${o.hue},45%,26%,0.88)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(0, 0, o.mantle, o.mantle * 0.82, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(8,6,6,0.85)';
      ctx.beginPath();
      ctx.arc(o.mantle * 0.38, -o.mantle * 0.08, o.mantle * 0.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.arc(o.mantle * 0.42, -o.mantle * 0.13, o.mantle * 0.05, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    return function draw(ctx, t){
      ctx.clearRect(0, 0, w, h);

      const wash = ctx.createLinearGradient(0, 0, 0, h);
      wash.addColorStop(0, 'rgba(8,42,52,0.30)');
      wash.addColorStop(1, 'rgba(4,24,32,0.42)');
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, w, h);

      causticBands.forEach(b => {
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, `hsla(${b.hue},80%,65%,0)`);
        grad.addColorStop(0.5, `hsla(${b.hue},80%,65%,.16)`);
        grad.addColorStop(1, `hsla(${b.hue},80%,65%,0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let x = 0; x <= w; x += 14) {
          const y = b.yBase + Math.sin(x * 0.02 + t * b.speed + b.phase) * b.amp;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fill();
      });

      jellies.forEach(j => {
        j.y -= j.vy;
        if (j.y < -j.bell * 4) Object.assign(j, spawnJelly(false));
        drawJelly(ctx, j, t);
      });

      octopus.x += octopus.speed * octopus.dir;
      if (octopus.x > w - octopus.mantle * 1.4) octopus.dir = -1;
      if (octopus.x < octopus.mantle * 1.4) octopus.dir = 1;
      drawOctopus(ctx, octopus, t);

      fish.forEach(f => {
        f.x += f.speed;
        f.bob += f.bobSpeed;
        f.tail += 0.25;
        if (f.dir > 0 && f.x > w + f.size * 2) f.x = -f.size * 2;
        if (f.dir < 0 && f.x < -f.size * 2) f.x = w + f.size * 2;
        drawFish(ctx, f);
      });

      motes.forEach(m => {
        m.x += m.driftX; m.y += m.driftY; m.tw += 0.02;
        if (m.x < 0) m.x = w; if (m.x > w) m.x = 0;
        if (m.y < 0) m.y = h; if (m.y > h) m.y = 0;
        const alpha = 0.2 + Math.sin(m.tw) * 0.15;
        ctx.beginPath();
        ctx.fillStyle = `rgba(180,230,230,${Math.max(alpha,0)})`;
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
      });

      bubbles.forEach(b => {
        b.wobble += b.wobbleSpeed;
        b.y -= b.vy;
        b.x += Math.sin(b.wobble) * 0.4;
        if (b.y < -10) Object.assign(b, spawnBubble(false));
        ctx.beginPath();
        ctx.strokeStyle = `rgba(200,240,240,${b.alpha})`;
        ctx.lineWidth = 1;
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.fillStyle = `rgba(255,255,255,${b.alpha * 0.6})`;
        ctx.arc(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.25, 0, Math.PI * 2);
        ctx.fill();
      });
    };
  }

  // ---------- Thunder Strike ----------
  // A jagged branching bolt periodically arcs down from the top of the card
  // and strikes the avatar's position, with a bright flash, an impact glow,
  // lingering electric sparks, and a brief shake on the card itself
  // (.thunder-shake, applied to hostEl — the nearest card container).
  function makeThunderCardFx(w, h, hostEl){
    const avatarX = w * 0.14;
    const avatarY = h * 0.51;

    let lastT = null;
    let nextStrike = 0.6 + Math.random() * 1.2;
    let flash = 0;
    let boltPath = null;
    let boltLife = 0;
    const sparks = [];

    function buildBolt(){
      const startX = avatarX + (Math.random() - 0.5) * 40;
      const segs = 9;
      const main = [];
      for (let i = 0; i <= segs; i++) {
        const prog = i / segs;
        const targetX = startX + (avatarX - startX) * prog;
        const targetY = -6 + (avatarY - -6) * prog;
        main.push([
          targetX + (Math.random() - 0.5) * 18 * (1 - prog * 0.6),
          targetY
        ]);
      }
      const branches = [];
      for (let b = 0; b < 3; b++) {
        const idx = 2 + Math.floor(Math.random() * (main.length - 4));
        let [bx, by] = main[idx];
        const branchPts = [[bx, by]];
        for (let s = 1; s <= 3; s++) {
          bx += (Math.random() - 0.5) * 22;
          by += Math.random() * 10 + 6;
          branchPts.push([bx, by]);
        }
        branches.push(branchPts);
      }
      return { main, branches };
    }

    function strokeBolt(ctx, pts, alpha, lineW){
      ctx.beginPath();
      pts.forEach(([px, py], i) => i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py));
      ctx.strokeStyle = `rgba(220,235,255,${alpha})`;
      ctx.lineWidth = lineW;
      ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(160,200,255,0.9)';
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    return function draw(ctx, t){
      if (lastT === null) lastT = t;
      const dt = Math.min(Math.max(t - lastT, 0), 0.05);
      lastT = t;

      ctx.clearRect(0, 0, w, h);

      nextStrike -= dt;
      if (nextStrike <= 0) {
        boltPath = buildBolt();
        boltLife = 1;
        flash = 1;
        nextStrike = 2.5 + Math.random() * 3.5;
        for (let i = 0; i < 10; i++) {
          const ang = Math.random() * Math.PI * 2;
          sparks.push({
            x: avatarX, y: avatarY, life: 1,
            vx: Math.cos(ang) * (Math.random() * 1.2 + 0.4),
            vy: Math.sin(ang) * (Math.random() * 1.2 + 0.4)
          });
        }
        if (hostEl) {
          hostEl.classList.remove('thunder-shake');
          void hostEl.offsetWidth;
          hostEl.classList.add('thunder-shake');
        }
      }

      if (flash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${flash * 0.5})`;
        ctx.fillRect(0, 0, w, h);
        flash = Math.max(flash - dt * 2.2, 0);
      }

      if (boltPath && boltLife > 0) {
        const alpha = Math.min(boltLife * 2, 1);
        strokeBolt(ctx, boltPath.main, alpha, 2.4);
        boltPath.branches.forEach(b => strokeBolt(ctx, b, alpha * 0.7, 1.2));
        boltLife -= dt * 3.2;
        if (boltLife <= 0) boltPath = null;
      }

      if (flash > 0.05 || boltPath) {
        const glow = ctx.createRadialGradient(avatarX, avatarY, 0, avatarX, avatarY, 36);
        glow.addColorStop(0, `rgba(200,225,255,${Math.max(flash, 0.3) * 0.8})`);
        glow.addColorStop(1, 'rgba(200,225,255,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(avatarX, avatarY, 36, 0, Math.PI * 2);
        ctx.fill();
      }

      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.x += s.vx; s.y += s.vy; s.life -= dt * 1.8;
        if (s.life <= 0) { sparks.splice(i, 1); continue; }
        ctx.beginPath();
        ctx.strokeStyle = `rgba(190,220,255,${s.life})`;
        ctx.lineWidth = 1;
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - s.vx * 3, s.y - s.vy * 3);
        ctx.stroke();
      }
    };
  }

  function makeCardFxDraw(type, w, h, canvas){
    if (type === 'meteor') return makeMeteorCardFx(w, h);
    if (type === 'plants') return makePlantsCardFx(w, h);
    if (type === 'underwater') return makeUnderwaterCardFx(w, h);
    if (type === 'thunder') {
      const hostEl = canvas
        ? (canvas.closest('.account-hero') || canvas.closest('.user-profile-card') || canvas.closest('.profile-store-card') || canvas.parentElement)
        : null;
      return makeThunderCardFx(w, h, hostEl);
    }
    return null;
  }

  // Finds any not-yet-activated canvas.card-fx-canvas elements under root
  // and registers each with the shared loop above. Canvas backing size is
  // synced to its rendered box at activation time so it stays crisp across
  // both the small store-grid previews and the full-width equipped card.
  function activateCardFx(root){
    if (!root) return;
    if (prefersReducedMotionCardFx) return;
    root.querySelectorAll('canvas.card-fx-canvas').forEach(canvas => {
      if (canvas._cardFx || !canvas.dataset.fxType) return;
      const w = Math.max(1, Math.round(canvas.clientWidth || canvas.width || 1));
      const h = Math.max(1, Math.round(canvas.clientHeight || canvas.height || 1));
      canvas.width = w; canvas.height = h;
      // Abyssal Depths needs to sit ABOVE the avatar/text and blend
      // normally instead of screen, so its teal wash actually tints
      // everything beneath it — see the .submerged CSS rule.
      canvas.classList.toggle('submerged', canvas.dataset.fxType === 'underwater');
      const ctx = canvas.getContext('2d');
      const draw = makeCardFxDraw(canvas.dataset.fxType, w, h, canvas);
      if (!draw) return;
      const entry = { ctx, draw, visible: true };
      cardFxRegistry.add(entry);
      ensureCardFxLoopRunning();
      canvas._cardFx = {
        entry, // exposed so canvasFxVisibilityObserver can toggle entry.visible
        stop(){
          cardFxRegistry.delete(entry);
          ctx.clearRect(0, 0, w, h);
          stopCardFxLoopIfIdle();
        }
      };
      watchCanvasFxVisibility(canvas);
    });
  }
  function deactivateCardFx(root){
    if (!root) return;
    root.querySelectorAll('canvas.card-fx-canvas').forEach(canvas => {
      if (canvas._cardFx) { canvas._cardFx.stop(); canvas._cardFx = null; }
      canvas.classList.remove('submerged');
      unwatchCanvasFxVisibility(canvas);
    });
  }

  // Profile cosmetics are deliberately a closed, built-in catalogue. The
  // item IDs are also mirrored in firestore_rules so a browser cannot redeem
  // arbitrary values or bypass the point prices.
  // Premium items are paid in real money via Paystack rather than Clash
  // Points. `cash.usd` is the real, canonical price (a genuine current-rate
  // conversion of the naira price Nidi quoted — not an inflated relabel).
  // At checkout, the backend converts cash.usd to naira using the live
  // exchange rate at that moment and charges that NGN amount — the naira
  // figure is NOT fixed here because FX moves over time. `cash.ngnRef` is
  // only kept as a reference for what the item was priced at when set.
  const PROFILE_DECORATIONS = [
    { id:'hellflame', name:'Hellflame', category:'Anime', rarity:'Legendary', cost:100, fx:true, season:'anime' },
    { id:'web-trap', name:'Web Trap', category:'Gothic', rarity:'Epic', cost:90, fx:true, premium:true, cash:{ usd:0.43, ngnRef:600 } },
    { id:'voltage', name:'Voltage', category:'Mecha', rarity:'Epic', cost:90, fx:true, premium:true, cash:{ usd:0.51, ngnRef:700 } },
    { id:'frostbite', name:'Frostbite', category:'Elemental', rarity:'Epic', cost:90, fx:true },
    { id:'bloodfang', name:'Bloodfang', category:'Gothic', rarity:'Legendary', cost:100, fx:true },
    { id:'solar-orbit', name:'Solar Orbit', category:'Cosmic', rarity:'Legendary', cost:100, fx:true, premium:true, cash:{ usd:0.65, ngnRef:900 } },
    { id:'web-slinger', name:'Web-Slinger', category:'Heroes', rarity:'Epic', cost:90, fx:true },
    { id:'kryptonian-flight', name:'Kryptonian Flight', category:'Heroes', rarity:'Legendary', cost:100, fx:true, premium:true, cash:{ usd:0.36, ngnRef:500 } },
    { id:'dark-knight', name:'Dark Knight', category:'Heroes', rarity:'Legendary', cost:100, fx:true, premium:true, cash:{ usd:0.36, ngnRef:500 } },
    { id:'thunderstrike', name:'Thunderstrike', category:'Elemental', rarity:'Epic', cost:90, fx:true, premium:true, cash:{ usd:0.36, ngnRef:500 } },
    // Canvas-particle effects (fx:'canvas') — rendered by AvatarEffect rather
    // than static/animated SVG. canvasType is the literal AvatarEffect type
    // string; fxParticles mirrors the maxParticles override each effect used
    // in the source preview (avatar-effects-canvas-preview.html).
    { id:'real-flame', name:'Real Flame', category:'Elemental', rarity:'Legendary', cost:100, fx:'canvas', canvasType:'flame', fxParticles:60, premium:true, cash:{ usd:0.87, ngnRef:1200 } },
    { id:'air-elemental', name:'Air Elemental', category:'Elemental', rarity:'Rare', cost:80, fx:'canvas', canvasType:'air', season:'anime' },
    { id:'overdrive-aura', name:'Overdrive Aura', category:'Mystic', rarity:'Epic', cost:90, fx:'canvas', canvasType:'energy', premium:true, cash:{ usd:0.65, ngnRef:900 } },
    { id:'toxic-bloom', name:'Toxic Bloom', category:'Mystic', rarity:'Rare', cost:85, fx:'canvas', canvasType:'toxic', season:'anime' },
    { id:'spirit-portal', name:'Spirit Portal', category:'Mystic', rarity:'Epic', cost:90, fx:'canvas', canvasType:'portal', season:'anime' },
    { id:'skeletal-reaper', name:'Skeletal Reaper', category:'Dark', rarity:'Legendary', cost:100, fx:'canvas', canvasType:'reaper', fxParticles:6, premium:true, cash:{ usd:0.72, ngnRef:1000 } },
    { id:'dragon-balls', name:'Dragon Balls', category:'Legendary', rarity:'Legendary', cost:100, fx:'canvas', canvasType:'dragonballs', fxParticles:7, season:'anime' },
    { id:'star-struck', name:'Star Struck', category:'Discord Picks', rarity:'Epic', cost:90, fx:'canvas', canvasType:'star_struck', fxParticles:14, season:'anime' },
    // Horror Season exclusives — same pattern as the anime set above:
    // reuse existing canvasType particle effects, just tagged season:'horror'
    // so they only show up in the store while Horror Season is live.
    // Moved out of Horror Season — these reuse the same canvas types as the
    // Anime season items (toxic/portal/reaper/flame), so they read as
    // "anime effects" sitting in the horror shelf. Kept as evergreen
    // (Clash Points) decorations instead of deleting them outright.
    { id:'phantom-mist', name:'Phantom Mist', category:'Dark', rarity:'Rare', cost:80, fx:'canvas', canvasType:'toxic', retired:true },
    { id:'wraith-veil', name:'Wraith Veil', category:'Dark', rarity:'Epic', cost:90, fx:'canvas', canvasType:'portal', retired:true },
    { id:'grim-reaper', name:'Grim Reaper', category:'Dark', rarity:'Legendary', cost:100, fx:'canvas', canvasType:'reaper', fxParticles:6, retired:true },
    { id:'cursed-flame', name:'Cursed Flame', category:'Dark', rarity:'Legendary', cost:100, fx:'canvas', canvasType:'flame', retired:true },
    // Final Six — bespoke non-particle canvas renderers (see AvatarEffect
    // custom-type branch below), redeemed with Skulls. These are now the
    // only items tagged season:'horror', so the Horror Season shelf shows
    // just these six.
    { id:'raven-curse', name:"Raven's Curse", category:'Dark', rarity:'Epic', cost:90, fx:'canvas', canvasType:'raven-curse', season:'horror' },
    { id:'lord-of-dead', name:'Lord of the Dead', category:'Dark', rarity:'Legendary', cost:100, fx:'canvas', canvasType:'lord-of-dead', season:'horror' },
    { id:'watcher-ring', name:"Watcher's Ring", category:'Dark', rarity:'Epic', cost:90, fx:'canvas', canvasType:'watcher-ring', season:'horror' },
    { id:'black-widow', name:'Black Widow', category:'Dark', rarity:'Epic', cost:90, fx:'canvas', canvasType:'black-widow', season:'horror' },
    { id:'styx-spirits', name:'Styx Spirits', category:'Dark', rarity:'Legendary', cost:100, fx:'canvas', canvasType:'styx-spirits', season:'horror' },
    { id:'creeping-roots', name:'Creeping Roots', category:'Dark', rarity:'Legendary', cost:100, fx:'canvas', canvasType:'creeping-roots', season:'horror' }
  ];
  // Profile CARD effects — full-card particle overlays that sit over the
  // banner + body (see card-fx-canvas / activateCardFx below), as opposed
  // to PROFILE_DECORATIONS which ring the avatar. Two unlock types so far:
  //   - requiresXp: free, but gated behind a live XP threshold (mirrors the
  //     verified-badge mechanic — nothing is spent, it just stops being
  //     locked once currentUserXp crosses the line)
  //   - premium + cash: real money via Paystack, same flow/contract as
  //     premium decorations (itemType 'cardEffect' instead of 'decoration')
  const PROFILE_CARD_EFFECTS = [
    { id:'meteor-fall', name:'Meteor Fall', category:'Cosmic', rarity:'Epic', canvasType:'meteor', requiresXp:200 },
    { id:'overgrowth', name:'Overgrowth', category:'Nature', rarity:'Epic', canvasType:'plants', premium:true, cash:{ usd:0.70, ngnRef:970 } },
    // Free, but gated behind a 2000 XP threshold — nothing is spent, same
    // mechanic as Meteor Fall above (see isValidEquipmentChange() in
    // firestore.rules for the matching server-side check).
    { id:'thunder-strike', name:'Thunder Strike', category:'Elemental', rarity:'Legendary', canvasType:'thunder', requiresXp:2000 },
    // Real money via Paystack — tints the whole card (banner, avatar, text)
    // rather than just glowing behind it, see .card-fx-canvas.submerged.
    { id:'abyssal-depths', name:'Abyssal Depths', category:'Nature', rarity:'Epic', canvasType:'underwater', premium:true, cash:{ usd:0.70, ngnRef:970 } }
  ];
  const cardEffectById = id => PROFILE_CARD_EFFECTS.find(item => item.id === id);
  const PROFILE_FONTS = [
    { id:'bangers', name:'Bangers', category:'Comic', cls:'profile-font-bangers' },
    { id:'luckiest', name:'Luckiest Guy', category:'Comic', cls:'profile-font-luckiest' },
    { id:'marker', name:'Permanent Marker', category:'Artistic', cls:'profile-font-marker' },
    { id:'creepster', name:'Creepster', category:'Comic', cls:'profile-font-creepster' },
    { id:'russo', name:'Russo One', category:'Anime', cls:'profile-font-russo', season:'anime', cost:60 },
    { id:'cinzel', name:'Cinzel Decorative', category:'Artistic', cls:'profile-font-cinzel' },
    { id:'bungee', name:'Bungee', category:'Comic', cls:'profile-font-bungee' },
    { id:'orbitron', name:'Orbitron Edge', category:'Anime', cls:'profile-font-orbitron', season:'anime', cost:60 },
    // Horror Season exclusives — same season-gating pattern as the Final Six
    // decorations above (see PROFILE_DECORATIONS): only shown/purchasable
    // while season:'horror' is the live season, priced in Skulls instead
    // of Clash Points (see the season-aware branch in renderCustomizationStore).
    { id:'nosifer', name:'Nosifer', category:'Horror', cls:'profile-font-nosifer', season:'horror', cost:60 },
    { id:'eater', name:'Eater', category:'Horror', cls:'profile-font-eater', season:'horror', cost:60 },
    { id:'butcherman', name:'Butcherman', category:'Horror', cls:'profile-font-butcherman', season:'horror', cost:60 },
    { id:'metal-mania', name:'Metal Mania', category:'Horror', cls:'profile-font-metalmania', season:'horror', cost:60 },
    // Crossverse Season exclusives — same season-gating pattern as the
    // Horror fonts above: bold, condensed movie-poster faces, priced in
    // Reels, only shown while season:'crossverse' is live.
    { id:'bebas', name:'Bebas Neue', category:'Crossverse', cls:'profile-font-bebas', season:'crossverse', cost:60 },
    { id:'anton', name:'Anton', category:'Crossverse', cls:'profile-font-anton', season:'crossverse', cost:60 },
    { id:'oswald', name:'Oswald', category:'Crossverse', cls:'profile-font-oswald', season:'crossverse', cost:60 },
    { id:'staatliches', name:'Staatliches', category:'Crossverse', cls:'profile-font-staatliches', season:'crossverse', cost:60 }
  ];
  const decorationById = id => PROFILE_DECORATIONS.find(item => item.id === id);
  const fontById = id => PROFILE_FONTS.find(item => item.id === id);

  // Fiction Clash's own sticker set — used both attached to a comment (like
  // a Discord sticker message) and as a reaction on someone else's comment.
  // Free, unlocked purely by XP milestone (every 100 XP), same "gated, not
  // spent" mechanic as PROFILE_CARD_EFFECTS' requiresXp items above — so
  // using a sticker never costs XP or touches leaderboard rank.
  // Artwork is embedded as base64 PNGs (cut from the sticker sheet) rather
  // than the old text-in-circle SVG badges.
  const STICKER_IMAGES = {
    pow: 'data:image/png;base64,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',
    ko: 'data:image/png;base64,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',
    pyramid_alert: 'data:image/png;base64,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',
    skill_issue: 'data:image/png;base64,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',
    votes_in: 'data:image/png;base64,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',
    cracked_shield: 'data:image/png;base64,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',
    swords_shield: 'data:image/png;base64,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',
    flame: 'data:image/png;base64,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',
    torn_poster: 'data:image/png;base64,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',
    underrated: 'data:image/png;base64,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',
    vs: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFkAAADICAMAAAC07717AAAA/1BMVEUiU2Mnj9/l5eTp6elIr94pMzY3jaMucZVc1uIVc9lIoKxlZ2eLi4sUM0nd3d074/h/f3+tra3q6upHe6DAvsA/QD9/f/++vsDAwL8AAP9APkB//3+qqv+/wcDAvr8AAAD9/f0BAgP+/v7Y2Njm5+bIyMe2trZM5/sRFhczt/E1x/VL2PYvp+4pmOw21/epqagnKCjp6Ojy8/NHR0dW9f7a2tpp+v14eHjn5+cNJzLl5eXl5eUIGSdXV1eXl5dIyfIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkdLM6AAAAQHRSTlP+/9ck//z///////v5/qn/AgNS//T/Av/+AfMCA/3/AP3+A/b0+fn//f////////f8UCr5/8//+m/+jq7++Pn/WOdZzQAAD59JREFUeNqtWwd36kjSVQRMcngzu/uFXVlqBYTIyCaj//+vtqqzhLAB0XPOjN8b+7p8K92qbhte8xN49sdh+7Hfl/7WeAqw9YnH2m+DIHgechCshp/8hEvvmcjePhTIn1+2hDaaA6+IBP4M98GzkAFoyEz+oshfgTC6MbK3ZSbHa4pMVk9Chlj4YjyMzvhv8jSbwWTGRd+n/yXDJ3nwzeMmhz4jIzo8Czng7uv5jAyyfw4yZB9zX+T79INIObARMrqPmbzw3SoZzZCF+86+v6FkRPunIAMX3H0j34+qZDRCFu47+f6C0X2wn4EsuYh9ScYW4rAxsnKf60sy7OD9Ccia+zgZsbV6gs0q+0Y6GUHjbhUEKvvgxIyMj+AJyKLeQ/YdBRlfq+Y26+7b7fyeSMDmvTvwlsJ9rnEUZCy1yHgQWc8+w6gn41HkvXCf+2fAyLCQjKbI0n3E940/viIjaMiziri1f3QEGX+RMhkPIXtLZvLc99sOJyMkh8qnGQ8Aq3o/MNv1afIgMo+4DZg8NfwRyxglBx5FBoH4Jdw3mJoD/8TSRJehDyJ70n1uewpkzBkZ24rJdyPLJIF6b0yRjPCiTz2ErBeMo6mRcQiaIouIO6P7kIwzj4wq8J3IkH2yYAymSAaTc9HXqjHyVtZ7MNk8Mjln6TrjIeRAtCio98ZEkUEuI+M+ZCwYlnIfJYNciYw7kTX3ocnOzh/wyLCDJshvmkA8mpPpBMjoXyXjHmQ5kmDBSKfTiU7GWwNkGXFYMJyJOYECyoW+FTRBDnSB2BpPzbQlyMBq5DVAFvoeC0aRmlPnx8i4HVmZDO5zsulLqsg4BE1slu7rg/uy9GU61sioM/lW5ECNZ/6gAJMnRftnMm5EDjSF4XeT9IWS4crIaIAsFAa6L8vMl2lhjn4m4zZk5T7XHznU5KxdN/Xcjfwm3IcFIwGTzawwJBn248hvQmFAvT92ksnLyyRxRrVC/17kQNX7Vj57eXkpkl/JuAVZn67dBE02s8yQI2BAz3vwQLd6UwLR7+bZCyXDZ3IOC+i7tOBOZKkwQCAa32jyy/i7JeXcyvNs295u7bvVl14wRp3vwoTISDpSzg0De3uwhp9D68O+02YpEPvU5CkgT/LOiJMRHfaW2KhZ9l3I8DMORb3fdfKxCYeSweXcp3aGdynzf4iCge6jJpvT5FvIufIh98yw+kRpdL6h4E/NyTeQcboExjXgPchawfjOpniK7y4nQxp77rOJwvZu3RVoEyW47zulyJQMBRv1XTHSk+WtyBhxfIMI7gOTQb5M0zzbCTLCeW+BE/2IrwH1mDZ+aVGWUBhdMHmCZyzIIOc1biDw9Hhw3+rB0kQJJlPgCYuMqOdSzKPRdnlxItH+Rg8CFx9SYUDEcZPzzs4fUQ5gmm91ModL3c+Y2DfarE+U4L5iksKZZEgGUmu0u1mezxKDl5AvbIg3ZUoQ2F9awUhSdpAMf2d0O995nmTjrNiJXQHZ3zjRlwtGPmbAxXfHaAHsd57M0omZJi2uzq04vHEL8T/iyiHEiMvR5DH8k3zTkydjGtxFNuAh91fF5KvI8EmHT+W+fMwPg83G6E4QukmXZ0kYW6vgRuSVGkk6+SsHzigsZQahx5mSjfvfKz9rbMJkVuOEybPZjH3AsLFrsXSMw+Uvc7eUlXrE5TOElKhZxqAnYww5niWHG7pVYNv7/Z5fOUCNA/fN5MmyrHBaJoNOOkemZ8Dkj587LFi83A+tUHagMzNZAzWM3ehoovXpOBe9hdQopQqy96FQVcQhbGFSUJp/RkZZSTquaLRk+eN0DP1/OCx1iR6NOAQ2jryujUbQAzKkfJZ3uTgP46/gl7l7X+5uKIogr19nCasVi1M/jkZgMmWHagP6BRbZBz9ppPKtGYn7pxE1+fX1FWNgMyc811vMo2gy23vFoGfef+AZCgXjmMx7pwX/4UFiwBH6gjHPTH7NtZBb7m2VCsz+MjIJWW3z+Q+/YMgYA5EMFmEyfLu1+hn31QmrhPzBkF0EpT98zzfyV4B2edjSLUHnFQxmJsd6HG0xFZYf7569DK4iuzI2jDx5RULPnzIlkxkwT01eVITMx8GyPi3LCvegeuuQ1/JLNv4AyVCSaI1zyiuevCW/ndB1KrAsa1mxOfxilgqgDbgryZX/sNUyYJol/LPCv6ILvTQMKlFHuAbg4deHFEzytvQfZk6eIDbPkhDiyF2wfClTY5cyhSvlsxYJUI9AuBgy5IwORmGSYzfs99csjGrkY7gt5+CQcDfF0mGOLDv0h2nlSZ53Ok5LiBg8Sj5a8cb9J1OPdciRhIoxCQ3p0AVqsE63ZexExK/78Vl4MpxvXPh+LMZJBdmKLOansywcXYd3OhZyXYE6WvN079F6F2+4FGPMhNGhjHwgnM6NjIWuIf3p+jI5+1GoCu26f1pIZs6irBpebXoLrQk1xxV/iJjiOp1LI8RcQO6Mdk/cjeHMXIsswbD+SNLh60ZlVN6BqW7sOgXIJR5UMaR6FZnwpbX0mTCDXqqdL+OWSbEMtEJhCI9EONnqyO+QKl9MvCw+FbV9kTWVOiH+FkQDapAx5A7rXWEcQlcs2+wxjbjR6oT8cCFjRD8Lf9AZo/QYFwPBW4wjcwkZtw2ibxCJ3FOekuUhjM6niAd8OzVBLqW4V2KhHMX06UnJ5uCDWBxFFYpIfg9e5yMWukSIPqrYxyDQeSjHrJEbdauXnkzvjfBlJEOVt5wFYckxcJCLFLlg/z/mcsmo2dUShXIW/sNL0VDE+A7Th592QWW15ILEIduSGjXLvp4eECrk/lfWkhFDPu4Mo5WiDEMuGD2Ui7dyHwx0k0WqzE+yyslawpJ8126ZRZbNKLAK5VhKR6OWZYncjz7Lt+WUImT62C6SGRe8GRRal3MhBZ5x8eIFO5Lr/13Nh1Ka9EcU22HAY0elNVm+Vd/JyHm1R+tbOd1cOaeKgN6MKCOUZcXFvzUZbdSYPOhU9hf4JqGagAx70ALglviBSFzz5kTOaD3WRnxSqmeIcqp0aIIO2aUpchGLkfDiRVmJ5QQbswZDoLFSMVrFjqB9US56HFhf6xo1JudJqySs6KaAhXAFe+0byMWxlNYl5LLJr7OS/sHbr+w1yVoDik1KI4FR7FSJ219O9GWTX1PzqDmMyk9QcoBNk6RHNM922yL2oyi0L7YQJZM7MPiaOy3IqPx8RUna6VKzpSTa+Mc/qsSF28u5W5oMQQAsp5OU31XC5/fXSBB0DRir3CPuNHy5RXL9nSr31csrQ18XRczkCSK7UCVFs3eylhir4BN0/eircl+d24yyybisxUquqqR/dNt8ABqdNjTzNTEtOkA4D7eXM2zV5Cm77EIo0BAtlIjwxzWKl5j9NVEFkHMek4uLPEMz+URNnkzNidk+ukYLQEHGZclrJqaANVVyoVZNRIkLa2ZYfacKrjLN6SQdjwHw+zvrwNzaSuTeBdykVw5fltZLLhiyZnKSpeMMZAlEGMYC9rmMLqHIpSCYyzKFXLxdIJdYhh4Bc3vW6balkG1ls85RH8/0pB8JLpY197AVkwun1VZCFmpZMUtadbLrM1yIUJ7XDcfAhrqp3IGpg6NABU+hTklm2eCCjDDqr6UIj+qv8QyPr9NPKoIXay6P2VhplmZV+NmptJfug9a3rL15VIHBRfc50goOjJXjtiQjjM9yINfct6+/eeT7ojUV3XNSrr5HB8oTRAYd86WpoDOwWisu6m/x2EqDiKlDO/+iJmNFdec9ESrHAaRl0YFwGXHlUs8FIFs1kapNwmO8LxfzAqCi7hwnuKY7Cy7soB55e4kchiq+J1NDmoqouFjMMA6vlTiFzCdiiUricz8U19pQnswBRXWKLMGbCThjvMITXIRXuKBRRyIZpfH8PI/nkagiYLJptk0zBVg4E0Q2UxrgQsVd4wKRbQuwCAHU+TyCD6xI3sRnqWlOEDbPsatQYHOMF6VaiXu/slk18BkJosaAah0OyxUXpNCwi7EJ3kpy6FRtmLdTvFky08wZKRW3v8YFq0ir/YGQ0NqvVvAXtryNaGVj6Ne0/9HCjTdL8K005XLtQlpTBbZtr3B5FbzzlR0oCVeveUYnLxB4Os50FWdfB2bd6h9qO7yy5Ab+j6ykdPkwoVwUqO5v4ELTSMGb/thPTugjox9jYcozanKhq3srCH5Fri7Kzwx1scGeF9Iulr4AsqMU7dfPXFwgL9lACJnw9yaWyyQgIzPxZrdwBkJLzpGLu5CpbzZxqA/AO9AKAGxqijb662D/CFzZFXiHy/1YxFo6muwgF0LRXs+R2m38PrpYY9F3FWjylKp7oWgPwXtwOzKyEVcLH0R2QS/mJ46hlbiV9zNwFdk+RIJiwjyIz90yfEswwcc8I1Kj7m9hAyVCBCWEYHma82J6dLIU3Ydx0b+Vi5q7CftA/oNVj7C77JA/MgH3te/houamBgixiBVaByI2mS00eeqoob1Oxd3wygK+xF4tl/ZW9PSdk4H/HI2L8q3ozcg8sWwrlJ2lMMFkVe4B2HsIGVcodrBiZGBmg8mm4uIzsla/5MhPt3hQ84jIbBNMdjCU+/K65xbgK8hv/NKfvh5DkxUXV7TWjciymuKTmzG6Tyv3H95NwNeQZc8apJM2ffAmlzl2A2T5gGVO93wvyMVNre93ZPFM6ETf3k5NfYFxK/CVqBuKDbfBh0Ne7iPLDhogQx7IzG6DyS1fDe3Lm02uR5ZqfYeCS9vR3hpxV2+lhzKzp/S96emOEvcD8v+JYO77bnsyMbUdbd2D03sqkniJjI/q8bmp4uL/b+eitopyMiL8PQBHX+bcw0UN8pu4jcVgdqBbcy7mZBsEjZCDgI2eGMy0xJ1l67sLuKZbBV/qlyLUvvrqc8XbkQMVzI6+r97eCVxFlv7DYFblnnLhNUReyfeb3T+q9VkrrylywHu26w/kvppy8eY1Qi4Fc1vf3d9r8SUyz+yNP/pzlOX+a3W/yRfqS84pA0Op+7vjokaL8isx7Nmi3P/rnnL/6wTU84+Ki3vK/XVk2bN91foOD5lcmVNUZmutb/WQyZVbPG2ptHig9f0QG0MiF54iLmr2kncjy1+QPOtc2A+aXH3NUr58pVy8e09AlmVOm/oe5KJ8iyczW7Y+KwgeBS4hy8yWMmDrPQxcQpZlbv5g66tHhklQ/MbMqXo92RBZkjGypAx485ojywumSE59h6CJydrN44qtY07ry+vJxshsArREuQ8aAV8ifyou3p6EbJNI2+WHdjMuSshhJJe6wMV7Q2A96pYkZvsYMidW4D0NmUL/E1e6cwDeNgbWa927twxJBIcc7ObA1VedW8uyDsvgCcDefwHIH6ma3xCiuQAAAABJRU5ErkJggg==',
  };
  const APP_STICKERS = [
    { id:'pow', label:'POW!', requiresXp:100, img:STICKER_IMAGES.pow },
    { id:'ko', label:'K.O.', requiresXp:200, img:STICKER_IMAGES.ko },
    { id:'level-up', label:'LEVEL UP', requiresXp:300, img:STICKER_IMAGES.pyramid_alert },
    { id:'skill-issue', label:'SKILL ISSUE', requiresXp:400, img:STICKER_IMAGES.skill_issue },
    { id:'votes-in', label:'VOTES IN', requiresXp:500, img:STICKER_IMAGES.votes_in },
    { id:'shattered', label:'SHATTERED', requiresXp:600, img:STICKER_IMAGES.cracked_shield },
    { id:'clash', label:'CLASH', requiresXp:700, img:STICKER_IMAGES.swords_shield },
    { id:'lit', label:'LIT', requiresXp:800, img:STICKER_IMAGES.flame },
    { id:'hero', label:'HERO', requiresXp:900, img:STICKER_IMAGES.torn_poster },
    { id:'underrated', label:'UNDERRATED', requiresXp:1000, img:STICKER_IMAGES.underrated },
    { id:'vs', label:'VS', requiresXp:1100, img:STICKER_IMAGES.vs },
  ];
  const stickerById = id => APP_STICKERS.find(item => item.id === id);
  const isStickerUnlocked = (id, xp) => {
    const s = stickerById(id);
    return !!s && (xp || 0) >= s.requiresXp;
  };
  // One shared badge template — just the sticker artwork itself, since the
  // PNGs already include their own outline/border, unlike the old
  // text-in-circle SVG badges which needed the circle drawn for them.
  function stickerHtml(id){
    const s = stickerById(id);
    if (!s) return '';
    return `<span class="sticker-badge" title="${escapeHtml(s.label)}"><img class="sticker-img" src="${s.img}" alt="${escapeHtml(s.label)}" draggable="false"></span>`;
  }

  // ---------- sticker picker popover (shared across composers AND reactions) ----------
  // One floating popover, repositioned and repopulated next to whichever
  // button opened it — generalized around a callback rather than always
  // writing to a form, so the same popover serves both "attach to what
  // I'm typing" (composer toggle) and "react to this comment" (react
  // button) without duplicating the picker itself.
  const stickerPickerPopover = document.getElementById('stickerPickerPopover');
  let stickerPickerOnPick = null;
  let stickerPickerOpenerEl = null;

  function closeStickerPicker(){
    stickerPickerPopover.hidden = true;
    stickerPickerOnPick = null;
    stickerPickerOpenerEl = null;
  }

  function openStickerPickerFor(openerEl, onPick){
    const unlocked = APP_STICKERS.filter(s => isStickerUnlocked(s.id, currentUserXp));
    if (!unlocked.length) {
      const next = APP_STICKERS.find(s => !isStickerUnlocked(s.id, currentUserXp));
      showToast(next ? `Unlock stickers at ${next.requiresXp} XP (you're at ${currentUserXp})` : 'No stickers available');
      return;
    }
    stickerPickerOpenerEl = openerEl;
    stickerPickerOnPick = onPick;
    stickerPickerPopover.innerHTML = unlocked.map(s =>
      `<button type="button" class="sticker-picker-item" data-sticker-id="${s.id}">${stickerHtml(s.id)}</button>`
    ).join('');
    const rect = openerEl.getBoundingClientRect();
    stickerPickerPopover.style.left = `${Math.max(8, Math.min(window.innerWidth - 208, rect.left - 80))}px`;
    stickerPickerPopover.style.top = `${Math.max(8, rect.top - 10)}px`;
    stickerPickerPopover.style.transform = 'translateY(-100%)';
    stickerPickerPopover.hidden = false;
  }

  // Records the chosen sticker on the form itself (read by postHeroComment/
  // addComment at send time) and swaps the toggle button's icon to a
  // preview of the attached sticker so it's obvious one's queued up.
  function attachStickerToForm(form, stickerId){
    form._attachedSticker = stickerId;
    const toggle = form.querySelector('.sticker-toggle-btn');
    if (toggle) {
      toggle.classList.add('has-sticker');
      toggle.innerHTML = stickerHtml(stickerId);
    }
  }
  function clearAttachedSticker(form){
    form._attachedSticker = null;
    const toggle = form.querySelector('.sticker-toggle-btn');
    if (toggle) {
      toggle.classList.remove('has-sticker');
      toggle.innerHTML = STICKER_TOGGLE_ICON;
    }
  }

  document.addEventListener('click', event => {
    const toggle = event.target.closest('.sticker-toggle-btn');
    if (toggle) {
      event.preventDefault();
      const form = toggle.closest('form');
      if (!form) return;
      if (!auth.currentUser) { requireSignIn('Sign in to use stickers'); return; }
      if (!stickerPickerPopover.hidden && stickerPickerOpenerEl === toggle) { closeStickerPicker(); return; }
      openStickerPickerFor(toggle, stickerId => attachStickerToForm(form, stickerId));
      return;
    }
    const reactBtn = event.target.closest('.comment-react-btn');
    if (reactBtn) {
      event.preventDefault();
      if (!auth.currentUser) { requireSignIn('Sign in to react'); return; }
      const commentEl = reactBtn.closest('.comment');
      if (!commentEl) return;
      if (!stickerPickerPopover.hidden && stickerPickerOpenerEl === reactBtn) { closeStickerPicker(); return; }
      openStickerPickerFor(reactBtn, stickerId => sendReaction(
        commentEl.dataset.parentType,
        commentEl.dataset.parentId,
        commentEl.dataset.commentId,
        stickerId
      ));
      return;
    }
    // Tapping an existing pill directly toggles that same sticker for you
    // (adds your reaction if you hadn't, removes it if you're the one who
    // tapped it before) — no need to reopen the picker just to react with
    // a sticker someone else already started.
    const pill = event.target.closest('.comment-reaction-pill');
    if (pill) {
      event.preventDefault();
      if (!auth.currentUser) { requireSignIn('Sign in to react'); return; }
      const commentEl = pill.closest('.comment');
      if (!commentEl) return;
      sendReaction(commentEl.dataset.parentType, commentEl.dataset.parentId, commentEl.dataset.commentId, pill.dataset.stickerId);
      return;
    }
    if (event.target.closest('.sticker-picker-popover')) return; // handled below, not a close-tap
    if (!stickerPickerPopover.hidden) closeStickerPicker();
  });

  stickerPickerPopover.addEventListener('click', event => {
    const item = event.target.closest('[data-sticker-id]');
    if (!item || !stickerPickerOnPick) return;
    const onPick = stickerPickerOnPick;
    closeStickerPicker();
    onPick(item.dataset.stickerId);
  });

  // ---------- comment reactions (server-authoritative, Render backend) ----------
  // One doc per (comment, uid) in the flat `commentReactions` collection —
  // upserting/toggling it is what /api/react-comment does. This is a
  // fire-and-forget POST; the actual pill counts update via the live
  // listeners wired in watchReactionsFor below, not from this response.
  async function sendReaction(parentType, parentId, commentId, stickerId){
    const user = auth.currentUser;
    if (!user || !commentId || !parentId) return;
    haptic('tap');
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`${PAYMENT_API_BASE}/api/react-comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify({ parentType, parentId, commentId, stickerId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reaction failed');
    } catch (err) {
      console.error('Reaction failed', err);
      showToast('Could not react — try again');
    }
  }

  // Repaints just the `.comment-reactions` pill row for every comment
  // currently in `listEl`, from an already-fetched reactions map — never
  // touches the rest of the comment (avatar/decoration/text), so it can
  // run on every reactions snapshot without fighting reconcileKeyedList's
  // own diffing of the surrounding comment elements.
  function refreshReactionPills(listEl, reactionsByComment){
    if (!listEl) return;
    listEl.querySelectorAll('.comment[data-comment-id]').forEach(commentEl => {
      const pillsEl = commentEl.querySelector('.comment-reactions');
      if (!pillsEl) return;
      const id = commentEl.dataset.commentId;
      const counts = reactionsByComment.get(id);
      if (!counts || !counts.size) { pillsEl.innerHTML = ''; return; }
      const myUid = auth.currentUser?.uid;
      pillsEl.innerHTML = Array.from(counts.entries()).map(([stickerId, info]) => {
        const mine = myUid && info.uids.has(myUid);
        return `<button type="button" class="comment-reaction-pill${mine ? ' mine' : ''}" data-sticker-id="${stickerId}" title="${info.uids.size} reacted">${stickerHtml(stickerId)}<span>${info.uids.size}</span></button>`;
      }).join('');
    });
  }

  // Watches every reaction on a single thread (matchupId or clipId) and
  // keeps `reactionsByComment` (commentId -> Map<stickerId, {uids:Set}>)
  // current, repainting pills on every change. Caches the map onto
  // `thread._reactions` too, so a fresh render (new comment arriving, the
  // modal sheet opening, a tab switch) can repaint immediately from the
  // last known snapshot instead of waiting for the next Firestore event.
  // Returns an unsubscribe fn. Same "filter by field, group in memory"
  // approach comments already use, rather than one listener per comment.
  function watchReactionsFor(parentId, thread, listEl){
    return onSnapshot(
      query(collection(db, 'commentReactions'), where('parentId', '==', parentId)),
      snapshot => {
        const reactionsByComment = new Map();
        snapshot.docs.forEach(d => {
          const r = d.data();
          if (!r.commentId || !r.stickerId || !r.uid) return;
          if (!reactionsByComment.has(r.commentId)) reactionsByComment.set(r.commentId, new Map());
          const perSticker = reactionsByComment.get(r.commentId);
          if (!perSticker.has(r.stickerId)) perSticker.set(r.stickerId, { uids: new Set() });
          perSticker.get(r.stickerId).uids.add(r.uid);
        });
        thread._reactions = reactionsByComment;
        refreshReactionPills(listEl, reactionsByComment);
        if (openCommentsThread === thread) refreshReactionPills(commentsModalList, reactionsByComment);
      },
      err => console.error('Reactions listener failed', err)
    );
  }

  // Each fx decoration can appear more than once at a time on the page
  // (e.g. the same equipped decoration on a comment avatar AND the account
  // header), so any internal SVG ids (gradients/filters/<use> targets) get
  // a per-call suffix — otherwise the browser resolves url(#id) against
  // whichever element with that id happens to come first in the DOM.
  let fxUidCounter = 0;
  const nextFxUid = () => `fx${Date.now().toString(36)}${(fxUidCounter++).toString(36)}`;

  const DECORATION_FX_BUILDERS = {
    hellflame(uid){
      const grad = `flameGrad-${uid}`, filt = `fireTurbulence-${uid}`;
      return `<span class="profile-deco-fx" aria-hidden="true">
        <svg class="fx-back" viewBox="0 0 130 130"><circle cx="65" cy="65" r="42" fill="#ff5b1f" opacity="0.25" filter="blur(6px)"/></svg>
        <svg class="fx-front" viewBox="0 0 130 130">
          <defs>
            <linearGradient id="${grad}" x1="0%" y1="100%" x2="0%" y2="0%">
              <stop offset="0%" stop-color="#ff5b1f"/><stop offset="100%" stop-color="#ffd873"/>
            </linearGradient>
            <filter id="${filt}" x="-40%" y="-40%" width="180%" height="180%">
              <feTurbulence type="fractalNoise" baseFrequency="0.01 0.06" numOctaves="2" seed="4" result="noise">
                <animate attributeName="baseFrequency" dur="3.5s" values="0.01 0.05;0.015 0.07;0.01 0.05" repeatCount="indefinite"/>
              </feTurbulence>
              <feDisplacementMap in="SourceGraphic" in2="noise" scale="6" xChannelSelector="R" yChannelSelector="G"/>
            </filter>
          </defs>
          <g style="filter:url(#${filt})">
            <g class="flame-t1"><path class="tongue-back" d="M65,44 C74,32 79,14 65,4 C51,14 56,32 65,44 Z"/></g>
            <g class="flame-t2" transform="rotate(60 65 65)"><path class="tongue-front" style="fill:url(#${grad})" d="M65,45 C72,35 76,20 65,10 C54,20 58,35 65,45 Z"/></g>
            <g class="flame-t3" transform="rotate(140 65 65)"><path class="tongue-front" style="fill:url(#${grad})" d="M65,44 C71,35 74,22 65,12 C56,22 59,35 65,44 Z"/></g>
            <g class="flame-t4" transform="rotate(220 65 65)"><path class="tongue-back" d="M65,45 C73,34 78,17 65,5 C52,17 57,34 65,45 Z"/></g>
            <g class="flame-t2" transform="rotate(290 65 65)"><path class="tongue-front" style="fill:url(#${grad})" d="M65,44 C72,34 75,19 65,9 C55,19 58,34 65,44 Z"/></g>
          </g>
        </svg>
      </span>`;
    },
    'web-trap'(uid){
      const CX = 41, CY = 41, SPOKE_COUNT = 10, OUTER_R = 39;
      const spokeAngles = Array.from({length: SPOKE_COUNT}, (_, i) => (i / SPOKE_COUNT) * 2 * Math.PI);
      const spokes = spokeAngles.map(a =>
        `<line class="web-strand" x1="${CX}" y1="${CY}" x2="${(CX + OUTER_R * Math.cos(a)).toFixed(1)}" y2="${(CY + OUTER_R * Math.sin(a)).toFixed(1)}"/>`
      ).join('');
      const scallops = [9, 16, 23, 30, 37].map(r => {
        const pts = spokeAngles.map(a => `${(CX + r * Math.cos(a)).toFixed(1)},${(CY + r * Math.sin(a)).toFixed(1)}`).join(' ');
        return `<polygon class="web-scallop" points="${pts}"/>`;
      }).join('');
      const spiderAngle = spokeAngles[2];
      const spiderX = (CX + 32 * Math.cos(spiderAngle)).toFixed(1), spiderY = (CY + 32 * Math.sin(spiderAngle)).toFixed(1);
      return `<span class="profile-deco-fx-web" aria-hidden="true">
        <svg class="web-sway" viewBox="0 0 82 82">
          <g>${spokes}</g>
          <g>${scallops}</g>
          <g transform="translate(${spiderX},${spiderY})">
            <ellipse class="spider-body" cx="0" cy="0" rx="3.4" ry="4.2"/>
            <circle class="spider-body" cx="0" cy="-5" r="2"/>
            <line class="spider-leg" x1="-2.6" y1="-1.6" x2="-7.6" y2="-5"/>
            <line class="spider-leg" x1="-2.6" y1="1" x2="-8.4" y2="1.6"/>
            <line class="spider-leg" x1="2.6" y1="-1.6" x2="7.6" y2="-5"/>
            <line class="spider-leg" x1="2.6" y1="1" x2="8.4" y2="1.6"/>
          </g>
        </svg>
      </span>`;
    },
    voltage(){
      return `<span class="profile-deco-fx" aria-hidden="true">
        <svg class="fx-back" viewBox="0 0 130 130"><circle class="ring-charge" cx="65" cy="65" r="41"/></svg>
        <svg class="fx-front" viewBox="0 0 130 130">
          <path class="bolt bolt-a" d="M65,20 L58,44 L68,44 L52,72 L62,50 L54,50 Z"/>
          <path class="bolt bolt-b" transform="rotate(140 65 65)" d="M65,18 L57,42 L67,42 L50,70 L60,48 L52,48 Z"/>
          <path class="bolt bolt-c" transform="rotate(250 65 65)" d="M65,22 L59,45 L69,45 L54,71 L63,51 L55,51 Z"/>
        </svg>
      </span>`;
    },
    frostbite(uid){
      const shape = `snowflakeShape-${uid}`;
      const flakes = [
        [28, 0, '8px', 1], [55, 0, '-6px', .7], [80, 0, '10px', 1],
        [100, 0, '-8px', .6], [40, 0, '5px', .8], [65, 0, '-10px', .65]
      ];
      const uses = flakes.map(([x, y, sway, scale], i) =>
        `<use class="snow-${i + 1}" href="#${shape}" x="${x}" y="${y}" style="--sway:${sway};transform:scale(${scale})"/>`
      ).join('');
      return `<span class="profile-deco-fx" aria-hidden="true">
        <svg class="fx-back" viewBox="0 0 130 130"><circle class="frost-glass" cx="65" cy="65" r="42"/></svg>
        <svg class="fx-front" viewBox="0 0 130 130">
          <defs>
            <g id="${shape}">
              <line class="snowflake" x1="0" y1="-6" x2="0" y2="6"/>
              <line class="snowflake" x1="-5.2" y1="-3" x2="5.2" y2="3"/>
              <line class="snowflake" x1="-5.2" y1="3" x2="5.2" y2="-3"/>
              <line class="snowflake" x1="0" y1="-6" x2="-1.6" y2="-3.6"/>
              <line class="snowflake" x1="0" y1="-6" x2="1.6" y2="-3.6"/>
              <line class="snowflake" x1="0" y1="6" x2="-1.6" y2="3.6"/>
              <line class="snowflake" x1="0" y1="6" x2="1.6" y2="3.6"/>
            </g>
          </defs>
          ${uses}
        </svg>
      </span>`;
    },
    bloodfang(){
      return `<span class="profile-deco-fx" aria-hidden="true">
        <svg class="fx-back" viewBox="0 0 130 130"><ellipse class="blood-mist" cx="65" cy="65" rx="46" ry="46"/></svg>
        <svg class="fx-front" viewBox="0 0 130 130">
          <circle class="vein" cx="65" cy="65" r="42" stroke-dasharray="3 10"/>
          <path class="blood-drip drip-1" d="M50,102 C50,106 46,110 46,114 C46,117 54,117 54,114 C54,110 50,106 50,102 Z"/>
          <path class="blood-drip drip-2" d="M65,105 C65,109 61,113 61,117 C61,120 69,120 69,117 C69,113 65,109 65,105 Z"/>
          <path class="blood-drip drip-3" d="M80,102 C80,106 76,110 76,114 C76,117 84,117 84,114 C84,110 80,106 80,102 Z"/>
        </svg>
      </span>`;
    },
    'solar-orbit'(){
      // Ported from a 340px canvas mockup (avatar-planets.html) into native
      // SVG: nine orbiting bodies, radii/sizes/periods compressed to read
      // clearly at avatar scale (32–56px) rather than kept to the mockup's
      // literal proportions. Each body gets its own <animateTransform> orbit
      // instead of a rAF redraw loop, so it's a static markup + CSS effect
      // like every other fx decoration, not a running script per instance.
      const CX = 65, CY = 65;
      const PLANETS = [
        { name:'mercury', color:'#b3a99a', r:44.0, size:1.4, period:4.4, angle:11  },
        { name:'venus',   color:'#e8c98a', r:46.4, size:2.0, period:5.8, angle:80  },
        { name:'earth',   color:'#5b9bd5', r:48.8, size:2.2, period:7.5, angle:166 },
        { name:'mars',    color:'#c1633b', r:51.1, size:1.8, period:9.5, angle:235 },
        { name:'jupiter', color:'#d8b98a', r:53.5, size:3.6, period:15,  angle:40  },
        { name:'saturn',  color:'#e3d3a5', r:55.9, size:3.2, period:19,  angle:206, ring:true },
        { name:'uranus',  color:'#9fd8db', r:58.3, size:2.6, period:26,  angle:298 },
        { name:'neptune', color:'#5f7fd8', r:60.6, size:2.5, period:35,  angle:109 },
        { name:'pluto',   color:'#c9b9a8', r:63.0, size:1.1, period:48,  angle:269 }
      ];
      const orbitRings = PLANETS.map(p => `<circle class="orbit-ring" cx="${CX}" cy="${CY}" r="${p.r}"/>`).join('');
      const bodies = PLANETS.map((p, i) => {
        const rad = p.angle * Math.PI / 180;
        const x = (CX + p.r * Math.cos(rad)).toFixed(2);
        const y = (CY + p.r * Math.sin(rad)).toFixed(2);
        const ring = p.ring ? `<ellipse class="planet-ring" cx="${x}" cy="${y}" rx="${(p.size*1.9).toFixed(2)}" ry="${(p.size*0.7).toFixed(2)}" transform="rotate(29 ${x} ${y})"/>` : '';
        return `<g>
          <animateTransform attributeName="transform" attributeType="XML" type="rotate" from="0 ${CX} ${CY}" to="360 ${CX} ${CY}" dur="${p.period}s" repeatCount="indefinite"/>
          ${ring}
          <circle class="planet-body" cx="${x}" cy="${y}" r="${p.size}" fill="${p.color}" style="animation-delay:${(i * 0.35).toFixed(2)}s"/>
        </g>`;
      }).join('');
      return `<span class="profile-deco-fx" aria-hidden="true">
        <svg class="fx-back" viewBox="0 0 130 130">${orbitRings}</svg>
        <svg class="fx-front" viewBox="0 0 130 130">${bodies}</svg>
      </span>`;
    },
    'web-slinger'(){
      // Color-swapped, un-clipped cousin of Web Trap: red/blue instead of
      // gothic black/white, plus three "shot" strands that fire past the
      // rim (Web Trap deliberately stays inside the circle; this one
      // bleeds outward like a sling in motion).
      const CX = 65, CY = 65, SPOKES = 8, OUTER_R = 40;
      const angles = Array.from({length: SPOKES}, (_, i) => (i / SPOKES) * 2 * Math.PI);
      const spokes = angles.map(a =>
        `<line class="webslinger-strand" x1="${CX}" y1="${CY}" x2="${(CX + OUTER_R * Math.cos(a)).toFixed(1)}" y2="${(CY + OUTER_R * Math.sin(a)).toFixed(1)}"/>`
      ).join('');
      const scallops = [12, 24, 34].map(r => {
        const pts = angles.map(a => `${(CX + r * Math.cos(a)).toFixed(1)},${(CY + r * Math.sin(a)).toFixed(1)}`).join(' ');
        return `<polygon class="webslinger-scallop" points="${pts}"/>`;
      }).join('');
      const shots = [angles[1], angles[4], angles[6]].map((a, i) =>
        `<line class="webslinger-shot ws-shot-${i + 1}" x1="${(CX + OUTER_R * 0.8 * Math.cos(a)).toFixed(1)}" y1="${(CY + OUTER_R * 0.8 * Math.sin(a)).toFixed(1)}" x2="${(CX + 62 * Math.cos(a)).toFixed(1)}" y2="${(CY + 62 * Math.sin(a)).toFixed(1)}"/>`
      ).join('');
      return `<span class="profile-deco-fx" aria-hidden="true">
        <svg class="fx-back" viewBox="0 0 130 130"><circle class="webslinger-ring ws-pulse" cx="${CX}" cy="${CY}" r="41"/></svg>
        <svg class="fx-front" viewBox="0 0 130 130">
          <g>${spokes}</g>
          <g>${scallops}</g>
          <g>${shots}</g>
        </svg>
      </span>`;
    },
    'kryptonian-flight'(){
      // Red/blue flight-trail streaks plus a generic pulsing heraldic
      // diamond at the chest position — deliberately a plain rhombus
      // rather than any specific crest, so it reads as "Kryptonian" in
      // spirit without reproducing a trademarked emblem.
      const streakPaths = [
        'M20,50 C35,45 50,48 62,58',
        'M108,42 C93,40 78,46 66,56',
        'M30,95 C42,86 55,80 65,72'
      ];
      const streaks = streakPaths.map((d, i) => `<path class="kryptonian-streak k-streak-${i + 1}" d="${d}" stroke-dasharray="10 30"/>`).join('');
      return `<span class="profile-deco-fx" aria-hidden="true">
        <svg class="fx-back" viewBox="0 0 130 130">
          <ellipse class="kryptonian-glow-blue" cx="65" cy="48" rx="44" ry="30"/>
          <ellipse class="kryptonian-glow-red" cx="65" cy="86" rx="44" ry="30"/>
        </svg>
        <svg class="fx-front" viewBox="0 0 130 130">
          ${streaks}
          <path class="kryptonian-emblem" d="M65,50 L78,65 L65,80 L52,65 Z"/>
        </svg>
      </span>`;
    },
    'dark-knight'(uid){
      // Two bat silhouettes on independent slow orbits (opposite
      // directions, different periods so they never lock into sync) plus
      // a spotlight wedge sweeping back and forth like a signal scanning
      // the sky, and a low purple mist underneath.
      const beamGrad = `darkknightBeam-${uid}`;
      const bat = `<g class="bat-wing">
          <ellipse cx="0" cy="0" rx="2.4" ry="4"/>
          <path d="M0,-1 L-14,-6 L-6,1 L-11,5 L-2,3 Z"/>
          <path d="M0,-1 L14,-6 L6,1 L11,5 L2,3 Z"/>
        </g>`;
      return `<span class="profile-deco-fx" aria-hidden="true">
        <svg class="fx-back" viewBox="0 0 130 130">
          <defs>
            <linearGradient id="${beamGrad}" x1="50%" y1="100%" x2="50%" y2="0%">
              <stop offset="0%" stop-color="#ffdf82" stop-opacity="0.32"/>
              <stop offset="100%" stop-color="#ffdf82" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <ellipse class="darkknight-mist" cx="65" cy="65" rx="46" ry="46"/>
          <path fill="url(#${beamGrad})" d="M65,65 L40,4 L90,4 Z">
            <animateTransform attributeName="transform" type="rotate" values="-35 65 65;35 65 65;-35 65 65" dur="6s" repeatCount="indefinite"/>
          </path>
        </svg>
        <svg class="fx-front" viewBox="0 0 130 130">
          <g>
            <animateTransform attributeName="transform" attributeType="XML" type="rotate" from="0 65 65" to="360 65 65" dur="14s" repeatCount="indefinite"/>
            <g class="bat-bob" transform="translate(65,26)">${bat}</g>
          </g>
          <g>
            <animateTransform attributeName="transform" attributeType="XML" type="rotate" from="360 65 65" to="0 65 65" dur="18s" repeatCount="indefinite"/>
            <g class="bat-bob" transform="translate(65,104) rotate(180)">${bat}</g>
          </g>
        </svg>
      </span>`;
    },
    thunderstrike(){
      // Storm-cousin of Voltage: same strobing zigzag-bolt technique, but
      // with clouds, more branching bolts at varied angles, and an
      // irregular whole-avatar flash synced loosely to the bolt timing.
      return `<span class="profile-deco-fx" aria-hidden="true">
        <svg class="fx-back" viewBox="0 0 130 130">
          <ellipse class="storm-cloud" cx="46" cy="26" rx="26" ry="12"/>
          <ellipse class="storm-cloud" cx="84" cy="22" rx="22" ry="10"/>
          <circle class="storm-flash storm-flash-anim" cx="65" cy="65" r="46"/>
        </svg>
        <svg class="fx-front" viewBox="0 0 130 130">
          <path class="storm-bolt storm-bolt-a" d="M50,20 L60,45 L48,45 L66,80 L58,52 L70,52 Z"/>
          <path class="storm-bolt storm-bolt-b" transform="rotate(150 65 65)" d="M52,18 L62,44 L50,44 L67,78 L59,50 L71,50 Z"/>
          <path class="storm-bolt storm-bolt-c" transform="rotate(255 65 65)" d="M48,22 L58,46 L46,46 L64,79 L56,53 L68,53 Z"/>
        </svg>
      </span>`;
    }
  };

  function profileDecorationMarkup(id){
    const item = decorationById(id);
    if (!item) return '';
    if (item.fx === 'canvas') {
      return `<span class="profile-deco-canvas" aria-hidden="true"><canvas class="avatar-fx-canvas" width="130" height="130" data-fx-type="${item.canvasType}"${item.fxParticles ? ` data-fx-particles="${item.fxParticles}"` : ''}></canvas></span>`;
    }
    const builder = item.fx && DECORATION_FX_BUILDERS[item.id];
    if (builder) return builder(nextFxUid());
    return `<span class="profile-deco profile-deco-${item.id}" aria-hidden="true"></span>`;
  }

  function initialsForProfile(name){
    return (name || 'Your account').trim().split(/\s+/).map(part => part[0]).join('').slice(0,2).toUpperCase() || 'YU';
  }

  function applyProfileNameFont(){
    if (!accountDisplayName) return;
    PROFILE_FONTS.forEach(font => accountDisplayName.classList.remove(font.cls));
    const font = fontById(equippedFont);
    if (font) accountDisplayName.classList.add(font.cls);
  }

  function renderCustomizationStore(){
    const pointsEl = document.getElementById('clashPointsDisplay');
    const shareEl = document.getElementById('profileShareCount');
    if (pointsEl) pointsEl.textContent = String(clashPoints);
    if (shareEl) shareEl.textContent = `${shareCount} share${shareCount === 1 ? '' : 's'}`;

    const decorationGrid = document.getElementById('decorationStoreGrid');
    const seasonSection = document.getElementById('decorationSeasonSection');
    const fontSeasonSection = document.getElementById('fontSeasonSection');
    const fontGrid = document.getElementById('fontStoreGrid');
    const cardEffectGrid = document.getElementById('cardEffectStoreGrid');
    const ownedGrid = document.getElementById('ownedStoreGrid');
    if (!decorationGrid || !fontGrid || !seasonSection) return;

    deactivateCanvasFx(decorationGrid);
    deactivateCanvasFx(seasonSection);
    if (fontSeasonSection) deactivateCanvasFx(fontSeasonSection);
    if (cardEffectGrid) deactivateCardFx(cardEffectGrid);
    if (ownedGrid) { deactivateCanvasFx(ownedGrid); deactivateCardFx(ownedGrid); }

    // Season items only ever show while their own season is the active
    // one — that's the "one active season at a time" behavior. Anything
    // already owned keeps working via decorationById() everywhere else
    // (equip/render), this just controls what's purchasable right now.
    const activeSeason = activeSeasonId ? SEASONS[activeSeasonId] : null;
    const seasonItems = activeSeason ? PROFILE_DECORATIONS.filter(item => item.season === activeSeasonId) : [];
    const evergreenItems = PROFILE_DECORATIONS.filter(item => !item.season && !item.retired);

    // Each season's own currency icon (the anime Shards' glowing sakura
    // petal, the Horror Skulls' skull mark, etc.) — shown wherever that
    // season's cost or balance appears. Icon path comes from the season's
    // own SEASONS entry, so a new season's currency is a data addition.
    function seasonCurrencyIconHtml(season){
      if (!season || !season.currencyIcon) return '';
      return `<img src="${season.currencyIcon}" alt="" class="shards-currency-icon" style="width:16px;height:16px;object-fit:contain;vertical-align:-3px;margin-right:3px;">`;
    }

    function decorationCardHtml(item, currency, balance){
      const owned = unlockedDecorations.includes(item.id);
      const equipped = equippedDecoration === item.id;
      const isPremium = !!item.premium;
      const buttonLabel = equipped ? 'Equipped' : owned ? 'Equip' : (isPremium ? 'Buy' : 'Redeem');
      // 'pts' is the evergreen Clash Points currency — anything else is a
      // season currency (shards, skulls, ...) and gets that season's icon.
      const costHtml = owned ? '' : isPremium
        ? `$${item.cash.usd.toFixed(2)}`
        : `${currency !== 'pts' ? seasonCurrencyIconHtml(activeSeason) : ''}${item.cost} ${currency}`;
      return `<div class="profile-store-item${owned ? ' owned' : ''}${isPremium ? ' premium' : ''}">
        ${owned ? '<span class="profile-owned-tag">OWNED</span>' : ''}
        ${!owned && isPremium ? '<span class="profile-premium-tag">PREMIUM</span>' : ''}
        <div class="profile-store-preview">${initialsForProfile(profileName?.value)}${profileDecorationMarkup(item.id)}</div>
        <h4>${item.name}</h4>
        <p class="profile-store-cat">${item.category}</p>
        <span class="profile-store-rarity ${item.rarity.toLowerCase()}">${item.rarity}</span>
        <div class="profile-store-cost">${costHtml}</div>
        <button class="profile-store-action${equipped ? ' equipped' : ''}${isPremium && !owned ? ' premium' : ''}" type="button" data-decoration-action="${item.id}" ${!owned && !isPremium && balance < item.cost ? 'disabled' : ''}>${buttonLabel}</button>
      </div>`;
    }

    seasonSection.innerHTML = (activeSeason && seasonItems.length) ? `
      <div class="profile-store-season">
        <div class="profile-store-season-banner" style="--season-banner-img:url('${activeSeason.bannerAsset}')">
          <span class="profile-store-season-label">${activeSeason.label}</span>
          <div class="profile-store-season-sub">Exclusive while the season's live — spend your ${activeSeason.currencyLabel} (${seasonCurrencyIconHtml(activeSeason)}${seasonShards} available)</div>
        </div>
        <div class="profile-store-season-grid">
          ${seasonItems.map(item => decorationCardHtml(item, activeSeason.currencyLabel.toLowerCase(), seasonShards)).join('')}
        </div>
      </div>` : '';

    // The evergreen (Clash Points) catalogue always stays visible in its
    // own section, season or no season — items priced in pts/XP live only
    // in this non-season store and never move into (or get replaced by)
    // the season shelf above. Previously this grid was cleared entirely
    // whenever a season was live, which made every evergreen decoration
    // unpurchasable for the duration of the season — that's fixed here.
    decorationGrid.innerHTML = evergreenItems.map(item => decorationCardHtml(item, 'pts', clashPoints)).join('');

    // Same split as the decorations above: season-tagged fonts (Nosifer &
    // co.) only ever show in their own season's shelf, exclusive to it —
    // never in another season, never in the default store. Evergreen
    // fonts (Bangers, Luckiest, ...) live in their own grid and — like the
    // evergreen decorations above — stay visible and purchasable the whole
    // time, season or no season, instead of disappearing while one is live.
    const seasonFontItems = activeSeason ? PROFILE_FONTS.filter(item => item.season === activeSeasonId) : [];
    const evergreenFontItems = PROFILE_FONTS.filter(item => !item.season);

    function fontCardHtml(item, forOwnedTab){
      const owned = unlockedFonts.includes(item.id);
      const equipped = equippedFont === item.id;
      const usesShards = !!item.season;
      const cost = item.cost || 70;
      const balance = usesShards ? seasonShards : clashPoints;
      const currency = usesShards ? (SEASONS[item.season]?.currencyLabel || 'Shards').toLowerCase() : 'pts';
      const buttonLabel = equipped ? 'Equipped' : owned ? 'Equip' : 'Redeem';
      const costHtml = owned ? '' : `${usesShards ? seasonCurrencyIconHtml(SEASONS[item.season]) : ''}${cost} ${currency}`;
      return `<div class="profile-store-item${owned ? ' owned' : ''}">
        ${owned ? '<span class="profile-owned-tag">OWNED</span>' : ''}
        <div class="profile-store-preview ${item.cls}">Aa</div>
        <h4>${item.name}</h4>
        <p class="profile-store-cat">${item.category}</p>
        <div class="profile-store-cost">${costHtml}</div>
        <button class="profile-store-action${equipped ? ' equipped' : ''}" type="button" data-font-action="${item.id}" ${!forOwnedTab && !owned && balance < cost ? 'disabled' : ''}>${buttonLabel}</button>
      </div>`;
    }

    if (fontSeasonSection) {
      fontSeasonSection.innerHTML = (activeSeason && seasonFontItems.length) ? `
        <div class="profile-store-season">
          <div class="profile-store-season-banner" style="--season-banner-img:url('${activeSeason.bannerAsset}')">
            <span class="profile-store-season-label">${activeSeason.label}</span>
            <div class="profile-store-season-sub">Exclusive while the season's live — spend your ${activeSeason.currencyLabel} (${seasonCurrencyIconHtml(activeSeason)}${seasonShards} available)</div>
          </div>
          <div class="profile-store-season-grid">
            ${seasonFontItems.map(item => fontCardHtml(item, false)).join('')}
          </div>
        </div>` : '';
    }
    fontGrid.innerHTML = evergreenFontItems.map(item => fontCardHtml(item, false)).join('');

    activateCanvasFx(decorationGrid);
    activateCanvasFx(seasonSection);
    [decorationGrid, seasonSection].forEach(grid => {
      grid.querySelectorAll('[data-decoration-action]').forEach(button => {
        button.addEventListener('click', () => handleCustomizationAction('decoration', button.dataset.decorationAction));
      });
    });
    [fontGrid, fontSeasonSection].filter(Boolean).forEach(grid => {
      grid.querySelectorAll('[data-font-action]').forEach(button => {
        button.addEventListener('click', () => handleCustomizationAction('font', button.dataset.fontAction));
      });
    });

    function cardEffectCardHtml(item){
      const owned = unlockedCardEffects.includes(item.id);
      const equipped = equippedCardEffect === item.id;
      const isPremium = !!item.premium;
      const xpLocked = !!item.requiresXp && currentUserXp < item.requiresXp && !owned;
      const buttonLabel = equipped ? 'Equipped'
        : owned ? 'Equip'
        : isPremium ? 'Buy'
        : xpLocked ? 'Locked' : 'Equip';
      const costHtml = owned ? '' : isPremium
        ? `$${item.cash.usd.toFixed(2)}`
        : item.requiresXp ? `${Math.min(currentUserXp, item.requiresXp)}/${item.requiresXp} XP` : '';
      return `<div class="profile-store-item card-effect-card${owned ? ' owned' : ''}${isPremium ? ' premium' : ''}${xpLocked ? ' locked' : ''}">
        ${owned ? '<span class="profile-owned-tag">OWNED</span>' : ''}
        ${!owned && isPremium ? '<span class="profile-premium-tag">PREMIUM</span>' : ''}
        ${xpLocked ? '<span class="profile-locked-tag">LOCKED</span>' : ''}
        <div class="profile-store-preview"><canvas class="card-fx-canvas mini" width="150" height="120" data-fx-type="${item.canvasType}"></canvas></div>
        <h4>${item.name}</h4>
        <p class="profile-store-cat">${item.category}</p>
        <span class="profile-store-rarity ${item.rarity.toLowerCase()}">${item.rarity}</span>
        <div class="profile-store-cost">${costHtml}</div>
        <button class="profile-store-action${equipped ? ' equipped' : ''}${isPremium && !owned ? ' premium' : ''}" type="button" data-card-effect-action="${item.id}" ${xpLocked ? 'disabled' : ''}>${buttonLabel}</button>
      </div>`;
    }

    if (cardEffectGrid) {
      cardEffectGrid.innerHTML = PROFILE_CARD_EFFECTS.map(cardEffectCardHtml).join('');
      activateCardFx(cardEffectGrid);
      cardEffectGrid.querySelectorAll('[data-card-effect-action]').forEach(button => {
        button.addEventListener('click', () => handleCardEffectAction(button.dataset.cardEffectAction));
      });
    }

    // Stickers tab — informational only (no equip/buy action): each one
    // just flips from locked to unlocked the moment currentUserXp crosses
    // its requiresXp line, same live-gated mechanic as Meteor Fall/Thunder
    // Strike above. The actual sticker picker (comment composer + reaction
    // bar) filters APP_STICKERS by isStickerUnlocked() independently of
    // this grid ever being opened.
    function stickerCardHtml(item){
      const unlocked = isStickerUnlocked(item.id, currentUserXp);
      return `<div class="profile-store-item sticker-card${unlocked ? ' owned' : ' locked'}">
        ${unlocked ? '<span class="profile-owned-tag">UNLOCKED</span>' : '<span class="profile-locked-tag">LOCKED</span>'}
        <div class="profile-store-preview sticker-preview">${stickerHtml(item.id)}</div>
        <div class="profile-store-cost">${unlocked ? '' : `${Math.min(currentUserXp, item.requiresXp)}/${item.requiresXp} XP`}</div>
      </div>`;
    }
    const stickerGrid = document.getElementById('stickerStoreGrid');
    if (stickerGrid) {
      stickerGrid.innerHTML = APP_STICKERS.map(stickerCardHtml).join('');
    }

    // Owned tab — every decoration, font, and card effect already
    // purchased or redeemed, in one place, regardless of which season (if
    // any) they came from or whether that season is still live. Read-only
    // display of ownership plus the same equip/unequip actions as the
    // regular shelves — nothing here is ever purchasable again.
    if (ownedGrid) {
      const ownedDecorations = PROFILE_DECORATIONS.filter(item => unlockedDecorations.includes(item.id));
      const ownedFonts = PROFILE_FONTS.filter(item => unlockedFonts.includes(item.id));
      const ownedCardEffects = PROFILE_CARD_EFFECTS.filter(item => unlockedCardEffects.includes(item.id));
      const hasOwnedItems = ownedDecorations.length || ownedFonts.length || ownedCardEffects.length;
      ownedGrid.innerHTML = hasOwnedItems ? [
        ownedDecorations.length ? `<div class="profile-owned-section-heading">Decorations</div>${ownedDecorations.map(item => decorationCardHtml(item, 'pts', clashPoints)).join('')}` : '',
        ownedFonts.length ? `<div class="profile-owned-section-heading">Name fonts</div>${ownedFonts.map(item => fontCardHtml(item, true)).join('')}` : '',
        ownedCardEffects.length ? `<div class="profile-owned-section-heading">Card effects</div>${ownedCardEffects.map(cardEffectCardHtml).join('')}` : ''
      ].join('') : `<div class="profile-store-empty-hint">Nothing purchased or redeemed yet — items you unlock show up here.</div>`;
      activateCanvasFx(ownedGrid);
      activateCardFx(ownedGrid);
      ownedGrid.querySelectorAll('[data-decoration-action]').forEach(button => {
        button.addEventListener('click', () => handleCustomizationAction('decoration', button.dataset.decorationAction));
      });
      ownedGrid.querySelectorAll('[data-font-action]').forEach(button => {
        button.addEventListener('click', () => handleCustomizationAction('font', button.dataset.fontAction));
      });
      ownedGrid.querySelectorAll('[data-card-effect-action]').forEach(button => {
        button.addEventListener('click', () => handleCardEffectAction(button.dataset.cardEffectAction));
      });
    }
  }

  // Premium (real-money) decorations are NOT unlocked by writing straight
  // to Firestore from the client the way point-redeemed items are — that
  // would let anyone grant themselves a paid item for free. They go through
  // Paystack instead, and the server verifies the payment before the item
  // is added to unlockedDecorations. That verification endpoint is the
  // "backend for the monetization" piece — not built yet, so this just
  // opens the checkout intent for now.
  // Paystack appends ?reference=xxx&trxref=xxx to whatever returnUrl we
  // sent it (see create-payment.js). onAuthStateChanged calls this on
  // every sign-in, so `paymentReturnHandled` stops it from re-verifying
  // (and re-showing a toast for) the same reference on a later auth event
  // in the same page load — verify-payment.js is idempotent regardless,
  // this just avoids a duplicate toast.
  let paymentReturnHandled = false;
  async function handlePaymentReturn(){
    if (paymentReturnHandled) return;
    const params = new URLSearchParams(location.search);
    const reference = params.get('reference') || params.get('trxref');
    if (!reference) return;
    paymentReturnHandled = true;
    history.replaceState(null, '', location.pathname);
    const user = auth.currentUser;
    if (!user) return;
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`${PAYMENT_API_BASE}/api/verify-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify({ reference }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        if (data.itemType === 'decoration') {
          if (!unlockedDecorations.includes(data.itemId)) unlockedDecorations.push(data.itemId);
          renderCustomizationStore();
          const item = decorationById(data.itemId);
          showToast(`${item ? item.name : 'Decoration'} unlocked!`);
        } else if (data.itemType === 'cardEffect') {
          if (!unlockedCardEffects.includes(data.itemId)) unlockedCardEffects.push(data.itemId);
          renderCustomizationStore();
          const item = cardEffectById(data.itemId);
          showToast(`${item ? item.name : 'Card effect'} unlocked!`);
        } else if (data.itemType === 'badge') {
          verifiedUntilCache[user.uid] = null; // force a fresh read next time it's checked
          showToast('Verified badge renewed!');
        }
      } else {
        showToast('Payment could not be confirmed — contact support if you were charged');
      }
    } catch (err) {
      console.error('Payment return check failed', err);
      showToast('Payment could not be confirmed — contact support if you were charged');
    }
  }

  async function handlePremiumPurchase(item, itemType = 'decoration'){
    const user = auth.currentUser;
    if (!user) { requireSignIn('Sign in to buy this item'); return; }
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`${PAYMENT_API_BASE}/api/create-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify({ itemType, itemId: item.id, returnUrl: location.href.split('?')[0] }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(res.status === 409 ? 'Already in your collection' : 'Could not start checkout');
        return;
      }
      location.href = data.authorization_url;
    } catch (err) {
      console.error('Premium purchase failed', err);
      showToast('Could not start checkout');
    }
  }

  // Card effects have two totally different unlock paths, so they get
  // their own handler rather than folding into handleCustomizationAction's
  // points/shards logic — requiresXp effects are never bought or spent
  // from, just gated live on currentUserXp until they cross the line.
  async function handleCardEffectAction(id){
    const user = auth.currentUser;
    if (!user) { requireSignIn('Sign in to use the Theme Store'); return; }
    const item = cardEffectById(id);
    if (!item) return;
    const owned = unlockedCardEffects.includes(id);

    if (item.premium && !owned) { handlePremiumPurchase(item, 'cardEffect'); return; }
    if (item.requiresXp && !owned && currentUserXp < item.requiresXp) {
      showToast(`Reach ${item.requiresXp} XP to unlock ${item.name} (${currentUserXp}/${item.requiresXp})`);
      return;
    }

    // Free to equip from here — either an owned premium effect or an
    // XP-gated one that's cleared its threshold. Nothing is spent.
    const nextValue = equippedCardEffect === id ? null : id;
    try {
      await updateDoc(doc(db, 'users', user.uid), { equippedCardEffect: nextValue });
      equippedCardEffect = nextValue;
      updateCardEffectDisplay();
      renderCustomizationStore();
      showToast(nextValue ? `${item.name} equipped` : `${item.name} unequipped`);
    } catch (err) {
      console.error('Card effect equip failed', err);
      showToast('Could not update your Theme Store');
    }
  }

  async function handleCustomizationAction(type, id){
    const user = auth.currentUser;
    if (!user) { requireSignIn('Sign in to use the Avatar Store'); return; }
    const item = type === 'decoration' ? decorationById(id) : fontById(id);
    if (!item) return;
    const ownedList = type === 'decoration' ? unlockedDecorations : unlockedFonts;
    if (item.premium && !ownedList.includes(id)) { handlePremiumPurchase(item); return; }
    const cost = type === 'decoration' ? item.cost : (item.cost || 70);
    // Season-tagged items (decorations AND fonts) spend seasonShards instead
    // of clashPoints — a completely separate balance/field, never mixed
    // with the evergreen currency (see awardXp in api/lib/xp.js for where
    // shards come from).
    const usesShards = !!item.season;
    // Dotted key (e.g. 'seasonShards.horror') — used as the nested-field
    // path for reading the local balance below. IMPORTANT: this only
    // resolves to the nested field seasonShards.horror when written via
    // transaction.update()/updateDoc(). transaction.set(ref, data,
    // {merge:true}) does NOT reliably expand a dotted object key into a
    // nested path — it can send it as one literal field literally named
    // "seasonShards.horror" (dot included in the name), which is exactly
    // what the security rules' affectedKeys() check correctly rejected,
    // since that literal field never matches 'seasonShards' in hasOnly().
    // That was the real cause behind every season-shard purchase silently
    // failing with permission-denied — see the transaction below, which
    // now uses update() instead of set()+merge for this reason.
    const currencyField = usesShards ? `seasonShards.${item.season}` : 'clashPoints';
    const currencyLabel = usesShards ? (SEASONS[item.season]?.currencyLabel || 'Shards') : 'Clash Points';
    const userRef = doc(db, 'users', user.uid);

    // See postHeroComment/addComment above — navigator.vibrate needs live
    // user activation. Every branch below does an awaited Firestore
    // round trip first, so the haptic has to fire here, still inside the
    // click handler's synchronous call stack, or it silently no-ops.
    haptic('tap');
    try {
      if (ownedList.includes(id)) {
        const field = type === 'decoration' ? 'equippedDecoration' : 'equippedFont';
        const nextValue = (type === 'decoration' ? equippedDecoration : equippedFont) === id ? null : id;
        await updateDoc(userRef, { [field]: nextValue });
        if (type === 'decoration') equippedDecoration = nextValue;
        else equippedFont = nextValue;
        updateAccountHeader();
        showToast(nextValue ? `${item.name} equipped` : `${item.name} unequipped`);
        return;
      }

      const localBalance = usesShards ? seasonShards : clashPoints;
      if (localBalance < cost) {
        showToast(`You need ${cost - localBalance} more ${currencyLabel}`);
        return;
      }
      await runTransaction(db, async transaction => {
        const snap = await transaction.get(userRef);
        const exists = snap.exists();
        const data = exists ? snap.data() : {};
        // data is the real nested doc — a dotted key won't resolve here
        // the way it does in the query/update side, so read it manually.
        const remoteBalance = Number(fieldPath(data, currencyField) || 0);
        const remoteOwned = type === 'decoration'
          ? (Array.isArray(data.unlockedDecorations) ? data.unlockedDecorations : [])
          : (Array.isArray(data.unlockedFonts) ? data.unlockedFonts : []);
        if (remoteOwned.includes(id)) throw new Error('already-owned');
        if (remoteBalance < cost) throw new Error('not-enough-points');
        const unlockedField = type === 'decoration' ? 'unlockedDecorations' : 'unlockedFonts';
        const lastRedeemedField = type === 'decoration' ? 'lastRedeemedDecoration' : 'lastRedeemedFont';
        if (exists) {
          // update() (unlike set()+merge — see the note on currencyField
          // above) reliably expands a dotted string key into the nested
          // field path, which is what actually gets this write past the
          // security rules' affectedKeys() check.
          transaction.update(userRef, {
            [currencyField]: remoteBalance - cost,
            [unlockedField]: arrayUnion(id),
            [lastRedeemedField]: id
          });
        } else {
          // No doc yet to update — build the nested object by hand
          // instead of leaning on a dotted key, since that's the exact
          // shape set()+merge fails to expand correctly.
          const payload = { [unlockedField]: arrayUnion(id), [lastRedeemedField]: id };
          if (usesShards) payload.seasonShards = { [item.season]: remoteBalance - cost };
          else payload.clashPoints = remoteBalance - cost;
          transaction.set(userRef, payload, { merge: true });
        }
      });
      if (usesShards) {
        seasonShardsRaw[item.season] = (seasonShardsRaw[item.season] || 0) - cost;
        recomputeSeasonShards();
      } else {
        clashPoints -= cost;
      }
      ownedList.push(id);
      renderCustomizationStore();
      showToast(`${item.name} redeemed`);
    } catch (err) {
      if (err.message === 'not-enough-points') showToast(`Not enough ${currencyLabel}`);
      else if (err.message === 'already-owned') showToast('Already in your collection');
      else {
        console.error('Avatar Store action failed', err);
        showToast('Could not update your Avatar Store');
      }
    }
  }

  let shareRewardInFlight = false;
  async function rewardAppSharePoints(){
    const user = auth.currentUser;
    if (!user || shareRewardInFlight) return;
    shareRewardInFlight = true;
    const userRef = doc(db, 'users', user.uid);
    const creditId = `app-share-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const creditRef = doc(db, 'users', user.uid, 'shareCredits', creditId);
    try {
      await runTransaction(db, async transaction => {
        const snap = await transaction.get(userRef);
        const data = snap.exists() ? snap.data() : {};
        transaction.set(creditRef, {
          type: 'appShare',
          points: 5,
          creditedAt: serverTimestamp()
        });
        transaction.set(userRef, {
          clashPoints: Number(data.clashPoints || 0) + 5,
          shareCount: Number(data.shareCount || 0) + 1,
          lastShareCreditId: creditId
        }, { merge: true });
      });
      clashPoints += 5;
      shareCount += 1;
      renderCustomizationStore();
      showToast('App shared · +5 Clash Points');
    } catch (err) {
      console.error('Share reward failed', err);
      showToast('Shared, but points could not be saved');
    } finally {
      shareRewardInFlight = false;
    }
  }

  const profileShareBtn = document.getElementById('profileShareBtn');
  profileShareBtn.addEventListener('click', () => {
    if (!auth.currentUser) { requireSignIn('Sign in to earn Clash Points'); return; }
    shareLink({
      title: 'Fiction Clash',
      text: 'Vote on the characters and stories you love on Fiction Clash.',
      url: buildShareUrl('app', 'profile'),
      onShared: rewardAppSharePoints
    });
  });
  document.querySelectorAll('[data-store-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      const activeTab = tab.dataset.storeTab;
      document.querySelectorAll('[data-store-tab]').forEach(item => item.classList.toggle('active', item === tab));
      // Every section is scoped to its own tab now — previously
      // decorationSeasonSection had no hidden toggle at all, so the active
      // season's avatar effects stayed on screen (stacked above whatever
      // grid was showing) no matter which tab was selected, e.g. fonts or
      // card effects both showed the season decorations ahead of their
      // own items. Each grid/section below now hides unless it's the
      // active tab's own.
      document.getElementById('decorationSeasonSection').hidden = activeTab !== 'decorations';
      document.getElementById('decorationStoreGrid').hidden = activeTab !== 'decorations';
      const fontSeasonSection = document.getElementById('fontSeasonSection');
      if (fontSeasonSection) fontSeasonSection.hidden = activeTab !== 'fonts';
      document.getElementById('fontStoreGrid').hidden = activeTab !== 'fonts';
      const cardEffectGrid = document.getElementById('cardEffectStoreGrid');
      if (cardEffectGrid) cardEffectGrid.hidden = activeTab !== 'cardEffects';
      const ownedGrid = document.getElementById('ownedStoreGrid');
      if (ownedGrid) ownedGrid.hidden = activeTab !== 'owned';
      const stickerGrid = document.getElementById('stickerStoreGrid');
      if (stickerGrid) stickerGrid.hidden = activeTab !== 'stickers';
    });
  });

  // ---------- topbar sign-in icon <-> avatar ----------
  const signinBtn = document.getElementById('signinBtn');
  const SIGNIN_DEFAULT_ICON = signinBtn.innerHTML;

  function syncTopbarAvatar(){
    const user = window.firebaseAuth && window.firebaseAuth.currentUser;
    if (user) {
      signinBtn.classList.add('is-avatar');
      signinBtn.classList.remove('has-decoration');
      signinBtn.setAttribute('aria-label', 'Account menu');
      signinBtn.title = 'Account';
      if (avatarDataUrl) {
        signinBtn.innerHTML = `<img src="${avatarDataUrl}" alt="Profile picture">`;
      } else {
        const name = profileName.value.trim() || user.displayName || (user.email ? user.email.split('@')[0] : '') || 'Your account';
        signinBtn.innerHTML = `${escapeHtml(name === 'Your account' ? 'YU' : name.trim().charAt(0).toUpperCase())}`;
      }
    } else {
      signinBtn.classList.remove('is-avatar');
      signinBtn.setAttribute('aria-label', 'Sign in');
      signinBtn.title = 'Sign in';
      signinBtn.innerHTML = SIGNIN_DEFAULT_ICON;
    }
  }

  function renderAvatar(){
    accountAvatar.classList.toggle('has-decoration', !!decorationById(equippedDecoration));
    accountAvatar.dataset.decoration = equippedDecoration || '';
    deactivateCanvasFx(accountAvatar);
    if (avatarDataUrl) {
      accountAvatar.innerHTML = `<img src="${avatarDataUrl}" alt="Profile picture">${profileDecorationMarkup(equippedDecoration)}`;
      removeAvatarBtn.hidden = false;
    } else {
      const name = profileName.value.trim() || 'Your account';
      accountAvatar.innerHTML = `<span class="avatar-initials">${escapeHtml(initialsForProfile(name))}</span>${profileDecorationMarkup(equippedDecoration)}`;
      removeAvatarBtn.hidden = true;
    }
    activateCanvasFx(accountAvatar);
    syncTopbarAvatar();
  }

  // ---------- verified badge (earned via XP: votes, comments, contributions) ----------
  // A user earns a "verified" badge for 3 days each time their cumulative
  // `xp` crosses a new multiple of 1000. xp only ever goes up and is only
  // ever written server-side (via /api/vote and /api/comment — see
  // /api/lib/xp.js), so this can't be farmed by scripting client writes.
  const VERIFIED_XP_THRESHOLD = 1000;
  const VERIFIED_BADGE_DAYS = 3;
  let currentUserVerifiedUntil = null; // Firestore Timestamp or null
  let currentUserXp = 0; // progress toward the next badge
  let currentUserWeeklyXp = 0; // resets to 0 every Monday — see /api/reset-weekly-xp

  // Same seal shape used everywhere the badge shows up.
  const VERIFIED_BADGE_SVG = '<svg viewBox="0 0 24 24" width="100%" height="100%"><path fill="#5865F2" d="M23 12l-2.44-2.78.34-3.68-3.61-.82-1.89-3.18L12 3 8.6 1.54 6.71 4.72l-3.61.81.34 3.68L1 12l2.44 2.78-.34 3.69 3.61.82 1.89 3.18L12 21l3.4 1.46 1.89-3.18 3.61-.82-.34-3.68L23 12z"/><path fill="#fff" d="M10 15.17l-3.88-3.88L5 12.41l5 5 9-9-1.41-1.41z"/></svg>';

  // Live badge status for OTHER people's comments — deliberately NOT based
  // on a "verified" flag saved onto the comment at post time, so that (a)
  // an account that becomes verified after a comment was posted still
  // shows the badge on that old comment, and (b) the badge disappears
  // from it again the moment that 1-month window runs out, same as
  // everywhere else. verifiedUntilCache holds each uid's expiry (in ms,
  // or null) fetched at most once per uid — cheap on reads since the
  // value itself rarely changes — and a periodic sweep below just
  // re-compares each visible badge's cached expiry against the clock.
  const verifiedUntilCache = {}; // uid -> millis | null
  const liveVerifiedBadges = []; // { el, uid } for every badge currently on screen
  async function getVerifiedUntilMillis(uid){
    if (uid in verifiedUntilCache) return verifiedUntilCache[uid];
    try {
      const snap = await getDoc(doc(db, 'users', uid));
      const vu = snap.exists() && snap.data().verifiedUntil ? snap.data().verifiedUntil.toMillis() : null;
      verifiedUntilCache[uid] = vu;
      return vu;
    } catch (err) {
      console.error('Verified status lookup failed', err);
      return null;
    }
  }
  // Wires one badge element to a uid: shows/hides it now (once the lookup
  // resolves) and registers it for the periodic expiry sweep.
  function attachVerifiedBadge(badgeEl, uid){
    if (!badgeEl || !uid) return;
    const entry = { el: badgeEl, uid };
    liveVerifiedBadges.push(entry);
    getVerifiedUntilMillis(uid).then(() => recomputeVerifiedBadge(entry));
  }
  function recomputeVerifiedBadge(entry){
    const vu = verifiedUntilCache[entry.uid];
    entry.el.style.display = (typeof vu === 'number' && vu > Date.now()) ? 'inline-flex' : 'none';
  }
  // Every minute, re-check every badge currently on screen against its
  // already-cached expiry — no extra Firestore reads, just a clock
  // comparison, so a badge disappears from old comments right on
  // schedule even if the page has been open the whole month.
  // liveVerifiedBadges only ever grew before — nothing removed an entry
  // when its comment/leaderboard row scrolled out of the preview cap or
  // its list got torn down (switching matchups, closing a sheet, etc.), so
  // a long session would build up thousands of stale entries pointing at
  // detached elements, each one still getting a style write every sweep.
  // Pruning disconnected elements here (rather than at every removal call
  // site) self-heals regardless of which code path removed the element.
  setInterval(() => {
    for (let i = liveVerifiedBadges.length - 1; i >= 0; i--) {
      if (!liveVerifiedBadges[i].el.isConnected) { liveVerifiedBadges.splice(i, 1); continue; }
      recomputeVerifiedBadge(liveVerifiedBadges[i]);
    }
  }, 60000);
  setInterval(renderVerifiedBadge, 60000);

  // Keeps a blind matchup's reveal countdown ticking, and catches the
  // blind→revealed transition for whoever's actively looking at it. No
  // Firestore listener does this — 'modified' doc changes are ignored
  // everywhere in this app, votesA/votesB included (see the matchups
  // onSnapshot above), so this matches how live vote counts already
  // behave here: it self-corrects on the next render, not via a push.
  setInterval(() => {
    const m = matchups[activeIdx];
    if (m && m.revealAt) updatePercentages();
  }, 15000);

  // ---------- equipped decoration (shown on OTHER accounts' comments) ----------
  // Same idea as the verified badge above: a comment only stores who posted
  // it (uid), and the decoration actually shown is looked up live from that
  // account's current profile. That way, if someone changes or unequips
  // their decoration, it updates everywhere their name appears — including
  // on comments they posted before the change — instead of being frozen to
  // whatever was equipped at post time.
  const equippedDecorationCache = {}; // uid -> decorationId | null
  async function getEquippedDecorationId(uid){
    if (uid in equippedDecorationCache) return equippedDecorationCache[uid];
    try {
      const snap = await getDoc(doc(db, 'users', uid));
      const id = snap.exists() && decorationById(snap.data().equippedDecoration) ? snap.data().equippedDecoration : null;
      equippedDecorationCache[uid] = id;
      return id;
    } catch (err) {
      console.error('Decoration lookup failed', err);
      return null;
    }
  }
  // Wires one avatar container (e.g. a .comment-avatar) to a uid: fetches
  // that account's current decoration and applies it to the container.
  function attachDecoration(container, uid){
    if (!container || !uid) return;
    getEquippedDecorationId(uid).then(id => applyDecorationToContainer(container, id));
  }
  function applyDecorationToContainer(container, id){
    const item = decorationById(id);
    container.classList.toggle('has-decoration', !!item);
    // Remove ANY previous decoration markup before adding the new one —
    // fx-style decorations (hellflame, web-trap, voltage, frostbite,
    // bloodfang) render as .profile-deco-fx / .profile-deco-fx-web spans
    // rather than .profile-deco, so only clearing .profile-deco left the
    // old fx overlay stacked on top of the new decoration whenever either
    // side of the swap was an fx one.
    // canvas-based fx (real-flame, dragon-balls, etc.) run a live rAF loop
    // per canvas — stop it before its element is torn out, or the shared
    // AvatarEffect loop keeps ticking an instance nothing shows anymore.
    deactivateCanvasFx(container);
    container.querySelectorAll('.profile-deco, .profile-deco-fx, .profile-deco-fx-web, .profile-deco-canvas').forEach(el => el.remove());
    if (item) container.insertAdjacentHTML('beforeend', profileDecorationMarkup(id));
    activateCanvasFx(container);
  }

  // ---------- equipped font (shown on OTHER accounts' comment names) ----------
  // Same live-lookup pattern as the decoration above: a comment's name is
  // rendered in that account's current equipped font, fetched from their
  // profile rather than baked in at post time.
  const equippedFontCache = {}; // uid -> fontId | null
  async function getEquippedFontId(uid){
    if (uid in equippedFontCache) return equippedFontCache[uid];
    try {
      const snap = await getDoc(doc(db, 'users', uid));
      const id = snap.exists() && fontById(snap.data().equippedFont) ? snap.data().equippedFont : null;
      equippedFontCache[uid] = id;
      return id;
    } catch (err) {
      console.error('Font lookup failed', err);
      return null;
    }
  }
  function attachFont(nameEl, uid){
    if (!nameEl || !uid) return;
    getEquippedFontId(uid).then(id => {
      PROFILE_FONTS.forEach(font => nameEl.classList.remove(font.cls));
      const font = fontById(id);
      if (font) nameEl.classList.add(font.cls);
    });
  }

  // ---------- live name/avatar (shown everywhere the account has engaged) ----------
  // Same live-lookup pattern as the decoration/font/verified badge above: a
  // comment, reply, or clip attribution only stores who posted it (uid)
  // plus whatever name/avatar were current at that moment. Looking up the
  // account's CURRENT name/avatarUrl here — instead of trusting that
  // snapshot — means changing your profile picture or display name updates
  // every comment, reply, and clip post you've ever made, not just new
  // ones, the same way a decoration change already does above.
  const nameAvatarCache = {}; // uid -> { name, avatarUrl } | null
  async function getLiveNameAvatar(uid){
    if (uid in nameAvatarCache) return nameAvatarCache[uid];
    try {
      const snap = await getDoc(doc(db, 'users', uid));
      const info = snap.exists() ? { name: snap.data().name || null, avatarUrl: snap.data().avatarUrl || null } : null;
      nameAvatarCache[uid] = info;
      return info;
    } catch (err) {
      console.error('Live name/avatar lookup failed', err);
      return null;
    }
  }
  // Swaps just the name text in place, leaving any sibling markup (the
  // verified badge span) untouched — the name is always nameEl's first
  // child text node, everything after it belongs to something else.
  function applyLiveName(nameEl, name){
    if (!nameEl || !name) return;
    const first = nameEl.firstChild;
    if (first && first.nodeType === Node.TEXT_NODE) first.nodeValue = name;
    else nameEl.insertBefore(document.createTextNode(name), nameEl.firstChild);
  }
  // Swaps just the avatar (img or initials) — always avatarContainer's
  // first child — leaving any decoration markup appended after it intact.
  function applyLiveAvatar(avatarContainer, name, avatarUrl){
    if (!avatarContainer || !avatarUrl) return;
    const img = document.createElement('img');
    img.src = avatarUrl;
    img.alt = name || '';
    const first = avatarContainer.firstChild;
    if (first) avatarContainer.replaceChild(img, first);
    else avatarContainer.appendChild(img);
  }
  // Wires a rendered comment/attribution to a uid: once the live lookup
  // resolves, updates the name text and/or avatar in place. Either element
  // can be omitted (e.g. a plain "Posted by X" line has no avatar image).
  function attachLiveIdentity(uid, nameEl, avatarContainer){
    if (!uid) return;
    getLiveNameAvatar(uid).then(info => {
      if (!info) return; // account deleted or lookup failed — keep the stored snapshot
      applyLiveName(nameEl, info.name);
      applyLiveAvatar(avatarContainer, info.name, info.avatarUrl);
    });
  }

  function isCurrentlyVerified(){
    return !!(currentUserVerifiedUntil && currentUserVerifiedUntil.toMillis() > Date.now());
  }

  function renderVerifiedBadge(){
    const el = document.getElementById('accountVerifiedBadge');
    if (el) el.style.display = isCurrentlyVerified() ? 'inline-flex' : 'none';
    renderVerifiedProgress();
  }

  // Shows "X/20 to verified badge" while someone's working toward it, or
  // a days-left countdown once they've earned it. Hidden entirely when
  // signed out, since progress is meaningless without an account to save it to.
  function renderVerifiedProgress(){
    const el = document.getElementById('verifiedProgressText');
    if (!el) return;
    if (!auth.currentUser) { el.style.display = 'none'; return; }
    if (isCurrentlyVerified()) {
      const daysLeft = Math.max(1, Math.ceil((currentUserVerifiedUntil.toMillis() - Date.now()) / (24 * 60 * 60 * 1000)));
      el.textContent = `✓ Verified · ${daysLeft}d left · tap to learn more`;
    } else {
      el.textContent = `${currentUserXp % VERIFIED_XP_THRESHOLD}/${VERIFIED_XP_THRESHOLD} points to verified badge · tap to learn more`;
    }
    el.style.display = 'block';
  }

  // Verified-badge progress is now driven entirely by server-side XP
  // awards (see /api/lib/xp.js) — votes and comments call /api/vote and
  // /api/comment, which bump `xp` and set `verifiedUntil` directly via
  // the Admin SDK when a new 1000-point threshold is crossed. There's no
  // client-side action to record anymore; loadCloudProfile() and the
  // vote/comment response handlers keep currentUserXp and
  // currentUserVerifiedUntil in sync with what the server already wrote.

  // Discord-style "Member Since" line on the profile — Firebase Auth
  // already tracks account-creation time per user, so this needs no new
  // backend field, just reading user.metadata.creationTime when signed in.
  function renderMemberSince(user){
    const el = document.getElementById('accountMemberSince');
    if (!el) return;
    if (!user || !user.metadata || !user.metadata.creationTime) { el.style.display = 'none'; return; }
    const joined = new Date(user.metadata.creationTime);
    const joinedLabel = joined.toLocaleDateString(undefined, {month:'long', year:'numeric'});
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg><span>Member since ${joinedLabel}</span>`;
    el.style.display = 'flex';
  }

  function updateAccountHeader(){
    const name = profileName.value.trim() || 'Your account';
    const handle = profileHandle.value.trim() || 'Sign in to save your clashes';
    accountDisplayName.textContent = name;
    accountDisplayHandle.textContent = handle;
    const bioEl = document.getElementById('accountDisplayBio');
    if (bioEl) {
      const bio = profileBio.value.trim();
      bioEl.textContent = bio;
      bioEl.style.display = bio ? 'block' : 'none';
    }
    applyProfileNameFont();
    renderAvatar();
    if (typeof renderCoverPhoto === 'function') renderCoverPhoto();
    renderCustomizationStore();
    renderVerifiedBadge();
    renderHeroCharacterCosmetics();
    updateCardEffectDisplay();
  }

  // Swaps the data-fx-type on the real account hero's canvas to match
  // whatever's equipped (or clears it). The canvas element itself always
  // stays in the DOM (see index.html) — this only ever toggles which
  // effect (if any) is running on it, same start/stop contract as
  // activateCardFx/deactivateCardFx use everywhere else.
  function updateCardEffectDisplay(){
    const canvas = document.getElementById('accountCardFxCanvas');
    if (!canvas) return;
    deactivateCardFx(canvas.parentElement);
    const item = equippedCardEffect ? cardEffectById(equippedCardEffect) : null;
    if (item) {
      canvas.dataset.fxType = item.canvasType;
      activateCardFx(canvas.parentElement);
    } else {
      delete canvas.dataset.fxType;
    }
  }

  function persistProfile(){
    const profile = {name:profileName.value.trim(), handle:profileHandle.value.trim(), bio:profileBio.value.trim(), avatar:avatarDataUrl, cover:coverPhotoDataUrl};
    localStorage.setItem('fictionClashProfile', JSON.stringify(profile));
    // Also sync to Firestore when signed in, so the name/handle/bio/picture
    // show up the same way on any other browser this account signs into.
    // Only sync the picture once it's small (a compressed data URL, or an
    // http(s) URL) — an uncompressed FileReader preview can be several MB,
    // which is both wasteful and can exceed Firestore's 1MB document limit.
    const user = auth.currentUser;
    if (user) {
      const smallEnough = !profile.avatar || profile.avatar.startsWith('http') || profile.avatar.length < 400000;
      const coverSmallEnough = !profile.cover || profile.cover.startsWith('http') || profile.cover.length < 500000;
      setDoc(doc(db, 'users', user.uid), {
        name: profile.name, handle: profile.handle, bio: profile.bio,
        avatarUrl: smallEnough ? profile.avatar : '',
        coverPhotoUrl: coverSmallEnough ? profile.cover : '',
        updatedAt: serverTimestamp()
      }, { merge: true }).catch(err => {
        console.error('Profile sync failed', err);
        // The name/avatar/cover were still saved to localStorage above, so
        // they'll look fine in THIS session — but without this toast a
        // rejected Firestore write (e.g. a security-rules mismatch) is
        // invisible until the user logs out/in or switches devices and
        // finds the change silently gone.
        showToast('Saved on this device, but syncing to your account failed');
      });
      // Drop this account's cached name/avatar so every comment, reply, and
      // clip already on screen picks up the change on its next re-render
      // instead of waiting for a full reload.
      delete nameAvatarCache[user.uid];
    }
  }

  // Loads this account's profile from Firestore (if any) so it shows up
  // the same way it does on the browser it was set up on. Local fields
  // already populated (e.g. from localStorage) are kept as a fallback.
  function loadCloudProfile(uid){
    getDoc(doc(db, 'users', uid)).then(snap => {
      if (!snap.exists()) return;
      const data = snap.data();
      if (data.name) profileName.value = data.name;
      if (data.handle) profileHandle.value = data.handle;
      if (data.bio) profileBio.value = data.bio;
      if (data.avatarUrl) avatarDataUrl = data.avatarUrl;
      if (data.coverPhotoUrl) coverPhotoDataUrl = data.coverPhotoUrl;
      clashPoints = Number(data.clashPoints || 0);
      seasonShardsRaw = (data.seasonShards && typeof data.seasonShards === 'object' && !Array.isArray(data.seasonShards))
        ? data.seasonShards
        : {}; // legacy flat-number accounts start clean — see api/lib/xp.js
      recomputeSeasonShards();
      shareCount = Number(data.shareCount || 0);
      unlockedDecorations = Array.isArray(data.unlockedDecorations) ? [...data.unlockedDecorations] : [];
      unlockedFonts = Array.isArray(data.unlockedFonts) ? [...data.unlockedFonts] : [];
      unlockedCardEffects = Array.isArray(data.unlockedCardEffects) ? [...data.unlockedCardEffects] : [];
      equippedDecoration = decorationById(data.equippedDecoration) ? data.equippedDecoration : null;
      equippedFont = fontById(data.equippedFont) ? data.equippedFont : null;
      equippedCardEffect = cardEffectById(data.equippedCardEffect) ? data.equippedCardEffect : null;
      characterDecorations = (data.characterDecorations && typeof data.characterDecorations === 'object') ? { ...data.characterDecorations } : {};
      currentUserVerifiedUntil = data.verifiedUntil || null;
      currentUserXp = Number(data.xp || 0);
      currentUserWeeklyXp = Number(data.weeklyXp || 0);
      verifiedUntilCache[uid] = currentUserVerifiedUntil ? currentUserVerifiedUntil.toMillis() : null;
      updateAccountHeader();
      updateCardEffectDisplay();
    }).catch(err => console.error('Profile load failed', err));
  }

  avatarEditBtn.addEventListener('click', () => avatarFile.click());

  avatarFile.addEventListener('change', () => {
    const file = avatarFile.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('Please choose an image file');
      avatarFile.value = '';
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      showToast('Image must be under 4MB');
      avatarFile.value = '';
      return;
    }
    const originalHTML = accountAvatar.innerHTML;
    accountAvatar.innerHTML = '<span class="btn-spinner avatar-spinner"></span>';
    const reader = new FileReader();
    reader.onload = () => {
      // Instant local preview while the compressed copy (below) is
      // prepared in the background and synced to Firestore.
      avatarDataUrl = reader.result;
      renderAvatar();
      avatarFile.value = '';
      compressImageToDataUrl(file)
        .then(compressed => {
          avatarDataUrl = compressed;
          renderAvatar();
          persistProfile();
          showToast(auth.currentUser ? 'Profile picture updated' : 'Profile picture updated (sign in to sync it everywhere)');
        })
        .catch(err => {
          console.error('Avatar compression failed', err);
          persistProfile(); // keeps the uncompressed preview at least local-only
          showToast('Saved here, but sync to other browsers failed');
        });
    };
    reader.onerror = () => {
      accountAvatar.innerHTML = originalHTML;
      showToast('Could not read that image');
    };
    reader.readAsDataURL(file);
  });

  removeAvatarBtn.addEventListener('click', () => {
    avatarDataUrl = '';
    renderAvatar();
    persistProfile();
    showToast('Profile picture removed');
  });

  const accountBanner = document.getElementById('accountBanner');
  const coverEditBtn = document.getElementById('coverEditBtn');
  const coverFile = document.getElementById('coverFile');
  function renderCoverPhoto(){
    // Inline style always wins over the .account-banner CSS rule (default
    // collage art, or a season reskin's background-image) — a user's own
    // cover photo takes priority over both, same treatment as avatarUrl
    // already gets versus season/theme art elsewhere.
    accountBanner.style.backgroundImage = coverPhotoDataUrl
      ? `linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 45%, var(--surface-veil) 100%), url('${coverPhotoDataUrl}')`
      : '';
  }

  coverEditBtn.addEventListener('click', () => coverFile.click());

  coverFile.addEventListener('change', () => {
    const file = coverFile.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('Please choose an image file');
      coverFile.value = '';
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      showToast('Image must be under 4MB');
      coverFile.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      // Instant local preview while the compressed copy (below) is
      // prepared in the background and synced to Firestore.
      coverPhotoDataUrl = reader.result;
      renderCoverPhoto();
      coverFile.value = '';
      // Wider aspect ratio than the avatar, so a larger max dimension —
      // still well under Firestore's 1MB document limit at this quality.
      compressImageToDataUrl(file, 640, 0.7)
        .then(compressed => {
          coverPhotoDataUrl = compressed;
          renderCoverPhoto();
          persistProfile();
          showToast(auth.currentUser ? 'Cover photo updated' : 'Cover photo updated (sign in to sync it everywhere)');
        })
        .catch(err => {
          console.error('Cover photo compression failed', err);
          persistProfile(); // keeps the uncompressed preview at least local-only
          showToast('Saved here, but sync to other browsers failed');
        });
    };
    reader.onerror = () => showToast('Could not read that image');
    reader.readAsDataURL(file);
  });

  try {
    const savedProfile = JSON.parse(localStorage.getItem('fictionClashProfile') || 'null');
    if (savedProfile) {
      profileName.value = savedProfile.name || '';
      profileHandle.value = savedProfile.handle || '';
      profileBio.value = savedProfile.bio || '';
      avatarDataUrl = savedProfile.avatar || '';
      coverPhotoDataUrl = savedProfile.cover || '';
      renderCoverPhoto();
      updateAccountHeader();
    }
  } catch (error) {}

  // ---------- firebase auth ----------
  const accountPassword = document.getElementById('accountPassword');
  const signedOutView = document.getElementById('signedOutView');
  const signedInView = document.getElementById('signedInView');
  const signedInEmail = document.getElementById('signedInEmail');
  const signOutBtn = document.getElementById('signOutBtn');

  function authErrorMessage(error){
    switch (error.code) {
      case 'auth/invalid-email': return 'That email address looks invalid';
      case 'auth/missing-password':
      case 'auth/weak-password': return 'Password must be at least 6 characters';
      case 'auth/email-already-in-use': return 'That email is already in use — check your password';
      case 'auth/wrong-password':
      case 'auth/invalid-credential': return 'Incorrect email or password';
      case 'auth/popup-closed-by-user': return 'Sign-in popup closed';
      case 'auth/popup-blocked': return 'Pop-up blocked — check your browser\'s pop-up settings';
      case 'auth/unauthorized-domain': return 'This domain isn\'t authorized for Google sign-in yet';
      case 'auth/cancelled-popup-request': return 'Sign-in already in progress';
      default: return 'Something went wrong — please try again';
    }
  }

  // Immediate (non-delayed) button loading helper — used for popup-based sign-in
  // so the call to signInWithPopup happens synchronously inside the click handler.
  // Wrapping it in a setTimeout (like withSpinner does) breaks the "user gesture"
  // requirement and causes browsers to silently block the Google popup.
  function beginLoading(btn, loadingLabel){
    if (btn.disabled) return null;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span><span>${loadingLabel}</span>`;
    return () => { btn.innerHTML = original; btn.disabled = false; };
  }

  function googleSignIn(btn, onSuccess){
    const endLoading = beginLoading(btn, 'CONNECTING…');
    if (!endLoading) return;
    signInWithPopup(auth, googleProvider)
      .then(() => { endLoading(); onSuccess(); })
      .catch((error) => {
        // If the popup itself couldn't open (blocked, or unsupported in this
        // environment, e.g. an embedded/sandboxed webview), fall back to a
        // full-page redirect flow instead of failing silently.
        if (error.code === 'auth/popup-blocked' || error.code === 'auth/operation-not-supported-in-this-environment') {
          signInWithRedirect(auth, googleProvider).catch((redirectError) => {
            endLoading();
            showToast(authErrorMessage(redirectError));
          });
          return;
        }
        endLoading();
        showToast(authErrorMessage(error));
      });
  }

  // Handle the case where signInWithPopup fell back to signInWithRedirect —
  // the result comes back here after the page reloads.
  getRedirectResult(auth).then((result) => {
    if (result && result.user) showToast('Signed in with Google');
  }).catch((error) => showToast(authErrorMessage(error)));

  async function emailSignInOrSignUp(email, password){
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential') {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        throw error;
      }
    }
  }

  // Tracks which account's data is currently on screen, so switching to a
  // *different* signed-in account doesn't leave the previous account's
  // name/handle/bio/picture visible until the cloud profile finishes loading.
  let lastSignedInUid = null;

  onAuthStateChanged(auth, (user) => {
    hideAppLoadingScreen();
    if (user) {
      // Signed in via ANY route (header button, a previous session being
      // restored, this overlay's own buttons, whatever) — the first-visit
      // intro has no reason to exist for a signed-in person, so dismiss it
      // and mark it seen the same as if they'd closed it themselves. This
      // is what actually fixes it reappearing for someone who signed in
      // through the header instead of through this specific overlay.
      if (typeof dismissIntro === 'function') dismissIntro();
      signedOutView.hidden = true;
      signedInView.hidden = false;
      signedInEmail.textContent = user.email || user.displayName || 'Signed in';
      if (lastSignedInUid !== user.uid) {
        // New account this session — start from this account's own
        // defaults rather than whatever the previous account/guest left on screen.
        profileName.value = user.displayName || (user.email ? user.email.split('@')[0] : '');
        profileHandle.value = user.email ? `@${user.email.split('@')[0]}` : '';
        profileBio.value = '';
        avatarDataUrl = user.photoURL || '';
        coverPhotoDataUrl = '';
         clashPoints = 0;
         seasonShardsRaw = {};
         seasonShards = 0;
         shareCount = 0;
         unlockedDecorations = [];
         unlockedFonts = [];
         unlockedCardEffects = [];
         equippedDecoration = null;
         equippedFont = null;
         equippedCardEffect = null;
         characterDecorations = {};
         // This account's own vote history — see loadScopedVoteState()
         // for why this can't just stay whatever the previous account
         // (or guest) had loaded.
         loadScopedVoteState();
         renderHero(); // picks up this account's voted/not-voted state on the current matchup
      }
      lastSignedInUid = user.uid;
      renderMemberSince(user);
      updateAccountHeader();
      loadCloudProfile(user.uid); // overwrites the above with synced data, if any exists
      renderAllLikeButtons(); // this account's like state may differ from the previous one's
      getDocs(collection(db, 'characterAvatars')).then(renderAdminReports).catch(() => {}); // admin card may now apply
      refreshModerationListeners(); // admin's pending queues, if this is the admin account
      renderSeasonAdminControls(); // season toggle card, if this is the admin account
      refreshAiFeatsCreditsDisplay(); // was showing "sign in to use" — now show this account's real count
      refreshAiStatsCreditsDisplay(); // same, for the hero "CHECK STATS" daily limit
      wireUserNotifications(user.uid); // start listening for reply notifications addressed to this account
      handlePaymentReturn(); // no-op unless the URL has a Paystack reference (see definition below)
    } else {
      lastSignedInUid = null;
      renderMemberSince(null);
      signedOutView.hidden = false;
      signedInView.hidden = true;
      signedInEmail.textContent = '';
      // Clear the previous account's profile out of memory — otherwise it
      // lingers in these fields (even though the signed-in card is hidden)
      // until a new account's data happens to overwrite it.
      profileName.value = '';
      profileHandle.value = '';
      profileBio.value = '';
      avatarDataUrl = '';
      coverPhotoDataUrl = '';
       clashPoints = 0;
       seasonShardsRaw = {};
       seasonShards = 0;
       shareCount = 0;
       unlockedDecorations = [];
       unlockedFonts = [];
       unlockedCardEffects = [];
       equippedDecoration = null;
       equippedFont = null;
       equippedCardEffect = null;
       characterDecorations = {};
      currentUserVerifiedUntil = null;
      currentUserXp = 0;
      currentUserWeeklyXp = 0;
      loadScopedVoteState(); // back to the guest/"anon" scope — voteStorageUid() now has no signed-in uid to key off
      renderHero();
      updateAccountHeader();
      updateCardEffectDisplay();
      syncTopbarAvatar();
      closeAccountDropdown();
      renderAllLikeButtons(); // signed out — nothing should show as "liked" now
      refreshAiFeatsCreditsDisplay(); // back to "sign in to use AI feat checks"
      refreshAiStatsCreditsDisplay(); // back to "sign in to use AI stats"
      unwireUserNotifications(); // stop listening — no account to receive reply notifications for
      refreshModerationListeners(); // detaches the admin queue listeners (isAdmin() is now false)
      updateSeasonCardVisibility(); // hides the season toggle card (isAdmin() is now false)
    }
  });

  signOutBtn.addEventListener('click', () => {
    signOut(auth).then(() => showToast('Signed out'));
  });

  const googleSignInBtn = document.getElementById('googleSignIn');
  googleSignInBtn.addEventListener('click', () => {
    googleSignIn(googleSignInBtn, () => showToast('Signed in with Google'));
  });
  const emailSignInBtn = document.getElementById('emailSignIn');
  emailSignInBtn.addEventListener('click', () => {
    const email = accountEmail.value.trim();
    const password = accountPassword.value;
    if (!email || !email.includes('@')) {
      accountEmail.style.borderColor = '#c0392b';
      showToast('Enter a valid email');
      return;
    }
    if (!password || password.length < 6) {
      accountPassword.style.borderColor = '#c0392b';
      showToast('Password must be at least 6 characters');
      return;
    }
    withSpinner(emailSignInBtn, 'SIGNING IN…', () => {
      emailSignInOrSignUp(email, password)
        .then(() => {
          accountEmail.style.borderColor = '';
          accountPassword.style.borderColor = '';
          accountPassword.value = '';
          showToast('Signed in with email');
        })
        .catch((error) => showToast(authErrorMessage(error)));
    });
  });
  document.getElementById('saveProfile').addEventListener('click', () => {
    // persistProfile() writes to localStorage AND, when signed in, syncs
    // name/handle/bio/avatar to Firestore under this account's uid so it
    // shows up the same way on any other browser signed into that account.
    persistProfile();
    updateAccountHeader();
    showToast(auth.currentUser ? 'Profile saved and synced' : 'Profile saved (sign in to sync it everywhere)');
  });

  // Auto-save on blur (tapping away from a field) as a safety net — so
  // forgetting to tap "SAVE PROFILE" after editing name/handle/bio can't
  // silently lose changes. No toast here, to avoid spamming one on every
  // single field tap; the explicit Save button still shows a toast.
  [profileName, profileHandle, profileBio].forEach(field => {
    field.addEventListener('blur', () => {
      persistProfile();
      updateAccountHeader();
    });
  });

  // ---------- bottom nav ----------
  // The topbar icon + wordmark are the actual brand mark, so they're
  // reserved for the Matchups home page only — every other section swaps
  // in that section's own nav icon (same ones already used in the bottom
  // nav, so it stays visually consistent) and its name instead, the way
  // most apps only show the full brand lockup on the home tab.
  const topbarIconWrap = document.querySelector('.logo-badge');
  const topbarWordmark = document.querySelector('.wordmark span');
  const BRAND_ICON_SVG = topbarIconWrap.innerHTML;
  const BRAND_WORDMARK_HTML = topbarWordmark.innerHTML;
  const SECTION_HEADERS = {
    Movies: {
      icon: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
      wordmark: '<b>Movies Hub</b><small class="brand-small">SCENES &amp; BREAKDOWNS</small>'
    },
    News: {
      icon: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h13a3 3 0 013 3v13H7a3 3 0 01-3-3V4z"/><path d="M4 4v13a3 3 0 003 3"/><path d="M9 8h7M9 12h7M9 16h4"/></svg>',
      wordmark: '<b>News</b><small class="brand-small">LATEST DROPS</small>'
    },
    Team: {
      icon: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5l8-3z"/></svg>',
      wordmark: '<b>Team Builder</b><small class="brand-small">BUILD YOUR ROSTER</small>'
    },
    Account: {
      icon: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
      wordmark: '<b>Account</b><small class="brand-small">YOUR PROFILE</small>'
    }
  };
  function applyTopbarForSection(section){
    const cfg = SECTION_HEADERS[section];
    topbarIconWrap.innerHTML = cfg ? cfg.icon : BRAND_ICON_SVG;
    topbarWordmark.innerHTML = cfg ? cfg.wordmark : BRAND_WORDMARK_HTML;
  }
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      const section = item.dataset.nav;
      applyTopbarForSection(section);
      const matchupSections = document.querySelectorAll('.quick-actions, .hero, .section-head, .trend-scroll');
      const isMovies = section === 'Movies';
      const isNews = section === 'News';
      const isTeam = section === 'Team';
      const isAccount = section === 'Account';
      matchupSections.forEach(element => element.style.display = (isMovies || isNews || isTeam || isAccount) ? 'none' : '');
      moviesSection.classList.toggle('hidden', !isMovies);
      newsSection.classList.toggle('hidden', !isNews);
      teamSection.classList.toggle('hidden', !isTeam);
      accountSection.classList.toggle('hidden', !isAccount);
      document.querySelector('.phone-scroll').scrollTo({ top: 0, behavior: 'instant' });
      if (section !== 'Matchups' && !isMovies && !isNews && !isTeam && !isAccount) showToast(`${section} — coming soon`);
    });
  });

  // ---------- sign-in modal ----------
  const signinOverlay = document.getElementById('signinOverlay');
  const signinCancel = document.getElementById('signinCancel');
  const signinSubmit = document.getElementById('signinSubmit');
  const signinEmail = document.getElementById('signinEmail');
  const signinPassword = document.getElementById('signinPassword');

  // ---------- first-visit intro ----------
  // Shown once, ever, per browser — never blocks browsing (someone landing
  // on a shared matchup link from TikTok/Reddit/Discord should see the
  // matchup immediately, not a wall). Closing it any way (X, "Continue
  // browsing", or actually signing in) all count as having seen it.
  const INTRO_SEEN_KEY = 'fictionClashIntroSeen';
  const introOverlay = document.getElementById('introOverlay');
  const introCloseBtn = document.getElementById('introCloseBtn');
  const introContinueBtn = document.getElementById('introContinueBtn');
  const introGoogleSignIn = document.getElementById('introGoogleSignIn');
  const introEmail = document.getElementById('introEmail');
  const introPassword = document.getElementById('introPassword');
  const introEmailSubmit = document.getElementById('introEmailSubmit');
  function dismissIntro(){
    introOverlay.classList.remove('show');
    if (nonEssentialStorageAllowed()) localStorage.setItem(INTRO_SEEN_KEY, '1');
  }
  if (!localStorage.getItem(INTRO_SEEN_KEY) && !auth.currentUser) {
    // The !auth.currentUser check covers the (uncommon but possible) case
    // where Firebase has already restored a session synchronously by this
    // point. The far more common case — session restored a moment later,
    // asynchronously — is handled in onAuthStateChanged above, which calls
    // dismissIntro() the instant a user is found; that's what actually
    // stops this from reappearing for someone who signed in through the
    // header button (or a previous visit) rather than through this
    // overlay's own Google/email buttons, since INTRO_SEEN_KEY was never
    // getting set for them before.
    introOverlay.classList.add('show');
  }
  introContinueBtn.addEventListener('click', dismissIntro);
  introCloseBtn.addEventListener('click', dismissIntro);
  introGoogleSignIn.addEventListener('click', () => {
    googleSignIn(introGoogleSignIn, () => {
      dismissIntro();
      showToast('Signed in with Google');
    });
  });
  introEmailSubmit.addEventListener('click', () => {
    const email = introEmail.value.trim();
    const password = introPassword.value;
    if (!email || !email.includes('@')) {
      introEmail.style.borderColor = '#c0392b';
      return;
    }
    if (!password || password.length < 6) {
      introPassword.style.borderColor = '#c0392b';
      showToast('Password must be at least 6 characters');
      return;
    }
    withSpinner(introEmailSubmit, 'CONTINUE', () => {
      emailSignInOrSignUp(email, password)
        .then(() => {
          dismissIntro();
          showToast('Signed in — welcome!');
          introEmail.value = '';
          introPassword.value = '';
          introEmail.style.borderColor = '';
          introPassword.style.borderColor = '';
        })
        .catch((error) => showToast(authErrorMessage(error)));
    }, 700);
  });

  // ---------- topbar account menu ----------
  const accountMenuWrap = document.getElementById('accountMenuWrap');
  const accountDropdown = document.getElementById('accountDropdown');
  const dropdownAccountBtn = document.getElementById('dropdownAccountBtn');
  const dropdownSignOutBtn = document.getElementById('dropdownSignOutBtn');

  function closeAccountDropdown(){ accountDropdown.hidden = true; }
  function toggleAccountDropdown(){ accountDropdown.hidden = !accountDropdown.hidden; }

  signinBtn.addEventListener('click', (e) => {
    if (auth.currentUser) {
      e.stopPropagation();
      toggleAccountDropdown();
    } else {
      signinOverlay.classList.add('show');
    }
  });
  document.addEventListener('click', (e) => {
    if (!accountDropdown.hidden && !accountMenuWrap.contains(e.target)) closeAccountDropdown();
  });
  dropdownAccountBtn.addEventListener('click', () => {
    closeAccountDropdown();
    const accountNavItem = document.querySelector('.nav-item[data-nav="Account"]');
    if (accountNavItem) accountNavItem.click();
  });
  dropdownSignOutBtn.addEventListener('click', () => {
    closeAccountDropdown();
    signOut(auth).then(() => showToast('Signed out'));
  });

  // ---------- notifications ----------
  // Lightweight, locally-persisted feed of "new matchup" / "new clip"
  // events. Firestore's onSnapshot replays every existing document as an
  // 'added' change the first time it connects, so each listener below
  // only starts actually creating notifications once its own first sync
  // has finished — otherwise opening the app for the first time would
  // dump a notification for every matchup and clip that already existed.
  const NOTIFS_KEY = 'fictionClashNotifications';
  const NOTIFS_SEEN_KEY = 'fictionClashNotificationsSeenAt';
  let notifications = JSON.parse(localStorage.getItem(NOTIFS_KEY) || '[]');
  const notifBtn = document.getElementById('notifBtn');
  const notifMenuWrap = document.getElementById('notifMenuWrap');
  const notifDropdown = document.getElementById('notifDropdown');
  const notifBadge = document.getElementById('notifBadge');
  const notifList = document.getElementById('notifList');

  function saveNotifications(){
    notifications = notifications.slice(0, 30); // cap so localStorage doesn't grow forever
    // Same reasoning as the theme/seen-state fixes above — this is the
    // notification list itself, not a tracker.
    try { localStorage.setItem(NOTIFS_KEY, JSON.stringify(notifications)); } catch (err) {}
  }

  function notifTimeAgo(ts){
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  // Same stroke-based icon used in the bottom nav for each section, so a
  // notification visually matches where tapping it will take you.
  const NOTIF_TYPE_ICON = {
    matchup: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20L20 4"/><path d="M2 18L6 22"/><path d="M20 20L4 4"/><path d="M18 22L22 18"/></svg>',
    clip: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    reply: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>'
  };

  function renderNotifications(){
    const lastSeen = Number(localStorage.getItem(NOTIFS_SEEN_KEY) || 0);
    // Local (device-wide "new matchup"/"new clip") and server-delivered
    // (this account's own replies) are two different sources with two
    // different lifetimes — merged here just for display, sorted newest
    // first, so the bell shows one unified feed.
    const combined = [...notifications, ...serverNotifications].sort((a, b) => b.at - a.at);
    const unreadCount = combined.filter(n => n.at > lastSeen).length;
    notifBadge.hidden = unreadCount === 0;
    notifBadge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
    if (!combined.length) {
      notifList.innerHTML = '<div class="notif-empty">You\'re all caught up</div>';
      return;
    }
    notifList.innerHTML = combined.map(n => `
      <button type="button" class="notif-item ${n.at <= lastSeen ? 'read' : ''}" data-notif-type="${n.type}" data-notif-subtype="${n.subtype || ''}" data-notif-target="${escapeHtml(n.target || '')}" data-notif-comment-id="${escapeHtml(n.commentId || '')}">
        <span class="notif-item-icon">${NOTIF_TYPE_ICON[n.type] || ''}<span class="notif-item-dot"></span></span>
        <span class="notif-item-body"><b>${escapeHtml(n.title)}</b><span>${escapeHtml(n.body)}</span><br><span class="notif-item-time">${notifTimeAgo(n.at)}</span></span>
      </button>`).join('');
  }

  // ---------- reply notifications (server-delivered, per account) ----------
  // Everything above (`notifications`/pushNotification) is a local,
  // per-device feed anyone gets for "new matchup"/"new clip" — it has no
  // way to reach a specific OTHER person. A reply is different: it needs
  // to reach the person being replied to specifically, on any device
  // they're signed into, which only a server-authoritative delivery can
  // do. /api/comment and /api/clip-comment (Admin SDK) write one doc per
  // reply into the replied-to user's own users/{uid}/notifications
  // subcollection (read: owner only, write: server-only — see
  // firestore.rules). This listener is what turns those into entries in
  // the same bell/dropdown, live, without needing a page reload.
  let serverNotifications = [];
  let unwireUserNotifications = () => {};
  function wireUserNotifications(uid){
    unwireUserNotifications(); // drop any previous account's listener first
    const unsubscribe = onSnapshot(
      query(collection(db, 'users', uid, 'notifications'), orderBy('createdAt', 'desc'), limit(30)),
      snapshot => {
        serverNotifications = snapshot.docs.map(d => {
          const data = d.data();
          const target = data.matchupId || data.clipId || '';
          return {
            id: d.id,
            type: 'reply',
            subtype: data.matchupId ? 'matchup' : 'clip',
            title: `${data.fromName || 'Someone'} replied to you`,
            body: data.text || '',
            target,
            // The specific reply comment's own Firestore doc id, so the
            // click handler below can scroll straight to it instead of
            // just opening the matchup/clip it lives on. Requires the
            // backend (/api/comment, /api/clip-comment) to include this
            // field when it writes the notification doc — falls back to
            // '' (whole-thread navigation only) for any older docs, or
            // if that backend field is ever missing.
            commentId: data.commentId || '',
            at: data.createdAt?.toMillis?.() || Date.now(),
          };
        });
        renderNotifications();
      },
      err => console.error('Reply notifications listener failed', err)
    );
    unwireUserNotifications = () => { unsubscribe(); serverNotifications = []; unwireUserNotifications = () => {}; };
  }

  // ---------- real device push, via OneSignal ----------
  // Goes through /api/send-push (a Vercel serverless function) instead of
  // calling OneSignal's REST API directly — that keeps the REST API key
  // server-side only, never exposed in this page's source.
  //
  // Only ever called from the code that actually CREATES a matchup/clip
  // (the poster's own browser, once), not from the onSnapshot listener
  // that watches for new ones — that listener fires in every connected
  // visitor's browser, so calling a real push send from inside it would
  // mean N people with the app open = N duplicate pushes blasted to
  // every subscriber. pushNotification() below (the in-app bell/dropdown
  // list) is fine to run per-viewer since that only updates their own
  // local list — it's the real device push that has to stay singular.
  function sendOneSignalPush(title, body){
    fetch('/api/send-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body })
    })
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          console.error('Push send rejected:', res.status, data);
          alert('Push send failed (' + res.status + '): ' + JSON.stringify(data));
          return;
        }
        console.log('Push send result:', data);
        if (data.skipped) {
          alert('Push skipped: ' + data.reason);
        } else {
          alert('Push response:\n' + JSON.stringify(data.raw || data, null, 2));
        }
      })
      .catch(err => {
        console.error('Push send failed', err);
        alert('Push send network error: ' + err.message);
      });
  }

  function pushNotification(type, title, body, target){
    notifications.unshift({ type, title, body, target: target || '', at: Date.now() });
    saveNotifications();
    renderNotifications();
  }

  const enablePushBtn = document.getElementById('enablePushBtn');
  const pushStatusText = document.getElementById('pushStatusText');
  // Reflects an already-opted-in state in the UI. Called right after a
  // successful opt-in, and also at load time below — otherwise a reload
  // shows "ENABLE NOTIFICATIONS" again for someone who already turned it on.
  function showPushOptedInUI(){
    pushStatusText.textContent = "You're set — you'll get notified on this device.";
    enablePushBtn.textContent = 'NOTIFICATIONS ON';
    enablePushBtn.disabled = true;
  }
  enablePushBtn.addEventListener('click', async () => {
    if (typeof OneSignal === 'undefined') {
      showToast('Notifications are still loading — try again in a moment');
      return;
    }
    try {
      await OneSignal.User.PushSubscription.optIn();
      if (OneSignal.User.PushSubscription.optedIn) {
        showPushOptedInUI();
      } else {
        showToast('Notifications permission was not granted');
      }
    } catch (err) {
      console.error('Push opt-in failed', err);
      showToast('Could not enable notifications — check browser permissions');
    }
  });
  // Load-time sync: this is a module script, so it can't reach into the
  // classic <script> that calls OneSignal.init() up in <head> to ask it
  // directly. Instead it pushes its own callback onto the same
  // OneSignalDeferred queue — that queue is exactly what lets any number of
  // scripts register work to run once the SDK's ready, in whatever order
  // they happen to load in.
  window.OneSignalDeferred = window.OneSignalDeferred || [];
  window.OneSignalDeferred.push(function(OneSignal) {
    if (OneSignal.User.PushSubscription.optedIn) showPushOptedInUI();
    // Covers permission being granted/revoked from the browser's own site
    // settings UI, outside of a click on our button.
    OneSignal.User.PushSubscription.addEventListener('change', event => {
      if (event.current.optedIn) showPushOptedInUI();
    });
  });

  function closeNotifDropdown(){ notifDropdown.hidden = true; }
  function toggleNotifDropdown(){
    notifDropdown.hidden = !notifDropdown.hidden;
    if (!notifDropdown.hidden) {
      // Give them a beat to see which ones were unread before the dots clear.
      setTimeout(() => {
        // Same reasoning as the theme fixes above — "have you seen this
        // notification" is local UI state, not tracking, so it's written
        // unconditionally. Gating it behind cookie consent meant anyone
        // who hadn't explicitly accepted the banner had this write
        // silently dropped every time, so the badge/unread dots came
        // right back on the next load even though they'd already opened
        // the dropdown and seen everything in it.
        try { localStorage.setItem(NOTIFS_SEEN_KEY, String(Date.now())); } catch (err) {}
        renderNotifications();
      }, 1200);
    }
  }
  notifBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleNotifDropdown();
  });
  document.addEventListener('click', (e) => {
    if (!notifDropdown.hidden && !notifMenuWrap.contains(e.target)) closeNotifDropdown();
  });
  notifList.addEventListener('click', (e) => {
    const item = e.target.closest('.notif-item');
    if (!item) return;
    closeNotifDropdown();
    const type = item.dataset.notifType;
    const commentId = item.dataset.notifCommentId || '';
    // A reply notification points at either a matchup or a clip — its
    // subtype tells us which of the two existing nav flows below to
    // reuse, so replies don't need their own third navigation branch.
    const asClip = type === 'clip' || (type === 'reply' && item.dataset.notifSubtype === 'clip');
    const asMatchup = type === 'matchup' || (type === 'reply' && item.dataset.notifSubtype === 'matchup');
    if (asClip) {
      document.querySelector('.nav-item[data-nav="Movies"]')?.click();
      setTimeout(() => {
        clipFeed.querySelector(`.clip-card[data-clip-id="${item.dataset.notifTarget}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // For a reply, don't stop at the clip itself — open its comments
        // sheet straight to the reply that was posted. The thread may not
        // be wired yet if this clip hasn't scrolled into view before (lazy
        // wiring), hence the extra wait and the lookup-may-miss fallback.
        if (type === 'reply') {
          setTimeout(() => {
            const thread = clipCommentThreads.get(item.dataset.notifTarget);
            if (thread) {
              openCommentsModal(thread);
              switchCommentsTab('replies');
              highlightModalComment(commentId);
            }
          }, 450);
        }
      }, 150);
    } else if (asMatchup) {
      document.querySelector('.nav-item[data-nav="Matchups"]')?.click();
      // Jump straight to the matchup this notification is about, not just
      // whichever card happened to already be active.
      const targetIdx = matchups.findIndex(m => m.docId === item.dataset.notifTarget);
      if (targetIdx !== -1) {
        activeIdx = targetIdx;
        renderHero(); // also re-wires heroCommentsThread onto this matchup
        renderTrendScroll();
      }
      // Same idea as the clip branch above — land on the actual reply,
      // not just the matchup it's attached to.
      if (type === 'reply') {
        setTimeout(() => {
          openCommentsModal(heroCommentsThread);
          switchCommentsTab('replies');
          highlightModalComment(commentId);
        }, 250);
      }
    }
  });
  renderNotifications();

  signinCancel.addEventListener('click', () => signinOverlay.classList.remove('show'));
  signinOverlay.addEventListener('click', (e) => {
    if (e.target === signinOverlay) signinOverlay.classList.remove('show');
  });
  const modalGoogleSignIn = document.getElementById('modalGoogleSignIn');
  modalGoogleSignIn.addEventListener('click', () => {
    googleSignIn(modalGoogleSignIn, () => {
      signinOverlay.classList.remove('show');
      showToast('Signed in with Google');
    });
  });
  signinSubmit.addEventListener('click', () => {
    const email = signinEmail.value.trim();
    const password = signinPassword.value;
    if (!email || !email.includes('@')) {
      signinEmail.style.borderColor = '#c0392b';
      return;
    }
    if (!password || password.length < 6) {
      signinPassword.style.borderColor = '#c0392b';
      showToast('Password must be at least 6 characters');
      return;
    }
    withSpinner(signinSubmit, 'CONTINUE', () => {
      emailSignInOrSignUp(email, password)
        .then(() => {
          signinOverlay.classList.remove('show');
          showToast('Signed in — welcome!');
          signinEmail.value = '';
          signinPassword.value = '';
          signinEmail.style.borderColor = '';
          signinPassword.style.borderColor = '';
        })
        .catch((error) => showToast(authErrorMessage(error)));
    }, 700);
  });

  renderHero();
