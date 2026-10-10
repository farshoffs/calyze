import type { Candle, Timeframe } from "../types";

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400
};

export function aggregateCandles(source: Candle[], timeframe: Timeframe): Candle[] {
  const seconds = TIMEFRAME_SECONDS[timeframe];
  if (seconds === 60) return source;

  const out: Candle[] = [];
  let current: Candle | null = null;
  let bucket = -1;

  for (const candle of source) {
    const nextBucket = Math.floor(candle.time / seconds) * seconds;
    if (!current || nextBucket !== bucket) {
      if (current) out.push(current);
      bucket = nextBucket;
      current = {
        time: nextBucket,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume
      };
      continue;
    }

    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume;
  }

  if (current) out.push(current);
  return out;
}

export function upperBoundTime(candles: Candle[], time: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (candles[mid].time <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function sma(candles: Candle[], period: number): Array<{ time: number; value: number }> {
  const out: Array<{ time: number; value: number }> = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) out.push({ time: candles[i].time, value: sum / period });
  }
  return out;
}
