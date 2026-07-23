import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface LaunchOpts {
  /** Where each slice starts — the plantain's cut end. Measured lazily at spawn. */
  from: () => DOMRect | null;
  /** The target chip for slice `index` — measured at leg-B start so it reflects the real,
   * post-layout tray slot (FLIP-style), robust to wrapping/scroll. Includes the chip's own
   * computed font-size so the flying tile's letter matches it exactly, instead of a guessed ratio
   * of the chip's box that could drift from the real CSS font-size and change size on arrival. */
  to: (index: number) => { rect: DOMRect; fontSize: string } | null;
  /** How many slices to fly (1 for a Peel draw, 3 for a Dump). */
  count: number;
  /** The letter each tile carries, shown on its face for the whole tray-bound leg. */
  letters?: string[];
  /** Delay between successive slices (Dump rolls them in one after another). */
  staggerMs?: number;
  /** Called when slice `index` lands (or is skipped) — the caller reveals the real tile then. */
  onLanded?: (index: number) => void;
}

export interface SliceFlyHandle {
  launch(opts: LaunchOpts): void;
}

const FALLBACK_SIZE = 42; // px, used only if the destination chip's real size can't be read yet
const LEG_A_MS = 750; // round plantain slice rolls right, off the screen, up at the Bunch
const LEG_B_MS = 1050; // full tile rolls in from the right, along the tray, to its slot
const MAX_ACTIVE = 4; // cap concurrent flights so a burst of peels can't flood the compositor
// Leg A is a small round plantain slice rolling by up at the Bunch, distinctly smaller than the
// tile it becomes; leg B is the real, full-size tile arriving at the tray. They're separate
// elements (never morphed in place), so no shape/size change is ever visible mid-flight.
const SMALL_SIZE_RATIO = 0.6;

function prefersReduced(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// Frames slower than this read as stutter/skipped-ahead rather than a smooth roll (60fps ≈ 16.7ms;
// this allows a generous margin down to ~25fps before treating the device as unable to render the
// flight smoothly).
const SLOW_FRAME_MS = 40;
const CALIBRATION_FRAMES = 6;

/** Measures real frame delivery via a handful of requestAnimationFrame callbacks and resolves
 * false if delivery is too slow/irregular to render a smooth multi-second flight — e.g. hardware
 * acceleration disabled, forcing software compositing. Without this, a device that can't keep up
 * doesn't get a stuttering slow-motion version of the animation; the WAAPI timeline still runs on
 * wall-clock time regardless of how few frames actually paint, so a starved renderer instead skips
 * straight to (or very near) the end state — reading exactly like "the tile arrived before it
 * rolled there" and, for a collapsed letter group, its count jumping straight to the new total. */
function measureFrameHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || prefersReduced()) {
      resolve(true); // irrelevant here — reduced motion already skips the flight on its own path
      return;
    }
    const deltas: number[] = [];
    let last = performance.now();
    const step = (now: number) => {
      deltas.push(now - last);
      last = now;
      if (deltas.length < CALIBRATION_FRAMES) {
        requestAnimationFrame(step);
      } else {
        const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
        resolve(avg <= SLOW_FRAME_MS);
      }
    };
    requestAnimationFrame(step);
  });
}

/** A fixed, non-interactive overlay that flies tiles from the Bunch meter into the tray each time
 * one is drawn, in two legs:
 *   A) a small round plantain slice rolls rightward across the top bar (at the Bunch) and off the
 *      right edge of the screen, then is discarded;
 *   B) a brand-new, full-size tile — real chip shape, letter already on it — enters from the right
 *      edge down at tray height and rolls left into the cleared slot, then hands off to the real
 *      chip and is removed.
 * The two legs are separate elements, so nothing ever morphs shape/size on screen. Elements are
 * created imperatively and animated with the Web Animations API (transform only — GPU-composited),
 * so this never re-renders the game tree. All in-flight animations and timers are cancelled on
 * unmount. */
const SliceFlyLayer = forwardRef<SliceFlyHandle>(function SliceFlyLayer(_props, ref) {
  const layerRef = useRef<HTMLDivElement>(null);
  const anims = useRef<Set<Animation>>(new Set());
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const rafs = useRef<Set<number>>(new Set());
  const activeCount = useRef(0);
  // Slices requested while MAX_ACTIVE is already flying wait here instead of being dropped. A
  // dropped slice reveals its tile with zero animation — which, in fast real play (e.g. several
  // auto-Peels firing in quick succession), is exactly what "the tile appeared before it rolled
  // in" looks like. Queueing guarantees every draw eventually gets a real flight, just delayed.
  const queue = useRef<Array<{ opts: LaunchOpts; index: number }>>([]);
  // Whether this device renders frames smoothly enough for the flight to look right — null until
  // the calibration in the mount effect below resolves; treated as smooth in the meantime so a
  // draw fired before that resolves isn't blocked on it.
  const frameHealthy = useRef<boolean | null>(null);

  useEffect(() => {
    const activeAnims = anims.current;
    const activeTimers = timers.current;
    const activeRafs = rafs.current;
    const activeQueue = queue.current;
    let cancelled = false;
    measureFrameHealth().then((healthy) => {
      if (!cancelled) frameHealthy.current = healthy;
    });
    return () => {
      cancelled = true;
      activeAnims.forEach((a) => a.cancel());
      activeTimers.forEach((id) => clearTimeout(id));
      activeRafs.forEach((id) => cancelAnimationFrame(id));
      activeAnims.clear();
      activeTimers.clear();
      activeRafs.clear();
      activeQueue.length = 0;
    };
  }, []);

  function scheduleRaf(cb: () => void) {
    const id = requestAnimationFrame(() => {
      rafs.current.delete(id);
      cb();
    });
    rafs.current.add(id);
  }

  function drainQueue() {
    while (activeCount.current < MAX_ACTIVE && queue.current.length > 0) {
      const next = queue.current.shift()!;
      startFlight(next.opts, next.index);
    }
  }

  function runSlice(opts: LaunchOpts, index: number) {
    const reveal = () => opts.onLanded?.(index);
    const fromRect = opts.from();
    const layer = layerRef.current;

    // Reduced motion, a device that can't render frames smoothly enough (frameHealthy === false
    // — see measureFrameHealth), or nothing to launch from → skip the flight, reveal now. Being
    // at/over capacity is *not* a skip condition — queue it instead so it still gets a real flight.
    if (prefersReduced() || frameHealthy.current === false || !fromRect || !layer) {
      reveal();
      return;
    }
    if (activeCount.current >= MAX_ACTIVE) {
      queue.current.push({ opts, index });
      return;
    }
    startFlight(opts, index);
  }

  function startFlight(opts: LaunchOpts, index: number) {
    const reveal = () => opts.onLanded?.(index);
    const fromRect = opts.from()!;
    const layer = layerRef.current!;

    activeCount.current += 1;
    const done = () => {
      activeCount.current = Math.max(0, activeCount.current - 1);
      // A slot just freed up — start the next queued slice, if any.
      drainQueue();
    };

    // Size the leg-A slice off the destination chip so the small→full jump between legs is
    // consistent, but leg A only ever shows the small round slice.
    const initial = opts.to(index);
    const baseW = initial?.rect.width ?? FALLBACK_SIZE;
    const baseH = initial?.rect.height ?? FALLBACK_SIZE;
    const sliceSize = Math.round(Math.min(baseW, baseH) * SMALL_SIZE_RATIO);

    // --- Leg A: round plantain slice rolls right, across the top bar and off the right edge ---
    const slice = document.createElement('div');
    slice.className = 'fly-slice';
    slice.style.willChange = 'transform';
    slice.style.width = `${sliceSize}px`;
    slice.style.height = `${sliceSize}px`;
    layer.appendChild(slice);

    const ax = fromRect.left + fromRect.width / 2 - sliceSize / 2;
    const ay = fromRect.top + fromRect.height / 2 - sliceSize / 2;
    const aExitX = window.innerWidth + sliceSize; // fully off the right edge

    const legA = slice.animate(
      [
        { transform: `translate(${ax}px, ${ay}px) rotate(0deg)` },
        { transform: `translate(${aExitX}px, ${ay}px) rotate(720deg)` }, // rightward = clockwise
      ],
      { duration: LEG_A_MS, easing: 'cubic-bezier(0.45, 0, 0.9, 0.5)', fill: 'forwards' },
    );
    anims.current.add(legA);

    legA.finished
      .then(() => {
        anims.current.delete(legA);
        slice.remove(); // leg-A slice is done and off-screen — discard it entirely

        // Re-measure the target now, after the pending chip has taken its real tray slot.
        const toInfo = opts.to(index);
        if (!toInfo) {
          reveal();
          done();
          return;
        }
        const w = toInfo.rect.width;
        const h = toInfo.rect.height;
        const tx = toInfo.rect.left + toInfo.rect.width / 2 - w / 2;
        const ty = toInfo.rect.top + toInfo.rect.height / 2 - h / 2;
        const bEnterX = window.innerWidth + w; // enters from off the right edge, at tray height

        // --- Leg B: the real, full-size tile (letter already on it) rolls in from the right ---
        const tile = document.createElement('div');
        tile.className = 'fly-tile';
        tile.style.willChange = 'transform';
        tile.style.width = `${w}px`;
        tile.style.height = `${h}px`;

        const letter = opts.letters?.[index];
        let letterEl: HTMLDivElement | null = null;
        if (letter) {
          letterEl = document.createElement('div');
          letterEl.className = 'fly-tile-letter';
          letterEl.style.fontSize = toInfo.fontSize;
          letterEl.textContent = letter;
          tile.appendChild(letterEl);
        }
        layer.appendChild(tile);

        // One full turn so it "rolls" in and lands square/aligned; the letter counter-rotates the
        // same amount to stay upright and readable the whole way.
        const legBEasing = 'cubic-bezier(0.22, 1, 0.36, 1)';
        const legB = tile.animate(
          [
            { transform: `translate(${bEnterX}px, ${ty}px) rotate(0deg)` },
            { transform: `translate(${tx}px, ${ty}px) rotate(-360deg)` }, // leftward = ccw
          ],
          { duration: LEG_B_MS, easing: legBEasing, fill: 'forwards' },
        );
        anims.current.add(legB);
        if (letterEl) {
          const spin = letterEl.animate(
            [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
            { duration: LEG_B_MS, easing: legBEasing, fill: 'forwards' },
          );
          anims.current.add(spin);
          legB.finished.then(
            () => anims.current.delete(spin),
            () => anims.current.delete(spin),
          );
        }

        legB.finished
          .then(() => {
            anims.current.delete(legB);
            // Hand off to the real chip: reveal it now (instantly — the flying tile was already
            // sitting exactly here, so no fade/scale, which would read as a flash). Keep the
            // flying tile in place (fill: forwards) for two frames so React commits + paints the
            // now-visible chip underneath it before we remove it; otherwise there's a one-frame
            // gap (flying tile gone, chip not yet painted) that reads as a flash.
            reveal();
            scheduleRaf(() =>
              scheduleRaf(() => {
                tile.remove();
                done();
              }),
            );
          })
          .catch(() => {
            // Cancelled (e.g. unmount) — just tear down, don't touch React state.
            anims.current.delete(legB);
            tile.remove();
            done();
          });
      })
      .catch(() => {
        anims.current.delete(legA);
        slice.remove();
        done();
      });
  }

  useImperativeHandle(ref, () => ({
    launch(opts: LaunchOpts) {
      const stagger = opts.staggerMs ?? 0;
      for (let i = 0; i < opts.count; i++) {
        const delay = i * stagger;
        const start = () => {
          if (delay > 0) {
            const id = setTimeout(() => {
              timers.current.delete(id);
              runSlice(opts, i);
            }, delay);
            timers.current.add(id);
          } else {
            runSlice(opts, i);
          }
        };
        // Defer every spawn by one frame — the destination chip mounted in the same React commit
        // that triggered this launch, and measuring its size immediately (synchronously, before
        // the browser has settled layout for the newly-inserted node) can read a transient,
        // too-small box. A frame later it's reliably at full size. Staggered slices already get
        // this for free from their setTimeout delay; this covers the un-staggered (first/only) one.
        const rafId = requestAnimationFrame(() => {
          rafs.current.delete(rafId);
          start();
        });
        rafs.current.add(rafId);
      }
    },
  }));

  return <div className="slice-fly-layer" ref={layerRef} aria-hidden="true" />;
});

export default SliceFlyLayer;
