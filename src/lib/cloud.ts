import type { Candle, InstrumentSpec } from "../types";
import { supabase } from "./supabase";

export async function saveDatasetToCloud(args: {
  name: string;
  symbol: string;
  candles: Candle[];
  instrument: InstrumentSpec;
  onProgress?: (done: number, total: number) => void;
}): Promise<string> {
  if (!supabase) throw new Error("Supabase is not configured.");

  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sign in before saving to Supabase.");

  const { data: dataset, error: datasetError } = await supabase
    .from("datasets")
    .insert({
      user_id: user.id,
      name: args.name,
      symbol: args.symbol,
      source: "ctrader_csv",
      base_timeframe: "M1",
      row_count: args.candles.length,
      first_ts: new Date(args.candles[0].time * 1000).toISOString(),
      last_ts: new Date(args.candles[args.candles.length - 1].time * 1000).toISOString(),
      instrument: args.instrument
    })
    .select("id")
    .single();

  if (datasetError) throw datasetError;

  const chunkSize = 1500;
  for (let start = 0; start < args.candles.length; start += chunkSize) {
    const chunk = args.candles.slice(start, start + chunkSize).map((candle) => ({
      dataset_id: dataset.id,
      user_id: user.id,
      ts: new Date(candle.time * 1000).toISOString(),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume
    }));

    const { error } = await supabase.from("market_candles").upsert(chunk, {
      onConflict: "dataset_id,ts"
    });
    if (error) throw error;
    args.onProgress?.(Math.min(start + chunk.length, args.candles.length), args.candles.length);
  }

  return dataset.id as string;
}
