import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface LaunchOpts {
  /** Where each slice starts — the plantain's cut end. Measured lazily at spawn. */
  from: () => DOMRect | null;
  /** The target chip for slice `index` — measured at leg-B start so it reflects the real,
   * post-layout tray slot (FLIP-style), robust to wrapping/scroll. Includes the chip's own
   * computed font-size so the slice's letter can match it exactly (rather than a guessed ratio
   * of the chip's box, which drifted from the real CSS font-size and made the letter visibly
   * shrink/grow the instant the slice handed off to the actual tile chip). */
  to: (index: number) => { rect: DOMRect; fontSize: string } | null;
  /** How many slices to fly (1 for a Peel draw, 3 for a Dump). */
  count: number;
  /** The letter each slice carries, shown on its face throughout the roll — so the slice already
   * reads as "becoming" that tile rather than a generic flourish that later reveals a letter. */
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
const LEG_A_MS = 650; // roll right, off-screen
const LEG_B_MS = 850; // re-enter from the right, roll left into the tray
const MAX_ACTIVE = 4; // cap concurrent flights so a burst of peels can't flood the compositor
// Leg A reads as a small plantain slice rolling by, distinctly smaller than the tile it's about
// to become — the size (and look, and letter) only change once it's off-screen for leg B.
const SMALL_SIZE_RATIO = 0.6;

function prefersReduced(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** A fixed, non-interactive overlay that flies little plantain "slices" from the Bunch meter into
 * the end of the tray each time a tile is drawn. Slices are created imperatively and animated with
 * the Web Animations API (transform/opacity only — GPU-composited), so this never re-renders the
 * game tree. All in-flight animations and timers are cancelled on unmount. */
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

  useEffect(() => {
    const activeAnims = anims.current;
    const activeTimers = timers.current;
    const activeRafs = rafs.current;
    const activeQueue = queue.current;
    return () => {
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

    // Reduced motion or nothing to launch from → skip the flight, reveal now. Being at/over
    // capacity is *not* a skip condition — queue it instead so it still gets a real flight.
    if (prefersReduced() || !fromRect || !layer) {
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

    // The full destination-chip size is known up front (the pending chip already occupies its
    // final tray slot, just hidden), but leg A deliberately renders *smaller* than that — a
    // distinct little plantain slice rolling by, not a preview of the tile. It only grows to the
    // real size (and swaps to the tile's look, and reveals its letter) once it's off-screen
    // between legs, so none of that change is ever visible mid-flight.
    const sizeInfo = opts.to(index);
    const w = sizeInfo?.rect.width ?? FALLBACK_SIZE;
    const h = sizeInfo?.rect.height ?? FALLBACK_SIZE;
    const targetFontSize = sizeInfo?.fontSize ?? `${Math.round(Math.min(w, h) * 0.46)}px`;
    const sw = Math.round(w * SMALL_SIZE_RATIO);
    const sh = Math.round(h * SMALL_SIZE_RATIO);

    const node = document.createElement('div');
    node.className = 'slice-wedge';
    node.style.willChange = 'transform';
    node.style.width = `${sw}px`;
    node.style.height = `${sh}px`;

    // The letter rides in a child element with its own counter-rotation, so it stays upright and
    // readable the whole time the outer disc visually rolls — like a wheel with a level label.
    // Hidden during leg A (it's just a plain slice at that point); revealed alongside the
    // size/look swap before leg B.
    const letter = opts.letters?.[index];
    let letterEl: HTMLDivElement | null = null;
    if (letter) {
      letterEl = document.createElement('div');
      letterEl.className = 'slice-wedge-letter';
      letterEl.style.opacity = '0';
      letterEl.style.fontSize = targetFontSize;
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

    const sx = fromRect.left + fromRect.width / 2 - sw / 2;
    const sy = fromRect.top + fromRect.height / 2 - sh / 2;
    const exitX = window.innerWidth + sw;

    // Leg A — roll right across the top bar and off the right edge (rightward = clockwise).
    const legAEasing = 'cubic-bezier(0.45, 0, 0.9, 0.5)';
    const legA = node.animate(
      [
        { transform: `translate(${sx}px, ${sy}px) rotate(0deg)` },
        { transform: `translate(${exitX}px, ${sy}px) rotate(720deg)` },
      ],
      { duration: LEG_A_MS, easing: legAEasing, fill: 'forwards' },
    );
    anims.current.add(legA);

    legA.finished
      .then(() => {
        anims.current.delete(legA);
        // Re-measure the target position now — after the pending chip has taken its real tray
        // slot — in case of reflow since spawn. Size was already locked in above.
        const toInfo = opts.to(index);
        if (!toInfo) {
          reveal();
          removeNode();
          return;
        }
        const toRect = toInfo.rect;
        const tx = toRect.left + toRect.width / 2 - w / 2;
        const ty = toRect.top + toRect.height / 2 - h / 2;
        const reenterX = window.innerWidth + w;

        // Grow to the real tile size, swap from the plantain-slice look to the tile's look, and
        // reveal the letter — all right here, while the node is still sitting fully off-screen
        // (leg A ended at exitX, past the right edge) until leg B's animation starts moving it, so
        // none of this is ever visible mid-flight. It should already look like — and be the size
        // of — the real tile by the time it re-enters and rolls into the tray.
        node.style.width = `${w}px`;
        node.style.height = `${h}px`;
        node.classList.add('tile-face');
        if (letterEl) letterEl.style.opacity = '1';

        // Leg B — re-enter from the right at tray height, roll left to the slot (leftward = ccw).
        // The off-screen gap between legs hides the rotation reset.
        const legBEasing = 'cubic-bezier(0.22, 1, 0.36, 1)';
        const legB = node.animate(
          [
            { transform: `translate(${reenterX}px, ${ty}px) rotate(0deg)` },
            { transform: `translate(${tx}px, ${ty}px) rotate(-560deg)` },
          ],
          { duration: LEG_B_MS, easing: legBEasing, fill: 'forwards' },
        );
        anims.current.add(legB);
        if (letterEl) {
          const legBLetter = letterEl.animate(
            [{ transform: 'rotate(0deg)' }, { transform: 'rotate(560deg)' }],
            { duration: LEG_B_MS, easing: legBEasing, fill: 'forwards' },
          );
          anims.current.add(legBLetter);
          legB.finished.then(
            () => anims.current.delete(legBLetter),
            () => anims.current.delete(legBLetter),
          );
        }
        legB.finished
          .then(() => {
            anims.current.delete(legB);
            reveal();
            removeNode();
          })
          .catch(() => {
            // Cancelled (e.g. unmount) — just tear down, don't touch React state.
            anims.current.delete(legB);
            removeNode();
          });
      })
      .catch(() => {
        anims.current.delete(legA);
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
