import type { InstrumentSpec, SessionSchedule } from "../types";

/**
 * Broker settings transcribed from user-supplied USOIL.S specification screenshots.
 * Spread, commission, rollover hour, server offset and account leverage CANNOT be
 * derived from those screenshots or bid-only OHLC, and remain user assumptions.
 */
const quoteSessions: SessionSchedule = {
  Monday: { start: "01:00", end: "23:59" },
  Tuesday: { start: "01:00", end: "23:59" },
  Wednesday: { start: "01:00", end: "23:59" },
  Thursday: { start: "01:00", end: "23:59" },
  Friday: { start: "01:00", end: "23:59" }
};

const tradeSessions: SessionSchedule = {
  Monday: { start: "01:05", end: "23:58" },
  Tuesday: { start: "01:02", end: "23:58" },
  Wednesday: { start: "01:02", end: "23:58" },
  Thursday: { start: "01:02", end: "23:58" },
  Friday: { start: "01:02", end: "23:55" }
};

export const USOIL_S: InstrumentSpec = {
  symbol: "USOIL.S",
  contractSize: 100,
  digits: 2,
  tickSize: 0.01,
  tickValue: 1,
  chartMode: "bid",
  spreadMode: "floating",
  // User-adjustable illustrative spread; CSV has no ask quotes.
  spread: 0.03,
  // No commission figure visible in screenshots. Explicit assumption.
  commissionPerLotRoundTurn: 0,
  minLot: 0.1,
  maxLot: 60,
  lotStep: 0.1,
  volumeLimit: 100,
  stopsLevelPoints: 15,
  marginCurrency: "USD",
  profitCurrency: "USD",
  marginCalculation: "notional",
  swapCurrency: "USD",
  swapLong: 0,
  swapShort: -16,
  swapMultipliers: { 0: 0, 1: 1, 2: 1, 3: 3, 4: 1, 5: 1, 6: 0 },
  // Broker's timezone/rollover not given in screenshots; use explicit UTC assumption.
  swapRolloverUtcHour: 0,
  serverUtcOffsetHours: null,
  quoteSessions,
  tradeSessions
};

export const DEFAULT_INSTRUMENT: InstrumentSpec = {
  symbol: "XAUUSD",
  contractSize: 100,
  tickSize: 0.01,
  chartMode: "mid",
  spread: 0.2,
  spreadMode: "fixed",
  commissionPerLotRoundTurn: 7,
  minLot: 0.01,
  maxLot: 100,
  lotStep: 0.01
};

export function instrumentFromImport(filename: string, symbolHint?: string): InstrumentSpec {
  if (/(^|[^A-Za-z])(WTI|USOIL)([^A-Za-z]|$)/i.test(filename + " " + (symbolHint ?? ""))) {
    return structuredClone(USOIL_S);
  }
  return structuredClone(DEFAULT_INSTRUMENT);
}
