import { useEffect, useMemo, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp
} from "lightweight-charts";
import type { Candle } from "../types";
import { sma } from "../lib/timeframes";

type Tool = "cursor" | "hline" | "trend";

interface Props {
  candles: Candle[];
  symbol: string;
  followLatest?: boolean;
}

export default function TradingChart({ candles, symbol, followLatest = true }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const sma20Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const sma50Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const trendStart = useRef<{ time: UTCTimestamp; price: number } | null>(null);
  const [tool, setTool] = useState<Tool>("cursor");
  const [showSma20, setShowSma20] = useState(false);
  const [showSma50, setShowSma50] = useState(false);

  const candleData = useMemo(
    () =>
      candles.map((candle) => ({
        time: candle.time as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
      })),
    [candles]
  );

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

    const candlesSeries = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      borderVisible: false,
      priceLineVisible: true
    });

    const sma20Series = chart.addLineSeries({
      color: "#eab308",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false
    });

    const sma50Series = chart.addLineSeries({
      color: "#38bdf8",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false
    });

    chartRef.current = chart;
    candleSeriesRef.current = candlesSeries;
    sma20Ref.current = sma20Series;
    sma50Ref.current = sma50Series;

    const resize = new ResizeObserver(() => {
      if (hostRef.current) {
        chart.applyOptions({
          width: hostRef.current.clientWidth,
          height: hostRef.current.clientHeight
        });
      }
    });
    resize.observe(hostRef.current);

    return () => {
      resize.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      sma20Ref.current = null;
      sma50Ref.current = null;
    };
  }, []);

  useEffect(() => {
    const series = candleSeriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    series.setData(candleData);
    if (followLatest && candleData.length) chart.timeScale().scrollToRealTime();
  }, [candleData, followLatest]);

  useEffect(() => {
    if (!sma20Ref.current || !sma50Ref.current) return;
    sma20Ref.current.setData(
      showSma20
        ? sma(candles, 20).map((point) => ({ time: point.time as UTCTimestamp, value: point.value }))
        : []
    );
    sma50Ref.current.setData(
      showSma50
        ? sma(candles, 50).map((point) => ({ time: point.time as UTCTimestamp, value: point.value }))
        : []
    );
  }, [candles, showSma20, showSma50]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) return;

    const onClick = (param: any) => {
      if (tool === "cursor" || !param.point || !param.time) return;
      const price = series.coordinateToPrice(param.point.y);
      if (price === null) return;

      if (tool === "hline") {
        series.createPriceLine({
          price,
          color: "#a78bfa",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "H"
        });
        setTool("cursor");
        return;
      }

      if (tool === "trend") {
        if (!trendStart.current) {
          trendStart.current = { time: param.time as UTCTimestamp, price };
          return;
        }

        const line = chart.addLineSeries({
          color: "#f97316",
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false
        });
        line.setData([
          { time: trendStart.current.time, value: trendStart.current.price },
          { time: param.time as UTCTimestamp, value: price }
        ]);
        trendStart.current = null;
        setTool("cursor");
      }
    };

    chart.subscribeClick(onClick);
    return () => chart.unsubscribeClick(onClick);
  }, [tool]);

  return (
    <section className="chart-shell">
      <div className="chart-toolbar">
        <strong>{symbol}</strong>
        <button className={tool === "cursor" ? "active" : ""} onClick={() => setTool("cursor")}>
          Cursor
        </button>
        <button className={tool === "hline" ? "active" : ""} onClick={() => setTool("hline")}>
          H-Line
        </button>
        <button className={tool === "trend" ? "active" : ""} onClick={() => setTool("trend")}>
          Trend
        </button>
        <span className="divider" />
        <label className="check">
          <input type="checkbox" checked={showSma20} onChange={(e) => setShowSma20(e.target.checked)} />
          SMA 20
        </label>
        <label className="check">
          <input type="checkbox" checked={showSma50} onChange={(e) => setShowSma50(e.target.checked)} />
          SMA 50
        </label>
      </div>
      <div ref={hostRef} className="chart-host" />
    </section>
  );
}
