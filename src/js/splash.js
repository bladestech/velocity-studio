// Startup animation. The intro (tile + V settling in) is pure CSS and plays from the first paint; once the
// app has booted, finish() launches the logo's V forward "through the screen": a short pull-back, then an
// exponential fly-through aimed at the gap between the V's strokes, with faint speed trails, while the
// tile drops away behind it and the app eases in. Only transform/opacity are animated (Web Animations),
// so it all runs on the compositor and stays smooth even while the renderer is still busy starting up.

const INTRO_MS = 1250;       // length of the CSS intro (see styles.css)
const HOLD_MS = 550;         // beat with the logo fully formed before it launches
const PULL_MS = 380;         // anticipation: the V draws back slightly
const FLIGHT_MS = 1250;      // the fly-through itself
const TOTAL = PULL_MS + FLIGHT_MS;
const PULL_END = PULL_MS / TOTAL;
const S_PULL = 0.92;         // scale at the bottom of the pull-back
const S_END = 30;            // scale when the V has passed the camera (the gap then fills the window)
const SAMPLES = 48;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp01 =(x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeInOutSine = (t) => 0.5 - Math.cos(Math.PI * t) / 2;

/** V transform/opacity at normalised launch time t (0..1). */
function vState(t) {
  if (t <= PULL_END) {
    const k = easeInOutSine(t / PULL_END);
    const s = 1 + (S_PULL - 1) * k;
    return { transform: `translate(${-1.6 * k}%, ${1.6 * k}%) scale(${s}) rotate(${1.2 * k}deg)`, f: 0 };
  }
  const f = (t - PULL_END) / (1 - PULL_END); // flight progress
  // Scale grows exponentially (constant perceived speed-up in depth); f^2.1 gives a soft take-off.
  const e = f ** 2.1;
  const s = S_PULL * (S_END / S_PULL) ** e;
  const tx = -1.6 * (1 - smooth(0, 0.35, f));
  return { transform: `translate(${tx}%, ${-tx}%) scale(${s}) rotate(${1.2 - 7.2 * e}deg)`, f };
}

function vKeyframes(opacityAt) {
  const kf = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const v = vState(t);
    kf.push({ offset: t, transform: v.transform, opacity: opacityAt(v.f, t) });
  }
  return kf;
}

function freeze(el) {
  // Capture the current CSS-animated look, then drop the CSS animation so a script animation can take over seamlessly.
  const cs = getComputedStyle(el);
  const from = { opacity: cs.opacity, transform: cs.transform === 'none' ? 'none' : cs.transform };
  el.style.animation = 'none';
  el.style.opacity = from.opacity;
  el.style.transform = from.transform;
  return from;
}

let introPromise = null;

/** Resolves once the intro (tile + V settling in) has played. Shared by the launch and the ffmpeg setup screen. */
export function introDone() {
  if (introPromise) return introPromise;
  introPromise = (async () => {
    const root = document.getElementById('splash');
    if (!root) return;
    const imgs = [...root.querySelectorAll('.splash-v')];
    await Promise.all(imgs.map((i) => (i.decode ? i.decode().catch(() => {}) : null)));
    // CSS animations only start ticking once frames are actually produced, so wait for the intro itself
    // (capped, in case the window isn't painting) rather than trusting the clock.
    const intro = ['.splash-tile', '.splash-glow', '.splash-flight']
      .flatMap((sel) => root.querySelector(sel).getAnimations())
      .filter((a) => a.animationName !== 'splash-breathe');
    await Promise.race([Promise.all(intro.map((a) => a.finished.catch(() => {}))), sleep(INTRO_MS * 2)]);
    intro.forEach((a) => { try { a.finish(); } catch { /* already done */ } });
  })();
  return introPromise;
}

let finishing = null;

/** Launch the V and reveal the app. Safe to call more than once. */
export function finish({ instant = false } = {}) {
  if (finishing) return finishing;
  finishing = run(instant).catch(() => cleanup());
  return finishing;
}

function revealApp() {
  document.body.classList.add('splash-revealing');
  document.body.classList.remove('splash-pending');
}

function cleanup() {
  const el = document.getElementById('splash');
  if (el) el.remove();
  document.body.classList.remove('splash-pending');
  setTimeout(() => document.body.classList.remove('splash-revealing'), 1200);
}

async function run(instant) {
  const root = document.getElementById('splash');
  if (!root) { cleanup(); return; }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (instant) { cleanup(); return; }

  await introDone();
  await sleep(HOLD_MS);

  const bg = root.querySelector('.splash-bg');
  if (reduced) {
    revealApp();
    await root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: 'ease-out', fill: 'forwards' }).finished;
    cleanup();
    return;
  }

  const tile = root.querySelector('.splash-tile');
  const glow = root.querySelector('.splash-glow');
  const flight = root.querySelector('.splash-flight');
  const tileFrom = freeze(tile);
  const glowFrom = freeze(glow);
  freeze(flight);

  const anims = [];
  const lead = root.querySelector('.splash-v.lead');
  anims.push(lead.animate(vKeyframes((f) => 1 - smooth(0.62, 0.94, f)), { duration: TOTAL, easing: 'linear', fill: 'forwards' }));
  // Fade the V's own glow out during the pull-back: a blur that scales up 30x with the V would cost GPU time
  // every frame of the flight. (The separate .splash-glow halo carries the light from here on.)
  const glowOff = lead.animate([{ filter: getComputedStyle(lead).filter }, { filter: 'drop-shadow(0 0 0 rgba(51, 197, 232, 0))' }], { duration: PULL_MS, easing: 'ease-in', fill: 'forwards' });
  glowOff.finished.then(() => { lead.style.filter = 'none'; glowOff.cancel(); }, () => {});

  // Speed trails: the same path, a few frames behind and faint — reads as motion blur without a blur filter.
  root.querySelectorAll('.splash-v.ghost').forEach((g, i) => {
    const peak = [0.34, 0.2, 0.11][i % 3];
    const kf = vKeyframes((f) => peak * smooth(0.04, 0.22, f) * (1 - smooth(0.5, 0.86, f)));
    anims.push(g.animate(kf, { duration: TOTAL, delay: 34 * (i + 1), easing: 'linear', fill: 'both' }));
  });

  // The tile sits "behind" the V, so it grows far less (parallax) and falls away as the V leaves it.
  const tStart = PULL_MS - 40;
  anims.push(tile.animate([
    { transform: tileFrom.transform, opacity: tileFrom.opacity },
    { transform: 'scale(0.965)', opacity: 1, offset: 0.25 },
    { transform: 'scale(1.7)', opacity: 0 },
  ], { duration: 980, delay: tStart - 220, easing: 'cubic-bezier(.55,0,.75,.35)', fill: 'forwards' }));
  anims.push(glow.animate([
    { transform: glowFrom.transform, opacity: glowFrom.opacity },
    { transform: 'scale(2.6)', opacity: 0 },
  ], { duration: 1050, delay: tStart, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' }));

  // Backdrop dissolves while the V is mid-flight, so the app appears through and around it.
  const bgDelay = PULL_MS + FLIGHT_MS * 0.34;
  anims.push(bg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FLIGHT_MS * 0.5, delay: bgDelay, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'forwards' }));
  setTimeout(revealApp, bgDelay);

  await Promise.all(anims.map((a) => a.finished.catch(() => {})));
  cleanup();
}
