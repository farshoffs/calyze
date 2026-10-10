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

export interface InstrumentSpec {
  symbol: string;
  contractSize: number;
  tickSize: number;
  spread: number;
  commissionPerLotRoundTurn: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
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
  exitReason?: ExitReason;
}

export interface AccountState {
  balance: number;
  positions: Position[];
  history: Position[];
}

export interface AccountMetrics {
  balance: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  marginLevel: number | null;
  floatingPnl: number;
}

export type Timeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1";
