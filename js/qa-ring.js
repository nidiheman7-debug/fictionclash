// Overlapping-ring layout for the three quick-action circles (Vote Now /
  // Compare Characters / Clash Leaderboard), swipeable Discord/Instagram-
  // story-style instead of a plain row. Deliberately does NOT rebuild the
  // DOM on rotate (no innerHTML replace) — #qaVote/#qaCompare/#qaLeaderboard
  // stay the exact same elements app.js already attached its own click
  // handlers to; this script only ever toggles which position class each
  // one wears. That's what keeps this decoupled from app.js: it doesn't
  // need to know what those handlers do, only when a tap should reach them.
  (function(){
    const track = document.getElementById('qaTrack');
    if (!track) return;
    const items = [
      document.getElementById('qaVote'),
      document.getElementById('qaCompare'),
      document.getElementById('qaLeaderboard')
    ];
    if (items.some(el => !el)) return;
    const dots = Array.from(document.querySelectorAll('#qaDots .qa-dot'));

    function mod(n, m){ return ((n % m) + m) % m; }
    let centerIndex = 0;

    function render(){
      items.forEach((el, i) => {
        el.classList.remove('qa-pos-left', 'qa-pos-center', 'qa-pos-right');
        if (i === centerIndex) el.classList.add('qa-pos-center');
        else if (i === mod(centerIndex + 1, items.length)) el.classList.add('qa-pos-right');
        else el.classList.add('qa-pos-left');
      });
      dots.forEach((d, i) => d.classList.toggle('active', i === centerIndex));
    }

    function goTo(index){
      centerIndex = mod(index, items.length);
      render();
    }

    // Capture phase, on the track (an ancestor of all three .qa nodes) —
    // this runs BEFORE app.js's own click listeners on the individual
    // elements (which fire in bubble phase, the default), regardless of
    // how those were registered. Tapping a peeking (non-center) item
    // recenters it instead of letting its real action fire; tapping the
    // already-centered item is left completely alone.
    track.addEventListener('click', event => {
      const qa = event.target.closest('.qa');
      if (!qa) return;
      if (!qa.classList.contains('qa-pos-center')) {
        event.preventDefault();
        event.stopPropagation();
        goTo(items.indexOf(qa));
      }
    }, true);

    dots.forEach((dot, i) => {
      dot.addEventListener('click', () => goTo(i));
    });

    // --- swipe / drag handling ---
    let startX = null;
    let dragging = false;
    const threshold = 40;
    track.addEventListener('pointerdown', e => { startX = e.clientX; dragging = true; });
    track.addEventListener('pointerup', e => {
      if (!dragging || startX === null) return;
      const dx = e.clientX - startX;
      if (dx > threshold) goTo(centerIndex - 1);
      else if (dx < -threshold) goTo(centerIndex + 1);
      dragging = false;
      startX = null;
    });
    track.addEventListener('pointerleave', () => { dragging = false; startX = null; });

    track.setAttribute('tabindex', '0');
    track.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft') goTo(centerIndex - 1);
      if (e.key === 'ArrowRight') goTo(centerIndex + 1);
    });

    render();
  })();
