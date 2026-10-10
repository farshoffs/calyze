import type {
  AccountConfig,
  AccountMetrics,
  AccountState,
  Candle,
  ExitReason,
  InstrumentSpec,
  Position,
  Side
} from "../types";

export function initialAccount(config: AccountConfig): AccountState {
  return { balance: config.initialBalance, positions: [], history: [] };
}

export function quote(mid: number, spec: InstrumentSpec): { bid: number; ask: number } {
  const half = spec.spread / 2;
  return { bid: mid - half, ask: mid + half };
}

export function positionRawPnl(position: Position, mid: number, spec: InstrumentSpec): number {
  const q = quote(mid, spec);
  const exit = position.side === "buy" ? q.bid : q.ask;
  const delta = position.side === "buy" ? exit - position.openPrice : position.openPrice - exit;
  return delta * spec.contractSize * position.lots;
}

export function positionMargin(position: Position, config: AccountConfig, spec: InstrumentSpec): number {
  return (position.openPrice * spec.contractSize * position.lots) / config.leverage;
}

export function metrics(
  state: AccountState,
  mid: number,
  config: AccountConfig,
  spec: InstrumentSpec
): AccountMetrics {
  const floatingPnl = state.positions.reduce((sum, position) => sum + positionRawPnl(position, mid, spec), 0);
  const usedMargin = state.positions.reduce((sum, position) => sum + positionMargin(position, config, spec), 0);
  const equity = state.balance + floatingPnl;
  const freeMargin = equity - usedMargin;
  return {
    balance: state.balance,
    equity,
    usedMargin,
    freeMargin,
    marginLevel: usedMargin > 0 ? (equity / usedMargin) * 100 : null,
    floatingPnl
  };
}

function normalizedLots(lots: number, spec: InstrumentSpec): number {
  const clamped = Math.min(spec.maxLot, Math.max(spec.minLot, lots));
  const steps = Math.floor((clamped + 1e-12) / spec.lotStep);
  return Number((steps * spec.lotStep).toFixed(8));
}

export function openPosition(
  state: AccountState,
  side: Side,
  lotsInput: number,
  mid: number,
  time: number,
  config: AccountConfig,
  spec: InstrumentSpec,
  stopLoss?: number,
  takeProfit?: number
): { state: AccountState; error?: string } {
  const lots = normalizedLots(lotsInput, spec);
  const q = quote(mid, spec);
  const openPrice = side === "buy" ? q.ask : q.bid;
  const requiredMargin = (openPrice * spec.contractSize * lots) / config.leverage;
  const before = metrics(state, mid, config, spec);
  const openCommission = (spec.commissionPerLotRoundTurn * lots) / 2;

  if (requiredMargin + openCommission > before.freeMargin) {
    return { state, error: "Not enough free margin for this order." };
  }

  const position: Position = {
    id: crypto.randomUUID(),
    side,
    lots,
    openTime: time,
    openPrice,
    stopLoss: stopLoss && stopLoss > 0 ? stopLoss : undefined,
    takeProfit: takeProfit && takeProfit > 0 ? takeProfit : undefined,
    commissionPaid: openCommission
  };

  return {
    state: {
      ...state,
      balance: state.balance - openCommission,
      positions: [...state.positions, position]
    }
  };
}

export function closePosition(
  state: AccountState,
  positionId: string,
  mid: number,
  time: number,
  spec: InstrumentSpec,
  reason: ExitReason = "manual",
  forcedPrice?: number
): AccountState {
  const position = state.positions.find((item) => item.id === positionId);
  if (!position) return state;

  const q = quote(mid, spec);
  const marketExit = position.side === "buy" ? q.bid : q.ask;
  const closePrice = forcedPrice ?? marketExit;
  const delta = position.side === "buy" ? closePrice - position.openPrice : position.openPrice - closePrice;
  const rawPnl = delta * spec.contractSize * position.lots;
  const closeCommission = (spec.commissionPerLotRoundTurn * position.lots) / 2;
  const totalCommission = position.commissionPaid + closeCommission;
  const closed: Position = {
    ...position,
    closeTime: time,
    closePrice,
    rawPnl,
    netPnl: rawPnl - totalCommission,
    commissionPaid: totalCommission,
    exitReason: reason
  };

  return {
    balance: state.balance + rawPnl - closeCommission,
    positions: state.positions.filter((item) => item.id !== positionId),
    history: [closed, ...state.history]
  };
}

function exitOnBar(position: Position, candle: Candle, spec: InstrumentSpec): { price: number; reason: ExitReason } | null {
  const half = spec.spread / 2;

  if (position.side === "buy") {
    const bidLow = candle.low - half;
    const bidHigh = candle.high - half;
    const sl = position.stopLoss !== undefined && bidLow <= position.stopLoss;
    const tp = position.takeProfit !== undefined && bidHigh >= position.takeProfit;
    if (sl) return { price: position.stopLoss!, reason: "stop_loss" };
    if (tp) return { price: position.takeProfit!, reason: "take_profit" };
    return null;
  }

  const askLow = candle.low + half;
  const askHigh = candle.high + half;
  const sl = position.stopLoss !== undefined && askHigh >= position.stopLoss;
  const tp = position.takeProfit !== undefined && askLow <= position.takeProfit;
  if (sl) return { price: position.stopLoss!, reason: "stop_loss" };
  if (tp) return { price: position.takeProfit!, reason: "take_profit" };
  return null;
}

export function advanceAccount(
  state: AccountState,
  candle: Candle,
  config: AccountConfig,
  spec: InstrumentSpec
): AccountState {
  let next = state;

  for (const position of [...next.positions]) {
    const exit = exitOnBar(position, candle, spec);
    if (exit) {
      next = closePosition(next, position.id, candle.close, candle.time, spec, exit.reason, exit.price);
    }
  }

  const marked = metrics(next, candle.close, config, spec);
  if (
    next.positions.length &&
    marked.marginLevel !== null &&
    marked.marginLevel <= config.stopOutLevel
  ) {
    for (const position of [...next.positions]) {
      next = closePosition(next, position.id, candle.close, candle.time, spec, "stop_out");
    }
  }

  return next;
}
