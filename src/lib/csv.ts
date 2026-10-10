import Papa from "papaparse";
import type { Candle } from "../types";

const normalize = (key: string) => key.trim().replace(/^\uFEFF/, "").toLowerCase().replace(/[^a-z0-9]/g, "");

function columnIndex(headers: string[], aliases: string[]): number {
  return headers.findIndex((key) => aliases.includes(normalize(key)));
}

interface ColumnMap {
  time: number;
  date: number;
  clock: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function resolveColumns(row: string[]): ColumnMap {
  const headers = row.map(normalize);
  const index = (aliases: string[]) => columnIndex(headers, aliases);
  const columns: ColumnMap = {
    time: index(["timeutc", "datetime", "timestamp", "opentime", "time"]),
    date: index(["date"]),
    clock: index(["time"]),
    open: index(["open", "o"]),
    high: index(["high", "h"]),
    low: index(["low", "l"]),
    close: index(["close", "c"]),
    volume: index(["tickvolume", "volume", "vol"])
  };

  if ([columns.open, columns.high, columns.low, columns.close].some((i) => i === -1)) {
    throw new Error("Missing OHLC columns. Expected open, high, low, close.");
  }
  if (columns.time === -1 && columns.date === -1) {
    throw new Error("Missing timestamp: expected time_utc, datetime, timestamp, or date/time.");
  }
  return columns;
}

function toNumber(value: string | undefined): number {
  if (value === undefined || !value.trim()) return NaN;
  return Number(value.trim().replace(",", "."));
}

function parseDateLike(input: string): number {
  const raw = input.trim();

  if (/^\d{10,13}$/.test(raw)) {
    const number = Number(raw);
    return number > 1e12 ? Math.floor(number / 1000) : number;
  }

  const dmy = raw.match(
    /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (dmy) {
    const [, day, month, year, hour = "0", minute = "0", second = "0"] = dmy;
    return Math.floor(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second) / 1000);
  }

  // cTrader export time_utc uses ISO, e.g. 2017-01-02T23:01:00Z.
  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(" ", "T") + "Z";
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) throw new Error("Invalid date/time: " + raw);
  return Math.floor(ms / 1000);
}

function rowToCandle(row: string[], columns: ColumnMap): Candle {
  const datetime =
    columns.date !== -1 && columns.clock !== -1 && columns.date !== columns.clock
      ? (row[columns.date] ?? "") + " " + (row[columns.clock] ?? "")
      : row[columns.time !== -1 ? columns.time : columns.date] ?? "";

  const candle: Candle = {
    time: parseDateLike(datetime),
    open: toNumber(row[columns.open]),
    high: toNumber(row[columns.high]),
    low: toNumber(row[columns.low]),
    close: toNumber(row[columns.close]),
    volume: columns.volume === -1 ? 0 : toNumber(row[columns.volume])
  };

  if (![candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) {
    throw new Error("Invalid numeric value near " + datetime);
  }
  if (candle.high < Math.max(candle.open, candle.close) ||
      candle.low > Math.min(candle.open, candle.close) ||
      candle.low > candle.high) {
    throw new Error("Invalid candle OHLC near " + datetime);
  }
  return candle;
}

export interface CsvProgress {
  rows: number;
  fraction: number;
}

// Use Papa's streaming worker 'chunk' callback. Never use transformHeader,
// transform or any other function-valued worker config: postMessage can't clone it.
// Each chunk is normalized and discarded before reading the next, which avoids
// the old enormous result.data allocation for 3M+ cTrader M1 rows.
export function parseCtraderCsv(
  file: File,
  onProgress?: (progress: CsvProgress) => void
): Promise<Candle[]> {
  return new Promise((resolve, reject) => {
    const candles: Candle[] = [];
    let columns: ColumnMap | null = null;
    let settled = false;
    let sorted = true;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    Papa.parse<string[]>(file, {
      header: false,
      worker: true,
      chunkSize: 1024 * 1024,
      skipEmptyLines: "greedy",
      chunk: (result) => {
        if (settled) return;
        try {
          for (const rawRow of result.data) {
            const row = rawRow as string[];
            if (!row.length || row.every((cell) => !cell.trim())) continue;
            if (!columns) {
              columns = resolveColumns(row);
              continue;
            }
            const candle = rowToCandle(row, columns);
            const prev = candles[candles.length - 1];
            if (prev && candle.time < prev.time) sorted = false;
            if (prev && candle.time === prev.time) continue;
            candles.push(candle);
          }
          onProgress?.({
            rows: candles.length,
            fraction: Math.min(1, Number(result.meta.cursor || 0) / Math.max(file.size, 1))
          });
        } catch (error) {
          fail(error);
        }
      },
      complete: () => {
        if (settled) return;
        try {
          if (!candles.length) throw new Error("No M1 candles found in the CSV.");
          if (!sorted) {
            candles.sort((a, b) => a.time - b.time);
            let write = 1;
            for (let read = 1; read < candles.length; read += 1) {
              if (candles[read].time !== candles[write - 1].time) {
                candles[write++] = candles[read];
              }
            }
            candles.length = write;
          }
          settled = true;
          resolve(candles);
        } catch (error) {
          fail(error);
        }
      },
      error: fail
    });
  });
}
