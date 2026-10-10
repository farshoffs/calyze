import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ColorType, CrosshairMode, createChart,
  type IChartApi, type ISeriesApi, type UTCTimestamp
} from "lightweight-charts";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Candle } from "../types";
import { sma } from "../lib/timeframes";
import { supabase } from "../lib/supabase";
import {
  DRAWING_GROUPS, TOOLS, defaultDrawing, moveDrawing, parseDrawings,
  pointsFor, updateAnchor, type Drawing, type DrawingAnchor, type DrawingKind
} from "../lib/drawings";
import DrawingShape, { type PlotPoint } from "./DrawingShape";

interface Props {
  candles: Candle[];
  symbol: string;
  workspaceKey: string;
  userId?: string;
  followLatest?: boolean;
}

type DragState = {
  id: string;
  index?: number;
  origin: DrawingAnchor;
  before: Drawing[];
  pointerId: number;
};

const PALETTE = ["#a78bfa", "#38bdf8", "#22c55e", "#f59e0b", "#f43f5e", "#f8fafc"];
const LOCAL_PREFIX = "calyze:drawings:v2:";
const normalizeWorkspace = (key: string, userId?: string) => LOCAL_PREFIX + (userId || "guest") + ":" + key;

function storedDrawings(key: string): Drawing[] {
  try { return parseDrawings(JSON.parse(localStorage.getItem(key) || "[]")); }
  catch { return []; }
}

export default function TradingChart({
  candles, symbol, workspaceKey, userId, followLatest = true
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<SVGSVGElement | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const sma20Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const sma50Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const drawingRef = useRef<Drawing[]>([]);
  const historyRef = useRef<{ past: Drawing[][]; future: Drawing[][] }>({ past: [], future: [] });
  const [drawingItems, setDrawingItems] = useState<Drawing[]>([]);
  const [tool, setTool] = useState<DrawingKind>("cursor");
  const [category, setCategory] = useState("Lines");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DrawingAnchor[]>([]);
  const [pointer, setPointer] = useState<DrawingAnchor | null>(null);
  const [brushDown, setBrushDown] = useState(false);
  const [ink, setInk] = useState("#a78bfa");
  const [lineWidth, setLineWidth] = useState(2);
  const [dash, setDash] = useState<Drawing["dash"]>("solid");
  const [showSma20, setShowSma20] = useState(false);
  const [showSma50, setShowSma50] = useState(false);
  const [viewportTick, setViewportTick] = useState(0);
  const [revision, setRevision] = useState(0);
  const [cloudInfo, setCloudInfo] = useState("");
  const [ready, setReady] = useState(false);

  const storeKey = useMemo(() => normalizeWorkspace(workspaceKey, userId), [workspaceKey, userId]);
  const cloudName = "drawings:" + workspaceKey;

  const candleData = useMemo(() => candles.map((candle) => ({
    time: candle.time as UTCTimestamp,
    open: candle.open, high: candle.high, low: candle.low, close: candle.close
  })), [candles]);

  const setItems = useCallback((next: Drawing[]) => {
    drawingRef.current = next;
    setDrawingItems(next);
  }, []);

  const commit = useCallback((next: Drawing[]) => {
    if (next.length > 1500) return;
    historyRef.current.past.push(drawingRef.current);
    if (historyRef.current.past.length > 80) historyRef.current.past.shift();
    historyRef.current.future = [];
    setItems(next);
    setRevision((value) => value + 1);
  }, [setItems]);

  const undo = useCallback(() => {
    const past = historyRef.current.past.pop();
    if (!past) return;
    historyRef.current.future.push(drawingRef.current);
    setItems(past);
    setSelectedId(null);
    setRevision((value) => value + 1);
  }, [setItems]);

  const redo = useCallback(() => {
    const future = historyRef.current.future.pop();
    if (!future) return;
    historyRef.current.past.push(drawingRef.current);
    setItems(future);
    setSelectedId(null);
    setRevision((value) => value + 1);
  }, [setItems]);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    commit(drawingRef.current.filter((drawing) => drawing.id !== selectedId));
    setSelectedId(null);
  }, [selectedId, commit]);

  const changeSelected = useCallback((change: Partial<Drawing>) => {
    if (!selectedId) return;
    commit(drawingRef.current.map((drawing) =>
      drawing.id === selectedId ? { ...drawing, ...change } : drawing
    ));
  }, [selectedId, commit]);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setTool("cursor");
    setSelectedId(null);
    setDraft([]);
    historyRef.current = { past: [], future: [] };
    setRevision(0);

    const local = storedDrawings(storeKey);
    setItems(local);
    setReady(true);
    setCloudInfo(local.length ? "Drawings restored from this device" : "");

    if (!userId || !supabase) return () => { cancelled = true; };
    const client = supabase;
    void (async () => {
      const { data, error } = await client.from("workspaces")
        .select("drawings")
        .eq("user_id", userId)
        .eq("name", cloudName)
        .order("updated_at", { ascending: false })
        .limit(1);
      if (cancelled) return;
      if (error) {
        setCloudInfo("Cloud drawing load: " + error.message);
        return;
      }
      const remote = parseDrawings(data?.[0]?.drawings);
      if (remote.length && drawingRef.current.length === 0) {
        setItems(remote);
        setCloudInfo("Drawings restored from Supabase");
      }
    })();
    return () => { cancelled = true; };
  }, [storeKey, cloudName, userId, setItems]);

  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(storeKey, JSON.stringify(drawingItems)); }
    catch { setCloudInfo("Device storage is full; export drawings to keep a backup."); }
  }, [drawingItems, storeKey, ready]);

  useEffect(() => {
    if (!ready || !revision || !userId || !supabase) return;
    const client = supabase;
    const timer = window.setTimeout(async () => {
      const { data: old, error: lookupError } = await client.from("workspaces")
        .select("id")
        .eq("user_id", userId)
        .eq("name", cloudName)
        .order("updated_at", { ascending: false })
        .limit(1);
      if (lookupError) {
        setCloudInfo("Cloud sync failed: " + lookupError.message);
        return;
      }
      const payload = {
        drawings: drawingItems,
        timeframe: "M15",
        updated_at: new Date().toISOString()
      };
      const result = old?.[0]
        ? await client.from("workspaces").update(payload).eq("id", old[0].id).eq("user_id", userId)
        : await client.from("workspaces").insert({
            user_id: userId, name: cloudName, ...payload
          });
      setCloudInfo(result.error ? "Cloud sync failed: " + result.error.message : "Drawings saved to Supabase");
    }, 850);
    return () => window.clearTimeout(timer);
  }, [drawingItems, cloudName, userId, revision, ready]);

  useEffect(() => {
    if (!hostRef.current) return;
    const chart = createChart(hostRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0b0e11" },
        textColor: "#a8b3c7"
      },
      grid: {
        vertLines: { color: "#161b22" },
        horzLines: { color: "#161b22" }
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#263040" },
      timeScale: {
        borderColor: "#263040",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8
      }
    });

    const series = chart.addCandlestickSeries({
      upColor: "#22c55e", downColor: "#ef4444",
      wickUpColor: "#22c55e", wickDownColor: "#ef4444",
      borderVisible: false, priceLineVisible: true
    });
    const sma20 = chart.addLineSeries({
      color: "#eab308", lineWidth: 1, priceLineVisible: false, lastValueVisible: false
    });
    const sma50 = chart.addLineSeries({
      color: "#38bdf8", lineWidth: 1, priceLineVisible: false, lastValueVisible: false
    });

    chartRef.current = chart;
    seriesRef.current = series;
    sma20Ref.current = sma20;
    sma50Ref.current = sma50;

    const refresh = () => setViewportTick((value) => value + 1);
    const observer = new ResizeObserver(refresh);
    observer.observe(hostRef.current);
    chart.timeScale().subscribeVisibleLogicalRangeChange(refresh);
    chart.subscribeCrosshairMove(refresh);

    return () => {
      observer.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(refresh);
      chart.unsubscribeCrosshairMove(refresh);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      sma20Ref.current = null;
      sma50Ref.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    series.setData(candleData);
    if (followLatest && candleData.length) chart.timeScale().scrollToRealTime();
    setViewportTick((value) => value + 1);
  }, [candleData, followLatest]);

  useEffect(() => {
    if (!sma20Ref.current || !sma50Ref.current) return;
    sma20Ref.current.setData(showSma20
      ? sma(candles, 20).map((point) => ({ time: point.time as UTCTimestamp, value: point.value }))
      : []);
    sma50Ref.current.setData(showSma50
      ? sma(candles, 50).map((point) => ({ time: point.time as UTCTimestamp, value: point.value }))
      : []);
  }, [candles, showSma20, showSma50]);

  const getAnchor = useCallback((event: ReactPointerEvent<SVGSVGElement>): DrawingAnchor | null => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const overlay = overlayRef.current;
    if (!chart || !series || !overlay) return null;
    const rect = overlay.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const price = series.coordinateToPrice(y);
    const time = chart.timeScale().coordinateToTime(x);
    if (typeof time !== "number" || price === null || !Number.isFinite(price)) return null;
    return { time: time as number, price };
  }, []);

  const nearestTimestamp = useCallback((time: number): number | null => {
    if (!candles.length) return null;
    let lo = 0, hi = candles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    const left = Math.max(0, lo - 1);
    const right = Math.min(candles.length - 1, lo);
    return Math.abs(candles[left].time - time) < Math.abs(candles[right].time - time)
      ? candles[left].time : candles[right].time;
  }, [candles]);

  const plot = useCallback((anchors: DrawingAnchor[]): PlotPoint[] => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return [];
    return anchors.map((point) => {
      const snappedTime = nearestTimestamp(point.time);
      if (snappedTime === null) return null;
      const x = chart.timeScale().timeToCoordinate(snappedTime as UTCTimestamp);
      const y = series.priceToCoordinate(point.price);
      if (x === null || y === null) return null;
      return { x: Number(x), y: Number(y), time: point.time, price: point.price };
    }).filter((point): point is PlotPoint => point !== null);
  }, [nearestTimestamp, viewportTick]);

  const size = {
    width: hostRef.current?.clientWidth ?? 900,
    height: hostRef.current?.clientHeight ?? 500
  };

  function create(kind: Exclude<DrawingKind, "cursor">, anchors: DrawingAnchor[]) {
    const textKind = kind === "text" || kind === "callout";
    let note: string | undefined;
    if (textKind) {
      const reply = window.prompt("Enter chart annotation", "Trading setup");
      if (reply === null) { setDraft([]); setPointer(null); setTool("cursor"); return; }
      note = reply.slice(0, 220);
    }
    const newDrawing = defaultDrawing(kind, anchors, ink, lineWidth, dash, note);
    commit([...drawingRef.current, newDrawing]);
    setSelectedId(newDrawing.id);
    setDraft([]);
    setPointer(null);
    setTool("cursor");
  }

  function handleOverlayDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (tool === "cursor") {
      setSelectedId(null);
      return;
    }
    const anchor = getAnchor(event);
    if (!anchor) return;
    if (tool === "brush") {
      setDraft([anchor]);
      setBrushDown(true);
      overlayRef.current?.setPointerCapture(event.pointerId);
      return;
    }
    const next = [...draft, anchor];
    if (next.length >= pointsFor(tool)) create(tool, next);
    else { setDraft(next); setPointer(anchor); }
  }

  function handleOverlayMove(event: ReactPointerEvent<SVGSVGElement>) {
    const anchor = getAnchor(event);
    if (!anchor) return;
    const drag = dragRef.current;
    if (drag) {
      const changeTime = anchor.time - drag.origin.time;
      const changePrice = anchor.price - drag.origin.price;
      const changed = drag.before.map((item) => {
        if (item.id !== drag.id) return item;
        return drag.index === undefined
          ? moveDrawing(item, changeTime, changePrice)
          : updateAnchor(item, drag.index, anchor);
      });
      setItems(changed);
      return;
    }
    if (brushDown && tool === "brush") {
      setDraft((previous) => {
        const last = previous[previous.length - 1];
        if (last?.time === anchor.time && Math.abs(last.price - anchor.price) < 0.0001) return previous;
        return [...previous, anchor].slice(-3000);
      });
      return;
    }
    if (tool !== "cursor" && draft.length) setPointer(anchor);
  }

  function handleOverlayUp() {
    if (dragRef.current) {
      const drag = dragRef.current;
      dragRef.current = null;
      const changed = JSON.stringify(drag.before) !== JSON.stringify(drawingRef.current);
      if (changed) {
        historyRef.current.past.push(drag.before);
        historyRef.current.future = [];
        setRevision((value) => value + 1);
      }
    }
    if (brushDown && tool === "brush") {
      setBrushDown(false);
      if (draft.length >= 2) create("brush", draft);
      else setDraft([]);
    }
  }

  function startDrag(
    event: ReactPointerEvent<SVGGElement>,
    id: string,
    anchorIndex?: number
  ) {
    if (tool !== "cursor") return;
    const anchor = getAnchor(event as unknown as ReactPointerEvent<SVGSVGElement>);
    if (!anchor) return;
    setSelectedId(id);
    dragRef.current = {
      id, index: anchorIndex, origin: anchor,
      before: drawingRef.current, pointerId: event.pointerId
    };
    overlayRef.current?.setPointerCapture(event.pointerId);
  }

  function useTool(kind: DrawingKind) {
    setTool(kind);
    setSelectedId(null);
    setDraft([]);
    setPointer(null);
    setPaletteOpen(false);
  }

  const selected = drawingItems.find((item) => item.id === selectedId);
  const pendingAnchors = draft.length && pointer && tool !== "brush"
    ? [...draft, pointer] : draft;
  const pendingShape = pendingAnchors.length && tool !== "cursor"
    ? defaultDrawing(tool, pendingAnchors, ink, lineWidth, dash, "Draft")
    : null;

  function exportDrawings() {
    const blob = new Blob([JSON.stringify({
      version: 2, symbol, workspaceKey, drawings: drawingRef.current
    }, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = "calyze_" + symbol + "_drawings.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  async function importDrawings(file: File) {
    try {
      const object: unknown = JSON.parse(await file.text());
      const items = parseDrawings(
        object && typeof object === "object" && "drawings" in object
          ? (object as { drawings: unknown }).drawings : object
      );
      if (!items.length) throw new Error("No valid drawings in this file.");
      commit([...drawingRef.current, ...items.map((item) => ({ ...item, id: crypto.randomUUID() }))]);
    } catch (error) {
      setCloudInfo(error instanceof Error ? error.message : "Invalid drawing backup.");
    }
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLSelectElement) return;
      if (event.key === "Escape") { setTool("cursor"); setDraft([]); setSelectedId(null); }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
        event.preventDefault();
        deleteSelected();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault(); redo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, deleteSelected, undo, redo]);

  return (
    <section className="chart-shell calyze-chart-workspace">
      <div className="chart-toolbar">
        <strong>{symbol}</strong>
        <span>{drawingItems.length} drawings</span>
        <span className="divider" />
        <label className="check">
          <input type="checkbox" checked={showSma20} onChange={(e) => setShowSma20(e.target.checked)} /> SMA 20
        </label>
        <label className="check">
          <input type="checkbox" checked={showSma50} onChange={(e) => setShowSma50(e.target.checked)} /> SMA 50
        </label>
        <button onClick={undo} disabled={!historyRef.current.past.length} title="Undo (Ctrl+Z)">↶ Undo</button>
        <button onClick={redo} disabled={!historyRef.current.future.length} title="Redo (Ctrl+Y)">↷ Redo</button>
        <button onClick={exportDrawings} title="Download drawing JSON">↓ Export</button>
        <button onClick={() => importRef.current?.click()} title="Load drawing JSON">↑ Import</button>
        <input ref={importRef} hidden type="file" accept="application/json,.json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importDrawings(file);
            event.currentTarget.value = "";
          }}/>
        {cloudInfo && <span className="drawing-sync">{cloudInfo}</span>}
      </div>

      <div className="drawing-chart-layout">
        <div className="drawing-rail">
          {DRAWING_GROUPS.map((group) => (
            <button key={group.title}
              className={category === group.title && paletteOpen ? "active" : ""}
              title={group.title}
              onClick={() => { setCategory(group.title); setPaletteOpen(category !== group.title || !paletteOpen); }}>
              {group.glyph}
            </button>
          ))}
          <span className="drawing-rail-separator" />
          <button title="Select and edit (Escape)" className={tool === "cursor" ? "active" : ""}
            onClick={() => useTool("cursor")}>↖</button>
          <button title="Undo" onClick={undo} disabled={!historyRef.current.past.length}>↶</button>
          <button title="Clear all drawings" onClick={() => {
            if (window.confirm("Clear every chart drawing? You can undo.")) {
              commit([]); setSelectedId(null);
            }
          }}>⌫</button>
        </div>

        <div className="drawing-stage">
          <div ref={hostRef} className="chart-host" />
          <svg ref={overlayRef} className={"drawing-overlay " + (tool !== "cursor" ? "drawing-mode" : "")}
            onPointerDown={handleOverlayDown} onPointerMove={handleOverlayMove}
            onPointerUp={handleOverlayUp} onPointerCancel={handleOverlayUp}>
            <defs>
              <marker id="calyze-drawing-arrow" markerWidth="10" markerHeight="10"
                refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L0,6 L9,3 z" fill={ink}/>
              </marker>
            </defs>
            {drawingItems.map((drawing) => (
              <DrawingShape key={drawing.id} drawing={drawing} points={plot(drawing.anchors)}
                selected={selectedId === drawing.id} interactive={tool === "cursor"}
                width={size.width} height={size.height}
                onPointerDown={(event, index) => startDrag(event, drawing.id, index)} />
            ))}
            {pendingShape && (
              <DrawingShape drawing={pendingShape} points={plot(pendingShape.anchors)}
                selected={false} interactive={false} width={size.width} height={size.height}
                onPointerDown={() => {}} />
            )}
          </svg>

          {paletteOpen && (
            <div className="drawing-tool-menu">
              <div className="drawing-menu-heading">
                <strong>{category}</strong>
                <button onClick={() => setPaletteOpen(false)} aria-label="Close drawing tools">×</button>
              </div>
              {DRAWING_GROUPS.find((group) => group.title === category)?.tools.map((entry) => (
                <button key={entry.kind} className={tool === entry.kind ? "active" : ""}
                  onClick={() => useTool(entry.kind)}>
                  <span className="tool-glyph">{entry.glyph}</span>
                  {entry.label}
                  <small>{entry.points === -1 ? "Drag" : entry.points === 1 ? "Click" : entry.points + " points"}</small>
                </button>
              ))}
            </div>
          )}

          {selected && (
            <div className="drawing-properties">
              <strong>{TOOLS.find((item) => item.kind === selected.kind)?.label}</strong>
              <input type="color" title="Line color" value={selected.color}
                onChange={(event) => changeSelected({ color: event.target.value })} />
              <select value={selected.width} title="Line width"
                onChange={(event) => changeSelected({ width: Number(event.target.value) })}>
                {[1, 2, 3, 4, 6].map((value) => <option value={value} key={value}>{value}px</option>)}
              </select>
              <select title="Line style" value={selected.dash}
                onChange={(event) => changeSelected({ dash: event.target.value as Drawing["dash"] })}>
                <option value="solid">Solid</option>
                <option value="dashed">Dashed</option>
                <option value="dotted">Dotted</option>
              </select>
              {(selected.kind === "text" || selected.kind === "callout") && (
                <button onClick={() => {
                  const next = window.prompt("Edit chart annotation", selected.text || "");
                  if (next !== null) changeSelected({ text: next.slice(0, 220) });
                }}>Edit text</button>
              )}
              <button title={selected.locked ? "Unlock" : "Lock"} onClick={() => changeSelected({ locked: !selected.locked })}>
                {selected.locked ? "🔒" : "🔓"}
              </button>
              <button title="Hide" onClick={() => changeSelected({ hidden: true })}>◉</button>
              <button title="Duplicate" onClick={() => {
                const copy = {
                  ...selected, id: crypto.randomUUID(),
                  anchors: selected.anchors.map((point) => ({ time: point.time + 3600, price: point.price }))
                };
                commit([...drawingRef.current, copy]); setSelectedId(copy.id);
              }}>⧉</button>
              <button title="Delete" onClick={deleteSelected}>🗑</button>
              <button title="Deselect" onClick={() => setSelectedId(null)}>×</button>
            </div>
          )}

          {drawingItems.some((item) => item.hidden) && (
            <button className="drawing-show-hidden" onClick={() =>
              commit(drawingRef.current.map((item) => ({ ...item, hidden: false })))
            }>Show hidden ({drawingItems.filter((item) => item.hidden).length})</button>
          )}

          {tool !== "cursor" && (
            <div className="drawing-hint">
              {TOOLS.find((item) => item.kind === tool)?.label} ·
              {tool === "brush" ? " drag to draw" : " click " + pointsFor(tool) + " point(s)"} · Esc to cancel
            </div>
          )}
        </div>
      </div>

      <div className="drawing-bottom-bar">
        <div className="drawing-palette">
          {PALETTE.map((color) => (
            <button key={color} title={color} className={ink === color ? "active" : ""}
              style={{ backgroundColor: color }}
              onClick={() => setInk(color)}/>
          ))}
          <input type="color" value={ink} onChange={(event) => setInk(event.target.value)}
            aria-label="Custom drawing color"/>
        </div>
        <select value={lineWidth} title="New drawing line width" onChange={(event) => setLineWidth(+event.target.value)}>
          {[1,2,3,4,6].map((width) => <option key={width} value={width}>{width}px</option>)}
        </select>
        <select value={dash} title="New drawing line style" onChange={(event) => setDash(event.target.value as Drawing["dash"])}>
          <option value="solid">Solid</option>
          <option value="dashed">Dashed</option>
          <option value="dotted">Dotted</option>
        </select>
        <span>Drawings auto-save on device{userId ? " + Supabase" : ""}</span>
      </div>
    </section>
  );
}
