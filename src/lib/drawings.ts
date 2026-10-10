export type DrawingKind =
  | "cursor" | "trend" | "ray" | "extended" | "horizontal" | "hray"
  | "vertical" | "arrow" | "cross" | "rectangle" | "ellipse"
  | "triangle" | "channel" | "brush" | "path" | "fib"
  | "fibext" | "fibtime" | "measure" | "long" | "short"
  | "text" | "callout" | "pitchfork";

export interface DrawingAnchor {
  time: number;   // UTC seconds: independent of chart timeframe
  price: number;
}

export interface Drawing {
  id: string;
  kind: Exclude<DrawingKind, "cursor">;
  anchors: DrawingAnchor[];
  color: string;
  width: number;
  dash: "solid" | "dashed" | "dotted";
  text?: string;
  locked?: boolean;
  hidden?: boolean;
}

export interface DrawingToolDef {
  kind: DrawingKind;
  label: string;
  glyph: string;
  points: number;
}

export const DRAWING_GROUPS: { title: string; glyph: string; tools: DrawingToolDef[] }[] = [
  {
    title: "Lines", glyph: "╱",
    tools: [
      { kind: "cursor", label: "Select / edit", glyph: "↖", points: 0 },
      { kind: "trend", label: "Trend line", glyph: "╱", points: 2 },
      { kind: "ray", label: "Ray", glyph: "⤴", points: 2 },
      { kind: "extended", label: "Extended line", glyph: "⟷", points: 2 },
      { kind: "horizontal", label: "Horizontal line", glyph: "━", points: 1 },
      { kind: "hray", label: "Horizontal ray", glyph: "⟶", points: 1 },
      { kind: "vertical", label: "Vertical line", glyph: "┃", points: 1 },
      { kind: "arrow", label: "Arrow", glyph: "➚", points: 2 },
      { kind: "cross", label: "Cross line", glyph: "╋", points: 1 }
    ]
  },
  {
    title: "Shapes", glyph: "▭",
    tools: [
      { kind: "rectangle", label: "Rectangle / zone", glyph: "▭", points: 2 },
      { kind: "ellipse", label: "Ellipse", glyph: "◯", points: 2 },
      { kind: "triangle", label: "Triangle", glyph: "△", points: 3 },
      { kind: "channel", label: "Parallel channel", glyph: "▱", points: 3 },
      { kind: "pitchfork", label: "Pitchfork", glyph: "⑂", points: 3 },
      { kind: "brush", label: "Freehand brush", glyph: "〰", points: -1 },
      { kind: "path", label: "Polyline", glyph: "⌁", points: 3 }
    ]
  },
  {
    title: "Fibonacci", glyph: "☷",
    tools: [
      { kind: "fib", label: "Fib retracement", glyph: "☷", points: 2 },
      { kind: "fibext", label: "Fib extension", glyph: "≋", points: 3 },
      { kind: "fibtime", label: "Fib time zones", glyph: "┇", points: 2 }
    ]
  },
  {
    title: "Trading", glyph: "⚖",
    tools: [
      { kind: "measure", label: "Price / time ruler", glyph: "↔", points: 2 },
      { kind: "long", label: "Long position (2R)", glyph: "▲", points: 2 },
      { kind: "short", label: "Short position (2R)", glyph: "▼", points: 2 }
    ]
  },
  {
    title: "Text", glyph: "T",
    tools: [
      { kind: "text", label: "Text note", glyph: "T", points: 1 },
      { kind: "callout", label: "Callout", glyph: "▤", points: 1 }
    ]
  }
];

export const TOOLS: DrawingToolDef[] = DRAWING_GROUPS.flatMap((group) => group.tools);
export function pointsFor(kind: DrawingKind): number {
  return TOOLS.find((tool) => tool.kind === kind)?.points ?? 2;
}

export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2.618] as const;
export const FIB_TIMES = [0, 1, 2, 3, 5, 8, 13, 21, 34] as const;

export function measureMove(start: DrawingAnchor, end: DrawingAnchor) {
  const delta = end.price - start.price;
  return {
    priceDelta: delta,
    percentage: start.price === 0 ? 0 : 100 * delta / start.price,
    minutes: Math.round((end.time - start.time) / 60)
  };
}

export function projectLine(
  a: { x: number; y: number },
  b: { x: number; y: number },
  mode: "segment" | "ray" | "extended",
  width: number
): [{ x: number; y: number }, { x: number; y: number }] {
  if (mode === "segment") return [a, b];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const factor = 2000 + Math.abs(width / (dx || 1));
  if (mode === "ray") return [a, { x: a.x + dx * factor, y: a.y + dy * factor }];
  return [
    { x: a.x - dx * factor, y: a.y - dy * factor },
    { x: a.x + dx * factor, y: a.y + dy * factor }
  ];
}

export function defaultDrawing(
  kind: Exclude<DrawingKind, "cursor">,
  anchors: DrawingAnchor[],
  color: string,
  width: number,
  dash: Drawing["dash"],
  text?: string
): Drawing {
  return {
    id: crypto.randomUUID(),
    kind, anchors, color, width, dash, text
  };
}

export function updateAnchor(drawing: Drawing, index: number, anchor: DrawingAnchor): Drawing {
  return {
    ...drawing,
    anchors: drawing.anchors.map((point, i) => i === index ? anchor : point)
  };
}

export function moveDrawing(drawing: Drawing, seconds: number, priceDelta: number): Drawing {
  return {
    ...drawing,
    anchors: drawing.anchors.map((point) => ({
      time: point.time + seconds,
      price: point.price + priceDelta
    }))
  };
}

export function parseDrawings(value: unknown): Drawing[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Drawing => {
    if (!item || typeof item !== "object") return false;
    const shape = item as Partial<Drawing>;
    return typeof shape.id === "string" &&
      TOOLS.some((tool) => tool.kind === shape.kind) &&
      Array.isArray(shape.anchors) &&
      shape.anchors.length > 0 &&
      shape.anchors.every((a) => Number.isFinite(a.time) && Number.isFinite(a.price)) &&
      typeof shape.color === "string" &&
      typeof shape.width === "number";
  });
}
