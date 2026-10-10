import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { FIB_RATIOS, FIB_TIMES, measureMove, projectLine, type Drawing } from "../lib/drawings";

export interface PlotPoint { x: number; y: number; time: number; price: number }

interface Props {
  drawing: Drawing;
  points: PlotPoint[];
  selected: boolean;
  interactive: boolean;
  width: number;
  height: number;
  onPointerDown: (event: ReactPointerEvent<SVGGElement>, anchorIndex?: number) => void;
}

export default function DrawingShape({ drawing, points, selected, interactive, width, height, onPointerDown }: Props) {
  if (drawing.hidden || !points.length) return null;
  const { color, kind } = drawing;
  const [a, b = a, c = b] = points;
  const dashArray = drawing.dash === "dashed" ? "8 5" : drawing.dash === "dotted" ? "2 4" : undefined;

  const line = (x1: number, y1: number, x2: number, y2: number, arrow = false): ReactNode => (
    <>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color}
        strokeWidth={drawing.width} strokeDasharray={dashArray}
        markerEnd={arrow ? "url(#calyze-drawing-arrow)" : undefined} pointerEvents="none" />
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent"
        strokeWidth={Math.max(14, drawing.width + 10)} pointerEvents="stroke" />
    </>
  );
  const text = (x: number, y: number, value: string, anchor: "start" | "middle" | "end" = "start") => (
    <text x={x} y={y} textAnchor={anchor} fill={color} fontSize="12" fontWeight="600"
      paintOrder="stroke" stroke="#101418" strokeWidth="3" strokeLinejoin="round" pointerEvents="none">
      {value}
    </text>
  );

  let geometry: ReactNode;
  switch (kind) {
    case "horizontal":
      geometry = line(0, a.y, width, a.y);
      break;
    case "hray":
      geometry = line(a.x, a.y, width, a.y);
      break;
    case "vertical":
      geometry = line(a.x, 0, a.x, height);
      break;
    case "cross":
      geometry = <>{line(a.x, 0, a.x, height)}{line(0, a.y, width, a.y)}</>;
      break;
    case "trend":
    case "ray":
    case "extended":
    case "arrow": {
      const [start, end] = projectLine(a, b,
        kind === "ray" ? "ray" : kind === "extended" ? "extended" : "segment", width);
      geometry = line(start.x, start.y, end.x, end.y, kind === "arrow");
      break;
    }
    case "rectangle": {
      const left = Math.min(a.x, b.x);
      const top = Math.min(a.y, b.y);
      const rectWidth = Math.abs(a.x - b.x);
      const rectHeight = Math.abs(a.y - b.y);
      geometry = <rect x={left} y={top} width={rectWidth} height={rectHeight}
        fill={color} fillOpacity={0.1} stroke={color} strokeWidth={drawing.width}
        strokeDasharray={dashArray} pointerEvents="visiblePainted" />;
      break;
    }
    case "ellipse":
      geometry = <ellipse cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2}
        rx={Math.abs(a.x - b.x) / 2} ry={Math.abs(a.y - b.y) / 2}
        fill={color} fillOpacity={0.1} stroke={color} strokeWidth={drawing.width}
        strokeDasharray={dashArray} pointerEvents="visiblePainted" />;
      break;
    case "triangle":
      geometry = <polygon points={points.slice(0, 3).map((p) => p.x + "," + p.y).join(" ")}
        fill={color} fillOpacity={0.1} stroke={color} strokeWidth={drawing.width}
        strokeDasharray={dashArray} pointerEvents="visiblePainted" />;
      break;
    case "channel": {
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      geometry = <>
        {line(a.x, a.y, b.x, b.y)}
        {line(a.x + dx, a.y + dy, b.x + dx, b.y + dy)}
        {line(a.x + dx / 2, a.y + dy / 2, b.x + dx / 2, b.y + dy / 2)}
        <polygon points={[a, b, { x: b.x + dx, y: b.y + dy }, { x: a.x + dx, y: a.y + dy }]
          .map((p) => p.x + "," + p.y).join(" ")} fill={color} fillOpacity="0.05" pointerEvents="none" />
      </>;
      break;
    }
    case "pitchfork": {
      const middle = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
      const vector = { x: middle.x - a.x, y: middle.y - a.y };
      const [start, end] = projectLine(a, middle, "ray", width);
      const factor = vector.x === 0 ? 100 : Math.abs(width / vector.x) + 10;
      geometry = <>
        {line(start.x, start.y, end.x, end.y)}
        {line(b.x, b.y, b.x + vector.x * factor, b.y + vector.y * factor)}
        {line(c.x, c.y, c.x + vector.x * factor, c.y + vector.y * factor)}
        {line(b.x, b.y, c.x, c.y)}
      </>;
      break;
    }
    case "path":
    case "brush":
      geometry = <polyline points={points.map((p) => p.x + "," + p.y).join(" ")}
        fill="none" stroke={color} strokeWidth={drawing.width}
        strokeDasharray={dashArray} strokeLinecap="round" strokeLinejoin="round" pointerEvents="stroke" />;
      break;
    case "fib":
    case "fibext": {
      const low = kind === "fibext" ? c : a;
      const diff = b.y - a.y;
      const left = Math.min(a.x, b.x);
      geometry = <>
        {FIB_RATIOS.map((ratio) => {
          const levelY = low.y + diff * ratio;
          return <g key={ratio}>
            {line(left, levelY, width, levelY)}
            {text(Math.max(8, Math.min(width - 120, left + 5)), levelY - 4,
              Math.round(ratio * 1000) / 10 + "% · " +
              (low.price + (b.price - a.price) * ratio).toFixed(3))}
          </g>;
        })}
      </>;
      break;
    }
    case "fibtime": {
      const delta = b.x - a.x;
      geometry = <>{FIB_TIMES.map((ratio) => {
        const x = a.x + delta * ratio;
        return <g key={ratio}>
          {line(x, 0, x, height)}
          {text(x + 4, 14, String(ratio))}
        </g>;
      })}</>;
      break;
    }
    case "measure": {
      const move = measureMove(a, b);
      geometry = <>
        <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)}
          width={Math.abs(a.x - b.x)} height={Math.abs(a.y - b.y)}
          stroke={color} strokeDasharray="5 4" fill={color} fillOpacity=".06"
          pointerEvents="visiblePainted" />
        {line(a.x, a.y, b.x, b.y)}
        {text(Math.min(a.x, b.x) + 5, Math.min(a.y, b.y) - 8,
          (move.priceDelta >= 0 ? "+" : "") + move.priceDelta.toFixed(3) +
          " / " + move.percentage.toFixed(2) + "% / " + move.minutes + "m")}
      </>;
      break;
    }
    case "long":
    case "short": {
      const range = Math.max(1, Math.abs(b.x - a.x));
      const right = Math.max(a.x, b.x, a.x + Math.min(260, range));
      const stopDistance = Math.abs(b.y - a.y);
      const stopY = kind === "long" ? a.y + stopDistance : a.y - stopDistance;
      const targetY = kind === "long" ? a.y - stopDistance * 2 : a.y + stopDistance * 2;
      geometry = <>
        <rect x={a.x} y={Math.min(a.y, targetY)} width={Math.max(1, right - a.x)}
          height={Math.abs(targetY - a.y)} fill="#22c55e" fillOpacity=".16"
          stroke="#22c55e" pointerEvents="visiblePainted" />
        <rect x={a.x} y={Math.min(a.y, stopY)} width={Math.max(1, right - a.x)}
          height={Math.abs(stopY - a.y)} fill="#ef4444" fillOpacity=".16"
          stroke="#ef4444" pointerEvents="visiblePainted" />
        {line(a.x, a.y, right, a.y)}
        {text(a.x + 5, a.y - 6, kind.toUpperCase() + " · RR 1:2")}
        {text(a.x + 5, targetY - 6, "TP 2R")}
        {text(a.x + 5, stopY + 13, "SL 1R")}
      </>;
      break;
    }
    case "text":
      geometry = <text x={a.x} y={a.y} fill={color} fontSize="15" fontWeight="700"
        paintOrder="stroke" stroke="#0b0e11" strokeWidth="3"
        pointerEvents="visiblePainted">{drawing.text || "Note"}</text>;
      break;
    case "callout":
      geometry = <>
        <path d={`M ${a.x} ${a.y} l 15 -20`} stroke={color} strokeWidth="1.5" pointerEvents="stroke"/>
        <rect x={a.x + 15} y={a.y - 46} width={Math.max(90, (drawing.text || "Note").length * 8 + 20)}
          height="32" rx="5" fill="#202939" stroke={color} pointerEvents="visiblePainted"/>
        {text(a.x + 25, a.y - 26, drawing.text || "Note")}
      </>;
      break;
    default:
      geometry = null;
  }

  return (
    <g pointerEvents={interactive ? "auto" : "none"} onPointerDown={(event) => {
      if (drawing.locked) return;
      event.stopPropagation();
      onPointerDown(event);
    }} style={{ cursor: drawing.locked ? "default" : "move" }}>
      {geometry}
      {selected && (
        <>
          {points.map((point, index) => (
            <circle key={index} cx={point.x} cy={point.y} r={6}
              fill="#e2e8f0" stroke={color} strokeWidth="2" pointerEvents="all"
              onPointerDown={(event) => {
                event.stopPropagation();
                if (!drawing.locked) onPointerDown(event, index);
              }}/>
          ))}
        </>
      )}
    </g>
  );
}
