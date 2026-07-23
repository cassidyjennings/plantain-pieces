import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface LaunchOpts {
  /** Where each slice starts — the plantain's cut end. Measured lazily at spawn. */
  from: () => DOMRect | null;
  /** The target chip for slice `index` — measured at spawn so it reflects the real, post-layout
   * tray slot. Includes the chip's own computed font-size so the flying tile's letter matches it
   * exactly, instead of a guessed ratio of the chip's box that could drift from the real CSS
   * font-size and visibly change size on arrival. */
  to: (index: number) => { rect: DOMRect; fontSize: string } | null;
  /** How many slices to fly (1 for a Peel draw, 3 for a Dump). */
  count: number;
  /** The letter each slice carries, shown on its face throughout the flight — so it already reads
   * as "becoming" that tile rather than a generic flourish that later reveals a letter. */
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
const FLIGHT_MS = 1400; // a single straight flight from the Bunch to the tray slot
const MAX_ACTIVE = 4; // cap concurrent flights so a burst of peels can't flood the compositor

function prefersReduced(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// Frames slower than this read as stutter/skipped-ahead rather than a smooth flight (60fps ≈
// 16.7ms; this allows a generous margin down to ~25fps before treating the device as unable to
// render it smoothly).
const SLOW_FRAME_MS = 40;
const CALIBRATION_FRAMES = 6;

/** Measures real frame delivery via a handful of requestAnimationFrame callbacks and resolves
 * false if delivery is too slow/irregular to render a smooth flight — e.g. hardware acceleration
 * disabled, forcing software compositing. Without this, a device that can't keep up doesn't get a
 * stuttering slow-motion version of the animation; the WAAPI timeline still runs on wall-clock
 * time regardless of how few frames actually paint, so a starved renderer instead skips straight
 * to (or very near) the end state — reading exactly like "the tile arrived before it flew there"
 * and, for a collapsed letter group, its count jumping straight to the new total. */
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

/** A fixed, non-interactive overlay that flies drawn tiles from the Bunch meter into the tray each
 * time one is drawn. Each tile already has its real tile-chip shape/look and letter for the whole
 * flight — a single straight move from the Bunch to its tray slot, not a shape-shifting round
 * "slice" that becomes a tile partway — so there's no discontinuity between how it starts and how
 * it lands. Slices are created imperatively and animated with the Web Animations API
 * (transform/opacity only — GPU-composited), so this never re-renders the game tree. All in-flight
 * animations and timers are cancelled on unmount. */
const SliceFlyLayer = forwardRef<SliceFlyHandle>(function SliceFlyLayer(_props, ref) {
  const layerRef = useRef<HTMLDivElement>(null);
  const anims = useRef<Set<Animation>>(new Set());
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const rafs = useRef<Set<number>>(new Set());
  const activeCount = useRef(0);
  // Slices requested while MAX_ACTIVE is already flying wait here instead of being dropped. A
  // dropped slice reveals its tile with zero animation — which, in fast real play (e.g. several
  // auto-Peels firing in quick succession), is exactly what "the tile appeared before it flew
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

    const toInfo = opts.to(index);
    const w = toInfo?.rect.width ?? FALLBACK_SIZE;
    const h = toInfo?.rect.height ?? FALLBACK_SIZE;
    const fontSize = toInfo?.fontSize ?? `${Math.round(Math.min(w, h) * 0.46)}px`;

    const node = document.createElement('div');
    node.className = 'slice-wedge';
    node.style.willChange = 'transform';
    node.style.width = `${w}px`;
    node.style.height = `${h}px`;

    const letter = opts.letters?.[index];
    if (letter) {
      const letterEl = document.createElement('div');
      letterEl.className = 'slice-wedge-letter';
      letterEl.style.fontSize = fontSize;
      letterEl.textContent = letter;
      node.appendChild(letterEl);
    }

    layer.appendChild(node);
    activeCount.current += 1;

    const removeNode = () => {
      node.remove();
      activeCount.current = Math.max(0, activeCount.current - 1);
      // A slot just freed up — start the next queued slice, if any.
      drainQueue();
    };

    const sx = fromRect.left + fromRect.width / 2 - w / 2;
    const sy = fromRect.top + fromRect.height / 2 - h / 2;
    const tx = toInfo ? toInfo.rect.left + toInfo.rect.width / 2 - w / 2 : sx;
    const ty = toInfo ? toInfo.rect.top + toInfo.rect.height / 2 - h / 2 : sy;

    if (!toInfo) {
      reveal();
      removeNode();
      return;
    }

    const anim = node.animate(
      [
        { transform: `translate(${sx}px, ${sy}px)` },
        { transform: `translate(${tx}px, ${ty}px)` },
      ],
      { duration: FLIGHT_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' },
    );
    anims.current.add(anim);

    anim.finished
      .then(() => {
        anims.current.delete(anim);
        reveal();
        removeNode();
      })
      .catch(() => {
        // Cancelled (e.g. unmount) — just tear down, don't touch React state.
        anims.current.delete(anim);
        removeNode();
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
