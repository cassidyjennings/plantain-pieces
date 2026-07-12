import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface LaunchOpts {
  /** Where each slice starts — the plantain's cut end. Measured lazily at spawn. */
  from: () => DOMRect | null;
  /** The target chip for slice `index` — measured at leg-B start so it reflects the real,
   * post-layout tray slot (FLIP-style), robust to wrapping/scroll. */
  to: (index: number) => DOMRect | null;
  /** How many slices to fly (1 for a Peel draw, 3 for a Dump). */
  count: number;
  /** Delay between successive slices (Dump rolls them in one after another). */
  staggerMs?: number;
  /** Called when slice `index` lands (or is skipped) — the caller reveals the real tile then. */
  onLanded?: (index: number) => void;
}

export interface SliceFlyHandle {
  launch(opts: LaunchOpts): void;
}

const SLICE = 34; // px, matches .slice-wedge
const LEG_A_MS = 430; // roll right, off-screen
const LEG_B_MS = 560; // re-enter from the right, roll left into the tray
const MAX_ACTIVE = 4; // cap concurrent flights so a burst of peels can't flood the compositor

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
  const activeCount = useRef(0);

  useEffect(() => {
    const activeAnims = anims.current;
    const activeTimers = timers.current;
    return () => {
      activeAnims.forEach((a) => a.cancel());
      activeTimers.forEach((id) => clearTimeout(id));
      activeAnims.clear();
      activeTimers.clear();
    };
  }, []);

  function runSlice(opts: LaunchOpts, index: number) {
    const reveal = () => opts.onLanded?.(index);
    const fromRect = opts.from();
    const layer = layerRef.current;

    // Reduced motion, over capacity, or nothing to launch from → skip the flight, reveal now.
    if (prefersReduced() || activeCount.current >= MAX_ACTIVE || !fromRect || !layer) {
      reveal();
      return;
    }

    const node = document.createElement('div');
    node.className = 'slice-wedge';
    node.style.willChange = 'transform';
    layer.appendChild(node);
    activeCount.current += 1;

    const removeNode = () => {
      node.remove();
      activeCount.current = Math.max(0, activeCount.current - 1);
    };

    const sx = fromRect.left + fromRect.width / 2 - SLICE / 2;
    const sy = fromRect.top + fromRect.height / 2 - SLICE / 2;
    const exitX = window.innerWidth + SLICE;

    // Leg A — roll right across the top bar and off the right edge (rightward = clockwise).
    const legA = node.animate(
      [
        { transform: `translate(${sx}px, ${sy}px) rotate(0deg)` },
        { transform: `translate(${exitX}px, ${sy}px) rotate(720deg)` },
      ],
      { duration: LEG_A_MS, easing: 'cubic-bezier(0.45, 0, 0.9, 0.5)', fill: 'forwards' },
    );
    anims.current.add(legA);

    legA.finished
      .then(() => {
        anims.current.delete(legA);
        // Measure the target now — after the pending chip has taken its real tray slot.
        const toRect = opts.to(index);
        if (!toRect) {
          reveal();
          removeNode();
          return;
        }
        const tx = toRect.left + toRect.width / 2 - SLICE / 2;
        const ty = toRect.top + toRect.height / 2 - SLICE / 2;
        const reenterX = window.innerWidth + SLICE;

        // Leg B — re-enter from the right at tray height, roll left to the slot (leftward = ccw).
        // The off-screen gap between legs hides the rotation reset.
        const legB = node.animate(
          [
            { transform: `translate(${reenterX}px, ${ty}px) rotate(0deg)` },
            { transform: `translate(${tx}px, ${ty}px) rotate(-560deg)` },
          ],
          { duration: LEG_B_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' },
        );
        anims.current.add(legB);
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
        if (stagger > 0 && i > 0) {
          const id = setTimeout(() => {
            timers.current.delete(id);
            runSlice(opts, i);
          }, i * stagger);
          timers.current.add(id);
        } else {
          runSlice(opts, i);
        }
      }
    },
  }));

  return <div className="slice-fly-layer" ref={layerRef} aria-hidden="true" />;
});

export default SliceFlyLayer;
