import Papa from "papaparse";
import type { Candle } from "../types";

type Row = Record<string, string>;

const normalize = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

function pick(row: Row, aliases: string[]): string | undefined {
  const map = new Map(Object.keys(row).map((key) => [normalize(key), row[key]]));
  for (const alias of aliases) {
    const value = map.get(normalize(alias));
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function numberValue(value: string | undefined, label: string): number {
  if (value === undefined) throw new Error("Missing " + label + " column");
  const cleaned = value.trim().replace(",", ".");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) throw new Error("Invalid " + label + " value: " + value);
  return parsed;
}

function parseDateLike(input: string): number {
  const raw = input.trim();

  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    return n > 1e12 ? Math.floor(n / 1000) : n;
  }

  const dmy = raw.match(
    /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (dmy) {
    const [, d, m, y, hh = "0", mm = "0", ss = "0"] = dmy;
    return Math.floor(Date.UTC(+y, +m - 1, +d, +hh, +mm, +ss) / 1000);
  }

  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(" ", "T") + "Z";
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) throw new Error("Unrecognized date/time: " + raw);
  return Math.floor(ms / 1000);
}

function parseTime(row: Row): number {
  const timestamp = pick(row, ["timestamp", "datetime", "date time", "open time"]);
  if (timestamp) return parseDateLike(timestamp);

  const date = pick(row, ["date"]);
  const time = pick(row, ["time"]);
  if (date && time) return parseDateLike(date + " " + time);
  if (time) return parseDateLike(time);

  throw new Error("Missing timestamp/date/time column");
}

export async function parseCtraderCsv(file: File): Promise<Candle[]> {
  return new Promise((resolve, reject) => {
    Papa.parse<Row>(file, {
      header: true,
      skipEmptyLines: "greedy",
      worker: true,
      transformHeader: (header) => header.trim(),
      complete: (result) => {
        try {
          if (result.errors.length) {
            const fatal = result.errors.find((error) => error.type !== "FieldMismatch");
            if (fatal) throw new Error(fatal.message);
          }

          const candles = result.data.map((row) => {
            const open = numberValue(pick(row, ["open", "o"]), "open");
            const high = numberValue(pick(row, ["high", "h"]), "high");
            const low = numberValue(pick(row, ["low", "l"]), "low");
            const close = numberValue(pick(row, ["close", "c"]), "close");
            const volumeRaw = pick(row, ["tick volume", "tickvolume", "volume", "vol"]);
            return {
              time: parseTime(row),
              open,
              high,
              low,
              close,
              volume: volumeRaw ? numberValue(volumeRaw, "volume") : 0
            };
          });

          candles.sort((a, b) => a.time - b.time);
          const deduped = candles.filter((candle, index) => index === 0 || candle.time !== candles[index - 1].time);
          if (!deduped.length) throw new Error("No candles found in CSV");
          resolve(deduped);
        } catch (error) {
          reject(error);
        }
      },
      error: (error) => reject(error)
    });
  });
}
