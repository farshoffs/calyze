export type Side = "buy" | "sell";
export type ExitReason = "manual" | "stop_loss" | "take_profit" | "stop_out";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SessionWindow {
  start: string;
  end: string;
}
export type SessionSchedule = Partial<Record<"Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday", SessionWindow>>;

export interface InstrumentSpec {
  symbol: string;
  contractSize: number;
  tickSize: number;
  /** CSV candles can be bid-based (USOIL.S) or synthetic mid-based (legacy). */
  chartMode?: "bid" | "mid";
  digits?: number;
  tickValue?: number;
  /** M1 OHLC contains no historical ask quotes; spread is an explicit modeling assumption. */
  spread: number;
  spreadMode?: "floating" | "fixed";
  commissionPerLotRoundTurn: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
  volumeLimit?: number;
  stopsLevelPoints?: number;
  marginCurrency?: string;
  profitCurrency?: string;
  marginCalculation?: "notional";
  swapCurrency?: string;
  swapLong?: number;
  swapShort?: number;
  swapMultipliers?: Partial<Record<number, number>>;
  /** Rollover time used for historical simulation (not inferred from screenshots). */
  swapRolloverUtcHour?: number;
  /** Broker-server time offset from UTC; null means trading-session validation is disabled. */
  serverUtcOffsetHours?: number | null;
  quoteSessions?: SessionSchedule;
  tradeSessions?: SessionSchedule;
}

export interface AccountConfig {
  currency: string;
  initialBalance: number;
  leverage: number;
  marginCallLevel: number;
  stopOutLevel: number;
}

export interface Position {
  id: string;
  side: Side;
  lots: number;
  openTime: number;
  openPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  closeTime?: number;
  closePrice?: number;
  rawPnl?: number;
  netPnl?: number;
  commissionPaid: number;
  swapAccrued?: number;
  exitReason?: ExitReason;
}

export interface AccountState {
  balance: number;
  positions: Position[];
  history: Position[];
  lastBarTime?: number;
}

export interface AccountMetrics {
  balance: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  marginLevel: number | null;
  floatingPnl: number;
  swaps: number;
}

export type Timeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1";
