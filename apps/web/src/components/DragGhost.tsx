interface Props {
  letter: string;
  x: number;
  y: number;
}

/** A floating tile that follows the pointer during a drag. Rendered at the document level
 * (fixed positioning) so it isn't clipped by the board viewport's overflow. */
export default function DragGhost({ letter, x, y }: Props) {
  return (
    <div className="drag-ghost" style={{ left: x, top: y }}>
      {letter}
    </div>
  );
}
