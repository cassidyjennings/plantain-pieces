import { useRef, useState } from 'react';
import { Stage, Layer, Rect, Text } from 'react-konva';
import type Konva from 'konva';
import { GRID_SIZE, type GridState } from '@plantain/shared';

const CELL = 32;
const BOARD_PX = GRID_SIZE * CELL;

interface Props {
  grid: GridState;
  width: number;
  height: number;
  canPlace: boolean;
  onCellClick: (x: number, y: number) => void;
}

export interface GridCanvasHandle {
  recenter: () => void;
}

export default function GridCanvas({ grid, width, height, canPlace, onCellClick }: Props) {
  const stageRef = useRef<Konva.Stage>(null);
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({
    x: width / 2 - (GRID_SIZE / 2) * CELL,
    y: height / 2 - (GRID_SIZE / 2) * CELL,
  });

  function handleWheel(e: Konva.KonvaEventObject<WheelEvent>) {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const oldScale = scale;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const mousePointTo = {
      x: (pointer.x - pos.x) / oldScale,
      y: (pointer.y - pos.y) / oldScale,
    };
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const newScale = Math.min(2.5, Math.max(0.25, oldScale * (direction > 0 ? 1.1 : 1 / 1.1)));

    setScale(newScale);
    setPos({
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    });
  }

  function recenter() {
    setScale(1);
    setPos({ x: width / 2 - (GRID_SIZE / 2) * CELL, y: height / 2 - (GRID_SIZE / 2) * CELL });
  }

  const cells = [];
  for (let x = 0; x < GRID_SIZE; x++) {
    for (let y = 0; y < GRID_SIZE; y++) {
      const key = `${x},${y}`;
      const letter = grid[key];
      cells.push(
        <Rect
          key={key}
          x={x * CELL}
          y={y * CELL}
          width={CELL - 1}
          height={CELL - 1}
          fill={letter ? '#f4d58d' : '#2a2a2a'}
          stroke={letter ? '#8a6d1c' : '#3d3d3d'}
          strokeWidth={1}
          cornerRadius={4}
          onClick={() => (letter ? onCellClick(x, y) : canPlace && onCellClick(x, y))}
          onTap={() => (letter ? onCellClick(x, y) : canPlace && onCellClick(x, y))}
        />,
      );
      if (letter) {
        cells.push(
          <Text
            key={`${key}-t`}
            x={x * CELL}
            y={y * CELL}
            width={CELL - 1}
            height={CELL - 1}
            text={letter}
            fontSize={16}
            fontStyle="bold"
            align="center"
            verticalAlign="middle"
            fill="#3a2a0a"
            listening={false}
          />,
        );
      }
    }
  }

  return (
    <div>
      <Stage
        ref={stageRef}
        width={width}
        height={height}
        draggable
        x={pos.x}
        y={pos.y}
        scaleX={scale}
        scaleY={scale}
        onWheel={handleWheel}
        onDragEnd={(e) => setPos({ x: e.target.x(), y: e.target.y() })}
      >
        <Layer>
          <Rect x={0} y={0} width={BOARD_PX} height={BOARD_PX} fill="#1c1c1c" />
          {cells}
        </Layer>
      </Stage>
      <button className="recenter-btn" onClick={recenter}>
        Recenter
      </button>
    </div>
  );
}
