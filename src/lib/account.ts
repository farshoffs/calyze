import type {
  AccountConfig, AccountMetrics, AccountState, Candle, ExitReason,
  InstrumentSpec, Position, Side
} from "../types";

export function initialAccount(config: AccountConfig): AccountState {
  return { balance: config.initialBalance, positions: [], history: [] };
}

/** Chart source prices are bid for USOIL.S; ask is estimated from configured spread. */
export function quote(chartPrice: number, spec: InstrumentSpec): { bid: number; ask: number } {
  const spread = Math.max(0, spec.spread);
  if (spec.chartMode === "bid") return { bid: chartPrice, ask: chartPrice + spread };
  return { bid: chartPrice - spread / 2, ask: chartPrice + spread / 2 };
}

export function positionRawPnl(position: Position, chartPrice: number, spec: InstrumentSpec): number {
  const q = quote(chartPrice, spec);
  const exit = position.side === "buy" ? q.bid : q.ask;
  const delta = position.side === "buy" ? exit - position.openPrice : position.openPrice - exit;
  return delta * spec.contractSize * position.lots;
}

/** Notional margin: price x contract size x lots / leverage, in USD for USOIL.S. */
export function marginForOrder(
  side: Side, lots: number, chartPrice: number, config: AccountConfig, spec: InstrumentSpec
): number {
  if (!(config.leverage > 0)) return NaN;
  const q = quote(chartPrice, spec);
  const fill = side === "buy" ? q.ask : q.bid;
  return fill * spec.contractSize * lots / config.leverage;
}

export function positionMargin(position: Position, config: AccountConfig, spec: InstrumentSpec): number {
  return position.openPrice * spec.contractSize * position.lots / config.leverage;
}

export function metrics(
  state: AccountState, chartPrice: number, config: AccountConfig, spec: InstrumentSpec
): AccountMetrics {
  const swaps = state.positions.reduce((sum, position) => sum + (position.swapAccrued ?? 0), 0);
  const floatingPnl = state.positions.reduce(
    (sum, position) => sum + positionRawPnl(position, chartPrice, spec), 0
  ) + swaps;
  const usedMargin = state.positions.reduce((sum, position) => sum + positionMargin(position, config, spec), 0);
  const equity = state.balance + floatingPnl;
  return {
    balance: state.balance, equity, usedMargin,
    freeMargin: equity - usedMargin,
    marginLevel: usedMargin > 0 ? equity / usedMargin * 100 : null,
    floatingPnl, swaps
  };
}

function validateLots(lots: number, state: AccountState, spec: InstrumentSpec): string | null {
  if (!Number.isFinite(lots)) return "Enter a valid lot size.";
  if (lots < spec.minLot - 1e-8 || lots > spec.maxLot + 1e-8) {
    return `Lots must be between ${spec.minLot} and ${spec.maxLot}.`;
  }
  const steps = (lots - spec.minLot) / spec.lotStep;
  if (!(spec.lotStep > 0) || Math.abs(steps - Math.round(steps)) > 1e-7) {
    return `Lots must increase in steps of ${spec.lotStep} from ${spec.minLot}.`;
  }
  if (spec.volumeLimit !== undefined) {
    const existing = state.positions.reduce((sum, position) => sum + position.lots, 0);
    if (existing + lots > spec.volumeLimit + 1e-8) {
      return `Aggregate open volume cannot exceed ${spec.volumeLimit} lots.`;
    }
  }
  return null;
}

function validStopDistance(
  side: Side, sl: number | undefined, tp: number | undefined,
  chartPrice: number, spec: InstrumentSpec
): string | null {
  const { bid, ask } = quote(chartPrice, spec);
  const stopMin = (spec.stopsLevelPoints ?? 0) * spec.tickSize;
  const mark = side === "buy" ? bid : ask;
  if (sl !== undefined && (!Number.isFinite(sl) || sl <= 0)) return "Stop loss must be a positive price.";
  if (tp !== undefined && (!Number.isFinite(tp) || tp <= 0)) return "Take profit must be a positive price.";
  if (side === "buy") {
    if (sl !== undefined && sl >= mark - stopMin + 1e-8) {
      return `BUY SL must be at least ${stopMin.toFixed(spec.digits ?? 2)} below bid.`;
    }
    if (tp !== undefined && tp <= mark + stopMin - 1e-8) {
      return `BUY TP must be at least ${stopMin.toFixed(spec.digits ?? 2)} above bid.`;
    }
  } else {
    if (sl !== undefined && sl <= mark + stopMin - 1e-8) {
      return `SELL SL must be at least ${stopMin.toFixed(spec.digits ?? 2)} above ask.`;
    }
    if (tp !== undefined && tp >= mark - stopMin + 1e-8) {
      return `SELL TP must be at least ${stopMin.toFixed(spec.digits ?? 2)} below ask.`;
    }
  }
  return null;
}

const WEEKDAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"] as const;

/** Enforce broker trading sessions only when a broker-server offset is supplied. */
export function isTradeSession(time: number, spec: InstrumentSpec): boolean {
  if (!spec.tradeSessions || spec.serverUtcOffsetHours == null) return true;
  const brokerTime = new Date((time + spec.serverUtcOffsetHours * 3600) * 1000);
  const weekday = WEEKDAYS[brokerTime.getUTCDay()];
  const window = spec.tradeSessions[weekday];
  if (!window) return false;
  const now = brokerTime.getUTCHours() * 60 + brokerTime.getUTCMinutes();
  const toMin = (value: string) => {
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
  };
  const start = toMin(window.start);
  const end = toMin(window.end);
  return start <= end ? now >= start && now <= end : now >= start || now <= end;
}

export function openPosition(
  state: AccountState, side: Side, lots: number, chartPrice: number, time: number,
  config: AccountConfig, spec: InstrumentSpec, stopLoss?: number, takeProfit?: number
): { state: AccountState; error?: string } {
  if (!(config.leverage > 0)) return { state, error: "Leverage must be greater than zero." };
  const lotError = validateLots(lots, state, spec);
  if (lotError) return { state, error: lotError };
  if (!isTradeSession(time, spec)) return { state, error: "Outside broker trading session." };
  const stopError = validStopDistance(side, stopLoss, takeProfit, chartPrice, spec);
  if (stopError) return { state, error: stopError };

  const q = quote(chartPrice, spec);
  const openPrice = side === "buy" ? q.ask : q.bid;
  const requiredMargin = marginForOrder(side, lots, chartPrice, config, spec);
  const before = metrics(state, chartPrice, config, spec);
  const openCommission = spec.commissionPerLotRoundTurn * lots / 2;
  const immediateSpreadLoss = spec.spread * spec.contractSize * lots;
  if (!Number.isFinite(requiredMargin) || !Number.isFinite(openCommission)) {
    return { state, error: "Invalid symbol settings or margin calculation." };
  }
  if (requiredMargin + openCommission + immediateSpreadLoss > before.freeMargin + 1e-8) {
    return { state, error: "Not enough free margin for this order, including spread and commission." };
  }

  const position: Position = {
    id: crypto.randomUUID(), side, lots, openTime: time, openPrice,
    stopLoss, takeProfit, commissionPaid: openCommission, swapAccrued: 0
  };
  return { state: {
    ...state, balance: state.balance - openCommission,
    positions: [...state.positions, position]
  } };
}

export function closePosition(
  state: AccountState, positionId: string, chartPrice: number, time: number,
  spec: InstrumentSpec, reason: ExitReason = "manual", forcedPrice?: number
): AccountState {
  const position = state.positions.find((item) => item.id === positionId);
  if (!position) return state;
  const q = quote(chartPrice, spec);
  const closePrice = forcedPrice ?? (position.side === "buy" ? q.bid : q.ask);
  const delta = position.side === "buy" ? closePrice - position.openPrice : position.openPrice - closePrice;
  const rawPnl = delta * spec.contractSize * position.lots;
  const closeCommission = spec.commissionPerLotRoundTurn * position.lots / 2;
  const totalCommission = position.commissionPaid + closeCommission;
  const swapAccrued = position.swapAccrued ?? 0;
  const closed: Position = {
    ...position, closeTime: time, closePrice, rawPnl,
    netPnl: rawPnl + swapAccrued - totalCommission,
    commissionPaid: totalCommission, exitReason: reason
  };
  return {
    ...state,
    balance: state.balance + rawPnl + swapAccrued - closeCommission,
    positions: state.positions.filter((item) => item.id !== positionId),
    history: [closed, ...state.history]
  };
}

/**
 * Overnight carrying costs from an explicitly configured UTC rollover.
 * Calendar day rates: Mon 1 Tue 1 Wed 3 Thu 1 Fri 1; no weekend rollovers.
 * The broker server timezone is unknown until supplied by the user.
 */
export function swapBetween(position: Position, fromTime: number, throughTime: number, spec: InstrumentSpec): number {
  if (throughTime <= fromTime) return 0;
  const daily = position.side === "buy" ? spec.swapLong ?? 0 : spec.swapShort ?? 0;
  if (!daily) return 0;
  const rollover = (spec.swapRolloverUtcHour ?? 0) * 3600;
  let earned = 0;
  const firstDay = Math.floor((fromTime - rollover) / 86400);
  const lastDay = Math.floor((throughTime - rollover) / 86400);
  for (let day = firstDay + 1; day <= lastDay; day += 1) {
    const moment = day * 86400 + rollover;
    const weekday = new Date(moment * 1000).getUTCDay();
    const factor = spec.swapMultipliers?.[weekday] ?? (weekday === 0 || weekday === 6 ? 0 : weekday === 3 ? 3 : 1);
    earned += daily * position.lots * factor;
  }
  return earned;
}

function exitOnBar(
  position: Position, candle: Candle, spec: InstrumentSpec
): { price: number; reason: ExitReason } | null {
  const bidOffset = spec.chartMode === "bid" ? 0 : -spec.spread / 2;
  const askOffset = spec.chartMode === "bid" ? spec.spread : spec.spread / 2;
  if (position.side === "buy") {
    const bidLow = candle.low + bidOffset;
    const bidHigh = candle.high + bidOffset;
    const sl = position.stopLoss !== undefined && bidLow <= position.stopLoss;
    const tp = position.takeProfit !== undefined && bidHigh >= position.takeProfit;
    if (sl) return { price: position.stopLoss!, reason: "stop_loss" };
    if (tp) return { price: position.takeProfit!, reason: "take_profit" };
    return null;
  }
  const askLow = candle.low + askOffset;
  const askHigh = candle.high + askOffset;
  const sl = position.stopLoss !== undefined && askHigh >= position.stopLoss;
  const tp = position.takeProfit !== undefined && askLow <= position.takeProfit;
  if (sl) return { price: position.stopLoss!, reason: "stop_loss" };
  if (tp) return { price: position.takeProfit!, reason: "take_profit" };
  return null;
}

export function advanceAccount(
  state: AccountState, candle: Candle, config: AccountConfig, spec: InstrumentSpec
): AccountState {
  let next: AccountState = {
    ...state,
    lastBarTime: candle.time,
    positions: state.positions.map((position) => ({
      ...position,
      swapAccrued: (position.swapAccrued ?? 0) +
        swapBetween(position, Math.max(position.openTime, state.lastBarTime ?? position.openTime), candle.time, spec)
    }))
  };
  for (const position of [...next.positions]) {
    const exit = exitOnBar(position, candle, spec);
    if (exit) next = closePosition(next, position.id, candle.close, candle.time, spec, exit.reason, exit.price);
  }
  const marked = metrics(next, candle.close, config, spec);
  if (next.positions.length && marked.marginLevel !== null && marked.marginLevel <= config.stopOutLevel) {
    for (const position of [...next.positions]) {
      next = closePosition(next, position.id, candle.close, candle.time, spec, "stop_out");
    }
  }
  return next;
}
